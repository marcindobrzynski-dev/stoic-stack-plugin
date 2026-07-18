import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { personalStatePath } from "../../src/io/paths.js";
import { initializeState } from "../../src/io/state.js";
import { makeTempDir } from "../helpers/temp-dir.js";

/** A project and an isolated home, so no test can reach real personal state. */
function isolatedProject(t) {
  return {
    projectDir: makeTempDir(t, "stoic-state-project-"),
    homeDir: makeTempDir(t, "stoic-state-home-"),
  };
}

const readState = (projectDir, homeDir) =>
  JSON.parse(fs.readFileSync(personalStatePath(projectDir, homeDir), "utf8"));

/** Plant a pre-existing state document, bypassing the module under test. */
function writeStateDocument(projectDir, homeDir, contents) {
  const statePath = personalStatePath(projectDir, homeDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const raw =
    typeof contents === "string" ? contents : JSON.stringify(contents);
  fs.writeFileSync(statePath, raw, "utf8");
  return statePath;
}

test("initializing a fresh project creates neutral engine state", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);

  const result = initializeState(projectDir, homeDir);

  assert.equal(result.status, "created");
  assert.deepEqual(readState(projectDir, homeDir), {
    score: 0,
    last_update: 0,
    mutes: [],
    skip_streak: {},
    skip_totals: {},
  });
});

test("fresh state carries no personal preset override", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);

  initializeState(projectDir, homeDir);

  // Absence is meaningful: a personal preset here would shadow the committed
  // team preset and pin every teammate to the built-in default.
  assert.ok(!("preset" in readState(projectDir, homeDir)));
});

test("re-initializing preserves state the developer already accumulated", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);
  const earned = {
    score: 7.5,
    last_update: 1783780610000,
    mutes: [{ category: "security", files: null, expires_at: 1783780610000 }],
    skip_streak: { architecture: { count: 2, last_skip: 1783780610000 } },
    skip_totals: { architecture: 5 },
    preset: "vigilant",
  };
  writeStateDocument(projectDir, homeDir, earned);

  const result = initializeState(projectDir, homeDir);

  assert.equal(result.status, "preserved");
  assert.deepEqual(readState(projectDir, homeDir), earned);
});

test("initializing twice is idempotent", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);

  initializeState(projectDir, homeDir);
  const first = readState(projectDir, homeDir);
  const result = initializeState(projectDir, homeDir);

  assert.equal(result.status, "preserved");
  assert.deepEqual(readState(projectDir, homeDir), first);
});

test("corrupt state is reported as a failure, never overwritten", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);
  const truncated = '{"score": 7.5, "mutes": [';
  const statePath = writeStateDocument(projectDir, homeDir, truncated);

  const result = initializeState(projectDir, homeDir);

  assert.equal(result.status, "failed");
  assert.ok(result.error instanceof Error);
  assert.equal(result.path, statePath);
  // The unreadable document survives byte-for-byte: it is the only copy of
  // history the user has, and setup does not get to decide it is worthless.
  assert.equal(fs.readFileSync(statePath, "utf8"), truncated);
});

test("state that parses but is not a document is a failure, not a reset", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);
  const notADocument = "[1, 2, 3]";
  const statePath = writeStateDocument(projectDir, homeDir, notADocument);

  const result = initializeState(projectDir, homeDir);

  assert.equal(result.status, "failed");
  assert.equal(fs.readFileSync(statePath, "utf8"), notADocument);
});

test("a failed initialization leaves no temporary files behind", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);
  const statePath = writeStateDocument(projectDir, homeDir, "{oops");

  initializeState(projectDir, homeDir);

  assert.deepEqual(fs.readdirSync(path.dirname(statePath)), ["state.json"]);
});

test("initialization writes nothing inside the project repository", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);

  initializeState(projectDir, homeDir);

  assert.deepEqual(fs.readdirSync(projectDir), []);
  assert.ok(
    !personalStatePath(projectDir, homeDir).startsWith(
      path.resolve(projectDir) + path.sep,
    ),
  );
});
