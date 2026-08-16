// The manual-pause writer is verified through the same seam as the other two
// CLIs: run the real script as a child process against a throwaway project and
// a throwaway home, and assert only what a caller can observe — the one stdout
// result, the exit status, stderr, and the documents on disk.
//
// What is different here is the material. This CLI's diff seam is left at its
// default, so these tests give it a real repository to measure and compare the
// counts it reports against edits whose lines the test itself wrote. The
// repository fixtures live in ../helpers/git-repo.js; a missing git fails the
// suite rather than skipping it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { defaultConfig } from "../../src/io/config/config.js";
import { resolveManualReflection } from "../../src/io/config/manual-reflection.js";
import { personalStateDir } from "../../src/io/paths.js";
import { defaultState } from "../../src/io/state.js";
import { createSandbox } from "../helpers/sandbox.js";
import {
  BASELINE_FILE,
  git,
  initRepo,
  writeLines,
} from "../helpers/git-repo.js";
import { makePause, stoicDirExists } from "../helpers/record-cli.js";
import {
  manualPauseExists,
  manualPauseFile,
  pendingPauseFile,
  readManualPause,
  readPendingPauseText,
  runReflect,
  writePendingPause,
} from "../helpers/reflect-cli.js";
import {
  readStateText,
  stateExists,
  writeConfigDocument,
  writeStateDocument,
} from "../helpers/setup-cli.js";

/** The plugin's own root — the same directory the CLI derives from its URL. */
const PLUGIN_ROOT = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);

/** The reading of a tree with nothing to say, as the result reports it. */
const CLEAN_RESULT = Object.freeze({
  ok: true,
  material: "clean",
  edit_count: 0,
  lines_added: 0,
  lines_removed: 0,
});

/**
 * The baseline README, edited in the working tree and left unstaged. Against
 * the three baseline lines this is one line replaced and one appended, so git
 * measures it as two added and one removed.
 */
const EDITED_README = Object.freeze(["alpha", "BETA", "gamma", "delta"]);
const EDITED_README_COUNTS = Object.freeze({
  lines_added: 2,
  lines_removed: 1,
});

/**
 * Files created and staged, each entirely new — so every line is an addition
 * and the expectation below is derived from these lists rather than restated.
 * The awkward names are the point: a subdirectory, a space, and non-ASCII, all
 * of which git would quote if this reader had not asked it not to.
 */
const STAGED_FILES = Object.freeze({
  "added.js": ["export const one = 1;", "export const two = 2;"],
  "src/deep/nested.txt": ["deep"],
  "notes with space.txt": ["spaced"],
  "zażółć.txt": ["gęślą jaźń"],
});

/** A file git has never been told about; a diff against HEAD cannot see it. */
const UNTRACKED_FILE = "untracked.txt";

/** The edits, keyed by path, so an assertion does not depend on git's order. */
const byFile = (edits) =>
  Object.fromEntries(
    edits.map((edit) => [
      edit.file,
      { lines_added: edit.lines_added, lines_removed: edit.lines_removed },
    ]),
  );

/** Sum one count across an expectation table. */
const totalOf = (expected, field) =>
  Object.values(expected).reduce((total, counts) => total + counts[field], 0);

/** A repository holding the baseline commit and nothing else. */
function repoSandbox(t) {
  const sandbox = createSandbox(t);
  initRepo(sandbox.projectDir, sandbox.env);
  return sandbox;
}

// ---------------------------------------------------------------------------
// What the tree is measured to hold
// ---------------------------------------------------------------------------

test("staged and unstaged changes are both measured, and untracked work is not", (t) => {
  const sandbox = repoSandbox(t);
  writeLines(path.join(sandbox.projectDir, BASELINE_FILE), [...EDITED_README]);
  for (const [file, lines] of Object.entries(STAGED_FILES)) {
    writeLines(path.join(sandbox.projectDir, file), [...lines]);
    git(sandbox.projectDir, ["add", "--", file], sandbox.env);
  }
  writeLines(path.join(sandbox.projectDir, UNTRACKED_FILE), ["invisible"]);

  const { status, result } = runReflect(sandbox);

  const expected = {
    [BASELINE_FILE]: { ...EDITED_README_COUNTS },
    ...Object.fromEntries(
      Object.entries(STAGED_FILES).map(([file, lines]) => [
        file,
        { lines_added: lines.length, lines_removed: 0 },
      ]),
    ),
  };
  const linesAdded = totalOf(expected, "lines_added");
  const linesRemoved = totalOf(expected, "lines_removed");

  assert.equal(status, 0);
  assert.deepEqual(result, {
    ok: true,
    material: "found",
    edit_count: Object.keys(expected).length,
    lines_added: linesAdded,
    lines_removed: linesRemoved,
  });

  const pause = readManualPause(sandbox);
  // Paths arrive verbatim: forward slashes, spaces and all, never quoted.
  assert.deepEqual(byFile(pause.group.edits), expected);
  assert.equal(pause.group.edit_count, Object.keys(expected).length);
  assert.equal(pause.group.lines_added, linesAdded);
  assert.equal(pause.group.lines_removed, linesRemoved);

  // An independent oracle: git's own record of how many files it sees.
  const numstat = git(
    sandbox.projectDir,
    ["diff", "HEAD", "--numstat"],
    sandbox.env,
  );
  assert.equal(numstat.trimEnd().split("\n").length, result.edit_count);
});

