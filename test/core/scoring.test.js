import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decayScore,
  relievedScore,
  rewardedScore,
  scoreTurn,
  turnDelta,
} from "../../src/core/scoring.js";
import {
  AUTO_ACCEPT_MULTIPLIER,
  DIFF_LINE_CAP,
  EDIT_COUNT_CAP,
  PRESETS,
  resolveKnobs,
} from "../../src/io/config/config.js";
import { MANUAL_RELIEF_FACTOR } from "../../src/io/config/manual-reflection.js";

const HOUR_MS = 60 * 60 * 1000;

/**
 * The knobs the mechanism tests score with — owned by these tests, NOT a
 * preset. They check the formula against the tests' own data, so a break in
 * scoring.js shows up whatever the presets are calibrated to. Every weight is
 * non-zero and distinct from the others, and the discount sits strictly
 * between 0 and 1, so no term collapses into the identity and no two
 * mutations can land on the same number.
 */
const TEST_KNOBS = Object.freeze({
  threshold: 12,
  half_life_hours: 5,
  weight_edits: 3,
  weight_diff: 5,
  weight_effort: 1.75,
  question_relief: 0.75,
  delegated_discount: 0.4,
});

/** A turn group exactly as `buildTurnGroup` shapes it, empty by default. */
function group(overrides = {}) {
  return {
    prompt: "",
    prompt_effort: 0,
    genuine_prompt_count: 0,
    neutralized_prompt_count: 0,
    prompt_neutralized: false,
    had_question: false,
    auto_accept: false,
    edit_count: 0,
    lines_added: 0,
    lines_removed: 0,
    delegated_edit_count: 0,
    delegated_lines_added: 0,
    delegated_lines_removed: 0,
    delegated: false,
    agent_count: 0,
    edits: [],
    subagent_events: [],
    understood_event_count: 0,
    skipped_event_count: 0,
    ...overrides,
  };
}

/** Knobs as the Stop hook will hand them: resolved knobs plus the constants. */
function scoringKnobs(overrides = {}) {
  return {
    ...TEST_KNOBS,
    edit_count_cap: EDIT_COUNT_CAP,
    diff_line_cap: DIFF_LINE_CAP,
    auto_accept_multiplier: AUTO_ACCEPT_MULTIPLIER,
    ...overrides,
  };
}

/** The edit term a given edit count should earn, from the named constants. */
const editTermOf = (effectiveEdits) =>
  (TEST_KNOBS.weight_edits * Math.min(effectiveEdits, EDIT_COUNT_CAP)) /
  EDIT_COUNT_CAP;

/** The diff term a given changed-line count should earn, likewise. */
const diffTermOf = (effectiveLines) =>
  (TEST_KNOBS.weight_diff * Math.min(effectiveLines, DIFF_LINE_CAP)) /
  DIFF_LINE_CAP;

/**
 * Assert scoring arithmetic without pinning float noise. The optional context
 * names which case failed, for the assertions looped over presets and scores.
 */
function assertClose(actual, expected, context = "") {
  const where = context === "" ? "" : ` (${context})`;
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `expected ${actual} to be within 1e-9 of ${expected}${where}`,
  );
}

// ---------------------------------------------------------------------------
// Decay — the score's only way down between turns.
// ---------------------------------------------------------------------------

test("a score with no elapsed time does not decay", () => {
  assert.equal(decayScore(8, 0, 6), 8);
});

test("exactly one half-life halves the score", () => {
  assertClose(decayScore(8, 6 * HOUR_MS, 6), 4);
});

test("three half-lives leave an eighth of the score", () => {
  assertClose(decayScore(8, 18 * HOUR_MS, 6), 1);
});

test("a huge elapsed time decays toward zero without ever going NaN", () => {
  const decayed = decayScore(8, Number.MAX_SAFE_INTEGER, 6);
  assert.ok(Number.isFinite(decayed));
  assert.ok(decayed >= 0);
  assert.ok(decayed < 1e-6);
});

test("a tiny elapsed time shaves almost nothing off the score", () => {
  const decayed = decayScore(8, 1, 6);
  assert.ok(decayed <= 8);
  assert.ok(decayed > 8 - 1e-6);
});

