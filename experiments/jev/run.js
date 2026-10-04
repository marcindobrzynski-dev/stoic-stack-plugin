// The Jev child: reads one classification request on stdin, asks Jev four
// questions about the developer's last turns, and prints a classifier-shaped
// result on stdout.
//
// `runner.js` spawns this file and trusts only `{ status: "ok", value }` with
// exit 0; every failure prints its status, exits non-zero, and lets the runner
// fall back to Haiku. A turn that invokes a Stoic Stack skill is not a failure:
// it is skipped with a negative verdict, so no pause lands on a reflection.
//
// Jev answers probabilities; the verdict is combined here, in code, so the
// thresholds stay visible and the raw answers stay loggable. The full input
// file is written here; the summary line is completed by the runner, which
// alone knows whether the fallback ran.
//
// Experiment only (`feature/jev-classifier-experiment`, never merged).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  allowedSubcategories,
  loadConfig,
} from "../../src/io/config/config.js";
import { isFiniteNumber, isPlainObject } from "../../src/core/predicates.js";
import { readApiKey } from "./env.js";
import { writeInputFile } from "./log.js";
import { buildState } from "./state.js";

/**
 * One attempt, no retries: the runner kills this child at 15 s, and a killed
 * child cannot report what went wrong.
 */
export const SDK_TIMEOUT_MS = 12_000;

/** The `category` label for "no listed subcategory fits". */
export const NO_CATEGORY = "none";

/** The uncalibrated cut between a yes and a no. */
const YES_THRESHOLD = 0.5;

/** The verdict for a skipped turn: a result, not a failure. */
const SKIPPED = Object.freeze({
  decision_found: false,
  subcategory: null,
  reason: "jev: skipped stoic_skill",
  confidence: 0,
});

/**
 * The four questions, in one request over the same `state`.
 *
 * @param {{noul: Function, choice: Function}} sdk - The SDK's builders.
 * @param {string[]} labels - The allowed subcategories.
 * @returns {object} Questions keyed by name.
 */
function buildQuestions(sdk, labels) {
  const criteria = Object.fromEntries(labels.map((label) => [label, null]));
  criteria[NO_CATEGORY] = "No listed label fits the latest turn.";

  return {
    significant_choice: sdk.noul(
      "Did the AI implement a significant engineering choice in the latest turn?",
    ),
    visible_reflection: sdk.noul(
      "Did the developer visibly reach this choice, even with the AI's help, by " +
        "comparing options or giving reasons or constraints? A bare " +
        '"yes, do it" does not count.',
    ),
    context_sufficient: sdk.noul(
      "Is the context enough to judge? A reference to an agreed plan that is " +
        "absent from the state means no.",
    ),
    category: sdk.choice(
      "Which label best names the engineering choice in the latest turn?",
      criteria,
    ),
  };
}

/**
 * Combine Jev's answers into a classifier verdict, or null when the answers
 * are unusable.
 *
 * @param {unknown} answers - `response.answers` from `systemOne`.
 * @param {string[]} labels - The allowed subcategories.
 * @returns {{decision_found: boolean, subcategory: string|null,
 *   reason: string, confidence: number}|null} The verdict, or null.
 */
export function combine(answers, labels) {
  if (!isPlainObject(answers)) {
    return null;
  }

  const readProbability = (questionName) => {
    const value = answers[questionName]?.noul;
    return isFiniteNumber(value) && value >= 0 && value <= 1 ? value : null;
  };

  const significantChoice = readProbability("significant_choice");
  const visibleReflection = readProbability("visible_reflection");
  const contextSufficient = readProbability("context_sufficient");

  const { choice: categoryLabel, confidence: categoryConfidence } =
    answers.category ?? {};

  if (
    significantChoice === null ||
    visibleReflection === null ||
    contextSufficient === null ||
    !(labels.includes(categoryLabel) || categoryLabel === NO_CATEGORY) ||
    !isFiniteNumber(categoryConfidence)
  ) {
    return null;
  }

  const formatProbability = (value) => value.toFixed(2);

  return {
    decision_found:
      significantChoice >= YES_THRESHOLD &&
      visibleReflection < YES_THRESHOLD &&
      contextSufficient >= YES_THRESHOLD,
    subcategory: categoryLabel === NO_CATEGORY ? null : categoryLabel,
    reason:
      `jev: significantChoice=${formatProbability(significantChoice)}` +
      ` visibleReflection=${formatProbability(visibleReflection)}` +
      ` contextSufficient=${formatProbability(contextSufficient)}` +
      ` category=${formatProbability(categoryConfidence)}`,
    confidence: Math.min(
      significantChoice,
      1 - visibleReflection,
      contextSufficient,
    ),
  };
}

