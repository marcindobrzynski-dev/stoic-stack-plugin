// The recording CLI is the single writer of a pause outcome, and this suite is
// the seam it is verified through: every test runs the real script as a child
// process against a throwaway project and a throwaway home, then asserts only
// what a caller can observe — the one JSON line on stdout, the exit status, and
// the documents left on disk. Nothing reaches inside the process.
//
// Numbers come from named exports (knobs resolved through the configuration
// model, bank constants) rather than literals, so recalibrating a placeholder
// cannot rewrite the suite.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// (§ `record.js` CLI, § `pause-answer.json`, § Decision bank entry,
//  § `state.json`, § `stoic-pending-pause.json`).
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  BANK_OUTCOMES,
  DECISIONS_IGNORE_LINE,
  NO_GIT_BRANCH_NAME,
} from "../../src/io/bank.js";
import { defaultConfig, resolveKnobs } from "../../src/io/config.js";
import { defaultState } from "../../src/io/state.js";
import { createSandbox } from "../helpers/sandbox.js";
import {
  readState,
  readStateText,
  stateExists,
  writeStateDocument,
} from "../helpers/setup-cli.js";
import {
  PAUSE_CATEGORY,
  PAUSE_FILES,
  PAUSE_SUBCATEGORY,
  answerExists,
  decisionFiles,
  groupOver,
  makeAnswer,
  makePause,
  pauseExists,
  readDecisionText,
  readGitignore,
  recordArgs,
  runRecord,
  stoicDirExists,
  writeAnswerDocument,
  writePauseDocument,
} from "../helpers/record-cli.js";

/**
 * The outcome vocabulary. These four imperatives ARE the thing under test — the
 * choice menu the pause skill offers — so they are spelled out here rather than
 * imported from the entrypoint the suite drives as a child process.
 */
const OUTCOMES = Object.freeze(["keep", "correct", "skip", "defer"]);

/** The outcomes that leave no bank entry, the complement of BANK_OUTCOMES. */
const QUIET_OUTCOMES = Object.freeze(["skip", "defer"]);

/** Consecutive skips that retire a whole category for a while. */
const SKIPS_BEFORE_CATEGORY_MUTE = 3;

/** The knobs an unconfigured project with untouched personal state resolves to. */
const KNOBS = resolveKnobs(defaultConfig(), defaultState());

const CATEGORY_MUTE_HOURS = Math.round(KNOBS.category_mute_ms / 3_600_000);

const CORRECTION = "Scope the read to the tenant and add a report-only role.";
const FOLLOWUP =
  "Add a report_reader role and scope the report query by tenant.";

/** Plant a valid pause and answer; returns the argv for the given outcome. */
function stage(sandbox, { outcome, pause = {}, answer = {} } = {}) {
  const pausePath = writePauseDocument(sandbox, makePause(sandbox, pause));
  if (!BANK_OUTCOMES.includes(outcome)) {
    return recordArgs({ outcome, pause: pausePath });
  }
  const dataPath = writeAnswerDocument(sandbox, makeAnswer(answer));
  return recordArgs({ outcome, pause: pausePath, data: dataPath });
}

/** The mute with a file fingerprint; there is at most one per invocation. */
const fingerprintMute = (state) =>
  state.mutes.find((mute) => Array.isArray(mute.files));

/** The category-wide mute, which the contract spells with `files: null`. */
const categoryMute = (state) => state.mutes.find((mute) => mute.files === null);

/**
 * An expiry stamped during this invocation: the CLI reads its own clock, so the
 * only honest assertion is that it landed inside the window the run spanned.
 */
function assertExpiresWithin(expiresAt, { before, after, windowMs }) {
  assert.ok(
    expiresAt >= before + windowMs && expiresAt <= after + windowMs,
    `expected an expiry ${windowMs}ms after the run, got ${expiresAt}`,
  );
}

/** A rejected request: named error, nothing on disk, the pause still waiting. */
function assertRejected(sandbox, { status, result }, code) {
  assert.equal(status, 2);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
  assert.ok(result.error.message.length > 0);
  assert.deepEqual(result.changed, { bank: "unchanged", state: "unchanged" });
  assert.ok(!stoicDirExists(sandbox));
  assert.ok(!stateExists(sandbox));
}

