// The setup CLI is the seam this whole feature is verified through: every test
// here runs the real script as a child process against a throwaway project and
// a throwaway home, and asserts only what a caller can observe — stdout, exit
// status, and the documents on disk. Nothing reaches inside the process, so the
// internals stay free to change. The child-process harness itself lives in
// ../helpers/setup-cli.js, shared with the reconfiguration suite.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  CATEGORIES,
  PAUSE_MODES,
  PRESET_NAMES,
  defaultConfig,
} from "../../src/io/config/config.js";
import { projectConfigPath, projectGitignorePath } from "../../src/io/paths.js";
import { createSandbox } from "../helpers/sandbox.js";
import {
  applyArgs,
  configExists,
  readConfig,
  readState,
  runSetup,
  stateExists,
  writeConfigDocument,
  writeStateDocument,
} from "../helpers/setup-cli.js";

// ---------------------------------------------------------------------------
// Fresh initialization
// ---------------------------------------------------------------------------

test("fresh setup writes a complete canonical config and creates state", (t) => {
  const sandbox = createSandbox(t);

  const { status, result } = runSetup(sandbox, applyArgs());

  assert.equal(status, 0);
  assert.deepEqual(result, {
    ok: true,
    operation: "apply",
    choices: {
      preset: "balanced",
      categories: ["data_domain", "security"],
      pause_mode: "hybrid",
      followup_draft: true,
    },
    enabled: true,
    state: "created",
    config: "written",
  });

  // The document is complete, not just the guided subset: every field a later
  // runtime consumer reads is present.
  assert.deepEqual(readConfig(sandbox), {
    ...defaultConfig(),
    categories: ["data_domain", "security"],
  });
});

test("fresh setup keeps engine state out of the repository", (t) => {
  const sandbox = createSandbox(t);

  runSetup(sandbox, applyArgs());

  assert.ok(stateExists(sandbox));
  assert.deepEqual(readState(sandbox), {
    score: 0,
    last_update: 0,
    mutes: [],
    skip_streak: {},
    skip_totals: {},
  });
  // Nothing under the project may hold personal state; only the config and
  // its privacy guard land.
  assert.deepEqual(
    fs.readdirSync(path.join(sandbox.projectDir, ".stoic")).sort(),
    [".gitignore", "config.json"],
  );
});

const ignoreLinesOf = (sandbox) =>
  fs
    .readFileSync(projectGitignorePath(sandbox.projectDir), "utf8")
    .split("\n")
    .map((line) => line.trim());

test("setup keeps the local key file and the decision bank out of commits", (t) => {
  const sandbox = createSandbox(t);

  runSetup(sandbox, applyArgs());

  const lines = ignoreLinesOf(sandbox);
  assert.ok(lines.includes(".env"), lines.join("\n"));
  assert.ok(lines.includes("decisions/"), lines.join("\n"));
});

test("re-running setup keeps a hand-edited ignore file without duplicating its lines", (t) => {
  const sandbox = createSandbox(t);
  runSetup(sandbox, applyArgs());
  const edited = `${fs.readFileSync(projectGitignorePath(sandbox.projectDir), "utf8")}scratch/\n`;
  fs.writeFileSync(projectGitignorePath(sandbox.projectDir), edited, "utf8");

  runSetup(sandbox, applyArgs());

  assert.equal(
    fs.readFileSync(projectGitignorePath(sandbox.projectDir), "utf8"),
    edited,
  );
  const lines = ignoreLinesOf(sandbox);
  assert.equal(lines.filter((line) => line === ".env").length, 1);
  assert.equal(lines.filter((line) => line === "decisions/").length, 1);
});

test("setup never manufactures a personal preset override", (t) => {
  const sandbox = createSandbox(t);

  runSetup(sandbox, applyArgs({ preset: "vigilant" }));

  // The preset the user chose is the TEAM value. A personal override in state
  // would shadow it, which is exactly what stops a committed preset from
  // reaching a teammate.
  assert.equal(readConfig(sandbox).preset, "vigilant");
  assert.ok(!Object.hasOwn(readState(sandbox), "preset"));
});

// ---------------------------------------------------------------------------
// Every supported guided choice
// ---------------------------------------------------------------------------

for (const preset of PRESET_NAMES) {
  test(`setup accepts the ${preset} preset`, (t) => {
    const sandbox = createSandbox(t);

    const { status, result } = runSetup(sandbox, applyArgs({ preset }));

    assert.equal(status, 0);
    assert.equal(result.choices.preset, preset);
    assert.equal(readConfig(sandbox).preset, preset);
  });
}

for (const mode of PAUSE_MODES) {
  test(`setup accepts the ${mode} pause mode`, (t) => {
    const sandbox = createSandbox(t);

    const { status, result } = runSetup(
      sandbox,
      applyArgs({ "pause-mode": mode }),
    );

    assert.equal(status, 0);
    assert.equal(result.choices.pause_mode, mode);
    assert.equal(readConfig(sandbox).pause_mode, mode);
  });
}

