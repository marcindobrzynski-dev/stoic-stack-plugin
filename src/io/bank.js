// The Decision Bank — the durable, private record of what the developer
// decided when a Stoic Pause was answered.
//
// One markdown file per day per branch under `<project>/.stoic/decisions/`,
// appended in chronological order. Markdown, not JSON, because the bank is
// meant to be read by a human weeks later; the engine only ever aggregates it
// by heading. Free text therefore lives in `###` sections and never in a list
// field, where the first newline of a real reflection would break the format.
//
// Privacy is unconditional, not configurable: every write first ensures
// `.stoic/.gitignore` carries the `decisions/` line, so a developer who deletes
// or hand-edits that file gets the guard back on the next recorded Decision
// rather than discovering their reflections in a diff.
//
// The module's whole world is `<project>/.stoic/`. It never reads or writes
// engine state, scores, or mutes, and it interprets no outcome — `record.js`
// owns those; this file only renders and persists what it is handed.
//
// Testability is programmatic, as everywhere else in `src/io`: `options.spawn`
// substitutes the git invocation and `options.now` the clock, both defaulting
// to the real thing. No environment variable can reach either.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// (§ "Decision bank entry").
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { writeTextFileAtomic } from "./json-file.js";
import {
  decisionFilePath,
  projectDecisionsDir,
  projectGitignorePath,
  projectStoicDir,
} from "./paths.js";
import { isNonEmptyString, isPlainObject } from "../core/predicates.js";

/** The single line that keeps recorded reflections out of commits. */
export const DECISIONS_IGNORE_LINE = "decisions/";

/** Branch name recorded when HEAD points at a commit rather than a branch. */
export const DETACHED_BRANCH_NAME = "detached";

/** Branch name recorded when the project is not a git repository at all. */
export const NO_GIT_BRANCH_NAME = "no-branch";

/** Characters of branch name a file name may carry; the rest is dropped. */
export const BRANCH_SLUG_LIMIT = 60;

/** Wall-clock budget for the branch lookup — a hung git must not hold a write. */
export const GIT_TIMEOUT_MS = 5000;

/** The two outcomes that reach the bank; `skip` and `defer` leave no entry. */
export const BANK_OUTCOMES = Object.freeze(["keep", "correct"]);

/** Heading of a recorded entry: local `HH:MM` plus the resolved top category. */
const HEADING_PATTERN = /^##\s+\d{1,2}:\d{2}\s+—\s+(.+?)\s*$/;

/** The one list field the aggregate reader consumes. */
const OUTCOME_PATTERN = /^-\s*outcome:\s*(keep|correct)\s*$/;

/** Placeholder for a field the recorded Decision simply did not carry. */
const NOTHING = "none";

