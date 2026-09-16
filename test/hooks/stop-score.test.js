// The Stop hook's score-and-persist stage, driven as a real child process.
//
// This is the turn boundary: the one place a score moves. The suite drives the
// REAL capture hooks to fill a session log, then the REAL Stop hook, and
// asserts only what Claude Code and the filesystem could observe — exit status,
// stdout, `state.json`, the session log, and the trace.
//
// Every expected number is computed by calling the pure functions the engine
// itself uses (`buildTurnGroup`, `scoreTurn`) on the events actually logged,
// with knobs assembled from the named constant exports. Nothing here restates
// the scoring arithmetic, so a recalibration moves the tests with the code.
//
// Elapsed time is the one thing a child process owns and the test cannot: the
// hook reads its own clock somewhere between spawn and exit. So decayed
// expectations are asserted as a WINDOW bounded by the elapsed time at those
// two moments, rather than as a single number a scheduling hiccup could break.
//
// Contract: thoughts/shared/.project/architecture.md (Stop order of
// operations) and architecture/payloads.md §`local-trace.jsonl`, §`state.json`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { buildTurnGroup } from "../../src/core/group.js";
import { scoreTurn } from "../../src/core/scoring.js";
import {
  AUTO_ACCEPT_MULTIPLIER,
  DIFF_LINE_CAP,
  EDIT_COUNT_CAP,
  PRESETS,
  saveConfig,
} from "../../src/io/config/config.js";
import { personalStatePath, sessionLogPath } from "../../src/io/paths.js";
import { appendSessionEvent } from "../../src/io/session-log.js";
import {
  readEvents,
  readStateDocument,
  readTrace,
  runHook,
  seedStateDocument,
} from "../helpers/capture-hook.js";
import { createSandbox } from "../helpers/sandbox.js";

const HOOK = "stop";
const SESSION_ID = "session-stop-123";
const HOUR_MS = 60 * 60 * 1000;

/** The preset an unconfigured project resolves to — the knobs under test. */
const BALANCED = PRESETS.balanced;

/** Knobs exactly as the Stop hook must assemble them for the scorer. */
const KNOBS = {
  ...BALANCED,
  edit_count_cap: EDIT_COUNT_CAP,
  diff_line_cap: DIFF_LINE_CAP,
  auto_accept_multiplier: AUTO_ACCEPT_MULTIPLIER,
};

/** One half-life of elapsed time — enough that decay is unmistakable. */
const HALF_LIFE_MS = BALANCED.half_life_hours * HOUR_MS;

/** Float slack: these are compositions of the engine's own arithmetic. */
const EPSILON = 1e-9;

/** A complete Stop payload; override one field per case. */
const stopPayload = (sandbox, overrides = {}) => ({
  session_id: SESSION_ID,
  cwd: sandbox.projectDir,
  stop_hook_active: false,
  ...overrides,
});

/** A UserPromptSubmit payload for filling the log through the real hook. */
const promptPayload = (sandbox, prompt) => ({
  session_id: SESSION_ID,
  cwd: sandbox.projectDir,
  prompt,
  permission_mode: "default",
});

/** A PostToolUse payload carrying a real two-added, one-removed patch. */
const editPayload = (sandbox, file) => ({
  session_id: SESSION_ID,
  cwd: sandbox.projectDir,
  tool_name: "Edit",
  tool_input: { file_path: file },
  tool_response: {
    structuredPatch: [
      { lines: [" unchanged", "+added one", "+added two", "-removed one"] },
    ],
  },
  permission_mode: "default",
});

/** Whatever it decided, the Stop hook exits 0 and says nothing on stdout. */
function assertSilentSuccess(run) {
  assert.equal(run.status, 0, `expected exit 0, stderr:\n${run.stderr}`);
  assert.equal(
    run.stdout,
    "",
    "this stage of the Stop hook fires no pause, so stdout must stay empty",
  );
}

/** The trace lines this hook wrote, ignoring the capture hooks' own lines. */
const stopTraceLines = (sandbox) =>
  readTrace(sandbox).filter((line) => line.hook === "Stop");

/** The one trace line a single Stop invocation is contracted to write. */
function soleStopTrace(sandbox) {
  const lines = stopTraceLines(sandbox);
  assert.equal(
    lines.length,
    1,
    `expected exactly one Stop trace line, got ${JSON.stringify(lines)}`,
  );
  return lines[0];
}

