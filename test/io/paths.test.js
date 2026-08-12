import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  pendingPausePath,
  personalStateDir,
  personalStatePath,
  projectConfigPath,
  projectSlug,
  projectStoicDir,
  sessionLogPath,
  sessionsDir,
  tracePath,
} from "../../src/io/paths.js";
import { makeTempDir } from "../helpers/temp-dir.js";

test("projectSlug produces a filesystem-safe, deterministic slug", (t) => {
  const projectDir = makeTempDir(t, "stoic-paths-");

  const slug = projectSlug(projectDir);

  assert.match(slug, /^[A-Za-z0-9-]+$/);
  assert.equal(slug, projectSlug(projectDir));
});

test("projectSlug distinguishes different project directories", (t) => {
  const first = makeTempDir(t, "stoic-paths-a-");
  const second = makeTempDir(t, "stoic-paths-b-");

  assert.notEqual(projectSlug(first), projectSlug(second));
});

test("project configuration lives in .stoic inside the project", (t) => {
  const projectDir = makeTempDir(t, "stoic-paths-");

  assert.equal(projectStoicDir(projectDir), path.join(projectDir, ".stoic"));
  assert.equal(
    projectConfigPath(projectDir),
    path.join(projectDir, ".stoic", "config.json"),
  );
});

test("personal state lives under the Claude home, outside the project", (t) => {
  const projectDir = makeTempDir(t, "stoic-paths-");
  const homeDir = makeTempDir(t, "stoic-home-");

  const stateDir = personalStateDir(projectDir, homeDir);
  const statePath = personalStatePath(projectDir, homeDir);

  assert.equal(
    stateDir,
    path.join(homeDir, ".claude", "stoic-stack", projectSlug(projectDir)),
  );
  assert.equal(statePath, path.join(stateDir, "state.json"));
  assert.ok(!statePath.startsWith(path.resolve(projectDir) + path.sep));
});

test("personal state resolution defaults to the user's home directory", (t) => {
  const projectDir = makeTempDir(t, "stoic-paths-");

  const stateDir = personalStateDir(projectDir);

  assert.ok(
    stateDir.startsWith(path.join(os.homedir(), ".claude", "stoic-stack")),
  );
});

test("session logs live under sessions/ inside the personal-state directory", (t) => {
  const projectDir = makeTempDir(t, "stoic-paths-");
  const homeDir = makeTempDir(t, "stoic-home-");

  const dir = sessionsDir(projectDir, homeDir);
  const logPath = sessionLogPath(projectDir, "abc-123", homeDir);

  assert.equal(
    dir,
    path.join(personalStateDir(projectDir, homeDir), "sessions"),
  );
  assert.equal(logPath, path.join(dir, "abc-123.jsonl"));
});

test("a hostile session id cannot escape the sessions directory", (t) => {
  const projectDir = makeTempDir(t, "stoic-paths-");
  const homeDir = makeTempDir(t, "stoic-home-");

  const logPath = sessionLogPath(projectDir, "../../evil/../id", homeDir);

  assert.equal(path.dirname(logPath), sessionsDir(projectDir, homeDir));
  assert.match(path.basename(logPath), /^[A-Za-z0-9-]+\.jsonl$/);
});

test("the trace sink lives at the top of the personal-state directory", (t) => {
  const projectDir = makeTempDir(t, "stoic-paths-");
  const homeDir = makeTempDir(t, "stoic-home-");

  assert.equal(
    tracePath(projectDir, homeDir),
    path.join(personalStateDir(projectDir, homeDir), "trace.jsonl"),
  );
});

test("the pending pause document sits beside the personal state document", (t) => {
  const projectDir = makeTempDir(t, "stoic-paths-");
  const homeDir = makeTempDir(t, "stoic-home-");

  const pausePath = pendingPausePath(projectDir, homeDir);

  assert.equal(
    pausePath,
    path.join(
      personalStateDir(projectDir, homeDir),
      "stoic-pending-pause.json",
    ),
  );
  assert.equal(
    path.dirname(pausePath),
    path.dirname(personalStatePath(projectDir, homeDir)),
  );
  assert.ok(!pausePath.startsWith(path.resolve(projectDir) + path.sep));
});

test("pending pause resolution defaults to the user's home directory", (t) => {
  const projectDir = makeTempDir(t, "stoic-paths-");

  assert.equal(
    pendingPausePath(projectDir),
    path.join(personalStateDir(projectDir), "stoic-pending-pause.json"),
  );
});

test("a relative project directory resolves to an absolute location", (t) => {
  const projectDir = makeTempDir(t, "stoic-paths-");
  const relative = path.relative(process.cwd(), projectDir);

  assert.equal(projectStoicDir(relative), path.join(projectDir, ".stoic"));
  assert.equal(projectSlug(relative), projectSlug(projectDir));
});

test("resolving every path creates no file or directory", (t) => {
  const projectDir = makeTempDir(t, "stoic-paths-");
  const homeDir = makeTempDir(t, "stoic-home-");

  projectStoicDir(projectDir);
  projectConfigPath(projectDir);
  projectSlug(projectDir);
  personalStateDir(projectDir, homeDir);
  personalStatePath(projectDir, homeDir);
  sessionsDir(projectDir, homeDir);
  sessionLogPath(projectDir, "abc-123", homeDir);
  tracePath(projectDir, homeDir);
  pendingPausePath(projectDir, homeDir);

  assert.deepEqual(fs.readdirSync(projectDir), []);
  assert.deepEqual(fs.readdirSync(homeDir), []);
});
