// The whole manual loop, driven as real processes: the developer asks for a
// reflection, answers it, and the recorder settles what the answer was worth.
//
// The automatic suite beside this one starts at a hook the engine fired. This
// one has no hook in its main chain at all — the developer's own writer opens
// the pause, which is the entire difference the feature exists to make. What is
// genuine here is everything: a real git repository whose lines this file wrote,
// the real `src/cli/reflect.js` measuring it, and the real `src/cli/record.js`
// handed THAT run's document path — never a fabricated one — reading a document
// no test assembled.
//
// Two artifacts are staged rather than produced, for the same reason as in the
// automatic suite: `pause-answer.json` is written by a skill, which is prose for
// a model and cannot be spawned, and the seeded `state.json` stands in for the
// turns that would have raised a score. The file PASSING is the seam under test,
// not the conversation that filled it in.
//
// The suite proves the seams, not the variants. What git measures is covered
// against the writer alone in ../cli/reflect.test.js, and the reward's algebra
// against the recorder alone in ../cli/record.test.js. What only a chain of real
// processes can show is that the two documents join up — that the numbers git
// measured survive into a bank entry, and that the score the recorder moves is
// the one the writer's own configuration resolution predicts.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §`stoic-manual-pause.json`, §`record.js` CLI, §`pause-answer.json`,
// §"Decision bank entry" and §`state.json`; and architecture/configuration.md
// §Score relief, which names the recorder as the second writer of the score.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { rewardedScore } from "../../src/core/scoring.js";
import { defaultConfig } from "../../src/io/config/config.js";
import {
  MANUAL_RELIEF_FACTOR,
  resolveManualReflection,
} from "../../src/io/config/manual-reflection.js";
import { appendSessionEvent } from "../../src/io/session-log.js";
import { defaultState } from "../../src/io/state.js";
import { VERDICT_SCENARIOS } from "../fixtures/classifier-verdicts.js";
import { hookEntrypoint } from "../helpers/capture-hook.js";
import { claudeShimEnv } from "../helpers/claude-shim.js";
import {
  BASELINE_FILE,
  commitAll,
  git,
  initRepo,
  writeLines,
} from "../helpers/git-repo.js";
import {
  answerExists,
  decisionFiles,
  makeAnswer,
  readDecisionText,
  recordArgs,
  runRecord,
  writeAnswerDocument,
  PAUSE_CATEGORY,
} from "../helpers/record-cli.js";
import {
  manualPauseExists,
  manualPauseFile,
  pendingPauseFile,
  readManualPause,
  readPendingPauseText,
  runReflect,
} from "../helpers/reflect-cli.js";
import { createSandbox } from "../helpers/sandbox.js";
import {
  readState,
  writeConfigDocument,
  writeStateDocument,
} from "../helpers/setup-cli.js";

/** The trigger the writer stamps, and the only one the recorder rewards. */
const MANUAL_TRIGGER = "manual";

/** The heading a categoryless reflection is filed under in the bank. */
const MANUAL_HEADING = /^## \d{1,2}:\d{2} — manual$/m;

/** The bank's placeholder for a Decision that touched no named file. */
const NO_FILES = /^- files: none$/m;

const SESSION_ID = "session-manual-loop-1";

/**
 * The baseline README, rewritten in the working tree and left unstaged: against
 * the three baseline lines this replaces one and appends one, so git measures
 * two added and one removed.
 */
const EDITED_README = Object.freeze(["alpha", "BETA", "gamma", "delta"]);
const EDITED_README_COUNTS = Object.freeze({
  lines_added: 2,
  lines_removed: 1,
});

/** A brand-new file, staged, so the chain carries both halves of `diff HEAD`. */
const STAGED_FILE = "src/auth/roles.js";
const STAGED_LINES = Object.freeze([
  "export const READER = 'reader';",
  "export const ADMIN = 'admin';",
]);

/** The correction and follow-up a `correct` outcome must carry into the bank. */
const CORRECTION = "Scope the role to the tenant the request already resolved.";
const FOLLOWUP = "Narrow the reader role to one tenant and re-run the suite.";