test("negative elapsed time never inflates the score", () => {
  assert.equal(decayScore(8, -3 * HOUR_MS, 6), 8);
});

test("an unusable previous score decays as zero rather than NaN", () => {
  for (const previous of [undefined, null, Number.NaN, Infinity, "8", -3]) {
    assert.equal(decayScore(previous, HOUR_MS, 6), 0);
  }
});

test("an unusable half-life leaves the score unchanged rather than wiping it", () => {
  for (const halfLife of [0, -2, Number.NaN, Infinity, undefined, "6"]) {
    assert.equal(decayScore(8, HOUR_MS, halfLife), 8);
  }
});

// ---------------------------------------------------------------------------
// The volume terms — caps as units, saturation, churn.
// ---------------------------------------------------------------------------

test("an empty turn moves the score by nothing", () => {
  assert.equal(turnDelta(group(), scoringKnobs()), 0);
});

test("the edit term grows below its cap, saturates at it, and never past it", () => {
  const knobs = scoringKnobs();
  const below = turnDelta(group({ edit_count: 4 }), knobs);
  const atCap = turnDelta(group({ edit_count: EDIT_COUNT_CAP }), knobs);
  const pastCap = turnDelta(group({ edit_count: EDIT_COUNT_CAP * 3 }), knobs);
  assertClose(below, editTermOf(4));
  assertClose(atCap, TEST_KNOBS.weight_edits);
  assertClose(pastCap, atCap);
});

test("the diff term grows below its cap, saturates at it, and never past it", () => {
  const knobs = scoringKnobs();
  const below = turnDelta(
    group({ edit_count: 0, lines_added: DIFF_LINE_CAP / 4 }),
    knobs,
  );
  const atCap = turnDelta(group({ lines_added: DIFF_LINE_CAP }), knobs);
  const pastCap = turnDelta(group({ lines_added: DIFF_LINE_CAP * 5 }), knobs);
  assertClose(below, diffTermOf(DIFF_LINE_CAP / 4));
  assertClose(atCap, TEST_KNOBS.weight_diff);
  assertClose(pastCap, atCap);
});

test("changed lines are churn — added plus removed, not the larger of the two", () => {
  const delta = turnDelta(
    group({ lines_added: 50, lines_removed: 50 }),
    scoringKnobs(),
  );
  assertClose(delta, diffTermOf(100));
  assert.notEqual(delta, diffTermOf(50));
});

// ---------------------------------------------------------------------------
// Auto-accept — the multiplier scales the summed volume, and only the volume.
// ---------------------------------------------------------------------------

test("an auto-accepted turn costs exactly the multiplier over the same manual turn", () => {
  const volume = { edit_count: 4, lines_added: 30, lines_removed: 10 };
  const knobs = scoringKnobs();
  const manual = turnDelta(group(volume), knobs);
  const auto = turnDelta(group({ ...volume, auto_accept: true }), knobs);
  assertClose(auto, manual * AUTO_ACCEPT_MULTIPLIER);
});

test("the multiplier scales the volume terms only, never effort or relief", () => {
  // All three term families present at once — the case that catches a
  // whole-delta multiplication, where relief would be worth more in the
  // riskier mode.
  const turn = {
    edit_count: 4,
    lines_added: 30,
    lines_removed: 10,
    prompt_effort: 0.5,
    had_question: true,
  };
  const knobs = scoringKnobs();
  const volume = editTermOf(4) + diffTermOf(40);
  const effort = TEST_KNOBS.weight_effort * 0.5;
  const manual = turnDelta(group(turn), knobs);
  const auto = turnDelta(group({ ...turn, auto_accept: true }), knobs);
  assertClose(manual, volume + effort - TEST_KNOBS.question_relief);
  assertClose(
    auto,
    volume * AUTO_ACCEPT_MULTIPLIER + effort - TEST_KNOBS.question_relief,
  );
});

// ---------------------------------------------------------------------------
// Delegation — the discount applies before the cap, and only to volume.
// ---------------------------------------------------------------------------

