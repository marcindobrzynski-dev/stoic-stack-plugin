// The experiment's two-tier logs, beside the personal engine state and never in
// the repository:
//
// - `jev-experiment.jsonl`: one v4 summary line per classification, written by
//   `runner.js`, the only place that knows whether the fallback ran;
// - `jev-experiment/<ts>.json`: the full record at structured-state schema
//   version 3 (Sonnet input summary,
//   structured state, and per-category question/answer sets), written by
//   `run.js`, the only place that holds them.
//
// `src/hooks/stop.js` is the single writer of turn-boundary `state.json` and
// the single source of `score_after` in `local-trace.jsonl`. Summary lines
// carry `score_before` plus the join key `{ prompt_id, session_id, ts }` so an
// external analysis can join them to `local-trace.jsonl`; the plugin itself
// never reads these logs back.
//
// Writing a log never throws: observation must not break the observed turn,
// and logs are never pruned.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §Jev experiment logs (structured-state branch, summary `schema_version: 4`).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

import {
  isFiniteNumber,
  isNonEmptyString,
  isPlainObject,
} from "../../src/core/predicates.js";
import {
  effectivePreset,
  loadConfig,
  normalizeConfig,
  resolveCategory,
} from "../../src/io/config/config.js";
import { personalStateDir } from "../../src/io/paths.js";
import { loadState } from "../../src/io/state.js";
import { CATEGORY_REGISTRY, sectionFor } from "./categories/categories.js";
import { combineProbabilities, selectDrivingCategory } from "./combine.js";
import {
  CLASSIFIER_VERDICT_FIELDS,
  DECISION_OWNERSHIP_NAME,
  DECISION_WEIGHT_NAME,
  DEVELOPER_INTENT_NAME,
  DEVELOPER_REFLECTION_NAME,
  FALLBACK_MODEL,
  PAUSE_THRESHOLDS,
  STATE_MODEL,
  STATE_SCHEMA_VERSION,
  SUMMARY_SCHEMA_VERSION,
} from "./jev.constants.js";
import { readApiKey } from "./env.js";
import { readTurns } from "./transcript.js";

/** The summary log's file name under `personalStateDir`. */
export const SUMMARY_FILE_NAME = "jev-experiment.jsonl";

/** The directory holding one full-input file per Jev call. */
export const INPUT_DIR_NAME = "jev-experiment";

/** Status and reason token recorded when a Jev category fails. */
export const CATEGORY_FAILED = "category_failed";

/** Verdict reason prefix emitted when a Jev category fails. */
export const CATEGORY_FAILED_REASON_PREFIX = `jev: ${CATEGORY_FAILED}`;

/** Minimum length for a secret value to be scrubbed from serialized strings. */
const MIN_SECRET_LENGTH = 4;

const SECRET_NAME_PATTERN = /api_?key$/i;

/**
 * Resolve the home directory from an options object or `os.homedir()`.
 *
 * @param {unknown} options - Options object or homeDir string.
 * @returns {string} Resolved home directory path.
 */
function resolveHomeDir(options) {
  if (isNonEmptyString(options)) {
    return options;
  }
  if (isPlainObject(options) && isNonEmptyString(options.homeDir)) {
    return options.homeDir;
  }
  return os.homedir();
}

/**
 * Resolve the path of `jev-experiment.jsonl` under `personalStateDir`.
 *
 * @param {string} projectDir - Project root directory.
 * @param {string|object} [options] - Home directory path or `{ homeDir }`.
 * @returns {string} Absolute path of `jev-experiment.jsonl`.
 */
export function summaryLogPath(projectDir, options) {
  return path.join(
    personalStateDir(projectDir, resolveHomeDir(options)),
    SUMMARY_FILE_NAME,
  );
}

/**
 * Resolve the directory holding per-call `<ts>.json` full records.
 *
 * @param {string} projectDir - Project root directory.
 * @param {string|object} [options] - Home directory path or `{ homeDir }`.
 * @returns {string} Absolute path of `jev-experiment/`.
 */
