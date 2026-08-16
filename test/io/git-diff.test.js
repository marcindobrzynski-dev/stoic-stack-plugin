import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

import {
  GIT_DIFF_ARGS,
  GIT_DIFF_MAX_BUFFER,
  GIT_DIFF_TIMEOUT_MS,
  emptyDiff,
  parseNumstat,
  readWorkingTreeDiff,
} from "../../src/io/git-diff.js";
import { makeTempDir } from "../helpers/temp-dir.js";

/** A throwaway project directory to run the reader against. */
const project = (t) => makeTempDir(t, "stoic-git-diff-project-");

/** A git seam that answers the one invocation with these numstat bytes. */
function gitEmitting(stdout) {
  return () => ({ status: 0, stdout, stderr: "" });
}

/** A git seam that records how it was called before answering. */
function recordingGit(stdout) {
  const calls = [];
  return {
    calls,
    spawn: (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout, stderr: "" };
    },
  };
}

// The exact bytes git 2.52 emits for `diff --numstat -z`, verified against a
// real repository; every fixture below is quoted from that transcript.
const TWO_FILES = "3\t1\tmod.txt\0" + "1\t0\tstaged_new.txt\0";
const BINARY = "-\t-\tbin.dat\0";
const RENAME_ACROSS_DIRS = "0\t0\t\0old.txt\0new/dir.txt\0";
const RENAME_WITH_EDITS = "3\t1\t\0a.js\0b.js\0";
const PATH_WITH_SPACE = "1\t0\tfile with space.txt\0";
const NON_ASCII_PATH = "1\t0\tzażółć.txt\0";
const SUBDIRECTORY_PATH = "1\t0\tsubdir/subfile.txt\0";

/** Read the working tree through a seam, never through the real git. */
const readWith = (t, spawn) => readWorkingTreeDiff(project(t), { spawn });

// --- The command the reader runs ---------------------------------------------

test("the reader asks git exactly one deterministic question", (t) => {
  const projectDir = project(t);
  const git = recordingGit("");

  readWorkingTreeDiff(projectDir, { spawn: git.spawn });

  assert.equal(git.calls.length, 1);
  assert.equal(git.calls[0].command, "git");
  assert.deepEqual(git.calls[0].args, GIT_DIFF_ARGS);
  assert.equal(git.calls[0].options.cwd, path.resolve(projectDir));
  assert.equal(git.calls[0].options.timeout, GIT_DIFF_TIMEOUT_MS);
  assert.equal(git.calls[0].options.maxBuffer, GIT_DIFF_MAX_BUFFER);
  assert.equal(git.calls[0].options.encoding, "utf8");
});

test("the frozen argument list cannot be edited by a caller", () => {
  assert.ok(Object.isFrozen(GIT_DIFF_ARGS));
  assert.deepEqual(GIT_DIFF_ARGS, [
    "--no-pager",
    "diff",
    "--numstat",
    "-z",
    "--find-renames",
    "HEAD",
    "--",
  ]);
});

// --- The grammar --------------------------------------------------------------

test("a multi-file diff becomes one edit per file with summed counts", (t) => {
  const diff = readWith(t, gitEmitting(TWO_FILES));

  assert.deepEqual(diff.edits, [
    { file: "mod.txt", lines_added: 3, lines_removed: 1 },
    { file: "staged_new.txt", lines_added: 1, lines_removed: 0 },
  ]);
  assert.equal(diff.edit_count, 2);
  assert.equal(diff.lines_added, 4);
  assert.equal(diff.lines_removed, 1);
});

test("a clean tree reads as the empty diff", (t) => {
  assert.deepEqual(readWith(t, gitEmitting("")), emptyDiff());
});

test("a binary file counts as an edit and contributes no lines", (t) => {
  const diff = readWith(t, gitEmitting(BINARY));

  assert.deepEqual(diff.edits, [
    { file: "bin.dat", lines_added: 0, lines_removed: 0 },
  ]);
  assert.equal(diff.edit_count, 1);
  assert.equal(diff.lines_added, 0);
  assert.equal(diff.lines_removed, 0);
});

test("a cross-directory rename records one edit at the destination", (t) => {
  const diff = readWith(t, gitEmitting(RENAME_ACROSS_DIRS));

  assert.deepEqual(diff.edits, [
    { file: "new/dir.txt", lines_added: 0, lines_removed: 0 },
  ]);
  assert.equal(diff.edit_count, 1);
});

test("a rename carrying edits counts them against the destination", (t) => {
  const diff = readWith(t, gitEmitting(RENAME_WITH_EDITS));

  assert.deepEqual(diff.edits, [
    { file: "b.js", lines_added: 3, lines_removed: 1 },
  ]);
  assert.equal(diff.lines_added, 3);
  assert.equal(diff.lines_removed, 1);
});

