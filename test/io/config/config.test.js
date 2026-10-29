import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  CATEGORIES,
  PAUSE_MODES,
  PRESETS,
  SUBCATEGORIES,
  allowedSubcategories,
  defaultConfig,
  effectivePreset,
  loadConfig,
  mergeGuidedChoices,
  normalizeConfig,
  resolveCategory,
  resolveKnobs,
} from "../../../src/io/config/config.js";
import { makeTempDir } from "../../helpers/temp-dir.js";

/** Write a project configuration document, as a user or an earlier setup run would. */
function writeConfig(projectDir, document) {
  const configPath = path.join(projectDir, ".stoic", "config.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, document, "utf8");
  return configPath;
}

// --- Defaults -------------------------------------------------------------

test("the built-in configuration is complete and usable without setup", () => {
  const config = defaultConfig();

  assert.equal(config.enabled, true);
  assert.equal(config.preset, "balanced");
  assert.deepEqual(config.categories, [...CATEGORIES]);
  assert.equal(config.pause_mode, "hybrid");
  assert.equal(config.followup_draft, true);
  assert.ok(config.critical_paths.length > 0);
  assert.ok(config.classifier_model.length > 0);
  assert.deepEqual(config.advanced, {});
});

test("each built-in configuration is independent of the last", () => {
  const first = defaultConfig();
  first.categories.push("invented");
  first.subcategories.security.length = 0;
  first.advanced.threshold = 99;

  const second = defaultConfig();

  assert.deepEqual(second.categories, [...CATEGORIES]);
  assert.deepEqual(second.subcategories.security, [...SUBCATEGORIES.security]);
  assert.deepEqual(second.advanced, {});
});

test("only the approved presets and pause modes exist", () => {
  assert.deepEqual(Object.keys(PRESETS), ["calm", "balanced", "vigilant"]);
  assert.deepEqual([...PAUSE_MODES], ["hybrid", "choices", "freeform"]);
});

test("presets order sensitivity as their names promise", () => {
  assert.ok(PRESETS.calm.threshold > PRESETS.balanced.threshold);
  assert.ok(PRESETS.vigilant.threshold < PRESETS.balanced.threshold);
  assert.ok(PRESETS.calm.half_life_hours < PRESETS.balanced.half_life_hours);
  assert.ok(
    PRESETS.vigilant.half_life_hours > PRESETS.balanced.half_life_hours,
  );
});

test("every preset knob is a valid, finite number", () => {
  for (const [name, knobs] of Object.entries(PRESETS)) {
    for (const [knob, value] of Object.entries(knobs)) {
      assert.ok(Number.isFinite(value), `${name}.${knob} must be finite`);
      assert.ok(value >= 0, `${name}.${knob} must not be negative`);
    }
    assert.ok(knobs.threshold > 0, `${name}.threshold must be positive`);
    assert.ok(
      knobs.half_life_hours > 0,
      `${name}.half_life_hours must be positive`,
    );
    assert.ok(
      knobs.delegated_discount <= 1,
      `${name}.delegated_discount must be a fraction`,
    );
  }
});

// --- Reading a project configuration --------------------------------------

test("a project without configuration resolves to the built-in defaults", (t) => {
  const projectDir = makeTempDir(t, "stoic-config-");

  assert.deepEqual(loadConfig(projectDir), defaultConfig());
});

test("reading a missing configuration creates no project file", (t) => {
  const projectDir = makeTempDir(t, "stoic-config-");

  loadConfig(projectDir);

  assert.deepEqual(fs.readdirSync(projectDir), []);
});

test("a corrupt configuration resolves to defaults instead of throwing", (t) => {
  const projectDir = makeTempDir(t, "stoic-config-");
  writeConfig(projectDir, "{ this is not json");

  assert.deepEqual(loadConfig(projectDir), defaultConfig());
});

test("a configuration that is not an object resolves to defaults", (t) => {
  const projectDir = makeTempDir(t, "stoic-config-");
  writeConfig(projectDir, '"balanced"');

  assert.deepEqual(loadConfig(projectDir), defaultConfig());
});

test("a valid configuration reaches the resolved model", (t) => {
  const projectDir = makeTempDir(t, "stoic-config-");
  writeConfig(
    projectDir,
    JSON.stringify({
      preset: "vigilant",
      pause_mode: "freeform",
      max_questions: 1,
    }),
  );

  const config = loadConfig(projectDir);

  assert.equal(config.preset, "vigilant");
  assert.equal(config.pause_mode, "freeform");
  assert.equal(config.max_questions, 1);
});

// --- Validation -----------------------------------------------------------

test("an invalid field falls back without discarding its valid neighbors", () => {
  const config = normalizeConfig({
    preset: "paranoid",
    pause_mode: "telepathy",
    max_questions: 9,
    classifier_confidence_threshold: 7,
    classifier_model: "",
    enabled: "yes",
    followup_draft: null,
  });

  const defaults = defaultConfig();
  assert.equal(config.preset, defaults.preset);
  assert.equal(config.pause_mode, defaults.pause_mode);
  assert.equal(config.max_questions, defaults.max_questions);
  assert.equal(
    config.classifier_confidence_threshold,
    defaults.classifier_confidence_threshold,
  );
  assert.equal(config.classifier_model, defaults.classifier_model);
  assert.equal(config.enabled, defaults.enabled);
  assert.equal(config.followup_draft, defaults.followup_draft);
});

test("max questions accepts only whole numbers from one to three", () => {
  const fallback = defaultConfig().max_questions;

  assert.equal(normalizeConfig({ max_questions: 1 }).max_questions, 1);
  assert.equal(normalizeConfig({ max_questions: 3 }).max_questions, 3);
  assert.equal(normalizeConfig({ max_questions: 0 }).max_questions, fallback);
  assert.equal(normalizeConfig({ max_questions: 4 }).max_questions, fallback);
  assert.equal(normalizeConfig({ max_questions: 2.5 }).max_questions, fallback);
});

test("confidence accepts only values from zero to one", () => {
  const fallback = defaultConfig().classifier_confidence_threshold;

  assert.equal(
    normalizeConfig({ classifier_confidence_threshold: 0 })
      .classifier_confidence_threshold,
    0,
  );
  assert.equal(
    normalizeConfig({ classifier_confidence_threshold: 1 })
      .classifier_confidence_threshold,
    1,
  );
  assert.equal(
    normalizeConfig({ classifier_confidence_threshold: -0.1 })
      .classifier_confidence_threshold,
    fallback,
  );
  assert.equal(
    normalizeConfig({ classifier_confidence_threshold: 1.1 })
      .classifier_confidence_threshold,
    fallback,
  );
});

test("critical paths keep only non-empty strings", () => {
  const config = normalizeConfig({
    critical_paths: ["auth", "", 42, null, "billing"],
  });

  assert.deepEqual(config.critical_paths, ["auth", "billing"]);
});

test("unknown fields never reach the resolved model", () => {
  const config = normalizeConfig({ telemetry_endpoint: "https://example.com" });

  assert.ok(!("telemetry_endpoint" in config));
});

test("an invalid advanced knob is dropped rather than clamped", () => {
  const config = normalizeConfig({
    advanced: {
      threshold: 0,
      half_life_hours: -1,
      weight_edits: -2,
      delegated_discount: 1.5,
      mute_window_ms: Number.POSITIVE_INFINITY,
      category_mute_ms: Number.NaN,
      invented_knob: 5,
    },
  });

  assert.deepEqual(config.advanced, {});
});

test("a valid advanced knob survives normalization", () => {
  const config = normalizeConfig({
    advanced: { threshold: 42, delegated_discount: 0, weight_edits: 0 },
  });

  assert.deepEqual(config.advanced, {
    threshold: 42,
    weight_edits: 0,
    delegated_discount: 0,
  });
});

// --- Taxonomy: resolution and pruning -------------------------------------

test("an unknown category is dropped from the resolved model", () => {
  const config = normalizeConfig({ categories: ["security", "astrology", 7] });

  assert.deepEqual(config.categories, ["security"]);
});

test("a repeated category is listed once", () => {
  const config = normalizeConfig({ categories: ["security", "security"] });

  assert.deepEqual(config.categories, ["security"]);
});

test("selecting no categories is preserved, not treated as unset", () => {
  const config = normalizeConfig({ categories: [] });

  assert.deepEqual(config.categories, []);
  assert.deepEqual(allowedSubcategories(config), []);
});

test("manual subcategory pruning is preserved", () => {
  const config = normalizeConfig({
    subcategories: { security: ["authentication"] },
  });

  assert.deepEqual(config.subcategories.security, ["authentication"]);
});

test("an area absent from the subcategory map keeps its built-in vocabulary", () => {
  const config = normalizeConfig({
    subcategories: { security: ["authentication"] },
  });

  assert.deepEqual(config.subcategories.architecture, [
    ...SUBCATEGORIES.architecture,
  ]);
});

test("an emptied subcategory list prunes the whole area's vocabulary", () => {
  const config = normalizeConfig({ subcategories: { security: [] } });

  assert.deepEqual(config.subcategories.security, []);
  assert.equal(resolveCategory("authentication", config), null);
});

test("a user-added subcategory is kept as valid vocabulary", () => {
  const config = normalizeConfig({
    subcategories: { security: ["threat_model"] },
  });

  assert.deepEqual(resolveCategory("threat_model", config), {
    category: "security",
    subcategory: "threat_model",
  });
});

test("a malformed subcategory entry is dropped", () => {
  const config = normalizeConfig({
    subcategories: {
      security: ["authentication", "", null, 5, "authentication"],
    },
  });

  assert.deepEqual(config.subcategories.security, ["authentication"]);
});

test("a subcategory resolves to its enabled top-level area", () => {
  assert.deepEqual(resolveCategory("database_schema", defaultConfig()), {
    category: "data_domain",
    subcategory: "database_schema",
  });
});

test("a top-level area resolves to itself", () => {
  assert.deepEqual(resolveCategory("security", defaultConfig()), {
    category: "security",
    subcategory: null,
  });
});

test("a name under a disabled area does not resolve", () => {
  const config = normalizeConfig({ categories: ["security"] });

  assert.equal(resolveCategory("database_schema", config), null);
  assert.equal(resolveCategory("data_domain", config), null);
});

test("an unknown or malformed name does not resolve", () => {
  const config = defaultConfig();

  assert.equal(resolveCategory("astrology", config), null);
  assert.equal(resolveCategory("", config), null);
  assert.equal(resolveCategory(null, config), null);
});

test("the classifier vocabulary spans exactly the enabled areas", () => {
  const config = normalizeConfig({ categories: ["security"] });

  assert.deepEqual(allowedSubcategories(config), [...SUBCATEGORIES.security]);
});

// --- Migration input ------------------------------------------------------

test("a persisted sandbox preset name is normalized to the canonical one", () => {
  assert.equal(normalizeConfig({ preset: "conservative" }).preset, "calm");
});

test("persisted sandbox pause modes are normalized to the canonical ones", () => {
  assert.equal(
    normalizeConfig({ pause_mode: "choice_only" }).pause_mode,
    "choices",
  );
  assert.equal(
    normalizeConfig({ pause_mode: "write_only" }).pause_mode,
    "freeform",
  );
});

test("persisted flat sandbox categories are normalized onto their areas", () => {
  const config = normalizeConfig({
    categories: [
      "data_model",
      "api_contract",
      "security_auth",
      "new_dependency",
      "architecture_pattern",
    ],
  });

  assert.deepEqual(config.categories, [
    "data_domain",
    "api_integration",
    "security",
    "architecture",
  ]);
});

test("persisted sandbox knob names are normalized to canonical knobs", () => {
  const config = normalizeConfig({
    advanced: {
      THRESHOLD: 12,
      HALF_LIFE_HOURS: 5,
      w_edits: 1,
      w_diff: 2,
      w_effort: 3,
      r_quest: 4,
      MUTE_WINDOW_MS: 1000,
      CATEGORY_MUTE_MS: 2000,
    },
  });

  assert.deepEqual(config.advanced, {
    threshold: 12,
    half_life_hours: 5,
    weight_edits: 1,
    weight_diff: 2,
    weight_effort: 3,
    question_relief: 4,
    mute_window_ms: 1000,
    category_mute_ms: 2000,
  });
});

test("a canonical knob wins over its sandbox name", () => {
  const config = normalizeConfig({
    advanced: { threshold: 12, THRESHOLD: 99 },
  });

  assert.equal(config.advanced.threshold, 12);
});

test("a sandbox name is rejected as a guided setup choice", () => {
  assert.throws(
    () => mergeGuidedChoices(defaultConfig(), { preset: "conservative" }),
    /preset/,
  );
  assert.throws(
    () => mergeGuidedChoices(defaultConfig(), { pause_mode: "choice_only" }),
    /pause_mode/,
  );
  assert.throws(
    () => mergeGuidedChoices(defaultConfig(), { categories: ["data_model"] }),
    /categories/,
  );
});

// --- Effective sensitivity ------------------------------------------------

test("a personal preset override wins over the committed team preset", () => {
  const config = normalizeConfig({ preset: "calm" });

  assert.equal(effectivePreset(config, { preset: "vigilant" }), "vigilant");
  assert.deepEqual(resolveKnobs(config, { preset: "vigilant" }), {
    ...PRESETS.vigilant,
  });
});

test("without a personal override the committed team preset applies", () => {
  const config = normalizeConfig({ preset: "calm" });

  assert.equal(effectivePreset(config, {}), "calm");
  assert.equal(effectivePreset(config, undefined), "calm");
});

test("an invalid personal override falls back to the team preset", () => {
  const config = normalizeConfig({ preset: "calm" });

  assert.equal(effectivePreset(config, { preset: "paranoid" }), "calm");
});

test("a persisted sandbox personal override is normalized, not ignored", () => {
  const config = normalizeConfig({ preset: "vigilant" });

  assert.equal(effectivePreset(config, { preset: "conservative" }), "calm");
});

test("with neither override nor team preset the built-in default applies", () => {
  assert.equal(effectivePreset(undefined, undefined), "balanced");
  assert.equal(effectivePreset({}, {}), "balanced");
  assert.deepEqual(resolveKnobs(defaultConfig(), {}), { ...PRESETS.balanced });
});

test("an advanced override wins over the effective preset, knob by knob", () => {
  const config = normalizeConfig({
    preset: "calm",
    advanced: { threshold: 42 },
  });

  const knobs = resolveKnobs(config, { preset: "vigilant" });

  assert.equal(knobs.threshold, 42);
  assert.equal(knobs.half_life_hours, PRESETS.vigilant.half_life_hours);
});

test("an invalid advanced override cannot displace the preset value", () => {
  const config = normalizeConfig({
    preset: "calm",
    advanced: { threshold: -5 },
  });

  assert.equal(resolveKnobs(config).threshold, PRESETS.calm.threshold);
});

test("resolved knobs are a complete, independent set", () => {
  const knobs = resolveKnobs(defaultConfig());
  knobs.threshold = 1234;

  assert.deepEqual(
    Object.keys(knobs).sort(),
    Object.keys(PRESETS.balanced).sort(),
  );
  assert.equal(PRESETS.balanced.threshold !== 1234, true);
});

// --- Cooldown -------------------------------------------------------------

test("every preset defines a cooldown ratio, and it resolves as a knob", () => {
  for (const [name, knobs] of Object.entries(PRESETS)) {
    assert.ok(
      Number.isFinite(knobs.cooldown_ratio),
      `${name}.cooldown_ratio must be finite`,
    );
    assert.ok(
      knobs.cooldown_ratio >= 0 && knobs.cooldown_ratio < 1,
      `${name}.cooldown_ratio must be a fraction below one`,
    );
  }

  assert.equal(
    resolveKnobs(defaultConfig(), {}).cooldown_ratio,
    PRESETS.balanced.cooldown_ratio,
  );
});

test("an advanced override moves the cooldown ratio", () => {
  const config = normalizeConfig({ advanced: { cooldown_ratio: 0.25 } });

  assert.equal(config.advanced.cooldown_ratio, 0.25);
  assert.equal(resolveKnobs(config, {}).cooldown_ratio, 0.25);
});

test("the cooldown ratio accepts zero but not one", () => {
  // Zero is a full reset — aggressive, but it still relieves pressure. One is
  // a no-op cap: a just-over-threshold fire would re-fire on the very next
  // turn, defeating the binding no-refire property the cooldown exists to
  // provide (architecture/configuration.md §Score relief), so it is invalid
  // shape, not a
  // calibration choice.
  assert.equal(
    resolveKnobs(normalizeConfig({ advanced: { cooldown_ratio: 0 } }), {})
      .cooldown_ratio,
    0,
  );
  assert.equal(
    resolveKnobs(normalizeConfig({ advanced: { cooldown_ratio: 1 } }), {})
      .cooldown_ratio,
    PRESETS.balanced.cooldown_ratio,
  );
});

test("an invalid cooldown ratio falls back to the preset value", () => {
  for (const invalid of [-0.1, 1, 1.5, "0.5", null, Number.NaN, Infinity]) {
    const config = normalizeConfig({
      preset: "calm",
      advanced: { cooldown_ratio: invalid },
    });

    assert.deepEqual(config.advanced, {}, `${String(invalid)} must be dropped`);
    assert.equal(
      resolveKnobs(config, {}).cooldown_ratio,
      PRESETS.calm.cooldown_ratio,
    );
  }
});

test("the cooldown ratio has no sandbox alias", () => {
  const config = normalizeConfig({
    advanced: { COOLDOWN_RATIO: 0.9, cooldown: 0.9, r_cool: 0.9 },
  });

  assert.deepEqual(config.advanced, {});
  assert.equal(
    resolveKnobs(config, {}).cooldown_ratio,
    PRESETS.balanced.cooldown_ratio,
  );
});

// --- Guided setup merge ---------------------------------------------------

test("a guided answer changes only its own field", () => {
  const before = normalizeConfig({ preset: "calm", pause_mode: "freeform" });

  const after = mergeGuidedChoices(before, { preset: "vigilant" });

  assert.equal(after.preset, "vigilant");
  assert.equal(after.pause_mode, "freeform");
});

test("merging guided answers never mutates the configuration it was given", () => {
  const before = normalizeConfig({ preset: "calm" });
  const snapshot = structuredClone(before);

  mergeGuidedChoices(before, {
    preset: "vigilant",
    categories: ["security"],
    pause_mode: "choices",
    followup_draft: false,
  });

  assert.deepEqual(before, snapshot);
});

test("hand-tuned settings survive a guided re-run", () => {
  const before = normalizeConfig({
    subcategories: { security: ["authentication"] },
    critical_paths: ["billing"],
    classifier_confidence_threshold: 0.9,
    classifier_model: "claude-custom-model",
    max_questions: 1,
    advanced: { threshold: 42 },
  });

  const after = mergeGuidedChoices(before, {
    preset: "vigilant",
    categories: [...CATEGORIES],
    pause_mode: "choices",
    followup_draft: false,
  });

  assert.deepEqual(after.subcategories.security, ["authentication"]);
  assert.deepEqual(after.critical_paths, ["billing"]);
  assert.equal(after.classifier_confidence_threshold, 0.9);
  assert.equal(after.classifier_model, "claude-custom-model");
  assert.equal(after.max_questions, 1);
  assert.deepEqual(after.advanced, { threshold: 42 });
});

test("choosing no decision areas disables the plugin", () => {
  const after = mergeGuidedChoices(defaultConfig(), { categories: [] });

  assert.deepEqual(after.categories, []);
  assert.equal(after.enabled, false);
});

test("choosing a decision area enables the plugin again", () => {
  const disabled = mergeGuidedChoices(defaultConfig(), { categories: [] });

  const after = mergeGuidedChoices(disabled, { categories: ["security"] });

  assert.deepEqual(after.categories, ["security"]);
  assert.equal(after.enabled, true);
});

test("a guided re-run with the same answers changes nothing", () => {
  const choices = {
    preset: "vigilant",
    categories: ["security", "architecture"],
    pause_mode: "choices",
    followup_draft: false,
  };

  const once = mergeGuidedChoices(defaultConfig(), choices);
  const twice = mergeGuidedChoices(once, choices);

  assert.deepEqual(twice, once);
});

test("guided setup repairs an unusable configuration into a canonical one", () => {
  const after = mergeGuidedChoices("not a config", { preset: "calm" });

  assert.deepEqual(after, { ...defaultConfig(), preset: "calm" });
});

test("an unsupported guided choice is rejected", () => {
  const before = defaultConfig();

  assert.throws(
    () => mergeGuidedChoices(before, { preset: "paranoid" }),
    /preset/,
  );
  assert.throws(
    () => mergeGuidedChoices(before, { pause_mode: "telepathy" }),
    /pause_mode/,
  );
  assert.throws(
    () => mergeGuidedChoices(before, { followup_draft: "yes" }),
    /followup_draft/,
  );
  assert.throws(
    () => mergeGuidedChoices(before, { categories: "security" }),
    /categories/,
  );
  assert.throws(
    () => mergeGuidedChoices(before, { categories: ["astrology"] }),
    /categories/,
  );
});

test("a guided choice outside the four questions is rejected", () => {
  assert.throws(
    () => mergeGuidedChoices(defaultConfig(), { advanced: { threshold: 1 } }),
    /advanced/,
  );
  assert.throws(
    () => mergeGuidedChoices(defaultConfig(), { enabled: false }),
    /enabled/,
  );
  assert.throws(() => mergeGuidedChoices(defaultConfig(), null), /choices/);
});

test("a rejected guided choice reports what was expected", () => {
  assert.throws(
    () => mergeGuidedChoices(defaultConfig(), { preset: "paranoid" }),
    {
      message:
        'Invalid setup choice for "preset": expected one of calm, balanced, vigilant.',
    },
  );
});

test("a repeated decision area is listed once", () => {
  const after = mergeGuidedChoices(defaultConfig(), {
    categories: ["security", "security"],
  });

  assert.deepEqual(after.categories, ["security"]);
});