export function inputDirPath(projectDir, options) {
  return path.join(
    personalStateDir(projectDir, resolveHomeDir(options)),
    INPUT_DIR_NAME,
  );
}

/**
 * A timestamp that can name a file on every platform: Windows forbids `:`.
 *
 * @param {Date} date - The moment.
 * @returns {string} For example `2026-10-03T08-15-30-123Z`.
 */
export function fileTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Whether a category entry or error value records a category failure.
 *
 * @param {unknown} categoryEntry - Category log object or error class string.
 * @returns {boolean} True when the entry carries a non-empty error class.
 */
function hasCategoryEntryError(categoryEntry) {
  if (isNonEmptyString(categoryEntry)) {
    return true;
  }
  return isPlainObject(categoryEntry) && isNonEmptyString(categoryEntry.error);
}

/**
 * Whether a categories map or `category_errors` map has at least one error.
 *
 * @param {unknown} categories - Map of category objects or error strings.
 * @returns {boolean} True when any category entry carries an error.
 */
function hasCategoryError(categories) {
  if (!isPlainObject(categories)) {
    return false;
  }
  return Object.values(categories).some(hasCategoryEntryError);
}

/**
 * Whether a verdict reason string carries the Jev category-failure prefix.
 *
 * @param {unknown} reason - Candidate verdict reason string.
 * @returns {boolean} True when `reason` starts with `"jev: category_failed"`.
 */
function hasCategoryFailedReason(reason) {
  return (
    isNonEmptyString(reason) && reason.startsWith(CATEGORY_FAILED_REASON_PREFIX)
  );
}

/**
 * Whether a summary record, child log, trace record, or category map
 * represents a Jev category failure, independent of `provider`.
 *
 * @param {unknown} record - Summary line, child log, trace record, or
 *   category-failure inputs.
 * @returns {boolean} True when any category failed.
 */
export function isCategoryFailed(record) {
  if (!isPlainObject(record)) {
    return false;
  }
  const reason = isNonEmptyString(record.reason) ? record.reason.trim() : null;
  if (
    record.status === CATEGORY_FAILED ||
    record.childStatus === CATEGORY_FAILED ||
    record.category_failed === true ||
    reason === CATEGORY_FAILED
  ) {
    return true;
  }
  if (
    hasCategoryError(record.categories) ||
    hasCategoryError(record.category_errors)
  ) {
    return true;
  }
  return (
    hasCategoryFailedReason(record.verdict?.reason) ||
    hasCategoryFailedReason(record.verdict_reason) ||
    hasCategoryFailedReason(reason)
  );
}

/**
 * Jev category names whose error class is set, in map order.
 *
 * @param {unknown} categoryErrors - `{ [categoryName]: error class | null }`.
 * @returns {string[]} Failed Jev category names. Empty when none failed.
 */
function jevFailedCategoryNames(categoryErrors) {
  if (!isPlainObject(categoryErrors)) {
    return [];
  }
  return Object.entries(categoryErrors)
    .filter(([, errorClass]) => isNonEmptyString(errorClass))
    .map(([categoryName]) => categoryName);
}

/**
 * Whether the summary provider is the Haiku headless fallback.
 *
 * @param {unknown} provider - Summary provider.
 * @returns {boolean} True when `provider` is `"headless_fallback"`.
 */
function isHeadlessFallback(provider) {
  return provider === "headless_fallback";
}

/**
 * Whether a classifier result carries an ok verdict object.
 *
 * @param {unknown} result - Result returned to `classify`.
 * @returns {boolean} True when `result.status` is `"ok"` and `result.value`
 *   is a plain object.
 */
function hasOkVerdict(result) {
  return result?.status === "ok" && isPlainObject(result.value);
}

/**
 * Haiku's own category and subcategory from a fallback verdict.
 * Both stay null unless this line's provider is the Haiku fallback and that
 * call returned a verdict, so a Jev category name is never stored here.
 *
 * @param {string} provider - Summary provider.
 * @param {object} [result] - Result returned to `classify`.
 * @param {object} config - Project configuration used to resolve a subcategory.
 * @returns {{ haikuCategory: string|null, haikuSubcategory: string|null }}
 *   Haiku labels, or nulls.
 */