/** A personal preset that is not the default, so the reward follows the state. */
const SEED_PRESET = "vigilant";

/** A timestamp no arithmetic here would ever produce, so a rewrite would show. */
const SEED_LAST_UPDATE = 1_700_000_000_000;

/** A file matching the default `critical_paths` keyword `auth` — the hard gate. */
const WATCHED_FILE = STAGED_FILE;

/** The state document a chain starts from, at whatever score it needs. */
const seededState = (score) => ({
  ...defaultState(),
  score,
  last_update: SEED_LAST_UPDATE,
  preset: SEED_PRESET,
});

/**
 * The three numbers the reward is made of, resolved exactly as the CLI resolves
 * them: no configuration file exists in a fresh sandbox, so `defaultConfig()` is
 * what a run there reads, and the seeded preset is what steers it.
 */
const MANUAL_SETTINGS = resolveManualReflection(
  defaultConfig(),
  seededState(0),
);

/** Where the automatic relief would stop: threshold times the cooldown ratio. */
const MANUAL_CAP = MANUAL_SETTINGS.threshold * MANUAL_SETTINGS.cooldown_ratio;

/**
 * A score comfortably below the cap — the case the feature exists for, since
 * the automatic path would leave it exactly where it stands.
 */
const CALM_SCORE = MANUAL_CAP / 2;

/**
 * What a completed reflection must leave behind, composed from the exported
 * formula and the state the recorder itself would have read.
 *
 * @param {object} before - The state document as it stood before recording.
 * @param {object} [config] - The configuration the run resolves against.
 * @returns {number} The rewarded score.
 */
function rewardFor(before, config = defaultConfig()) {
  const settings = resolveManualReflection(config, before);
  return rewardedScore(before.score, settings.threshold, settings);
}

/** A repository holding the baseline commit, and a score worth relieving. */
function repoSandbox(t, stateOverrides = {}) {
  const sandbox = createSandbox(t);
  initRepo(sandbox.projectDir, sandbox.env);
  writeStateDocument(sandbox, {
    ...seededState(CALM_SCORE),
    ...stateOverrides,
  });
  return sandbox;
}

/**
 * Put real work in the tree — one tracked file edited, one new file staged —
 * and return the counts git must be measured to agree with.
 */
function stageWork(sandbox) {
  writeLines(path.join(sandbox.projectDir, BASELINE_FILE), [...EDITED_README]);
  writeLines(path.join(sandbox.projectDir, STAGED_FILE), [...STAGED_LINES]);
  git(sandbox.projectDir, ["add", "--", STAGED_FILE], sandbox.env);
  return {
    [BASELINE_FILE]: { ...EDITED_README_COUNTS },
    [STAGED_FILE]: { lines_added: STAGED_LINES.length, lines_removed: 0 },
  };
}

/** The measured edits keyed by path, so no assertion depends on git's order. */
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

/**
 * Run the real writer and hand back the path IT reported, read off the
 * contractual stderr line rather than recomputed — that hand-off is the seam
 * the rest of the chain hangs from.
 */
function reflectNow(sandbox) {
  const run = runReflect(sandbox);
  assert.equal(run.status, 0, `reflect.js failed, stderr:\n${run.stderr}`);
  const [, reported] = /manual pause: (.+)\r?\n/.exec(run.stderr) ?? [];
  assert.ok(
    reported,
    `reflect.js must name the document it wrote. stderr:\n${run.stderr}`,
  );
  return { run, pauseFile: reported, pause: readManualPause(sandbox) };
}

/** Answer the pause the way the reflection skill does, then record it. */
function recordManual(sandbox, outcome, pauseFile, answerOverrides = {}) {
  const answer = makeAnswer(answerOverrides);
  const data = writeAnswerDocument(sandbox, answer);
  const run = runRecord(
    sandbox,
    recordArgs({ outcome, pause: pauseFile, data }),
  );
  return { run, answer };
}

/** A complete Stop payload; override one field per case. */
const stopPayload = (sandbox, overrides = {}) => ({
  session_id: SESSION_ID,
  cwd: sandbox.projectDir,
  stop_hook_active: false,
  ...overrides,
});

