// Path resolution for Stoic Stack's two storage locations:
//
// - team-shareable project configuration:  <project>/.stoic/
// - per-project personal engine state:     ~/.claude/stoic-stack/<project-slug>/
//
// Resolution is pure — nothing here touches the filesystem, so inspecting
// paths can never create a directory or file. Directories come into existence
// only through explicit writes (see json-file.js).
import os from "node:os";
import path from "node:path";

const PROJECT_DIR_NAME = ".stoic";
const CONFIG_FILE_NAME = "config.json";
const STATE_FILE_NAME = "state.json";
const STATE_ROOT_SEGMENTS = [".claude", "stoic-stack"];
const SESSIONS_DIR_NAME = "sessions";
const TRACE_FILE_NAME = "trace.jsonl";

/**
 * Reduce a value to the plugin's one filesystem-safe alphabet: every
 * character outside `[A-Za-z0-9]` becomes a dash. Both the project slug and
 * session-log file names go through this single definition so the two
 * alphabets cannot drift apart.
 *
 * @param {unknown} value - Value to reduce.
 * @returns {string} Text safe to use as a single path segment.
 */
function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Derive the stable, filesystem-safe identifier of a project used to keep
 * personal state for different projects apart under the Claude home,
 * mirroring Claude Code's own project-slug convention.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @returns {string} Slug safe to use as a single directory name.
 */
export function projectSlug(projectDir) {
  return safeSegment(path.resolve(projectDir));
}

/**
 * Resolve the team-shareable Stoic Stack directory inside the project.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @returns {string} Absolute path of `<project>/.stoic`.
 */
export function projectStoicDir(projectDir) {
  return path.join(path.resolve(projectDir), PROJECT_DIR_NAME);
}

/**
 * Resolve the project configuration document.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @returns {string} Absolute path of `<project>/.stoic/config.json`.
 */
export function projectConfigPath(projectDir) {
  return path.join(projectStoicDir(projectDir), CONFIG_FILE_NAME);
}

/**
 * Resolve the per-project personal-state directory under the user's Claude
 * home — always outside the repository.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {string} [homeDir] - Home directory override for tests; defaults to
 *   `os.homedir()`, which honors `HOME` (POSIX) and `USERPROFILE` (Windows).
 * @returns {string} Absolute path of `~/.claude/stoic-stack/<project-slug>`.
 */
export function personalStateDir(projectDir, homeDir = os.homedir()) {
  return path.join(homeDir, ...STATE_ROOT_SEGMENTS, projectSlug(projectDir));
}

/**
 * Resolve the personal engine-state document.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {string} [homeDir] - Home directory override for tests.
 * @returns {string} Absolute path of the project's `state.json`.
 */
export function personalStatePath(projectDir, homeDir = os.homedir()) {
  return path.join(personalStateDir(projectDir, homeDir), STATE_FILE_NAME);
}

/**
 * Resolve the directory holding the per-session event logs.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {string} [homeDir] - Home directory override for tests.
 * @returns {string} Absolute path of the project's `sessions` directory.
 */
export function sessionsDir(projectDir, homeDir = os.homedir()) {
  return path.join(personalStateDir(projectDir, homeDir), SESSIONS_DIR_NAME);
}

/**
 * Resolve a per-session event log. The session id arrives on hook stdin from
 * outside the plugin, so it is reduced to the slug alphabet before it may
 * name a file — a hostile or malformed id can never escape the sessions
 * directory.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {string} sessionId - Session identifier from the hook payload.
 * @param {string} [homeDir] - Home directory override for tests.
 * @returns {string} Absolute path of the session's `<session_id>.jsonl`.
 */
export function sessionLogPath(projectDir, sessionId, homeDir = os.homedir()) {
  return path.join(
    sessionsDir(projectDir, homeDir),
    `${safeSegment(sessionId)}.jsonl`,
  );
}

/**
 * Resolve the bounded trace sink (one outcome line per hook invocation).
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {string} [homeDir] - Home directory override for tests.
 * @returns {string} Absolute path of the project's `trace.jsonl`.
 */
export function tracePath(projectDir, homeDir = os.homedir()) {
  return path.join(personalStateDir(projectDir, homeDir), TRACE_FILE_NAME);
}