/** Run one git query in the project, or return null when it cannot be answered. */
function gitOutput(spawn, cwd, args) {
  let result;
  try {
    result = spawn("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
  if (!isPlainObject(result) || result.error || result.status !== 0) {
    return null;
  }
  const text = typeof result.stdout === "string" ? result.stdout.trim() : "";
  return text.length > 0 ? text : null;
}

/**
 * Resolve the branch a Decision belongs to, as the developer knows it.
 *
 * Two questions, in order: `rev-parse` answers for an ordinary checkout and
 * says `HEAD` when the checkout is detached; `symbolic-ref` answers the one
 * case `rev-parse` cannot — a repository whose first commit does not exist yet,
 * where a branch is nevertheless already chosen.
 *
 * The returned name is raw and unsanitized, because it is what the frontmatter
 * records; {@link branchSlug} is what a file name gets.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {object} [options] - Call options.
 * @param {Function} [options.spawn] - Seam with the `spawnSync` signature;
 *   defaults to the real one.
 * @returns {string} The branch name, {@link DETACHED_BRANCH_NAME}, or
 *   {@link NO_GIT_BRANCH_NAME}. Never throws: a bank entry is worth more than
 *   the branch label on it.
 */
export function resolveBranch(projectDir, options) {
  try {
    const settings = isPlainObject(options) ? options : {};
    const spawn =
      typeof settings.spawn === "function" ? settings.spawn : spawnSync;
    const cwd = path.resolve(projectDir);

    const head = gitOutput(spawn, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (head === "HEAD") {
      return DETACHED_BRANCH_NAME;
    }
    if (head) {
      return head;
    }
    return (
      gitOutput(spawn, cwd, ["symbolic-ref", "--short", "HEAD"]) ??
      NO_GIT_BRANCH_NAME
    );
  } catch {
    return NO_GIT_BRANCH_NAME;
  }
}

/**
 * Reduce a branch name to the part of a file name it may become: the plugin's
 * filename alphabet, no repeated or edge dashes, bounded in length. A name that
 * survives none of that is indistinguishable from having no branch at all.
 *
 * @param {unknown} branch - A raw branch name, or anything else.
 * @returns {string} A filename-safe slug; {@link NO_GIT_BRANCH_NAME} when empty.
 */
export function branchSlug(branch) {
  const slug = String(isNonEmptyString(branch) ? branch : "")
    .replace(/[^A-Za-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, BRANCH_SLUG_LIMIT)
    .replace(/-$/, "");
  return slug.length > 0 ? slug : NO_GIT_BRANCH_NAME;
}

/** Two-digit local calendar date and clock, the way both the name and the heading want them. */
function localStamp(now) {
  const pad = (value) => String(value).padStart(2, "0");
  return {
    date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  };
}

/**
 * Ensure the decision bank is ignored by git before anything is written into
 * it. Idempotent in both directions: a missing file is created, a file a user
 * edited keeps its edits and gains the line back, and a file that already
 * carries the line is left untouched rather than accumulating duplicates.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @returns {string} Absolute path of the enforced `.stoic/.gitignore`.
 * @throws {Error} When the file cannot be written — the caller decides whether
 *   a Decision that cannot be kept private is still worth recording.
 */
export function ensureDecisionsIgnored(projectDir) {
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
    fs.writeFileSync(filePath, `${DECISIONS_IGNORE_LINE}\n`, "utf8");
    return filePath;
  }
  if (
    existing
      .split(/\r?\n/)
      .some((line) => line.trim() === DECISIONS_IGNORE_LINE)
  ) {
    return filePath;
  }

  const separator =
    existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  fs.appendFileSync(filePath, `${separator}${DECISIONS_IGNORE_LINE}\n`, "utf8");
  return filePath;
}

/** A free-text block, with a stable placeholder for the empty case. */
function freeText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > 0 ? text : `${NOTHING} recorded`;
}

/** The touched files as one single-line engine fact. */
function fileList(files) {
  if (!Array.isArray(files)) {
    return NOTHING;
  }
  const named = files.filter(isNonEmptyString);
  return named.length > 0 ? named.join(", ") : NOTHING;
}

/** The asked questions as a numbered list, or the empty placeholder. */
function questionLines(questions) {
  const asked = Array.isArray(questions)
    ? questions.filter(isNonEmptyString)
    : [];
  return asked.length > 0
    ? asked.map((question, index) => `${index + 1}. ${question}`)
    : [`${NOTHING} recorded`];
}

/**
 * Render one Decision as the frozen entry section, leading blank line included
 * so sections separate themselves however many already sit in the file.
 *
 * `### Correction` appears only on a `correct` outcome and `### Follow-up` only
 * when a follow-up prompt was actually approved, so a `keep` entry ends after
 * its answer.
 *
 * @param {object} entry - The Decision, already validated by the caller.
 * @param {string} time - Local `HH:MM` of the recording.
 * @returns {string} The section text, newline-terminated.
 */
function renderEntry(entry, time) {
  const category = isNonEmptyString(entry.category) ? entry.category : "manual";
  const lines = [
    "",
    `## ${time} — ${category}`,
    "",
    `- outcome: ${entry.outcome}`,
  ];

  if (isNonEmptyString(entry.subcategory)) {
    lines.push(`- subcategory: ${entry.subcategory}`);
  }
  lines.push(`- files: ${fileList(entry.files)}`);
  lines.push(
    `- trigger: ${isNonEmptyString(entry.trigger) ? entry.trigger : "manual"}`,
  );
  lines.push("", "### Questions", "", ...questionLines(entry.questions));
  lines.push("", "### Answer", "", freeText(entry.answer));

  if (entry.outcome === "correct") {
    lines.push("", "### Correction", "", freeText(entry.correction));
    if (isNonEmptyString(entry.followup_prompt)) {
      lines.push("", "### Follow-up", "", entry.followup_prompt.trim());
    }
  }

  return `${lines.join("\n")}\n`;
}

/**
 * @typedef {{path: string, date: string, time: string, branch: string,
 *   category: string}} BankWriteResult
 */

/**
 * Append one recorded Decision to today's bank file for the current branch,
 * creating the file with its frontmatter when this is the day's first entry.
 *
 * Privacy comes first: the `.gitignore` guard is enforced before any decision
 * text reaches disk, so a failure to protect the bank prevents the write rather
 * than following it. The file is then rewritten whole through a temporary file
 * and a rename, because an interrupted plain append would leave a half-written
 * reflection behind.
 *
 * The entry is rendered exactly as handed over — no scoring, no outcome
 * interpretation, no category inference beyond the contract's `manual` fallback
 * for a pause that carried no classification.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {object} entry - The Decision to record.
 * @param {"keep"|"correct"} entry.outcome - The recorded outcome.
 * @param {string} [entry.category] - Resolved top-level category; absent means
 *   a manual reflection, recorded as `manual`.
 * @param {string} [entry.subcategory] - Classified subcategory, when there was one.
 * @param {string[]} [entry.files] - Files the turn touched.
 * @param {string} [entry.trigger] - `score`, `critical_path`, or `manual`.
 * @param {string[]} [entry.questions] - The questions actually asked.
 * @param {string} [entry.answer] - The developer's reflection, free text.
 * @param {string} [entry.correction] - The revised decision; `correct` only.
 * @param {string} [entry.followup_prompt] - An approved follow-up; `correct` only.
 * @param {object} [options] - Call options.
 * @param {Date} [options.now] - Clock seam; defaults to the current moment.
 * @param {Function} [options.spawn] - Git seam, as in {@link resolveBranch}.
 * @returns {BankWriteResult} Where the entry landed, and under which branch.
 * @throws {TypeError} When the entry is not an object or carries an outcome the
 *   bank does not record.
 * @throws {Error} When the bank or its privacy guard cannot be written. Failing
 *   loudly is deliberate: the caller (`record.js`) owns fail-silence, and a
 *   swallowed failure here would silently lose a reflection the developer just
 *   wrote.
 */
export function writeDecisionEntry(projectDir, entry, options) {
  if (!isPlainObject(entry) || !BANK_OUTCOMES.includes(entry.outcome)) {
    throw new TypeError(
      `decision bank entries need an outcome of ${BANK_OUTCOMES.join(" or ")}`,
    );
  }

  const settings = isPlainObject(options) ? options : {};
  const now =
    settings.now instanceof Date && Number.isFinite(settings.now.getTime())
      ? settings.now
      : new Date();

  ensureDecisionsIgnored(projectDir);

  const branch = resolveBranch(projectDir, settings);
  const { date, time } = localStamp(now);
  const filePath = decisionFilePath(projectDir, date, branchSlug(branch));

  let existing;
  try {
    existing = fs.readFileSync(filePath, "utf8");
  } catch {
    // No file yet (or an unreadable one): this write starts the day's bank.
    existing = "";
  }
  let head;
  if (existing.length === 0) {
    head = `---\ndate: ${date}\nbranch: ${branch}\n---\n`;
  } else if (existing.endsWith("\n")) {
    head = existing;
  } else {
    head = `${existing}\n`;
  }

  writeTextFileAtomic(filePath, `${head}${renderEntry(entry, time)}`);

  return {
    path: filePath,
    date,
    time,
    branch,
    category: isNonEmptyString(entry.category) ? entry.category : "manual",
  };
}

/**
 * @typedef {{total: number,
 *   categories: Record<string, {total: number, keep: number, correct: number}>}}
 *   BankAggregate
 */

/**
 * Summarize the bank by top-level category, for the future status surface.
 *
 * The bank is a human's markdown, so this reads it the way a status display
 * should: line-oriented and forgiving. Every `## HH:MM — <category>` heading is
 * one entry; the first `- outcome:` line beneath it, if any, supplies the
 * breakdown. Anything else — prose, hand edits, a duplicated field, a file that
 * cannot be read at all — is skipped rather than fatal, and a project with no
 * bank yet is simply empty.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @returns {BankAggregate} Entry counts per category and overall. Never throws.
 */
export function aggregateDecisions(projectDir) {
  const summary = { total: 0, categories: {} };
  let names;
  try {
    names = fs
      .readdirSync(projectDecisionsDir(projectDir))
      .filter((name) => name.endsWith(".md"));
  } catch {
    return summary;
  }

  for (const name of names) {
    let contents;
    try {
      contents = fs.readFileSync(
        path.join(projectDecisionsDir(projectDir), name),
        "utf8",
      );
    } catch {
      // One unreadable file must not cost the reader every other entry.
      continue;
    }

    let open = null;
    for (const line of contents.split(/\r?\n/)) {
      const heading = HEADING_PATTERN.exec(line);
      if (heading) {
        const category = heading[1];
        summary.categories[category] ??= { total: 0, keep: 0, correct: 0 };
        summary.categories[category].total += 1;
        summary.total += 1;
        open = summary.categories[category];
        continue;
      }
      const outcome = open && OUTCOME_PATTERN.exec(line);
      if (outcome) {
        open[outcome[1]] += 1;
        open = null;
      }
    }
  }

  return summary;
}
