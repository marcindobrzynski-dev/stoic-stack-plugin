// The Stop hook's fire decision, exercised in process.
//
// `decideFire` is the whole "should this turn pause?" question with the I/O
// lifted out, so this suite owns the combinatorial surface the child-process
// contract suite cannot afford to enumerate: both gates in every combination,
// all four veto reasons, every mute shape, and the cooldown arithmetic. The
// classifier is reached through its `runner` seam — the same programmatic
// substitution `test/io/classifier.test.js` uses — so nothing here spawns a
// process, touches the filesystem, or reads a clock.
//
// Numbers come from the resolved knobs rather than literals: the scoring and
// cooldown placeholders are explicitly uncalibrated, and recalibrating one must
// not rewrite this suite.
//
// Contract: thoughts/shared/.project/architecture.md (Stop order of
// operations), architecture/payloads.md (§ `stoic-pending-pause.json`,
// § "Classifier verdict (LLM #1)", § `state.json` mute shape) and
// architecture/configuration.md (`critical_paths`, `cooldown_ratio`).
import assert from "node:assert/strict";
import { test } from "node:test";

import { decideFire } from "../../src/hooks/stop-decision.js";
import { VETO_REASONS } from "../../src/io/classifier.js";
import { defaultConfig, resolveKnobs } from "../../src/io/config.js";
import { defaultState } from "../../src/io/state.js";

/** The knobs every expectation below is expressed in. */
const KNOBS = resolveKnobs(defaultConfig(), defaultState());

/** The confidence floor the classifier judges a verdict against. */
const CONFIDENCE_FLOOR = defaultConfig().classifier_confidence_threshold;

/** A watched keyword the project ships with, and a path that touches it. */
const WATCHED_FILE = `src/${defaultConfig().critical_paths[0]}/session.js`;

/** An arbitrary instant; every expiry below is expressed relative to it. */
const NOW = 1_700_000_000_000;

/** A turn group carrying only what the gates and the classifier prompt read. */
function group(overrides) {
  return {
    prompt: "Store the session token in a cookie.",
    edit_count: 2,
    lines_added: 30,
    lines_removed: 4,
    edits: [{ file: "src/ui/panel.js", lines_added: 30, lines_removed: 4 }],
    ...overrides,
  };
}

/** A turn group whose edits touch a configured critical path. */
function criticalGroup(overrides) {
  return group({
    edits: [
      { file: WATCHED_FILE, lines_added: 30, lines_removed: 4 },
      { file: WATCHED_FILE, lines_added: 1, lines_removed: 0 },
    ],
    ...overrides,
  });
}

/** Personal state as the Stop hook loaded it, with overrides. */
function state(overrides) {
  return { ...defaultState(), ...overrides };
}

/** A verdict the classifier model could plausibly have emitted. */
function verdict(overrides) {
  return {
    decision_found: true,
    subcategory: "security_auth",
    reason: "The turn chose a token storage strategy.",
    confidence: 0.9,
    ...overrides,
  };
}

/** The classification `classify` returns for `verdict()` above. */
function classificationFor(overrides) {
  const { subcategory, reason, confidence, decision_found } = verdict();
  return {
    decision_found,
    category: "security",
    subcategory,
    reason,
    confidence,
    ...overrides,
  };
}

/** A runner seam answering with one verdict, as a successful headless call. */
function runnerAnswering(value) {
  return () => ({ status: "ok", value });
}

/** A mute entry exactly as `state.json` stores one, category-wide by default. */
function mute(overrides) {
  return {
    category: "security",
    files: null,
    expires_at: NOW + 60_000,
    ...overrides,
  };
}

/** Call options with the seam wired and the clock supplied. */
function options(overrides) {
  return { now: NOW, runner: runnerAnswering(verdict()), ...overrides };
}

// ---------------------------------------------------------------------------
// The gates — which turns are even candidates for a pause.
// ---------------------------------------------------------------------------

test("a quiet turn below both gates decides nothing further", () => {
  const decision = decideFire(
    state({ score: KNOBS.threshold - 1 }),
    defaultConfig(),
    group(),
    options(),
  );

  assert.deepEqual(decision, { outcome: "below_gates" });
});

test("a critical path fires at score zero", () => {
  const decision = decideFire(
    state({ score: 0 }),
    defaultConfig(),
    criticalGroup(),
    options(),
  );

  assert.equal(decision.outcome, "fire");
  assert.equal(decision.trigger, "critical_path");
  assert.equal(decision.score, 0);
});

