// The Jev child: reads one classification request on stdin, builds the v3
// structured session state once through Sonnet, asks Jev per registry category
// in parallel over each category's isolated state section, and prints a
// classifier-shaped result on stdout.
//
// `runner.js` spawns this file and trusts only `{ status: "ok", value }` with
// exit 0; every infrastructure failure (`no_turns`, `state_too_large`,
// `state_unavailable`, `state_invalid`, `no_key`, `sdk_missing`, or all
// categories failing) prints its status, exits non-zero, and lets the runner
// fall back without waiting for the runner kill.
//
// When one or some (but not all) categories fail or return unusable answers,
// the child returns a negative verdict (`status: "ok"`, `decision_found: false`)
// whose `reason` names the failed categories and their error classes only.
// When all categories succeed, the per-category probabilities are combined into
// `pause_probability`:
// `decision_weight * decision_ownership
//  * (1 - REFLECTION_MAX_REDUCTION * developer_reflection)
//  * (1 - INTENT_MAX_REDUCTION * developer_intent)`.
// `developer_intent` only lowers that probability. `decision_found` is
// `pause_probability > 0` (temporary); `confidence` scales
// `pause_probability` against `PAUSE_THRESHOLDS[effectivePreset]`.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §Classifier verdict (LLM #1).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  clampFinite,
  isFiniteNumber,
  isNonEmptyString,
  isPlainObject,
} from "../../src/core/predicates.js";
import {
  configuredConfidenceFloor,
  effectivePreset,
  loadConfig,
  resolveCategory,
} from "../../src/io/config/config.js";
import { loadState } from "../../src/io/state.js";
import { name as decisionOwnershipName } from "./categories/decision-ownership.js";
import { name as decisionWeightName } from "./categories/decision-weight.js";
import { name as developerIntentName } from "./categories/developer-intent.js";
import { name as developerReflectionName } from "./categories/developer-reflection.js";
import {
  CATEGORY_REGISTRY,
  probabilitiesByCategory,
  sectionFor,
} from "./categories/index.js";
import {
  INTENT_MAX_REDUCTION,
  JEV_GENERAL_CATEGORY,
  PAUSE_THRESHOLDS,
  REFLECTION_MAX_REDUCTION,
  STATE_MODEL,
} from "./constants.js";
import { CATEGORY_TIMEOUT_MS } from "./timing.js";
import { readApiKey } from "./env.js";
import { buildCategoriesLog, writeInputFile } from "./log.js";
import { buildStructuredState } from "./structured-state.js";

/** Decimal rounding scale to eliminate binary IEEE-754 representation drift. */
const FLOAT_ROUND_SCALE = 1e12;

/** The verdict for a skipped turn: a result, not a failure. */
const SKIPPED = Object.freeze({
  decision_found: false,
  subcategory: null,
  reason: "jev: skipped stoic_skill",
  confidence: 0,
});

/**
 * Extract only the error class name from a rejection value so an API error's
 * message or response body never leaks into a verdict reason or log line.
 *
 * @param {unknown} error - Rejection reason.
 * @returns {string} Error class identifier.
 */
function readErrorClass(error) {
  if (typeof error !== "object" || error === null) {
    return "Error";
  }
  if (isNonEmptyString(error.name)) {
    return error.name;
  }
  const constructorName = error.constructor?.name;
  if (isNonEmptyString(constructorName) && constructorName !== "Object") {
    return constructorName;
  }
  return "Error";
}

/**
 * Resolve the TypeSafe SDK module from an optional parameter seam, defaulting
 * to the production `@typesafe-ai/sdk` dynamic import.
 *
 * @param {unknown} sdkSeam - Optional SDK object or loader function.
 * @returns {Promise<object|null>} Resolved SDK module, or null when missing.
 */
