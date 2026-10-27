// Task 05 — safe reconfiguration and migration.
//
// Where setup.test.js proves the FRESH-project contract, this suite proves what
// happens on the SECOND run and beyond: reconfiguring a project that already
// holds a team config and accumulated personal history. Every test drives the
// real setup.js as a child process (the shared harness in
// ../helpers/setup-cli.js) and asserts only observable effects — stdout, exit
// status, and the documents on disk.
//
// The behaviors verified here already live in the config model and the CLI
// write ordering (tasks 02–04); these tests are the regression lock that keeps
// a reconfiguration from ever losing a hand-tuned setting or a developer's
// personal state, and that keeps persisted sandbox vocabulary from surviving a
// rewrite.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import {
  PRESET_NAMES,
  defaultConfig,
  normalizeConfig,
} from "../../src/io/config/config.js";
import { personalStateDir, projectStoicDir } from "../../src/io/paths.js";
import { createSandbox } from "../helpers/sandbox.js";
import {
  applyArgs,
  configExists,
  readConfig,
  readConfigText,
  readState,
  readStateText,
  runSetup,
  stateExists,
  writeConfigDocument,
  writeStateDocument,
} from "../helpers/setup-cli.js";

/**
 * A configuration whose non-guided fields have all been hand-tuned away from
 * their defaults — the settings a reconfiguration must never disturb. Planted
 * directly on disk, then reconfigured through the CLI.
 */
const HAND_TUNED = Object.freeze({
  enabled: true,
  preset: "calm",
  categories: ["security"],
  subcategories: { security: ["authentication"] },
  pause_mode: "freeform",
  followup_draft: false,
  critical_paths: ["billing", "payments"],
  classifier_confidence_threshold: 0.9,
  classifier_model: "claude-custom-model",
  max_questions: 1,
  advanced: { threshold: 42, delegated_discount: 0.25 },
});

/** A complete, valid personal state carrying real accumulated history. */
const ACCUMULATED_STATE = Object.freeze({
  score: 7.5,
  last_update: 1_700_000_000_000,
  mutes: [
    {
      category: "security",
      files: ["src/auth.js"],
      expires_at: 1_800_000_000_000,
    },
  ],
  skip_streak: { security: 2 },
  skip_totals: { security: 5, architecture: 1 },
  preset: "vigilant", // a personal override the developer chose
});

// ---------------------------------------------------------------------------
// A rerun changes exactly the guided fields, and nothing else
// ---------------------------------------------------------------------------

test("a rerun changes exactly the guided fields, preserving the rest verbatim", (t) => {
  const sandbox = createSandbox(t);
  writeConfigDocument(sandbox, HAND_TUNED);

  const { status, result } = runSetup(
    sandbox,
    applyArgs({
      preset: "vigilant",
      categories: "data_domain,architecture",
      "pause-mode": "hybrid",
      "followup-draft": "true",
    }),
  );

  assert.equal(status, 0);
  assert.deepEqual(result.choices, {
    preset: "vigilant",
    categories: ["data_domain", "architecture"],
    pause_mode: "hybrid",
    followup_draft: true,
  });

  // The whole document equals the hand-tuned one with ONLY the five guided
  // fields (preset, categories, pause_mode, followup_draft, and the derived
  // enabled) moved to their new values.
  assert.deepEqual(readConfig(sandbox), {
    ...normalizeConfig(HAND_TUNED),
    enabled: true,
    preset: "vigilant",
    categories: ["data_domain", "architecture"],
    pause_mode: "hybrid",
    followup_draft: true,
  });
});

test("a rerun preserves every hand-tuned non-guided field", (t) => {
  const sandbox = createSandbox(t);
  writeConfigDocument(sandbox, HAND_TUNED);

  runSetup(sandbox, applyArgs({ preset: "vigilant" }));

  const after = readConfig(sandbox);
  assert.deepEqual(after.subcategories.security, ["authentication"]);
  assert.deepEqual(after.critical_paths, ["billing", "payments"]);
  assert.equal(after.classifier_confidence_threshold, 0.9);
  assert.equal(after.classifier_model, "claude-custom-model");
  assert.equal(after.max_questions, 1);
  assert.deepEqual(after.advanced, { threshold: 42, delegated_discount: 0.25 });
});

