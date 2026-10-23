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
import { clampFinite, isPlainObject } from "../../../src/core/predicates.js";
import { readProbability } from "../combine.js";
import { DEVELOPER_REFLECTION_NAME } from "../constants.js";

/** Canonical snake_case category identifier. */
export const name = DEVELOPER_REFLECTION_NAME;

/** Full human-readable name for logs and diagnostics. */
export const readableName = "Developer reflection";

/** Key of this category's section in the v3 structured state. */
export const stateSection = DEVELOPER_REFLECTION_NAME;

/**
 * Discount factor applied when a streak of bare option picks or go-aheads
 * pulls down borderline reflection signals.
 */
export const BARE_PICK_STREAK_PENALTY = 0.5;

/** Declarative Jev question definitions for `developer_reflection`. */
export const questions = Object.freeze({
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
      "Did the developer ask a question about the behaviour, risk, or " +
      "meaning of the work?",
    criteria: Object.freeze({
      true:
        "The developer asks a genuine question about behaviour, risks, or " +
        "how the change works.",
      false: "The developer asks no analytical question.",
    }),
  }),
  discussed_alternatives: Object.freeze({
    type: "noul",
    instructions:
      "Did the developer discuss an alternative to the approach under " +
      "consideration?",
    criteria: Object.freeze({
      true:
        "The developer compares options, names another approach, or weighs " +
        "a different design.",
      false: "The developer does not discuss an alternative.",
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
 * Positive reflection signals — justifying a choice, asking a question,
 * discussing an alternative, or suggesting a fix — combine by `max`.
 * A bare-pick streak dampens borderline reflection proportionally to
 * `(1 - positiveReflection)`.
 *
 * @param {unknown} answers - Jev `response.answers` for this category.
 * @returns {number|null} Probability in [0, 1], or null when unusable.
 *   Never throws.
 */
export function toProbability(answers) {
  if (!isPlainObject(answers)) {
    return null;
  }

  const justifiedChoice = readProbability(answers, "justified_choice");
  const askedQuestions = readProbability(answers, "asked_questions");
  const discussedAlternatives = readProbability(
    answers,
    "discussed_alternatives",
  );
  const suggestedFixes = readProbability(answers, "suggested_fixes");
  const barePickStreak = readProbability(answers, "bare_pick_streak");

  if (
    justifiedChoice === null ||
    askedQuestions === null ||
    discussedAlternatives === null ||
    suggestedFixes === null ||
    barePickStreak === null
  ) {
    return null;
  }

  const positiveReflection = Math.max(
    justifiedChoice,
    askedQuestions,
    discussedAlternatives,
    suggestedFixes,
  );
  const barePickDrag =
    barePickStreak * BARE_PICK_STREAK_PENALTY * (1 - positiveReflection);

  return clampFinite(positiveReflection * (1 - barePickDrag), 0, 1);
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
