// The two mechanical chores every hook entrypoint does, and neither owns.
//
// `capture.js` and `stop.js` orchestrate different things — one appends an
// event, the other closes a turn — and they stay independent on purpose. But
// both start by turning fd 0 into a payload, and both end by turning a thrown
// value into one trace-safe line. Neither step carries any judgment a test
// could disagree with, so two copies of them were two chances for a fix to
// land in one hook and not the other.
//
// This is a LEAF module by design: it reads no configuration, resolves no
// paths, writes nothing, and imports nothing from `src/io/`. It holds the
// chores, not the frame. Everything that decides — the `STOIC_INTERNAL` guard
// and its position, project-directory resolution, the master switch, which
// outcome gets traced — stays with the entrypoint that has to answer for it.
//
// Contract: thoughts/shared/.project/architecture/payloads.md §`Hook inputs`,
// §`local-trace.jsonl`.
import fs from "node:fs";

import { isNonEmptyString, isPlainObject } from "../core/predicates.js";

/** How much of a thrown value survives into a trace line. */
const TRACE_ERROR_MAX_LENGTH = 200;

/**
 * The hook payload on stdin, or undefined when there is not a usable one.
 *
 * Three failures collapse into that one undefined because no caller can tell
 * them apart usefully: an unreadable fd 0 (a hook run by hand, a closed pipe),
 * text that is not JSON, and JSON that is not a payload object naming a
 * session. Every hook needs a session id — it is the log file to append to and
 * the log file to consume — so a payload without one is no more actionable
 * than no payload at all. Callers trace that as `malformed_input`.
 *
 * Never throws: reading stdin happens before a hook has proven anything about
 * its environment, and the fail-silent contract starts here.
 *
 * @returns {object|undefined} A payload object carrying a non-empty
 *   `session_id`, or undefined.
 */
export function readHookPayload() {
  let raw;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch {
    return undefined;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return undefined;
  }

  return isPlainObject(payload) && isNonEmptyString(payload.session_id)
    ? payload
    : undefined;
}

/**
 * Collapse any thrown value into one short trace-safe line.
 *
 * The trace is a JSONL file a human greps; a stack trace or a multi-megabyte
 * message would drown the line it belongs to and every line after it. First
 * line only, capped — enough to name the bug, never enough to be the problem.
 *
 * @param {unknown} error - Anything a `catch` can receive, including a
 *   non-Error value with no `message`.
 * @returns {string} A single line of at most 200 characters.
 */
export function traceErrorMessage(error) {
  return String(error?.message ?? error)
    .split("\n")[0]
    .slice(0, TRACE_ERROR_MAX_LENGTH);
}