test("disabling then re-enabling leaves the manual layer intact", (t) => {
  const sandbox = createSandbox(t);
  writeConfigDocument(sandbox, HAND_TUNED);

  // Mute everything, then turn it back on — the round trip must not scrub the
  // hand-tuned fields.
  runSetup(sandbox, applyArgs({ categories: "" }));
  assert.equal(readConfig(sandbox).enabled, false);

  runSetup(sandbox, applyArgs({ categories: "security" }));
  const after = readConfig(sandbox);
  assert.equal(after.enabled, true);
  assert.deepEqual(after.critical_paths, ["billing", "payments"]);
  assert.deepEqual(after.advanced, { threshold: 42, delegated_discount: 0.25 });
  assert.equal(after.classifier_model, "claude-custom-model");
});

// ---------------------------------------------------------------------------
// A rerun preserves all valid personal state
// ---------------------------------------------------------------------------

test("a rerun preserves accumulated personal state byte-for-byte", (t) => {
  const sandbox = createSandbox(t);
  runSetup(sandbox, applyArgs()); // materialize config + fresh state
  writeStateDocument(sandbox, ACCUMULATED_STATE);
  const stateBefore = readStateText(sandbox);

  const { result } = runSetup(sandbox, applyArgs({ preset: "calm" }));

  assert.equal(result.state, "preserved");
  assert.equal(readStateText(sandbox), stateBefore);
});

test("a rerun keeps the personal preset override separate from the team preset", (t) => {
  const sandbox = createSandbox(t);
  runSetup(sandbox, applyArgs({ preset: "balanced" }));
  writeStateDocument(sandbox, ACCUMULATED_STATE);

  // Setup writes the TEAM preset; the developer's private override must survive
  // untouched, so the two layers stay independent.
  runSetup(sandbox, applyArgs({ preset: "calm" }));

  assert.equal(readConfig(sandbox).preset, "calm");
  const state = readState(sandbox);
  assert.equal(state.preset, "vigilant");
  assert.equal(state.score, 7.5);
  assert.equal(state.last_update, 1_700_000_000_000);
  assert.deepEqual(state.mutes, [...ACCUMULATED_STATE.mutes]);
  assert.deepEqual(state.skip_streak, { security: 2 });
  assert.deepEqual(state.skip_totals, { security: 5, architecture: 1 });
});

// ---------------------------------------------------------------------------
// An identical rerun is idempotent in both documents
// ---------------------------------------------------------------------------

test("an identical rerun changes neither config nor state", (t) => {
  const sandbox = createSandbox(t);
  const args = applyArgs({
    preset: "vigilant",
    categories: "security,architecture",
    "pause-mode": "choices",
    "followup-draft": "false",
  });
  runSetup(sandbox, args);
  writeStateDocument(sandbox, ACCUMULATED_STATE);

  const configBefore = readConfigText(sandbox);
  const stateBefore = readStateText(sandbox);
  const { status, result } = runSetup(sandbox, args);

  assert.equal(status, 0);
  assert.equal(result.state, "preserved");
  assert.equal(result.config, "written");
  assert.equal(readConfigText(sandbox), configBefore);
  assert.equal(readStateText(sandbox), stateBefore);
});

// ---------------------------------------------------------------------------
// Recovery from missing or corrupt project configuration
// ---------------------------------------------------------------------------

test("a rerun rebuilds a complete config from one that is not an object", (t) => {
  const sandbox = createSandbox(t);
  writeConfigDocument(sandbox, "[1, 2, 3]");

  const { status, result } = runSetup(sandbox, applyArgs({ preset: "calm" }));

  assert.equal(status, 0);
  assert.equal(result.ok, true);
  const after = readConfig(sandbox);
  assert.deepEqual(
    Object.keys(after).sort(),
    Object.keys(defaultConfig()).sort(),
  );
  assert.deepEqual(after, {
    ...defaultConfig(),
    preset: "calm",
    categories: ["data_domain", "security"],
  });
});

test("a rerun keeps the recognized valid values of a partially corrupt config", (t) => {
  const sandbox = createSandbox(t);
  // A valid object mixing good non-guided values with meaningless ones.
  writeConfigDocument(sandbox, {
    preset: "bogus",
    pause_mode: "nonsense",
    critical_paths: ["billing"],
    classifier_model: "claude-custom",
    max_questions: 99,
    classifier_confidence_threshold: 5,
    advanced: { threshold: 7, invented_knob: 3 },
  });

  const { status } = runSetup(sandbox, applyArgs({ preset: "vigilant" }));

  assert.equal(status, 0);
  const after = readConfig(sandbox);
  // Recognized valid non-guided values survived...
  assert.deepEqual(after.critical_paths, ["billing"]);
  assert.equal(after.classifier_model, "claude-custom");
  assert.deepEqual(after.advanced, { threshold: 7 });
  // ...meaningless values fell back to canonical defaults...
  assert.equal(after.max_questions, defaultConfig().max_questions);
  assert.equal(
    after.classifier_confidence_threshold,
    defaultConfig().classifier_confidence_threshold,
  );
  // ...and the guided answer was applied, over a complete document.
  assert.equal(after.preset, "vigilant");
  assert.deepEqual(
    Object.keys(after).sort(),
    Object.keys(defaultConfig()).sort(),
  );
});

