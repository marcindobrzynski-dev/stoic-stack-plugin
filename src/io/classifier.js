// The Classifier (Veto Gate) — LLM #1, the cheap label that decides whether a
// fired gate is allowed to interrupt the developer.
//
// Two of the three functions here are deliberately side-effect-free: one turns
// a turn group plus the project's configured vocabulary into a prompt string,
// the other turns whatever the model answered back into a validated
// classification. No filesystem, no child processes, no environment reads —
// the spawn lives in `src/io/headless.js`. `classify` is the seam that joins
// them to that runner and evaluates the veto, so everything below the spawn
// stays unit-testable on its own.
//
// The vocabulary is never restated here. It is read from the configuration
// through `allowedSubcategories`, so a pruned entry or a disabled area is
// invisible to the model, and a taxonomy change lands in exactly one file.
//
// `classify` returns data, never control flow: one decision object carrying
// the validated classification (when there is one) and either a pass or
// exactly one veto reason. The Stop hook applies that decision; it re-derives
// nothing. And it never throws — a classifier that failed must cost the user a
// pause, never a session.
//
// Testability is programmatic, exactly as in the runner: `options.runner`
// substitutes the headless call, its production default is the real module,
// and no environment variable can reach it.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// (§ "Classifier verdict (LLM #1)").
import {
  allowedSubcategories,
  configuredConfidenceFloor,
  normalizeConfig,
  resolveCategory,
} from "./config/config.js";
import { runClaude } from "./headless.js";
import {
  clampFinite,
  isFiniteNumber,
  isNonEmptyString,
  isPlainObject,
} from "../core/predicates.js";

// Temporary imports from experiment
import {
  JEV_GENERAL_CATEGORY,
  JEV_MODEL_PREFIX,
} from "../../experiments/jev/jev.constants.js";
import { runJev } from "../../experiments/jev/runner.js";

/**
 * Characters of turn-prompt text the classification prompt may carry. A
 * pathological turn (a pasted log, a whole file) must not become an oversized
 * classification prompt; the opening of a prompt carries the intent anyway.
 */
export const PROMPT_TEXT_LIMIT = 2000;

/** Touched files the classification prompt may list, for the same reason. */
export const TOUCHED_FILE_LIMIT = 30;

/** Turn-group text, defensively: anything that is not usable text reads as empty. */
function readText(value) {
  return isNonEmptyString(value) ? value.slice(0, PROMPT_TEXT_LIMIT) : "";
}

/** Turn-group counts, defensively: anything unusable for arithmetic reads as zero. */
function readCount(value) {
  return isFiniteNumber(value) ? value : 0;
}

/**
 * The files a turn touched, derived from its edits — the turn group carries no
 * file list of its own. Deduped in first-touch order, then bounded, so a sweep
 * across hundreds of files cannot inflate the prompt.
 *
 * `src/hooks/stop-decision.js` (`touchedFiles`) makes the same derivation for
 * the gates, deliberately WITHOUT the bound: a prompt must stay small, a gate
 * must see every file. A change to what counts as a usable edit belongs in
 * both places.
 *
 * @param {unknown} edits - The turn group's `edits` array, or anything else.
 * @returns {string[]} Distinct file paths, at most `TOUCHED_FILE_LIMIT`.
 */
function readTouchedFiles(edits) {
  if (!Array.isArray(edits)) {
    return [];
  }
  const files = [];
  for (const edit of edits) {
    if (!isPlainObject(edit) || !isNonEmptyString(edit.file)) {
      continue;
    }
    if (!files.includes(edit.file)) {
      files.push(edit.file);
    }
    if (files.length === TOUCHED_FILE_LIMIT) {
      break;
    }
  }
  return files;
}

