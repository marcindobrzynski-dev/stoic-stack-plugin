// Shared harness for driving the real setup CLI as a child process. Both the
// fresh-project suite (task 04) and the reconfiguration suite (task 05) verify
// the plugin through this one seam: run `src/cli/setup.js` against a throwaway
// project and home, and assert only what a caller can observe — stdout, exit
// status, and the documents left on disk. Nothing reaches inside the process.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { personalStatePath, projectConfigPath } from "../../src/io/paths.js";

export const SETUP_CLI = fileURLToPath(
  new URL("../../src/cli/setup.js", import.meta.url),
);

/** Run the real CLI and parse the single JSON result it contracts to emit. */
export function runSetup(sandbox, args) {
  const run = sandbox.runNode(SETUP_CLI, args);
  let result;
  try {
    result = JSON.parse(run.stdout);
  } catch {
    assert.fail(
      `setup.js must always print one JSON result to stdout. Got:\n${run.stdout}\nstderr:\n${run.stderr}`,
    );
  }
  return { status: run.status, stderr: run.stderr, result };
}

/** A complete, valid `--apply` request; override one field to make it invalid. */
export function applyArgs(overrides = {}) {
  const choices = {
    preset: "balanced",
    categories: "data_domain,security",
    "pause-mode": "hybrid",
    "followup-draft": "true",
    ...overrides,
  };
  return [
    "--apply",
    ...Object.entries(choices).flatMap(([flag, value]) => [`--${flag}`, value]),
  ];
}

/** Raw config-document bytes, exactly as they sit on disk. */
export const readConfigText = (sandbox) =>
  fs.readFileSync(projectConfigPath(sandbox.projectDir), "utf8");

export const readConfig = (sandbox) => JSON.parse(readConfigText(sandbox));

export const configExists = (sandbox) =>
  fs.existsSync(projectConfigPath(sandbox.projectDir));

export const stateExists = (sandbox) =>
  fs.existsSync(personalStatePath(sandbox.projectDir, sandbox.homeDir));

/** Raw state-document bytes, exactly as they sit on disk. */
export const readStateText = (sandbox) =>
  fs.readFileSync(
    personalStatePath(sandbox.projectDir, sandbox.homeDir),
    "utf8",
  );

export const readState = (sandbox) => JSON.parse(readStateText(sandbox));

/** Plant a config document directly, bypassing the CLI under test. */
export function writeConfigDocument(sandbox, contents) {
  const configPath = projectConfigPath(sandbox.projectDir);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    typeof contents === "string" ? contents : JSON.stringify(contents),
    "utf8",
  );
}

/** Plant a state document directly, bypassing the CLI under test. */
export function writeStateDocument(sandbox, contents) {
  const statePath = personalStatePath(sandbox.projectDir, sandbox.homeDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    typeof contents === "string" ? contents : JSON.stringify(contents),
    "utf8",
  );
}
