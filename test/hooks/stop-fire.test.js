// The Stop hook's fire path, driven as a real child process — parts 1 and 2 of
// the frozen pause-delivery contract.
//
// This is the outside view of a pause. The suite seeds a session log and a
// state document, runs the REAL `src/hooks/stop.js` as a child, and asserts
// only what Claude Code and the filesystem could observe: exit status, stdout,
// `stoic-pending-pause.json`, `state.json`, and the trace. Nothing is stubbed
// inside the process — `options.runner` stays unset, so the production
// `classify` → `runClaude` → spawn chain really runs.
//
// Which makes the child's PATH the load-bearing part of the harness. A real
// Claude CLI is installed on developer machines, so the environment is rebuilt
// from nothing but a shim directory and the minimum a shell needs (see
// `../helpers/claude-shim.js`): the only `claude` the hook can reach is the
// stub, and a test that accidentally escaped that would fail rather than call
// a model.
//
// The combinatorial surface — every veto reason, every mute shape, the
// cooldown arithmetic — belongs to `stop-decision.test.js`, which asks the same
// question in-process. What lives here is only what a spawn can prove.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §`stoic-pending-pause.json` (part 1) and §"Stop hook output" (part 2).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { buildTurnGroup } from "../../src/core/group.js";
import { scoreTurn } from "../../src/core/scoring.js";
import {
  AUTO_ACCEPT_MULTIPLIER,
  DIFF_LINE_CAP,
  EDIT_COUNT_CAP,
  PRESETS,
} from "../../src/io/config/config.js";
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
import { createSandbox } from "../helpers/sandbox.js";

const SESSION_ID = "session-stop-fire-1";
const HOUR_MS = 60 * 60 * 1000;

/** The preset an unconfigured project resolves to — the knobs under test. */
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

/** A file matching the default `critical_paths` keyword `auth`. */
const WATCHED_FILE = "src/auth/roles.js";

/** A file matching no default critical path. */
const ORDINARY_FILE = "src/ui/table.js";

/** The plugin root the pause document must report: two levels above `src/hooks`. */
const PLUGIN_ROOT = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);

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
 * Seed the turn under test: one genuine prompt and one edit of `file`. Returns
 * the turn group the Stop hook will build from it, so expectations are the
 * engine's own arithmetic rather than restated numbers.
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
  const env =
    options.env ??
    claudeShimEnv(sandbox, options.scenario ?? VERDICT_SCENARIOS.pass);
  const startedAt = Date.now();
  const run = sandbox.runNode(hookEntrypoint("stop"), [], {
    input: JSON.stringify(stopPayload(sandbox, options.overrides)),
    env,
  });
  return { run, startedAt, finishedAt: Date.now() };
}

/** The one trace line a single Stop invocation is contracted to write. */
function soleStopTrace(sandbox) {
  const lines = readTrace(sandbox).filter((line) => line.hook === "Stop");
  assert.equal(
    lines.length,
    1,
    `expected exactly one Stop trace line, got ${JSON.stringify(lines)}`,
  );
  return lines[0];
}

/**
 * The fire-time score the child could plausibly have computed, as a range.
 * `invocation` is a whole {@link runStop} result — the spawn and the wall clock
 * either side of it — of which only the two timestamps are read here. The
 * child's own clock reading is unknowable, so both ends are computed.
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

/** The pending-pause document as an outside observer would read it. */
function readPause(sandbox) {
  return JSON.parse(
    fs.readFileSync(
      pendingPausePath(sandbox.projectDir, sandbox.homeDir),
      "utf8",
    ),
  );
}

const pauseExists = (sandbox) =>
  fs.existsSync(pendingPausePath(sandbox.projectDir, sandbox.homeDir));

/** A suppressed turn: exit 0, and stdout genuinely empty — no block at all. */
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

// ---------------------------------------------------------------------------
// Contract part 1 — the pending-pause document.
// ---------------------------------------------------------------------------

