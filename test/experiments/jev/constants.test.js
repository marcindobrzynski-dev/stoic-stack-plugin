import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_CLASSIFIER_MODEL,
  PRESETS,
  PRESET_NAMES,
  isCooldownRatio,
} from "../../../src/io/config/config.js";
import {
  FALLBACK_MODEL,
  PAUSE_THRESHOLDS,
  VETO_COOLDOWN_RATIO,
} from "../../../experiments/jev/constants.js";

test("pause thresholds order sensitivity as the preset names promise", () => {
  assert.ok(PAUSE_THRESHOLDS.calm > PAUSE_THRESHOLDS.balanced);
  assert.ok(PAUSE_THRESHOLDS.vigilant < PAUSE_THRESHOLDS.balanced);
});

test("every plugin preset has a valid pause threshold", () => {
  assert.deepEqual(
    Object.keys(PAUSE_THRESHOLDS).sort(),
    [...PRESET_NAMES].sort(),
  );

  for (const name of PRESET_NAMES) {
    const threshold = PAUSE_THRESHOLDS[name];
    assert.ok(Number.isFinite(threshold), `${name} threshold must be finite`);
    assert.ok(
      threshold > 0 && threshold < 1,
      `${name} threshold must be a probability inside (0, 1)`,
    );
  }
});

test("the veto cooldown is gentler than the pause cooldown on every preset", () => {
  for (const [name, knobs] of Object.entries(PRESETS)) {
    assert.ok(
      VETO_COOLDOWN_RATIO > knobs.cooldown_ratio,
      `veto cooldown ratio must leave a higher cap than ${name}.cooldown_ratio`,
    );
  }
});

test("the veto cooldown ratio passes the same validation as the pause cooldown ratio", () => {
  assert.equal(isCooldownRatio(VETO_COOLDOWN_RATIO), true);
  assert.equal(isCooldownRatio(0), true);
  assert.equal(isCooldownRatio(1), false);

  for (const invalid of [-0.1, 1, 1.5, "0.8", null, Number.NaN, Infinity]) {
    assert.equal(
      isCooldownRatio(invalid),
      false,
      `${String(invalid)} must be rejected`,
    );
  }
  assert.equal(DEFAULT_CLASSIFIER_MODEL, "claude-haiku-5-5");
  assert.equal(FALLBACK_MODEL, DEFAULT_CLASSIFIER_MODEL);
});
