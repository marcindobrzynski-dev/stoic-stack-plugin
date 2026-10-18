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
// When all categories succeed, Stage 3 computes the per-category probabilities
// via `probabilitiesByCategory` and returns a conservative negative verdict
// until Stage 4 wires the weighted combination formula.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §Classifier verdict (LLM #1).
//
// Experiment only (`feature/jev-classifier-experiment`, never merged).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { isNonEmptyString, isPlainObject } from "../../src/core/predicates.js";
import {
  CATEGORY_REGISTRY,
  probabilitiesByCategory,
  sectionFor,
} from "./categories/index.js";
import { CATEGORY_TIMEOUT_MS } from "./constants.js";
import { readApiKey } from "./env.js";
import { writeInputFile } from "./log.js";
import { buildStructuredState } from "./structured-state.js";

/** The `category` label for "no listed subcategory fits". */
export const NO_CATEGORY = "none";

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
 * @returns {Promise<{
 *   result: object,
 *   questions: object|null,
 *   response: object|null,
 *   probabilities: object|null,
 * }>} Category evaluation outcome.
 */
export async function askJev(state, model, projectDir, options = {}) {
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
      probabilities: null,
    };
  }

  const sdk = await resolveSdk(settings.sdk);
  if (sdk === null) {
    return {
      result: { status: "sdk_missing", error: "sdk_missing" },
      questions: null,
      response: null,
      probabilities: null,
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
      probabilities: null,
    };
  }

  const { client } = clientResolution;
  const questionsByCat = {};
  const hasModel = isNonEmptyString(model);

  const requests = registry.map((category) => {
    const section = sectionFor(category, state);
    if (section === null) {
      questionsByCat[category.name] = null;
      const missingError = new Error("Missing category section");
      missingError.name = "MissingSectionError";
      return Promise.reject(missingError);
    }

    let categoryQuestions;
    try {
      categoryQuestions = category.buildQuestions(sdk, section);
    } catch (error) {
      questionsByCat[category.name] = null;
      return Promise.reject(error);
    }

    questionsByCat[category.name] = categoryQuestions;
    const requestPayload = {
      state: JSON.stringify(section),
      questions: categoryQuestions,
      ...(hasModel ? { model } : {}),
    };

    try {
      return Promise.resolve(client.systemOne(requestPayload));
    } catch (error) {
      return Promise.reject(error);
    }
  });

  const settledResults = await Promise.allSettled(requests);
  const responsesByCat = {};
  const answersByCat = {};
  const rejectionErrors = {};

  for (let index = 0; index < registry.length; index += 1) {
    const category = registry[index];
    const settled = settledResults[index];
    if (settled.status === "fulfilled") {
      responsesByCat[category.name] = settled.value ?? null;
      answersByCat[category.name] = settled.value?.answers ?? null;
    } else {
      responsesByCat[category.name] = null;
      answersByCat[category.name] = null;
      rejectionErrors[category.name] = readErrorClass(settled.reason);
    }
  }

  const probabilities = probabilitiesByCategory(answersByCat, registry);
  const failures = [];

  for (const category of registry) {
    const rejectedClass = rejectionErrors[category.name];
    if (typeof rejectedClass === "string") {
      failures.push({ name: category.name, error: rejectedClass });
    } else if (probabilities[category.name] === null) {
      failures.push({ name: category.name, error: "unusable_answer" });
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
      questions: questionsByCat,
      response: responsesByCat,
      probabilities,
    };
  }

  if (failures.length > 0) {
    const failureSummary = formatCategoryFailures(failures);
    return {
      result: {
        status: "ok",
        value: {
          decision_found: false,
          subcategory: null,
          reason: `jev: category_failed (${failureSummary})`,
          confidence: 0,
        },
      },
      questions: questionsByCat,
      response: responsesByCat,
      probabilities,
    };
  }

  const formattedProbabilities = registry
    .map(
      (category) =>
        `${category.name}=${probabilities[category.name].toFixed(2)}`,
    )
    .join(" ");

  return {
    result: {
      status: "ok",
      value: {
        decision_found: false,
        subcategory: null,
        reason: `jev: stage_3_interim (combination in stage 4; ${formattedProbabilities})`,
        confidence: 0,
      },
    },
    questions: questionsByCat,
    response: responsesByCat,
    probabilities,
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

  const stateResult = buildStructuredState(stopInput, {
    projectDir,
    homeDir: settings.homeDir,
    previousSummary: settings.previousSummary,
    maxInputChars: settings.maxInputChars,
    runner: stateRunner,
    spawn: settings.spawn,
    registry,
  });

  let result = {
    status: stateResult.status,
    ...(isNonEmptyString(stateResult.reason)
      ? { reason: stateResult.reason, error: stateResult.reason }
      : {}),
  };
  let questions = null;
  let response = null;
  let probabilities = null;

  if (stateResult.status === "stoic_skill") {
    result = {
      status: "ok",
      value: { ...SKIPPED },
    };
  } else if (stateResult.status === "ok") {
    ({ result, questions, response, probabilities } = await askJev(
      stateResult.state,
      model,
      projectDir,
      {
        sdk: settings.sdk,
        client: settings.client,
        registry,
      },
    ));
  }

  const statePayload = isPlainObject(stateResult.state)
    ? stateResult.state
    : stateResult.value?.prompt;
  const stateWasBuilt =
    isPlainObject(statePayload) || typeof statePayload === "string";
  const inputFile = stateWasBuilt
    ? writeInputFile(projectDir, startedAt, {
        state: statePayload,
        questions,
        response,
        probabilities,
      })
    : null;

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
  const logStatus =
    stateResult.status === "stoic_skill" ? "stoic_skill" : result.status;

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
      model_version: firstModelVersion(response, registry),
      probabilities,
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
  await main();
}
