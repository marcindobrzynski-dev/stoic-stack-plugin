// The whole pause loop, driven as real processes: a turn fires the Stop hook,
// the developer's outcome is recorded, and the turn after it lives with what
// the two of them left behind.
//
// Everything between those points is genuine. The actual `src/hooks/stop.js`
// writes `stoic-pending-pause.json`; the actual `src/cli/record.js` is handed
// THAT file's path — never a fabricated one — and consumes it; the next Stop
// reads the `state.json` both of them wrote. The only stand-in is the
// classifier, and only from outside the process: the child's PATH is rebuilt
// so the sole reachable `claude` is `test/fixtures/stub-claude-cli.js` (see
// ../helpers/claude-shim.js), which is what the two-level seam rule in
// architecture.md §Testing prescribes for a spawned entrypoint.
//
// One thing in the chain cannot be spawned. The `stoic-pause` skill is prose
// for a model, so the single artifact it contributes — `pause-answer.json` —
// is staged here with the recording harness's own document builder. The file
// PASSING is the seam under test, not the conversation that would have filled
// it in.
//
// The suite proves the seams, not the variants. Every veto reason, every mute
// shape, the gate combinatorics and the CLI's whole error surface are already
// covered where they belong — `stop-decision.test.js` and `../core/gates.test.js`
// in process, `../cli/record.test.js` against the CLI alone. What only a chain
// of real processes can show is that the documents they hand one another
// actually join up, and that the engine's one pressure relief happens exactly
// once.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §`stoic-pending-pause.json` (part 1), §"Stop hook output" (part 2),
// §`record.js` CLI (part 3), §`pause-answer.json` (part 3b), §"Decision bank
// entry" and §`state.json`; and architecture.md §Data flow, whose "One
// pressure-relief mechanism" paragraph is what the second journey below pins.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { buildTurnGroup } from "../../src/core/group.js";
import { scoreTurn } from "../../src/core/scoring.js";
import { BANK_OUTCOMES } from "../../src/io/bank.js";
import {
  AUTO_ACCEPT_MULTIPLIER,
  DIFF_LINE_CAP,
  EDIT_COUNT_CAP,
  PRESETS,
  SKIPS_BEFORE_CATEGORY_MUTE,
} from "../../src/io/config.js";
import { pendingPausePath } from "../../src/io/paths.js";
import { appendSessionEvent } from "../../src/io/session-log.js";
import {
  PASS_VERDICT,
  VERDICT_SCENARIOS,
} from "../fixtures/classifier-verdicts.js";
import {
  hookEntrypoint,
  readStateDocument,
  readTrace,
  seedStateDocument,
} from "../helpers/capture-hook.js";
import { claudeShimEnv } from "../helpers/claude-shim.js";
import {
  assertExpiresWithin,
  categoryMute,
  fingerprintMute,
} from "../helpers/mute.js";
import {
  answerExists,
  decisionFiles,
  makeAnswer,
  readDecisionText,
  recordArgs,
  runRecord,
  writeAnswerDocument,
} from "../helpers/record-cli.js";
import { createSandbox } from "../helpers/sandbox.js";

const SESSION_ID = "session-full-loop-1";

const MS_PER_HOUR = 3_600_000;

/**
 * The preset an unconfigured project with untouched personal state resolves to
 * — on BOTH sides of the loop. The Stop hook and `record.js` resolve knobs
 * through the same configuration model, so one preset object serves the score
 * arithmetic here and the mute windows below.
 */
const BALANCED = PRESETS.balanced;

/** Knobs exactly as the Stop hook assembles them for the scorer. */
const KNOBS = {
  ...BALANCED,
  edit_count_cap: EDIT_COUNT_CAP,
  diff_line_cap: DIFF_LINE_CAP,
  auto_accept_multiplier: AUTO_ACCEPT_MULTIPLIER,
};

/** The score a fire cools down to, once it is above the cap at all. */
const COOLED = BALANCED.threshold * BALANCED.cooldown_ratio;

/** A score far enough over the threshold that decay cannot explain a fire. */
const LOUD_SCORE = 30;

