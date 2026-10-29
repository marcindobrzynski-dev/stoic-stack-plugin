// The bounded trace sinks — Stoic Stack's only field-debugging surface.
//
// Every hook invocation appends exactly one compact JSON outcome line, so a
// dead pipeline is distinguishable from a quiet one without shipping logs
// anywhere. There are two sinks behind one append: the local trace, kept per
// project beside its state, and the shared trace above every project, for an
// invocation that could not name its project. Both deliberately replace the
// sandbox's unbounded `debug.log`: errors become an outcome line here, growth
// is capped by a single rotation per sink (`local-trace.jsonl` →
// `local-trace.jsonl.1`, `shared-trace.jsonl` → `shared-trace.jsonl.1`,
// previous generation discarded), and there is no debug mode — no
// `STOIC_DEBUG`, no raw payload capture, no environment-variable seams.
//
// Tracing must never break the traced session: neither writer throws or
// prints, and the append stamps `ts` and `hook` itself so five hook
// entrypoints cannot drift apart in how they label a line.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §`local-trace.jsonl`, §`shared-trace.jsonl`.
import fs from "node:fs";
import path from "node:path";

import { sharedTracePath, tracePath } from "./paths.js";

/**
 * Size at which the trace rotates. UNCALIBRATED PLACEHOLDER: bounds disk use
 * at roughly two generations of this size; not derived from observed line
 * volume.
 */
export const TRACE_MAX_BYTES = 256 * 1024;

/**
 * Append one outcome line to the local trace, the per-project sink. The line
 * is `{ ts, hook, ...data }`, compact, one per hook invocation. When the trace
 * has reached `TRACE_MAX_BYTES` it first rotates: the current file replaces
 * `local-trace.jsonl.1` and a fresh generation starts. Never throws, never
 * prints.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {string} hook - Hook name as registered in `hooks/hooks.json`.
 * @param {object} data - Outcome fields per the trace-line contract.
 * @param {string} [homeDir] - Home directory override for tests.
 */
export function writeLocalTraceLine(projectDir, hook, data, homeDir) {
  try {
    appendTraceLine(tracePath(projectDir, homeDir), hook, data);
  } catch {
    // Tracing must never break a hook.
  }
}

/**
 * Append one outcome line to the shared trace, the sink keyed on no project.
 * Same line shape and rotation as the per-project trace. Never throws, never
 * prints.
 *
 * @param {string} hook - Trace label: a hook name as registered in
 *   `hooks/hooks.json`, or a CLI's own label (`setup`, `reflect`).
 * @param {object} data - Outcome fields per the trace-line contract.
 * @param {string} [homeDir] - Home directory override for tests.
 */
export function writeSharedTraceLine(hook, data, homeDir) {
  try {
    appendTraceLine(sharedTracePath(homeDir), hook, data);
  } catch {
    // Tracing must never break a hook.
  }
}

/**
 * Stamp, bound, and append one line to a trace file, creating its directory
 * when missing. Throws; both public writers catch.
 *
 * @param {string} target - Absolute path of the live trace file.
 * @param {string} hook - Trace label the line is stamped with (see the two
 *   public writers).
 * @param {object} data - Outcome fields per the trace-line contract.
 */
function appendTraceLine(target, hook, data) {
  // Stamps come after the spread so caller data can never override them —
  // `ts`, `hook`, and thereby `outcome`'s labeling are required on every
  // line by the trace contract.
  const line = JSON.stringify({ ...data, ts: Date.now(), hook });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  rotateIfFull(target);
  fs.appendFileSync(target, `${line}\n`, "utf8");
}

/**
 * Rotate a full trace file out of the way, dropping the previous generation.
 * A missing file, and a rotation that itself fails, both fall through to the
 * append — bounding is best-effort, losing a line is worse than exceeding
 * the cap by one write.
 *
 * @param {string} target - Absolute path of the live trace file.
 */
function rotateIfFull(target) {
  try {
    if (fs.statSync(target).size >= TRACE_MAX_BYTES) {
      fs.rmSync(`${target}.1`, { force: true });
      fs.renameSync(target, `${target}.1`);
    }
  } catch {
    // No trace yet, or rotation lost a race — append to what is there.
  }
}
