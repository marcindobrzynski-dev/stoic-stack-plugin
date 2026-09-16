// Project-root resolution — the one directory a project is known by, whatever
// subdirectory the work happens in.
//
// Configuration and personal state are both keyed on a project directory, and
// the directory an entrypoint is handed moves: a session that starts at the
// root can report a subfolder a few turns later, and `CLAUDE_PROJECT_DIR` can
// name a subfolder too. Taking that directory as the identity gave one project
// several. This module finds the root instead of trusting where work started.
//
// Five gates, first valid answer wins. Only git and the nearest
// `.stoic/config.json` discover a boundary; the environment, the payload's
// `cwd` and the process directory are fallbacks. Git outranks a subproject's
// own configuration, and git alone decides nested repositories, submodules and
// worktrees — there is no logic of our own for them.
//
// It returns an absolute directory or null, and never throws or prints: null is
// the only failure signal, and what to do with it belongs to the caller. It
// derives no paths from the root; that stays in `paths.js`. There are no test
// seams: git, the environment and the home directory are read from their real
// sources, because the whole value of the git gate is git's real answer.
//
// Contract: thoughts/shared/.project/architecture.md §State locations, and
// thoughts/shared/.project/glossary.md §Project Root.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isNonEmptyString } from "../core/predicates.js";

/** Wall-clock budget for asking git where the working tree begins. */
export const GIT_TOPLEVEL_TIMEOUT_MS = 2000;

/** The one question gate 1 asks git, frozen so no caller can reshape it. */
const GIT_TOPLEVEL_ARGS = Object.freeze(["rev-parse", "--show-toplevel"]);

/** The file whose presence marks a configured project, relative to its root. */
const CONFIG_MARKER = path.join(".stoic", "config.json");

/**
 * Error codes that mean "no configuration here", as opposed to a directory the
 * walk could not read. `ENOTDIR` is a `.stoic` that is a file, not a folder.
 */
const ABSENT_CODES = Object.freeze(["ENOENT", "ENOTDIR"]);

/**
 * The single validity predicate every gate shares.
 *
 * @param {unknown} candidate - A directory some gate proposes.
 * @returns {string|null} The normalized absolute directory, or null.
 */
function validDirectory(candidate) {
  if (!isNonEmptyString(candidate) || !path.isAbsolute(candidate)) {
    return null;
  }
  const resolved = path.resolve(candidate);
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Whether two normalized directories are the same one. Windows paths differ
 * only in letter case for the same directory, so there the comparison folds it.
 */
function sameDirectory(left, right) {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

/**
 * Gate 1: the root of the working tree that contains `startDir`. An invalid
 * start yields nothing rather than letting git run in the process directory.
 *
 * @param {string} startDir - Directory git runs in.
 * @returns {string|null} The working-tree root, or null.
 */
function gitRoot(startDir) {
  const cwd = validDirectory(startDir);
  if (cwd === null) {
    return null;
  }
  const result = spawnSync("git", GIT_TOPLEVEL_ARGS, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TOPLEVEL_TIMEOUT_MS,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  return validDirectory(result.stdout.replace(/\r?\n$/, ""));
}

/**
 * Gate 2: the nearest directory at or above `startDir` holding the
 * configuration file. The walk stops before the home directory and at the
 * filesystem root; an unreadable directory ends it.
 *
 * @param {string} startDir - Directory the walk starts in.
 * @returns {string|null} The configured directory, or null.
 */
function configRoot(startDir) {
  const home = path.resolve(os.homedir());
  let dir = validDirectory(startDir);

  while (dir !== null && !sameDirectory(dir, home)) {
    try {
      if (fs.statSync(path.join(dir, CONFIG_MARKER)).isFile()) {
        return dir;
      }
    } catch (error) {
      if (!ABSENT_CODES.includes(error?.code)) {
        return null;
      }
    }
    const parent = path.dirname(dir);
    dir = parent === dir ? null : parent;
  }
  return null;
}

/**
 * The Project Root for a start directory. Gates in order, the first valid
 * directory wins:
 *
 * 1. the root of the git working tree containing `startDir`;
 * 2. the nearest directory at or above `startDir` holding
 *    `.stoic/config.json`, below the home directory;
 * 3. `CLAUDE_PROJECT_DIR`;
 * 4. `payloadCwd`;
 * 5. the process directory.
 *
 * @param {string} startDir - The caller's directory, normally `process.cwd()`.
 * @param {string} [payloadCwd] - A hook payload's `cwd`; CLIs omit it.
 * @returns {string|null} An absolute, normalized directory, or null when every
 *   gate is empty.
 */
export function resolveProjectRoot(startDir, payloadCwd) {
  try {
    return (
      gitRoot(startDir) ??
      configRoot(startDir) ??
      validDirectory(process.env.CLAUDE_PROJECT_DIR) ??
      validDirectory(payloadCwd) ??
      validDirectory(process.cwd())
    );
  } catch {
    return null;
  }
}