/** Float slack: these are compositions of the engine's own arithmetic. */
const EPSILON = 1e-9;

/** The four outcomes the pause skill may report — the developer's menu. */
const OUTCOMES = Object.freeze(["keep", "correct", "skip", "defer"]);

/** Distinct files all matching the default `critical_paths` keyword `auth`. */
const WATCHED_FILES = Object.freeze([
  "src/auth/roles.js",
  "src/auth/tokens.js",
  "src/auth/session.js",
  "src/auth/scopes.js",
]);

/** Distinct files matching no default critical path — the soft gate only. */
const ORDINARY_FILES = Object.freeze(["src/ui/table.js", "src/ui/chart.js"]);

/** The category `PASS_VERDICT`'s subcategory resolves to. */
const PASS_CATEGORY = "security";

/** A complete Stop payload; override one field per case. */
const stopPayload = (sandbox, overrides = {}) => ({
  session_id: SESSION_ID,
  cwd: sandbox.projectDir,
  stop_hook_active: false,
  ...overrides,
});

/** A state document with everything the Stop hook expects to find. */
const seedState = (sandbox, overrides = {}) =>
  seedStateDocument(sandbox, {
    score: 0,
    last_update: Date.now(),
    mutes: [],
    skip_streak: {},
    skip_totals: {},
    ...overrides,
  });

/** Append one session event straight to the log, bypassing the capture hooks. */
const logEvent = (sandbox, event) =>
  appendSessionEvent(sandbox.projectDir, SESSION_ID, event, sandbox.homeDir);

/**
 * Seed one turn: a genuine prompt and one edit of `file`. Returns the turn
 * group the Stop hook will build from it, so expectations stay the engine's
 * own arithmetic rather than restated numbers.
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
  return buildTurnGroup(events);
}

/**
 * Run the real Stop hook with the stub CLI as the only reachable `claude`, and
 * bracket it in wall-clock time so a decayed expectation can be checked against
 * the range of elapsed times the child could have read.
 */
function runStop(sandbox, options = {}) {
  const env = claudeShimEnv(
    sandbox,
    options.scenario ?? VERDICT_SCENARIOS.pass,
  );
  const startedAt = Date.now();
  const run = sandbox.runNode(hookEntrypoint("stop"), [], {
    input: JSON.stringify(stopPayload(sandbox, options.overrides)),
    env,
  });
  return { run, startedAt, finishedAt: Date.now() };
}

/**
 * Report an outcome the way the pause skill does: stage the answer document
 * when the outcome banks one, then shell to the real CLI with the pause path
 * the hook itself wrote. Bracketed in wall-clock time, because the mute
 * expiries it stamps come from the child's own clock.
 *
 * Returns the same shape as {@link runStop} — the spawn result under `run`,
 * the timing beside it — so `.run` means the child process in both, and never
 * the envelope holding it.
 */
function recordOutcome(sandbox, outcome, pauseFile) {
  const data = BANK_OUTCOMES.includes(outcome)
    ? writeAnswerDocument(sandbox, makeAnswer())
    : undefined;
  const startedAt = Date.now();
  const run = runRecord(
    sandbox,
    recordArgs({ outcome, pause: pauseFile, data }),
  );
  return { run, startedAt, finishedAt: Date.now() };
}

/** Where the Stop hook writes its hand-off — the path `record.js` is handed. */
const hookPausePath = (sandbox) =>
  pendingPausePath(sandbox.projectDir, sandbox.homeDir);

/** The pending-pause document as an outside observer would read it. */
const readPause = (sandbox) =>
  JSON.parse(fs.readFileSync(hookPausePath(sandbox), "utf8"));

const pauseExists = (sandbox) => fs.existsSync(hookPausePath(sandbox));

/** Every Stop trace line so far, in invocation order. */
const stopTrace = (sandbox) =>
  readTrace(sandbox).filter((line) => line.hook === "Stop");