/** Append one session event straight to the log, bypassing the capture hooks. */
const logEvent = (sandbox, event) =>
  appendSessionEvent(sandbox.projectDir, SESSION_ID, event, sandbox.homeDir);

/**
 * Seed one turn the engine will stop on: a genuine prompt and one edit of
 * `file`. Local to this suite — the fire recipe stays next to the one test
 * that needs a real neighbour document, not a planted one.
 */
function seedTurn(sandbox, file) {
  const events = [
    {
      type: "prompt",
      ts: 1000,
      prompt: "tighten who may read another tenant's records",
      effort: 0.4,
      permission_mode: "default",
    },
    {
      type: "edit",
      ts: 1001,
      file,
      lines_added: 4,
      lines_removed: 1,
      permission_mode: "default",
    },
  ];
  for (const event of events) {
    logEvent(sandbox, event);
  }
}

/**
 * Run the real Stop hook with the stub CLI as the only reachable `claude`.
 * Returns the same shape as {@link recordManual} — the spawn under `run` —
 * so `.run` means the child process in both.
 */
function runStop(sandbox, options = {}) {
  const env = claudeShimEnv(
    sandbox,
    options.scenario ?? VERDICT_SCENARIOS.pass,
  );
  const run = sandbox.runNode(hookEntrypoint("stop"), [], {
    input: JSON.stringify(stopPayload(sandbox, options.overrides)),
    env,
  });
  return { run };
}

// ---------------------------------------------------------------------------
// The chain itself: measured, answered, banked, rewarded.
// ---------------------------------------------------------------------------

test("a reflection the developer asked for is measured, banked, and rewarded end to end", (t) => {
  const sandbox = repoSandbox(t);
  const expected = stageWork(sandbox);

  // --- The writer, on a tree it has to measure rather than describe -----
  const { run: written, pauseFile, pause } = reflectNow(sandbox);

  assert.equal(pauseFile, manualPauseFile(sandbox));
  assert.equal(written.result.material, "found");
  assert.deepEqual(byFile(pause.group.edits), expected);
  assert.equal(pause.group.edit_count, Object.keys(expected).length);
  assert.equal(pause.group.lines_added, totalOf(expected, "lines_added"));
  assert.equal(pause.group.lines_removed, totalOf(expected, "lines_removed"));
  // The document and the result are two readings of one measurement.
  assert.equal(written.result.edit_count, pause.group.edit_count);
  assert.equal(written.result.lines_added, pause.group.lines_added);
  assert.equal(written.result.lines_removed, pause.group.lines_removed);
  assert.equal(pause.trigger, MANUAL_TRIGGER);
  for (const field of ["score", "threshold", "classification"]) {
    assert.equal(
      field in pause,
      false,
      `${field} must not appear at all: a zero would read as a measurement`,
    );
  }

  // --- The outcome, through the real CLI, on the writer's own document ---
  const { run: record, answer } = recordManual(sandbox, "keep", pauseFile);

  assert.equal(record.status, 0, `stderr:\n${record.stderr}`);
  assert.deepEqual(record.result, {
    ok: true,
    outcome: "keep",
    notices: [],
  });

  // --- The entry, joined from both documents ---------------------------
  const entry = readDecisionText(sandbox);
  assert.match(entry, MANUAL_HEADING);
  assert.match(entry, /^- outcome: keep$/m);
  assert.match(entry, /^- trigger: manual$/m);
  // A manual reflection is never classified, so nothing names a subcategory.
  assert.equal(entry.includes("- subcategory:"), false);
  // The files come from the pause; the questions and answer from the answer.
  assert.ok(
    entry.includes(
      `- files: ${pause.group.edits.map((edit) => edit.file).join(", ")}`,
    ),
  );
  for (const question of answer.questions) {
    assert.ok(entry.includes(question));
  }
  assert.ok(entry.includes(answer.answer));

  // --- What the recording consumed -------------------------------------
  assert.equal(manualPauseExists(sandbox), false);
  assert.equal(answerExists(sandbox), false);

  // --- What it moved, and what it left alone ---------------------------
  const state = readState(sandbox);
  // A reflection carries no category, so it has nothing to suppress.
  assert.deepEqual(state.mutes, []);
  assert.deepEqual(state.skip_streak, {});
  assert.deepEqual(state.skip_totals, {});
  assert.equal(state.score, rewardFor(seededState(CALM_SCORE)));
  // The asymmetry is the feature: below the cap the automatic relief is a
  // no-op, so a reward that changed nothing here would be no reward at all.
  assert.ok(state.score < CALM_SCORE);
  assert.equal(MANUAL_SETTINGS.manual_relief_factor, MANUAL_RELIEF_FACTOR);
  // The clock belongs to the Stop hook, and a personal preset is not the
  // recorder's to drop.
  assert.equal(state.last_update, SEED_LAST_UPDATE);
  assert.equal(state.preset, SEED_PRESET);
});