// ---------------------------------------------------------------------------
// Legacy sandbox vocabulary is normalized when a document is rewritten
// ---------------------------------------------------------------------------

// Sandbox aliases with NO canonical spelling — none of these may survive a
// rewrite. (The five flat v01 category names are deliberately absent: they are
// legitimate canonical subcategory names in the current taxonomy, so they DO
// appear in a rewritten document and are not migration residue.)
const RETIRED_SANDBOX_TOKENS = Object.freeze([
  "conservative",
  "choice_only",
  "write_only",
  "THRESHOLD",
  "HALF_LIFE_HOURS",
  "w_edits",
  "w_diff",
  "w_effort",
  "r_quest",
  "MUTE_WINDOW_MS",
  "CATEGORY_MUTE_MS",
]);

test("a rerun rewrites persisted sandbox knob aliases to canonical names", (t) => {
  const sandbox = createSandbox(t);
  writeConfigDocument(sandbox, {
    preset: "conservative",
    pause_mode: "write_only",
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
    // Not part of the documented config — must not be carried across.
    debug_trace: { last_run: 123 },
    telemetry_endpoint: "https://example.com",
  });

  runSetup(sandbox, applyArgs());

  const after = readConfig(sandbox);
  // The advanced escape hatch is preserved (non-guided) AND migrated.
  assert.deepEqual(after.advanced, {
    threshold: 12,
    half_life_hours: 5,
    weight_edits: 1,
    weight_diff: 2,
    weight_effort: 3,
    question_relief: 4,
    mute_window_ms: 1000,
    category_mute_ms: 2000,
  });
  // Undocumented artifacts were dropped, not migrated.
  assert.ok(!("debug_trace" in after));
  assert.ok(!("telemetry_endpoint" in after));
  // No retired sandbox vocabulary survives anywhere in the rewritten bytes.
  const raw = readConfigText(sandbox);
  for (const token of RETIRED_SANDBOX_TOKENS) {
    assert.ok(
      !raw.includes(token),
      `rewritten config still contains retired sandbox token "${token}"`,
    );
  }
});

test("--current surfaces canonical values from a persisted sandbox document", (t) => {
  const sandbox = createSandbox(t);
  writeConfigDocument(sandbox, {
    preset: "conservative",
    pause_mode: "write_only",
    categories: [
      "data_model",
      "api_contract",
      "security_auth",
      "new_dependency",
      "architecture_pattern",
    ],
  });

  const { status, result } = runSetup(sandbox, ["--current"]);

  assert.equal(status, 0);
  assert.equal(result.choices.preset, "calm");
  assert.equal(result.choices.pause_mode, "freeform");
  assert.deepEqual(result.choices.categories, [
    "data_domain",
    "api_integration",
    "security",
    "architecture",
  ]);
});

// ---------------------------------------------------------------------------
// Effective-preset precedence, as the setup seam exposes it
//
// setup.js reports the TEAM preset and deliberately ignores the personal
// override, so a rerun can never publish a private choice to the team. These
// tests exercise that team-layer resolution end-to-end; the full
// personal-wins precedence lives in effectivePreset() and is exhausted as a
// pure function in test/io/config.test.js.
// ---------------------------------------------------------------------------

for (const preset of PRESET_NAMES) {
  test(`--current surfaces the persisted team preset ${preset}`, (t) => {
    const sandbox = createSandbox(t);
    writeConfigDocument(sandbox, { preset });

    const { status, result } = runSetup(sandbox, ["--current"]);

    assert.equal(status, 0);
    assert.equal(result.choices.preset, preset);
  });
}

test("--current falls back to balanced when no config exists", (t) => {
  const sandbox = createSandbox(t);

  const { result } = runSetup(sandbox, ["--current"]);

  assert.equal(result.choices.preset, "balanced");
});

for (const [label, document] of [
  ["corrupt", "{ not json at all"],
  ["not an object", "[1, 2, 3]"],
]) {
  test(`--current falls back to balanced when the config is ${label}`, (t) => {
    const sandbox = createSandbox(t);
    writeConfigDocument(sandbox, document);

    const { result } = runSetup(sandbox, ["--current"]);

    assert.equal(result.choices.preset, "balanced");
  });
}