// ---------------------------------------------------------------------------
// keep and correct — the outcomes that reach the decision bank
// ---------------------------------------------------------------------------

test("keep banks the reflection, mutes the fingerprint, and consumes the pause", (t) => {
  const sandbox = createSandbox(t);
  const args = stage(sandbox, { outcome: "keep" });

  const before = Date.now();
  const { status, result } = runRecord(sandbox, args);
  const after = Date.now();

  assert.equal(status, 0);
  assert.deepEqual(result, { ok: true, outcome: "keep", notices: [] });

  // The bank entry: one file for today and this branch. A bare temp directory
  // is not a repository, so the branch label is the no-git fallback.
  const names = decisionFiles(sandbox);
  assert.equal(names.length, 1);
  assert.ok(names[0].endsWith(`_${NO_GIT_BRANCH_NAME}.md`));

  const entry = readDecisionText(sandbox);
  assert.match(entry, new RegExp(`^branch: ${NO_GIT_BRANCH_NAME}$`, "m"));
  assert.match(
    entry,
    new RegExp(`^## \\d{1,2}:\\d{2} — ${PAUSE_CATEGORY}$`, "m"),
  );
  assert.match(entry, /^- outcome: keep$/m);
  assert.match(entry, new RegExp(`^- subcategory: ${PAUSE_SUBCATEGORY}$`, "m"));
  assert.ok(entry.includes(`- files: ${PAUSE_FILES.join(", ")}`));
  assert.match(entry, /^- trigger: score$/m);
  assert.ok(entry.includes("### Questions"));
  assert.ok(entry.includes(makeAnswer().questions[0]));
  assert.ok(entry.includes("### Answer"));
  assert.ok(entry.includes(makeAnswer().answer));
  // A kept decision was not revised, so the entry ends after its answer.
  assert.ok(!entry.includes("### Correction"));
  assert.ok(!entry.includes("### Follow-up"));

  const state = readState(sandbox);
  assert.equal(state.mutes.length, 1);
  const mute = fingerprintMute(state);
  assert.equal(mute.category, PAUSE_CATEGORY);
  assert.deepEqual(mute.files, [...PAUSE_FILES]);
  assertExpiresWithin(mute.expires_at, {
    before,
    after,
    windowMs: KNOBS.mute_window_ms,
  });
  // Answering invents no skip counter for a category that never had one.
  assert.deepEqual(state.skip_streak, {});
  assert.deepEqual(state.skip_totals, {});

  // Both consumed documents are gone; the deleted pause is the completion mark.
  assert.ok(!pauseExists(sandbox));
  assert.ok(!answerExists(sandbox));
});

test("correct records the revision and the approved follow-up", (t) => {
  const sandbox = createSandbox(t);
  const args = stage(sandbox, {
    outcome: "correct",
    answer: { correction: CORRECTION, followup_prompt: FOLLOWUP },
  });

  const before = Date.now();
  const { status, result } = runRecord(sandbox, args);
  const after = Date.now();

  assert.equal(status, 0);
  assert.deepEqual(result, { ok: true, outcome: "correct", notices: [] });

  const entry = readDecisionText(sandbox);
  assert.match(entry, /^- outcome: correct$/m);
  assert.ok(entry.includes("### Correction"));
  assert.ok(entry.includes(CORRECTION));
  assert.ok(entry.includes("### Follow-up"));
  assert.ok(entry.includes(FOLLOWUP));

  const state = readState(sandbox);
  assert.equal(state.mutes.length, 1);
  assertExpiresWithin(fingerprintMute(state).expires_at, {
    before,
    after,
    windowMs: KNOBS.mute_window_ms,
  });
  assert.deepEqual(fingerprintMute(state).files, [...PAUSE_FILES]);

  assert.ok(!pauseExists(sandbox));
  assert.ok(!answerExists(sandbox));
});

test("correct without an approved follow-up writes no follow-up section", (t) => {
  const sandbox = createSandbox(t);
  const args = stage(sandbox, {
    outcome: "correct",
    answer: { correction: CORRECTION },
  });

  const { status } = runRecord(sandbox, args);

  assert.equal(status, 0);
  const entry = readDecisionText(sandbox);
  assert.ok(entry.includes("### Correction"));
  assert.ok(!entry.includes("### Follow-up"));
});