/**
 * Run the Stop hook and bracket it in wall-clock time, so a decayed
 * expectation can be checked against the range of elapsed times the child
 * could plausibly have read.
 */
function runStop(sandbox, overrides = {}, options = {}) {
  const startedAt = Date.now();
  const run = runHook(sandbox, HOOK, stopPayload(sandbox, overrides), options);
  return { run, startedAt, finishedAt: Date.now() };
}

/** Whether the session log still exists at all — truncation deletes it. */
const sessionLogExists = (sandbox) =>
  fs.existsSync(
    sessionLogPath(sandbox.projectDir, SESSION_ID, sandbox.homeDir),
  );

/**
 * Assert a persisted score against the score the engine's own functions
 * produce, for every elapsed time the child could have observed. More elapsed
 * time means more decay, so the window's floor uses the later reading.
 */
function assertScoredWithin(actual, { previousScore, lastUpdate, group, run }) {
  const lowest = scoreTurn(
    previousScore,
    run.finishedAt - lastUpdate,
    group,
    KNOBS,
  );
  const highest = scoreTurn(
    previousScore,
    run.startedAt - lastUpdate,
    group,
    KNOBS,
  );
  assert.ok(
    actual >= lowest - EPSILON && actual <= highest + EPSILON,
    `expected ${actual} within [${lowest}, ${highest}]`,
  );
}

// ---------------------------------------------------------------------------
// The full pipeline — prompts and edits through the real hooks, then Stop.
// ---------------------------------------------------------------------------

test("a turn of real prompt and edit events is scored into state", (t) => {
  const sandbox = createSandbox(t);
  const previousScore = 8;
  const lastUpdate = Date.now() - HALF_LIFE_MS;
  seedStateDocument(sandbox, {
    score: previousScore,
    last_update: lastUpdate,
    mutes: [],
    skip_streak: {},
    skip_totals: {},
  });
  runHook(sandbox, "user-prompt-submit", promptPayload(sandbox, "fix it"));
  runHook(sandbox, "post-tool-use", editPayload(sandbox, "src/io/paths.js"));
  runHook(sandbox, "post-tool-use", editPayload(sandbox, "src/io/state.js"));
  const group = buildTurnGroup(readEvents(sandbox, SESSION_ID));

  const stop = runStop(sandbox);

  assertSilentSuccess(stop.run);
  const state = readStateDocument(sandbox);
  assertScoredWithin(state.score, {
    previousScore,
    lastUpdate,
    group,
    run: stop,
  });
  assert.ok(
    state.last_update >= stop.startedAt && state.last_update <= stop.finishedAt,
    `last_update ${state.last_update} outside the invocation window`,
  );
});

test("the turn's own evidence moves the score, not decay alone", (t) => {
  const sandbox = createSandbox(t);
  const previousScore = 8;
  const lastUpdate = Date.now() - HALF_LIFE_MS;
  seedStateDocument(sandbox, {
    score: previousScore,
    last_update: lastUpdate,
    mutes: [],
    skip_streak: {},
    skip_totals: {},
  });
  runHook(sandbox, "user-prompt-submit", promptPayload(sandbox, "fix it"));
  runHook(sandbox, "post-tool-use", editPayload(sandbox, "src/io/paths.js"));
  const group = buildTurnGroup(readEvents(sandbox, SESSION_ID));
  // The turn is genuinely evidence-bearing: a low-effort prompt and a measured
  // edit, so the assertions below are about scoring rather than about zero.
  assert.equal(group.edit_count, 1);
  assert.equal(group.lines_added + group.lines_removed, 3);
  assert.ok(group.prompt_effort > 0);

  const stop = runStop(sandbox);

  const { score } = readStateDocument(sandbox);
  // Half a half-life of decay is visible, and the turn's delta rides on top.
  assert.ok(score < previousScore, `expected decay below ${previousScore}`);
  assert.ok(score > previousScore / 2, "expected the turn's delta on top");
  assertScoredWithin(score, { previousScore, lastUpdate, group, run: stop });
});

test("the consumed session log is truncated away", (t) => {
  const sandbox = createSandbox(t);
  runHook(sandbox, "user-prompt-submit", promptPayload(sandbox, "fix it"));
  runHook(sandbox, "post-tool-use", editPayload(sandbox, "src/io/paths.js"));
  assert.equal(sessionLogExists(sandbox), true);

  const stop = runStop(sandbox);

  assertSilentSuccess(stop.run);
  assert.equal(sessionLogExists(sandbox), false);
  assert.deepEqual(readEvents(sandbox, SESSION_ID), []);
});

