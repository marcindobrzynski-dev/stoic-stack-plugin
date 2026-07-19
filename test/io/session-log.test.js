import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { sessionLogPath, sessionsDir } from "../../src/io/paths.js";
import {
  appendSessionEvent,
  readSessionEvents,
  truncateSessionLog,
} from "../../src/io/session-log.js";
import { makeTempDir } from "../helpers/temp-dir.js";

const SESSION_ID = "abc-123";

test("appended events read back in order as one object per line", (t) => {
  const projectDir = makeTempDir(t, "stoic-log-");
  const homeDir = makeTempDir(t, "stoic-home-");
  const prompt = {
    type: "prompt",
    ts: 1,
    prompt: "why?",
    effort: 0.4,
    permission_mode: "default",
    neutralized: false,
  };
  const edit = {
    type: "edit",
    ts: 2,
    file: "src/x.js",
    lines_added: 3,
    lines_removed: 1,
    permission_mode: "default",
    delegated: false,
    agent_type: null,
  };

  appendSessionEvent(projectDir, SESSION_ID, prompt, homeDir);
  appendSessionEvent(projectDir, SESSION_ID, edit, homeDir);

  assert.deepEqual(readSessionEvents(projectDir, SESSION_ID, homeDir), [
    prompt,
    edit,
  ]);
});

test("the first append creates the sessions directory", (t) => {
  const projectDir = makeTempDir(t, "stoic-log-");
  const homeDir = makeTempDir(t, "stoic-home-");

  appendSessionEvent(projectDir, SESSION_ID, { type: "prompt" }, homeDir);

  assert.ok(fs.existsSync(sessionsDir(projectDir, homeDir)));
});

test("reading a missing log returns no events and creates nothing", (t) => {
  const projectDir = makeTempDir(t, "stoic-log-");
  const homeDir = makeTempDir(t, "stoic-home-");

  const events = readSessionEvents(projectDir, SESSION_ID, homeDir);

  assert.deepEqual(events, []);
  assert.deepEqual(fs.readdirSync(homeDir), []);
});

test("events for different sessions land in separate logs", (t) => {
  const projectDir = makeTempDir(t, "stoic-log-");
  const homeDir = makeTempDir(t, "stoic-home-");

  appendSessionEvent(projectDir, "session-a", { type: "prompt" }, homeDir);
  appendSessionEvent(projectDir, "session-b", { type: "edit" }, homeDir);

  assert.deepEqual(readSessionEvents(projectDir, "session-a", homeDir), [
    { type: "prompt" },
  ]);
  assert.deepEqual(readSessionEvents(projectDir, "session-b", homeDir), [
    { type: "edit" },
  ]);
});

test("a torn final line is dropped instead of poisoning the read", (t) => {
  const projectDir = makeTempDir(t, "stoic-log-");
  const homeDir = makeTempDir(t, "stoic-home-");
  appendSessionEvent(projectDir, SESSION_ID, { type: "prompt" }, homeDir);
  fs.appendFileSync(
    sessionLogPath(projectDir, SESSION_ID, homeDir),
    '{"type":"edi',
    "utf8",
  );

  assert.deepEqual(readSessionEvents(projectDir, SESSION_ID, homeDir), [
    { type: "prompt" },
  ]);
});

test("an append after a torn line corrupts only the merged line", (t) => {
  const projectDir = makeTempDir(t, "stoic-log-");
  const homeDir = makeTempDir(t, "stoic-home-");
  appendSessionEvent(projectDir, SESSION_ID, { type: "prompt" }, homeDir);
  fs.appendFileSync(
    sessionLogPath(projectDir, SESSION_ID, homeDir),
    '{"type":"edi',
    "utf8",
  );
  appendSessionEvent(
    projectDir,
    SESSION_ID,
    { type: "subagent_stop" },
    homeDir,
  );
  appendSessionEvent(projectDir, SESSION_ID, { type: "edit" }, homeDir);

  const events = readSessionEvents(projectDir, SESSION_ID, homeDir);

  assert.deepEqual(events, [{ type: "prompt" }, { type: "edit" }]);
});

test("truncating removes the log so the next read is empty", (t) => {
  const projectDir = makeTempDir(t, "stoic-log-");
  const homeDir = makeTempDir(t, "stoic-home-");
  appendSessionEvent(projectDir, SESSION_ID, { type: "prompt" }, homeDir);

  truncateSessionLog(projectDir, SESSION_ID, homeDir);

  assert.deepEqual(readSessionEvents(projectDir, SESSION_ID, homeDir), []);
  assert.ok(!fs.existsSync(sessionLogPath(projectDir, SESSION_ID, homeDir)));
});

test("truncating a missing log is a silent no-op", (t) => {
  const projectDir = makeTempDir(t, "stoic-log-");
  const homeDir = makeTempDir(t, "stoic-home-");

  truncateSessionLog(projectDir, SESSION_ID, homeDir);

  assert.deepEqual(fs.readdirSync(homeDir), []);
});

test("a failed append never throws into the caller", (t) => {
  const projectDir = makeTempDir(t, "stoic-log-");
  const homeDir = makeTempDir(t, "stoic-home-");
  // A file where the sessions DIRECTORY must go makes every append fail.
  const dir = sessionsDir(projectDir, homeDir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.writeFileSync(dir, "not a directory", "utf8");

  appendSessionEvent(projectDir, SESSION_ID, { type: "prompt" }, homeDir);

  assert.deepEqual(readSessionEvents(projectDir, SESSION_ID, homeDir), []);
});

test("an unserializable event is swallowed, not thrown", (t) => {
  const projectDir = makeTempDir(t, "stoic-log-");
  const homeDir = makeTempDir(t, "stoic-home-");
  const circular = {};
  circular.self = circular;

  appendSessionEvent(projectDir, SESSION_ID, circular, homeDir);

  assert.deepEqual(readSessionEvents(projectDir, SESSION_ID, homeDir), []);
});