test("a reflection completed as a correction banks the correction and earns the same reward", (t) => {
  const sandbox = repoSandbox(t);
  stageWork(sandbox);

  const { pauseFile, pause } = reflectNow(sandbox);
  const { run: record, answer } = recordManual(sandbox, "correct", pauseFile, {
    correction: CORRECTION,
    followup_prompt: FOLLOWUP,
  });

  assert.equal(record.status, 0, `stderr:\n${record.stderr}`);
  assert.deepEqual(record.result, {
    ok: true,
    outcome: "correct",
    notices: [],
  });

  const entry = readDecisionText(sandbox);
  assert.match(entry, MANUAL_HEADING);
  assert.match(entry, /^- outcome: correct$/m);
  assert.match(entry, /^- trigger: manual$/m);
  assert.ok(entry.includes("### Correction"));
  assert.ok(entry.includes(answer.correction));
  assert.ok(entry.includes("### Follow-up"));
  assert.ok(entry.includes(answer.followup_prompt));
  assert.ok(
    entry.includes(
      `- files: ${pause.group.edits.map((edit) => edit.file).join(", ")}`,
    ),
  );

  assert.equal(manualPauseExists(sandbox), false);
  assert.equal(answerExists(sandbox), false);

  const state = readState(sandbox);
  assert.deepEqual(state.mutes, []);
  assert.deepEqual(state.skip_streak, {});
  assert.deepEqual(state.skip_totals, {});
  assert.equal(state.score, rewardFor(seededState(CALM_SCORE)));
});

// ---------------------------------------------------------------------------
// Asking is not reflecting.
// ---------------------------------------------------------------------------

test("a reflection asked for and then withdrawn earns nothing, however it is withdrawn", (t) => {
  const sandbox = repoSandbox(t);
  stageWork(sandbox);

  for (const outcome of ["skip", "defer"]) {
    // A fresh writer run each time: the previous recording consumed the
    // document, so nothing here can settle a pause it did not open.
    const { pauseFile } = reflectNow(sandbox);
    const run = runRecord(sandbox, recordArgs({ outcome, pause: pauseFile }));

    assert.equal(run.status, 0, `${outcome} failed, stderr:\n${run.stderr}`);
    assert.deepEqual(run.result, { ok: true, outcome, notices: [] });
    assert.equal(manualPauseExists(sandbox), false);
    // Nothing was reflected on, so nothing is banked.
    assert.deepEqual(decisionFiles(sandbox), []);

    const state = readState(sandbox);
    // Rewarding the request rather than the completion would make "invoke the
    // skill, press Escape" the cheapest score in the plugin.
    assert.equal(
      state.score,
      CALM_SCORE,
      `${outcome} must leave the score exactly where it stood`,
    );
    assert.equal(state.last_update, SEED_LAST_UPDATE);
    assert.deepEqual(state.mutes, []);
    assert.deepEqual(state.skip_streak, {});
    assert.deepEqual(state.skip_totals, {});
  }
});

// ---------------------------------------------------------------------------
// Two pauses, two documents, one project.
// ---------------------------------------------------------------------------