test("one Stop invocation traces its score movement exactly once", (t) => {
  const sandbox = createSandbox(t);
  const previousScore = 8;
  seedStateDocument(sandbox, {
    score: previousScore,
    last_update: Date.now() - HALF_LIFE_MS,
    mutes: [],
    skip_streak: {},
    skip_totals: {},
  });
  runHook(sandbox, "user-prompt-submit", promptPayload(sandbox, "fix it"));

  const stop = runStop(sandbox);

  assertSilentSuccess(stop.run);
  const line = soleStopTrace(sandbox);
  assert.equal(line.outcome, "scored");
  assert.equal(line.score_before, previousScore);
  assert.equal(line.score_after, readStateDocument(sandbox).score);
  assert.ok(Number.isFinite(line.ts));
});

test("state keeps every field the scorer does not own", (t) => {
  const sandbox = createSandbox(t);
  // The mute is deliberately UNEXPIRED: the turn boundary prunes expired ones
  // before it gates, so an expired entry is a field the scorer now does own.
  const untouched = {
    mutes: [
      { category: "security", files: null, expires_at: Date.now() + HOUR_MS },
    ],
    skip_streak: { architecture: { count: 2, last_skip: 1783780610000 } },
    skip_totals: { architecture: 5 },
    preset: "vigilant",
  };
  seedStateDocument(sandbox, {
    score: 3,
    last_update: Date.now() - HALF_LIFE_MS,
    ...untouched,
  });
  runHook(sandbox, "user-prompt-submit", promptPayload(sandbox, "fix it"));

  const stop = runStop(sandbox);

  assertSilentSuccess(stop.run);
  const state = readStateDocument(sandbox);
  // The document really was rewritten — otherwise the survival below would be
  // the survival of a file nobody touched.
  assert.ok(
    state.last_update >= stop.startedAt,
    "expected the turn boundary to have rewritten state",
  );
  assert.deepEqual(state.mutes, untouched.mutes);
  assert.deepEqual(state.skip_streak, untouched.skip_streak);
  assert.deepEqual(state.skip_totals, untouched.skip_totals);
  assert.equal(state.preset, untouched.preset);
});

// ---------------------------------------------------------------------------
// The continuation Stop — the invocation that follows a pause. It consumes the
// pause machinery's own events and scores nothing.
// ---------------------------------------------------------------------------

test("a continuation Stop truncates the log without scoring", (t) => {
  const sandbox = createSandbox(t);
  const seeded = {
    score: 6,
    last_update: Date.now() - HALF_LIFE_MS,
    mutes: [],
    skip_streak: {},
    skip_totals: {},
  };
  seedStateDocument(sandbox, seeded);
  runHook(sandbox, "user-prompt-submit", promptPayload(sandbox, "fix it"));
  runHook(sandbox, "post-tool-use", editPayload(sandbox, "src/io/paths.js"));
  runHook(sandbox, "post-tool-use", editPayload(sandbox, "src/io/state.js"));

  const stop = runStop(sandbox, { stop_hook_active: true });

  assertSilentSuccess(stop.run);
  assert.equal(sessionLogExists(sandbox), false);
  // Not rewritten at all: no decay, no delta, no new timestamp.
  assert.deepEqual(readStateDocument(sandbox), seeded);
});

test("a continuation Stop counts what its truncation dropped, by kind", (t) => {
  const sandbox = createSandbox(t);
  runHook(sandbox, "user-prompt-submit", promptPayload(sandbox, "fix it"));
  runHook(sandbox, "post-tool-use", editPayload(sandbox, "src/io/paths.js"));
  runHook(sandbox, "post-tool-use", editPayload(sandbox, "src/io/state.js"));

  const stop = runStop(sandbox, { stop_hook_active: true });

  assertSilentSuccess(stop.run);
  const line = soleStopTrace(sandbox);
  assert.equal(line.outcome, "continuation_truncated");
  assert.deepEqual(line.dropped, { prompt: 1, edit: 2 });
});