/**
 * Jev's raw answers for the summary log, whether or not they combine into a
 * verdict, so an unusable answer still shows what came back.
 *
 * @param {unknown} answers - `response.answers` from `systemOne`.
 * @returns {object} The four answers; null where absent.
 */
function summarizeAnswers(answers) {
  const {
    significant_choice,
    visible_reflection,
    context_sufficient,
    category,
  } = isPlainObject(answers) ? answers : {};
  const readNumber = (value) => (isFiniteNumber(value) ? value : null);

  return {
    significant_choice: readNumber(significant_choice?.noul),
    visible_reflection: readNumber(visible_reflection?.noul),
    context_sufficient: readNumber(context_sufficient?.noul),
    category: typeof category?.choice === "string" ? category.choice : null,
    category_probability: readNumber(category?.confidence),
  };
}

/**
 * Ask Jev about a built state. Never throws; a failure is a status.
 *
 * @param {string} state - The rendered state.
 * @param {unknown} model - The `jev…` model id.
 * @param {string} projectDir - The project directory.
 * @returns {Promise<{result: object, questions: object|null,
 *   response: object|null}>} The result, with what was sent and received.
 */
async function askJev(state, model, projectDir) {
  const apiKey = readApiKey(projectDir);

  if (apiKey === null) {
    return { result: { status: "no_key" }, questions: null, response: null };
  }

  let sdk;

  try {
    sdk = await import("@typesafe-ai/sdk");
  } catch {
    return {
      result: { status: "sdk_missing" },
      questions: null,
      response: null,
    };
  }

  const labels = allowedSubcategories(loadConfig(projectDir));
  const questions = buildQuestions(sdk, labels);
  let response = null;

  try {
    const client = new sdk.TypeSafeClient({
      apiKey,
      logLevel: "off",
      timeout: SDK_TIMEOUT_MS,
      retry: { maxRetries: 0 },
    });

    response = await client.systemOne({
      state,
      questions,
      ...(typeof model === "string" && model !== "" ? { model } : {}),
    });

    const value = combine(response?.answers, labels);
    const result = value
      ? { status: "ok", value }
      : { status: "unusable_answer" };

    return { result, questions, response };
  } catch (error) {
    // The class name only: an API error's message may quote the response.
    return {
      result: { status: "api_error", error: error?.name ?? "Error" },
      questions,
      response,
    };
  }
}

/**
 * Classify one request through Jev. Never throws; a failure is a status.
 * Every result carries `log`, the fields of the summary line only this child
 * knows; `runner.js` completes and writes the line. Whenever a state was
 * built, the full input lands in `jev-experiment/<ts>.json`.
 *
 * @param {unknown} input - `{ prompt, model, group, context }` from the runner.
 * @returns {Promise<{status: string, value?: object, error?: string,
 *   log: object}>} The result; only `ok` carries a value.
 */
export async function classifyTurn(input) {
  const startedAt = new Date();
  const { model, context } = isPlainObject(input) ? input : {};
  const { stopInput, projectDir } = isPlainObject(context) ? context : {};

  const stateResult = buildState(stopInput);
  const built = stateResult.value;

  let result = { status: stateResult.status };
  let questions = null;
  let response = null;

  if (stateResult.status === "stoic_skill") {
    result = {
      status: "ok",
      value: { ...SKIPPED },
    };
  } else if (stateResult.status === "ok") {
    ({ result, questions, response } = await askJev(
      built.state,
      model,
      projectDir,
    ));
  }

  const stateWasBuilt = typeof built?.state === "string";
  const inputFile = stateWasBuilt
    ? writeInputFile(projectDir, startedAt, {
        state: built.state,
        questions,
        response,
      })
    : null;

  return {
    ...result,
    log: {
      status:
        stateResult.status === "stoic_skill" ? "stoic_skill" : result.status,
      prompt_id: built?.promptId ?? null,
      model_version:
        typeof response?.model === "string" ? response.model : null,
      ...summarizeAnswers(response?.answers),
      state_chars: built?.stateChars ?? null,
      turns_included: built?.turnsIncluded ?? null,
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