/** A suppressed turn: exit 0, stdout genuinely empty, no document written. */
function assertNoPause(sandbox, stop) {
  assert.equal(
    stop.run.status,
    0,
    `expected exit 0, stderr:\n${stop.run.stderr}`,
  );
  assert.equal(
    stop.run.stdout,
    "",
    "a turn that does not fire must leave stdout completely empty",
  );
  assert.equal(pauseExists(sandbox), false);
}

/**
 * The fire-time score the child could plausibly have computed, as a range.
 * `invocation` is a whole run — the spawn result and the wall clock either
 * side of it — of which only the two timestamps are read here. The child's own
 * clock reading is unknowable, so both ends are computed.
 */
function scoreWindow({ previousScore, lastUpdate, group, invocation }) {
  return [
    scoreTurn(previousScore, invocation.finishedAt - lastUpdate, group, KNOBS),
    scoreTurn(previousScore, invocation.startedAt - lastUpdate, group, KNOBS),
  ];
}

function assertWithin(actual, [lowest, highest]) {
  assert.ok(
    actual >= lowest - EPSILON && actual <= highest + EPSILON,
    `expected ${actual} within [${lowest}, ${highest}]`,
  );
}

// ---------------------------------------------------------------------------
// The loop itself, once per outcome: fire → record → the turn after.
// ---------------------------------------------------------------------------

for (const outcome of OUTCOMES) {
  test(`a fired pause recorded as ${outcome} is consumed, and the decision it settled stays quiet next turn`, (t) => {
    const sandbox = createSandbox(t);
    seedState(sandbox, { score: 0, last_update: Date.now() });
    seedTurn(sandbox, WATCHED_FILES[0]);

    // --- The turn that fires -------------------------------------------
    const fire = runStop(sandbox);

    assert.equal(fire.run.status, 0, `stderr:\n${fire.run.stderr}`);
    assert.equal(JSON.parse(fire.run.stdout).decision, "block");
    const pause = readPause(sandbox);
    assert.equal(pause.trigger, "critical_path");
    assert.equal(pause.classification.category, PASS_CATEGORY);
    const afterFire = readStateDocument(sandbox);

    // --- The outcome, through the real CLI, on the hook's own document ---
    const record = recordOutcome(sandbox, outcome, hookPausePath(sandbox));

    assert.equal(record.run.status, 0, `stderr:\n${record.run.stderr}`);
    assert.deepEqual(record.run.result, { ok: true, outcome, notices: [] });
    // The deleted hand-off IS the completion marker.
    assert.equal(pauseExists(sandbox), false);

    if (BANK_OUTCOMES.includes(outcome)) {
      // Everything but the reflection came out of the pause document: the
      // trigger is the tell, since only the hook could have named this gate.
      const entry = readDecisionText(sandbox);
      assert.match(
        entry,
        new RegExp(`^## \\d{1,2}:\\d{2} — ${PASS_CATEGORY}$`, "m"),
      );
      assert.match(entry, new RegExp(`^- outcome: ${outcome}$`, "m"));
      assert.match(
        entry,
        new RegExp(`^- subcategory: ${PASS_VERDICT.subcategory}$`, "m"),
      );
      assert.ok(entry.includes(`- files: ${WATCHED_FILES[0]}`));
      assert.match(entry, /^- trigger: critical_path$/m);
      assert.ok(entry.includes(makeAnswer().answer));
      // The answer file is consumed too, so the reflection cannot be re-banked.
      assert.equal(answerExists(sandbox), false);
    } else {
      assert.deepEqual(decisionFiles(sandbox), []);
    }

    const afterRecord = readStateDocument(sandbox);
    // The shape check is not here: `fingerprintMute` holds every entry to the
    // frozen keys on every read, so it covers this one and the rest alike.
    const mute = fingerprintMute(afterRecord);
    assert.equal(mute.category, PASS_CATEGORY);
    assert.deepEqual(mute.files, [WATCHED_FILES[0]]);
    assertExpiresWithin(mute.expires_at, {
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      windowMs: KNOBS.mute_window_ms,
    });
    // Recording is not scoring: the Stop hook's word on the score is the last.
    assert.equal(afterRecord.score, afterFire.score);
    assert.equal(afterRecord.last_update, afterFire.last_update);

    // --- The turn after: the same decision, over the same files ---------
    seedTurn(sandbox, WATCHED_FILES[0]);
    const next = runStop(sandbox);

    assertNoPause(sandbox, next);
    // `muted`, not `scored`: the hard gate fired and the classifier passed
    // again, so it is the recorded outcome that silenced this turn.
    assert.deepEqual(
      stopTrace(sandbox).map((line) => line.outcome),
      ["fired", "muted"],
    );
  });
}