for (const outcome of BANK_OUTCOMES) {
  test(`${outcome} clears the skip streak of its own category only`, (t) => {
    const sandbox = createSandbox(t);
    writeStateDocument(sandbox, {
      ...defaultState(),
      skip_streak: { [PAUSE_CATEGORY]: 2, architecture: 3 },
      skip_totals: { [PAUSE_CATEGORY]: 6, architecture: 4 },
    });
    const args = stage(sandbox, {
      outcome,
      answer: { correction: CORRECTION },
    });

    const { status } = runRecord(sandbox, args);

    assert.equal(status, 0);
    const state = readState(sandbox);
    assert.deepEqual(state.skip_streak, {
      [PAUSE_CATEGORY]: 0,
      architecture: 3,
    });
    // Answering a pause is not a skip; the lifetime totals never move.
    assert.deepEqual(state.skip_totals, {
      [PAUSE_CATEGORY]: 6,
      architecture: 4,
    });
  });
}

test("the decision bank is kept out of commits end to end", (t) => {
  const sandbox = createSandbox(t);
  const args = stage(sandbox, { outcome: "keep" });

  runRecord(sandbox, args);

  assert.match(
    readGitignore(sandbox),
    new RegExp(`^${DECISIONS_IGNORE_LINE}$`, "m"),
  );
});

// ---------------------------------------------------------------------------
// skip — the streak-advancing outcome
// ---------------------------------------------------------------------------

test("skip mutes the fingerprint and advances the streak without banking", (t) => {
  const sandbox = createSandbox(t);
  const args = stage(sandbox, { outcome: "skip" });

  const before = Date.now();
  const { status, result } = runRecord(sandbox, args);
  const after = Date.now();

  assert.equal(status, 0);
  assert.deepEqual(result, { ok: true, outcome: "skip", notices: [] });
  assert.deepEqual(decisionFiles(sandbox), []);

  const state = readState(sandbox);
  assert.equal(state.mutes.length, 1);
  assertExpiresWithin(fingerprintMute(state).expires_at, {
    before,
    after,
    windowMs: KNOBS.mute_window_ms,
  });
  assert.deepEqual(state.skip_streak, { [PAUSE_CATEGORY]: 1 });
  assert.deepEqual(state.skip_totals, { [PAUSE_CATEGORY]: 1 });
  assert.ok(!pauseExists(sandbox));
});

test("the third consecutive skip retires the category and says so", (t) => {
  const sandbox = createSandbox(t);
  writeStateDocument(sandbox, {
    ...defaultState(),
    skip_streak: { [PAUSE_CATEGORY]: SKIPS_BEFORE_CATEGORY_MUTE - 1 },
    skip_totals: { [PAUSE_CATEGORY]: 7 },
  });
  const args = stage(sandbox, { outcome: "skip" });

  const before = Date.now();
  const { status, result } = runRecord(sandbox, args);
  const after = Date.now();

  assert.equal(status, 0);
  assert.equal(result.ok, true);

  const state = readState(sandbox);
  assert.equal(state.mutes.length, 2);
  assertExpiresWithin(fingerprintMute(state).expires_at, {
    before,
    after,
    windowMs: KNOBS.mute_window_ms,
  });

  const wide = categoryMute(state);
  assert.equal(wide.category, PAUSE_CATEGORY);
  assert.equal(wide.files, null);
  assertExpiresWithin(wide.expires_at, {
    before,
    after,
    windowMs: KNOBS.category_mute_ms,
  });

  // The streak restarts, but the lifetime count keeps counting.
  assert.deepEqual(state.skip_streak, { [PAUSE_CATEGORY]: 0 });
  assert.deepEqual(state.skip_totals, { [PAUSE_CATEGORY]: 8 });

  assert.equal(result.notices.length, 1);
  assert.ok(result.notices[0].includes(PAUSE_CATEGORY));
  assert.ok(result.notices[0].includes(String(CATEGORY_MUTE_HOURS)));
  assert.match(result.notices[0], /setup/);
});