function haikuLabelsFromResult(provider, result, config) {
  if (!isHeadlessFallback(provider) || !hasOkVerdict(result)) {
    return { haikuCategory: null, haikuSubcategory: null };
  }

  const haikuSubcategory = isNonEmptyString(result.value.subcategory)
    ? result.value.subcategory
    : null;
  const explicitCategory = isNonEmptyString(result.value.category)
    ? result.value.category
    : null;
  const resolvedCategory = resolveCategory(haikuSubcategory, config);
  const haikuCategory = explicitCategory ?? resolvedCategory?.category ?? null;

  return { haikuCategory, haikuSubcategory };
}

/**
 * Haiku's verdict fields, copied unchanged from a fallback result.
 * Null unless this line's provider is the Haiku fallback and that call
 * returned a verdict.
 *
 * @param {string} provider - Summary provider.
 * @param {object} [result] - Result returned to `classify`.
 * @returns {object|null} The verdict fields Haiku returned, or null.
 */
function haikuVerdictFromResult(provider, result) {
  if (!isHeadlessFallback(provider) || !hasOkVerdict(result)) {
    return null;
  }
  const haikuVerdict = {};
  for (const fieldName of CLASSIFIER_VERDICT_FIELDS) {
    if (Object.hasOwn(result.value, fieldName)) {
      haikuVerdict[fieldName] = result.value[fieldName];
    }
  }
  return haikuVerdict;
}

/**
 * Add a candidate secret string to a set when it is long enough to scrub.
 *
 * @param {Set<string>} secrets - Accumulated secret strings.
 * @param {unknown} value - Candidate secret value.
 */
function collectSecretValue(secrets, value) {
  if (typeof value === "string" && value.trim().length >= MIN_SECRET_LENGTH) {
    secrets.add(value.trim());
  }
}

/**
 * Collect all secret values from `.stoic/.env`, `process.env`, `options`, and
 * any secret-named properties inside `record` so none can reach disk.
 *
 * @param {unknown} projectDir - Project root directory.
 * @param {unknown} record - Log record being written.
 * @param {unknown} options - Writer options.
 * @returns {string[]} Distinct secret values to redact.
 */
function gatherSecrets(projectDir, record, options) {
  const secrets = new Set();

  collectSecretValue(secrets, readApiKey(projectDir));

  if (isNonEmptyString(projectDir)) {
    try {
      const dotenvText = fs.readFileSync(
        path.join(projectDir, ".stoic", ".env"),
        "utf8",
      );
      const parsedEnv = parseEnv(dotenvText);
      for (const value of Object.values(parsedEnv)) {
        collectSecretValue(secrets, value);
      }
    } catch {
      // Missing or unreadable .stoic/.env has no extra secrets to collect.
    }
  }

  for (const [envName, envValue] of Object.entries(process.env)) {
    if (SECRET_NAME_PATTERN.test(envName)) {
      collectSecretValue(secrets, envValue);
    }
  }

  if (isPlainObject(options)) {
    for (const [key, value] of Object.entries(options)) {
      if (SECRET_NAME_PATTERN.test(key)) {
        collectSecretValue(secrets, value);
      }
    }
  }

  function scanObjectForSecretKeys(candidate) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        scanObjectForSecretKeys(item);
      }
      return;
    }
    if (!isPlainObject(candidate)) {
      return;
    }
    for (const [key, value] of Object.entries(candidate)) {
      if (SECRET_NAME_PATTERN.test(key)) {
        collectSecretValue(secrets, value);
      } else {
        scanObjectForSecretKeys(value);
      }
    }
  }

  scanObjectForSecretKeys(record);
  return [...secrets];
}

/**
 * Replace any occurrence of collected secret values inside a string.
 *
 * @param {string} text - Input string.
 * @param {string[]} secrets - Secret values to scrub.
 * @returns {string} Redacted string.
 */