for (const override of ["vigilant", "conservative", "paranoid", "balanced"]) {
  test(`--current reports the team preset, ignoring a personal override (${override})`, (t) => {
    const sandbox = createSandbox(t);
    writeConfigDocument(sandbox, { preset: "calm" }); // team choice
    writeStateDocument(sandbox, { ...ACCUMULATED_STATE, preset: override });

    const { result } = runSetup(sandbox, ["--current"]);

    // Whatever the private override is — a valid preset, a sandbox alias, or an
    // invalid value — setup shows the committed team preset, never the override.
    assert.equal(result.choices.preset, "calm");
  });
}

// ---------------------------------------------------------------------------
// A rejected reconfiguration leaves an already-configured project untouched
// ---------------------------------------------------------------------------

for (const [label, invalid] of [
  ["an unsupported preset", { preset: "reckless" }],
  ["an unsupported decision area", { categories: "security,telepathy" }],
  ["a sandbox alias as guided input", { preset: "conservative" }],
]) {
  test(`${label} is rejected and leaves existing config and state byte-for-byte unchanged`, (t) => {
    const sandbox = createSandbox(t);
    runSetup(sandbox, applyArgs({ preset: "balanced" }));
    writeStateDocument(sandbox, ACCUMULATED_STATE);
    const configBefore = readConfigText(sandbox);
    const stateBefore = readStateText(sandbox);

    const { status, result } = runSetup(sandbox, applyArgs(invalid));

    assert.equal(status, 2);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "invalid_choice");
    assert.equal(result.state, "unchanged");
    assert.equal(result.config, "unchanged");
    assert.equal(readConfigText(sandbox), configBefore);
    assert.equal(readStateText(sandbox), stateBefore);
  });
}

test("an incomplete rerun leaves existing config and state byte-for-byte unchanged", (t) => {
  const sandbox = createSandbox(t);
  runSetup(sandbox, applyArgs());
  writeStateDocument(sandbox, ACCUMULATED_STATE);
  const configBefore = readConfigText(sandbox);
  const stateBefore = readStateText(sandbox);

  // A patch-shaped request (only one field) is not a valid apply.
  const { status, result } = runSetup(sandbox, ["--apply", "--preset", "calm"]);

  assert.equal(status, 2);
  assert.equal(result.error.code, "invalid_choice");
  assert.equal(readConfigText(sandbox), configBefore);
  assert.equal(readStateText(sandbox), stateBefore);
});

// ---------------------------------------------------------------------------
// A successful write is complete and hides its own mechanism
// ---------------------------------------------------------------------------

test("a successful apply leaves one complete, parseable config and no temp files", (t) => {
  const sandbox = createSandbox(t);

  runSetup(sandbox, applyArgs());

  // Parseable (readConfig would throw otherwise) and complete — every field a
  // runtime consumer expects is present, no more and no less.
  const after = readConfig(sandbox);
  assert.deepEqual(
    Object.keys(after).sort(),
    Object.keys(defaultConfig()).sort(),
  );

  // The atomic tmp+rename write leaves no debris: each directory holds exactly
  // its own documents, so a temp filename is never a lingering artifact.
  assert.deepEqual(fs.readdirSync(projectStoicDir(sandbox.projectDir)).sort(), [
    ".gitignore",
    "config.json",
  ]);
  assert.deepEqual(
    fs.readdirSync(personalStateDir(sandbox.projectDir, sandbox.homeDir)),
    ["state.json"],
  );
});

test("the result reports outcomes without exposing the write algorithm", (t) => {
  const sandbox = createSandbox(t);

  const { result } = runSetup(sandbox, applyArgs());

  // The public result is exactly the documented keys — no temp filename, pid,
  // or rename detail leaks into the contract callers depend on.
  assert.deepEqual(Object.keys(result).sort(), [
    "choices",
    "config",
    "enabled",
    "ok",
    "operation",
    "state",
  ]);
  const json = JSON.stringify(result);
  assert.ok(!json.includes(".tmp"));
  assert.ok(!json.toLowerCase().includes("rename"));
});

// A guard so the suite's own assumptions stay honest: reconfiguration only ever
// touches these two documents.
test("reconfiguration never creates a third document type", (t) => {
  const sandbox = createSandbox(t);
  writeConfigDocument(sandbox, HAND_TUNED);

  runSetup(sandbox, applyArgs());

  assert.ok(configExists(sandbox));
  assert.ok(stateExists(sandbox));
  assert.deepEqual(fs.readdirSync(projectStoicDir(sandbox.projectDir)).sort(), [
    ".gitignore",
    "config.json",
  ]);
});