/**
 * Build the classification prompt: a single flat instruction the headless
 * runner delivers on stdin, never on a command line, so arbitrary prompt text
 * can never be shell-quoted.
 *
 * The turn group is read defensively — a missing, mistyped, or entirely absent
 * group yields an empty, zeroed summary rather than an exception, because the
 * caller is a hook that must not break the session.
 *
 * @param {unknown} group - A turn group, or anything else.
 * @param {object} [config] - Project configuration (canonical or raw).
 * @returns {string} The prompt text. Never throws.
 */
export function buildClassificationPrompt(group, config) {
  const turn = isPlainObject(group) ? group : {};
  const vocabulary = allowedSubcategories(config);

  return [
    "You are a decision classifier for a developer mindfulness tool.",
    "Given one coding-assistant turn — the developer's request and the edits it",
    "produced — decide whether the turn contains a deliberate, consequential",
    "engineering decision the developer should stay aware of.",
    "",
    "Allowed labels (choose exactly one, or null when none fits):",
    JSON.stringify(vocabulary),
    "",
    "Turn data:",
    `Developer request: ${JSON.stringify(readText(turn.prompt))}`,
    `Edits executed: ${readCount(turn.edit_count)}`,
    `Diff stats: +${readCount(turn.lines_added)} / -${readCount(turn.lines_removed)} lines`,
    `Touched files: ${JSON.stringify(readTouchedFiles(turn.edits))}`,
    "",
    "Answer ONLY with a single JSON object, no prose, no markdown fences:",
    '{"decision_found": <true when the turn contains such a decision, else false>,',
    ' "subcategory": "<one of the allowed labels, or null>",',
    ' "reason": "<one short sentence>",',
    ' "confidence": <0..1>}',
  ].join("\n");
}

/**
 * Validate a returned verdict into the pending-pause-ready classification.
 *
 * A verdict that is not an object, or that lacks a boolean `decision_found`, is
 * no classification at all: `null`, which the veto evaluation reads as
 * `no_classification`. There is no partial credit, because a verdict that lost
 * its central field cannot be trusted on the others.
 *
 * Everything else is coerced rather than rejected: `reason` becomes a string,
 * `confidence` is clamped into [0, 1] — the model's number is never trusted to
 * already be in range — and the emitted name is resolved to its enabled
 * top-level area. The raw emitted name is kept as `subcategory` even when
 * resolution fails, so a trace can show what the model actually said; a `null`
 * `category` is the authoritative signal that the name was unknown, pruned, or
 * in a disabled area.
 *
 * @param {unknown} verdict - A parsed verdict object, or anything else.
 * @param {object} [config] - Project configuration (canonical or raw).
 * @returns {{decision_found: boolean, category: string|null,
 *   subcategory: string|null, reason: string, confidence: number}|null}
 *   The classification, or null when there is none. Never throws.
 */
export function validateClassification(verdict, config) {
  if (!isPlainObject(verdict) || typeof verdict.decision_found !== "boolean") {
    return null;
  }

  const emitted = isNonEmptyString(verdict.subcategory)
    ? verdict.subcategory
    : null;
  const resolution = resolveCategory(emitted, config);
  const resolved = resolution ? resolution.category : null;

  return {
    decision_found: verdict.decision_found,
    category: resolved,
    subcategory: emitted,
    reason: typeof verdict.reason === "string" ? verdict.reason : "",
    confidence: clampFinite(verdict.confidence, 0, 1),
  };
}

/**
 * The veto reasons, in the order the contract checks them. Exported so a
 * consumer can name them without restating the vocabulary.
 *
 * @typedef {"no_classification"|"no_decision"|"low_confidence"|"bad_category"}
 *   VetoReason
 */
export const VETO_REASONS = Object.freeze([
  "no_classification",
  "no_decision",
  "low_confidence",
  "bad_category",
]);

/**
 * @typedef {{status: "pass", reason: null, classification: object}
 *   | {status: "veto", reason: VetoReason, classification: object|null}}
 *   ClassifierDecision
 */

/** A veto, shaped like every other decision so a consumer reads one shape. */
function veto(reason, classification) {
  return { status: "veto", reason, classification };
}