test("a staged rename is measured once, at the path the file now has", (t) => {
  const sandbox = repoSandbox(t);
  const destination = "docs/README.md";
  fs.mkdirSync(path.join(sandbox.projectDir, "docs"), { recursive: true });
  git(sandbox.projectDir, ["mv", BASELINE_FILE, destination], sandbox.env);

  const { status, result } = runReflect(sandbox);

  assert.equal(status, 0);
  assert.equal(result.material, "found");
  assert.equal(result.edit_count, 1);
  // A pure move changes no lines, and git says so with real zeros — this is
  // the rename record of `-z`, read by the real reader against real git.
  assert.deepEqual(byFile(readManualPause(sandbox).group.edits), {
    [destination]: { lines_added: 0, lines_removed: 0 },
  });
});

test("a clean tree reports no material and still leaves a document to reflect on", (t) => {
  const sandbox = repoSandbox(t);

  const { status, result } = runReflect(sandbox);

  assert.equal(status, 0);
  assert.deepEqual(result, { ...CLEAN_RESULT });

  const pause = readManualPause(sandbox);
  assert.deepEqual(pause.group.edits, []);
  assert.equal(pause.group.edit_count, 0);
});

test("a directory that is no repository reads exactly like a clean tree", (t) => {
  const sandbox = createSandbox(t);
  // Nothing is initialized here, and the ceiling keeps git from wandering up
  // into whatever repository the temporary directory may itself sit inside.
  const env = {
    ...sandbox.env,
    GIT_CEILING_DIRECTORIES: path.dirname(sandbox.projectDir),
  };

  const { status, result } = runReflect(sandbox, [], { env });

  assert.equal(status, 0);
  assert.deepEqual(result, { ...CLEAN_RESULT });

  const pause = readManualPause(sandbox);
  assert.deepEqual(pause.group.edits, []);
  assert.equal(pause.group.edit_count, 0);
  assert.equal(pause.trigger, "manual");
});

// ---------------------------------------------------------------------------
// The document itself
// ---------------------------------------------------------------------------

test("the document names the manual trigger, the project, and the recorder", (t) => {
  const sandbox = repoSandbox(t);

  runReflect(sandbox);

  const pause = readManualPause(sandbox);
  const settings = resolveManualReflection(defaultConfig(), defaultState());

  assert.equal(pause.trigger, "manual");
  assert.equal(pause.cwd, sandbox.projectDir);
  assert.equal(pause.plugin_root, PLUGIN_ROOT);
  assert.equal(
    pause.record_cmd,
    `node "${path.join(PLUGIN_ROOT, "src", "cli", "record.js")}"`,
  );
  assert.equal(pause.pause_mode, settings.pause_mode);
  assert.equal(pause.followup_draft, settings.followup_draft);
  assert.equal(pause.max_questions, settings.max_questions);
  assert.ok(Number.isFinite(pause.created_at) && pause.created_at > 0);
});

test("the fields a measured pause never had are absent rather than zeroed", (t) => {
  const sandbox = repoSandbox(t);

  runReflect(sandbox);

  const pause = readManualPause(sandbox);
  for (const field of ["score", "threshold", "classification"]) {
    assert.equal(
      field in pause,
      false,
      `${field} must not appear at all: a zero would read as a measurement`,
    );
  }
});

test("an automatic pause sitting beside the manual one is left byte-for-byte alone", (t) => {
  const sandbox = repoSandbox(t);
  writePendingPause(sandbox, makePause(sandbox));
  const before = readPendingPauseText(sandbox);

  const { status } = runReflect(sandbox);

  assert.equal(status, 0);
  assert.equal(readPendingPauseText(sandbox), before);
  assert.ok(manualPauseExists(sandbox));
  assert.notEqual(manualPauseFile(sandbox), pendingPauseFile(sandbox));
});

test("a second reflection replaces the document the first one left", (t) => {
  const sandbox = repoSandbox(t);

  const first = runReflect(sandbox);
  assert.equal(first.result.material, "clean");

  writeLines(path.join(sandbox.projectDir, BASELINE_FILE), [...EDITED_README]);
  const second = runReflect(sandbox);

  assert.equal(second.result.material, "found");
  const pause = readManualPause(sandbox);
  assert.equal(pause.group.edit_count, 1);
  assert.deepEqual(byFile(pause.group.edits), {
    [BASELINE_FILE]: { ...EDITED_README_COUNTS },
  });
});

// ---------------------------------------------------------------------------
// What it must not touch
// ---------------------------------------------------------------------------