test("a skip leaves another category's streak alone", (t) => {
  const sandbox = createSandbox(t);
  writeStateDocument(sandbox, {
    ...defaultState(),
    skip_streak: { architecture: SKIPS_BEFORE_CATEGORY_MUTE - 1 },
  });
  const args = stage(sandbox, { outcome: "skip" });

  const { status, result } = runRecord(sandbox, args);

  assert.equal(status, 0);
  assert.deepEqual(result.notices, []);
  const state = readState(sandbox);
  assert.deepEqual(state.skip_streak, { architecture: 2, [PAUSE_CATEGORY]: 1 });
  // No category mute: the streak that matters is the one being skipped.
  assert.equal(state.mutes.length, 1);
  assert.equal(categoryMute(state), undefined);
});

// ---------------------------------------------------------------------------
// defer — "later", not "not this topic"
// ---------------------------------------------------------------------------

test("defer mutes the fingerprint and never touches the skip history", (t) => {
  const sandbox = createSandbox(t);
  writeStateDocument(sandbox, {
    ...defaultState(),
    skip_streak: { [PAUSE_CATEGORY]: 2 },
    skip_totals: { [PAUSE_CATEGORY]: 5 },
  });
  const args = stage(sandbox, { outcome: "defer" });

  const before = Date.now();
  const { status, result } = runRecord(sandbox, args);
  const after = Date.now();

  assert.equal(status, 0);
  assert.deepEqual(result, { ok: true, outcome: "defer", notices: [] });
  assert.deepEqual(decisionFiles(sandbox), []);

  const state = readState(sandbox);
  assert.equal(state.mutes.length, 1);
  assertExpiresWithin(fingerprintMute(state).expires_at, {
    before,
    after,
    windowMs: KNOBS.mute_window_ms,
  });
  assert.deepEqual(state.skip_streak, { [PAUSE_CATEGORY]: 2 });
  assert.deepEqual(state.skip_totals, { [PAUSE_CATEGORY]: 5 });
  assert.ok(!pauseExists(sandbox));
});

// ---------------------------------------------------------------------------
// Fingerprint shapes and the categoryless pause
// ---------------------------------------------------------------------------

test("a prompt-only pause stores an empty fingerprint rather than none", (t) => {
  const sandbox = createSandbox(t);
  const args = stage(sandbox, {
    outcome: "skip",
    pause: { group: groupOver([]) },
  });

  const { status } = runRecord(sandbox, args);

  assert.equal(status, 0);
  const state = readState(sandbox);
  assert.equal(state.mutes.length, 1);
  // Empty is not null: an empty stored fingerprint is category-scoped for its
  // short window, which is what stops the identical pause re-firing every turn.
  assert.deepEqual(state.mutes[0].files, []);
  assert.equal(state.mutes[0].category, PAUSE_CATEGORY);
});

const manualPause = { trigger: "manual", classification: undefined };

