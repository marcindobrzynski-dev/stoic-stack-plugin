// The runtime half of personal state: the load/save pair the Stop hook turns a
// turn into a persisted score with.
//
// It sits beside `state.test.js` rather than inside it because the two halves
// answer opposite questions. Initialization is a foreground operation that
// REPORTS what it cannot understand; these two run inside a hook, where an
// unreadable document must resolve to neutral state and the turn must go on.
//
// Contract: thoughts/shared/.project/architecture/payloads.md §`state.json`.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { personalStatePath } from "../../src/io/paths.js";
import { defaultState, loadState, saveState } from "../../src/io/state.js";
import { makeTempDir } from "../helpers/temp-dir.js";

/** A project and an isolated home, so no test can reach real personal state. */
function isolatedProject(t) {
  return {
    projectDir: makeTempDir(t, "stoic-state-project-"),
    homeDir: makeTempDir(t, "stoic-state-home-"),
  };
}

/** The document as it stands on disk, read without the module under test. */
const readState = (projectDir, homeDir) =>
  JSON.parse(fs.readFileSync(personalStatePath(projectDir, homeDir), "utf8"));

/** Plant a pre-existing state document, bypassing the module under test. */
function writeStateDocument(projectDir, homeDir, contents) {
  const statePath = personalStatePath(projectDir, homeDir);
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(
    statePath,
    typeof contents === "string" ? contents : JSON.stringify(contents),
    "utf8",
  );
  return statePath;
}

/** State a developer accumulated over real use — every field populated. */
const earnedState = () => ({
  score: 7.5,
  last_update: 1783780610000,
  mutes: [{ category: "security", files: null, expires_at: 1783784210000 }],
  skip_streak: { architecture: { count: 2, last_skip: 1783780610000 } },
  skip_totals: { architecture: 5, security: 1 },
  preset: "vigilant",
});

// ---------------------------------------------------------------------------
// Loading — fail-silent, and never a repair.
// ---------------------------------------------------------------------------

test("state a project never had loads as neutral state", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);

  assert.deepEqual(loadState(projectDir, homeDir), defaultState());
});

test("loading never creates the document it did not find", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);

  loadState(projectDir, homeDir);

  assert.equal(fs.existsSync(personalStatePath(projectDir, homeDir)), false);
});

test("corrupt state loads as neutral state instead of throwing", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);
  const truncated = '{"score": 7.5, "mutes": [';
  const statePath = writeStateDocument(projectDir, homeDir, truncated);

  assert.deepEqual(loadState(projectDir, homeDir), defaultState());
  // Reading is not repairing: the unreadable document survives byte-for-byte,
  // so the user can still recover the only copy of their history.
  assert.equal(fs.readFileSync(statePath, "utf8"), truncated);
});

test("state that parses but is not a document loads as neutral too", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);
  writeStateDocument(projectDir, homeDir, "[1, 2, 3]");

  assert.deepEqual(loadState(projectDir, homeDir), defaultState());
});

test("a valid document loads exactly as the previous turn wrote it", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);
  const earned = earnedState();
  writeStateDocument(projectDir, homeDir, earned);

  assert.deepEqual(loadState(projectDir, homeDir), earned);
});

test("a partial document loads with every field the engine expects", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);
  writeStateDocument(projectDir, homeDir, { score: 4 });

  const state = loadState(projectDir, homeDir);

  assert.equal(state.score, 4);
  assert.equal(state.last_update, 0);
  assert.deepEqual(state.mutes, []);
  assert.deepEqual(state.skip_streak, {});
  assert.deepEqual(state.skip_totals, {});
});

// ---------------------------------------------------------------------------
// Saving — atomic, and never lossy.
// ---------------------------------------------------------------------------

test("saving state round-trips through the document on disk", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);
  const saved = { ...defaultState(), score: 12.25, last_update: 1783780610000 };

  saveState(projectDir, saved, homeDir);

  assert.deepEqual(readState(projectDir, homeDir), saved);
  assert.deepEqual(loadState(projectDir, homeDir), saved);
});

test("saving creates the state directory and leaves no temporary file", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);

  saveState(projectDir, defaultState(), homeDir);

  const statePath = personalStatePath(projectDir, homeDir);
  assert.deepEqual(fs.readdirSync(path.dirname(statePath)), ["state.json"]);
});

test("saving writes nothing inside the project repository", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);

  saveState(projectDir, defaultState(), homeDir);

  assert.deepEqual(fs.readdirSync(projectDir), []);
});

test("a load-modify-save cycle leaves fields the scorer does not own alone", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);
  const earned = earnedState();
  writeStateDocument(projectDir, homeDir, earned);

  const state = loadState(projectDir, homeDir);
  state.score = 9.5;
  state.last_update = 1783790610000;
  saveState(projectDir, state, homeDir);

  assert.deepEqual(readState(projectDir, homeDir), {
    ...earned,
    score: 9.5,
    last_update: 1783790610000,
  });
});

test("a save preserves what the save before it wrote", (t) => {
  const { projectDir, homeDir } = isolatedProject(t);
  const earned = earnedState();
  saveState(projectDir, earned, homeDir);

  const state = loadState(projectDir, homeDir);
  state.score = 5;
  saveState(projectDir, state, homeDir);

  const reloaded = loadState(projectDir, homeDir);
  assert.equal(reloaded.score, 5);
  assert.deepEqual(reloaded.mutes, earned.mutes);
  assert.deepEqual(reloaded.skip_streak, earned.skip_streak);
  assert.deepEqual(reloaded.skip_totals, earned.skip_totals);
  assert.equal(reloaded.preset, earned.preset);
});
