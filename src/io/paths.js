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
const GITIGNORE_FILE_NAME = ".gitignore";
const DECISIONS_DIR_NAME = "decisions";
const SESSIONS_DIR_NAME = "sessions";
const TRACE_FILE_NAME = "local-trace.jsonl";
const SHARED_TRACE_FILE_NAME = "shared-trace.jsonl";
const PENDING_PAUSE_FILE_NAME = "stoic-pending-pause.json";
const MANUAL_PAUSE_FILE_NAME = "stoic-manual-pause.json";

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
 * Resolve the project-local privacy file that keeps the decision bank out of
 * commits. It lives inside `.stoic/` rather than at the repository root, so the
 * plugin never edits a file the team owns.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @returns {string} Absolute path of `<project>/.stoic/.gitignore`.
 */
export function projectGitignorePath(projectDir) {
  return path.join(projectStoicDir(projectDir), GITIGNORE_FILE_NAME);
}

/**
 * Resolve the directory holding the decision bank's markdown entries.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @returns {string} Absolute path of `<project>/.stoic/decisions`.
 */
export function projectDecisionsDir(projectDir) {
  return path.join(projectStoicDir(projectDir), DECISIONS_DIR_NAME);
}

/**
 * Resolve one decision-bank file: one per day, per branch. Both name parts are
 * reduced to the slug alphabet before they may name a file, so a branch name
 * carrying separators can never escape the decisions directory.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {string} date - Local calendar date, `YYYY-MM-DD`.
 * @param {string} branchSlug - Filename-safe branch name.
 * @returns {string} Absolute path of `<project>/.stoic/decisions/<date>_<branch>.md`.
 */
export function decisionFilePath(projectDir, date, branchSlug) {
  return path.join(
    projectDecisionsDir(projectDir),
    `${safeSegment(date)}_${safeSegment(branchSlug)}.md`,
  );
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
 * Resolve the pending-pause document — the single hand-off the Stop hook
 * writes and the pause skill consumes. It lives beside the personal state
 * rather than in the project, because a pending reflection is personal and
 * must never reach a commit.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {string} [homeDir] - Home directory override for tests.
 * @returns {string} Absolute path of the project's `stoic-pending-pause.json`.
 */
export function pendingPausePath(projectDir, homeDir = os.homedir()) {
  return path.join(
    personalStateDir(projectDir, homeDir),
    PENDING_PAUSE_FILE_NAME,
  );
}

/**
 * Resolve the manual-pause document — the hand-off a developer's own request
 * writes, read by the same pause conversation.
 *
 * It is a SECOND file rather than the pending one because the pending path is
 * keyed on the project, not the session: every session open in a repository
 * shares it. A manual pause written there would silently replace an automatic
 * pause the developer had interrupted — an atomic write protects against a
 * half-written file, not against a complete one taking the place of another.
 * Two files remove the ambiguity entirely, because every consumer is handed an
 * explicit path rather than having to guess which pause it found.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {string} [homeDir] - Home directory override for tests.
 * @returns {string} Absolute path of the project's `stoic-manual-pause.json`.
 */
export function manualPausePath(projectDir, homeDir = os.homedir()) {
  return path.join(
    personalStateDir(projectDir, homeDir),
    MANUAL_PAUSE_FILE_NAME,
  );
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
 * Resolve the local trace sink: the bounded per-project trace (one outcome
 * line per hook invocation).
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {string} [homeDir] - Home directory override for tests.
 * @returns {string} Absolute path of the project's `local-trace.jsonl`.
 */
export function tracePath(projectDir, homeDir = os.homedir()) {
  return path.join(personalStateDir(projectDir, homeDir), TRACE_FILE_NAME);
}

/**
 * Resolve the shared trace sink. It is keyed on no project: it sits above the
 * per-project slug directories, so a hook that could not name its project
 * still has one place to record that outcome.
 *
 * @param {string} [homeDir] - Home directory override for tests.
 * @returns {string} Absolute path of `~/.claude/stoic-stack/shared-trace.jsonl`.
 */
export function sharedTracePath(homeDir = os.homedir()) {
  return path.join(homeDir, ...STATE_ROOT_SEGMENTS, SHARED_TRACE_FILE_NAME);
}
