// A `claude` executable the hook child can actually resolve — and a PATH that
// contains nothing else.
//
// The fire path runs the real `classify` → `runClaude` → spawn chain, so
// the suite cannot substitute a runner: it has to make the name the runner's
// cascade looks up resolve to the stub CLI. That is what this helper does, in
// two halves that are equally load-bearing.
//
// The shim: a `claude.cmd` for the Windows cascade (its third strategy runs
// through a shell, which is what resolves a `.cmd`) and an executable POSIX
// `claude` beside it, so one sandbox serves both platforms. Both re-exec the
// stub through THIS process's own Node binary, by absolute path, so the shim
// never needs `node` on the PATH it is about to be given.
//
// The PATH: rebuilt from nothing but the shim directory and the minimum the
// operating system needs to spawn a shell at all. A real Claude CLI is
// installed on developer machines, and inheriting the ambient PATH would let a
// test quietly reach it — a network call, a bill, and a non-deterministic
// verdict. Every PATH-ish key is dropped before the controlled one is set,
// because Windows environment names are case-insensitive and a surviving
// `Path` would shadow the `PATH` written next to it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Absolute path of the stub the shim re-execs. */
const STUB_CLI = fileURLToPath(
  new URL("../fixtures/stub-claude-cli.js", import.meta.url),
);

/** The shim directory's name inside the sandbox home. */
const SHIM_DIR_NAME = "shim-bin";

/**
 * The system directories a spawned shell needs, and nothing more. On Windows
 * `shell: true` runs through `cmd.exe`, which lives under the system root; a
 * POSIX shell is at an absolute path already, so the list is only a courtesy
 * there.
 *
 * @returns {string[]} Absolute directories to append after the shim.
 */
function systemPathEntries() {
  if (process.platform === "win32") {
    const root = process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows";
    return [path.join(root, "System32"), root];
  }
  return ["/usr/bin", "/bin"];
}

/**
 * Install a fake `claude` in the sandbox that always answers with one stub
 * scenario.
 *
 * @param {object} sandbox - Sandbox from `createSandbox`.
 * @param {string} scenario - A `stub-claude-cli.js` scenario name.
 * @returns {string} Absolute path of the shim directory.
 */
export function installClaudeShim(sandbox, scenario) {
  const shimDir = path.join(sandbox.homeDir, SHIM_DIR_NAME);
  fs.mkdirSync(shimDir, { recursive: true });

  fs.writeFileSync(
    path.join(shimDir, "claude.cmd"),
    `@"${process.execPath}" "${STUB_CLI}" ${scenario} %*${os.EOL}`,
    "utf8",
  );

  const posixShim = path.join(shimDir, "claude");
  fs.writeFileSync(
    posixShim,
    `#!/bin/sh\nexec "${process.execPath}" "${STUB_CLI}" ${scenario} "$@"\n`,
    "utf8",
  );
  fs.chmodSync(posixShim, 0o755);

  return shimDir;
}

/**
 * The environment a hook child runs in when the stub must be the only Claude
 * CLI in existence: the sandbox environment with every PATH-ish key replaced
 * by the shim directory plus the minimal system directories.
 *
 * @param {object} sandbox - Sandbox from `createSandbox`.
 * @param {string} scenario - A `stub-claude-cli.js` scenario name.
 * @returns {Record<string, string|undefined>} A complete child environment.
 */
export function claudeShimEnv(sandbox, scenario) {
  const shimDir = installClaudeShim(sandbox, scenario);
  const env = {};
  for (const [name, value] of Object.entries(sandbox.env)) {
    if (name.toLowerCase() !== "path") {
      env[name] = value;
    }
  }
  env.PATH = [shimDir, ...systemPathEntries()].join(path.delimiter);
  return env;
}
