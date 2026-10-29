import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { personalStateDir } from "../../src/io/paths.js";
import { createSandbox } from "./sandbox.js";

const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const printPathsFixture = path.join(fixturesDir, "print-paths.js");
const writeStateFixture = path.join(fixturesDir, "write-state.js");
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

test("a child process resolves every location inside the sandbox", (t) => {
  const sandbox = createSandbox(t);

  const result = sandbox.runNode(printPathsFixture);

  assert.equal(result.status, 0, result.stderr);
  const paths = JSON.parse(result.stdout);
  assert.equal(paths.home, sandbox.homeDir);
  assert.ok(paths.configPath.startsWith(sandbox.projectDir + path.sep));
  assert.ok(paths.statePath.startsWith(sandbox.homeDir + path.sep));
  assert.ok(!paths.statePath.startsWith(sandbox.projectDir + path.sep));
});

test("a child process resolves the sandbox project even when the parent names another", (t) => {
  // A suite run from inside a Claude Code session inherits CLAUDE_PROJECT_DIR
  // naming the real repository; the resolver's environment gate would then
  // hand a child that repository instead of the sandbox project.
  const previous = process.env.CLAUDE_PROJECT_DIR;
  process.env.CLAUDE_PROJECT_DIR = repositoryRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = previous;
  });
  const sandbox = createSandbox(t);

  const result = sandbox.runNode(printPathsFixture);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).projectRoot, sandbox.projectDir);
});

test("read-only inspection creates no project or home entries", (t) => {
  const sandbox = createSandbox(t);

  const result = sandbox.runNode(printPathsFixture);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).configReadStatus, "missing");
  assert.deepEqual(fs.readdirSync(sandbox.projectDir), []);
  assert.deepEqual(fs.readdirSync(sandbox.homeDir), []);
});

test("a child process persisting state writes only into the sandbox home", (t) => {
  const sandbox = createSandbox(t);

  const result = sandbox.runNode(writeStateFixture);

  assert.equal(result.status, 0, result.stderr);
  const { statePath } = JSON.parse(result.stdout);
  assert.ok(statePath.startsWith(sandbox.homeDir + path.sep));
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), {
    probe: true,
  });
  assert.deepEqual(fs.readdirSync(sandbox.projectDir), []);
  // The sandbox project's slug is unique, so its state directory resolved
  // against the contributor's real home must not exist after the write.
  assert.ok(!fs.existsSync(personalStateDir(sandbox.projectDir)));
});

test("fixtures are inert outside the sandbox harness", (t) => {
  const sandbox = createSandbox(t);
  const env = { ...sandbox.env };
  delete env.STOIC_TEST_SANDBOX;

  const result = spawnSync(process.execPath, [writeStateFixture], {
    cwd: sandbox.projectDir,
    env,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(fs.readdirSync(sandbox.homeDir), []);
});

test("the sandbox removes its temporary directories after the test", async (t) => {
  let root;
  await t.test("inner test that owns a sandbox", (inner) => {
    const sandbox = createSandbox(inner);
    root = path.dirname(sandbox.projectDir);
    assert.ok(fs.existsSync(root));
  });

  assert.ok(!fs.existsSync(root));
});
