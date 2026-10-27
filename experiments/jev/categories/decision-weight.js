// Category module for `decision_weight` — how consequential or costly to
// reverse the turn's engineering decisions are.
//
// Exists as its own category module so its declarative Jev questions and its
// answer-to-probability mapping stay isolated from the other categories and
// from the registry's generic orchestration.
//
// Pure and SDK-injectable: no I/O, no clock, no environment reads, and no
// import of `@typesafe-ai/sdk` at module load. `toProbability` never throws,
// returns `null` when any required answer is missing or out of [0, 1], and
// never reads or vetoes on `area_label`.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §Classifier verdict (LLM #1).
import { clampFinite, isPlainObject } from "../../../src/core/predicates.js";
import { readProbability } from "../combine.js";
import { DECISION_WEIGHT_NAME } from "../jev.constants.js";
import { buildNoulQuestions } from "./categories.helpers.js";

/** Full human-readable name for logs and diagnostics. */
const readableName = "Decision weight";

/** Declarative Jev question definitions for `decision_weight`. */
const questions = Object.freeze({
  logic_and_size: Object.freeze({
    type: "noul",
    instructions:
      "Did the turn make a substantial change to domain logic, control flow, " +
      "state management, or module structure?",
    criteria: Object.freeze({
      true:
        "The changes alter non-trivial runtime behaviour, domain rules, " +
        "algorithms, or boundaries across the codebase.",
      false:
        "The changes are small and local, cosmetic, formatting-only, or " +
        "touch no code logic.",
    }),
  }),
  one_way_decision: Object.freeze({
    type: "noul",
    instructions:
      "Did the turn make a one-way or costly-to-reverse decision, even if " +
      "the diff is small?",
    criteria: Object.freeze({
      true:
        "It adds or changes a dependency, database schema, migration, " +
        "security boundary, persisted format, or public API contract, " +
        "regardless of line count.",
      false:
        "Every change is local and easily reversible without migration, " +
        "contract breakage, or dependency churn.",
    }),
  }),
  non_code_decision: Object.freeze({
    type: "noul",
    instructions:
      "Did the turn record or adopt a non-code architectural or design " +
      "decision, such as an ADR or specification, even with an empty code " +
      "diff?",
    criteria: Object.freeze({
      true:
        "The turn commits to an architectural decision record, design " +
        "contract, or system rule outside source code.",
      false:
        "No non-code architectural or design decision was adopted in this " +
        "turn.",
    }),
  }),
  unaware_decision_cascade: Object.freeze({
    type: "noul",
    instructions:
      "Does this turn continue a cascade of repeated unaware assistant " +
      "decisions across turns?",
    criteria: Object.freeze({
      true:
        "The running count or history shows repeated unaware assistant " +
        "decisions accumulating across turns.",
      false: "There is no running buildup of unaware assistant decisions.",
    }),
  }),
});

/**
 * Map `decision_weight` answers onto a probability in [0, 1].
 *
 * Signals combine by `max` so a small one-way decision (`one_way_decision`)
 * or a non-code ADR (`non_code_decision` with an empty diff) carries full
 * weight without being diluted by `logic_and_size`. When a cascade of unaware
 * decisions is present alongside code/logic changes, it compounds with
 * `logic_and_size` (`1 - (1 - logic_and_size) * (1 - unaware_decision_cascade)`)
 * so repeated unaware small decisions raise the weight. `area_label` is never
 * consulted and never vetoes.
 *
 * @param {unknown} answers - Jev `response.answers` for this category.
 * @returns {number|null} Probability in [0, 1], or null when unusable.
 *   Never throws.
 */
function toProbability(answers) {
  if (!isPlainObject(answers)) {
    return null;
  }

  const logicAndSize = readProbability(answers, "logic_and_size");
  const oneWayDecision = readProbability(answers, "one_way_decision");
  const nonCodeDecision = readProbability(answers, "non_code_decision");
  const unawareDecisionCascade = readProbability(
    answers,
    "unaware_decision_cascade",
  );

  if (
    logicAndSize === null ||
    oneWayDecision === null ||
    nonCodeDecision === null ||
    unawareDecisionCascade === null
  ) {
    return null;
  }

  const cascadeRaised = 1 - (1 - logicAndSize) * (1 - unawareDecisionCascade);

  const raw = Math.max(
    logicAndSize,
    oneWayDecision,
    nonCodeDecision,
    unawareDecisionCascade,
    cascadeRaised,
  );

  return clampFinite(raw, 0, 1);
}

/** Frozen category descriptor for the registry. */
export const decisionWeightCategory = Object.freeze({
  name: DECISION_WEIGHT_NAME,
  readableName,
  stateSection: DECISION_WEIGHT_NAME,
  questions,
  buildNoulQuestions,
  toProbability,
});
