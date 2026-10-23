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
// carry `score_before` plus the join key `{ prompt_id, session_id, ts }`, and
// `joinSummaryWithLocalTrace` joins them to `local-trace.jsonl`.
//
// Writing or reading a log never throws: observation must not break the
// observed turn. Neither tier ever logs the TypeSafe API key or any
// environment secret, and logs are never pruned.
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
import { name as decisionOwnershipName } from "./categories/decision-ownership.js";
import { name as decisionWeightName } from "./categories/decision-weight.js";
import { name as developerIntentName } from "./categories/developer-intent.js";
import { name as developerReflectionName } from "./categories/developer-reflection.js";
import { CATEGORY_REGISTRY, sectionFor } from "./categories/index.js";
import { combineProbabilities, selectDrivingCategory } from "./combine.js";
import {
  FALLBACK_MODEL,
  PAUSE_THRESHOLDS,
  STATE_MODEL,
  STATE_SCHEMA_VERSION,
  SUMMARY_SCHEMA_VERSION,
  SUMMARY_SCHEMA_VERSION_ONE,
  SUMMARY_SCHEMA_VERSION_THREE,
  SUMMARY_SCHEMA_VERSION_TWO,
} from "./constants.js";
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

/** Object property names that must never be serialized to either log tier. */
const SECRET_PROPERTY_PATTERN =
  /^(?:api_?key|typesafe_api_key|anthropic_api_key|secret|token|password|authorization|credential|env)$/i;

/** Environment variable names whose values must never appear in logs. */
const ENV_SECRET_NAME_PATTERN =
  /(?:api_?key|secret|token|password|credential|auth)/i;

/** Duplicated flat keys normalized into `formula_inputs`, `timings`, and `models`. */
const LEGACY_FLAT_SUMMARY_KEYS = Object.freeze([
  "decision_weight",
  "decision_ownership",
  "developer_reflection",
  "developer_intent",
  "developer_reflection_reduction_multiplier",
  "developer_intent_reduction_multiplier",
  "sonnet_ms",
  "jev_ms",
  "category_latency_ms",
  "fallback_ms",
  "total_ms",
  "latency_ms",
  "state_model",
  "jev_model",
  "model_version",
  "fallback_model",
]);

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
 * Parse a timestamp that may be numeric epoch milliseconds, a numeric string,
 * or an ISO-8601 date string into numeric epoch milliseconds.
 *
 * @param {unknown} rawTimestamp - Raw timestamp value.
 * @returns {number|null} Epoch milliseconds, or null when unparseable.
 */
