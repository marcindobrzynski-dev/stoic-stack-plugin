// The privacy guard inside `.stoic/`: the `.gitignore` that keeps the decision
// bank and the local credentials file (`.stoic/.env`) out of commits.
//
// Two writers ensure it, each for what it is about to protect: setup ensures
// every line as soon as it configures a project, before any key could be put
// in `.stoic/.env`; the decision bank ensures its own line before every write,
// so a project that never ran setup — or a developer who deleted the file —
// still cannot commit a recorded reflection.
//
// The file lives inside `.stoic/` rather than at the repository root, so the
// plugin never edits a file the team owns.
import fs from "node:fs";

import { projectGitignorePath, projectStoicDir } from "./paths.js";

/** Keeps recorded reflections out of commits. */
export const DECISIONS_IGNORE_LINE = "decisions/";

/** Keeps the local credentials file out of commits. */
export const ENV_IGNORE_LINE = ".env";

/** Every line a configured project's `.stoic/.gitignore` carries. */
export const STOIC_IGNORE_LINES = Object.freeze([
  DECISIONS_IGNORE_LINE,
  ENV_IGNORE_LINE,
]);

/** The comment a freshly written `.stoic/.gitignore` opens with. */
const STOIC_IGNORE_HEADER = "# Ignored files and directories by Stoic Stack";

/**
 * Ensure `.stoic/.gitignore` carries the given lines. Idempotent in both
 * directions: a missing file is created, a file a user edited keeps its edits
 * and gains back only the lines it lost, and a file that already carries every
 * line is left untouched rather than accumulating duplicates.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {readonly string[]} [lines] - The lines to guarantee; defaults to
 *   {@link STOIC_IGNORE_LINES}.
 * @returns {string} Absolute path of the enforced `.stoic/.gitignore`.
 * @throws {Error} When the file cannot be written — the caller decides whether
 *   to go on without the guard.
 */
export function ensureStoicIgnored(projectDir, lines = STOIC_IGNORE_LINES) {
  const filePath = projectGitignorePath(projectDir);
  fs.mkdirSync(projectStoicDir(projectDir), { recursive: true });

  let existing;
  try {
    existing = fs.readFileSync(filePath, "utf8");
  } catch {
    // Missing or unreadable both mean "no guard on disk"; write a fresh one.
    existing = null;
  }

  if (existing === null) {
    const fresh = [STOIC_IGNORE_HEADER, ...lines].join("\n");
    fs.writeFileSync(filePath, `${fresh}\n`, "utf8");
    return filePath;
  }

  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()));
  const missing = lines.filter((line) => !present.has(line));
  if (missing.length === 0) {
    return filePath;
  }

  const separator =
    existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(filePath, `${separator}${missing.join("\n")}\n`, "utf8");
  return filePath;
}
