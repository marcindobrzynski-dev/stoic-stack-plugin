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
import path from "node:path";
import { test } from "node:test";

import { BANK_OUTCOMES, NO_GIT_BRANCH_NAME } from "../../src/io/bank.js";
import {
  SKIPS_BEFORE_CATEGORY_MUTE,
  defaultConfig,
  resolveKnobs,
} from "../../src/io/config/config.js";
import { resolveManualReflection } from "../../src/io/config/manual-reflection.js";
import { rewardedScore } from "../../src/core/scoring.js";
import { personalStateDir, projectDecisionsDir } from "../../src/io/paths.js";
import { DECISIONS_IGNORE_LINE } from "../../src/io/stoic-ignore.js";
import { defaultState } from "../../src/io/state.js";
import {
  assertExpiresWithin,
  categoryMute,
  fingerprintMute,
} from "../helpers/mute.js";
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

  const startedAt = Date.now();
  const { status, result } = runRecord(sandbox, args);
  const finishedAt = Date.now();

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
    startedAt,
    finishedAt,
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

  const startedAt = Date.now();
  const { status, result } = runRecord(sandbox, args);
  const finishedAt = Date.now();

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
    startedAt,
    finishedAt,
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

// ---------------------------------------------------------------------------
// pause-answer.json — the answer contract, pinned from the only side a test can
// reach. Both cases below are characterization, not red-green: they pass
// against today's reader. Their job is that changing part 3b must touch this
// file, per architecture/testing.md ("changing a contract without updating its
// test must fail the local suite"). The writer is prose
// (skills/stoic-pause/SKILL.md), so no test can hold it to the key set; that
// half stays a manual re-check, like the
// SKILL.md <-> blockReason() pairing architecture/components.md already
// records.
// ---------------------------------------------------------------------------

/**
 * The frozen key set of `pause-answer.json` (payloads.md § part 3b). Spelled
 * out rather than imported: it IS the contract under test, like OUTCOMES above.
 */
const ANSWER_CONTRACT_KEYS = Object.freeze([
  "answer",
  "correction",
  "followup_prompt",
  "questions",
]);

/** The two optional fields, which only a `correct` carries. */
const FULL_ANSWER = Object.freeze({
  correction: CORRECTION,
  followup_prompt: FOLLOWUP,
});

/** A field no version of the contract names, as a stray skill might emit. */
const UNKNOWN_FIELD = "confidence_note";
const UNKNOWN_VALUE = "unsure about the second question";

test("every field the answer contract names reaches the bank entry", (t) => {
  const sandbox = createSandbox(t);
  // The pin: a field added to the contract fails here until it is consumed.
  assert.deepEqual(Object.keys(makeAnswer(FULL_ANSWER)).sort(), [
    ...ANSWER_CONTRACT_KEYS,
  ]);

  const args = stage(sandbox, { outcome: "correct", answer: FULL_ANSWER });

  const { status } = runRecord(sandbox, args);

  assert.equal(status, 0);
  const entry = readDecisionText(sandbox);
  for (const question of makeAnswer().questions) {
    assert.ok(entry.includes(question));
  }
  assert.ok(entry.includes(makeAnswer().answer));
  assert.ok(entry.includes(CORRECTION));
  assert.ok(entry.includes(FOLLOWUP));
});

test("an answer field the contract does not name is ignored, not fatal", (t) => {
  const sandbox = createSandbox(t);
  const args = stage(sandbox, {
    outcome: "correct",
    answer: { ...FULL_ANSWER, [UNKNOWN_FIELD]: UNKNOWN_VALUE },
  });

  const { status, result } = runRecord(sandbox, args);

  // Leniency is the deliberate choice (src/cli/record.js § readAnswer): the
  // file is written by a model, and a stray field must not cost the developer
  // the reflection they just wrote. Pinned so hardening it is a decision.
  assert.equal(status, 0);
  assert.deepEqual(result, { ok: true, outcome: "correct", notices: [] });

  const entry = readDecisionText(sandbox);
  assert.ok(!entry.includes(UNKNOWN_FIELD));
  assert.ok(!entry.includes(UNKNOWN_VALUE));
  // The named fields are unaffected by the stranger beside them.
  assert.ok(entry.includes(CORRECTION));
  assert.ok(entry.includes(FOLLOWUP));

  assert.ok(!pauseExists(sandbox));
  assert.ok(!answerExists(sandbox));
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

  const lines = readGitignore(sandbox).split("\n");
  assert.ok(lines.includes(DECISIONS_IGNORE_LINE), lines.join("\n"));
});