async function resolveSdk(sdkSeam) {
  try {
    let sdk;
    if (typeof sdkSeam === "function") {
      sdk = await sdkSeam();
    } else if (isPlainObject(sdkSeam)) {
      sdk = sdkSeam;
    } else {
      sdk = await import("@typesafe-ai/sdk");
    }
    if (!isPlainObject(sdk) || typeof sdk.noul !== "function") {
      return null;
    }
    return sdk;
  } catch {
    return null;
  }
}

/**
 * Resolve or construct the TypeSafe client from an optional parameter seam.
 *
 * @param {object} sdk - Resolved TypeSafe SDK module.
 * @param {string} apiKey - TypeSafe API key.
 * @param {unknown} clientSeam - Optional pre-built client `{ systemOne }`.
 * @returns {{ ok: true, client: { systemOne: Function } }
 *   | { ok: false, status: "sdk_missing" | "api_error", error: string }}
 *   Client resolution result.
 */
function resolveClient(sdk, apiKey, clientSeam) {
  if (isPlainObject(clientSeam) && typeof clientSeam.systemOne === "function") {
    return { ok: true, client: clientSeam };
  }
  if (typeof sdk.TypeSafeClient !== "function") {
    return { ok: false, status: "sdk_missing", error: "sdk_missing" };
  }
  try {
    const client = new sdk.TypeSafeClient({
      apiKey,
      logLevel: "off",
      timeout: CATEGORY_TIMEOUT_MS,
      retry: { maxRetries: 0 },
    });
    return { ok: true, client };
  } catch (error) {
    return {
      ok: false,
      status: "api_error",
      error: readErrorClass(error),
    };
  }
}

/**
 * Format `{ name, error }` entries into a single comma-separated summary.
 *
 * @param {{ name: string, error: string }[]} failures - Category failures.
 * @returns {string} Formatted `category:ErrorClass` list.
 */
function formatCategoryFailures(failures) {
  return failures.map((item) => `${item.name}:${item.error}`).join(", ");
}

/**
 * Read the first non-empty model identifier reported across category responses.
 *
 * @param {unknown} responsesByCategory - Map of `{ [category.name]: response }`.
 * @param {readonly object[]} registry - Active category registry.
 * @returns {string|null} Reported model identifier, or null when absent.
 */
function firstModelVersion(responsesByCategory, registry) {
  if (!isPlainObject(responsesByCategory)) {
    return null;
  }
  for (const category of registry) {
    const reported = responsesByCategory[category.name]?.model;
    if (isNonEmptyString(reported)) {
      return reported;
    }
  }
  return null;
}

/**
 * Round a floating-point number to 12 decimal places so an exact ratio of the
 * configured confidence floor to itself never suffers binary IEEE-754 drift
 * below that floor.
 *
 * @param {number} value - Raw floating-point number.
 * @returns {number} Rounded number.
 */
function roundProbability(value) {
  return Math.round(value * FLOAT_ROUND_SCALE) / FLOAT_ROUND_SCALE;
}

/**
 * Read one category probability in [0, 1] from a probabilities map, defaulting
 * missing or non-numeric entries to 0.
 *
 * @param {unknown} probabilities - Map of `{ [category.name]: number }`.
 * @param {string} categoryName - Registry category identifier.
 * @returns {number} Clamped probability in [0, 1].
 */
function readCategoryProbability(probabilities, categoryName) {
  if (!isPlainObject(probabilities)) {
    return 0;
  }
  const candidate = probabilities[categoryName];
  return isFiniteNumber(candidate) ? clampFinite(candidate, 0, 1) : 0;
}

/**
 * Combine per-category probabilities into `pause_probability`.
 *
 * Formula:
 *   `pause_probability = decision_weight * decision_ownership
 *     * (1 - REFLECTION_MAX_REDUCTION * developer_reflection)
 *     * (1 - INTENT_MAX_REDUCTION * developer_intent)`
 *
 * `developer_reflection` and `developer_intent` are separate reduction
 * multipliers. Either one can only lower the probability. Intent never
 * raises it, including when intent is higher than reflection.
 *
 * @param {unknown} probabilities - Map of `{ [category.name]: number }`.
 * @returns {{
 *   pauseProbability: number,
 *   decisionWeight: number,
 *   decisionOwnership: number,
 *   developerReflection: number,
 *   developerIntent: number,
 *   developerReflectionReductionMultiplier: number,
 *   developerIntentReductionMultiplier: number,
 * }} Combined probabilities and the two reduction multipliers.
 */