test("a score at the threshold fires on the soft gate", () => {
  const decision = decideFire(
    state({ score: KNOBS.threshold }),
    defaultConfig(),
    group(),
    options(),
  );

  assert.equal(decision.outcome, "fire");
  assert.equal(decision.trigger, "score");
});

test("the hard gate names the trigger when both gates apply", () => {
  const decision = decideFire(
    state({ score: KNOBS.threshold * 10 }),
    defaultConfig(),
    criticalGroup(),
    options(),
  );

  assert.equal(decision.outcome, "fire");
  assert.equal(decision.trigger, "critical_path");
});

test("no decision ever names a streak as its trigger", () => {
  for (const candidate of [
    decideFire(
      state({ score: 0 }),
      defaultConfig(),
      criticalGroup(),
      options(),
    ),
    decideFire(
      state({ score: KNOBS.threshold }),
      defaultConfig(),
      group(),
      options(),
    ),
  ]) {
    assert.ok(["critical_path", "score"].includes(candidate.trigger));
  }
});

// ---------------------------------------------------------------------------
// The classifier veto — a fired gate the label refused to justify.
// ---------------------------------------------------------------------------

test("an unavailable classifier vetoes as no_classification", () => {
  const decision = decideFire(
    state({ score: KNOBS.threshold }),
    defaultConfig(),
    group(),
    options({ runner: () => ({ status: "unavailable", reason: "timeout" }) }),
  );

  assert.deepEqual(decision, {
    outcome: "veto",
    reason: "no_classification",
    trigger: "score",
  });
});

test("a verdict finding no decision vetoes as no_decision", () => {
  const decision = decideFire(
    state({ score: KNOBS.threshold }),
    defaultConfig(),
    group(),
    options({ runner: runnerAnswering(verdict({ decision_found: false })) }),
  );

  assert.equal(decision.outcome, "veto");
  assert.equal(decision.reason, "no_decision");
});

test("a verdict under the confidence floor vetoes as low_confidence", () => {
  const decision = decideFire(
    state({ score: KNOBS.threshold }),
    defaultConfig(),
    group(),
    options({
      runner: runnerAnswering(verdict({ confidence: CONFIDENCE_FLOOR / 2 })),
    }),
  );

  assert.equal(decision.outcome, "veto");
  assert.equal(decision.reason, "low_confidence");
});

test("an unresolvable label vetoes as bad_category", () => {
  const decision = decideFire(
    state({ score: KNOBS.threshold }),
    defaultConfig(),
    group(),
    options({ runner: runnerAnswering(verdict({ subcategory: "vibes" })) }),
  );

  assert.equal(decision.outcome, "veto");
  assert.equal(decision.reason, "bad_category");
});

test("every veto reason a decision can carry belongs to the frozen vocabulary", () => {
  const runners = [
    () => ({ status: "unavailable", reason: "timeout" }),
    runnerAnswering(verdict({ decision_found: false })),
    runnerAnswering(verdict({ confidence: 0 })),
    runnerAnswering(verdict({ subcategory: "vibes" })),
  ];

  const reasons = runners.map(
    (runner) =>
      decideFire(
        state({ score: KNOBS.threshold }),
        defaultConfig(),
        group(),
        options({ runner }),
      ).reason,
  );

  assert.deepEqual(reasons, [...VETO_REASONS]);
});

test("a confidence exactly at the floor still fires", () => {
  const decision = decideFire(
    state({ score: KNOBS.threshold }),
    defaultConfig(),
    group(),
    options({
      runner: runnerAnswering(verdict({ confidence: CONFIDENCE_FLOOR })),
    }),
  );

  assert.equal(decision.outcome, "fire");
  assert.equal(decision.classification.confidence, CONFIDENCE_FLOOR);
});

test("a fire carries the classification the classifier validated", () => {
  const decision = decideFire(
    state({ score: KNOBS.threshold }),
    defaultConfig(),
    group(),
    options(),
  );

  assert.deepEqual(decision.classification, classificationFor());
});

// ---------------------------------------------------------------------------
// Mutes — a decision already settled must not be re-litigated.
// ---------------------------------------------------------------------------

test("a category-wide mute suppresses a fire on any file", () => {
  const decision = decideFire(
    state({ score: KNOBS.threshold, mutes: [mute()] }),
    defaultConfig(),
    group(),
    options(),
  );

  assert.deepEqual(decision, {
    outcome: "muted",
    trigger: "score",
    classification: classificationFor(),
  });
});