test("a fire writes the full pending-pause document", (t) => {
  const sandbox = createSandbox(t);
  const lastUpdate = Date.now();
  seedState(sandbox, { score: LOUD_SCORE, last_update: lastUpdate });
  const group = seedTurn(sandbox, WATCHED_FILE);

  const stop = runStop(sandbox);

  assert.equal(stop.run.status, 0, `stderr:\n${stop.run.stderr}`);
  const pause = readPause(sandbox);

  assert.deepEqual(Object.keys(pause).sort(), [
    "classification",
    "created_at",
    "cwd",
    "followup_draft",
    "group",
    "max_questions",
    "pause_mode",
    "plugin_root",
    "record_cmd",
    "score",
    "threshold",
    "trigger",
  ]);
  assert.ok(
    pause.created_at >= stop.startedAt && pause.created_at <= stop.finishedAt,
    `created_at ${pause.created_at} outside the invocation window`,
  );
  assert.equal(pause.trigger, "critical_path");
  assertWithin(
    pause.score,
    scoreWindow({
      previousScore: LOUD_SCORE,
      lastUpdate,
      group,
      invocation: stop,
    }),
  );
  assert.equal(pause.threshold, BALANCED.threshold);
  assert.deepEqual(pause.classification, {
    decision_found: true,
    category: PASS_CATEGORY,
    subcategory: PASS_VERDICT.subcategory,
    reason: PASS_VERDICT.reason,
    confidence: PASS_VERDICT.confidence,
  });
  // The turn group travels verbatim: the pause skill and the decision bank both
  // read the very summary that was scored, not a re-derivation of it.
  assert.deepEqual(pause.group, group);
  assert.equal(pause.cwd, sandbox.projectDir);
  assert.equal(pause.plugin_root, PLUGIN_ROOT);
  assert.equal(path.isAbsolute(pause.plugin_root), true);
  // The plugin-root path is quoted: a marketplace install can sit under a
  // path with spaces, and the skill shells this command verbatim.
  assert.equal(
    pause.record_cmd,
    `node "${path.join(PLUGIN_ROOT, "src", "cli", "record.js")}"`,
  );
  assert.equal(pause.pause_mode, "hybrid");
  assert.equal(pause.followup_draft, true);
  assert.equal(pause.max_questions, 3);
});

test("the fire-time score is persisted cooled, and traced as fired", (t) => {
  const sandbox = createSandbox(t);
  const lastUpdate = Date.now();
  seedState(sandbox, { score: LOUD_SCORE, last_update: lastUpdate });
  const group = seedTurn(sandbox, ORDINARY_FILE);

  const stop = runStop(sandbox);

  const pause = readPause(sandbox);
  assert.equal(pause.trigger, "score");
  // The document reports the score that fired; state keeps the cooled one.
  assert.ok(pause.score > BALANCED.threshold);
  assert.equal(readStateDocument(sandbox).score, COOLED);

  const line = soleStopTrace(sandbox);
  assert.equal(line.outcome, "fired");
  assert.equal(line.trigger, "score");
  assert.equal(line.score_before, LOUD_SCORE);
  assert.equal(line.score_after, COOLED);
  assertWithin(
    pause.score,
    scoreWindow({
      previousScore: LOUD_SCORE,
      lastUpdate,
      group,
      invocation: stop,
    }),
  );
});

// ---------------------------------------------------------------------------
// Contract part 2 — the Stop-block on stdout.
// ---------------------------------------------------------------------------

test("a fire prints exactly the Stop-block, and nothing else", (t) => {
  const sandbox = createSandbox(t);
  seedState(sandbox, { score: LOUD_SCORE, last_update: Date.now() });
  seedTurn(sandbox, WATCHED_FILE);

  const stop = runStop(sandbox);

  const block = JSON.parse(stop.run.stdout);
  assert.deepEqual(Object.keys(block).sort(), ["decision", "reason"]);
  assert.equal(block.decision, "block");
  assert.equal(
    stop.run.stdout,
    JSON.stringify(block),
    "stdout must carry the block object alone — no banner, no trailing prose",
  );

  // The three machine-actionable elements the skill depends on.
  assert.ok(
    block.reason.includes("stoic-stack:stoic-pause"),
    `reason must name the skill: ${block.reason}`,
  );
  assert.ok(
    block.reason.includes(
      pendingPausePath(sandbox.projectDir, sandbox.homeDir),
    ),
    `reason must carry the absolute pause path: ${block.reason}`,
  );
  assert.match(block.reason, /end the turn/i);
});

// ---------------------------------------------------------------------------
// The hard gate is independent of the score, and the cooldown never raises one.
// ---------------------------------------------------------------------------

test("a watched path fires at a low score without raising it", (t) => {
  const sandbox = createSandbox(t);
  seedState(sandbox, { score: 0, last_update: Date.now() });
  const group = seedTurn(sandbox, WATCHED_FILE);
  const ownDelta = scoreTurn(0, 0, group, KNOBS);
  // The control only means something if the turn really is below the soft gate.
  assert.ok(ownDelta < BALANCED.threshold);
  assert.ok(ownDelta < COOLED);

  const stop = runStop(sandbox);

  assert.equal(stop.run.status, 0, `stderr:\n${stop.run.stderr}`);
  assert.equal(readPause(sandbox).trigger, "critical_path");
  // The cooldown is a cap, never an assignment: pausing must not hand a quiet
  // session the score it did not earn.
  const persisted = readStateDocument(sandbox).score;
  assert.ok(
    Math.abs(persisted - ownDelta) < EPSILON,
    `expected the cooldown to leave ${ownDelta} alone, got ${persisted}`,
  );
});

