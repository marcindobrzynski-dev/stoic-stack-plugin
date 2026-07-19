// Pure diff-stat extraction — how big was one edit, in lines?
//
// The PostToolUse hook (matcher `Edit|MultiEdit|Write`) calls this at write
// time and stores `lines_added` / `lines_removed` on the edit event; the turn
// delta later weighs the totals. Extraction is shape-driven rather than
// keyed on `tool_name`, because the frozen hook-input contract only promises
// `tool_response` "diff/patch data" — the response's own fields say what kind
// of evidence it carries:
//
// 1. `structuredPatch` (Edit / MultiEdit) — real hunks; count `+` / `-` lines.
// 2. `type: "create"` (Write, new file) — every content line is an addition.
// 3. `originalFile` + `content` (Write, full-file rewrite) — no usable diff.
//    DOCUMENTED APPROXIMATION: the rewrite is counted as replacing the whole
//    file — every new line added, every old line removed. This overstates a
//    rewrite that changed little, but a whole-file overwrite accepted in one
//    keystroke is exactly the volume signal the score is after, and the turn
//    delta caps total diff lines anyway.
// 4. Anything else — zeros: an unobserved change costs nothing, consistent
//    with the fail-silent observation pipeline.
//
// This module is Domain-layer pure: deterministic, no I/O, tolerant of any
// input shape, and it never throws. Malformed patch fragments are skipped,
// not fatal — one bad hunk costs its own count, never the event.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §`Hook inputs` (PostToolUse row) and §`Session event log` (edit event).
import { isPlainObject } from "./predicates.js";

/**
 * Count the lines of a text block. The final trailing newline terminates the
 * last line rather than opening an empty one ("a\n" is one line, "a\nb" is
 * two), and the empty string has no lines at all.
 *
 * @param {unknown} text - File or patch content.
 * @returns {number} Line count; 0 for non-strings.
 */
export function lineCount(text) {
  if (typeof text !== "string" || text === "") {
    return 0;
  }
  return text.replace(/\r?\n$/, "").split(/\r?\n/).length;
}

/** Sum `+` / `-` diff lines across every well-formed hunk of a patch. */
function countPatchLines(structuredPatch) {
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const hunk of structuredPatch) {
    if (!isPlainObject(hunk) || !Array.isArray(hunk.lines)) {
      continue;
    }
    for (const line of hunk.lines) {
      if (typeof line !== "string") {
        continue;
      }
      if (line.startsWith("+")) {
        linesAdded += 1;
      } else if (line.startsWith("-")) {
        linesRemoved += 1;
      }
    }
  }
  return { linesAdded, linesRemoved };
}

/**
 * Extract the size of one edit from a `PostToolUse` tool response, per the
 * shape ladder in the module header: patch hunks first, then the file-create
 * shape, then the whole-file-rewrite approximation, and zeros for anything
 * that carries no usable diff.
 *
 * @param {unknown} toolResponse - `tool_response` from the hook payload.
 * @returns {{linesAdded: number, linesRemoved: number}} Non-negative counts;
 *   the hook stores them as the edit event's `lines_added` / `lines_removed`
 *   fields. Never throws.
 */
export function extractDiffStats(toolResponse) {
  if (!isPlainObject(toolResponse)) {
    return { linesAdded: 0, linesRemoved: 0 };
  }
  if (Array.isArray(toolResponse.structuredPatch)) {
    return countPatchLines(toolResponse.structuredPatch);
  }
  if (
    toolResponse.type === "create" &&
    typeof toolResponse.content === "string"
  ) {
    return { linesAdded: lineCount(toolResponse.content), linesRemoved: 0 };
  }
  if (
    typeof toolResponse.originalFile === "string" &&
    typeof toolResponse.content === "string"
  ) {
    return {
      linesAdded: lineCount(toolResponse.content),
      linesRemoved: lineCount(toolResponse.originalFile),
    };
  }
  return { linesAdded: 0, linesRemoved: 0 };
}