test("a fingerprint mute over a touched file suppresses the fire", () => {
  const decision = decideFire(
    state({ score: 0, mutes: [mute({ files: [WATCHED_FILE] })] }),
    defaultConfig(),
    criticalGroup(),
    options(),
  );

  assert.equal(decision.outcome, "muted");
  assert.equal(decision.trigger, "critical_path");
});

test("a fingerprint mute over untouched files suppresses nothing", () => {
  const decision = decideFire(
    state({ score: 0, mutes: [mute({ files: ["src/other/thing.js"] })] }),
    defaultConfig(),
    criticalGroup(),
    options(),
  );

  assert.equal(decision.outcome, "fire");
});

test("an expired mute suppresses nothing", () => {
  const decision = decideFire(
    state({ score: KNOBS.threshold, mutes: [mute({ expires_at: NOW })] }),
    defaultConfig(),
    group(),
    options(),
  );

  assert.equal(decision.outcome, "fire");
});

test("a corrupt mute suppresses nothing", () => {
  for (const files of ["src/auth", 7, [""], [null, 3]]) {
    const decision = decideFire(
      state({ score: KNOBS.threshold, mutes: [mute({ files })] }),
      defaultConfig(),
      group(),
      options(),
    );

    assert.equal(decision.outcome, "fire", JSON.stringify(files));
  }
});

test("a mute on another category suppresses nothing", () => {
  const decision = decideFire(
    state({ score: KNOBS.threshold, mutes: [mute({ category: "testing" })] }),
    defaultConfig(),
    group(),
    options(),
  );

  assert.equal(decision.outcome, "fire");
});

// ---------------------------------------------------------------------------
// Cooldown — a fire caps the score, and never raises it.
// ---------------------------------------------------------------------------

test("a far-over-threshold fire cools to the capped fraction of the threshold", () => {
  const score = KNOBS.threshold * 10;

  const decision = decideFire(
    state({ score }),
    defaultConfig(),
    group(),
    options(),
  );

  assert.equal(decision.score, score);
  assert.equal(decision.threshold, KNOBS.threshold);
  assert.equal(
    decision.cooled_score,
    KNOBS.threshold * KNOBS.cooldown_ratio,
    "a loud turn must not stay loud enough to fire again",
  );
});

test("a fire already below the cap keeps its score", () => {
  const decision = decideFire(
    state({ score: 0 }),
    defaultConfig(),
    criticalGroup(),
    options(),
  );

  assert.equal(
    decision.cooled_score,
    0,
    "the cooldown must never raise a score",
  );
});

test("the cooldown follows the configured preset", () => {
  const config = { ...defaultConfig(), preset: "vigilant" };
  const knobs = resolveKnobs(config, defaultState());

  const decision = decideFire(
    state({ score: knobs.threshold * 4 }),
    config,
    group(),
    options(),
  );

  assert.equal(decision.threshold, knobs.threshold);
  assert.equal(decision.cooled_score, knobs.threshold * knobs.cooldown_ratio);
});

// ---------------------------------------------------------------------------
// Untrusted inputs — the decision never throws and never invents a pause.
// ---------------------------------------------------------------------------

test("a turn group that is not an object decides nothing", () => {
  for (const candidate of [undefined, null, "turn", 7, []]) {
    assert.deepEqual(
      decideFire(
        state({ score: KNOBS.threshold * 10 }),
        defaultConfig(),
        candidate,
        options(),
      ),
      { outcome: "below_gates" },
    );
  }
});

test("corrupt state, configuration, and options never throw", () => {
  for (const candidate of [undefined, null, "corrupt", 7, []]) {
    assert.doesNotThrow(() =>
      decideFire(candidate, candidate, group(), candidate),
    );
  }
});

test("an unreadable score is read as no score at all", () => {
  const decision = decideFire(
    state({ score: "loud" }),
    defaultConfig(),
    group(),
    options(),
  );

  assert.deepEqual(decision, { outcome: "below_gates" });
});

test("a runner that throws is a veto, not an exception", () => {
  const decision = decideFire(
    state({ score: KNOBS.threshold }),
    defaultConfig(),
    group(),
    options({
      runner: () => {
        throw new Error("spawn failed");
      },
    }),
  );

  assert.deepEqual(decision, {
    outcome: "veto",
    reason: "no_classification",
    trigger: "score",
  });
});
