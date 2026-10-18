import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { DEFAULT_CLASSIFIER_MODEL } from "../../src/io/config/config.js";
import {
  HEADLESS_MAX_OUTPUT_BYTES,
  HEADLESS_TIMEOUT_MS,
  MODEL_ID_PATTERN,
  SCHEMA_MAX_TURNS,
  buildHeadlessArgs,
  extractFirstJsonObject,
  runClaude,
  spawnAttempts,
} from "../../src/io/headless.js";
import { makeTempDir } from "../helpers/temp-dir.js";

const STUB_PATH = fileURLToPath(
  new URL("../fixtures/stub-claude-cli.js", import.meta.url),
);

const MODEL = "stub-model-1";

/**
 * Build a spawn seam that runs the stub CLI in place of `claude`, recording
 * every cascade attempt. The seam keeps the runner's own options — stdin
 * payload, timeout, buffer cap, child environment — so the real spawn path is
 * what the suite exercises; only the executable is substituted. `shell` is
 * dropped because the substituted command is an absolute Node path that a
 * shell would have to re-quote.
 *
 * @param {import("node:test").TestContext} t - Owning test context.
 * @param {string} scenario - Stub scenario name.
 * @param {{failingAttempts?: number}} [options] - `failingAttempts` makes the
 *   first N attempts fail to launch, standing in for a missing binary name.
 * @returns {{spawn: Function, calls: object[]}} Seam and its recorded calls.
 */
function stubSeam(t, scenario, options = {}) {
  const homeDir = makeTempDir(t, "stoic-headless-home-");
  const workDir = makeTempDir(t, "stoic-headless-work-");
  const failingAttempts = options.failingAttempts ?? 0;
  const calls = [];

  const spawn = (command, args, spawnOptions) => {
    calls.push({ command, args, options: spawnOptions });
    const failing = calls.length <= failingAttempts;
    const executable = failing
      ? path.join(workDir, "definitely-missing-claude-binary")
      : process.execPath;
    const argv = failing ? [] : [STUB_PATH, scenario, ...args];
    const passthrough = { ...spawnOptions };
    delete passthrough.shell;
    return spawnSync(executable, argv, {
      ...passthrough,
      cwd: workDir,
      env: {
        ...spawnOptions.env,
        HOME: homeDir,
        USERPROFILE: homeDir,
        STOIC_TEST_SANDBOX: "1",
      },
    });
  };

  return { spawn, calls };
}