/**
 * Classify one turn group and evaluate the veto.
 *
 * The whole classifier in one call: build the prompt from the group and the
 * project's vocabulary, run it through the headless CLI on the configured
 * model, validate what came back, and check the contract's four veto reasons
 * in order, returning the first that applies. The classification travels with
 * the veto whenever there is one, because a consumer that wants to trace why a
 * pause was suppressed needs the label, not just the reason.
 *
 * The confidence check is strict: a confidence *below* the configured floor
 * vetoes, so a verdict landing exactly on it passes. The floor is
 * `configuredConfidenceFloor` — the active preset's
 * `classifier_confidence_threshold` when the preset defines one, otherwise
 * the project setting, which defaults to `0.6`. It is the lowest confidence
 * the user accepts, not the first one they reject.
 *
 * Only `classifier_model` and `classifier_confidence_threshold` are consumed,
 * through the same fail-silent normalization every other reader uses, so a
 * missing or corrupt configuration classifies against the built-in defaults
 * rather than not classifying at all.
 *
 * @param {unknown} group - A turn group, or anything else.
 * @param {object} [config] - Project configuration (canonical or raw).
 * @param {object} [context] - Turn data for the runner,
 *   `{ stopInput, projectDir }`; carried through unread. `runClaude` ignores
 *   it; `runJev` forwards it.
 * @param {object} [options] - Call options.
 * @param {Function} [options.runner] - Seam with the `runClaude`
 *   signature; defaults to `runJev` for a model starting with `jev`, and to
 *   `runClaude` otherwise.
 * @param {object} [options.personalState] - Personal engine state. The
 *   confidence floor follows its `preset` when that preset defines one.
 * @param {object} [options.presets] - Preset table forwarded to
 *   `configuredConfidenceFloor`. Production leaves this unset.
 * @returns {ClassifierDecision} The decision. Never throws: any internal
 *   failure is the `no_classification` veto.
 */
export function classify(group, config, context, options) {
  try {
    // A caller that has no group at all is broken; classifying the empty
    // summary it would read as could only manufacture a pause from nothing.
    // Garbage FIELDS inside a real group object still read defensively.
    if (!isPlainObject(group)) {
      return veto("no_classification", null);
    }

    const settings = isPlainObject(options) ? options : {};
    const normalizedConfig = normalizeConfig(config);
    const { classifier_model: model } = normalizedConfig;
    const floor = configuredConfidenceFloor(
      normalizedConfig,
      settings.personalState,
      settings.presets,
    );

    let runner;
    if (typeof settings.runner === "function") {
      runner = settings.runner;
    } else if (model.startsWith(JEV_MODEL_PREFIX)) {
      runner = runJev;
    } else {
      runner = runClaude;
    }

    const result = runner(buildClassificationPrompt(group, config), {
      model,
      group,
      context,
    });

    if (!isPlainObject(result) || result.status !== "ok") {
      return veto("no_classification", null);
    }

    const classification = validateClassification(result.value, config);
    if (!classification) {
      return veto("no_classification", null);
    }

    const isJevVerdict =
      model.startsWith(JEV_MODEL_PREFIX) && result.provider === "jev";

    if (
      isJevVerdict &&
      classification.category === null &&
      classification.subcategory === JEV_GENERAL_CATEGORY &&
      normalizedConfig.categories.length > 0
    ) {
      classification.category = JEV_GENERAL_CATEGORY;
    }

    if (classification.decision_found !== true) {
      return veto("no_decision", classification);
    }

    if (classification.confidence < floor) {
      return veto("low_confidence", classification);
    }

    // Resolution already honored disabled areas and pruned vocabularies; a
    // null category is that verdict, not a second judgment of it.
    if (classification.category === null) {
      return veto("bad_category", classification);
    }

    return { status: "pass", reason: null, classification };
  } catch {
    return veto("no_classification", null);
  }
}