export function combineProbabilities(probabilities) {
  const decisionWeight = readCategoryProbability(
    probabilities,
    decisionWeightName,
  );
  const decisionOwnership = readCategoryProbability(
    probabilities,
    decisionOwnershipName,
  );
  const developerReflection = readCategoryProbability(
    probabilities,
    developerReflectionName,
  );
  const developerIntent = readCategoryProbability(
    probabilities,
    developerIntentName,
  );
  const developerReflectionReductionMultiplier = clampFinite(
    1 - REFLECTION_MAX_REDUCTION * developerReflection,
    0,
    1,
  );
  const developerIntentReductionMultiplier = clampFinite(
    1 - INTENT_MAX_REDUCTION * developerIntent,
    0,
    1,
  );
  const rawPauseProbability =
    decisionWeight *
    decisionOwnership *
    developerReflectionReductionMultiplier *
    developerIntentReductionMultiplier;
  const pauseProbability = clampFinite(
    roundProbability(rawPauseProbability),
    0,
    1,
  );

  return {
    pauseProbability,
    decisionWeight,
    decisionOwnership,
    developerReflection,
    developerIntent,
    developerReflectionReductionMultiplier,
    developerIntentReductionMultiplier,
  };
}

/**
 * Select the category name that drove the combined verdict.
 *
 * Rule:
 * - When `pauseProbability >= presetPauseThreshold` (pause), pick the
 *   dominant positive factor (`decision_weight` vs `decision_ownership`,
 *   ties to `decision_weight`).
 * - When `pauseProbability < presetPauseThreshold` (negative verdict), pick
 *   the limiting factor with the smallest multiplicative contribution among
 *   `decision_weight`, `decision_ownership`,
 *   `developer_reflection_reduction_multiplier`, and
 *   `developer_intent_reduction_multiplier`.
 *
 * @param {ReturnType<typeof combineProbabilities>} combination - Combined
 *   category factors.
 * @param {number} presetPauseThreshold - Active preset's pause threshold.
 * @returns {string} Driving category name.
 */
export function selectDrivingCategory(combination, presetPauseThreshold) {
  const {
    pauseProbability,
    decisionWeight,
    decisionOwnership,
    developerReflectionReductionMultiplier,
    developerIntentReductionMultiplier,
  } = combination;

  if (pauseProbability >= presetPauseThreshold) {
    return decisionWeight >= decisionOwnership
      ? decisionWeightName
      : decisionOwnershipName;
  }

  let limitingCategory = decisionWeightName;
  let smallestFactor = decisionWeight;

  if (decisionOwnership < smallestFactor) {
    limitingCategory = decisionOwnershipName;
    smallestFactor = decisionOwnership;
  }
  if (developerReflectionReductionMultiplier < smallestFactor) {
    limitingCategory = developerReflectionName;
    smallestFactor = developerReflectionReductionMultiplier;
  }
  if (developerIntentReductionMultiplier < smallestFactor) {
    limitingCategory = developerIntentName;
  }

  return limitingCategory;
}

/**
 * Resolve Sonnet's `area_label` against the project's enabled areas and
 * subcategories, falling back to `"general"` when `area_label` is `"none"`
 * or outside the enabled taxonomy.
 *
 * @param {unknown} areaLabel - `state.area_label` from structured state.
 * @param {object} [config] - Project configuration.
 * @returns {string} Resolved subcategory or `"general"`.
 */
export function resolveVerdictSubcategory(areaLabel, config) {
  const resolution = resolveCategory(areaLabel, config);
  if (resolution !== null) {
    return areaLabel;
  }
  return JEV_GENERAL_CATEGORY;
}