for (const area of CATEGORIES) {
  test(`setup accepts ${area} as the only decision area`, (t) => {
    const sandbox = createSandbox(t);

    const { status, result } = runSetup(
      sandbox,
      applyArgs({ categories: area }),
    );

    assert.equal(status, 0);
    assert.deepEqual(result.choices.categories, [area]);
    assert.equal(result.enabled, true);
    assert.deepEqual(readConfig(sandbox).categories, [area]);
  });
}

for (const followup of [true, false]) {
  test(`setup accepts followup drafting ${followup}`, (t) => {
    const sandbox = createSandbox(t);

    const { status, result } = runSetup(
      sandbox,
      applyArgs({ "followup-draft": String(followup) }),
    );

    assert.equal(status, 0);
    assert.equal(result.choices.followup_draft, followup);
    assert.equal(readConfig(sandbox).followup_draft, followup);
  });
}

test("setup accepts every decision area at once", (t) => {
  const sandbox = createSandbox(t);

  const { status, result } = runSetup(
    sandbox,
    applyArgs({ categories: CATEGORIES.join(",") }),
  );

  assert.equal(status, 0);
  assert.deepEqual(result.choices.categories, [...CATEGORIES]);
  assert.equal(result.enabled, true);
});

// ---------------------------------------------------------------------------
// Empty selection is an answer, not an omission
// ---------------------------------------------------------------------------

test("selecting no decision areas disables the plugin", (t) => {
  const sandbox = createSandbox(t);

  const { status, result } = runSetup(sandbox, applyArgs({ categories: "" }));

  assert.equal(status, 0);
  assert.deepEqual(result.choices.categories, []);
  assert.equal(result.enabled, false);

  const config = readConfig(sandbox);
  assert.deepEqual(config.categories, []);
  assert.equal(config.enabled, false);
});

test("selecting an area again re-enables the plugin", (t) => {
  const sandbox = createSandbox(t);

  runSetup(sandbox, applyArgs({ categories: "" }));
  const { result } = runSetup(sandbox, applyArgs({ categories: "security" }));

  assert.equal(result.enabled, true);
  assert.equal(readConfig(sandbox).enabled, true);
});

// ---------------------------------------------------------------------------
// Current-settings inspection
// ---------------------------------------------------------------------------

test("--current reports the recommended defaults and writes nothing", (t) => {
  const sandbox = createSandbox(t);

  const { status, result } = runSetup(sandbox, ["--current"]);

  assert.equal(status, 0);
  assert.deepEqual(result, {
    ok: true,
    operation: "current",
    choices: {
      preset: "balanced",
      categories: [...CATEGORIES],
      pause_mode: "hybrid",
      followup_draft: true,
    },
    enabled: true,
  });
  // Inspecting must never bring a project under configuration.
  assert.ok(!configExists(sandbox));
  assert.ok(!stateExists(sandbox));
});

test("--current reflects the choices already applied", (t) => {
  const sandbox = createSandbox(t);

  runSetup(
    sandbox,
    applyArgs({
      preset: "calm",
      categories: "security",
      "pause-mode": "freeform",
      "followup-draft": "false",
    }),
  );
  const { result } = runSetup(sandbox, ["--current"]);

  assert.deepEqual(result.choices, {
    preset: "calm",
    categories: ["security"],
    pause_mode: "freeform",
    followup_draft: false,
  });
});

test("--current ignores a personal preset override", (t) => {
  const sandbox = createSandbox(t);

  runSetup(sandbox, applyArgs({ preset: "calm" }));
  writeStateDocument(sandbox, { ...readState(sandbox), preset: "vigilant" });

  // Offering the private override as the current answer would make an
  // unchanged re-run publish it to the team.
  const { result } = runSetup(sandbox, ["--current"]);
  assert.equal(result.choices.preset, "calm");
});

// ---------------------------------------------------------------------------
// Rejected requests write nothing
// ---------------------------------------------------------------------------

test("an unsupported preset is rejected and nothing is written", (t) => {
  const sandbox = createSandbox(t);

  const { status, result } = runSetup(
    sandbox,
    applyArgs({ preset: "reckless" }),
  );

  assert.equal(status, 2);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_choice");
  assert.match(result.error.message, /preset/);
  assert.equal(result.state, "unchanged");
  assert.equal(result.config, "unchanged");
  assert.ok(!configExists(sandbox));
  assert.ok(!stateExists(sandbox));
});

test("an unsupported decision area is rejected and nothing is written", (t) => {
  const sandbox = createSandbox(t);

  const { status, result } = runSetup(
    sandbox,
    applyArgs({ categories: "security,telepathy" }),
  );

  assert.equal(status, 2);
  assert.equal(result.error.code, "invalid_choice");
  assert.ok(!configExists(sandbox));
  assert.ok(!stateExists(sandbox));
});

test("an unsupported pause mode is rejected", (t) => {
  const sandbox = createSandbox(t);

  const { status, result } = runSetup(
    sandbox,
    applyArgs({ "pause-mode": "nagging" }),
  );

  assert.equal(status, 2);
  assert.equal(result.error.code, "invalid_choice");
  assert.ok(!configExists(sandbox));
});