test("a continuation Stop over an empty log drops nothing", (t) => {
  const sandbox = createSandbox(t);

  const stop = runStop(sandbox, { stop_hook_active: true });

  assertSilentSuccess(stop.run);
  const line = soleStopTrace(sandbox);
  assert.equal(line.outcome, "continuation_truncated");
  assert.deepEqual(line.dropped, {});
});

// ---------------------------------------------------------------------------
// Elapsed time is always reflected, even when the turn had no evidence.
// ---------------------------------------------------------------------------

test("a turn with no session log still decays the persisted score", (t) => {
  const sandbox = createSandbox(t);
  const previousScore = 8;
  const lastUpdate = Date.now() - HALF_LIFE_MS;
  seedStateDocument(sandbox, {
    score: previousScore,
    last_update: lastUpdate,
    mutes: [],
    skip_streak: {},
    skip_totals: {},
  });

  const stop = runStop(sandbox);

  assertSilentSuccess(stop.run);
  const state = readStateDocument(sandbox);
  assertScoredWithin(state.score, {
    previousScore,
    lastUpdate,
    group: buildTurnGroup([]),
    run: stop,
  });
  assert.ok(state.last_update >= stop.startedAt);
  assert.equal(soleStopTrace(sandbox).outcome, "scored");
});

test("a turn whose log holds no events decays the score too", (t) => {
  const sandbox = createSandbox(t);
  const previousScore = 8;
  const lastUpdate = Date.now() - HALF_LIFE_MS;
  seedStateDocument(sandbox, {
    score: previousScore,
    last_update: lastUpdate,
    mutes: [],
    skip_streak: {},
    skip_totals: {},
  });
  const logPath = sessionLogPath(
    sandbox.projectDir,
    SESSION_ID,
    sandbox.homeDir,
  );
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, "", "utf8");

  const stop = runStop(sandbox);

  assertSilentSuccess(stop.run);
  assertScoredWithin(readStateDocument(sandbox).score, {
    previousScore,
    lastUpdate,
    group: buildTurnGroup([]),
    run: stop,
  });
  assert.equal(sessionLogExists(sandbox), false);
});

test("a Stop with no prior state creates one floored at zero", (t) => {
  const sandbox = createSandbox(t);

  const stop = runStop(sandbox);

  assertSilentSuccess(stop.run);
  const state = readStateDocument(sandbox);
  assert.ok(state, "expected state.json to be created");
  assert.ok(state.score >= 0, `expected a floored score, got ${state.score}`);
  assert.equal(state.score, 0);
  assert.ok(state.last_update >= stop.startedAt);
  assert.deepEqual(state.mutes, []);
  assert.equal(soleStopTrace(sandbox).outcome, "scored");
});

test("state never seen before decays from now, not from the epoch", (t) => {
  const sandbox = createSandbox(t);
  // `last_update: 0` means never evaluated. Treating that as elapsed time
  // since 1970 would wipe an accumulated score on the first Stop after an
  // upgrade, so it must decay nothing at all.
  seedStateDocument(sandbox, {
    score: 5,
    last_update: 0,
    mutes: [],
    skip_streak: {},
    skip_totals: {},
  });

  const stop = runStop(sandbox);

  assertSilentSuccess(stop.run);
  assert.equal(readStateDocument(sandbox).score, 5);
});

// ---------------------------------------------------------------------------
// Self-instrumentation and the master switch.
// ---------------------------------------------------------------------------

test("STOIC_INTERNAL stops the hook before it reads or writes anything", (t) => {
  const sandbox = createSandbox(t);
  const seeded = {
    score: 6,
    last_update: Date.now() - HALF_LIFE_MS,
    mutes: [],
    skip_streak: {},
    skip_totals: {},
  };
  seedStateDocument(sandbox, seeded);
  appendSessionEvent(
    sandbox.projectDir,
    SESSION_ID,
    { type: "prompt", ts: Date.now(), prompt: "fix it", effort: 1 },
    sandbox.homeDir,
  );

  const stop = runStop(sandbox, {}, { env: { STOIC_INTERNAL: "1" } });

  assertSilentSuccess(stop.run);
  assert.deepEqual(readTrace(sandbox), []);
  assert.deepEqual(readStateDocument(sandbox), seeded);
  assert.equal(readEvents(sandbox, SESSION_ID).length, 1);
});

