// Shared harness for driving the real manual-pause writer as a child process,
// the twin of ../helpers/record-cli.js. The suite verifies the CLI through one
// seam only: run `src/cli/reflect.js` against a throwaway project and home, and
// assert nothing but what a caller can observe — the single stdout JSON result,
// the exit status, stderr, and the documents left on disk.
//
// Both pause paths are resolved here from the real path module rather than
// spelled out, so a test that asserts the two documents never collide is
// asserting it about the paths the plugin actually uses.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { manualPausePath, pendingPausePath } from "../../src/io/paths.js";

export const REFLECT_CLI = fileURLToPath(
  new URL("../../src/cli/reflect.js", import.meta.url),
);

/** Where the CLI under test must write, for this sandbox's project. */
export const manualPauseFile = (sandbox) =>
  manualPausePath(sandbox.projectDir, sandbox.homeDir);

/** Where an automatic pause sits — the neighbour that must survive untouched. */
export const pendingPauseFile = (sandbox) =>
  pendingPausePath(sandbox.projectDir, sandbox.homeDir);

/**
 * Run the real CLI and parse the single JSON result it contracts to emit.
 *
 * @param {object} sandbox - A sandbox from ./sandbox.js.
 * @param {string[]} [args] - Process arguments.
 * @param {{env?: Record<string, string|undefined>, cwd?: string}} [options] -
 *   Passed through to the sandbox runner: `env` replaces the environment
 *   wholesale, and `cwd` is the directory the CLI process starts in.
 */
export function runReflect(sandbox, args = [], options = {}) {
  const run = sandbox.runNode(REFLECT_CLI, args, {
    env: options.env,
    cwd: options.cwd,
  });
  let result;
  try {
    result = JSON.parse(run.stdout);
  } catch {
    assert.fail(
      `reflect.js must always print one JSON result to stdout. Got:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, result };
}

export const manualPauseExists = (sandbox) =>
  fs.existsSync(manualPauseFile(sandbox));

/** The manual document as the skill would read it. */
export const readManualPause = (sandbox) =>
  JSON.parse(fs.readFileSync(manualPauseFile(sandbox), "utf8"));

/** Raw bytes of the automatic pause, for the collision guarantee. */
export const readPendingPauseText = (sandbox) =>
  fs.readFileSync(pendingPauseFile(sandbox), "utf8");

/** Plant an automatic pending pause beside the manual one, bypassing the CLI. */
export function writePendingPause(sandbox, contents) {
  const filePath = pendingPauseFile(sandbox);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    typeof contents === "string" ? contents : JSON.stringify(contents, null, 2),
    "utf8",
  );
  return filePath;
}