test("a manual categoryless keep is banked without any mute", (t) => {
  const sandbox = createSandbox(t);
  writeStateDocument(sandbox, {
    ...defaultState(),
    skip_streak: { [PAUSE_CATEGORY]: 2 },
  });
  const args = stage(sandbox, { outcome: "keep", pause: manualPause });

  const { status, result } = runRecord(sandbox, args);

  assert.equal(status, 0);
  assert.deepEqual(result, { ok: true, outcome: "keep", notices: [] });

  const entry = readDecisionText(sandbox);
  assert.match(entry, /^## \d{1,2}:\d{2} — manual$/m);
  assert.match(entry, /^- trigger: manual$/m);
  assert.ok(!entry.includes("- subcategory:"));

  // Mutes and streaks both key on a category, so a categoryless reflection
  // updates neither.
  const state = readState(sandbox);
  assert.deepEqual(state.mutes, []);
  assert.deepEqual(state.skip_streak, { [PAUSE_CATEGORY]: 2 });
  assert.deepEqual(state.skip_totals, {});
  assert.ok(!pauseExists(sandbox));
});

for (const outcome of QUIET_OUTCOMES) {
  test(`${outcome} on a manual pause consumes it and changes nothing else`, (t) => {
    const sandbox = createSandbox(t);
    writeStateDocument(sandbox, {
      ...defaultState(),
      skip_streak: { [PAUSE_CATEGORY]: 2 },
      skip_totals: { [PAUSE_CATEGORY]: 4 },
    });
    const args = stage(sandbox, { outcome, pause: manualPause });

    const { status, result } = runRecord(sandbox, args);

    assert.equal(status, 0);
    assert.deepEqual(result, { ok: true, outcome, notices: [] });
    assert.deepEqual(decisionFiles(sandbox), []);

    const state = readState(sandbox);
    assert.deepEqual(state.mutes, []);
    assert.deepEqual(state.skip_streak, { [PAUSE_CATEGORY]: 2 });
    assert.deepEqual(state.skip_totals, { [PAUSE_CATEGORY]: 4 });
    assert.ok(!pauseExists(sandbox));
  });
}

// ---------------------------------------------------------------------------
// What recording must never touch
// ---------------------------------------------------------------------------

for (const outcome of OUTCOMES) {
  test(`${outcome} neither reads nor rewrites the score`, (t) => {
    const sandbox = createSandbox(t);
    writeStateDocument(sandbox, {
      ...defaultState(),
      score: 3.25,
      last_update: 1_700_000_000_000,
      preset: "vigilant",
    });
    const args = stage(sandbox, {
      outcome,
      answer: { correction: CORRECTION },
    });

    const { status } = runRecord(sandbox, args);

    assert.equal(status, 0);
    const state = readState(sandbox);
    assert.equal(state.score, 3.25);
    assert.equal(state.last_update, 1_700_000_000_000);
    // The personal preset override is not the recorder's to drop either.
    assert.equal(state.preset, "vigilant");
    // Byte evidence, not just a parsed number: the score was never recomputed.
    assert.ok(readStateText(sandbox).includes("3.25"));
  });
}

test("existing mutes are preserved and expired ones are not pruned", (t) => {
  const sandbox = createSandbox(t);
  const expired = {
    category: "architecture",
    files: ["src/legacy.js"],
    expires_at: 1,
  };
  const active = {
    category: "api_integration",
    files: null,
    expires_at: 4_000_000_000_000,
  };
  writeStateDocument(sandbox, { ...defaultState(), mutes: [expired, active] });
  const args = stage(sandbox, { outcome: "skip" });

  const { status } = runRecord(sandbox, args);

  assert.equal(status, 0);
  const state = readState(sandbox);
  assert.equal(state.mutes.length, 3);
  // Pruning belongs to the Stop hook; recording only appends.
  assert.deepEqual(state.mutes[0], expired);
  assert.deepEqual(state.mutes[1], active);
});

// ---------------------------------------------------------------------------
// Rejected requests write nothing
// ---------------------------------------------------------------------------

test("the past-tense vocabulary is not accepted", (t) => {
  const sandbox = createSandbox(t);
  const pausePath = writePauseDocument(sandbox, makePause(sandbox));
  const dataPath = writeAnswerDocument(sandbox, makeAnswer());

  for (const outcome of ["kept", "corrected", "skipped", "deferred", "keeep"]) {
    const run = runRecord(
      sandbox,
      recordArgs({ outcome, pause: pausePath, data: dataPath }),
    );
    assertRejected(sandbox, run, "usage");
  }
  assert.ok(pauseExists(sandbox));
});

test("a request missing its outcome or its pause is a usage error", (t) => {
  const sandbox = createSandbox(t);
  const pausePath = writePauseDocument(sandbox, makePause(sandbox));
  const dataPath = writeAnswerDocument(sandbox, makeAnswer());

  for (const args of [
    recordArgs({ pause: pausePath, data: dataPath }),
    recordArgs({ outcome: "skip" }),
    recordArgs({}),
    [...recordArgs({ outcome: "skip", pause: pausePath }), "--turbo"],
  ]) {
    assertRejected(sandbox, runRecord(sandbox, args), "usage");
  }
  assert.ok(pauseExists(sandbox));
});

for (const outcome of BANK_OUTCOMES) {
  test(`${outcome} without the answer file is a usage error`, (t) => {
    const sandbox = createSandbox(t);
    const pausePath = writePauseDocument(sandbox, makePause(sandbox));

    const run = runRecord(sandbox, recordArgs({ outcome, pause: pausePath }));

    assertRejected(sandbox, run, "usage");
    assert.ok(pauseExists(sandbox));
  });
}

for (const outcome of QUIET_OUTCOMES) {
  test(`${outcome} refuses an answer file it would never read`, (t) => {
    const sandbox = createSandbox(t);
    const pausePath = writePauseDocument(sandbox, makePause(sandbox));
    const dataPath = writeAnswerDocument(sandbox, makeAnswer());

    const run = runRecord(
      sandbox,
      recordArgs({ outcome, pause: pausePath, data: dataPath }),
    );

    assertRejected(sandbox, run, "usage");
    assert.ok(pauseExists(sandbox));
    assert.ok(answerExists(sandbox));
  });
}

test("an unusable pause document is rejected before anything is written", (t) => {
  const sandbox = createSandbox(t);
  const dataPath = writeAnswerDocument(sandbox, makeAnswer());

  const cases = [
    null, // no document at all
    "{ not json at all",
    JSON.stringify([1, 2, 3]),
    makePause(sandbox, { cwd: undefined }),
    makePause(sandbox, { cwd: "" }),
    makePause(sandbox, { cwd: 42 }),
  ];

  for (const contents of cases) {
    const pausePath = writePauseDocument(sandbox, contents ?? "");
    if (contents === null) {
      fs.rmSync(pausePath);
    }
    const run = runRecord(
      sandbox,
      recordArgs({ outcome: "keep", pause: pausePath, data: dataPath }),
    );
    assertRejected(sandbox, run, "invalid_pause");
  }
  assert.ok(answerExists(sandbox));
});

test("an unusable answer file is rejected before anything is written", (t) => {
  const sandbox = createSandbox(t);
  const pausePath = writePauseDocument(sandbox, makePause(sandbox));

  const cases = [null, "{ mangled", JSON.stringify(["a"]), '"just a string"'];

  for (const contents of cases) {
    const dataPath = writeAnswerDocument(sandbox, contents ?? "");
    if (contents === null) {
      fs.rmSync(dataPath);
    }
    const run = runRecord(
      sandbox,
      recordArgs({ outcome: "keep", pause: pausePath, data: dataPath }),
    );
    assertRejected(sandbox, run, "invalid_data");
  }
  // Nothing was consumed, so the user can answer again.
  assert.ok(pauseExists(sandbox));
});

test("a consumed pause cannot be recorded twice", (t) => {
  const sandbox = createSandbox(t);
  const args = stage(sandbox, { outcome: "keep" });

  assert.equal(runRecord(sandbox, args).status, 0);
  const banked = readDecisionText(sandbox);
  const stateAfterFirst = readStateText(sandbox);

  const second = runRecord(sandbox, args);

  // The deleted pause IS the completion marker: a replay is not a second entry.
  assert.equal(second.status, 2);
  assert.equal(second.result.ok, false);
  assert.equal(second.result.error.code, "invalid_pause");
  assert.deepEqual(second.result.changed, {
    bank: "unchanged",
    state: "unchanged",
  });
  assert.equal(readDecisionText(sandbox), banked);
  assert.equal(readStateText(sandbox), stateAfterFirst);
});

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

test("every invocation prints exactly one JSON line and no filesystem location", (t) => {
  const sandbox = createSandbox(t);
  const pausePath = writePauseDocument(sandbox, makePause(sandbox));
  const dataPath = writeAnswerDocument(sandbox, makeAnswer());

  for (const args of [
    recordArgs({ outcome: "kept", pause: pausePath, data: dataPath }),
    recordArgs({ outcome: "keep" }),
    recordArgs({ outcome: "skip", pause: dataPath }),
    recordArgs({ outcome: "skip", pause: pausePath, data: dataPath }),
    // The successful run goes last: it consumes both documents.
    recordArgs({ outcome: "keep", pause: pausePath, data: dataPath }),
  ]) {
    const { stdout, result } = runRecord(sandbox, args);
    assert.equal(stdout.trimEnd().split("\n").length, 1);
    const json = JSON.stringify(result);
    assert.ok(!json.includes(sandbox.projectDir));
    assert.ok(!json.includes(sandbox.homeDir));
    assert.ok(!json.includes(".stoic"));
  }
});