export function parseTimestampMs(rawTimestamp) {
  if (isFiniteNumber(rawTimestamp) && rawTimestamp >= 0) {
    return rawTimestamp;
  }
  if (!isNonEmptyString(rawTimestamp)) {
    return null;
  }
  const trimmed = rawTimestamp.trim();
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const numericValue = Number(trimmed);
    return isFiniteNumber(numericValue) && numericValue >= 0
      ? numericValue
      : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return null;
  }
  const parsedMs = Date.parse(trimmed);
  return isFiniteNumber(parsedMs) ? parsedMs : null;
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
export function hasCategoryError(categories) {
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
    if (ENV_SECRET_NAME_PATTERN.test(envName)) {
      collectSecretValue(secrets, envValue);
    }
  }

  if (isPlainObject(options)) {
    for (const [key, value] of Object.entries(options)) {
      if (SECRET_PROPERTY_PATTERN.test(key)) {
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
      if (SECRET_PROPERTY_PATTERN.test(key)) {
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
    if (SECRET_PROPERTY_PATTERN.test(key)) {
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
    isFiniteNumber(resolvedProbabilities[decisionWeightName]) &&
    isFiniteNumber(resolvedProbabilities[decisionOwnershipName]) &&
    isFiniteNumber(resolvedProbabilities[developerReflectionName]) &&
    isFiniteNumber(resolvedProbabilities[developerIntentName]);

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
 * @param {number} [parts.totalMs] - Legacy alias for `runnerTotalMs`.
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
  totalMs = null,
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
    isFiniteNumber(categories[decisionWeightName]?.probability) &&
    isFiniteNumber(categories[decisionOwnershipName]?.probability) &&
    isFiniteNumber(categories[developerReflectionName]?.probability) &&
    isFiniteNumber(categories[developerIntentName]?.probability);

  const probabilityMapForFormula = {};
  for (const category of activeRegistry) {
    probabilityMapForFormula[category.name] =
      categories[category.name]?.probability ?? null;
  }

  const combination = allFourPresent
    ? combineProbabilities(probabilityMapForFormula)
    : null;

  const decisionWeight = categories[decisionWeightName]?.probability ?? null;
  const decisionOwnership =
    categories[decisionOwnershipName]?.probability ?? null;
  const developerReflection =
    categories[developerReflectionName]?.probability ?? null;
  const developerIntent = categories[developerIntentName]?.probability ?? null;
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
  const explicitRunnerSpan = isFiniteNumber(runnerTotalMs)
    ? runnerTotalMs
    : totalMs;
  const resolvedRunnerTotalMs = isFiniteNumber(explicitRunnerSpan)
    ? explicitRunnerSpan
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

/**
 * Normalize legacy flat v1/v2 formula inputs into the nested `formula_inputs`
 * object when `formula_inputs` is not already present.
 *
 * @param {object} parsed - Parsed raw summary line.
 * @returns {object} Normalized `formula_inputs` object.
 */
function normalizeFormulaInputs(parsed) {
  if (isPlainObject(parsed.formula_inputs)) {
    return {
      decision_weight: isFiniteNumber(parsed.formula_inputs.decision_weight)
        ? parsed.formula_inputs.decision_weight
        : null,
      decision_ownership: isFiniteNumber(
        parsed.formula_inputs.decision_ownership,
      )
        ? parsed.formula_inputs.decision_ownership
        : null,
      developer_reflection: isFiniteNumber(
        parsed.formula_inputs.developer_reflection,
      )
        ? parsed.formula_inputs.developer_reflection
        : null,
      developer_intent: isFiniteNumber(parsed.formula_inputs.developer_intent)
        ? parsed.formula_inputs.developer_intent
        : null,
      developer_reflection_reduction_multiplier: isFiniteNumber(
        parsed.formula_inputs.developer_reflection_reduction_multiplier,
      )
        ? parsed.formula_inputs.developer_reflection_reduction_multiplier
        : null,
      developer_intent_reduction_multiplier: isFiniteNumber(
        parsed.formula_inputs.developer_intent_reduction_multiplier,
      )
        ? parsed.formula_inputs.developer_intent_reduction_multiplier
        : null,
    };
  }

  let decisionWeight = null;
  if (isFiniteNumber(parsed.decision_weight)) {
    decisionWeight = parsed.decision_weight;
  } else if (isFiniteNumber(parsed.significant_choice)) {
    decisionWeight = parsed.significant_choice;
  }

  let decisionOwnership = null;
  if (isFiniteNumber(parsed.decision_ownership)) {
    decisionOwnership = parsed.decision_ownership;
  } else if (isFiniteNumber(parsed.assistant_choice)) {
    decisionOwnership = parsed.assistant_choice;
  }

  let developerReflection = null;
  if (isFiniteNumber(parsed.developer_reflection)) {
    developerReflection = parsed.developer_reflection;
  } else if (isFiniteNumber(parsed.visible_reflection)) {
    developerReflection = parsed.visible_reflection;
  }

  let developerIntent = null;
  if (isFiniteNumber(parsed.developer_intent)) {
    developerIntent = parsed.developer_intent;
  } else if (isFiniteNumber(parsed.developer_named_it)) {
    developerIntent = parsed.developer_named_it;
  }

  return {
    decision_weight: decisionWeight,
    decision_ownership: decisionOwnership,
    developer_reflection: developerReflection,
    developer_intent: developerIntent,
    developer_reflection_reduction_multiplier: null,
    developer_intent_reduction_multiplier: null,
  };
}

/**
 * Normalize legacy flat timing fields into the nested `timings` object.
 *
 * @param {object} parsed - Parsed raw summary line.
 * @returns {object} Normalized `timings` object.
 */
function normalizeTimings(parsed) {
  if (isPlainObject(parsed.timings)) {
    let nestedRunnerTotalMs = null;
    if (isFiniteNumber(parsed.timings.runner_total_ms)) {
      nestedRunnerTotalMs = parsed.timings.runner_total_ms;
    } else if (isFiniteNumber(parsed.timings.total_ms)) {
      nestedRunnerTotalMs = parsed.timings.total_ms;
    }
    return {
      sonnet_ms: isFiniteNumber(parsed.timings.sonnet_ms)
        ? parsed.timings.sonnet_ms
        : null,
      jev_ms: isFiniteNumber(parsed.timings.jev_ms)
        ? parsed.timings.jev_ms
        : null,
      categories: isPlainObject(parsed.timings.categories)
        ? parsed.timings.categories
        : null,
      fallback_ms: isFiniteNumber(parsed.timings.fallback_ms)
        ? parsed.timings.fallback_ms
        : null,
      runner_total_ms: nestedRunnerTotalMs,
    };
  }

  let runnerTotalMs = null;
  if (isFiniteNumber(parsed.runner_total_ms)) {
    runnerTotalMs = parsed.runner_total_ms;
  } else if (isFiniteNumber(parsed.total_ms)) {
    runnerTotalMs = parsed.total_ms;
  } else if (isFiniteNumber(parsed.latency_ms)) {
    runnerTotalMs = parsed.latency_ms;
  }

  return {
    sonnet_ms: isFiniteNumber(parsed.sonnet_ms) ? parsed.sonnet_ms : null,
    jev_ms: isFiniteNumber(parsed.jev_ms) ? parsed.jev_ms : null,
    categories: isPlainObject(parsed.category_latency_ms)
      ? parsed.category_latency_ms
      : null,
    fallback_ms: isFiniteNumber(parsed.fallback_ms) ? parsed.fallback_ms : null,
    runner_total_ms: runnerTotalMs,
  };
}

/**
 * Normalize legacy flat model fields into the nested `models` object.
 *
 * @param {object} parsed - Parsed raw summary line.
 * @returns {object} Normalized `models` object.
 */
function normalizeModels(parsed) {
  if (isPlainObject(parsed.models)) {
    return {
      state_model: isNonEmptyString(parsed.models.state_model)
        ? parsed.models.state_model
        : null,
      jev_model: isNonEmptyString(parsed.models.jev_model)
        ? parsed.models.jev_model
        : null,
      model_version: isNonEmptyString(parsed.models.model_version)
        ? parsed.models.model_version
        : null,
      fallback_model: isNonEmptyString(parsed.models.fallback_model)
        ? parsed.models.fallback_model
        : null,
    };
  }

  return {
    state_model: isNonEmptyString(parsed.state_model)
      ? parsed.state_model
      : null,
    jev_model: isNonEmptyString(parsed.jev_model) ? parsed.jev_model : null,
    model_version: isNonEmptyString(parsed.model_version)
      ? parsed.model_version
      : null,
    fallback_model: isNonEmptyString(parsed.fallback_model)
      ? parsed.fallback_model
      : null,
  };
}

/**
 * Parse and normalize one line from `jev-experiment.jsonl`, handling v1, v2,
 * v3, and v4 records, normalizing legacy flat fields into the nested shape
 * (`formula_inputs`, `timings`, `models`, `categories`), and returning `null`
 * on blank or torn lines. Never throws.
 *
 * @param {unknown} rawLine - Raw JSONL line string or parsed object.
 * @returns {object|null} Normalized summary record with `schema_version` 1, 2,
 *   3, or 4, or null when unreadable.
 */
export function parseSummaryLine(rawLine) {
  try {
    let parsed = rawLine;
    if (typeof rawLine === "string") {
      if (rawLine.trim() === "") {
        return null;
      }
      parsed = JSON.parse(rawLine);
    }
    if (!isPlainObject(parsed)) {
      return null;
    }

    let schemaVersion = SUMMARY_SCHEMA_VERSION_ONE;
    if (parsed.schema_version === SUMMARY_SCHEMA_VERSION) {
      schemaVersion = SUMMARY_SCHEMA_VERSION;
    } else if (
      parsed.schema_version === SUMMARY_SCHEMA_VERSION_THREE ||
      parsed.schema_version === STATE_SCHEMA_VERSION ||
      isPlainObject(parsed.categories)
    ) {
      schemaVersion = SUMMARY_SCHEMA_VERSION_THREE;
    } else if (
      parsed.schema_version === SUMMARY_SCHEMA_VERSION_TWO ||
      "assistant_choice" in parsed ||
      "developer_named_it" in parsed
    ) {
      schemaVersion = SUMMARY_SCHEMA_VERSION_TWO;
    } else if (
      parsed.schema_version === SUMMARY_SCHEMA_VERSION_ONE ||
      "significant_choice" in parsed ||
      "visible_reflection" in parsed ||
      "context_sufficient" in parsed
    ) {
      schemaVersion = SUMMARY_SCHEMA_VERSION_ONE;
    }

    const normalized = { ...parsed };
    for (const flatKey of LEGACY_FLAT_SUMMARY_KEYS) {
      delete normalized[flatKey];
    }
    delete normalized.score_after;

    normalized.schema_version = schemaVersion;
    normalized.categories = isPlainObject(parsed.categories)
      ? parsed.categories
      : {};
    normalized.formula_inputs = normalizeFormulaInputs(parsed);
    normalized.timings = normalizeTimings(parsed);
    normalized.models = normalizeModels(parsed);

    if (isCategoryFailed(normalized)) {
      normalized.status = CATEGORY_FAILED;
      normalized.category_failed = true;
    } else if (typeof normalized.category_failed !== "boolean") {
      normalized.category_failed = false;
    }

    return normalized;
  } catch {
    return null;
  }
}

/**
 * Read all valid summary lines from `personalStateDir/jev-experiment.jsonl`,
 * handling v1, v2, v3, and v4 lines in the same file while skipping blank or torn
 * lines. Never throws.
 *
 * @param {string} projectDir - Project root directory.
 * @param {object} [options] - Reader options (`{ homeDir }`).
 * @returns {object[]} Parsed and normalized summary lines in append order.
 */
export function readSummaryLines(projectDir, options) {
  try {
    if (!isNonEmptyString(projectDir)) {
      return [];
    }
    const raw = fs.readFileSync(summaryLogPath(projectDir, options), "utf8");
    const records = [];
    for (const line of raw.split(/\r?\n/)) {
      const parsed = parseSummaryLine(line);
      if (parsed !== null) {
        records.push(parsed);
      }
    }
    return records;
  } catch {
    return [];
  }
}

/**
 * Parse a candidate local-trace record (object or JSON string).
 *
 * @param {unknown} candidate - Raw trace line or parsed object.
 * @returns {object|null} Plain object or null.
 */
function parseTraceCandidate(candidate) {
  try {
    const parsed =
      typeof candidate === "string" ? JSON.parse(candidate) : candidate;
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Check whether a local-trace decision record matches a summary line's
 * exact `{ prompt_id, session_id, turn_ts === ts }` join key.
 *
 * @param {object} summaryLine - Normalized or raw summary line.
 * @param {object} traceRecord - Parsed local-trace record.
 * @returns {boolean} True when both records belong to the same turn decision.
 */
function matchesTraceJoinKey(summaryLine, traceRecord) {
  if (
    !isPlainObject(summaryLine) ||
    !isPlainObject(traceRecord) ||
    !isFiniteNumber(traceRecord.score_after)
  ) {
    return false;
  }
  if (isNonEmptyString(traceRecord.hook) && traceRecord.hook !== "Stop") {
    return false;
  }
  if ((summaryLine.session_id ?? null) !== (traceRecord.session_id ?? null)) {
    return false;
  }
  if ((summaryLine.prompt_id ?? null) !== (traceRecord.prompt_id ?? null)) {
    return false;
  }
  const rawSummaryTs = summaryLine.ts;
  const rawTraceTurnTs = traceRecord.turn_ts;
  if (
    isNonEmptyString(rawSummaryTs) &&
    isNonEmptyString(rawTraceTurnTs) &&
    rawSummaryTs === rawTraceTurnTs
  ) {
    return true;
  }
  const summaryTsMs = parseTimestampMs(rawSummaryTs);
  const traceTurnTsMs = parseTimestampMs(rawTraceTurnTs);
  if (summaryTsMs === null || traceTurnTsMs === null) {
    return false;
  }
  return summaryTsMs === traceTurnTsMs;
}

/**
 * Join `jev-experiment.jsonl` summary lines with `local-trace.jsonl` records
 * by `{ prompt_id, session_id, ts }`, attaching the traced `score_after` (or
 * `null` when no trace record matches). Never throws.
 *
 * @param {unknown} summaryLines - Summary line objects or raw JSONL lines.
 * @param {unknown} traceRecords - Local-trace objects or raw JSONL lines.
 * @returns {object[]} Summary lines with `score_after` attached.
 */
export function joinSummaryWithLocalTrace(summaryLines, traceRecords) {
  try {
    if (!Array.isArray(summaryLines)) {
      return [];
    }
    const parsedTraces = Array.isArray(traceRecords)
      ? traceRecords
          .map((entry) => parseTraceCandidate(entry))
          .filter((entry) => entry !== null)
      : [];

    const joined = [];
    for (const entry of summaryLines) {
      const line = isPlainObject(entry) ? entry : parseSummaryLine(entry);
      if (!isPlainObject(line)) {
        continue;
      }
      const match = parsedTraces.find((traceRecord) =>
        matchesTraceJoinKey(line, traceRecord),
      );
      joined.push({
        ...line,
        score_after: match ? match.score_after : null,
      });
    }
    return joined;
  } catch {
    return [];
  }
}

/**
 * Read one Tier-2 full record from `personalStateDir/jev-experiment/<file>`.
 * Never throws.
 *
 * @param {string} projectDir - Project root directory.
 * @param {string} fileName - File name returned by `writeInputFile`.
 * @param {object} [options] - Reader options (`{ homeDir }`).
 * @returns {object|null} Parsed record, or null when missing or unreadable.
 */
export function readInputRecord(projectDir, fileName, options) {
  try {
    if (!isNonEmptyString(projectDir) || !isNonEmptyString(fileName)) {
      return null;
    }
    const safeName = path.basename(fileName);
    const fullPath = path.join(inputDirPath(projectDir, options), safeName);
    const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
