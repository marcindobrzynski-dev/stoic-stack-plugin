// Project-root resolution, driven through the real entrypoints as processes.
//
// The unit suite beside this file, `project-root.test.js`, proves the resolver answers
// correctly. This one proves the entrypoints ASK it: that a hook or CLI started
// in a subdirectory keys its configuration and state on the Project Root rather
// than on the directory it was handed. Only a real child process can show that,
// because the directory is exactly what a process owns and a module does not.
//
// It lives apart from the Stop and loop suites because those rebuild the
// child's PATH around the `claude` shim, which leaves no `git` for the git gate
// to find. Here the child inherits the real PATH and meets real repositories.
//
// Contract: thoughts/shared/.project/architecture.md §State locations, and
// thoughts/shared/.project/glossary.md §Project Root.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  manualPausePath,
  personalStatePath,
  projectConfigPath,
} from "../../../src/io/paths.js";
import { readSessionEvents } from "../../../src/io/session-log.js";
import { runHook } from "../../helpers/capture-hook.js";
import { initRepo } from "../../helpers/git-repo.js";
import { runReflect } from "../../helpers/reflect-cli.js";
import { createSandbox } from "../../helpers/sandbox.js";
import { applyArgs, runSetup } from "../../helpers/setup-cli.js";

const SESSION_ID = "session-project-root-1";

test("a Stop started in a subdirectory writes state under the repository root", (t) => {
  const sandbox = createSandbox(t);
  const root = initRepo(sandbox.projectDir, sandbox.env);
  const subdirectory = path.join(root, "src");
  fs.mkdirSync(subdirectory);

  // Claude Code hands the hook the subdirectory twice: as its process
  // directory and as the payload's `cwd`.
  const run = runHook(
    sandbox,
    "stop",
    { session_id: SESSION_ID, cwd: subdirectory, stop_hook_active: false },
    { cwd: subdirectory },
  );

  assert.equal(run.status, 0, run.stderr);
  assert.ok(
    fs.existsSync(personalStatePath(root, sandbox.homeDir)),
    "state.json must be keyed on the repository root",
  );
  assert.ok(
    !fs.existsSync(personalStatePath(subdirectory, sandbox.homeDir)),
    "no state may be keyed on the subdirectory",
  );
});

test("a session that moves from the root into a subdirectory keeps one event log", (t) => {
  const sandbox = createSandbox(t);
  const root = initRepo(sandbox.projectDir, sandbox.env);
  const subdirectory = path.join(root, "src");
  fs.mkdirSync(subdirectory);

  // One session, two prompts: the first handed the root, the second the
  // subdirectory — the move the diagnostics caught within a single session.
  for (const cwd of [root, subdirectory]) {
    const run = runHook(
      sandbox,
      "user-prompt-submit",
      { session_id: SESSION_ID, cwd, prompt: "Rename the helper" },
      { cwd },
    );
    assert.equal(run.status, 0, run.stderr);
  }

  assert.equal(
    readSessionEvents(root, SESSION_ID, sandbox.homeDir).length,
    2,
    "both prompts must land in the repository root's log",
  );
  assert.deepEqual(
    readSessionEvents(subdirectory, SESSION_ID, sandbox.homeDir),
    [],
    "no event may be keyed on the subdirectory",
  );
});

test("setup run from a subdirectory writes configuration at the repository root", (t) => {
  const sandbox = createSandbox(t);
  const root = initRepo(sandbox.projectDir, sandbox.env);
  const subdirectory = path.join(root, "src");
  fs.mkdirSync(subdirectory);

  const { status, stderr } = runSetup(sandbox, applyArgs(), {
    cwd: subdirectory,
  });

  assert.equal(status, 0, stderr);
  assert.ok(
    fs.existsSync(projectConfigPath(root)),
    "config.json must be written at the repository root",
  );
  assert.ok(
    !fs.existsSync(projectConfigPath(subdirectory)),
    "no config may be written in the subdirectory",
  );
});

test("reflect run from a subdirectory writes its pause under the repository root", (t) => {
  const sandbox = createSandbox(t);
  const root = initRepo(sandbox.projectDir, sandbox.env);
  const subdirectory = path.join(root, "src");
  fs.mkdirSync(subdirectory);

  const { status, stderr } = runReflect(sandbox, [], { cwd: subdirectory });

  assert.equal(status, 0, stderr);
  const pause = JSON.parse(
    fs.readFileSync(manualPausePath(root, sandbox.homeDir), "utf8"),
  );
  // `record.js` reads the project from here, so a pause filed under the root
  // but naming the subdirectory would still reward the wrong state.
  assert.equal(pause.cwd, root, "the pause must name the repository root");
  assert.ok(
    !fs.existsSync(manualPausePath(subdirectory, sandbox.homeDir)),
    "no pause may be keyed on the subdirectory",
  );
});
