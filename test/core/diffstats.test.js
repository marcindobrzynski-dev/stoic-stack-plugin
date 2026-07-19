import assert from "node:assert/strict";
import { test } from "node:test";

import { extractDiffStats, lineCount } from "../../src/core/diffstats.js";

/** A structuredPatch hunk with the given diff lines. */
function hunk(lines) {
  return { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines };
}

// ---------------------------------------------------------------------------
// extractDiffStats — one branch per frozen tool_response shape.
// ---------------------------------------------------------------------------

test("an Edit response counts added and removed lines from its patch", () => {
  const stats = extractDiffStats({
    structuredPatch: [
      hunk(["-const a = 1;", "+const a = 2;", "+const b = 3;"]),
    ],
  });
  assert.deepEqual(stats, { linesAdded: 2, linesRemoved: 1 });
});

test("a MultiEdit response sums every hunk of its patch", () => {
  const stats = extractDiffStats({
    structuredPatch: [
      hunk(["+first addition", " context line"]),
      hunk(["-gone", "-also gone", "+replacement"]),
    ],
  });
  assert.deepEqual(stats, { linesAdded: 2, linesRemoved: 2 });
});

test("patch context lines are never counted as changes", () => {
  const stats = extractDiffStats({
    structuredPatch: [hunk([" unchanged", " also unchanged"])],
  });
  assert.deepEqual(stats, { linesAdded: 0, linesRemoved: 0 });
});

test("a Write creating a file counts every content line as added", () => {
  const stats = extractDiffStats({
    type: "create",
    filePath: "src/new.js",
    content: "line one\nline two\nline three\n",
  });
  assert.deepEqual(stats, { linesAdded: 3, linesRemoved: 0 });
});

test("a full-file rewrite is approximated as replacing the whole file", () => {
  const stats = extractDiffStats({
    filePath: "src/x.js",
    originalFile: "old one\nold two\n",
    content: "new one\nnew two\nnew three\n",
  });
  assert.deepEqual(stats, { linesAdded: 3, linesRemoved: 2 });
});

test("a patch takes precedence over rewrite fields on the same response", () => {
  const stats = extractDiffStats({
    structuredPatch: [hunk(["+only this counts"])],
    originalFile: "a\nb\nc\n",
    content: "a\nb\nc\nd\n",
  });
  assert.deepEqual(stats, { linesAdded: 1, linesRemoved: 0 });
});

test("responses carrying no usable diff extract as zeros", () => {
  const shapes = [
    undefined,
    null,
    "plain string result",
    42,
    {},
    { content: "content without originalFile or create marker\n" },
    { filePath: "src/x.js" },
  ];
  for (const shape of shapes) {
    assert.deepEqual(
      extractDiffStats(shape),
      { linesAdded: 0, linesRemoved: 0 },
      `expected zeros for: ${JSON.stringify(shape)}`,
    );
  }
});

test("malformed patch entries are skipped without poisoning the total", () => {
  const stats = extractDiffStats({
    structuredPatch: [
      null,
      "not a hunk",
      { lines: "not an array" },
      hunk([42, null, "+counted", "-counted too"]),
    ],
  });
  assert.deepEqual(stats, { linesAdded: 1, linesRemoved: 1 });
});

// ---------------------------------------------------------------------------
// lineCount — the shared line-counting rule.
// ---------------------------------------------------------------------------

test("line counting ignores exactly one trailing newline", () => {
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("a"), 1);
  assert.equal(lineCount("a\n"), 1);
  assert.equal(lineCount("a\r\n"), 1);
  assert.equal(lineCount("a\nb"), 2);
  assert.equal(lineCount("a\nb\n"), 2);
  assert.equal(lineCount("a\n\n"), 2);
  assert.equal(lineCount("\n"), 1);
});

test("non-string content counts as zero lines", () => {
  assert.equal(lineCount(undefined), 0);
  assert.equal(lineCount(null), 0);
  assert.equal(lineCount(42), 0);
});
