// Category module for `developer_intent` — how deliberately the developer
// framed and owned the request before the assistant acted.
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
import { clampFinite, isPlainObject } from "../../../src/core/predicates.js";
import { readProbability } from "../combine.js";

/** Canonical snake_case category identifier. */
export const name = "developer_intent";

/** Full human-readable name for logs and diagnostics. */
export const readableName = "Developer intent";

/** Key of this category's section in the v3 structured state. */
export const stateSection = "developer_intent";

/**
 * Weight applied when the developer brings their own proposal and refines it
 * with the assistant: counts nearly as the developer's own ready idea.
 */
export const REFINING_PROPOSAL_WEIGHT = 0.9;

/**
 * Weight applied to a specific, bounded request when the developer is not
 * merely accepting an assistant-originated proposal.
 */
export const SPECIFIC_REQUEST_WEIGHT = 0.6;

/** Declarative Jev question definitions for `developer_intent`. */
export const questions = Object.freeze({
  own_idea: Object.freeze({
    type: "noul",
    instructions:
      "Does the developer's request state their own concrete idea or ready " +
      "decision for what to build or change?",
    criteria: Object.freeze({
      true:
        "The developer brings a decided approach, design, or rule of their " +
        "own and asks the assistant to carry it out.",
      false:
        "The developer asks the assistant what to do, accepts an assistant " +
        "proposal, or leaves the approach open.",
    }),
  }),
  refining_own_proposal: Object.freeze({
    type: "noul",
    instructions:
      "Does the developer bring their own proposal or direction and refine " +
      "it with the assistant?",
    criteria: Object.freeze({
      true:
        "The developer starts from their own proposal, hypothesis, or design " +
        "sketch and iterates on it with the assistant.",
      false:
        "The developer brings no proposal of their own, or only reacts to " +
        "ideas the assistant originated.",
    }),
  }),
  specific_request: Object.freeze({
    type: "noul",
    instructions:
      "Is the developer's request specific about the target behaviour, " +
      "constraints, or files rather than open-ended?",
    criteria: Object.freeze({
      true:
        "The request names concrete constraints, boundaries, files, or " +
        "expected outcomes.",
      false:
        "The request is a broad prompt asking the assistant to figure out " +
        "the solution.",
    }),
  }),
  accepting_ai_proposal: Object.freeze({
    type: "noul",
    instructions:
      "Is the developer accepting a proposal originated by the assistant " +
      "rather than driving their own idea?",
    criteria: Object.freeze({
      true:
        "The assistant proposed the approach or options and the developer " +
        "is accepting or picking from them.",
      false:
        "The developer originated the approach or is refining their own " +
        "proposal.",
    }),
  }),
});

/**
 * Build the TypeSafe SDK questions for `developer_intent`.
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
 * Map `developer_intent` answers onto a probability in [0, 1].
 *
 * Signals combine by `max`: the developer's own idea carries full weight,
 * refining their own proposal with the assistant counts nearly as their own
 * idea (`REFINING_PROPOSAL_WEIGHT`), and a specific request contributes to
 * the degree the developer is not merely accepting an assistant proposal.
 *
 * @param {unknown} answers - Jev `response.answers` for this category.
 * @returns {number|null} Probability in [0, 1], or null when unusable.
 *   Never throws.
 */
export function toProbability(answers) {
  if (!isPlainObject(answers)) {
    return null;
  }

  const ownIdea = readProbability(answers, "own_idea");
  const refiningOwnProposal = readProbability(answers, "refining_own_proposal");
  const specificRequest = readProbability(answers, "specific_request");
  const acceptingAiProposal = readProbability(answers, "accepting_ai_proposal");

  if (
    ownIdea === null ||
    refiningOwnProposal === null ||
    specificRequest === null ||
    acceptingAiProposal === null
  ) {
    return null;
  }

  const raw = Math.max(
    ownIdea,
    refiningOwnProposal * REFINING_PROPOSAL_WEIGHT,
    specificRequest * SPECIFIC_REQUEST_WEIGHT * (1 - acceptingAiProposal),
  );

  return clampFinite(raw, 0, 1);
}

/** Frozen category descriptor for the registry. */
export const developerIntentCategory = Object.freeze({
  name,
  readableName,
  stateSection,
  questions,
  buildQuestions,
  toProbability,
});
