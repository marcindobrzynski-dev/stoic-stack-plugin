import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  DECISIONS_IGNORE_LINE,
  DETACHED_BRANCH_NAME,
  NO_GIT_BRANCH_NAME,
  aggregateDecisions,
  branchSlug,
  resolveBranch,
  writeDecisionEntry,
} from "../../src/io/bank.js";
import {
  projectDecisionsDir,
  projectGitignorePath,
} from "../../src/io/paths.js";
import { makeTempDir } from "../helpers/temp-dir.js";

/** A throwaway project the bank may write into. */
const project = (t) => makeTempDir(t, "stoic-bank-project-");

/** A git seam that answers every invocation with one branch name. */
function gitOn(branch) {
  return () => ({ status: 0, stdout: `${branch}\n`, stderr: "" });
}

/** A git seam that fails the way a non-repository directory does. */
const gitAbsent = () => ({ status: 128, stdout: "", stderr: "not a repo" });

/** A fixed local moment, so date and time assertions never depend on the clock. */
const AT = new Date(2026, 7, 10, 14, 3);

const KEEP_ENTRY = {
  outcome: "keep",
  category: "architecture",
  subcategory: "dependency-choice",
  files: ["src/a.js", "src/b.js"],
  trigger: "score",
  questions: ["Why this library?", "What breaks later?"],
  answer: "Because it is small.\n\nSecond paragraph.",
};

const read = (filePath) => fs.readFileSync(filePath, "utf8");

// --- File naming, frontmatter, and append order ------------------------------

test("a first write creates the day-and-branch file with frontmatter", (t) => {
  const projectDir = project(t);

  const result = writeDecisionEntry(projectDir, KEEP_ENTRY, {
    now: AT,
    spawn: gitOn("feature/new thing"),
  });

  assert.equal(
    result.path,
    path.join(
      projectDecisionsDir(projectDir),
      "2026-08-10_feature-new-thing.md",
    ),
  );
  assert.equal(result.date, "2026-08-10");
  assert.equal(result.branch, "feature/new thing");
  assert.ok(
    read(result.path).startsWith(
      "---\ndate: 2026-08-10\nbranch: feature/new thing\n---\n",
    ),
    "frontmatter must carry the local date and the RAW branch name",
  );
});

test("the frozen section format is written verbatim", (t) => {
  const projectDir = project(t);

  const { path: filePath } = writeDecisionEntry(projectDir, KEEP_ENTRY, {
    now: AT,
    spawn: gitOn("main"),
  });

  assert.equal(
    read(filePath),
    [
      "---",
      "date: 2026-08-10",
      "branch: main",
      "---",
      "",
      "## 14:03 — architecture",
      "",
      "- outcome: keep",
      "- subcategory: dependency-choice",
      "- files: src/a.js, src/b.js",
      "- trigger: score",
      "",
      "### Questions",
      "",
      "1. Why this library?",
      "2. What breaks later?",
      "",
      "### Answer",
      "",
      "Because it is small.",
      "",
      "Second paragraph.",
      "",
    ].join("\n"),
  );
});

test("a categoryless pause is recorded as a manual entry", (t) => {
  const projectDir = project(t);

  const { path: filePath } = writeDecisionEntry(
    projectDir,
    {
      outcome: "keep",
      trigger: "manual",
      questions: ["What are you actually deciding?"],
      answer: "To stop.",
    },
    { now: AT, spawn: gitOn("main") },
  );

  const contents = read(filePath);
  assert.ok(contents.includes("## 14:03 — manual"), contents);
  assert.ok(!contents.includes("- subcategory:"), "no subcategory line");
  assert.ok(contents.includes("- trigger: manual"), contents);
  assert.ok(contents.includes("- files: none"), contents);
});

test("sections append in call order under one frontmatter", (t) => {
  const projectDir = project(t);
  const options = { now: AT, spawn: gitOn("main") };

  const first = writeDecisionEntry(projectDir, KEEP_ENTRY, options);
  const second = writeDecisionEntry(
    projectDir,
    { ...KEEP_ENTRY, category: "testing", answer: "Later." },
    { ...options, now: new Date(2026, 7, 10, 16, 30) },
  );

  assert.equal(second.path, first.path);
  const contents = read(first.path);
  assert.equal(contents.match(/^---$/gm).length, 2, "one frontmatter only");
  assert.ok(
    contents.indexOf("## 14:03 — architecture") <
      contents.indexOf("## 16:30 — testing"),
    contents,
  );
});