// ---------------------------------------------------------------------------
// One pressure relief, at fire time, and no second one anywhere in the loop.
// ---------------------------------------------------------------------------

test("the fire-time cooldown is the whole of the loop's pressure relief", (t) => {
  const sandbox = createSandbox(t);
  const lastUpdate = Date.now();
  seedState(sandbox, { score: LOUD_SCORE, last_update: lastUpdate });
  const loudGroup = seedTurn(sandbox, ORDINARY_FILES[0]);

  // --- The soft gate fires ---------------------------------------------
  const fire = runStop(sandbox);

  assert.equal(fire.run.status, 0, `stderr:\n${fire.run.stderr}`);
  assert.equal(JSON.parse(fire.run.stdout).decision, "block");
  const pause = readPause(sandbox);
  assert.equal(pause.trigger, "score");
  // The document reports the score that fired; state keeps the cooled one.
  assertWithin(
    pause.score,
    scoreWindow({
      previousScore: LOUD_SCORE,
      lastUpdate,
      group: loudGroup,
      invocation: fire,
    }),
  );
  assert.ok(pause.score > BALANCED.threshold);
  assert.equal(readStateDocument(sandbox).score, COOLED);

  // --- The Stop that closes the pause conversation itself ---------------
  // The developer answers, so the pause turn has events of its own; that turn
  // is not a turn the engine may score.
  logEvent(sandbox, {
    type: "prompt",
    ts: 2000,
    prompt: "the cross-tenant read is deliberate — the report page needs it",
    effort: -0.2,
    permission_mode: "default",
  });
  const continuation = runStop(sandbox, {
    overrides: { stop_hook_active: true },
  });

  assert.equal(
    continuation.run.status,
    0,
    `stderr:\n${continuation.run.stderr}`,
  );
  assert.equal(continuation.run.stdout, "");
  const afterContinuation = readStateDocument(sandbox);
  assert.equal(afterContinuation.score, COOLED);

  // --- The outcome, recorded ------------------------------------------
  const record = recordOutcome(sandbox, "keep", hookPausePath(sandbox));

  assert.equal(record.run.status, 0, `stderr:\n${record.run.stderr}`);
  const afterRecord = readStateDocument(sandbox);
  // The cooldown cap and nothing else: not the pause conversation, not the
  // recorded keep. `record.js` never reads or writes the score.
  assert.equal(afterRecord.score, COOLED);
  assert.equal(afterRecord.last_update, afterContinuation.last_update);

  // --- The next real turn ----------------------------------------------
  // A different file, so the fingerprint mute the keep just wrote cannot be
  // what answers here — the score alone has to.
  const nextGroup = seedTurn(sandbox, ORDINARY_FILES[1]);
  assert.deepEqual(fingerprintMute(afterRecord).files, [ORDINARY_FILES[0]]);
  const next = runStop(sandbox);

  assertNoPause(sandbox, next);
  const afterNext = readStateDocument(sandbox);
  assertWithin(
    afterNext.score,
    scoreWindow({
      previousScore: COOLED,
      lastUpdate: afterRecord.last_update,
      group: nextGroup,
      invocation: next,
    }),
  );
  assert.ok(afterNext.score < BALANCED.threshold);
  // The cap is what silenced it: from the score the pause reported — the
  // fire-time score, before the cooldown — this very turn would have fired
  // again, which is the double-fire defect this journey keeps dead.
  //
  // Read it as a tripwire, not a proof, because of how much slack it carries.
  // It can only go red if this turn's delta falls further than the margin by
  // which `pause.score` clears the threshold — and a delta cannot fall further
  // than `weight_effort + question_relief`, since the volume terms never go
  // negative. `LOUD_SCORE` is seeded far enough above `threshold` that the
  // margin dwarfs that floor, so no edit to `seedTurn` alone can turn this red:
  // it takes a `LOUD_SCORE` moved down near the threshold, or a recalibration
  // that brings the two within reach of each other. Those are precisely the
  // changes that would make this journey's story untrue, which is why the line
  // stays. What rules out a silence from the WRONG cause is not this line but
  // the trace below — `scored`, never `muted`.
  assert.ok(scoreTurn(pause.score, 0, nextGroup, KNOBS) >= BALANCED.threshold);

  assert.deepEqual(
    stopTrace(sandbox).map((line) => line.outcome),
    ["fired", "continuation_truncated", "scored"],
  );
});