// ---------------------------------------------------------------------------
// skip — the streak-advancing outcome
// ---------------------------------------------------------------------------

test("skip mutes the fingerprint and advances the streak without banking", (t) => {
  const sandbox = createSandbox(t);
  const args = stage(sandbox, { outcome: "skip" });

  const startedAt = Date.now();
  const { status, result } = runRecord(sandbox, args);
  const finishedAt = Date.now();

  assert.equal(status, 0);
  assert.deepEqual(result, { ok: true, outcome: "skip", notices: [] });
  assert.deepEqual(decisionFiles(sandbox), []);

  const state = readState(sandbox);
  assert.equal(state.mutes.length, 1);
  assertExpiresWithin(fingerprintMute(state).expires_at, {
    startedAt,
    finishedAt,
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

  const startedAt = Date.now();
  const { status, result } = runRecord(sandbox, args);
  const finishedAt = Date.now();

  assert.equal(status, 0);
  assert.equal(result.ok, true);

  const state = readState(sandbox);
  assert.equal(state.mutes.length, 2);
  assertExpiresWithin(fingerprintMute(state).expires_at, {
    startedAt,
    finishedAt,
    windowMs: KNOBS.mute_window_ms,
  });

  const wide = categoryMute(state);
  assert.equal(wide.category, PAUSE_CATEGORY);
  assert.equal(wide.files, null);
  assertExpiresWithin(wide.expires_at, {
    startedAt,
    finishedAt,
    windowMs: KNOBS.category_mute_ms,
  });

  // The streak restarts, but the lifetime count keeps counting.
  assert.deepEqual(state.skip_streak, { [PAUSE_CATEGORY]: 0 });
  assert.deepEqual(state.skip_totals, { [PAUSE_CATEGORY]: 8 });

  assert.equal(result.notices.length, 1);
  assert.ok(result.notices[0].includes(PAUSE_CATEGORY));
  assert.ok(result.notices[0].includes(String(CATEGORY_MUTE_HOURS)));
  // The shipped skill is `stoic-setup`; `/setup/` would also match the
  // dead `/stoic-stack:setup` command.
  assert.match(result.notices[0], /\/stoic-stack:stoic-setup/);
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

  const startedAt = Date.now();
  const { status, result } = runRecord(sandbox, args);
  const finishedAt = Date.now();

  assert.equal(status, 0);
  assert.deepEqual(result, { ok: true, outcome: "defer", notices: [] });
  assert.deepEqual(decisionFiles(sandbox), []);

  const state = readState(sandbox);
  assert.equal(state.mutes.length, 1);
  assertExpiresWithin(fingerprintMute(state).expires_at, {
    startedAt,
    finishedAt,
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
// The score — the recorder's one write, and everywhere it must not happen
//
// A completed manual reflection is the single case in which this CLI touches
// the score. The whole trigger-by-outcome matrix is asserted below, because the
// value of the rule is in what it excludes.
// ---------------------------------------------------------------------------

/** A personal preset that is not the default, so the reward follows the state. */
const SEED_PRESET = "vigilant";

/** A timestamp no arithmetic here would ever produce, so a rewrite would show. */
const SEED_LAST_UPDATE = 1_700_000_000_000;

/** The state document a score test starts from, at whatever score it needs. */
const seededState = (score) => ({
  ...defaultState(),
  score,
  last_update: SEED_LAST_UPDATE,
  preset: SEED_PRESET,
});

/**
 * The three numbers the reward is made of, resolved exactly as the CLI resolves
 * them: the sandbox holds no configuration file, so `defaultConfig()` is what a
 * run there reads, and the seeded preset is what steers it.
 */
const MANUAL_SETTINGS = resolveManualReflection(
  defaultConfig(),
  seededState(0),
);

/** Where the automatic relief would leave a score: threshold x cooldown ratio. */
const MANUAL_CAP = MANUAL_SETTINGS.threshold * MANUAL_SETTINGS.cooldown_ratio;

/**
 * A score comfortably below the cap. This is the case that motivated the
 * feature: the automatic path would leave it exactly where it stands, so every
 * bit of movement here is the reward and nothing else.
 */
const CALM_SCORE = MANUAL_CAP / 2;

/** A score well above the cap, where the cap bites before the reward does. */
const LOUD_SCORE = MANUAL_CAP * 3;

/** What a completed manual reflection must leave behind, from the same formula. */
const rewardOf = (score) =>
  rewardedScore(score, MANUAL_SETTINGS.threshold, MANUAL_SETTINGS);

for (const outcome of BANK_OUTCOMES) {
  test(`a manual pause completed as ${outcome} relieves a score the automatic path would have left alone`, (t) => {
    const sandbox = createSandbox(t);
    writeStateDocument(sandbox, seededState(CALM_SCORE));
    const args = stage(sandbox, {
      outcome,
      pause: manualPause,
      answer: { correction: CORRECTION },
    });

    const { status } = runRecord(sandbox, args);

    assert.equal(status, 0);
    const state = readState(sandbox);
    assert.equal(state.score, rewardOf(CALM_SCORE));
    // The asymmetry is the feature: below the cap the fire-time relief is a
    // no-op, so a reward that changed nothing here would be no reward at all.
    assert.ok(state.score < CALM_SCORE);
    // Relief is the only thing that moves. The clock belongs to the Stop hook,
    // and a personal preset is not the recorder's to drop.
    assert.equal(state.last_update, SEED_LAST_UPDATE);
    assert.equal(state.preset, SEED_PRESET);
    // A manual reflection is categoryless, so it still leaves no Mute behind.
    assert.deepEqual(state.mutes, []);
    // The reward rides along with the recording; it does not replace it.
    assert.match(readDecisionText(sandbox), /^- trigger: manual$/m);
    assert.ok(!pauseExists(sandbox));
  });
}

test("a manual reflection completed far over the threshold is capped before it is rewarded", (t) => {
  const sandbox = createSandbox(t);
  writeStateDocument(sandbox, seededState(LOUD_SCORE));
  const args = stage(sandbox, { outcome: "keep", pause: manualPause });

  const { status } = runRecord(sandbox, args);

  assert.equal(status, 0);
  const state = readState(sandbox);
  assert.equal(state.score, rewardOf(LOUD_SCORE));
  // Strictly under the cap the automatic path would have stopped at: the two
  // steps compose, so a loud score is not merely brought back to the ceiling.
  assert.ok(state.score < MANUAL_CAP);
});

for (const outcome of QUIET_OUTCOMES) {
  test(`${outcome} on a manual pause earns no relief at all`, (t) => {
    const sandbox = createSandbox(t);
    writeStateDocument(sandbox, seededState(CALM_SCORE));
    const args = stage(sandbox, { outcome, pause: manualPause });

    const { status } = runRecord(sandbox, args);

    assert.equal(status, 0);
    const state = readState(sandbox);
    // Asking and then withdrawing is not reflecting. Rewarding the request
    // rather than the completion would make "invoke the skill, press Escape"
    // the cheapest score in the plugin.
    assert.equal(state.score, CALM_SCORE);
    assert.equal(state.last_update, SEED_LAST_UPDATE);
    assert.ok(readStateText(sandbox).includes(String(CALM_SCORE)));
  });
}

// ---------------------------------------------------------------------------
// What recording must never touch
// ---------------------------------------------------------------------------

/** The two gates the engine fires on its own initiative, neither of them earned. */
const AUTOMATIC_TRIGGERS = Object.freeze(["score", "critical_path"]);

for (const trigger of AUTOMATIC_TRIGGERS) {
  for (const outcome of OUTCOMES) {
    test(`${outcome} on a ${trigger} pause neither reads nor rewrites the score`, (t) => {
      const sandbox = createSandbox(t);
      writeStateDocument(sandbox, seededState(CALM_SCORE));
      const args = stage(sandbox, {
        outcome,
        pause: { trigger },
        answer: { correction: CORRECTION },
      });

      const { status } = runRecord(sandbox, args);

      assert.equal(status, 0);
      const state = readState(sandbox);
      // The Stop hook already relieved this pause when it fired it. A second
      // relief for answering one the developer never asked for would pay twice.
      assert.equal(state.score, CALM_SCORE);
      assert.equal(state.last_update, SEED_LAST_UPDATE);
      // The personal preset override is not the recorder's to drop either.
      assert.equal(state.preset, SEED_PRESET);
      // Byte evidence, not just a parsed number: the score was never recomputed.
      assert.ok(readStateText(sandbox).includes(String(CALM_SCORE)));
    });
  }
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
// Persistence failures report honestly what had already landed
// ---------------------------------------------------------------------------

/**
 * Make a directory the CLI must own impossible to create, by planting a plain
 * file at its path. The wrong kind of inode is the portable way to fail a
 * write: it needs no privileged user, it survives an unprivileged CI account
 * that permission bits would not stop, and it fails identically on Windows and
 * POSIX (`EEXIST` on the directory itself, `ENOTDIR` on anything beneath it).
 */
function blockDirectory(dirPath) {
  fs.mkdirSync(path.dirname(dirPath), { recursive: true });
  fs.writeFileSync(dirPath, "", "utf8");
}

test("a bank write that cannot land changes nothing else", (t) => {
  const sandbox = createSandbox(t);
  const args = stage(sandbox, { outcome: "keep" });
  blockDirectory(projectDecisionsDir(sandbox.projectDir));

  const { status, result } = runRecord(sandbox, args);

  // 1, not 2: the request was fine and the failure was persistence.
  assert.equal(status, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "bank_write_failed");
  assert.ok(result.error.message.length > 0);
  // The reflection is written first precisely so that losing it costs nothing
  // else: no mute, no streak, no state document at all.
  assert.deepEqual(result.changed, { bank: "unchanged", state: "unchanged" });
  assert.deepEqual(decisionFiles(sandbox), []);
  assert.ok(!stateExists(sandbox));
  // The deleted pause is the completion mark, so a failed recording leaves both
  // documents where they were and the developer can answer again.
  assert.ok(pauseExists(sandbox));
  assert.ok(answerExists(sandbox));
});

test("a state save that cannot land still owns up to the banked reflection", (t) => {
  const sandbox = createSandbox(t);
  const args = stage(sandbox, { outcome: "keep" });
  blockDirectory(personalStateDir(sandbox.projectDir, sandbox.homeDir));

  const { status, result } = runRecord(sandbox, args);

  assert.equal(status, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "state_save_failed");
  assert.ok(result.error.message.length > 0);
  // Honest rather than tidy: the bank write precedes the save, so a partial run
  // reports the entry it really did make instead of claiming a clean slate.
  assert.deepEqual(result.changed, { bank: "written", state: "unchanged" });
  assert.match(readDecisionText(sandbox), /^- outcome: keep$/m);
  assert.ok(!stateExists(sandbox));
  // Consumption comes after the save — `payloads.md` makes the state save the
  // last step that can fail a run and deleting both documents a notice after
  // it, which is why `changed.state` has no `"saved"` arm. So a failed save
  // leaves the pause answerable rather than silently consumed, at the price of
  // a second entry if the same pause is recorded again.
  assert.ok(pauseExists(sandbox));
  assert.ok(answerExists(sandbox));
});

test("a state save that cannot land claims no bank entry it never wrote", (t) => {
  const sandbox = createSandbox(t);
  const args = stage(sandbox, { outcome: "skip" });
  blockDirectory(personalStateDir(sandbox.projectDir, sandbox.homeDir));

  const { status, result } = runRecord(sandbox, args);

  assert.equal(status, 1);
  assert.equal(result.error.code, "state_save_failed");
  // A quiet outcome reaches no bank, so the same failure reports it unchanged.
  assert.deepEqual(result.changed, { bank: "unchanged", state: "unchanged" });
  assert.deepEqual(decisionFiles(sandbox), []);
  assert.ok(pauseExists(sandbox));
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
