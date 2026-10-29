#!/usr/bin/env node
// PostToolUse (Edit | MultiEdit | Write) — record what just changed on disk.
//
// One edit, one event: which file, how many lines moved, under which
// permission mode, and whether a sub-agent made it. Delegation is attributed
// per event from `agent_id` alone — there is no live counter and no
// suppression window, because autopilot is a property of the user's input, not
// of the machine's output, and a planned fan-out is normal engineering that
// the score discounts rather than punishes.
//
// Two edits are dropped outright, and both are correctness conditions rather
// than optimizations: anything under `.stoic/` (the plugin writing its own
// bookkeeping is not the developer working) and anything outside the Project
// Root (another repository's file is not this turn's evidence).
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §`Hook inputs` (PostToolUse row) and §`Session event log` (edit event).
import path from "node:path";

import { extractDiffStats } from "../core/diffstats.js";
import { isNonEmptyString } from "../core/predicates.js";
import { agentTypeOf, permissionModeOf, runCaptureHook } from "./capture.js";

/** The plugin's own directory inside the project — never observed. */
const OWN_STATE_DIR = ".stoic";

/**
 * Whether a path segment names the plugin's own directory. Matching follows
 * the filesystem rather than the string: on Windows `.STOIC` and `.stoic` are
 * one directory, so a case-sensitive test there would observe the plugin's own
 * bookkeeping through a differently-cased path. On POSIX they are genuinely
 * two directories and only the exact name is ours.
 */
const isOwnStateSegment = (segment) =>
  process.platform === "win32"
    ? segment.toLowerCase() === OWN_STATE_DIR
    : segment === OWN_STATE_DIR;

/**
 * Place an edited file inside the project, or say why it does not belong to
 * this turn. The stored form is project-relative with forward slashes on every
 * platform: it is compared against configured critical paths and shown back to
 * the developer, so a Windows session and a POSIX one must produce the same
 * text for the same file.
 *
 * @param {unknown} filePath - `tool_input.file_path` from the payload.
 * @param {string} projectDir - The resolved Project Root.
 * @returns {{file: string}|{reason: string}} The stored path, or a drop reason.
 */
function locateEdit(filePath, projectDir) {
  if (!isNonEmptyString(filePath)) {
    return { reason: "no_file_path" };
  }
  const relative = path.relative(
    path.resolve(projectDir),
    path.resolve(projectDir, filePath),
  );
  const segments = relative.split(path.sep);
  // `..` as the first segment means it climbed out; an absolute result means it
  // never shared a root at all (a second Windows drive), and an empty relative
  // path means the "file" is the project directory itself.
  if (relative === "" || path.isAbsolute(relative) || segments[0] === "..") {
    return { reason: "outside_project" };
  }
  // Any segment, not just the first: a session whose cwd sits above a
  // sub-project would otherwise observe that sub-project's `.stoic/`.
  if (segments.some(isOwnStateSegment)) {
    return { reason: "own_state" };
  }
  return { file: segments.join("/") };
}

runCaptureHook("PostToolUse", (payload, projectDir) => {
  const located = locateEdit(payload.tool_input?.file_path, projectDir);
  if (!located.file) {
    return { outcome: "dropped", reason: located.reason };
  }

  const { linesAdded, linesRemoved } = extractDiffStats(payload.tool_response);
  // `agent_id` is what attributes an edit, so an event naming a type without an
  // id is the main conversation's own work and is scored as such.
  const delegated = isNonEmptyString(payload.agent_id);
  return {
    event: {
      type: "edit",
      ts: Date.now(),
      file: located.file,
      lines_added: linesAdded,
      lines_removed: linesRemoved,
      permission_mode: permissionModeOf(payload),
      delegated,
      agent_type: delegated ? agentTypeOf(payload) : null,
    },
  };
});