test("a mixed turn discounts only its delegated share", () => {
  const delta = turnDelta(
    group({ edit_count: 6, delegated_edit_count: 2, delegated: true }),
    scoringKnobs(),
  );
  assertClose(delta, editTermOf(4 + TEST_KNOBS.delegated_discount * 2));
});

test("the discount buys headroom before the cap, not an exemption from it", () => {
  // Discount before cap: the cap divided by the discount, fully delegated,
  // saturates exactly where the cap's worth of the developer's own edits does.
  const knobs = scoringKnobs();
  const delegatedTwiceCap = turnDelta(
    group({
      edit_count: EDIT_COUNT_CAP / TEST_KNOBS.delegated_discount,
      delegated_edit_count: EDIT_COUNT_CAP / TEST_KNOBS.delegated_discount,
      delegated: true,
    }),
    knobs,
  );
  const ownAtCap = turnDelta(group({ edit_count: EDIT_COUNT_CAP }), knobs);
  assertClose(delegatedTwiceCap, ownAtCap);
});

test("delegated lines are discounted the same way as delegated edits", () => {
  const delta = turnDelta(
    group({
      lines_added: 100,
      lines_removed: 60,
      delegated_lines_added: 50,
      delegated_lines_removed: 30,
      delegated: true,
    }),
    scoringKnobs(),
  );
  assertClose(delta, diffTermOf(80 + TEST_KNOBS.delegated_discount * 80));
});

test("the discount never touches the effort term — not thinking is not forgiven", () => {
  const knobs = scoringKnobs();
  const delegated = {
    edit_count: 6,
    delegated_edit_count: 6,
    delegated: true,
    agent_count: 6,
  };
  const silent = turnDelta(group(delegated), knobs);
  const lazy = turnDelta(group({ ...delegated, prompt_effort: 1 }), knobs);
  assertClose(lazy - silent, TEST_KNOBS.weight_effort * 1);
});

// ---------------------------------------------------------------------------
// Effort and relief — the two terms about the developer, not the volume.
// ---------------------------------------------------------------------------

test("a genuine question earns its relief, and only when it happened", () => {
  const knobs = scoringKnobs();
  const withQuestion = turnDelta(
    group({ edit_count: 4, had_question: true }),
    knobs,
  );
  const without = turnDelta(group({ edit_count: 4 }), knobs);
  assertClose(without - withQuestion, TEST_KNOBS.question_relief);
});

test("prompt effort is consumed as-is: low effort raises, high effort lowers", () => {
  // The dedicated no-sign-flip test. promptEffort already returns POSITIVE
  // for low effort, so a negation here would reward autopilot.
  const knobs = scoringKnobs();
  const neutral = turnDelta(group({ edit_count: 4 }), knobs);
  const lowEffort = turnDelta(
    group({ edit_count: 4, prompt_effort: 0.5 }),
    knobs,
  );
  const highEffort = turnDelta(
    group({ edit_count: 4, prompt_effort: -0.5 }),
    knobs,
  );
  assertClose(lowEffort - neutral, TEST_KNOBS.weight_effort * 0.5);
  assertClose(highEffort - neutral, -TEST_KNOBS.weight_effort * 0.5);
});

test("a high-effort turn with little volume posts a negative delta", () => {
  const delta = turnDelta(
    group({ edit_count: 1, prompt_effort: -1 }),
    scoringKnobs(),
  );
  assert.ok(delta < 0);
  assertClose(delta, editTermOf(1) - TEST_KNOBS.weight_effort);
});

test("a neutralized-prompt turn contributes no effort term", () => {
  // The group already carries prompt_effort: 0 for a neutralized turn; the
  // scorer needs no special branch, but the contract deserves proof.
  const delta = turnDelta(
    group({
      prompt_neutralized: true,
      prompt_effort: 0,
      neutralized_prompt_count: 2,
      edit_count: 4,
    }),
    scoringKnobs(),
  );
  assertClose(delta, editTermOf(4));
});

// ---------------------------------------------------------------------------
// The whole turn — decay plus delta, floored at zero.
// ---------------------------------------------------------------------------