// --- Outcome-conditional sections --------------------------------------------

test("a keep entry ends after its answer", (t) => {
  const projectDir = project(t);

  const { path: filePath } = writeDecisionEntry(
    projectDir,
    { ...KEEP_ENTRY, correction: "ignored", followup_prompt: "ignored too" },
    { now: AT, spawn: gitOn("main") },
  );

  const contents = read(filePath);
  assert.ok(contents.includes("### Answer"), contents);
  assert.ok(!contents.includes("### Correction"), "keep writes no correction");
  assert.ok(!contents.includes("### Follow-up"), "keep writes no follow-up");
});

test("a correct entry adds the correction section", (t) => {
  const projectDir = project(t);

  const { path: filePath } = writeDecisionEntry(
    projectDir,
    { ...KEEP_ENTRY, outcome: "correct", correction: "Use the built-in." },
    { now: AT, spawn: gitOn("main") },
  );

  const contents = read(filePath);
  assert.ok(contents.includes("- outcome: correct"), contents);
  assert.ok(
    contents.includes("### Correction\n\nUse the built-in.\n"),
    contents,
  );
  assert.ok(!contents.includes("### Follow-up"), "no follow-up was approved");
  assert.ok(
    contents.indexOf("### Answer") < contents.indexOf("### Correction"),
    contents,
  );
});

test("a follow-up section is written only when a follow-up prompt exists", (t) => {
  const projectDir = project(t);

  const { path: filePath } = writeDecisionEntry(
    projectDir,
    {
      ...KEEP_ENTRY,
      outcome: "correct",
      correction: "Use the built-in.",
      followup_prompt: "Replace the dependency with node:crypto.",
    },
    { now: AT, spawn: gitOn("main") },
  );

  const contents = read(filePath);
  assert.ok(
    contents.includes(
      "### Follow-up\n\nReplace the dependency with node:crypto.\n",
    ),
    contents,
  );
  assert.ok(
    contents.indexOf("### Correction") < contents.indexOf("### Follow-up"),
    contents,
  );
});

// --- Privacy enforcement ------------------------------------------------------

test("the first write creates the privacy gitignore", (t) => {
  const projectDir = project(t);

  writeDecisionEntry(projectDir, KEEP_ENTRY, {
    now: AT,
    spawn: gitOn("main"),
  });

  assert.equal(read(projectGitignorePath(projectDir)), "decisions/\n");
  assert.equal(DECISIONS_IGNORE_LINE, "decisions/");
});

test("a deleted gitignore comes back on the next write", (t) => {
  const projectDir = project(t);
  const options = { now: AT, spawn: gitOn("main") };
  writeDecisionEntry(projectDir, KEEP_ENTRY, options);
  fs.rmSync(projectGitignorePath(projectDir));

  writeDecisionEntry(projectDir, KEEP_ENTRY, options);

  assert.equal(read(projectGitignorePath(projectDir)), "decisions/\n");
});

test("an edit that dropped the line gets it back without losing the edit", (t) => {
  const projectDir = project(t);
  const options = { now: AT, spawn: gitOn("main") };
  writeDecisionEntry(projectDir, KEEP_ENTRY, options);
  fs.writeFileSync(
    projectGitignorePath(projectDir),
    "# mine\nscratch/\n",
    "utf8",
  );

  writeDecisionEntry(projectDir, KEEP_ENTRY, options);

  assert.equal(
    read(projectGitignorePath(projectDir)),
    "# mine\nscratch/\ndecisions/\n",
  );
});

test("an edit that kept the line is left alone", (t) => {
  const projectDir = project(t);
  const options = { now: AT, spawn: gitOn("main") };
  writeDecisionEntry(projectDir, KEEP_ENTRY, options);
  fs.writeFileSync(
    projectGitignorePath(projectDir),
    "# mine\ndecisions/\nscratch/\n",
    "utf8",
  );

  writeDecisionEntry(projectDir, KEEP_ENTRY, options);

  assert.equal(
    read(projectGitignorePath(projectDir)),
    "# mine\ndecisions/\nscratch/\n",
  );
});

// --- Branch resolution --------------------------------------------------------

test("branch names are reduced to one filename alphabet", () => {
  assert.equal(branchSlug("feature/JIRA-12_fix"), "feature-JIRA-12-fix");
  assert.equal(branchSlug("  "), "no-branch");
  assert.equal(branchSlug(undefined), "no-branch");
  assert.ok(branchSlug("x".repeat(500)).length <= 60);
});