function scrubString(text, secrets) {
  let result = text;
  for (const secret of secrets) {
    if (result.includes(secret)) {
      result = result.replaceAll(secret, "[REDACTED]");
    }
  }
  return result;
}

/**
 * Deeply clone and sanitize a log value, stripping secret-named properties and
 * scrubbing any secret values from strings.
 *
 * @param {unknown} value - Candidate value to sanitize.
 * @param {string[]} secrets - Secret values to scrub.
 * @returns {unknown} Sanitized value safe for `JSON.stringify`.
 */
function sanitizeValue(value, secrets) {
  if (typeof value === "string") {
    return scrubString(value, secrets);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, secrets));
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const cleaned = {};
  for (const [key, entryValue] of Object.entries(value)) {
    // Defense in depth: drop any field whose name ends in an API key.
    if (SECRET_NAME_PATTERN.test(key)) {
      continue;
    }
    cleaned[key] = sanitizeValue(entryValue, secrets);
  }
  return cleaned;
}

/**
 * Sanitize a log record against secret keys and secret values before writing.
 *
 * @param {unknown} projectDir - Project root directory.
 * @param {unknown} record - Record to sanitize.
 * @param {unknown} [options] - Optional writer options.
 * @returns {object} Sanitized plain object.
 */
function sanitizeLogRecord(projectDir, record, options) {
  const base = isPlainObject(record) ? record : {};
  const secrets = gatherSecrets(projectDir, base, options);
  return sanitizeValue(base, secrets);
}

/**
 * Extract scalar per-question answers (`noul` probability or `choice` string)
 * for every question declared in a category module.
 *
 * @param {object} category - Category descriptor from the registry.
 * @param {unknown} rawAnswers - Raw `response.answers` for this category.
 * @returns {Record<string, number|string|null>} Question answers keyed by
 *   question identifier.
 */
export function extractCategoryAnswers(category, rawAnswers) {
  const questionSpecs = isPlainObject(category?.questions)
    ? category.questions
    : {};
  const source = isPlainObject(rawAnswers) ? rawAnswers : {};
  const extracted = {};

  for (const questionKey of Object.keys(questionSpecs)) {
    const entry = source[questionKey];
    if (isPlainObject(entry) && isFiniteNumber(entry.noul)) {
      extracted[questionKey] = entry.noul;
    } else if (isPlainObject(entry) && typeof entry.choice === "string") {
      extracted[questionKey] = entry.choice;
    } else if (isFiniteNumber(entry)) {
      extracted[questionKey] = entry;
    } else {
      extracted[questionKey] = null;
    }
  }

  return extracted;
}

/**
 * Build per-category records by iterating the category registry rather than a
 * hardcoded list of category names, assigning `role` (`"dominant"`,
 * `"limiting"`, or `null`) via `selectDrivingCategory` from `./combine.js`.
 *
 * @param {object} params - Category record inputs.
 * @param {readonly object[]} [params.registry] - Active category registry.
 * @param {unknown} [params.state] - Validated v3 structured state (Tier 2).
 * @param {unknown} [params.questionsByCategory] - Built SDK questions per
 *   category (Tier 2).
 * @param {unknown} [params.answersByCategory] - Raw Jev answers per category.
 * @param {unknown} [params.probabilities] - Mapped probabilities per category.
 * @param {unknown} [params.categoryLatencyMs] - Latency in ms per category.
 * @param {unknown} [params.categoryErrors] - Error class per failed category.
 * @param {number} [params.presetPauseThreshold] - Active preset pause threshold.
 * @param {boolean} [params.includeFullQuestions] - True for Tier 2 full records.
 * @returns {Record<string, object>} Category records keyed by category name.
 */