// ---------------------------------------------------------------------------
// Three refusals in a row retire the whole category.
// ---------------------------------------------------------------------------

test("three fired-and-skipped pauses retire the category, and the next candidate stays quiet", (t) => {
  const sandbox = createSandbox(t);
  seedState(sandbox, { score: 0, last_update: Date.now() });

  // Each round touches a different watched file, so the previous round's
  // fingerprint mute cannot be what ends the next one — only the skip streak
  // can accumulate across them.
  for (let round = 0; round < SKIPS_BEFORE_CATEGORY_MUTE; round += 1) {
    const file = WATCHED_FILES[round];
    seedTurn(sandbox, file);

    const fire = runStop(sandbox);
    assert.equal(fire.run.status, 0, `stderr:\n${fire.run.stderr}`);
    assert.equal(
      JSON.parse(fire.run.stdout).decision,
      "block",
      `round ${round + 1} was expected to fire`,
    );
    assert.equal(readPause(sandbox).classification.category, PASS_CATEGORY);

    const record = recordOutcome(sandbox, "skip", hookPausePath(sandbox));
    assert.equal(record.run.status, 0, `stderr:\n${record.run.stderr}`);
    assert.equal(record.run.result.ok, true);
    assert.equal(pauseExists(sandbox), false);
    assert.deepEqual(decisionFiles(sandbox), []);

    const state = readStateDocument(sandbox);
    assert.deepEqual(state.skip_totals, { [PASS_CATEGORY]: round + 1 });

    if (round + 1 < SKIPS_BEFORE_CATEGORY_MUTE) {
      assert.deepEqual(record.run.result.notices, []);
      assert.deepEqual(state.skip_streak, { [PASS_CATEGORY]: round + 1 });
      assert.equal(categoryMute(state), undefined);
      continue;
    }

    // The third skip is an answer of its own: the area goes quiet, and says so.
    const wide = categoryMute(state);
    assert.deepEqual(Object.keys(wide).sort(), [
      "category",
      "expires_at",
      "files",
    ]);
    assert.equal(wide.category, PASS_CATEGORY);
    assert.equal(wide.files, null);
    assertExpiresWithin(wide.expires_at, {
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      windowMs: KNOBS.category_mute_ms,
    });
    // The streak restarts; the lifetime count keeps counting.
    assert.deepEqual(state.skip_streak, { [PASS_CATEGORY]: 0 });

    assert.equal(record.run.result.notices.length, 1);
    const [notice] = record.run.result.notices;
    assert.ok(notice.includes(PASS_CATEGORY));
    // The duration is derived from the knob, never a literal in the prose.
    assert.ok(
      notice.includes(String(Math.round(KNOBS.category_mute_ms / MS_PER_HOUR))),
    );
    // The shipped skill is `stoic-setup`; `/setup/` would also match the
    // dead `/stoic-stack:setup` command.
    assert.match(notice, /\/stoic-stack:stoic-setup/);
  }

  // --- A fourth candidate, untouched by any fingerprint -----------------
  seedTurn(sandbox, WATCHED_FILES[3]);
  const fourth = runStop(sandbox);

  assertNoPause(sandbox, fourth);
  assert.deepEqual(
    stopTrace(sandbox).map((line) => line.outcome),
    ["fired", "fired", "fired", "muted"],
  );
});
