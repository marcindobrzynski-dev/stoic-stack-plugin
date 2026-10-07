// The Jev child: reads one classification request on stdin, asks Jev seven
// questions about the developer's last turns, and prints a classifier-shaped
// result on stdout. Four questions are live and feed the verdict; three are
// shadow questions, logged only.
//
// "Choice" throughout means a technical choice the assistant made on its own.
// `decision_found` is the engine contract: the verdict shape
// (`decision_found`, `subcategory`, `reason`, `confidence`) is frozen.
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
import { SDK_TIMEOUT_MS } from "./timing.js";

/** The `category` label for "no listed subcategory fits". */
export const NO_CATEGORY = "none";

/** The uncalibrated cut between a yes and a no. */
const YES_THRESHOLD = 0.5;

/** How every question points at the turn being classified. */
const ANCHOR = "the turn whose heading ends with `(current)`";

/** The verdict for a skipped turn: a result, not a failure. */
const SKIPPED = Object.freeze({
  decision_found: false,
  subcategory: null,
  reason: "jev: skipped stoic_skill",
  confidence: 0,
});

/**
 * The seven questions, in one request over the same `state`: four live
 * questions that `combine` reads, then three shadow questions that are
 * logged only.
 *
 * @param {{noul: Function, choice: Function}} sdk - The SDK's builders.
 * @param {string[]} labels - The allowed subcategories.
 * @returns {object} Questions keyed by name.
 */
function buildQuestions(sdk, labels) {
  const criteria = Object.fromEntries(labels.map((label) => [label, null]));
  criteria[NO_CATEGORY] = "No listed label fits the current turn.";

  return {
    // Live: `combine` reads these four.
    reflex_approval: sdk.noul(
      `Read only the \`### Developer\` section of ${ANCHOR} and the ` +
        "`### Assistant` section of the turn just before it. Is the " +
        "developer's message a bare go-ahead?",
      {
        true:
          "It only confirms, approves, picks a lettered or named option, or " +
          "says to continue, with no reason, constraint, question or new " +
          "requirement of its own.",
        false:
          "It gives a reason, a constraint, a trade-off, a question, a " +
          "correction, or asks for something the assistant had not proposed.",
      },
    ),
    assistant_choice: sdk.noul(
      `Read the \`### Developer\` and \`### Assistant\` sections of ${ANCHOR}. ` +
        "Does the assistant report a technical choice it made on its own, " +
        "beyond what the developer asked for in this turn?",
      {
        true:
          "It interpreted an unclear request its own way, deviated from the " +
          "brief or plan, picked a default value, file, library or approach, " +
          "added or changed a dependency, changed a schema or migration, or " +
          "edited something the developer had not asked about.",
        false:
          "It only carried out what was asked, reported checks or results, " +
          "explained, said it found nothing to deviate from, or asked the " +
          "developer to decide.",
      },
    ),
    developer_named_it: sdk.noul(
      `Suppose the \`### Assistant\` section of ${ANCHOR} reports a ` +
        "technical choice. Did any `### Developer` section in this state ask " +
        "for that same choice or pick it from options the assistant had " +
        "offered?",
      {
        true:
          "The developer's words name or select that choice; a letter " +
          "answering offered options counts.",
        false:
          "The developer never mentioned that choice, or only said to go " +
          "ahead in general.",
      },
    ),
    category: sdk.choice(
      "Which label best names the technical choice reported in the " +
        `\`### Assistant\` section of ${ANCHOR} or visible in its ` +
        "`### Changes` section?",
      criteria,
    ),

    // Shadow (logged only): `combine` never reads these.
    significant_choice: sdk.noul(
      "Did the AI implement a significant engineering choice in the latest turn?",
    ),
    visible_reflection: sdk.noul(
      "Did the developer visibly reach this choice, even with the AI's help, by " +
        "comparing options or giving reasons or constraints? A bare " +
        '"yes, do it" does not count.',
    ),
    bare_pick_streak: sdk.noul(
      "Read every `### Developer` section in this state. Does the developer " +
        "answer with bare picks or go-aheads in every one of them?",
      {
        true:
          "Each developer message only picks options, confirms, or says to " +
          "continue, with no reason, question, constraint or correction in " +
          "any of them.",
        false:
          "At least one developer message gives a reason, asks a question, " +
          "sets a constraint, corrects the assistant, or states a " +
          "requirement of its own.",
      },
    ),
  };
}