export function buildCategoriesLog({
  registry = CATEGORY_REGISTRY,
  state = null,
  questionsByCategory = null,
  answersByCategory = null,
  probabilities = null,
  categoryLatencyMs = null,
  categoryErrors = null,
  presetPauseThreshold = PAUSE_THRESHOLDS.balanced,
  includeFullQuestions = false,
}) {
  const activeRegistry = Array.isArray(registry) ? registry : CATEGORY_REGISTRY;
  const rawAnswersMap = isPlainObject(answersByCategory)
    ? answersByCategory
    : {};
  const probabilitiesMap = isPlainObject(probabilities) ? probabilities : {};
  const latencyMap = isPlainObject(categoryLatencyMs) ? categoryLatencyMs : {};
  const errorMap = isPlainObject(categoryErrors) ? categoryErrors : {};
  const questionsMap = isPlainObject(questionsByCategory)
    ? questionsByCategory
    : {};

  const resolvedProbabilities = {};
  for (const category of activeRegistry) {
    const rawAnswers = rawAnswersMap[category.name] ?? null;
    const rawProbability = probabilitiesMap[category.name];
    const categoryError = isNonEmptyString(errorMap[category.name])
      ? errorMap[category.name]
      : null;
    let probability = null;
    if (categoryError === null) {
      if (isFiniteNumber(rawProbability)) {
        probability = rawProbability;
      } else if (isPlainObject(rawAnswers)) {
        probability = category.toProbability(rawAnswers);
      }
    }
    resolvedProbabilities[category.name] = probability;
  }

  const allFourPresent =
    isFiniteNumber(resolvedProbabilities[DECISION_WEIGHT_NAME]) &&
    isFiniteNumber(resolvedProbabilities[DECISION_OWNERSHIP_NAME]) &&
    isFiniteNumber(resolvedProbabilities[DEVELOPER_REFLECTION_NAME]) &&
    isFiniteNumber(resolvedProbabilities[DEVELOPER_INTENT_NAME]);

  let drivingCategory = null;
  let drivingRole = null;
  if (allFourPresent) {
    const combination = combineProbabilities(resolvedProbabilities);
    drivingCategory = selectDrivingCategory(combination, presetPauseThreshold);
    drivingRole =
      combination.pauseProbability >= presetPauseThreshold
        ? "dominant"
        : "limiting";
  }

  const categories = {};
  for (const category of activeRegistry) {
    const rawAnswers = rawAnswersMap[category.name] ?? null;
    const probability = resolvedProbabilities[category.name] ?? null;
    const categoryError = isNonEmptyString(errorMap[category.name])
      ? errorMap[category.name]
      : null;
    const rawLatency = latencyMap[category.name];
    const latencyMs = isFiniteNumber(rawLatency) ? rawLatency : null;
    const role = category.name === drivingCategory ? drivingRole : null;

    if (includeFullQuestions) {
      categories[category.name] = {
        readable_name: category.readableName,
        section: isPlainObject(state) ? sectionFor(category, state) : null,
        questions: questionsMap[category.name] ?? category.questions,
        answers: extractCategoryAnswers(category, rawAnswers),
        raw_answers: rawAnswers,
        probability,
        role,
        latency_ms: latencyMs,
        error: categoryError,
      };
    } else {
      categories[category.name] = {
        readable_name: category.readableName,
        questions: Object.keys(category.questions),
        answers: extractCategoryAnswers(category, rawAnswers),
        probability,
        role,
        latency_ms: latencyMs,
        error: categoryError,
      };
    }
  }

  return categories;
}

/**
 * Build a summary line for `jev-experiment.jsonl` at `SUMMARY_SCHEMA_VERSION`,
 * grouping category records by iterating the category registry and emitting
 * only the nested shape (`categories`, `formula_inputs`, `timings`,
 * `models`) plus `score_before` and the join key `{ prompt_id, session_id, ts }`.
 *
 * @param {object} parts - Summary line inputs.
 * @param {Date} parts.startedAt - When the runner started.
 * @param {object} [parts.context] - `{ stopInput, projectDir, score_before }`.
 * @param {string} [parts.model] - Requested `jev…` model id.
 * @param {string} parts.provider - `"jev"`, `"skipped"`, or `"headless_fallback"`.
 * @param {string} parts.status - Child status or failure reason.
 * @param {object|null} [parts.child] - Parsed child stdout object.
 * @param {object} [parts.result] - Result returned to `classify`.
 * @param {number|null} [parts.fallbackMs] - Duration of fallback call in ms.
 * @param {number} [parts.runnerTotalMs] - Wall-clock duration of `runJev` in ms.
 * @param {readonly object[]} [parts.registry] - Category registry override.
 * @param {object} [parts.config] - Project configuration override.
 * @param {object} [parts.personalState] - Personal state override.
 * @param {string} [parts.homeDir] - Home directory override.
 * @returns {object} Complete summary line.
 */