test("a large negative delta floors the score at exactly zero, never below", () => {
  // Decayed 0.5, relief alone pulls the delta below -0.5 → the floor holds.
  const score = scoreTurn(
    1,
    TEST_KNOBS.half_life_hours * HOUR_MS,
    group({ had_question: true }),
    scoringKnobs(),
  );
  assert.equal(score, 0);
});

test("an unusable previous score scores the turn from zero", () => {
  const turn = group({ edit_count: 4 });
  const knobs = scoringKnobs();
  assertClose(scoreTurn(Number.NaN, 0, turn, knobs), editTermOf(4));
});

test("the worked example: an auto-accepted turn on a decayed score", () => {
  // 4 edits, 150 changed lines, effort +0.5, a genuine question, auto-accept
  // on, previous score 8.0, 3 hours elapsed.
  const turn = group({
    prompt_effort: 0.5,
    had_question: true,
    auto_accept: true,
    edit_count: 4,
    lines_added: 100,
    lines_removed: 50,
  });
  const knobs = scoringKnobs();

  const volume = (editTermOf(4) + diffTermOf(150)) * AUTO_ACCEPT_MULTIPLIER;
  const delta =
    volume + TEST_KNOBS.weight_effort * 0.5 - TEST_KNOBS.question_relief;
  const decayed = 8 * 0.5 ** (3 / TEST_KNOBS.half_life_hours);

  assertClose(turnDelta(turn, knobs), delta);
  assertClose(
    scoreTurn(8, 3 * HOUR_MS, turn, knobs),
    Math.max(0, decayed + delta),
  );
});

// ---------------------------------------------------------------------------
// Relief — the two moments a pause lowers the score, one factor apart.
//
// Every property below is asserted over EVERY preset and over a spread of
// scores that straddles the cap, not over one worked example: the cap and the
// reward are calibration, and a recalibration must not be able to make a
// property quietly stop being checked where it matters.
// ---------------------------------------------------------------------------

/** Each preset by name, so relief is proven a property of all three. */
const PRESET_ENTRIES = Object.entries(PRESETS);

/** The cap the fire-time relief applies for a given preset. */
const capOf = (preset) => preset.threshold * preset.cooldown_ratio;

/**
 * The score spread each property is checked over: nothing, comfortably below
 * the cap, exactly at it, over the threshold, and far past it.
 */
const scoreSpread = (preset) => [
  0,
  capOf(preset) / 2,
  capOf(preset),
  preset.threshold * 1.5,
  preset.threshold * 10,
];

/** Knobs as the recorder hands them: the cap's ratio plus the reward factor. */
const rewardKnobs = (preset, overrides = {}) => ({
  cooldown_ratio: preset.cooldown_ratio,
  manual_relief_factor: MANUAL_RELIEF_FACTOR,
  ...overrides,
});

test("the fire-time relief caps a score at its preset's fraction of the threshold", () => {
  for (const [name, preset] of PRESET_ENTRIES) {
    for (const score of scoreSpread(preset)) {
      assertClose(
        relievedScore(score, preset.threshold, preset.cooldown_ratio),
        Math.min(score, capOf(preset)),
        `${name} at ${score}`,
      );
    }
  }
});

test("a score already below the cap is left exactly as it stands by the fire-time relief", () => {
  for (const [name, preset] of PRESET_ENTRIES) {
    const below = capOf(preset) / 2;
    assert.equal(
      relievedScore(below, preset.threshold, preset.cooldown_ratio),
      below,
      `${name} must not move a score the cap does not bite`,
    );
  }
});

test("the rewarded score is the capped score scaled by the manual reward factor", () => {
  for (const [name, preset] of PRESET_ENTRIES) {
    for (const score of scoreSpread(preset)) {
      const capped = relievedScore(
        score,
        preset.threshold,
        preset.cooldown_ratio,
      );
      assertClose(
        rewardedScore(score, preset.threshold, rewardKnobs(preset)),
        capped * MANUAL_RELIEF_FACTOR,
        `${name} at ${score}`,
      );
    }
  }
});

