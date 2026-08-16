// The SubagentStart / SubagentStop capture hooks, driven as real child
// processes.
//
// These two are the thinnest hooks in the plugin — they record that a
// sub-agent began or ended, and nothing else. Because they are twins, the
// universal capture contract (silence, fail-silence, the internal guard, the
// master switch, one trace line) is asserted once per entrypoint through a
// table rather than written out twice.
import assert from "node:assert/strict";
import { test } from "node:test";

import { saveConfig } from "../../src/io/config/config.js";
import {
  readEvents,
  readTrace,
  runHook,
  soleTraceOutcome,
} from "../helpers/capture-hook.js";
import { createSandbox } from "../helpers/sandbox.js";

const SESSION_ID = "session-abc-123";

/** Entrypoint file name → the event type it appends and the hook it traces. */
const LIFECYCLE_HOOKS = [
  { name: "subagent-start", type: "subagent_start", hook: "SubagentStart" },
  { name: "subagent-stop", type: "subagent_stop", hook: "SubagentStop" },
];

/** A complete, valid sub-agent lifecycle payload; override one field per case. */
const payload = (overrides = {}) => ({
  session_id: SESSION_ID,
  agent_id: "agent-7",
  agent_type: "general-purpose",
  ...overrides,
});

/** Every capture hook is silent and successful, whatever it decided. */
function assertSilentSuccess(run) {
  assert.equal(run.status, 0, `expected exit 0, stderr:\n${run.stderr}`);
  assert.equal(run.stdout, "", "capture hooks must never write to stdout");
}

for (const { name, type, hook } of LIFECYCLE_HOOKS) {
  test(`${name} logs the sub-agent's type`, (t) => {
    const sandbox = createSandbox(t);

    const run = runHook(sandbox, name, payload());

    assertSilentSuccess(run);
    const events = readEvents(sandbox, SESSION_ID);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.type, type);
    assert.equal(event.agent_type, "general-purpose");
    assert.ok(Number.isFinite(event.ts) && event.ts > 0);
    assert.equal(soleTraceOutcome(sandbox), "logged");
  });

  test(`${name} matches the frozen field contract, key order included`, (t) => {
    const sandbox = createSandbox(t);

    runHook(sandbox, name, payload());

    const [event] = readEvents(sandbox, SESSION_ID);
    assert.deepEqual(Object.keys(event), ["type", "ts", "agent_type"]);
  });

  test(`${name} records a sub-agent of unknown type as unknown`, (t) => {
    const sandbox = createSandbox(t);

    runHook(sandbox, name, payload({ agent_type: undefined }));

    const [event] = readEvents(sandbox, SESSION_ID);
    assert.equal(event.agent_type, null);
  });

  test(`${name} costs the event, not the turn, on malformed stdin`, (t) => {
    const sandbox = createSandbox(t);

    const run = runHook(sandbox, name, "not json at all");

    assertSilentSuccess(run);
    assert.deepEqual(readEvents(sandbox, SESSION_ID), []);
    assert.equal(soleTraceOutcome(sandbox), "malformed_input");
  });

  test(`${name} has nowhere to log without a session id`, (t) => {
    const sandbox = createSandbox(t);

    const run = runHook(sandbox, name, payload({ session_id: undefined }));

    assertSilentSuccess(run);
    assert.equal(soleTraceOutcome(sandbox), "malformed_input");
  });

  test(`${name} stops before reading or writing under STOIC_INTERNAL`, (t) => {
    const sandbox = createSandbox(t);

    const run = runHook(sandbox, name, payload(), {
      env: { STOIC_INTERNAL: "1" },
    });

    assertSilentSuccess(run);
    assert.deepEqual(readEvents(sandbox, SESSION_ID), []);
    assert.deepEqual(readTrace(sandbox), []);
  });

  test(`${name} observes nothing when the plugin is disabled`, (t) => {
    const sandbox = createSandbox(t);
    saveConfig(sandbox.projectDir, { enabled: false });

    const run = runHook(sandbox, name, payload());

    assertSilentSuccess(run);
    assert.deepEqual(readEvents(sandbox, SESSION_ID), []);
    assert.equal(soleTraceOutcome(sandbox), "disabled");
  });

  test(`${name} traces itself under its registered hook name`, (t) => {
    const sandbox = createSandbox(t);

    runHook(sandbox, name, payload());

    const trace = readTrace(sandbox);
    assert.equal(trace.length, 1);
    assert.equal(trace[0].hook, hook);
  });
}

test("a start and a stop share one session log, in order", (t) => {
  const sandbox = createSandbox(t);

  runHook(sandbox, "subagent-start", payload());
  runHook(sandbox, "subagent-stop", payload());

  const events = readEvents(sandbox, SESSION_ID);
  assert.deepEqual(
    events.map((event) => event.type),
    ["subagent_start", "subagent_stop"],
  );
});
