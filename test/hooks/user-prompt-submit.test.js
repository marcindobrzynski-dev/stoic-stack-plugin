// The UserPromptSubmit capture hook, driven as a real child process.
//
// Two things are under test and they fail differently: the prompt event's
// SHAPE is a frozen payload contract (assert it byte-for-byte, key order
// included), while its `effort` is an uncalibrated placeholder (assert it
// agrees with `src/core/prompts.js`, never a literal number).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  promptEffort,
  PROMPT_TRUNCATION_CHARS,
} from "../../src/core/prompts.js";
import { saveConfig } from "../../src/io/config.js";
import { projectConfigPath } from "../../src/io/paths.js";
import {
  readEvents,
  readTrace,
  runHook,
  soleTraceOutcome,
} from "../helpers/capture-hook.js";
import { createSandbox } from "../helpers/sandbox.js";

const HOOK = "user-prompt-submit";
const SESSION_ID = "session-abc-123";

/** A complete, valid UserPromptSubmit payload; override one field per case. */
const payload = (overrides = {}) => ({
  session_id: SESSION_ID,
  prompt: "Refactor src/io/paths.js so it always uses path.join",
  permission_mode: "default",
  cwd: overrides.cwd,
  ...overrides,
});

/** Every capture hook is silent and successful, whatever it decided. */
function assertSilentSuccess(run) {
  assert.equal(run.status, 0, `expected exit 0, stderr:\n${run.stderr}`);
  assert.equal(run.stdout, "", "capture hooks must never write to stdout");
}

test("a genuine prompt is logged with write-time effort", (t) => {
  const sandbox = createSandbox(t);
  const prompt = "Refactor src/io/paths.js so it always uses path.join";

  const run = runHook(sandbox, HOOK, {
    session_id: SESSION_ID,
    prompt,
    permission_mode: "acceptEdits",
    cwd: sandbox.projectDir,
  });

  assertSilentSuccess(run);
  const events = readEvents(sandbox, SESSION_ID);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.type, "prompt");
  assert.equal(event.prompt, prompt);
  assert.equal(event.effort, promptEffort(prompt));
  assert.equal(event.permission_mode, "acceptEdits");
  assert.equal(event.neutralized, false);
  assert.ok(Number.isFinite(event.ts) && event.ts > 0);
  assert.equal(soleTraceOutcome(sandbox), "logged");
});

test("the prompt event matches the frozen field contract, key order included", (t) => {
  const sandbox = createSandbox(t);

  runHook(sandbox, HOOK, payload({ cwd: sandbox.projectDir }));

  const [event] = readEvents(sandbox, SESSION_ID);
  assert.deepEqual(Object.keys(event), [
    "type",
    "ts",
    "prompt",
    "effort",
    "permission_mode",
    "neutralized",
  ]);
});

test("a harness-injected notification is neutralized at zero effort", (t) => {
  const sandbox = createSandbox(t);
  const injected = "<task-notification>agent finished</task-notification>";

  runHook(
    sandbox,
    HOOK,
    payload({ prompt: injected, cwd: sandbox.projectDir }),
  );

  const [event] = readEvents(sandbox, SESSION_ID);
  assert.equal(event.neutralized, true);
  assert.equal(event.effort, 0);
  assert.equal(event.prompt, injected);
  assert.equal(soleTraceOutcome(sandbox), "logged");
});

test("the plugin's own skill invocations are never observed", (t) => {
  const sandbox = createSandbox(t);

  const run = runHook(
    sandbox,
    HOOK,
    payload({ prompt: "/stoic-stack:setup", cwd: sandbox.projectDir }),
  );

  assertSilentSuccess(run);
  assert.deepEqual(readEvents(sandbox, SESSION_ID), []);
  assert.equal(soleTraceOutcome(sandbox), "own_prompt_ignored");
});

test("a stored prompt is bounded by the contract's truncation limit", (t) => {
  const sandbox = createSandbox(t);
  const huge = "x".repeat(PROMPT_TRUNCATION_CHARS + 500);

  runHook(sandbox, HOOK, payload({ prompt: huge, cwd: sandbox.projectDir }));

  const [event] = readEvents(sandbox, SESSION_ID);
  assert.equal(event.prompt.length, PROMPT_TRUNCATION_CHARS);
});

test("non-JSON stdin costs the event, not the turn", (t) => {
  const sandbox = createSandbox(t);

  const run = runHook(sandbox, HOOK, "not json at all");

  assertSilentSuccess(run);
  assert.deepEqual(readEvents(sandbox, SESSION_ID), []);
  assert.equal(soleTraceOutcome(sandbox), "malformed_input");
});

test("empty stdin costs the event, not the turn", (t) => {
  const sandbox = createSandbox(t);

  const run = runHook(sandbox, HOOK, "");

  assertSilentSuccess(run);
  assert.deepEqual(readEvents(sandbox, SESSION_ID), []);
  assert.equal(soleTraceOutcome(sandbox), "malformed_input");
});

test("a payload without a session id has nowhere to log", (t) => {
  const sandbox = createSandbox(t);

  const run = runHook(sandbox, HOOK, {
    prompt: "hello",
    cwd: sandbox.projectDir,
  });

  assertSilentSuccess(run);
  assert.equal(soleTraceOutcome(sandbox), "malformed_input");
});

test("STOIC_INTERNAL stops the hook before it reads or writes anything", (t) => {
  const sandbox = createSandbox(t);

  const run = runHook(sandbox, HOOK, payload({ cwd: sandbox.projectDir }), {
    env: { STOIC_INTERNAL: "1" },
  });

  assertSilentSuccess(run);
  assert.deepEqual(readEvents(sandbox, SESSION_ID), []);
  assert.deepEqual(readTrace(sandbox), []);
});

test("a disabled plugin observes nothing", (t) => {
  const sandbox = createSandbox(t);
  saveConfig(sandbox.projectDir, { enabled: false });

  const run = runHook(sandbox, HOOK, payload({ cwd: sandbox.projectDir }));

  assertSilentSuccess(run);
  assert.deepEqual(readEvents(sandbox, SESSION_ID), []);
  assert.equal(soleTraceOutcome(sandbox), "disabled");
});

test("a corrupt config falls back to built-in defaults rather than failing", (t) => {
  const sandbox = createSandbox(t);
  const configPath = projectConfigPath(sandbox.projectDir);
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, "{ this is not json", "utf8");

  const run = runHook(sandbox, HOOK, payload({ cwd: sandbox.projectDir }));

  assertSilentSuccess(run);
  assert.equal(readEvents(sandbox, SESSION_ID).length, 1);
});

test("every invocation appends exactly one trace line", (t) => {
  const sandbox = createSandbox(t);

  runHook(sandbox, HOOK, payload({ cwd: sandbox.projectDir }));
  runHook(sandbox, HOOK, payload({ cwd: sandbox.projectDir }));
  runHook(sandbox, HOOK, "garbage");

  const trace = readTrace(sandbox);
  assert.equal(trace.length, 3);
  for (const line of trace) {
    assert.equal(line.hook, "UserPromptSubmit");
    assert.ok(Number.isFinite(line.ts));
    assert.equal(typeof line.outcome, "string");
  }
});