/**
 * Adapt per-category probabilities and `area_label` into the frozen
 * `{ decision_found, subcategory, reason, confidence }` classifier verdict.
 *
 * @param {unknown} probabilities - Map of `{ [category.name]: number }`.
 * @param {unknown} areaLabel - `state.area_label` from structured state.
 * @param {object} [config] - Project configuration.
 * @param {object} [personalState] - Personal engine state (`state.json`).
 * @returns {{
 *   decision_found: boolean,
 *   subcategory: string,
 *   reason: string,
 *   confidence: number,
 * }} Classifier verdict.
 *
 * `confidence` is
 * `min(1, configuredConfidenceFloor * pause_probability / PAUSE_THRESHOLDS[preset])`.
 * The floor is the active preset's `classifier_confidence_threshold` when
 * that preset defines one, otherwise the project
 * `classifier_confidence_threshold` (default `0.6`). At the preset's pause
 * threshold the confidence equals that floor, so the `low_confidence` veto
 * stays aligned with the pause threshold. `presets` defaults to the shipped
 * table; a caller passes a copy only to define a floor the shipped presets
 * do not carry.
 *
 * @param {object} [presets] - Preset table for `configuredConfidenceFloor`.
 * @param {number} [presetPauseThreshold] - Already resolved pause threshold.
 *   When omitted, the threshold is `PAUSE_THRESHOLDS` for the effective preset.
 */
export function buildVerdict(
  probabilities,
  areaLabel,
  config,
  personalState,
  presets,
  presetPauseThreshold,
) {
  const preset = effectivePreset(config, personalState);
  const resolvedPauseThreshold = isFiniteNumber(presetPauseThreshold)
    ? presetPauseThreshold
    : PAUSE_THRESHOLDS[preset];
  const combination = combineProbabilities(probabilities);
  const { pauseProbability } = combination;
  const configuredFloor = configuredConfidenceFloor(
    config,
    personalState,
    presets,
  );
  const rawConfidence =
    (configuredFloor * pauseProbability) / resolvedPauseThreshold;
  const confidence = clampFinite(roundProbability(rawConfidence), 0, 1);
  // TODO: `decision_found = pause_probability > 0` is temporary.
  // Calibrate it or remove it later.
  const decisionFound = pauseProbability > 0;
  const subcategory = resolveVerdictSubcategory(areaLabel, config);
  const drivingCategory = selectDrivingCategory(
    combination,
    resolvedPauseThreshold,
  );
  const role =
    pauseProbability >= resolvedPauseThreshold ? "dominant" : "limiting";

  return {
    decision_found: decisionFound,
    subcategory,
    reason: `jev: ${role}=${drivingCategory} (p=${pauseProbability.toFixed(2)} threshold=${resolvedPauseThreshold.toFixed(2)})`,
    confidence,
  };
}

/**
 * Ask Jev in parallel across every category in the registry, passing each
 * category only its own isolated section from the validated structured state.
 * Never throws; failures are returned as structured statuses or negative
 * verdicts.
 *
 * @param {object} state - Validated v3 structured session state.
 * @param {unknown} model - The `jev…` model id.
 * @param {string} projectDir - Project root directory.
 * @param {object} [options] - Optional parameter seams for tests.
 * @param {object|Function} [options.sdk] - Injectable SDK module or loader.
 * @param {{ systemOne: Function }} [options.client] - Injectable SDK client.
 * @param {readonly object[]} [options.registry] - Category registry override.
 * @param {number} [options.presetPauseThreshold] - Pause threshold already
 *   resolved by the caller from `PAUSE_THRESHOLDS`. When omitted,
 *   `buildVerdict` reads that table for the effective preset.
 * @returns {Promise<{
 *   result: object,
 *   questions: object|null,
 *   response: object|null,
 *   answersByCategory: object|null,
 *   probabilities: object|null,
 *   categoryLatencyMs: object|null,
 *   categoryErrors: object|null,
 *   jevMs: number,
 * }>} Category evaluation outcome.
 */
