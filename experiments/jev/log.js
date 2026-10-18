// The experiment's two-tier logs, beside the personal engine state and never in
// the repository:
//
// - `jev-experiment.jsonl`: one v3 summary line per classification, written by
//   `runner.js`, the only place that knows whether the fallback ran;
// - `jev-experiment/<ts>.json`: the v3 full record (Sonnet input summary,
//   structured state, and per-category question/answer sets), written by
//   `run.js`, the only place that holds them.
//
// Writing or reading a log never throws: observation must not break the
// observed turn. Neither tier ever logs the TypeSafe API key or any
// environment secret, and logs are never pruned.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §Jev experiment logs (structured-state branch, `schema_version: 3`).
//
// Experiment only (`feature/jev-classifier-experiment`, never merged).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseEnv } from "node:util";

import { isMuted } from "../../src/core/gates.js";
import {
  clampFinite,
  isFiniteNumber,
  isNonEmptyString,
  isPlainObject,
} from "../../src/core/predicates.js";
import { relievedScore } from "../../src/core/scoring.js";
import {
  JEV_GENERAL_CATEGORY,
  validateClassification,
} from "../../src/io/classifier.js";
import {
  effectivePreset,
  loadConfig,
  normalizeConfig,
  resolveKnobs,
} from "../../src/io/config/config.js";
import { personalStateDir } from "../../src/io/paths.js";
import { loadState } from "../../src/io/state.js";
import { name as decisionOwnershipName } from "./categories/decision-ownership.js";
import { name as decisionWeightName } from "./categories/decision-weight.js";
import { name as developerIntentName } from "./categories/developer-intent.js";
import { name as developerReflectionName } from "./categories/developer-reflection.js";
import { CATEGORY_REGISTRY, sectionFor } from "./categories/index.js";
import {
  FALLBACK_MODEL,
  PAUSE_THRESHOLDS,
  STATE_MODEL,
  STATE_SCHEMA_VERSION,
  VETO_COOLDOWN_RATIO,
} from "./constants.js";
import { readApiKey } from "./env.js";
import { combineProbabilities } from "./run.js";

/** The summary log's file name under `personalStateDir`. */
export const SUMMARY_FILE_NAME = "jev-experiment.jsonl";

/** The directory holding one full-input file per Jev call. */
export const INPUT_DIR_NAME = "jev-experiment";

/** Minimum length for a secret value to be scrubbed from serialized strings. */
const MIN_SECRET_LENGTH = 4;

/** Object property names that must never be serialized to either log tier. */
const SECRET_PROPERTY_PATTERN =
  /^(?:api_?key|typesafe_api_key|anthropic_api_key|secret|token|password|authorization|credential|env)$/i;

/** Environment variable names whose values must never appear in logs. */
const ENV_SECRET_NAME_PATTERN =
  /(?:api_?key|secret|token|password|credential|auth)/i;