/**
 * Combine Jev's live answers into a classifier verdict, or null when they are
 * unusable. A decision is found on a turn with changes when the developer
 * gave a bare go-ahead (reflex approval) or the assistant made a choice the
 * developer never named (unowned choice). Shadow answers are never read, so
 * they cannot make a verdict unusable.
 *
 * @param {unknown} answers - `response.answers` from `systemOne`.
 * @param {string[]} labels - The allowed subcategories.
 * @param {unknown} currentHasChanges - Whether the current turn changed
 *   files; anything but `true` reads as no changes, so no decision.
 * @returns {{decision_found: boolean, subcategory: string|null,
 *   reason: string, confidence: number}|null} The verdict, or null when a
 *   live answer is missing, outside [0, 1], or names no allowed label.
 */
export function combine(answers, labels, currentHasChanges) {
  if (!isPlainObject(answers)) {
    return null;
  }

  const readProbability = (questionName) => {
    const value = answers[questionName]?.noul;
    return isFiniteNumber(value) && value >= 0 && value <= 1 ? value : null;
  };

  const reflexApproval = readProbability("reflex_approval");
  const assistantChoice = readProbability("assistant_choice");
  const developerNamedIt = readProbability("developer_named_it");

  const { choice: categoryLabel, confidence: categoryConfidence } =
    answers.category ?? {};

  if (
    reflexApproval === null ||
    assistantChoice === null ||
    developerNamedIt === null ||
    !(labels.includes(categoryLabel) || categoryLabel === NO_CATEGORY) ||
    !isFiniteNumber(categoryConfidence)
  ) {
    return null;
  }

  const changes = currentHasChanges === true;
  // An assistant choice counts only to the degree the developer did not name it.
  const unownedChoice = assistantChoice * (1 - developerNamedIt);
  const formatProbability = (value) => value.toFixed(2);

  return {
    decision_found:
      changes &&
      (reflexApproval >= YES_THRESHOLD || unownedChoice >= YES_THRESHOLD),
    subcategory: categoryLabel === NO_CATEGORY ? null : categoryLabel,
    reason:
      `jev: reflexApproval=${formatProbability(reflexApproval)}` +
      ` unownedChoice=${formatProbability(unownedChoice)}` +
      ` assistantChoice=${formatProbability(assistantChoice)}` +
      ` developerNamedIt=${formatProbability(developerNamedIt)}` +
      ` category=${formatProbability(categoryConfidence)}` +
      ` changes=${changes ? "yes" : "no"}`,
    confidence: changes ? Math.max(reflexApproval, unownedChoice) : 0,
  };
}

/**
 * Jev's raw answers for the summary log, whether or not they combine into a
 * verdict, so an unusable answer still shows what came back. The three live
 * `noul` answers and the category; the shadow answers live only in
 * `jev-experiment/<ts>.json` under `response.answers`.
 *
 * @param {unknown} answers - `response.answers` from `systemOne`.
 * @returns {object} The live answers; null where absent.
 */
function summarizeAnswers(answers) {
  const { reflex_approval, assistant_choice, developer_named_it, category } =
    isPlainObject(answers) ? answers : {};
  const readNumber = (value) => (isFiniteNumber(value) ? value : null);

  return {
    reflex_approval: readNumber(reflex_approval?.noul),
    assistant_choice: readNumber(assistant_choice?.noul),
    developer_named_it: readNumber(developer_named_it?.noul),
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
 * @param {unknown} currentHasChanges - Whether the current turn changed
 *   files, passed to `combine`; anything but `true` means no decision.
 * @returns {Promise<{result: object, questions: object|null,
 *   response: object|null}>} The result, with what was sent and received.
 */
async function askJev(state, model, projectDir, currentHasChanges) {
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

    const value = combine(response?.answers, labels, currentHasChanges);
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
      built.currentHasChanges,
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