test("a disabled plugin scores nothing", (t) => {
  const sandbox = createSandbox(t);
  saveConfig(sandbox.projectDir, { enabled: false });
  const seeded = {
    score: 6,
    last_update: Date.now() - HALF_LIFE_MS,
    mutes: [],
    skip_streak: {},
    skip_totals: {},
  };
  seedStateDocument(sandbox, seeded);
  appendSessionEvent(
    sandbox.projectDir,
    SESSION_ID,
    { type: "prompt", ts: Date.now(), prompt: "fix it", effort: 1 },
    sandbox.homeDir,
  );

  const stop = runStop(sandbox);

  assertSilentSuccess(stop.run);
  assert.equal(soleStopTrace(sandbox).outcome, "disabled");
  assert.deepEqual(readStateDocument(sandbox), seeded);
  // The master switch is off, not a truncation instruction: like every capture
  // hook, a disabled Stop leaves the log exactly as it found it.
  assert.equal(readEvents(sandbox, SESSION_ID).length, 1);
});

// ---------------------------------------------------------------------------
// Fail-silent: nothing on this path may cost the user a turn.
// ---------------------------------------------------------------------------

test("non-JSON stdin costs the turn boundary, not the session", (t) => {
  const sandbox = createSandbox(t);

  const run = runHook(sandbox, HOOK, "not json at all");

  assertSilentSuccess(run);
  assert.equal(soleStopTrace(sandbox).outcome, "malformed_input");
  assert.equal(
    fs.existsSync(personalStatePath(sandbox.projectDir, sandbox.homeDir)),
    false,
  );
});

test("empty stdin is malformed input too", (t) => {
  const sandbox = createSandbox(t);

  const run = runHook(sandbox, HOOK, "");

  assertSilentSuccess(run);
  assert.equal(soleStopTrace(sandbox).outcome, "malformed_input");
});

test("a payload naming no session cannot be a turn boundary", (t) => {
  const sandbox = createSandbox(t);

  const run = runHook(sandbox, HOOK, { cwd: sandbox.projectDir });

  assertSilentSuccess(run);
  assert.equal(soleStopTrace(sandbox).outcome, "malformed_input");
});

test("corrupt state is replaced by a consistent scored document", (t) => {
  const sandbox = createSandbox(t);
  seedStateDocument(sandbox, '{"score": 7.5, "mutes": [');
  runHook(sandbox, "post-tool-use", editPayload(sandbox, "src/io/paths.js"));
  const group = buildTurnGroup(readEvents(sandbox, SESSION_ID));

  const stop = runStop(sandbox);

  assertSilentSuccess(stop.run);
  const state = readStateDocument(sandbox);
  // Unreadable state is neutral state: score 0, never evaluated, so nothing
  // decays and the turn's own delta is the whole score.
  assert.ok(
    Math.abs(state.score - scoreTurn(0, 0, group, KNOBS)) < EPSILON,
    `expected ${state.score} to equal the turn's own delta`,
  );
  assert.deepEqual(state.mutes, []);
  assert.deepEqual(state.skip_streak, {});
  assert.deepEqual(state.skip_totals, {});
  assert.ok(state.last_update >= stop.startedAt);
  assert.equal(soleStopTrace(sandbox).outcome, "scored");
});

test("corrupt log lines are skipped and the rest of the turn is scored", (t) => {
  const sandbox = createSandbox(t);
  const logPath = sessionLogPath(
    sandbox.projectDir,
    SESSION_ID,
    sandbox.homeDir,
  );
  runHook(sandbox, "post-tool-use", editPayload(sandbox, "src/io/paths.js"));
  fs.appendFileSync(logPath, '{"type": "edit", "file": "torn\n', "utf8");
  runHook(sandbox, "post-tool-use", editPayload(sandbox, "src/io/state.js"));
  fs.appendFileSync(logPath, "not json at all\n", "utf8");
  const survivors = readEvents(sandbox, SESSION_ID);
  assert.equal(survivors.length, 2);
  const group = buildTurnGroup(survivors);

  const stop = runStop(sandbox);

  assertSilentSuccess(stop.run);
  const state = readStateDocument(sandbox);
  assert.ok(
    Math.abs(state.score - scoreTurn(0, 0, group, KNOBS)) < EPSILON,
    `expected ${state.score} to score the two readable edits`,
  );
  assert.equal(sessionLogExists(sandbox), false);
  assert.equal(soleStopTrace(sandbox).outcome, "scored");
});