/** Categories whose probability represents developer reflection/intent. */
const REFLECTION_CATEGORY_NAMES = new Set([
  developerReflectionName,
  developerIntentName,
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
 * Derive one category's decision label from its probability and error state.
 *
 * @param {string} categoryName - Registry category name.
 * @param {unknown} probability - Category probability in [0, 1], or null.
 * @param {number} presetPauseThreshold - Active preset's pause threshold.
 * @param {unknown} categoryError - Error class or `"unusable_answer"` on failure.
 * @param {boolean} ranJev - Whether the Jev category step ran.
 * @returns {"pause"|"no_pause"|"failed"|"skipped"} Category decision label.
 */
export function categoryDecisionFor(
  categoryName,
  probability,
  presetPauseThreshold,
  categoryError,
  ranJev,
) {
  if (!ranJev) {
    return "skipped";
  }
  if (isNonEmptyString(categoryError) || !isFiniteNumber(probability)) {
    return "failed";
  }
  const clamped = clampFinite(probability, 0, 1);
  const pauseFactor = REFLECTION_CATEGORY_NAMES.has(categoryName)
    ? 1 - clamped
    : clamped;
  return pauseFactor >= presetPauseThreshold ? "pause" : "no_pause";
}

/**
 * Build per-category records by iterating the category registry rather than a
 * hardcoded list of category names.
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
 * @param {boolean} [params.ranJev] - Whether the Jev category step ran.
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
  ranJev = false,
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

  const categories = {};
  for (const category of activeRegistry) {
    const rawAnswers = rawAnswersMap[category.name] ?? null;
    const rawProbability = probabilitiesMap[category.name];
    let probability = null;
    if (isFiniteNumber(rawProbability)) {
      probability = rawProbability;
    } else if (isPlainObject(rawAnswers)) {
      probability = category.toProbability(rawAnswers);
    }

    const categoryError = isNonEmptyString(errorMap[category.name])
      ? errorMap[category.name]
      : null;
    const rawLatency = latencyMap[category.name];
    const latencyMs = isFiniteNumber(rawLatency) ? rawLatency : null;
    const decision = categoryDecisionFor(
      category.name,
      probability,
      presetPauseThreshold,
      categoryError,
      ranJev,
    );

    if (includeFullQuestions) {
      categories[category.name] = {
        readable_name: category.readableName,
        section: isPlainObject(state) ? sectionFor(category, state) : null,
        questions: questionsMap[category.name] ?? category.questions,
        answers: extractCategoryAnswers(category, rawAnswers),
        raw_answers: rawAnswers,
        probability,
        decision,
        latency_ms: latencyMs,
        error: categoryError,
      };
    } else {
      categories[category.name] = {
        readable_name: category.readableName,
        questions: Object.keys(category.questions),
        answers: extractCategoryAnswers(category, rawAnswers),
        probability,
        decision,
        latency_ms: latencyMs,
        error: categoryError,
      };
    }
  }

  return categories;
}

/**
 * Extract the distinct touched file paths from a turn group for mute matching.
 *
 * @param {unknown} group - Turn group object.
 * @returns {string[]} Distinct touched file paths.
 */
function touchedFilesFromGroup(group) {
  if (!isPlainObject(group) || !Array.isArray(group.edits)) {
    return [];
  }
  const files = [];
  for (const edit of group.edits) {
    if (
      isPlainObject(edit) &&
      isNonEmptyString(edit.file) &&
      !files.includes(edit.file)
    ) {
      files.push(edit.file);
    }
  }
  return files;
}

/**
 * Compute `score_after` consistent with `local-trace.jsonl` (`decideFire` and
 * `closeTurnBoundary`) for any classification result.
 *
 * @param {object} params - Score calculation inputs.
 * @param {unknown} params.scoreBefore - Score entering classification.
 * @param {object} params.config - Project configuration.
 * @param {object} params.personalState - Personal engine state.
 * @param {unknown} params.group - Turn group.
 * @param {unknown} params.model - Configured classifier model.
 * @param {unknown} params.result - Runner result returned to `classify`.
 * @returns {number|null} Cooled (or uncooled) `score_after`, or null when
 *   `scoreBefore` is not a finite number.
 */
function computeScoreAfter({
  scoreBefore,
  config,
  personalState,
  group,
  model,
  result,
}) {
  if (!isFiniteNumber(scoreBefore)) {
    return null;
  }

  const knobs = resolveKnobs(config, personalState);
  const threshold = knobs.threshold;
  const normalizedConfig = normalizeConfig(config);

  if (!isPlainObject(result) || result.status !== "ok") {
    return relievedScore(scoreBefore, threshold, VETO_COOLDOWN_RATIO);
  }

  const classification = validateClassification(result.value, config);
  if (!classification) {
    return relievedScore(scoreBefore, threshold, VETO_COOLDOWN_RATIO);
  }

  const isJevVerdict =
    isNonEmptyString(model) &&
    model.startsWith("jev") &&
    result.provider === "jev";
  if (
    isJevVerdict &&
    classification.category === null &&
    classification.subcategory === JEV_GENERAL_CATEGORY &&
    normalizedConfig.categories.length > 0
  ) {
    classification.category = JEV_GENERAL_CATEGORY;
  }

  if (
    classification.decision_found !== true ||
    classification.confidence < normalizedConfig.classifier_confidence_threshold
  ) {
    return relievedScore(scoreBefore, threshold, VETO_COOLDOWN_RATIO);
  }

  if (classification.category === null) {
    return scoreBefore;
  }

  const files = touchedFilesFromGroup(group);
  if (isMuted(personalState?.mutes, classification.category, files)) {
    return scoreBefore;
  }

  return relievedScore(scoreBefore, threshold, knobs.cooldown_ratio);
}

/**
 * Build a `schema_version: 3` summary line for `jev-experiment.jsonl`,
 * grouping category records by iterating the category registry rather than a
 * hardcoded list.
 *
 * @param {object} parts - Summary line inputs.
 * @param {Date} parts.startedAt - When the runner started.
 * @param {object} [parts.context] - `{ stopInput, projectDir, score_before }`.
 * @param {string} [parts.model] - Requested `jev…` model id.
 * @param {object} [parts.group] - Turn group.
 * @param {string} parts.provider - `"jev"`, `"skipped"`, or `"headless_fallback"`.
 * @param {string} parts.status - Child status or failure reason.
 * @param {object|null} [parts.child] - Parsed child stdout object.
 * @param {object} [parts.result] - Result returned to `classify`.
 * @param {number|null} [parts.fallbackMs] - Duration of fallback call in ms.
 * @param {number} [parts.totalMs] - Total duration of `runJev` in ms.
 * @param {readonly object[]} [parts.registry] - Category registry override.
 * @param {object} [parts.config] - Project configuration override.
 * @param {object} [parts.personalState] - Personal state override.
 * @param {string} [parts.homeDir] - Home directory override.
 * @returns {object} Complete v3 summary line.
 */
export function buildSummaryLine({
  startedAt,
  context,
  model,
  group,
  provider,
  status,
  child,
  result,
  fallbackMs = null,
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
  const { session_id: sessionId } = isPlainObject(context?.stopInput)
    ? context.stopInput
    : {};

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

  const ranJev =
    isPlainObject(probabilities) ||
    isPlainObject(childLog.answers_by_category) ||
    isPlainObject(childLog.category_latency_ms);

  const categories = buildCategoriesLog({
    registry: activeRegistry,
    answersByCategory: childLog.answers_by_category,
    probabilities,
    categoryLatencyMs: childLog.category_latency_ms,
    categoryErrors: childLog.category_errors,
    presetPauseThreshold,
    ranJev,
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
  const effectiveReflection = combination
    ? combination.effectiveReflection
    : null;
  const pauseProbability = combination ? combination.pauseProbability : null;

  const formulaInputs = {
    decision_weight: decisionWeight,
    decision_ownership: decisionOwnership,
    developer_reflection: developerReflection,
    developer_intent: developerIntent,
    effective_reflection: effectiveReflection,
  };

  let verdict = null;
  if (result?.status === "ok" && isPlainObject(result.value)) {
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

  const scoreBefore = isFiniteNumber(context?.score_before)
    ? context.score_before
    : null;
  let resolvedJevModel = null;
  if (isNonEmptyString(model)) {
    resolvedJevModel = model;
  } else if (isNonEmptyString(childLog.jev_model)) {
    resolvedJevModel = childLog.jev_model;
  }

  const scoreAfter = computeScoreAfter({
    scoreBefore,
    config,
    personalState,
    group,
    model: resolvedJevModel,
    result,
  });

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
  const resolvedTotalMs = isFiniteNumber(totalMs)
    ? totalMs
    : Math.max(0, Date.now() - startedDate.getTime());

  const timings = {
    sonnet_ms: sonnetMs,
    jev_ms: jevMs,
    categories: categoryLatencyMap,
    fallback_ms: resolvedFallbackMs,
    total_ms: resolvedTotalMs,
  };

  const stateModel = isNonEmptyString(childLog.state_model)
    ? childLog.state_model
    : STATE_MODEL;
  const modelVersion = isNonEmptyString(childLog.model_version)
    ? childLog.model_version
    : null;
  const fallbackModel =
    provider === "headless_fallback" ? FALLBACK_MODEL : null;

  const models = {
    state_model: stateModel,
    jev_model: resolvedJevModel,
    model_version: modelVersion,
    fallback_model: fallbackModel,
  };

  let errorText = null;
  if (isNonEmptyString(child?.error)) {
    errorText = child.error;
  } else if (isNonEmptyString(childLog.error)) {
    errorText = childLog.error;
  }

  const hasBooleanDecision =
    verdict !== null && typeof verdict.decision_found === "boolean";

  return {
    schema_version: STATE_SCHEMA_VERSION,
    ts: startedDate.toISOString(),
    session_id: typeof sessionId === "string" ? sessionId : null,
    prompt_id: childLog.prompt_id ?? null,
    provider,
    status,
    error: errorText,
    categories,
    formula_inputs: formulaInputs,
    decision_weight: decisionWeight,
    decision_ownership: decisionOwnership,
    developer_reflection: developerReflection,
    developer_intent: developerIntent,
    effective_reflection: effectiveReflection,
    pause_probability: pauseProbability,
    preset,
    preset_pause_threshold: presetPauseThreshold,
    confidence: verdict ? verdict.confidence : null,
    decision_found: hasBooleanDecision ? verdict.decision_found : null,
    subcategory: verdict ? verdict.subcategory : null,
    verdict,
    score_before: scoreBefore,
    score_after: scoreAfter,
    timings,
    sonnet_ms: sonnetMs,
    jev_ms: jevMs,
    category_latency_ms: categoryLatencyMap,
    fallback_ms: resolvedFallbackMs,
    total_ms: resolvedTotalMs,
    latency_ms: resolvedTotalMs,
    models,
    state_model: stateModel,
    jev_model: resolvedJevModel,
    model_version: modelVersion,
    fallback_model: fallbackModel,
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
        schema_version: STATE_SCHEMA_VERSION,
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
 * Write one `schema_version: 3` full-input file under
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
 * Parse and normalize one line from `jev-experiment.jsonl`, handling v1, v2,
 * and v3 records and returning `null` on blank or torn lines. Never throws.
 *
 * @param {unknown} rawLine - Raw JSONL line string or parsed object.
 * @returns {object|null} Normalized summary record with `schema_version` 1, 2,
 *   or 3, or null when unreadable.
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

    let schemaVersion = 1;
    if (
      parsed.schema_version === STATE_SCHEMA_VERSION ||
      isPlainObject(parsed.categories)
    ) {
      schemaVersion = STATE_SCHEMA_VERSION;
    } else if (
      parsed.schema_version === 2 ||
      "reflex_approval" in parsed ||
      "assistant_choice" in parsed ||
      "developer_named_it" in parsed
    ) {
      schemaVersion = 2;
    } else if (
      parsed.schema_version === 1 ||
      "significant_choice" in parsed ||
      "visible_reflection" in parsed ||
      "context_sufficient" in parsed
    ) {
      schemaVersion = 1;
    }

    let totalMs = null;
    if (isFiniteNumber(parsed.total_ms)) {
      totalMs = parsed.total_ms;
    } else if (isFiniteNumber(parsed.latency_ms)) {
      totalMs = parsed.latency_ms;
    }

    return {
      ...parsed,
      schema_version: schemaVersion,
      total_ms: totalMs,
      latency_ms: isFiniteNumber(parsed.latency_ms)
        ? parsed.latency_ms
        : totalMs,
    };
  } catch {
    return null;
  }
}

/**
 * Read all valid summary lines from `personalStateDir/jev-experiment.jsonl`,
 * handling v1, v2, and v3 lines in the same file while skipping blank or torn
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