export async function askJev(state, model, projectDir, options = {}) {
  const jevStartedAt = Date.now();
  const settings = isPlainObject(options) ? options : {};
  const registry = Array.isArray(settings.registry)
    ? settings.registry
    : CATEGORY_REGISTRY;
  const apiKey = readApiKey(projectDir);

  if (apiKey === null) {
    return {
      result: { status: "no_key", error: "no_key" },
      questions: null,
      response: null,
      answersByCategory: null,
      probabilities: null,
      categoryLatencyMs: null,
      categoryErrors: null,
      jevMs: Date.now() - jevStartedAt,
    };
  }

  const sdk = await resolveSdk(settings.sdk);
  if (sdk === null) {
    return {
      result: { status: "sdk_missing", error: "sdk_missing" },
      questions: null,
      response: null,
      answersByCategory: null,
      probabilities: null,
      categoryLatencyMs: null,
      categoryErrors: null,
      jevMs: Date.now() - jevStartedAt,
    };
  }

  const clientResolution = resolveClient(sdk, apiKey, settings.client);
  if (!clientResolution.ok) {
    return {
      result: {
        status: clientResolution.status,
        error: clientResolution.error,
      },
      questions: null,
      response: null,
      answersByCategory: null,
      probabilities: null,
      categoryLatencyMs: null,
      categoryErrors: null,
      jevMs: Date.now() - jevStartedAt,
    };
  }

  const { client } = clientResolution;
  const questionsByCategory = {};
  const categoryLatencyMs = {};
  const hasModel = isNonEmptyString(model);

  const requests = registry.map((category) => {
    const categoryStartedAt = Date.now();
    const recordElapsed = () => {
      categoryLatencyMs[category.name] = Date.now() - categoryStartedAt;
    };

    const section = sectionFor(category, state);
    if (section === null) {
      questionsByCategory[category.name] = null;
      recordElapsed();
      const missingError = new Error("Missing category section");
      missingError.name = "MissingSectionError";
      return Promise.reject(missingError);
    }

    let categoryQuestions;
    try {
      categoryQuestions = category.buildQuestions(sdk, section);
    } catch (error) {
      questionsByCategory[category.name] = null;
      recordElapsed();
      return Promise.reject(error);
    }

    questionsByCategory[category.name] = categoryQuestions;
    const requestPayload = {
      state: JSON.stringify(section),
      questions: categoryQuestions,
      ...(hasModel ? { model } : {}),
    };

    try {
      return Promise.resolve(client.systemOne(requestPayload)).finally(
        recordElapsed,
      );
    } catch (error) {
      recordElapsed();
      return Promise.reject(error);
    }
  });

  const settledResults = await Promise.allSettled(requests);
  const jevMs = Date.now() - jevStartedAt;
  const responsesByCategory = {};
  const answersByCategory = {};
  const rejectionErrors = {};

  for (let index = 0; index < registry.length; index += 1) {
    const category = registry[index];
    const settled = settledResults[index];
    if (settled.status === "fulfilled") {
      responsesByCategory[category.name] = settled.value ?? null;
      answersByCategory[category.name] = settled.value?.answers ?? null;
    } else {
      responsesByCategory[category.name] = null;
      answersByCategory[category.name] = null;
      rejectionErrors[category.name] = readErrorClass(settled.reason);
    }
  }

  const probabilities = probabilitiesByCategory(answersByCategory, registry);
  const categoryErrors = {};
  const failures = [];

  for (const category of registry) {
    const rejectedClass = rejectionErrors[category.name];
    if (typeof rejectedClass === "string") {
      categoryErrors[category.name] = rejectedClass;
      failures.push({ name: category.name, error: rejectedClass });
    } else if (probabilities[category.name] === null) {
      categoryErrors[category.name] = "unusable_answer";
      failures.push({ name: category.name, error: "unusable_answer" });
    } else {
      categoryErrors[category.name] = null;
    }
  }

  if (failures.length === registry.length) {
    const hasRejection = Object.keys(rejectionErrors).length > 0;
    const failureStatus = hasRejection ? "api_error" : "unusable_answer";
    const failureSummary = formatCategoryFailures(failures);
    return {
      result: {
        status: failureStatus,
        error: failureSummary,
        reason: failureSummary,
      },
      questions: questionsByCategory,
      response: responsesByCategory,
      answersByCategory,
      probabilities,
      categoryLatencyMs,
      categoryErrors,
      jevMs,
    };
  }

  if (failures.length > 0) {
    const failureSummary = formatCategoryFailures(failures);
    return {
      result: {
        status: "ok",
        error: failureSummary,
        value: {
          decision_found: false,
          subcategory: null,
          reason: `jev: category_failed (${failureSummary})`,
          confidence: 0,
        },
      },
      questions: questionsByCategory,
      response: responsesByCategory,
      answersByCategory,
      probabilities,
      categoryLatencyMs,
      categoryErrors,
      jevMs,
    };
  }

  const config = isPlainObject(settings.config)
    ? settings.config
    : loadConfig(projectDir);
  const personalState = isPlainObject(settings.personalState)
    ? settings.personalState
    : loadState(projectDir, settings.homeDir);
  const verdict = buildVerdict(
    probabilities,
    state?.area_label,
    config,
    personalState,
    undefined,
    settings.presetPauseThreshold,
  );

  return {
    result: {
      status: "ok",
      value: verdict,
    },
    questions: questionsByCategory,
    response: responsesByCategory,
    answersByCategory,
    probabilities,
    categoryLatencyMs,
    categoryErrors,
    jevMs,
  };
}

