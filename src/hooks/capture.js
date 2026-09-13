// The shared frame every capture hook runs inside.
//
// The four capture entrypoints differ in one thing only: which event they
// build from a payload. Everything around that decision is identical, and it
// is precisely the part that must not drift — the self-instrumentation guard,
// the fail-silent contract, and the promise that one invocation leaves exactly
// one trace line. Four copies of that frame would be four chances for one hook
// to quietly start throwing into a user's session.
//
// So this module owns the invariant order:
//
//   1. STOIC_INTERNAL — leave before reading or writing ANYTHING. The
//      classifier's future headless child sets it; a hook that observed that
//      child would be scoring the plugin's own machinery.
//   2. Read and parse stdin, then resolve the Project Root. With no root there
//      is no project to trace into, so the one line goes to the shared trace.
//   3. Anything that is not a payload object carrying a session id is
//      `malformed_input`: with no session there is nowhere to append, and the
//      turn is worth more than the event. Then honor the master switch.
//   4. Let the entrypoint build its event — or decline to.
//   5. Append, and trace exactly one outcome.
//
// Every exit from that sequence is a silent, successful one. A capture hook
// prints nothing at all: stdout belongs to the Stop hook's pause-delivery
// contract, and a stray line here would reach the user's conversation.
//
// Contract: thoughts/shared/.project/architecture/payloads.md §`Hook inputs`,
// §`Session event log`, §`local-trace.jsonl`, §`shared-trace.jsonl`.
import { isNonEmptyString, isPlainObject } from "../core/predicates.js";
import { loadConfig } from "../io/config/config.js";
import { resolveProjectRoot } from "../io/project-root.js";
import { appendSessionEvent } from "../io/session-log.js";
import { writeLocalTraceLine, writeSharedTraceLine } from "../io/trace.js";
import { readHookPayload, traceErrorMessage } from "./hook-runtime.js";

/** The mode recorded when a payload names none — the mode that asks for most. */
const DEFAULT_PERMISSION_MODE = "default";

// The two field readers below stay here rather than moving to `src/core/`.
// They are not domain logic — they carry no judgment a test could disagree
// with — but the event-writing policy of this frame: what an unstated field
// means in a log line. The Domain layer exists to keep scoring swappable and
// unit-testable; a ternary that spells "unstated means default" would gain
// nothing there and would separate the policy from the shapes it fills in.

/**
 * The permission mode in force for an event. A payload that names no mode is
 * recorded as the default one rather than as nothing: the field feeds the turn
 * delta's auto-accept multiplier, and the honest reading of "unstated" is the
 * mode that grants the least, not an absent value the scorer has to special-
 * case.
 *
 * @param {object} payload - Parsed hook payload.
 * @returns {string} A permission-mode name.
 */
export const permissionModeOf = (payload) =>
  isNonEmptyString(payload.permission_mode)
    ? payload.permission_mode
    : DEFAULT_PERMISSION_MODE;

/**
 * The kind of sub-agent an event belongs to, or null when the payload does not
 * say. Null rather than omitted: the frozen event shapes always carry the
 * field, so a later reader never has to distinguish "absent" from "unknown".
 *
 * @param {object} payload - Parsed hook payload.
 * @returns {string|null} Agent type name, or null.
 */
export const agentTypeOf = (payload) =>
  isNonEmptyString(payload.agent_type) ? payload.agent_type : null;

/**
 * Run one capture hook end to end. Never throws, never prints, always exits 0.
 *
 * @param {string} hook - Hook name as registered in `hooks/hooks.json`; it
 *   labels this invocation's trace line.
 * @param {(payload: object, projectDir: string) =>
 *   ({event: object} | {outcome: string, [extra: string]: unknown})} buildEvent
 *   The entrypoint's one decision: the event to append, or the outcome to
 *   trace instead when this payload must not be observed. It may read only the
 *   fields frozen in `payloads.md` and should tolerate any value in them —
 *   anything it throws becomes an `error` outcome rather than a broken turn.
 */
export function runCaptureHook(hook, buildEvent) {
  // Presence, not value: the guard exists so the plugin cannot observe its own
  // child processes, and any value at all means one is running.
  if (process.env.STOIC_INTERNAL !== undefined) {
    return;
  }

  // Null until resolution names a project: a failure before that has no local
  // trace to land in.
  let projectDir = null;
  try {
    const payload = readHookPayload();

    // The Project Root, not the directory this process was handed: a session
    // can report a subfolder turns after starting at the root, and the event
    // log, the trace, and the outside-the-project drop all have to agree on one
    // project. A malformed payload offers no `cwd`, but its trace line still
    // belongs to the root rather than to a subfolder.
    projectDir = resolveProjectRoot(process.cwd(), payload?.cwd);
    if (projectDir === null) {
      writeSharedTraceLine(hook, { outcome: "no_project_root" });
      return;
    }

    if (payload === undefined) {
      // With no session there is nowhere to append, and the turn is worth more
      // than the event.
      writeLocalTraceLine(projectDir, hook, { outcome: "malformed_input" });
      return;
    }

    if (!loadConfig(projectDir).enabled) {
      writeLocalTraceLine(projectDir, hook, { outcome: "disabled" });
      return;
    }

    const captured = buildEvent(payload, projectDir);
    if (!isPlainObject(captured.event)) {
      writeLocalTraceLine(projectDir, hook, captured);
      return;
    }
    appendSessionEvent(projectDir, payload.session_id, captured.event);
    writeLocalTraceLine(projectDir, hook, { outcome: "logged" });
  } catch (error) {
    // The safety net under a pipeline whose every I/O module already swallows
    // its own failures. Reaching it means a bug rather than a bad payload —
    // which is exactly why it must still cost nothing but one trace line.
    const line = { outcome: "error", error: traceErrorMessage(error) };
    if (projectDir === null) {
      writeSharedTraceLine(hook, line);
    } else {
      writeLocalTraceLine(projectDir, hook, line);
    }
  }
}
