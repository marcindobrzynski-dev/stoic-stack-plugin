// The PostToolUse capture hook, driven as a real child process.
//
// This hook carries the most rules of the four: it must record edit volume,
// attribute delegation per event, and refuse to observe the plugin's own
// bookkeeping. The self-instrumentation drops (`.stoic/`, outside the project)
// are correctness conditions from the architecture, not optimizations, so they
// are asserted as behavior rather than left to a code comment.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { saveConfig } from "../../src/io/config.js";
import { projectConfigPath } from "../../src/io/paths.js";
import {
  readEvents,
  readTrace,
  runHook,
  soleTraceOutcome,
} from "../helpers/capture-hook.js";
import { createSandbox } from "../helpers/sandbox.js";

const HOOK = "post-tool-use";
const SESSION_ID = "session-abc-123";

/** A two-added, one-removed patch — the Edit / MultiEdit response shape. */
const PATCH_RESPONSE = {
  structuredPatch: [
    {
      lines: [" unchanged", "+added one", "+added two", "-removed one"],
    },
  ],
};

/** A complete, valid PostToolUse payload; override one field per case. */
const payload = (overrides = {}) => ({
  session_id: SESSION_ID,
  tool_name: "Edit",
  tool_input: { file_path: "src/io/paths.js" },
  tool_response: PATCH_RESPONSE,
  permission_mode: "default",
  ...overrides,
});

/** Every capture hook is silent and successful, whatever it decided. */
function assertSilentSuccess(run) {
  assert.equal(run.status, 0, `expected exit 0, stderr:\n${run.stderr}`);
  assert.equal(run.stdout, "", "capture hooks must never write to stdout");
}

test("an edit is logged with its file and line counts", (t) => {
  const sandbox = createSandbox(t);

  const run = runHook(
    sandbox,
    HOOK,
    payload({ cwd: sandbox.projectDir, permission_mode: "acceptEdits" }),
  );

  assertSilentSuccess(run);
  const events = readEvents(sandbox, SESSION_ID);
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.type, "edit");
  assert.equal(event.file, "src/io/paths.js");
  assert.equal(event.lines_added, 2);
  assert.equal(event.lines_removed, 1);
  assert.equal(event.permission_mode, "acceptEdits");
  assert.ok(Number.isFinite(event.ts) && event.ts > 0);
  assert.equal(soleTraceOutcome(sandbox), "logged");
});

test("the edit event matches the frozen field contract, key order included", (t) => {
  const sandbox = createSandbox(t);

  runHook(sandbox, HOOK, payload({ cwd: sandbox.projectDir }));

  const [event] = readEvents(sandbox, SESSION_ID);
  assert.deepEqual(Object.keys(event), [
    "type",
    "ts",
    "file",
    "lines_added",
    "lines_removed",
    "permission_mode",
    "delegated",
    "agent_type",
  ]);
});

test("an edit the user made carries both delegation fields, unset", (t) => {
  const sandbox = createSandbox(t);

  runHook(sandbox, HOOK, payload({ cwd: sandbox.projectDir }));

  const [event] = readEvents(sandbox, SESSION_ID);
  assert.equal(event.delegated, false);
  assert.equal(event.agent_type, null);
});

test("an edit carrying an agent id is attributed to that sub-agent", (t) => {
  const sandbox = createSandbox(t);

  runHook(
    sandbox,
    HOOK,
    payload({
      cwd: sandbox.projectDir,
      agent_id: "agent-7",
      agent_type: "general-purpose",
    }),
  );

  const [event] = readEvents(sandbox, SESSION_ID);
  assert.equal(event.delegated, true);
  assert.equal(event.agent_type, "general-purpose");
});

test("a delegated edit of unknown type is still marked delegated", (t) => {
  const sandbox = createSandbox(t);

  runHook(sandbox, HOOK, payload({ cwd: sandbox.projectDir, agent_id: "a-7" }));

  const [event] = readEvents(sandbox, SESSION_ID);
  assert.equal(event.delegated, true);
  assert.equal(event.agent_type, null);
});

test("a whole-file write is measured from the response it carries", (t) => {
  const sandbox = createSandbox(t);

  runHook(
    sandbox,
    HOOK,
    payload({
      cwd: sandbox.projectDir,
      tool_name: "Write",
      tool_input: { file_path: "notes.md" },
      tool_response: { type: "create", content: "one\ntwo\nthree\n" },
    }),
  );

  const [event] = readEvents(sandbox, SESSION_ID);
  assert.equal(event.file, "notes.md");
  assert.equal(event.lines_added, 3);
  assert.equal(event.lines_removed, 0);
});