test("a request for a reflection changes no engine state", (t) => {
  const sandbox = repoSandbox(t);
  writeStateDocument(sandbox, {
    ...defaultState(),
    score: 41.5,
    last_update: 1_700_000_000_000,
    preset: "vigilant",
  });
  const before = readStateText(sandbox);

  const { status } = runReflect(sandbox);

  assert.equal(status, 0);
  assert.equal(readStateText(sandbox), before);
});

test("a disabled plugin still writes the pause: `enabled` gates the engine, not the developer", (t) => {
  const sandbox = repoSandbox(t);
  writeConfigDocument(sandbox, { ...defaultConfig(), enabled: false });
  writeLines(path.join(sandbox.projectDir, BASELINE_FILE), [...EDITED_README]);

  const { status, result } = runReflect(sandbox);

  assert.equal(status, 0);
  assert.equal(result.material, "found");
  assert.equal(readManualPause(sandbox).trigger, "manual");
});

test("a project that never ran setup gains no state and no decision bank", (t) => {
  const sandbox = repoSandbox(t);

  const { status } = runReflect(sandbox);

  assert.equal(status, 0);
  assert.equal(stateExists(sandbox), false);
  assert.equal(stoicDirExists(sandbox), false);
});

// ---------------------------------------------------------------------------
// The two streams
// ---------------------------------------------------------------------------

test("stdout carries exactly one JSON line and stderr names the document", (t) => {
  const sandbox = repoSandbox(t);

  const { stdout, stderr } = runReflect(sandbox);

  const line = stdout.trim();
  assert.equal(line.includes("\n"), false);
  assert.deepEqual(JSON.parse(line), { ...CLEAN_RESULT });
  assert.equal(line.includes(sandbox.homeDir), false);
  assert.ok(
    stderr.includes(`manual pause: ${manualPauseFile(sandbox)}`),
    `stderr must hand the document's path to the skill. Got:\n${stderr}`,
  );
});

// ---------------------------------------------------------------------------
// Refused invocations
// ---------------------------------------------------------------------------

test("a project directory that is not a directory is refused, writing nothing", (t) => {
  const sandbox = repoSandbox(t);
  const notADirectory = path.join(sandbox.projectDir, "notes.txt");
  fs.writeFileSync(notADirectory, "not a project\n", "utf8");

  const { status, result } = runReflect(sandbox, ["--project", notADirectory]);

  assert.equal(status, 2);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_project");
  assert.deepEqual(result.changed, { pause: "unchanged" });
  assert.equal(manualPauseExists(sandbox), false);
});

test("a project directory that does not exist is refused the same way", (t) => {
  const sandbox = repoSandbox(t);

  const { status, result } = runReflect(sandbox, [
    "--project",
    path.join(sandbox.projectDir, "nowhere"),
  ]);

  assert.equal(status, 2);
  assert.equal(result.error.code, "invalid_project");
  assert.equal(manualPauseExists(sandbox), false);
});

test("an unknown flag is a usage rejection, not a written pause", (t) => {
  const sandbox = repoSandbox(t);

  const { status, result } = runReflect(sandbox, ["--outcome", "keep"]);

  assert.equal(status, 2);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "usage");
  assert.deepEqual(result.changed, { pause: "unchanged" });
  assert.equal(manualPauseExists(sandbox), false);
});

test("a document that cannot land is a persistence failure, reported honestly", (t) => {
  const sandbox = repoSandbox(t);
  // A regular file where the personal state directory must go: every write
  // beneath it fails, and nothing about the request itself is wrong.
  const stateDir = personalStateDir(sandbox.projectDir, sandbox.homeDir);
  fs.mkdirSync(path.dirname(stateDir), { recursive: true });
  fs.writeFileSync(stateDir, "in the way\n", "utf8");

  const { status, result, stderr } = runReflect(sandbox);

  assert.equal(status, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "pause_write_failed");
  assert.deepEqual(result.changed, { pause: "unchanged" });
  assert.ok(
    stderr.includes("Cannot write the manual pause"),
    `stderr must say what could not be written. Got:\n${stderr}`,
  );
  assert.equal(stderr.includes("manual pause: "), false);
});

test("a named project is measured instead of the running directory", (t) => {
  const sandbox = repoSandbox(t);
  const other = path.join(sandbox.homeDir, "other-project");
  initRepo(other, sandbox.env);
  writeLines(path.join(other, BASELINE_FILE), [...EDITED_README]);

  const { status, result } = runReflect(sandbox, ["--project", other]);

  assert.equal(status, 0);
  assert.deepEqual(result, {
    ok: true,
    material: "found",
    edit_count: 1,
    lines_added: EDITED_README_COUNTS.lines_added,
    lines_removed: EDITED_README_COUNTS.lines_removed,
  });
  // The running directory is clean and, more to the point, untouched.
  assert.equal(manualPauseExists(sandbox), false);

  const pause = JSON.parse(
    fs.readFileSync(
      manualPauseFile({ projectDir: other, homeDir: sandbox.homeDir }),
      "utf8",
    ),
  );
  assert.equal(pause.cwd, other);
});