export function buildSummaryLine({
  startedAt,
  context,
  model,
  provider,
  status,
  child,
  result,
  fallbackMs = null,
  runnerTotalMs = null,
  registry = CATEGORY_REGISTRY,
  config: configOverride,
  personalState: personalStateOverride,
  homeDir: homeDirOverride,
}) {
  const activeRegistry = Array.isArray(registry) ? registry : CATEGORY_REGISTRY;
  const startedDate = startedAt instanceof Date ? startedAt : new Date();
  const projectDir = context?.projectDir;
  const resolvedHome = resolveHomeDir(homeDirOverride ?? context?.homeDir);

  let sessionId = null;
  if (isNonEmptyString(context?.stopInput?.session_id)) {
    sessionId = context.stopInput.session_id;
  } else if (isNonEmptyString(context?.session_id)) {
    sessionId = context.session_id;
  }

  let config = normalizeConfig({});
  if (isPlainObject(configOverride)) {
    config = configOverride;
  } else if (isNonEmptyString(projectDir)) {
    config = loadConfig(projectDir);
  }

  let personalState = {};
  if (isPlainObject(personalStateOverride)) {
    personalState = personalStateOverride;
  } else if (isNonEmptyString(projectDir)) {
    personalState = loadState(projectDir, resolvedHome);
  }

  const preset = effectivePreset(config, personalState);
  const presetPauseThreshold = PAUSE_THRESHOLDS[preset];

  const childLog = isPlainObject(child?.log) ? child.log : {};
  let probabilities = null;
  if (isPlainObject(childLog.probabilities)) {
    probabilities = childLog.probabilities;
  } else if (isPlainObject(child?.probabilities)) {
    probabilities = child.probabilities;
  }

  const categories = buildCategoriesLog({
    registry: activeRegistry,
    answersByCategory: childLog.answers_by_category,
    probabilities,
    categoryLatencyMs: childLog.category_latency_ms,
    categoryErrors: childLog.category_errors,
    presetPauseThreshold,
    includeFullQuestions: false,
  });

  const allFourPresent =
    isFiniteNumber(categories[DECISION_WEIGHT_NAME]?.probability) &&
    isFiniteNumber(categories[DECISION_OWNERSHIP_NAME]?.probability) &&
    isFiniteNumber(categories[DEVELOPER_REFLECTION_NAME]?.probability) &&
    isFiniteNumber(categories[DEVELOPER_INTENT_NAME]?.probability);

  const probabilityMapForFormula = {};
  for (const category of activeRegistry) {
    probabilityMapForFormula[category.name] =
      categories[category.name]?.probability ?? null;
  }

  const combination = allFourPresent
    ? combineProbabilities(probabilityMapForFormula)
    : null;

  const decisionWeight = categories[DECISION_WEIGHT_NAME]?.probability ?? null;
  const decisionOwnership =
    categories[DECISION_OWNERSHIP_NAME]?.probability ?? null;
  const developerReflection =
    categories[DEVELOPER_REFLECTION_NAME]?.probability ?? null;
  const developerIntent =
    categories[DEVELOPER_INTENT_NAME]?.probability ?? null;
  const developerReflectionReductionMultiplier = combination
    ? combination.developerReflectionReductionMultiplier
    : null;
  const developerIntentReductionMultiplier = combination
    ? combination.developerIntentReductionMultiplier
    : null;
  const pauseProbability = combination ? combination.pauseProbability : null;

  const formulaInputs = {
    decision_weight: decisionWeight,
    decision_ownership: decisionOwnership,
    developer_reflection: developerReflection,
    developer_intent: developerIntent,
    developer_reflection_reduction_multiplier:
      developerReflectionReductionMultiplier,
    developer_intent_reduction_multiplier: developerIntentReductionMultiplier,
  };

  const categoryFailed = isCategoryFailed({
    status,
    childStatus: childLog.status,
    categories,
    category_errors: childLog.category_errors,
    verdict: isPlainObject(child?.value) ? child.value : null,
  });
  // Only a Jev category failure drops Haiku out of verdict and subcategory.
  // A fallback such as no_key still logs Haiku there.
  const jevVerdictDiscarded = isHeadlessFallback(provider) && categoryFailed;
  let verdict = null;
  if (!jevVerdictDiscarded && hasOkVerdict(result)) {
    verdict = {
      decision_found: result.value.decision_found,
      subcategory: result.value.subcategory ?? null,
      reason:
        typeof result.value.reason === "string" ? result.value.reason : "",
      confidence: isFiniteNumber(result.value.confidence)
        ? result.value.confidence
        : null,
    };
  }

  const haikuLabels = haikuLabelsFromResult(provider, result, config);
  let decisionFound =
    verdict !== null && typeof verdict.decision_found === "boolean"
      ? verdict.decision_found
      : null;
  let confidence = verdict ? verdict.confidence : null;
  if (jevVerdictDiscarded && hasOkVerdict(result)) {
    decisionFound =
      typeof result.value.decision_found === "boolean"
        ? result.value.decision_found
        : null;
    confidence = isFiniteNumber(result.value.confidence)
      ? result.value.confidence
      : null;
  }

  const scoreBefore = isFiniteNumber(context?.score_before)
    ? context.score_before
    : null;

  let resolvedJevModel = null;
  if (isNonEmptyString(model)) {
    resolvedJevModel = model;
  } else if (isNonEmptyString(childLog.jev_model)) {
    resolvedJevModel = childLog.jev_model;
  }

  const categoryLatencyMap = {};
  for (const category of activeRegistry) {
    categoryLatencyMap[category.name] =
      categories[category.name]?.latency_ms ?? null;
  }

  const sonnetMs = isFiniteNumber(childLog.sonnet_ms)
    ? childLog.sonnet_ms
    : null;
  const jevMs = isFiniteNumber(childLog.jev_ms) ? childLog.jev_ms : null;
  const resolvedFallbackMs = isFiniteNumber(fallbackMs) ? fallbackMs : null;
  const resolvedRunnerTotalMs = isFiniteNumber(runnerTotalMs)
    ? runnerTotalMs
    : Math.max(0, Date.now() - startedDate.getTime());

  const timings = {
    sonnet_ms: sonnetMs,
    jev_ms: jevMs,
    categories: categoryLatencyMap,
    fallback_ms: resolvedFallbackMs,
    runner_total_ms: resolvedRunnerTotalMs,
  };

  const stateModel = isNonEmptyString(childLog.state_model)
    ? childLog.state_model
    : STATE_MODEL;
  const modelVersion = isNonEmptyString(childLog.model_version)
    ? childLog.model_version
    : null;
  const fallbackModel = isHeadlessFallback(provider) ? FALLBACK_MODEL : null;

  const models = {
    state_model: stateModel,
    jev_model: resolvedJevModel,
    model_version: modelVersion,
    fallback_model: fallbackModel,
  };

  const failedCategoryErrors = [];
  for (const [categoryName, categoryEntry] of Object.entries(categories)) {
    if (hasCategoryEntryError(categoryEntry)) {
      failedCategoryErrors.push(`${categoryName}:${categoryEntry.error}`);
    }
  }
  const resolvedStatus = categoryFailed ? CATEGORY_FAILED : status;

  let errorText = null;
  if (isNonEmptyString(child?.error)) {
    errorText = child.error;
  } else if (isNonEmptyString(childLog.error)) {
    errorText = childLog.error;
  } else if (failedCategoryErrors.length > 0) {
    errorText = failedCategoryErrors.join(", ");
  }

  let promptId = null;
  if (isNonEmptyString(childLog.prompt_id)) {
    promptId = childLog.prompt_id;
  } else if (isNonEmptyString(context?.prompt_id)) {
    promptId = context.prompt_id;
  } else if (isNonEmptyString(context?.stopInput?.transcript_path)) {
    promptId =
      readTurns(context.stopInput.transcript_path).at(-1)?.promptId ?? null;
  }

  return {
    schema_version: SUMMARY_SCHEMA_VERSION,
    ts: startedDate.toISOString(),
    session_id: sessionId,
    prompt_id: promptId,
    provider,
    status: resolvedStatus,
    category_failed: categoryFailed,
    jev_failed_categories: jevFailedCategoryNames(childLog.category_errors),
    haiku_category: haikuLabels.haikuCategory,
    haiku_subcategory: haikuLabels.haikuSubcategory,
    haiku_verdict: haikuVerdictFromResult(provider, result),
    error: errorText,
    categories,
    formula_inputs: formulaInputs,
    pause_probability: pauseProbability,
    preset,
    preset_pause_threshold: presetPauseThreshold,
    confidence,
    decision_found: decisionFound,
    subcategory: verdict ? verdict.subcategory : null,
    verdict,
    score_before: scoreBefore,
    timings,
    models,
    input_file: childLog.input_file ?? null,
    turns_included: isFiniteNumber(childLog.turns_included)
      ? childLog.turns_included
      : null,
    state_chars: isFiniteNumber(childLog.state_chars)
      ? childLog.state_chars
      : null,
    current_has_changes:
      typeof childLog.current_has_changes === "boolean"
        ? childLog.current_has_changes
        : null,
  };
}