test("a rename record does not disturb the records around it", (t) => {
  const diff = readWith(t, gitEmitting(TWO_FILES + RENAME_WITH_EDITS + BINARY));

  assert.deepEqual(
    diff.edits.map((edit) => edit.file),
    ["mod.txt", "staged_new.txt", "b.js", "bin.dat"],
  );
  assert.equal(diff.edit_count, 4);
  assert.equal(diff.lines_added, 7);
  assert.equal(diff.lines_removed, 2);
});

test("a path with a space arrives verbatim and unquoted", (t) => {
  const diff = readWith(t, gitEmitting(PATH_WITH_SPACE));

  assert.equal(diff.edits[0].file, "file with space.txt");
});

test("a non-ASCII path arrives verbatim and unquoted", (t) => {
  const diff = readWith(t, gitEmitting(NON_ASCII_PATH));

  assert.equal(diff.edits[0].file, "zażółć.txt");
});

test("a subdirectory path keeps git's forward slashes", (t) => {
  const diff = readWith(t, gitEmitting(SUBDIRECTORY_PATH));

  assert.equal(diff.edits[0].file, "subdir/subfile.txt");
});

test("two records naming one file stay two separate edits", (t) => {
  const diff = readWith(t, gitEmitting("1\t0\ta.js\0" + "2\t0\ta.js\0"));

  assert.equal(diff.edits.length, 2);
  assert.equal(diff.edit_count, 2);
  assert.equal(diff.lines_added, 3);
});

test("parsing the numstat grammar needs no git process at all", () => {
  assert.deepEqual(parseNumstat(TWO_FILES).edits, [
    { file: "mod.txt", lines_added: 3, lines_removed: 1 },
    { file: "staged_new.txt", lines_added: 1, lines_removed: 0 },
  ]);
  assert.deepEqual(parseNumstat(""), emptyDiff());
});

// --- Every degradation is emptiness, never an error ---------------------------

test("a non-zero git exit reads as the empty diff", (t) => {
  const diff = readWith(t, () => ({
    status: 128,
    stdout: "",
    stderr: "fatal: ambiguous argument HEAD",
  }));

  assert.deepEqual(diff, emptyDiff());
});

test("a directory that is not a repository reads as the empty diff", (t) => {
  const diff = readWith(t, () => ({
    status: 129,
    stdout: "",
    stderr: "warning: Not a git repository. Use --no-index to compare",
  }));

  assert.deepEqual(diff, emptyDiff());
});

test("a git that is not installed reads as the empty diff", (t) => {
  const diff = readWith(t, () => {
    throw new Error("spawnSync git ENOENT");
  });

  assert.deepEqual(diff, emptyDiff());
});

test("a timed-out git reads as the empty diff", (t) => {
  const diff = readWith(t, () => ({
    error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }),
    status: null,
    stdout: "",
    stderr: "",
  }));

  assert.deepEqual(diff, emptyDiff());
});

test("output larger than the buffer reads as the empty diff", (t) => {
  const diff = readWith(t, () => ({
    error: Object.assign(new Error("ENOBUFS"), { code: "ENOBUFS" }),
    status: null,
    stdout: null,
    stderr: "",
  }));

  assert.deepEqual(diff, emptyDiff());
});

test("a non-string stdout reads as the empty diff", (t) => {
  const diff = readWith(t, () => ({ status: 0, stdout: null, stderr: "" }));

  assert.deepEqual(diff, emptyDiff());
});

test("a spawn result that is not an object reads as the empty diff", (t) => {
  assert.deepEqual(
    readWith(t, () => undefined),
    emptyDiff(),
  );
});

test("unparsable output reads as the empty diff rather than a partial one", (t) => {
  for (const garbage of [
    "not numstat at all\0",
    "3\tmod.txt\0",
    "x\ty\tmod.txt\0",
    "3\t1\t\0only-one-path.txt\0",
  ]) {
    assert.deepEqual(
      readWith(t, gitEmitting(garbage)),
      emptyDiff(),
      `expected emptiness for ${JSON.stringify(garbage)}`,
    );
  }
});

test("one unreadable record discards the whole reading", (t) => {
  const diff = readWith(t, gitEmitting(TWO_FILES + "oops\0"));

  assert.deepEqual(diff, emptyDiff());
});

test("the empty diff is a fresh, zeroed shape on every call", () => {
  const first = emptyDiff();

  assert.deepEqual(first, {
    edits: [],
    edit_count: 0,
    lines_added: 0,
    lines_removed: 0,
  });
  first.edits.push({ file: "mutated" });
  assert.deepEqual(emptyDiff().edits, []);
});

test("reading never throws, whatever the seam does", (t) => {
  const projectDir = project(t);

  assert.doesNotThrow(() => readWorkingTreeDiff(projectDir, null));
  assert.doesNotThrow(() => readWorkingTreeDiff(projectDir, { spawn: 7 }));
});
