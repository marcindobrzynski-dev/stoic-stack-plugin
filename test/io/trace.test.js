import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { personalStateDir, tracePath } from "../../src/io/paths.js";
import { TRACE_MAX_BYTES, writeTraceLine } from "../../src/io/trace.js";
import { makeTempDir } from "../helpers/temp-dir.js";

/** Read the trace file back as parsed JSON lines. */
function readTraceLines(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

/** Append lines until the trace file is at least TRACE_MAX_BYTES long. */
function fillTraceToCap(projectDir, homeDir) {
  const filePath = tracePath(projectDir, homeDir);
  const filler = "x".repeat(8 * 1024);
  while (
    !fs.existsSync(filePath) ||
    fs.statSync(filePath).size < TRACE_MAX_BYTES
  ) {
    writeTraceLine(projectDir, "Stop", { outcome: "noop", filler }, homeDir);
  }
}

test("a trace line records ts, hook, and the outcome data compactly", (t) => {
  const projectDir = makeTempDir(t, "stoic-trace-");
  const homeDir = makeTempDir(t, "stoic-home-");

  writeTraceLine(
    projectDir,
    "UserPromptSubmit",
    { outcome: "logged" },
    homeDir,
  );

  const raw = fs.readFileSync(tracePath(projectDir, homeDir), "utf8");
  assert.equal(raw.split("\n").length, 2); // one compact line, one trailing \n
  const [line] = readTraceLines(tracePath(projectDir, homeDir));
  assert.equal(line.hook, "UserPromptSubmit");
  assert.equal(line.outcome, "logged");
  assert.equal(typeof line.ts, "number");
});

test("trace lines accumulate in invocation order", (t) => {
  const projectDir = makeTempDir(t, "stoic-trace-");
  const homeDir = makeTempDir(t, "stoic-home-");

  writeTraceLine(
    projectDir,
    "UserPromptSubmit",
    { outcome: "logged" },
    homeDir,
  );
  writeTraceLine(projectDir, "Stop", { outcome: "scored" }, homeDir);

  const lines = readTraceLines(tracePath(projectDir, homeDir));
  assert.deepEqual(
    lines.map((line) => line.hook),
    ["UserPromptSubmit", "Stop"],
  );
});

test("the first trace line creates the personal-state directory", (t) => {
  const projectDir = makeTempDir(t, "stoic-trace-");
  const homeDir = makeTempDir(t, "stoic-home-");

  writeTraceLine(projectDir, "Stop", { outcome: "noop" }, homeDir);

  assert.ok(fs.existsSync(personalStateDir(projectDir, homeDir)));
});

test("passing the size cap rotates once and starts a fresh trace", (t) => {
  const projectDir = makeTempDir(t, "stoic-trace-");
  const homeDir = makeTempDir(t, "stoic-home-");
  const filePath = tracePath(projectDir, homeDir);
  fillTraceToCap(projectDir, homeDir);
  const fullSize = fs.statSync(filePath).size;

  writeTraceLine(projectDir, "Stop", { outcome: "after-cap" }, homeDir);

  assert.equal(fs.statSync(`${filePath}.1`).size, fullSize);
  const lines = readTraceLines(filePath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].outcome, "after-cap");
});

test("a second rotation replaces the old generation instead of adding one", (t) => {
  const projectDir = makeTempDir(t, "stoic-trace-");
  const homeDir = makeTempDir(t, "stoic-home-");
  const filePath = tracePath(projectDir, homeDir);
  fillTraceToCap(projectDir, homeDir);
  writeTraceLine(projectDir, "Stop", { outcome: "first-rotation" }, homeDir);
  fillTraceToCap(projectDir, homeDir);

  writeTraceLine(projectDir, "Stop", { outcome: "second-rotation" }, homeDir);

  const stateDir = personalStateDir(projectDir, homeDir);
  assert.deepEqual(fs.readdirSync(stateDir).sort(), [
    "trace.jsonl",
    "trace.jsonl.1",
  ]);
  const rotated = readTraceLines(`${filePath}.1`);
  assert.equal(rotated[0].outcome, "first-rotation");
});

test("caller data can never override the sink's ts and hook stamps", (t) => {
  const projectDir = makeTempDir(t, "stoic-trace-");
  const homeDir = makeTempDir(t, "stoic-home-");

  writeTraceLine(
    projectDir,
    "Stop",
    { outcome: "scored", ts: "forged", hook: "forged" },
    homeDir,
  );

  const [line] = readTraceLines(tracePath(projectDir, homeDir));
  assert.equal(line.hook, "Stop");
  assert.equal(typeof line.ts, "number");
});

test("a failed trace write never throws into the caller", (t) => {
  const projectDir = makeTempDir(t, "stoic-trace-");
  const homeDir = makeTempDir(t, "stoic-home-");
  // A directory where the trace FILE must go makes every append fail.
  fs.mkdirSync(tracePath(projectDir, homeDir), { recursive: true });

  writeTraceLine(projectDir, "Stop", { outcome: "noop" }, homeDir);
});

test("unserializable outcome data is swallowed, not thrown", (t) => {
  const projectDir = makeTempDir(t, "stoic-trace-");
  const homeDir = makeTempDir(t, "stoic-home-");
  const circular = {};
  circular.self = circular;

  writeTraceLine(projectDir, "Stop", circular, homeDir);

  assert.ok(!fs.existsSync(tracePath(projectDir, homeDir)));
});