test("a non-boolean followup choice is rejected", (t) => {
  const sandbox = createSandbox(t);

  const { status, result } = runSetup(
    sandbox,
    applyArgs({ "followup-draft": "yes" }),
  );

  assert.equal(status, 2);
  assert.equal(result.error.code, "invalid_choice");
  assert.match(result.error.message, /followup/);
  assert.ok(!configExists(sandbox));
});

test("legacy sandbox names are not accepted as guided input", (t) => {
  const sandbox = createSandbox(t);

  // `conservative` and `choice_only` are migration input for a persisted
  // document only. Accepting them here would quietly keep the old vocabulary
  // alive in new writes.
  for (const args of [
    applyArgs({ preset: "conservative" }),
    applyArgs({ "pause-mode": "choice_only" }),
  ]) {
    const { status, result } = runSetup(sandbox, args);
    assert.equal(status, 2);
    assert.equal(result.error.code, "invalid_choice");
  }
  assert.ok(!configExists(sandbox));
});

test("an incomplete request names every missing choice", (t) => {
  const sandbox = createSandbox(t);

  const { status, result } = runSetup(sandbox, ["--apply", "--preset", "calm"]);

  assert.equal(status, 2);
  assert.equal(result.error.code, "invalid_choice");
  assert.match(result.error.message, /--categories/);
  assert.match(result.error.message, /--pause-mode/);
  assert.match(result.error.message, /--followup-draft/);
  assert.ok(!configExists(sandbox));
  assert.ok(!stateExists(sandbox));
});

test("an unknown flag is a usage error", (t) => {
  const sandbox = createSandbox(t);

  const { status, result } = runSetup(sandbox, [...applyArgs(), "--turbo"]);

  assert.equal(status, 2);
  assert.equal(result.error.code, "usage");
  assert.ok(!configExists(sandbox));
});

test("setup requires exactly one operation", (t) => {
  const sandbox = createSandbox(t);

  for (const args of [[], ["--current", ...applyArgs()]]) {
    const { status, result } = runSetup(sandbox, args);
    assert.equal(status, 2);
    assert.equal(result.error.code, "usage");
  }
  assert.ok(!configExists(sandbox));
});

// ---------------------------------------------------------------------------
// Recovery and preservation
// ---------------------------------------------------------------------------

test("setup replaces a corrupt config with a valid canonical one", (t) => {
  const sandbox = createSandbox(t);
  writeConfigDocument(sandbox, "{ not json at all");

  const { status, result } = runSetup(sandbox, applyArgs({ preset: "calm" }));

  // Config is reproducible, so an explicit setup run is allowed to regenerate
  // it — the user asked.
  assert.equal(status, 0);
  assert.equal(result.ok, true);
  assert.equal(readConfig(sandbox).preset, "calm");
});

test("setup refuses to touch unreadable engine state", (t) => {
  const sandbox = createSandbox(t);
  writeStateDocument(sandbox, "{ mangled");

  const { status, result, stderr } = runSetup(sandbox, applyArgs());

  // State is unrecoverable history, so setup reports it instead of deciding it
  // is worthless — and stops before the config write, leaving the project as
  // it was.
  assert.equal(status, 1);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "state_init_failed");
  assert.equal(result.state, "unchanged");
  assert.equal(result.config, "unchanged");
  assert.ok(!configExists(sandbox));
  // The path belongs in the human diagnostic, not the machine contract.
  assert.match(stderr, /state\.json/);
  assert.ok(!JSON.stringify(result).includes(sandbox.homeDir));
});

test("re-running setup preserves existing engine state", (t) => {
  const sandbox = createSandbox(t);
  runSetup(sandbox, applyArgs());
  writeStateDocument(sandbox, {
    ...readState(sandbox),
    score: 7.5,
    last_update: 1_700_000_000_000,
    skip_totals: { security: 2 },
  });

  const { result } = runSetup(sandbox, applyArgs({ preset: "vigilant" }));

  assert.equal(result.state, "preserved");
  const state = readState(sandbox);
  assert.equal(state.score, 7.5);
  assert.equal(state.last_update, 1_700_000_000_000);
  assert.deepEqual(state.skip_totals, { security: 2 });
});

test("re-running setup with the same choices is idempotent", (t) => {
  const sandbox = createSandbox(t);

  runSetup(sandbox, applyArgs());
  const first = fs.readFileSync(projectConfigPath(sandbox.projectDir), "utf8");
  const { result } = runSetup(sandbox, applyArgs());

  assert.equal(result.ok, true);
  assert.equal(
    fs.readFileSync(projectConfigPath(sandbox.projectDir), "utf8"),
    first,
  );
});

// ---------------------------------------------------------------------------
// Output contract
// ---------------------------------------------------------------------------

test("no result exposes a filesystem location", (t) => {
  const sandbox = createSandbox(t);

  for (const args of [
    ["--current"],
    applyArgs(),
    applyArgs({ preset: "bogus" }),
  ]) {
    const { result } = runSetup(sandbox, args);
    const json = JSON.stringify(result);
    assert.ok(!json.includes(sandbox.projectDir));
    assert.ok(!json.includes(sandbox.homeDir));
    assert.ok(!json.includes(".stoic"));
  }
});