test("an absolute path inside the project is stored project-relative", (t) => {
  const sandbox = createSandbox(t);

  runHook(
    sandbox,
    HOOK,
    payload({
      cwd: sandbox.projectDir,
      tool_input: {
        file_path: path.join(sandbox.projectDir, "src", "core", "prompts.js"),
      },
    }),
  );

  const [event] = readEvents(sandbox, SESSION_ID);
  assert.equal(event.file, "src/core/prompts.js");
});

test("a response carrying no usable diff still records the edit", (t) => {
  const sandbox = createSandbox(t);

  runHook(
    sandbox,
    HOOK,
    payload({ cwd: sandbox.projectDir, tool_response: { ok: true } }),
  );

  const [event] = readEvents(sandbox, SESSION_ID);
  assert.equal(event.lines_added, 0);
  assert.equal(event.lines_removed, 0);
  assert.equal(soleTraceOutcome(sandbox), "logged");
});

test("the plugin's own bookkeeping is never observed", (t) => {
  const sandbox = createSandbox(t);

  const run = runHook(
    sandbox,
    HOOK,
    payload({
      cwd: sandbox.projectDir,
      tool_input: { file_path: ".stoic/config.json" },
    }),
  );

  assertSilentSuccess(run);
  assert.deepEqual(readEvents(sandbox, SESSION_ID), []);
  assert.equal(soleTraceOutcome(sandbox), "dropped");
});

// On Windows `.STOIC` and `.stoic` name one directory, so a case-sensitive
// drop would let the plugin observe its own bookkeeping through a differently
// cased path. On POSIX they are two directories and only ours is dropped.
test(
  "on Windows the plugin's directory is dropped whatever its casing",
  { skip: process.platform !== "win32" },
  (t) => {
    const sandbox = createSandbox(t);

    runHook(
      sandbox,
      HOOK,
      payload({
        cwd: sandbox.projectDir,
        tool_input: { file_path: ".STOIC/config.json" },
      }),
    );

    assert.deepEqual(readEvents(sandbox, SESSION_ID), []);
    assert.equal(soleTraceOutcome(sandbox), "dropped");
  },
);

test("an edit outside the project is not this project's turn", (t) => {
  const sandbox = createSandbox(t);

  const run = runHook(
    sandbox,
    HOOK,
    payload({
      cwd: sandbox.projectDir,
      tool_input: { file_path: path.join(sandbox.homeDir, "elsewhere.js") },
    }),
  );

  assertSilentSuccess(run);
  assert.deepEqual(readEvents(sandbox, SESSION_ID), []);
  assert.equal(soleTraceOutcome(sandbox), "dropped");
});

test("a traversing relative path cannot escape the project either", (t) => {
  const sandbox = createSandbox(t);

  runHook(
    sandbox,
    HOOK,
    payload({
      cwd: sandbox.projectDir,
      tool_input: { file_path: "../elsewhere.js" },
    }),
  );

  assert.deepEqual(readEvents(sandbox, SESSION_ID), []);
  assert.equal(soleTraceOutcome(sandbox), "dropped");
});

test("an edit with no file path has nothing to record", (t) => {
  const sandbox = createSandbox(t);

  const run = runHook(
    sandbox,
    HOOK,
    payload({ cwd: sandbox.projectDir, tool_input: {} }),
  );

  assertSilentSuccess(run);
  assert.deepEqual(readEvents(sandbox, SESSION_ID), []);
  assert.equal(soleTraceOutcome(sandbox), "dropped");
});

test("a payload missing its tool input costs the event, not the turn", (t) => {
  const sandbox = createSandbox(t);

  const run = runHook(sandbox, HOOK, {
    session_id: SESSION_ID,
    tool_name: "Edit",
    cwd: sandbox.projectDir,
  });

  assertSilentSuccess(run);
  assert.deepEqual(readEvents(sandbox, SESSION_ID), []);
  assert.equal(soleTraceOutcome(sandbox), "dropped");
});

test("non-JSON stdin costs the event, not the turn", (t) => {
  const sandbox = createSandbox(t);

  const run = runHook(sandbox, HOOK, "not json at all");

  assertSilentSuccess(run);
  assert.deepEqual(readEvents(sandbox, SESSION_ID), []);
  assert.equal(soleTraceOutcome(sandbox), "malformed_input");
});

test("JSON that is not a payload object is malformed too", (t) => {
  const sandbox = createSandbox(t);

  const run = runHook(sandbox, HOOK, "[1, 2, 3]");

  assertSilentSuccess(run);
  assert.deepEqual(readEvents(sandbox, SESSION_ID), []);
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
    assert.equal(line.hook, "PostToolUse");
    assert.ok(Number.isFinite(line.ts));
    assert.equal(typeof line.outcome, "string");
  }
});
