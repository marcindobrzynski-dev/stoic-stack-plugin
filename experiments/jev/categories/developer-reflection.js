// Category module for `developer_reflection` — whether the developer actively
// analysed, questioned, or justified the work versus approving on reflex.
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
//
// Experiment only (`feature/jev-classifier-experiment`, never merged).
import {
  clampFinite,
  isFiniteNumber,
  isPlainObject,
} from "../../../src/core/predicates.js";

/** Canonical snake_case category identifier. */
export const name = "developer_reflection";

/** Full human-readable name for logs and diagnostics. */
export const readableName = "Developer reflection";

/** Key of this category's section in the v3 structured state. */
export const stateSection = "developer_reflection";

/**
 * Discount factor applied when a streak of bare option picks or go-aheads
 * pulls down borderline reflection signals.
 */
export const BARE_PICK_STREAK_PENALTY = 0.5;

/** Declarative Jev question definitions for `developer_reflection`. */
export const questions = Object.freeze({
  reflex_approval: Object.freeze({
    type: "noul",
    instructions:
      "Is the developer's message a bare go-ahead or option pick without " +
      "reasoning?",
    criteria: Object.freeze({
      true:
        "It only confirms, approves, picks a lettered or named option, or " +
        "says to continue, with no reason, constraint, question, or " +
        "correction.",
      false:
        "It gives a reason, constraint, trade-off, question, or suggested " +
        "fix of its own.",
    }),
  }),
  justified_choice: Object.freeze({
    type: "noul",
    instructions:
      "Did the developer justify a choice with a reason, constraint, or " +
      "trade-off?",
    criteria: Object.freeze({
      true:
        "The developer explains why an option or approach fits, names a " +
        "constraint, or compares trade-offs.",
      false: "The developer states no reason, constraint, or trade-off.",
    }),
  }),
  asked_questions: Object.freeze({
    type: "noul",
    instructions:
      "Did the developer actively analyse the work by asking questions, " +
      "quizzing the assistant, or discussing alternatives?",
    criteria: Object.freeze({
      true:
        "The developer asks a genuine question about behaviour, risks, or " +
        "alternatives, or engages in technical discussion.",
      false:
        "The developer asks no analytical questions and does not discuss " +
        "alternatives.",
    }),
  }),
  suggested_fixes: Object.freeze({
    type: "noul",
    instructions:
      "Did the developer point out an issue, correct the assistant, or " +
      "suggest a specific fix?",
    criteria: Object.freeze({
      true:
        "The developer spots a flaw, pushes back on a choice, or proposes " +
        "a concrete fix or adjustment.",
      false: "The developer makes no correction or suggested fix.",
    }),
  }),
  bare_pick_streak: Object.freeze({
    type: "noul",
    instructions:
      "Across the recent turns, has the developer been answering with a " +
      "streak of bare picks or go-aheads?",
    criteria: Object.freeze({
      true:
        "The bare-pick history shows consecutive turns where the developer " +
        "only confirmed or picked options without reasoning.",
      false:
        "Recent turns include reasons, questions, constraints, or " +
        "corrections from the developer.",
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
 * Build the TypeSafe SDK questions for `developer_reflection`.
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
 * Map `developer_reflection` answers onto a probability in [0, 1].
 *
 * Positive reflection signals — justifying a choice, asking analytical
 * questions, or suggesting fixes — combine by `max`. Anti-reflection signals
 * (`reflex_approval` and `bare_pick_streak`) dampen borderline reflection
 * proportionally to `(1 - positiveReflection)`.
 *
 * @param {unknown} answers - Jev `response.answers` for this category.
 * @returns {number|null} Probability in [0, 1], or null when unusable.
 *   Never throws.
 */
export function toProbability(answers) {
  if (!isPlainObject(answers)) {
    return null;
  }

  const reflexApproval = readProbability(answers, "reflex_approval");
  const justifiedChoice = readProbability(answers, "justified_choice");
  const askedQuestions = readProbability(answers, "asked_questions");
  const suggestedFixes = readProbability(answers, "suggested_fixes");
  const barePickStreak = readProbability(answers, "bare_pick_streak");

  if (
    reflexApproval === null ||
    justifiedChoice === null ||
    askedQuestions === null ||
    suggestedFixes === null ||
    barePickStreak === null
  ) {
    return null;
  }

  const positiveReflection = Math.max(
    justifiedChoice,
    askedQuestions,
    suggestedFixes,
  );
  const autopilotDrag =
    Math.max(reflexApproval, barePickStreak * BARE_PICK_STREAK_PENALTY) *
    (1 - positiveReflection);

  return clampFinite(positiveReflection * (1 - autopilotDrag), 0, 1);
}

/** Frozen category descriptor for the registry. */
export const developerReflectionCategory = Object.freeze({
  name,
  readableName,
  stateSection,
  questions,
  buildQuestions,
  toProbability,
});