test("a detached HEAD resolves to a stable fallback name", (t) => {
  const projectDir = project(t);

  assert.equal(
    resolveBranch(projectDir, { spawn: gitOn("HEAD") }),
    DETACHED_BRANCH_NAME,
  );
  assert.equal(DETACHED_BRANCH_NAME, "detached");
});

test("a project without git resolves to a stable fallback name", (t) => {
  const projectDir = project(t);

  assert.equal(resolveBranch(projectDir, { spawn: gitAbsent }), "no-branch");
  assert.equal(NO_GIT_BRANCH_NAME, "no-branch");
  // A real temporary directory is not a repository either.
  assert.equal(resolveBranch(projectDir), NO_GIT_BRANCH_NAME);
});

test("branch resolution never throws, whatever the seam does", (t) => {
  const projectDir = project(t);
  const seams = [
    () => {
      throw new Error("spawn exploded");
    },
    () => null,
    () => ({ status: 0, stdout: null }),
    () => ({ error: new Error("ENOENT"), status: null, stdout: "" }),
  ];

  for (const spawn of seams) {
    assert.equal(resolveBranch(projectDir, { spawn }), NO_GIT_BRANCH_NAME);
  }
});

test("an unresolvable branch still produces a written entry", (t) => {
  const projectDir = project(t);

  const result = writeDecisionEntry(projectDir, KEEP_ENTRY, {
    now: AT,
    spawn: gitAbsent,
  });

  assert.equal(path.basename(result.path), "2026-08-10_no-branch.md");
  assert.ok(read(result.path).includes("branch: no-branch"));
});

// --- Aggregate reader ---------------------------------------------------------

/** Plant a bank file directly, bypassing the writer. */
function plant(projectDir, name, contents) {
  const dir = projectDecisionsDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, contents, "utf8");
  return filePath;
}

test("aggregation counts entries by top-level category", (t) => {
  const projectDir = project(t);
  plant(
    projectDir,
    "2026-08-10_main.md",
    [
      "---",
      "date: 2026-08-10",
      "branch: main",
      "---",
      "",
      "## 09:00 — architecture",
      "",
      "- outcome: keep",
      "",
      "## 10:00 — architecture",
      "",
      "- outcome: correct",
      "",
      "## 11:00 — testing",
      "",
      "- outcome: keep",
      "",
    ].join("\n"),
  );
  plant(
    projectDir,
    "2026-08-11_main.md",
    ["## 09:00 — testing", "", "- outcome: correct", ""].join("\n"),
  );

  assert.deepEqual(aggregateDecisions(projectDir), {
    total: 4,
    categories: {
      architecture: { total: 2, keep: 1, correct: 1 },
      testing: { total: 2, keep: 1, correct: 1 },
    },
  });
});

test("hand-edited and malformed files are tolerated", (t) => {
  const projectDir = project(t);
  plant(
    projectDir,
    "2026-08-10_main.md",
    [
      "## not a heading at all",
      "- outcome: keep",
      "",
      "## 09:00 — architecture",
      "",
      "- outcome: nonsense",
      "",
      "## 10:00 — architecture",
      "",
      "- outcome: keep",
      "- outcome: correct",
      "",
      "random prose the user typed",
      "",
    ].join("\n"),
  );
  plant(projectDir, "notes.txt", "ignored, not a bank file\n");

  assert.deepEqual(aggregateDecisions(projectDir), {
    total: 2,
    categories: { architecture: { total: 2, keep: 1, correct: 0 } },
  });
});

test("an unreadable bank file does not break aggregation", (t) => {
  const projectDir = project(t);
  plant(
    projectDir,
    "2026-08-10_main.md",
    ["## 09:00 — testing", "", "- outcome: keep", ""].join("\n"),
  );
  // A directory where a file is expected: unreadable on every platform.
  fs.mkdirSync(path.join(projectDecisionsDir(projectDir), "2026-08-11_x.md"));

  assert.deepEqual(aggregateDecisions(projectDir), {
    total: 1,
    categories: { testing: { total: 1, keep: 1, correct: 0 } },
  });
});

test("a project with no bank aggregates to an empty result", (t) => {
  const projectDir = project(t);

  assert.deepEqual(aggregateDecisions(projectDir), {
    total: 0,
    categories: {},
  });
  assert.deepEqual(aggregateDecisions(undefined), { total: 0, categories: {} });
});
