import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  personalStateDir,
  sharedTracePath,
  tracePath,
} from "../../src/io/paths.js";
import {
  TRACE_MAX_BYTES,
  writeLocalTraceLine,
  writeSharedTraceLine,
} from "../../src/io/trace.js";
import { makeTempDir } from "../helpers/temp-dir.js";

/** Read the trace file back as parsed JSON lines. */
function readTraceLines(filePath) {
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line));
}

/** Both trace sinks in fresh directories: the file each owns and its writer. */
function traceSinks(t) {
  const projectDir = makeTempDir(t, "stoic-trace-");
  const homeDir = makeTempDir(t, "stoic-home-");
  return [
    {
      name: "local trace",
      filePath: tracePath(projectDir, homeDir),
      write: (data) => writeLocalTraceLine(projectDir, "Stop", data, homeDir),
    },
    {
      name: "shared trace",
      filePath: sharedTracePath(homeDir),
      write: (data) => writeSharedTraceLine("Stop", data, homeDir),
    },
  ];
}

/** Append lines until the sink's file is at least TRACE_MAX_BYTES long. */
function fillTraceToCap(sink) {
  const filler = "x".repeat(8 * 1024);
  while (
    !fs.existsSync(sink.filePath) ||
    fs.statSync(sink.filePath).size < TRACE_MAX_BYTES
  ) {
    sink.write({ outcome: "noop", filler });
  }
}

test("a trace line records ts, hook, and the outcome data compactly", (t) => {
  const projectDir = makeTempDir(t, "stoic-trace-");
  const homeDir = makeTempDir(t, "stoic-home-");

  writeLocalTraceLine(
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

  writeLocalTraceLine(
    projectDir,
    "UserPromptSubmit",
    { outcome: "logged" },
    homeDir,
  );
  writeLocalTraceLine(projectDir, "Stop", { outcome: "scored" }, homeDir);

  const lines = readTraceLines(tracePath(projectDir, homeDir));
  assert.deepEqual(
    lines.map((line) => line.hook),
    ["UserPromptSubmit", "Stop"],
  );
});

test("the first trace line creates the personal-state directory", (t) => {
  const projectDir = makeTempDir(t, "stoic-trace-");
  const homeDir = makeTempDir(t, "stoic-home-");

  writeLocalTraceLine(projectDir, "Stop", { outcome: "noop" }, homeDir);

  assert.ok(fs.existsSync(personalStateDir(projectDir, homeDir)));
});

test("passing the size cap rotates each sink once and starts a fresh trace", (t) => {
  for (const sink of traceSinks(t)) {
    fillTraceToCap(sink);
    const fullSize = fs.statSync(sink.filePath).size;

    sink.write({ outcome: "after-cap" });

    assert.equal(fs.statSync(`${sink.filePath}.1`).size, fullSize, sink.name);
    const lines = readTraceLines(sink.filePath);
    assert.equal(lines.length, 1, sink.name);
    assert.equal(lines[0].outcome, "after-cap", sink.name);
  }
});

test("a second rotation replaces each sink's old generation instead of adding one", (t) => {
  for (const sink of traceSinks(t)) {
    fillTraceToCap(sink);
    sink.write({ outcome: "first-rotation" });
    fillTraceToCap(sink);

    sink.write({ outcome: "second-rotation" });

    // Both sinks may share a directory, so only this sink's own names count.
    const fileName = path.basename(sink.filePath);
    const generations = fs
      .readdirSync(path.dirname(sink.filePath))
      .filter((entry) => entry.startsWith(fileName))
      .sort();
    assert.deepEqual(generations, [fileName, `${fileName}.1`], sink.name);
    const rotated = readTraceLines(`${sink.filePath}.1`);
    assert.equal(rotated[0].outcome, "first-rotation", sink.name);
  }
});

test("a shared trace line needs no project and creates the stoic-stack directory", (t) => {
  const homeDir = makeTempDir(t, "stoic-home-");
  const filePath = sharedTracePath(homeDir);
  assert.ok(!fs.existsSync(path.dirname(filePath)));

  writeSharedTraceLine("Stop", { outcome: "no_project_root" }, homeDir);

  const [line] = readTraceLines(filePath);
  assert.equal(line.hook, "Stop");
  assert.equal(line.outcome, "no_project_root");
  assert.equal(typeof line.ts, "number");
});

test("caller data can never override the sink's ts and hook stamps", (t) => {
  const projectDir = makeTempDir(t, "stoic-trace-");
  const homeDir = makeTempDir(t, "stoic-home-");

  writeLocalTraceLine(
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

  writeLocalTraceLine(projectDir, "Stop", { outcome: "noop" }, homeDir);
});

test("unserializable outcome data is swallowed, not thrown", (t) => {
  const projectDir = makeTempDir(t, "stoic-trace-");
  const homeDir = makeTempDir(t, "stoic-home-");
  const circular = {};
  circular.self = circular;

  writeLocalTraceLine(projectDir, "Stop", circular, homeDir);

  assert.ok(!fs.existsSync(tracePath(projectDir, homeDir)));
});
