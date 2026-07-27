// Shared harness for driving the real capture hooks as child processes.
//
// Every capture-hook suite verifies the plugin through this one seam: spawn
// the actual `src/hooks/*.js` entrypoint with synthetic stdin JSON against a
// throwaway project and home, then assert only what Claude Code itself could
// observe — exit status, stdout, and the documents left on disk. Nothing
// reaches inside the process, because the fail-silent contract is precisely a
// statement about that outside view.
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { tracePath } from "../../src/io/paths.js";
import { readSessionEvents } from "../../src/io/session-log.js";

/** Absolute path of a capture-hook entrypoint, by file name. */
export const hookEntrypoint = (name) =>
  fileURLToPath(new URL(`../../src/hooks/${name}.js`, import.meta.url));

/**
 * Run one hook against a payload. A non-string payload is serialized; a string
 * is piped verbatim, which is how the malformed-stdin cases are expressed.
 *
 * @param {object} sandbox - Sandbox from `createSandbox`.
 * @param {string} name - Entrypoint file name, e.g. `user-prompt-submit`.
 * @param {unknown} payload - Hook stdin payload, or raw text.
 * @param {{env?: Record<string, string|undefined>}} [options] - Extra
 *   environment variables, merged over the sandbox environment.
 */
export function runHook(sandbox, name, payload, options = {}) {
  return sandbox.runNode(hookEntrypoint(name), [], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: { ...sandbox.env, ...options.env },
  });
}

/** The events the hook appended to this session's log, in append order. */
export const readEvents = (sandbox, sessionId) =>
  readSessionEvents(sandbox.projectDir, sessionId, sandbox.homeDir);

/** Every trace line written so far, parsed, in append order. */
export function readTrace(sandbox) {
  let raw;
  try {
    raw = fs.readFileSync(
      tracePath(sandbox.projectDir, sandbox.homeDir),
      "utf8",
    );
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

/** The one trace outcome a single hook invocation is contracted to write. */
export function soleTraceOutcome(sandbox) {
  const lines = readTrace(sandbox);
  return lines.length === 1
    ? lines[0].outcome
    : `<${lines.length} trace lines>`;
}
