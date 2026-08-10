// The Classifier (Veto Gate) — LLM #1, the cheap label that decides whether a
// fired gate is allowed to interrupt the developer.
//
// This half of the module is deliberately side-effect-free: it turns a turn
// group plus the project's configured vocabulary into one prompt string, and
// turns whatever the model answered back into a validated classification. No
// filesystem, no child processes, no environment reads — the spawn lives in
// `src/io/headless.js`, and the veto ordering that consumes these functions is
// assembled separately. Everything here is unit-testable below the spawn.
//
// The vocabulary is never restated here. It is read from the configuration
// through `allowedSubcategories`, so a pruned entry or a disabled area is
// invisible to the model, and a taxonomy change lands in exactly one file.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// (§ "Classifier verdict (LLM #1)").
import { allowedSubcategories, resolveCategory } from "./config.js";
import {
  clampFinite,
  isFiniteNumber,
  isNonEmptyString,
  isPlainObject,
} from "../core/predicates.js";

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
