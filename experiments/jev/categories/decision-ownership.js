// Category module for `decision_ownership` — whether technical decisions in
// the turn were made by the assistant without the developer's awareness.
//
// Exists as its own category module so its declarative Jev questions and its
// answer-to-probability mapping stay isolated from the other categories and
// from the registry's generic orchestration.
//
// Pure and SDK-injectable: no I/O, no clock, no environment reads, and no
// import of `@typesafe-ai/sdk` at module load. `toProbability` never throws
// and returns `null` when any required answer is missing or out of [0, 1].
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §Classifier verdict (LLM #1).
import {
  clampFinite,
  isFiniteNumber,
  isPlainObject,
} from "../../../src/core/predicates.js";

/** Canonical snake_case category identifier. */
export const name = "decision_ownership";

/** Full human-readable name for logs and diagnostics. */
export const readableName = "Decision ownership";

/** Key of this category's section in the v3 structured state. */
export const stateSection = "decision_ownership";

/** Declarative Jev question definitions for `decision_ownership`. */
export const questions = Object.freeze({
  unaware_ai_decision: Object.freeze({
    type: "noul",
    instructions:
      "Did the assistant make any technical decision in this turn that the " +
      "developer did not consciously name or show awareness of?",
    criteria: Object.freeze({
      true:
        "At least one decision in the turn was made by the assistant without " +
        "the developer naming, selecting, or showing awareness of it.",
      false:
        "Every decision was made or explicitly named by the developer, or " +
        "no technical decision was made.",
    }),
  }),
  ai_beyond_request: Object.freeze({
    type: "noul",
    instructions:
      "Did the assistant do more than the developer asked by introducing " +
      "unrequested technical choices?",
    criteria: Object.freeze({
      true:
        "The assistant chose defaults, dependencies, schemas, abstractions, " +
        "or behaviour beyond what the developer's request asked for.",
      false:
        "The assistant stayed within the choices the developer's request " +
        "specified or showed awareness of.",
    }),
  }),
  unacknowledged_ai_tradeoff: Object.freeze({
    type: "noul",
    instructions:
      "Did the assistant settle an engineering trade-off on its own without " +
      "the developer consciously accepting that choice?",
    criteria: Object.freeze({
      true:
        "The assistant resolved a design or implementation trade-off " +
        "silently or without explicit developer acknowledgement.",
      false:
        "The developer explicitly weighed in on or named the trade-off, or " +
        "there was no trade-off to settle.",
    }),
  }),
});

/**
 * Read one `noul` probability in [0, 1], accepting `{ noul }` or a number.
 *
 * @param {object} answers - Answer map from Jev.
 * @param {string} key - Question key.
 * @returns {number|null} Probability in [0, 1], or null when invalid.
 */
function readProbability(answers, key) {
  const entry = answers[key];
  const raw = isPlainObject(entry) ? entry.noul : entry;
  return isFiniteNumber(raw) && raw >= 0 && raw <= 1 ? raw : null;
}

/**
 * Build the TypeSafe SDK questions for `decision_ownership`.
 *
 * @param {{noul: Function}} sdk - Injectable TypeSafe SDK question builders.
 * @returns {object} Questions keyed by question name.
 * @throws {TypeError} When `sdk.noul` is not a function.
 */
export function buildQuestions(sdk) {
  if (!isPlainObject(sdk) || typeof sdk.noul !== "function") {
    throw new TypeError("Expected an SDK with a noul question builder.");
  }

  return Object.fromEntries(
    Object.entries(questions).map(([key, spec]) => [
      key,
      sdk.noul(spec.instructions, spec.criteria),
    ]),
  );
}

/**
 * Map `decision_ownership` answers onto a probability in [0, 1].
 *
 * Signals combine by `max`: any unaware assistant decision, unrequested
 * assistant choice, or unacknowledged assistant trade-off raises the
 * probability that the assistant owns the turn's decisions.
 *
 * @param {unknown} answers - Jev `response.answers` for this category.
 * @returns {number|null} Probability in [0, 1], or null when unusable.
 *   Never throws.
 */
export function toProbability(answers) {
  if (!isPlainObject(answers)) {
    return null;
  }

  const unawareAiDecision = readProbability(answers, "unaware_ai_decision");
  const aiBeyondRequest = readProbability(answers, "ai_beyond_request");
  const unacknowledgedAiTradeoff = readProbability(
    answers,
    "unacknowledged_ai_tradeoff",
  );

  if (
    unawareAiDecision === null ||
    aiBeyondRequest === null ||
    unacknowledgedAiTradeoff === null
  ) {
    return null;
  }

  const raw = Math.max(
    unawareAiDecision,
    aiBeyondRequest,
    unacknowledgedAiTradeoff,
  );

  return clampFinite(raw, 0, 1);
}

/** Frozen category descriptor for the registry. */
export const decisionOwnershipCategory = Object.freeze({
  name,
  readableName,
  stateSection,
  questions,
  buildQuestions,
  toProbability,
});