test("a manual reflection runs beside a pending automatic pause without disturbing it", (t) => {
  const sandbox = repoSandbox(t, { last_update: Date.now() });
  // The hard gate rather than the score: a watched path, not a loud number.
  seedTurn(sandbox, WATCHED_FILE);

  // --- The engine's own pause, from the real hook ----------------------
  const fire = runStop(sandbox);

  assert.equal(fire.run.status, 0, `stderr:\n${fire.run.stderr}`);
  assert.equal(JSON.parse(fire.run.stdout).decision, "block");
  const automaticBefore = readPendingPauseText(sandbox);
  const afterFire = readState(sandbox);

  // --- The developer's own pause, opened beside it ---------------------
  const { pauseFile } = reflectNow(sandbox);

  assert.notEqual(manualPauseFile(sandbox), pendingPauseFile(sandbox));
  assert.equal(readPendingPauseText(sandbox), automaticBefore);

  const manual = recordManual(sandbox, "keep", pauseFile);
  assert.equal(manual.run.status, 0, `stderr:\n${manual.run.stderr}`);
  // The neighbour survives the whole chain byte for byte.
  assert.equal(readPendingPauseText(sandbox), automaticBefore);
  const afterManual = readState(sandbox);
  assert.equal(afterManual.score, rewardFor(afterFire));

  // --- And still completes normally on its own terms -------------------
  const automatic = recordManual(sandbox, "keep", pendingPauseFile(sandbox));

  assert.equal(automatic.run.status, 0, `stderr:\n${automatic.run.stderr}`);
  assert.deepEqual(automatic.run.result, {
    ok: true,
    outcome: "keep",
    notices: [],
  });
  assert.equal(fs.existsSync(pendingPauseFile(sandbox)), false);

  const entry = readDecisionText(sandbox);
  assert.match(entry, MANUAL_HEADING);
  assert.match(
    entry,
    new RegExp(`^## \\d{1,2}:\\d{2} — ${PAUSE_CATEGORY}$`, "m"),
  );

  const afterAutomatic = readState(sandbox);
  // The classified pause leaves the mute a reflection never does — and no
  // second helping of relief.
  assert.equal(afterAutomatic.mutes.length, 1);
  assert.equal(afterAutomatic.mutes[0].category, PAUSE_CATEGORY);
  assert.equal(afterAutomatic.score, afterManual.score);
});

// ---------------------------------------------------------------------------
// The cases where there is nothing, or nobody, to measure for.
// ---------------------------------------------------------------------------

test("a fully committed tree still earns a reflection, banked with no file attribution", (t) => {
  const sandbox = repoSandbox(t);
  stageWork(sandbox);
  commitAll(sandbox.projectDir, "everything committed", sandbox.env);

  const { run: written, pauseFile, pause } = reflectNow(sandbox);

  assert.equal(written.result.material, "clean");
  assert.equal(written.result.edit_count, 0);
  assert.deepEqual(pause.group.edits, []);
  assert.equal(pause.group.edit_count, 0);

  const { run: record } = recordManual(sandbox, "keep", pauseFile);

  assert.equal(record.status, 0, `stderr:\n${record.stderr}`);
  const entry = readDecisionText(sandbox);
  assert.match(entry, MANUAL_HEADING);
  // Nothing measured is said plainly, not left as an empty list.
  assert.match(entry, NO_FILES);
  assert.equal(readState(sandbox).score, rewardFor(seededState(CALM_SCORE)));
});

test("a disabled plugin runs the whole loop, reward included: `enabled` gates the engine, not the developer", (t) => {
  const sandbox = repoSandbox(t);
  const config = { ...defaultConfig(), enabled: false };
  writeConfigDocument(sandbox, config);
  stageWork(sandbox);

  const { run: written, pauseFile, pause } = reflectNow(sandbox);

  assert.equal(written.result.material, "found");
  assert.equal(pause.trigger, MANUAL_TRIGGER);

  const { run: record } = recordManual(sandbox, "keep", pauseFile);

  assert.equal(record.status, 0, `stderr:\n${record.stderr}`);
  assert.match(readDecisionText(sandbox), MANUAL_HEADING);
  assert.equal(manualPauseExists(sandbox), false);

  const state = readState(sandbox);
  assert.equal(state.score, rewardFor(seededState(CALM_SCORE), config));
  assert.ok(state.score < CALM_SCORE);
  assert.deepEqual(state.mutes, []);
});