/**
 * Classify one request through Sonnet structured state and parallel per-category
 * Jev calls. Never throws; any infrastructure failure returns a non-`ok` status
 * so `runner.js` falls back immediately.
 *
 * @param {unknown} input - `{ prompt, model, group, context }` from the runner.
 * @param {object} [options] - Optional parameter seams for tests.
 * @param {Function} [options.stateRunner] - Headless runner seam for Sonnet.
 * @param {Function} [options.runner] - Alias for `options.stateRunner`.
 * @param {Function} [options.spawn] - Spawn seam forwarded to Sonnet runner.
 * @param {string} [options.homeDir] - Home directory override for summaries.
 * @param {object} [options.previousSummary] - Explicit prior summary override.
 * @param {number} [options.maxInputChars] - Maximum prompt length in chars.
 * @param {object|Function} [options.sdk] - Injectable TypeSafe SDK or loader.
 * @param {{ systemOne: Function }} [options.client] - Injectable SDK client.
 * @param {readonly object[]} [options.registry] - Category registry override.
 * @returns {Promise<{
 *   status: string,
 *   value?: object,
 *   reason?: string|null,
 *   error?: string|null,
 *   probabilities: object|null,
 *   currentHasChanges: boolean|null,
 *   promptId: string|null,
 *   stateChars: number|null,
 *   turnsIncluded: number|null,
 *   log: object,
 * }>} Classification child outcome.
 */