// ---------------------------------------------------------------------------
// The double-fire regression: one loud turn must not pause twice.
// ---------------------------------------------------------------------------

test("a loud turn fires once and the quiet turn after it does not", (t) => {
  const sandbox = createSandbox(t);
  seedState(sandbox, { score: LOUD_SCORE, last_update: Date.now() });
  seedTurn(sandbox, ORDINARY_FILE);

  const first = runStop(sandbox);
  assert.equal(JSON.parse(first.run.stdout).decision, "block");
  assert.equal(readStateDocument(sandbox).score, COOLED);
  // The pause skill would have consumed the document; the regression is about
  // the score, so clear it and let the next turn speak for itself.
  fs.rmSync(pendingPausePath(sandbox.projectDir, sandbox.homeDir));

  const second = runStop(sandbox);

  assertNoPause(sandbox, second);
  const lines = readTrace(sandbox).filter((line) => line.hook === "Stop");
  assert.deepEqual(
    lines.map((line) => line.outcome),
    ["fired", "scored"],
  );
});

// ---------------------------------------------------------------------------
// Suppression — stdout stays genuinely empty.
// ---------------------------------------------------------------------------

test("a turn below both gates says nothing at all", (t) => {
  const sandbox = createSandbox(t);
  seedState(sandbox, { score: 0, last_update: Date.now() });
  seedTurn(sandbox, ORDINARY_FILE);

  const stop = runStop(sandbox);

  assertNoPause(sandbox, stop);
  assert.equal(soleStopTrace(sandbox).outcome, "scored");
});

test("a vetoed candidate says nothing at all", (t) => {
  const sandbox = createSandbox(t);
  seedState(sandbox, { score: LOUD_SCORE, last_update: Date.now() });
  seedTurn(sandbox, WATCHED_FILE);

  const stop = runStop(sandbox, { scenario: VERDICT_SCENARIOS.noDecision });

  assertNoPause(sandbox, stop);
  const line = soleStopTrace(sandbox);
  assert.equal(line.outcome, "veto");
  assert.equal(line.reason, "no_decision");
  assert.equal(line.trigger, "critical_path");
});

test("an active category mute says nothing at all", (t) => {
  const sandbox = createSandbox(t);
  const now = Date.now();
  seedState(sandbox, {
    score: LOUD_SCORE,
    last_update: now,
    mutes: [
      { category: PASS_CATEGORY, files: null, expires_at: now + HOUR_MS },
    ],
  });
  seedTurn(sandbox, WATCHED_FILE);

  const stop = runStop(sandbox);

  assertNoPause(sandbox, stop);
  assert.equal(soleStopTrace(sandbox).outcome, "muted");
});

// ---------------------------------------------------------------------------
// Mute hygiene — the pre-gate save is what prunes.
// ---------------------------------------------------------------------------

test("expired mutes are pruned into state and suppress nothing", (t) => {
  const sandbox = createSandbox(t);
  const now = Date.now();
  const alive = {
    category: "architecture",
    files: null,
    expires_at: now + HOUR_MS,
  };
  seedState(sandbox, {
    score: LOUD_SCORE,
    last_update: now,
    mutes: [
      { category: PASS_CATEGORY, files: null, expires_at: now - HOUR_MS },
      alive,
    ],
  });
  seedTurn(sandbox, WATCHED_FILE);

  const stop = runStop(sandbox);

  assert.equal(JSON.parse(stop.run.stdout).decision, "block");
  assert.deepEqual(readStateDocument(sandbox).mutes, [alive]);
});

// ---------------------------------------------------------------------------
// Fail-silent: a pause that cannot be written costs the pause, not the turn.
// ---------------------------------------------------------------------------

test("an unwritable pause document costs the pause, not the session", (t) => {
  const sandbox = createSandbox(t);
  seedState(sandbox, { score: LOUD_SCORE, last_update: Date.now() });
  seedTurn(sandbox, WATCHED_FILE);
  // A directory where the document belongs: the atomic rename cannot land.
  fs.mkdirSync(pendingPausePath(sandbox.projectDir, sandbox.homeDir), {
    recursive: true,
  });

  const stop = runStop(sandbox);

  assert.equal(stop.run.status, 0, `stderr:\n${stop.run.stderr}`);
  assert.equal(
    stop.run.stdout,
    "",
    "a pause that could not be written must never be announced",
  );
  // The score still made it to disk: the save happens before the gating.
  assert.equal(readStateDocument(sandbox).score, COOLED);
  const line = soleStopTrace(sandbox);
  assert.equal(line.outcome, "error");
  assert.equal(typeof line.error, "string");
});