/**
 * Append one summary line to `personalStateDir/jev-experiment.jsonl`.
 * Never throws, never logs secrets, and never prunes prior lines.
 *
 * @param {string} projectDir - The project directory.
 * @param {object} line - The summary record.
 * @param {object} [options] - Optional writer settings (`{ homeDir }`).
 */
export function appendSummaryLine(projectDir, line, options) {
  try {
    if (!isNonEmptyString(projectDir)) {
      return;
    }
    const targetPath = summaryLogPath(projectDir, options);
    const sanitized = sanitizeLogRecord(
      projectDir,
      {
        schema_version: SUMMARY_SCHEMA_VERSION,
        ...(isPlainObject(line) ? line : {}),
      },
      options,
    );

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.appendFileSync(targetPath, `${JSON.stringify(sanitized)}\n`, "utf8");
  } catch {
    // A lost line costs the experiment one data point, nothing more.
  }
}

/**
 * Write one full-input file under
 * `personalStateDir/jev-experiment/<ts>.json`. Never throws, never logs
 * secrets, and never prunes prior files.
 *
 * @param {string} projectDir - The project directory.
 * @param {Date} date - The moment that names the file.
 * @param {object} record - Full per-call record.
 * @param {object} [options] - Optional writer settings (`{ homeDir }`).
 * @returns {string|null} The file name, or null when nothing was written.
 */
export function writeInputFile(projectDir, date, record, options) {
  try {
    if (!isNonEmptyString(projectDir)) {
      return null;
    }
    const directory = inputDirPath(projectDir, options);
    const moment = date instanceof Date ? date : new Date();
    const fileName = `${fileTimestamp(moment)}.json`;
    const sanitized = sanitizeLogRecord(
      projectDir,
      {
        schema_version: STATE_SCHEMA_VERSION,
        ...(isPlainObject(record) ? record : {}),
      },
      options,
    );

    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, fileName),
      `${JSON.stringify(sanitized, null, 2)}\n`,
      "utf8",
    );

    return fileName;
  } catch {
    return null;
  }
}
