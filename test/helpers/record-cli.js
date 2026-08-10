// Shared harness for driving the real outcome-recording CLI as a child process,
// the twin of ../helpers/setup-cli.js. The recording suite verifies the plugin
// through one seam only: run `src/cli/record.js` against a throwaway project and
// home, and assert nothing but what a caller can observe — the single stdout
// JSON result, the exit status, and the documents left on disk.
//
// The pause and answer documents deliberately live OUTSIDE the project
// directory, in the sandbox home, because that is where the pause skill writes
// them and because their paths are always passed explicitly — `record.js` may
// never derive either one from the invocation cwd.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  projectDecisionsDir,
  projectGitignorePath,
  projectStoicDir,
} from "../../src/io/paths.js";

export const RECORD_CLI = fileURLToPath(
  new URL("../../src/cli/record.js", import.meta.url),
);

/** File names the pause skill uses; both sit outside the project. */
const PAUSE_FILE_NAME = "stoic-pending-pause.json";
const ANSWER_FILE_NAME = "pause-answer.json";

/** The category the default pause classifies into. */
export const PAUSE_CATEGORY = "security";

/** The subcategory the default pause carries, under {@link PAUSE_CATEGORY}. */
export const PAUSE_SUBCATEGORY = "authorization";

/**
 * The touched files the default pause's turn group implies: unique, non-empty,
 * in first-seen order. The group repeats one file so the fingerprint has
 * something to dedupe.
 */
export const PAUSE_FILES = Object.freeze([
  "src/auth/roles.js",
  "src/api/records.js",
]);

export const pausePath = (sandbox) =>
  path.join(sandbox.homeDir, PAUSE_FILE_NAME);

export const answerPath = (sandbox) =>
  path.join(sandbox.homeDir, ANSWER_FILE_NAME);

/** One edit event, shaped as the turn group stores it. */
const edit = (file, ts) => ({
  ts,
  file,
  lines_added: 4,
  lines_removed: 1,
  delegated: false,
  agent_type: null,
});

/** A turn group with the given files, in order, as the pause embeds it. */
export function groupOver(files) {
  return {
    prompt: "tighten who may read another tenant's records",
    prompt_effort: 0.4,
    genuine_prompt_count: 1,
    neutralized_prompt_count: 0,
    prompt_neutralized: false,
    had_question: false,
    auto_accept: false,
    edit_count: files.length,
    lines_added: 4 * files.length,
    lines_removed: files.length,
    delegated_edit_count: 0,
    delegated_lines_added: 0,
    delegated_lines_removed: 0,
    delegated: false,
    agent_count: 0,
    edits: files.map((file, index) => edit(file, 1000 + index)),
    subagent_events: [],
    understood_event_count: files.length + 1,
    skipped_event_count: 0,
  };
}

/**
 * A complete, valid pause document pointing at the sandbox project. Override
 * any field — or pass `classification: undefined` — to make it something else.
 */
export function makePause(sandbox, overrides = {}) {
  const pause = {
    created_at: 1_700_000_000_000,
    trigger: "score",
    score: 12.5,
    threshold: 10,
    classification: {
      decision_found: true,
      category: PAUSE_CATEGORY,
      subcategory: PAUSE_SUBCATEGORY,
      reason: "The turn changed who may read another tenant's records.",
      confidence: 0.82,
    },
    // The repeated file is deliberate: the fingerprint dedupes it.
    group: groupOver([PAUSE_FILES[0], PAUSE_FILES[1], PAUSE_FILES[0]]),
    cwd: sandbox.projectDir,
    plugin_root: "/plugins/stoic-stack",
    record_cmd: "node /plugins/stoic-stack/src/cli/record.js",
    pause_mode: "hybrid",
    followup_draft: true,
    max_questions: 3,
    ...overrides,
  };
  if (pause.classification === undefined) {
    delete pause.classification;
  }
  return pause;
}

/** A complete, valid answer document as the pause skill writes it. */
export function makeAnswer(overrides = {}) {
  const answer = {
    questions: [
      "Why does the report page need cross-tenant reads?",
      "What is the smallest role that still works?",
    ],
    answer:
      "The report page reads across tenants today.\n\nA narrower role would need a new join.",
    ...overrides,
  };
  for (const [field, value] of Object.entries(answer)) {
    if (value === undefined) {
      delete answer[field];
    }
  }
  return answer;
}

/** Plant a document at an explicit path, bypassing the CLI under test. */
function plant(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    typeof contents === "string" ? contents : JSON.stringify(contents),
    "utf8",
  );
  return filePath;
}

/** Plant the pending pause document; returns the path to pass as `--pause`. */
export const writePauseDocument = (sandbox, contents) =>
  plant(pausePath(sandbox), contents);

/** Plant the answer document; returns the path to pass as `--data`. */
export const writeAnswerDocument = (sandbox, contents) =>
  plant(answerPath(sandbox), contents);

/** Assemble a record invocation; omit a value to leave that flag out entirely. */
export function recordArgs({ outcome, pause, data } = {}) {
  const args = [];
  if (outcome !== undefined) {
    args.push("--outcome", outcome);
  }
  if (pause !== undefined) {
    args.push("--pause", pause);
  }
  if (data !== undefined) {
    args.push("--data", data);
  }
  return args;
}

/** Run the real CLI and parse the single JSON result it contracts to emit. */
export function runRecord(sandbox, args) {
  const run = sandbox.runNode(RECORD_CLI, args);
  let result;
  try {
    result = JSON.parse(run.stdout);
  } catch {
    assert.fail(
      `record.js must always print one JSON result to stdout. Got:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );
  }
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, result };
}

export const pauseExists = (sandbox) => fs.existsSync(pausePath(sandbox));

export const answerExists = (sandbox) => fs.existsSync(answerPath(sandbox));

export const stoicDirExists = (sandbox) =>
  fs.existsSync(projectStoicDir(sandbox.projectDir));

export const readGitignore = (sandbox) =>
  fs.readFileSync(projectGitignorePath(sandbox.projectDir), "utf8");

/** The decision-bank markdown files on disk, or `[]` when the bank is absent. */
export function decisionFiles(sandbox) {
  try {
    return fs
      .readdirSync(projectDecisionsDir(sandbox.projectDir))
      .filter((name) => name.endsWith(".md"));
  } catch {
    return [];
  }
}

/** The one bank file's text; fails the test when there is not exactly one. */
export function readDecisionText(sandbox) {
  const names = decisionFiles(sandbox);
  assert.equal(
    names.length,
    1,
    `expected exactly one decision-bank file, found: ${names.join(", ") || "none"}`,
  );
  return fs.readFileSync(
    path.join(projectDecisionsDir(sandbox.projectDir), names[0]),
    "utf8",
  );
}