test("the rewarded score is never worse than the automatic relief, and always lower than a positive score", () => {
  for (const [name, preset] of PRESET_ENTRIES) {
    for (const score of scoreSpread(preset)) {
      const automatic = relievedScore(
        score,
        preset.threshold,
        preset.cooldown_ratio,
      );
      const rewarded = rewardedScore(
        score,
        preset.threshold,
        rewardKnobs(preset),
      );
      assert.ok(
        rewarded <= automatic,
        `${name} at ${score}: the reward must never be the worse path`,
      );
      if (score > 0) {
        assert.ok(
          rewarded < score,
          `${name} at ${score}: a completed reflection always earns relief`,
        );
      }
    }
  }
});

test("neither relief ever raises a score, at any preset or any height", () => {
  for (const [name, preset] of PRESET_ENTRIES) {
    for (const score of scoreSpread(preset)) {
      assert.ok(
        relievedScore(score, preset.threshold, preset.cooldown_ratio) <= score,
        `${name} at ${score}: the cap is a cap, never an assignment`,
      );
      assert.ok(
        rewardedScore(score, preset.threshold, rewardKnobs(preset)) <= score,
        `${name} at ${score}: the reward is relief, never a raise`,
      );
    }
  }
});

test("a score below the cap is untouched by the fire-time relief and still lowered by the reward", () => {
  // The asymmetry that motivated the whole design: a developer who reflects
  // BEFORE drifting gets nothing from a cap and everything from the reward.
  for (const [name, preset] of PRESET_ENTRIES) {
    const below = capOf(preset) / 2;
    assert.equal(
      relievedScore(below, preset.threshold, preset.cooldown_ratio),
      below,
      `${name}: the automatic path leaves an early reflection unrewarded`,
    );
    assert.ok(
      rewardedScore(below, preset.threshold, rewardKnobs(preset)) < below,
      `${name}: the manual path must reward it anyway`,
    );
  }
});

test("an unreadable score, threshold, or ratio relieves to zero rather than to NaN", () => {
  const unusable = [undefined, null, Number.NaN, Infinity, "8", -3];
  for (const [name, preset] of PRESET_ENTRIES) {
    for (const broken of unusable) {
      const noScore = relievedScore(
        broken,
        preset.threshold,
        preset.cooldown_ratio,
      );
      assert.equal(noScore, 0, `${name}: an unreadable score is no score`);

      const noCap = relievedScore(
        preset.threshold,
        broken,
        preset.cooldown_ratio,
      );
      assert.equal(noCap, 0, `${name}: an unreadable threshold is a zero cap`);

      const noRatio = relievedScore(preset.threshold, preset.threshold, broken);
      assert.equal(noRatio, 0, `${name}: an unreadable ratio is a zero cap`);
    }
  }
});

test("an unreadable reward factor withholds the reward without raising the score", () => {
  // discountOf semantics: the safe degradation of a reward is to withhold it.
  const unusable = [undefined, null, Number.NaN, Infinity, "0.25", -0.5, 1.5];
  for (const [name, preset] of PRESET_ENTRIES) {
    for (const score of scoreSpread(preset)) {
      const automatic = relievedScore(
        score,
        preset.threshold,
        preset.cooldown_ratio,
      );
      for (const factor of unusable) {
        const rewarded = rewardedScore(
          score,
          preset.threshold,
          rewardKnobs(preset, { manual_relief_factor: factor }),
        );
        assert.ok(
          Number.isFinite(rewarded),
          `${name} at ${score}: a broken factor must not persist a NaN`,
        );
        assert.equal(
          rewarded,
          automatic,
          `${name} at ${score}: a broken factor is no reward, never a raise`,
        );
      }
    }
  }
});