test("a well-formed envelope yields the model's JSON object", (t) => {
  const { spawn } = stubSeam(t, "envelope");

  const result = runClaude("classify this turn", {
    model: MODEL,
    spawn,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.value.received.prompt, "classify this turn");
});

test("the prompt travels on stdin and never on the command line", (t) => {
  const { spawn } = stubSeam(t, "envelope");

  const result = runClaude('a prompt with "quotes" and $(danger)', {
    model: MODEL,
    spawn,
  });

  assert.equal(result.status, "ok");
  assert.equal(
    result.value.received.prompt,
    'a prompt with "quotes" and $(danger)',
  );
  assert.equal(
    result.value.received.args.some((arg) => arg.includes("danger")),
    false,
  );
});

test("only the fixed flags reach the child's command line", (t) => {
  const { spawn } = stubSeam(t, "envelope");

  const result = runClaude("classify this turn", {
    model: MODEL,
    spawn,
  });

  assert.equal(result.status, "ok");
  assert.deepEqual(result.value.received.args, buildHeadlessArgs(MODEL));
  assert.equal(result.value.received.args.includes(MODEL), true);
});

test("a schema call passes the schema flags, disables tools, bounds turns, and keeps the prompt off argv", (t) => {
  const { spawn } = stubSeam(t, "structured_output");
  const jsonSchema = {
    type: "object",
    properties: { schema_version: { type: "integer", const: 3 } },
    required: ["schema_version"],
  };
  const prompt = 'turn text with "quotes" and $(danger)';

  const result = runClaude(prompt, {
    model: MODEL,
    jsonSchema,
    spawn,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.value.received.prompt, prompt);
  assert.deepEqual(
    result.value.received.args,
    buildHeadlessArgs(MODEL, { jsonSchema }),
  );
  assert.deepEqual(result.value.received.args, [
    "-p",
    "--model",
    MODEL,
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(jsonSchema),
    "--tools",
    "",
    "--max-turns",
    String(SCHEMA_MAX_TURNS),
  ]);
  assert.equal(result.value.received.args.includes("--disallowedTools"), false);
  assert.equal(
    result.value.received.args.some((arg) => arg.includes("danger")),
    false,
  );
});

test("an envelope with structured_output and an empty result string yields the structured object", (t) => {
  const { spawn } = stubSeam(t, "structured_output");
  const jsonSchema = { type: "object" };

  const result = runClaude("extract structured state", {
    model: MODEL,
    jsonSchema,
    spawn,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.value.received.prompt, "extract structured state");

  const omittedResult = runClaude("extract structured state", {
    model: MODEL,
    jsonSchema,
    spawn: () => ({
      status: 0,
      stdout: JSON.stringify({
        type: "result",
        structured_output: { schema_version: 3 },
      }),
    }),
  });
  assert.deepEqual(omittedResult, {
    status: "ok",
    value: { schema_version: 3 },
  });

  const emptyBoth = runClaude("extract structured state", {
    model: MODEL,
    jsonSchema,
    spawn: () => ({
      status: 0,
      stdout: JSON.stringify({
        type: "result",
        result: "",
        structured_output: null,
      }),
    }),
  });
  assert.deepEqual(emptyBoth, {
    status: "unavailable",
    reason: "unparseable",
  });
});

test("a schema call refuses the Windows shell strategy instead of putting JSON on a shell command line", (t) => {
  const { spawn, calls } = stubSeam(t, "structured_output", {
    failingAttempts: 2,
  });
  const jsonSchema = {
    type: "object",
    properties: { summary: { type: "string" } },
  };

  const result = runClaude("extract structured state", {
    model: MODEL,
    jsonSchema,
    platform: "win32",
    spawn,
  });

  assert.deepEqual(result, {
    status: "unavailable",
    reason: "json_schema_requires_direct_spawn",
  });
  assert.equal(calls.length, 2);
});

test("the child is marked as the plugin's own internal session", (t) => {
  const { spawn } = stubSeam(t, "envelope");

  const result = runClaude("classify this turn", {
    model: MODEL,
    spawn,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.value.received.stoic_internal, "1");
});

test("the default bounds are the module's timeout and output constants", (t) => {
  const { spawn, calls } = stubSeam(t, "envelope");

  runClaude("classify this turn", { model: MODEL, spawn });

  assert.equal(calls[0].options.timeout, HEADLESS_TIMEOUT_MS);
  assert.equal(calls[0].options.maxBuffer, HEADLESS_MAX_OUTPUT_BYTES);
  assert.equal(Number.isFinite(HEADLESS_TIMEOUT_MS), true);
  assert.equal(HEADLESS_TIMEOUT_MS > 0, true);
  assert.equal(HEADLESS_MAX_OUTPUT_BYTES > 0, true);
});

test("JSON wrapped in prose and fences is still extracted", (t) => {
  const { spawn } = stubSeam(t, "prose");

  const result = runClaude("classify this turn", {
    model: MODEL,
    spawn,
  });

  assert.equal(result.status, "ok");
  assert.equal(result.value.received.stoic_internal, "1");
});

test("an envelope behind CLI banner noise is still unwrapped", (t) => {
  const { spawn } = stubSeam(t, "banner");

  const result = runClaude("classify this turn", {
    model: MODEL,
    spawn,
  });

  assert.equal(result.status, "ok");
});

test("model text without a JSON object is unavailable", (t) => {
  const { spawn } = stubSeam(t, "malformed-result");

  const result = runClaude("classify this turn", {
    model: MODEL,
    spawn,
  });

  assert.deepEqual(result, { status: "unavailable", reason: "unparseable" });
});

test("output that is not an envelope at all is unavailable", (t) => {
  const { spawn } = stubSeam(t, "malformed-envelope");

  const result = runClaude("classify this turn", {
    model: MODEL,
    spawn,
  });

  assert.deepEqual(result, { status: "unavailable", reason: "unparseable" });
});

test("an envelope without result text is unavailable", (t) => {
  const { spawn } = stubSeam(t, "resultless-envelope");

  const result = runClaude("classify this turn", {
    model: MODEL,
    spawn,
  });

  assert.deepEqual(result, { status: "unavailable", reason: "unparseable" });
});

test("a CLI that ran and exited non-zero ends the cascade", (t) => {
  const { spawn, calls } = stubSeam(t, "nonzero");

  const result = runClaude("classify this turn", {
    model: MODEL,
    spawn,
  });

  assert.deepEqual(result, { status: "unavailable", reason: "cli_failed" });
  assert.equal(calls.length, 1);
});

test("a child that hangs past the timeout is unavailable", (t) => {
  const { spawn, calls } = stubSeam(t, "hang");

  const result = runClaude("classify this turn", {
    model: MODEL,
    spawn,
    timeoutMs: 400,
  });

  assert.deepEqual(result, { status: "unavailable", reason: "timeout" });
  assert.equal(calls.length, 1);
});

test("output past the buffer cap is unavailable", (t) => {
  const { spawn, calls } = stubSeam(t, "oversized");

  const result = runClaude("classify this turn", {
    model: MODEL,
    spawn,
    maxOutputBytes: 4096,
  });

  assert.deepEqual(result, {
    status: "unavailable",
    reason: "output_too_large",
  });
  assert.equal(calls.length, 1);
});

test("a missing executable exhausts the cascade and is unavailable", (t) => {
  const { spawn, calls } = stubSeam(t, "envelope", { failingAttempts: 99 });

  const result = runClaude("classify this turn", {
    model: MODEL,
    spawn,
  });

  assert.deepEqual(result, { status: "unavailable", reason: "spawn_failed" });
  assert.equal(calls.length, spawnAttempts(process.platform).length);
});

test("a launch failure advances the cascade to the next strategy", (t) => {
  const attempts = spawnAttempts(process.platform).length;
  const { spawn, calls } = stubSeam(t, "envelope", {
    failingAttempts: attempts - 1,
  });

  const result = runClaude("classify this turn", {
    model: MODEL,
    spawn,
  });

  assert.equal(result.status, "ok");
  assert.equal(calls.length, attempts);
});

test("Windows cascades three spawn strategies, other platforms one", () => {
  assert.deepEqual(spawnAttempts("win32"), [
    { command: "claude", shell: false },
    { command: "claude.cmd", shell: false },
    { command: "claude", shell: true },
  ]);
  assert.deepEqual(spawnAttempts("darwin"), [
    { command: "claude", shell: false },
  ]);
  assert.deepEqual(spawnAttempts("linux"), [
    { command: "claude", shell: false },
  ]);
});

test("a throwing spawn seam never escapes as an exception", () => {
  const result = runClaude("classify this turn", {
    model: MODEL,
    spawn() {
      throw new Error("seam exploded");
    },
  });

  assert.deepEqual(result, { status: "unavailable", reason: "spawn_failed" });
});

test("a seam returning nonsense is unavailable", () => {
  const result = runClaude("classify this turn", {
    model: MODEL,
    spawn: () => null,
  });

  assert.deepEqual(result, { status: "unavailable", reason: "spawn_failed" });
});

test("a missing prompt or model is unavailable without spawning", () => {
  const calls = [];
  const spawn = (...args) => {
    calls.push(args);
    return { status: 0, stdout: "" };
  };

  assert.deepEqual(runClaude("", { model: MODEL, spawn }), {
    status: "unavailable",
    reason: "invalid_request",
  });
  assert.deepEqual(runClaude("prompt", { model: "", spawn }), {
    status: "unavailable",
    reason: "invalid_request",
  });
  assert.deepEqual(runClaude(undefined, { model: MODEL, spawn }), {
    status: "unavailable",
    reason: "invalid_request",
  });
  assert.equal(calls.length, 0);
});

test("a model id outside the safe pattern is unavailable without spawning", () => {
  const calls = [];
  const spawn = (...args) => {
    calls.push(args);
    return { status: 0, stdout: "" };
  };

  // The last Windows strategy spawns through a shell, so a model id carrying
  // shell metacharacters must be rejected before any spawn is attempted.
  for (const model of [
    "haiku & calc.exe",
    "haiku; rm -rf /",
    'haiku" | evil',
    "haiku`whoami`",
    "haiku model",
  ]) {
    assert.deepEqual(runClaude("prompt", { model, spawn }), {
      status: "unavailable",
      reason: "invalid_request",
    });
  }
  assert.equal(calls.length, 0);

  assert.ok(MODEL_ID_PATTERN.test(DEFAULT_CLASSIFIER_MODEL));
  assert.ok(MODEL_ID_PATTERN.test("us.anthropic.claude-3:v1"));
});

test("hostile input never throws across the module boundary", () => {
  assert.doesNotThrow(() => runClaude(null));
  assert.doesNotThrow(() => runClaude({}, null));
  assert.doesNotThrow(() => runClaude("prompt", { spawn: 7 }));
});

test("balanced extraction tolerates braces and escapes inside strings", () => {
  assert.deepEqual(extractFirstJsonObject('prefix {"a":"}{\\"x\\""} suffix'), {
    a: '}{"x"',
  });
  assert.deepEqual(extractFirstJsonObject('{"a":{"b":1}}'), { a: { b: 1 } });
  assert.equal(extractFirstJsonObject("no object here"), null);
  assert.equal(extractFirstJsonObject('{"a":'), null);
  assert.equal(extractFirstJsonObject("{oops}"), null);
  assert.equal(extractFirstJsonObject(null), null);
});

test("balanced extraction skips a non-JSON braced region before the object", () => {
  assert.deepEqual(
    extractFirstJsonObject('I will tag it {like so}: {"decision_found":true}'),
    { decision_found: true },
  );
  assert.deepEqual(extractFirstJsonObject('{1} {[2]} {"a":3}'), { a: 3 });
  assert.equal(extractFirstJsonObject("{not json} {still not json}"), null);
});
