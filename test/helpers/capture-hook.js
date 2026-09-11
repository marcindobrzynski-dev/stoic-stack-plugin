// Shared harness for driving the real capture hooks as child processes.
//
// Every capture-hook suite verifies the plugin through this one seam: spawn
// the actual `src/hooks/*.js` entrypoint with synthetic stdin JSON against a
// throwaway project and home, then assert only what Claude Code itself could
// observe — exit status, stdout, and the documents left on disk. Nothing
// reaches inside the process, because the fail-silent contract is precisely a
// statement about that outside view.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { personalStatePath, tracePath } from "../../src/io/paths.js";
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
 * @param {{env?: Record<string, string|undefined>, cwd?: string}} [options] -
 *   Extra environment variables, merged over the sandbox environment, and the
 *   directory the hook process starts in.
 */
export function runHook(sandbox, name, payload, options = {}) {
  return sandbox.runNode(hookEntrypoint(name), [], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: { ...sandbox.env, ...options.env },
    cwd: options.cwd,
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

/**
 * The personal state document as it stands on disk, read the way an outside
 * observer would: raw JSON, no module of the plugin involved.
 *
 * @param {object} sandbox - Sandbox from `createSandbox`.
 * @returns {object|undefined} The parsed document, or undefined when there is
 *   none (or it cannot be parsed, which is itself a fact worth asserting).
 */
export function readStateDocument(sandbox) {
  try {
    return JSON.parse(
      fs.readFileSync(
        personalStatePath(sandbox.projectDir, sandbox.homeDir),
        "utf8",
      ),
    );
  } catch {
    return undefined;
  }
}

/**
 * Plant a prior state document, bypassing the module under test — the only way
 * a hook run can start from a score a previous turn left behind.
 *
 * @param {object} sandbox - Sandbox from `createSandbox`.
 * @param {object|string} contents - A document, or raw text for corrupt cases.
 * @returns {string} Absolute path of the planted document.
 */
export function seedStateDocument(sandbox, contents) {
  const statePath = personalStatePath(sandbox.projectDir, sandbox.homeDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    typeof contents === "string" ? contents : JSON.stringify(contents),
    "utf8",
  );
  return statePath;
}

/** The one trace outcome a single hook invocation is contracted to write. */
export function soleTraceOutcome(sandbox) {
  const lines = readTrace(sandbox);
  return lines.length === 1
    ? lines[0].outcome
    : `<${lines.length} trace lines>`;
}