export async function classifyTurn(input, options = {}) {
  const startedAt = new Date();
  const settings = isPlainObject(options) ? options : {};
  const { model, context } = isPlainObject(input) ? input : {};
  const { stopInput, projectDir } = isPlainObject(context) ? context : {};
  const registry = Array.isArray(settings.registry)
    ? settings.registry
    : CATEGORY_REGISTRY;

  const stateRunner =
    typeof settings.stateRunner === "function"
      ? settings.stateRunner
      : settings.runner;

  const sonnetStartedAt = Date.now();
  const stateResult = buildStructuredState(stopInput, {
    projectDir,
    homeDir: settings.homeDir,
    previousSummary: settings.previousSummary,
    maxInputChars: settings.maxInputChars,
    runner: stateRunner,
    spawn: settings.spawn,
    registry,
  });
  const sonnetMs = Date.now() - sonnetStartedAt;
  const config = isPlainObject(settings.config)
    ? settings.config
    : loadConfig(projectDir);
  const personalState = isPlainObject(settings.personalState)
    ? settings.personalState
    : loadState(projectDir, settings.homeDir);
  const presetPauseThreshold =
    PAUSE_THRESHOLDS[effectivePreset(config, personalState)];

  let result = {
    status: stateResult.status,
    ...(isNonEmptyString(stateResult.reason)
      ? { reason: stateResult.reason, error: stateResult.reason }
      : {}),
  };
  let questions = null;
  let response = null;
  let answersByCategory = null;
  let probabilities = null;
  let categoryLatencyMs = null;
  let categoryErrors = null;
  let jevMs = null;

  if (stateResult.status === "stoic_skill") {
    result = {
      status: "ok",
      value: { ...SKIPPED },
    };
  } else if (stateResult.status === "ok") {
    ({
      result,
      questions,
      response,
      answersByCategory,
      probabilities,
      categoryLatencyMs,
      categoryErrors,
      jevMs,
    } = await askJev(stateResult.state, model, projectDir, {
      sdk: settings.sdk,
      client: settings.client,
      registry,
      homeDir: settings.homeDir,
      config,
      personalState,
      presetPauseThreshold,
    }));
  }

  const promptId = stateResult.promptId ?? null;
  const currentHasChanges =
    typeof stateResult.currentHasChanges === "boolean"
      ? stateResult.currentHasChanges
      : null;
  const stateChars =
    typeof stateResult.stateChars === "number" ? stateResult.stateChars : null;
  const turnsIncluded =
    typeof stateResult.turnsIncluded === "number"
      ? stateResult.turnsIncluded
      : null;
  const previousSummary = isPlainObject(stateResult.previousSummary)
    ? stateResult.previousSummary
    : null;

  const sonnetInputSummary = {
    state_model: STATE_MODEL,
    prompt_id: promptId,
    turns_included: turnsIncluded,
    state_chars: stateChars,
    current_has_changes: currentHasChanges,
    sonnet_ms: sonnetMs,
    previous_summary: previousSummary,
  };

  const categoriesLog = buildCategoriesLog({
    registry,
    state: stateResult.state,
    questionsByCategory: questions,
    answersByCategory,
    probabilities,
    categoryLatencyMs,
    categoryErrors,
    presetPauseThreshold,
    includeFullQuestions: true,
  });

  const inputFile = isPlainObject(stateResult.state)
    ? writeInputFile(
        projectDir,
        startedAt,
        {
          sonnet_input_summary: sonnetInputSummary,
          state: stateResult.state,
          categories: categoriesLog,
          questions,
          response,
          probabilities,
        },
        { homeDir: settings.homeDir },
      )
    : null;

  const hasPartialCategoryFailure =
    result.status === "ok" &&
    isPlainObject(categoryErrors) &&
    Object.values(categoryErrors).some((entry) => isNonEmptyString(entry));
  let logStatus = result.status;
  if (stateResult.status === "stoic_skill") {
    logStatus = "stoic_skill";
  } else if (hasPartialCategoryFailure) {
    logStatus = "category_failed";
  }

  return {
    ...result,
    probabilities,
    currentHasChanges,
    promptId,
    stateChars,
    turnsIncluded,
    log: {
      status: logStatus,
      error: result.error ?? null,
      prompt_id: promptId,
      state_model: STATE_MODEL,
      jev_model: isNonEmptyString(model) ? model : null,
      model_version: firstModelVersion(response, registry),
      probabilities,
      answers_by_category: answersByCategory,
      category_latency_ms: categoryLatencyMs,
      category_errors: categoryErrors,
      sonnet_ms: sonnetMs,
      jev_ms: jevMs,
      current_has_changes: currentHasChanges,
      state_chars: stateChars,
      turns_included: turnsIncluded,
      input_file: inputFile,
    },
  };
}

/** Read stdin, classify, print one JSON line, exit non-zero unless `ok`. */
async function main() {
  let input;

  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    input = null;
  }

  const result = await classifyTurn(input);

  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.status === "ok" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
