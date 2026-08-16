// Real-git fixtures, for the one suite that cannot use a spawn seam.
//
// Everywhere else the infrastructure layer's git calls are injected, and that
// stays the rule. The manual-pause CLI is driven as a child process with its
// seam left at the default, though, so the only way to test what it measures is
// to give it something real to measure: a repository, a baseline commit, and
// then edits whose line counts the test already knows.
//
// The environment comes from the sandbox — `HOME` and `USERPROFILE` already
// redirected — so the contributor's global git configuration cannot reach these
// repositories, and every identity and newline setting a commit needs is written
// into the repository itself rather than assumed.
//
// Nothing here is quiet about failure. A missing git or a refused command fails
// the test that called it, loudly and with git's own message: a silently skipped
// integration suite would read as a passing one.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** The file the baseline commit contains, and the lines it starts with. */
export const BASELINE_FILE = "README.md";

export const BASELINE_LINES = Object.freeze(["alpha", "beta", "gamma"]);

/**
 * Run one git command, or fail the test.
 *
 * @param {string} cwd - Directory to run in.
 * @param {string[]} args - Git arguments, already split.
 * @param {Record<string, string|undefined>} [env] - Child environment; pass the
 *   sandbox's so the redirected home applies.
 * @returns {string} The command's stdout.
 */
export function git(cwd, args, env = process.env) {
  const run = spawnSync("git", args, {
    cwd,
    // A prompt would hang the suite rather than fail it; refuse to ask.
    env: { ...env, GIT_TERMINAL_PROMPT: "0" },
    encoding: "utf8",
    windowsHide: true,
  });
  if (run.error) {
    throw new Error(
      `These tests need real git on PATH. \`git ${args.join(" ")}\` in ${cwd} could not run: ${run.error.message}`,
    );
  }
  if (run.status !== 0) {
    throw new Error(
      `\`git ${args.join(" ")}\` failed in ${cwd} with status ${run.status}:\n${run.stderr}`,
    );
  }
  return run.stdout;
}

/**
 * Write a file as a known list of lines, creating parent directories. Always
 * LF-terminated, which is what the repositories below are configured to store.
 *
 * @param {string} filePath - Absolute file location.
 * @param {string[]} lines - The lines, without terminators.
 */
export function writeLines(filePath, lines) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

/** Stage everything under `dir` and commit it. */
export function commitAll(dir, message, env) {
  git(dir, ["add", "-A"], env);
  git(dir, ["commit", "-q", "-m", message], env);
}

/**
 * Create a repository with one baseline commit — the state every diff in these
 * tests is measured against.
 *
 * The four configuration writes are local on purpose. `commit.gpgsign` off and
 * an identity of our own keep a commit from depending on the contributor's
 * machine, and `core.autocrlf` off keeps a checkout on Windows from rewriting
 * the newlines the line counts below were computed from.
 *
 * @param {string} dir - Directory to initialize; created if absent.
 * @param {Record<string, string|undefined>} [env] - The sandbox environment.
 * @returns {string} The same directory, for chaining.
 */
export function initRepo(dir, env) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ["init", "-q", "-b", "main"], env);
  git(dir, ["config", "user.name", "Stoic Test"], env);
  git(dir, ["config", "user.email", "stoic@test.local"], env);
  git(dir, ["config", "core.autocrlf", "false"], env);
  git(dir, ["config", "commit.gpgsign", "false"], env);
  writeLines(path.join(dir, BASELINE_FILE), [...BASELINE_LINES]);
  commitAll(dir, "baseline", env);
  return dir;
}
