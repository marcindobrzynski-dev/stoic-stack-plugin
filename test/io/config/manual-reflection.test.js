import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  PRESETS,
  defaultConfig,
  loadConfig,
  normalizeConfig,
  resolveKnobs,
} from "../../../src/io/config/config.js";
import {
  MANUAL_RELIEF_FACTOR,
  resolveManualReflection,
} from "../../../src/io/config/manual-reflection.js";
import { makeTempDir } from "../../helpers/temp-dir.js";

/** Write a project configuration document, as a user or an earlier setup run would. */
function writeConfig(projectDir, document) {
  const configPath = path.join(projectDir, ".stoic", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, document, "utf8");
  return configPath;
}

/** The six fields the manual path consumes, in no particular order. */
const MANUAL_FIELDS = [
  "pause_mode",
  "max_questions",
  "followup_draft",
  "threshold",
  "cooldown_ratio",
  "manual_relief_factor",
];

// --- The shape of the resolved settings -----------------------------------

test("the resolver returns exactly the six fields the manual path consumes", () => {
  const resolved = resolveManualReflection(defaultConfig(), {});

  assert.deepEqual(Object.keys(resolved).sort(), [...MANUAL_FIELDS].sort());
});

test("the resolver carries nothing about categories, the classifier, or scoring", () => {
  const resolved = resolveManualReflection(defaultConfig(), {});

  for (const absent of [
    "categories",
    "subcategories",
    "critical_paths",
    "classifier_model",
    "classifier_confidence_threshold",
    "enabled",
    "preset",
    "advanced",
    "weight_edits",
    "weight_diff",
    "weight_effort",
    "half_life_hours",
    "mute_window_ms",
    "category_mute_ms",
    "question_relief",
    "delegated_discount",
  ]) {
    assert.equal(
      Object.hasOwn(resolved, absent),
      false,
      `expected the manual settings to omit ${absent}`,
    );
  }
});

// --- Every field is what the existing resolvers already produce ------------

test("the conversation fields are the ones the configuration itself carries", () => {
  const config = defaultConfig();

  const resolved = resolveManualReflection(config, {});

  assert.equal(resolved.pause_mode, config.pause_mode);
  assert.equal(resolved.max_questions, config.max_questions);
  assert.equal(resolved.followup_draft, config.followup_draft);
});

test("a configured conversation shape reaches the resolved settings", () => {
  const config = normalizeConfig({
    pause_mode: "freeform",
    max_questions: 2,
    followup_draft: false,
  });

  const resolved = resolveManualReflection(config, {});

  assert.equal(resolved.pause_mode, config.pause_mode);
  assert.equal(resolved.max_questions, config.max_questions);
  assert.equal(resolved.followup_draft, config.followup_draft);
});

test("the two formula knobs are the ones the knob resolver produces", () => {
  const config = defaultConfig();
  const knobs = resolveKnobs(config, {});

  const resolved = resolveManualReflection(config, {});

  assert.equal(resolved.threshold, knobs.threshold);
  assert.equal(resolved.cooldown_ratio, knobs.cooldown_ratio);
});

// --- The overrides keep working through the existing functions -------------

test("an advanced override of the formula knobs reaches the resolved settings", () => {
  const config = normalizeConfig({
    preset: "calm",
    advanced: {
      threshold: PRESETS.vigilant.threshold,
      cooldown_ratio: PRESETS.balanced.cooldown_ratio / 2,
    },
  });
  const knobs = resolveKnobs(config, {});

  const resolved = resolveManualReflection(config, {});

  assert.equal(resolved.threshold, knobs.threshold);
  assert.equal(resolved.cooldown_ratio, knobs.cooldown_ratio);
  assert.equal(resolved.threshold !== PRESETS.calm.threshold, true);
});

test("a personal preset override reaches the resolved settings", () => {
  const config = normalizeConfig({ preset: "calm" });
  const state = { preset: "vigilant" };

  const resolved = resolveManualReflection(config, state);

  assert.equal(resolved.threshold, PRESETS.vigilant.threshold);
  assert.equal(resolved.cooldown_ratio, PRESETS.vigilant.cooldown_ratio);
});

// --- Failure behavior ------------------------------------------------------

test("a project without configuration resolves to the built-in defaults", (t) => {
  const projectDir = makeTempDir(t, "stoic-manual-");
  const defaults = resolveManualReflection(defaultConfig(), {});

  const resolved = resolveManualReflection(loadConfig(projectDir), {});

  assert.deepEqual(resolved, defaults);
});

test("a corrupt configuration document resolves to the built-in defaults", (t) => {
  const projectDir = makeTempDir(t, "stoic-manual-");
  writeConfig(projectDir, "{ this is not json");
  const defaults = resolveManualReflection(defaultConfig(), {});

  const resolved = resolveManualReflection(loadConfig(projectDir), {});

  assert.deepEqual(resolved, defaults);
});

test("settings that are not a document at all resolve without throwing", () => {
  const defaults = resolveManualReflection(defaultConfig(), {});

  for (const raw of [undefined, null, "balanced", 7, [], true]) {
    assert.deepEqual(resolveManualReflection(raw, undefined), defaults);
  }
});

// --- The reward factor -----------------------------------------------------

test("the reward factor is the module constant, whatever the configuration says", () => {
  const configured = normalizeConfig({
    advanced: { manual_relief_factor: MANUAL_RELIEF_FACTOR + 0.5 },
  });

  assert.equal(
    resolveManualReflection(defaultConfig(), {}).manual_relief_factor,
    MANUAL_RELIEF_FACTOR,
  );
  assert.equal(
    resolveManualReflection(configured, {}).manual_relief_factor,
    MANUAL_RELIEF_FACTOR,
  );
});

test("the reward factor is not a knob any preset defines", () => {
  for (const [name, knobs] of Object.entries(PRESETS)) {
    assert.equal(
      Object.hasOwn(knobs, "manual_relief_factor"),
      false,
      `expected the ${name} preset to leave the reward factor to the module`,
    );
  }
});

test("resolved manual settings are a fresh object the caller cannot leak back", () => {
  const config = defaultConfig();
  const first = resolveManualReflection(config, {});
  first.threshold = 1234;

  const second = resolveManualReflection(config, {});

  assert.equal(second.threshold, resolveKnobs(config, {}).threshold);
  assert.equal(second.threshold !== 1234, true);
});