test("knobs that are not an object fall to the floors rather than throwing", () => {
  for (const [name, preset] of PRESET_ENTRIES) {
    for (const knobs of [undefined, null, "knobs", 0.25, [0.25]]) {
      const rewarded = rewardedScore(preset.threshold, preset.threshold, knobs);
      assert.ok(
        Number.isFinite(rewarded),
        `${name}: unusable knobs must not persist a NaN`,
      );
      assert.equal(
        rewarded,
        0,
        `${name}: an unreadable ratio is a zero cap, so the reward is zero`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Purity — the scorer reads its arguments, it never edits them.
// ---------------------------------------------------------------------------

test("scoring a turn leaves the group and the knobs untouched", () => {
  const turn = group({
    edit_count: 4,
    lines_added: 30,
    delegated_edit_count: 2,
    prompt_effort: 0.5,
    had_question: true,
    auto_accept: true,
    edits: [{ ts: 1, file: "src/a.js" }],
  });
  const knobs = scoringKnobs();
  const turnBefore = structuredClone(turn);
  const knobsBefore = structuredClone(knobs);
  scoreTurn(8, 3 * HOUR_MS, turn, knobs);
  assert.deepEqual(turn, turnBefore);
  assert.deepEqual(knobs, knobsBefore);
});

// ---------------------------------------------------------------------------
// Robustness — any input shape, never a throw, never a NaN.
// ---------------------------------------------------------------------------

test("a group of unusable fields scores as if those fields were absent", () => {
  const delta = turnDelta(
    group({
      edit_count: "many",
      lines_added: Number.NaN,
      lines_removed: -40,
      delegated_edit_count: Infinity,
      prompt_effort: Infinity,
      had_question: "yes",
      auto_accept: 1,
    }),
    scoringKnobs(),
  );
  assert.equal(delta, 0);
});

test("anything that is not a group scores as an empty turn", () => {
  for (const input of [undefined, null, 42, "group", ["edit"]]) {
    assert.equal(turnDelta(input, scoringKnobs()), 0);
  }
});

test("missing or unusable knobs degrade the delta to zero rather than NaN", () => {
  const turn = group({ edit_count: 4, lines_added: 30, prompt_effort: 0.5 });
  for (const knobs of [undefined, null, {}, "knobs"]) {
    const delta = turnDelta(turn, knobs);
    assert.ok(Number.isFinite(delta));
    assert.equal(delta, 0);
  }
});

test("a missing cap silences its own term instead of dividing by nothing", () => {
  const turn = group({ edit_count: 4, lines_added: 30, lines_removed: 10 });
  const delta = turnDelta(
    turn,
    scoringKnobs({ edit_count_cap: undefined, diff_line_cap: 0 }),
  );
  assert.ok(Number.isFinite(delta));
  assert.equal(delta, 0);
});

test("a delegated share larger than the total cannot push volume negative", () => {
  const delta = turnDelta(
    group({ edit_count: 2, delegated_edit_count: 10, delegated: true }),
    scoringKnobs(),
  );
  assert.ok(Number.isFinite(delta));
  assertClose(delta, editTermOf(TEST_KNOBS.delegated_discount * 2));
});

test("prompt effort outside the signal range is clamped before weighting", () => {
  const knobs = scoringKnobs();
  const overflowing = turnDelta(group({ prompt_effort: 99 }), knobs);
  const atCeiling = turnDelta(group({ prompt_effort: 1 }), knobs);
  assertClose(overflowing, atCeiling);
});

test("scoring an entirely unusable turn never throws and never yields NaN", () => {
  const score = scoreTurn(undefined, "later", null, null);
  assert.ok(Number.isFinite(score));
  assert.equal(score, 0);
});

// ---------------------------------------------------------------------------
// The config guard — the caps and the multiplier are constants, not knobs.
// ---------------------------------------------------------------------------

test("the scoring constants cannot be smuggled in through advanced overrides", () => {
  // Worth more than any arithmetic test above: the constants live in
  // config.js for calibration's sake, but they must never become user-facing
  // knobs — resolveKnobs must drop them in every spelling.
  const config = {
    preset: "balanced",
    advanced: {
      EDIT_COUNT_CAP: 999,
      edit_count_cap: 999,
      DIFF_LINE_CAP: 1,
      diff_line_cap: 1,
      AUTO_ACCEPT_MULTIPLIER: 9,
      auto_accept_multiplier: 9,
    },
  };
  assert.deepEqual(resolveKnobs(config), { ...PRESETS.balanced });
});
