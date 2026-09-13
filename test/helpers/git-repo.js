// Helpers that build real git repositories for tests.
//
// Use them when the test needs git's actual answer, not a substitute: code run
// as a child process cannot be handed a fake git, and code whose job is to ask
// git a question proves nothing against one. A unit test of a module that
// accepts a `spawn` option keeps using that option instead.
//
// Every repository is configured locally — identity, signing off, newlines kept
// as written — so a commit never depends on the contributor's global git
// settings. A test that also redirects the home directory passes its sandbox
// environment through the `env` parameter.
//
// Failure is loud. A missing git or a refused command throws with git's own
// message, because a silently skipped suite would read as a passing one.
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
    // Add GIT_TERMINAL_PROMPT=0 so that git never asks for input; otherwise, the suite could hang if git asks for something like credentials.
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

/**
 * Create a directory inside a working tree — the place a session has wandered
 * into, below the root it should still be known by.
 *
 * @param {string} dir - An existing directory, normally a repository root.
 * @param {string} name - The subdirectory's name.
 * @returns {string} The subdirectory's absolute path.
 */
export function addSubdirectory(dir, name) {
  const subdirectory = path.join(dir, name);
  fs.mkdirSync(subdirectory);
  return subdirectory;
}

/**
 * Check out a second working tree of `repoDir` at `worktreeDir`. Detached, so
 * no branch name has to be invented; the tree still shares the repository's
 * git directory, which is what makes it a worktree rather than a clone.
 *
 * @param {string} repoDir - A repository with at least one commit.
 * @param {string} worktreeDir - Where the new tree goes; must not exist yet.
 * @param {Record<string, string|undefined>} [env] - The sandbox environment.
 * @returns {string} The worktree directory, for chaining.
 */
export function addWorktree(repoDir, worktreeDir, env) {
  git(repoDir, ["worktree", "add", "-q", "--detach", worktreeDir], env);
  return worktreeDir;
}

/**
 * Add `sourceDir` to `repoDir` as a submodule named `name`, and commit it.
 *
 * Git refuses to clone a submodule over the local file transport unless told
 * otherwise, and the permission is passed for this one command rather than
 * written to any configuration.
 *
 * @param {string} repoDir - The superproject, with at least one commit.
 * @param {string} sourceDir - A repository with at least one commit to clone.
 * @param {string} name - The submodule's path inside the superproject.
 * @param {Record<string, string|undefined>} [env] - The sandbox environment.
 * @returns {string} The submodule's absolute directory.
 */
export function addSubmodule(repoDir, sourceDir, name, env) {
  git(
    repoDir,
    [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "-q",
      sourceDir,
      name,
    ],
    env,
  );
  commitAll(repoDir, `add submodule ${name}`, env);
  return path.join(repoDir, name);
}
