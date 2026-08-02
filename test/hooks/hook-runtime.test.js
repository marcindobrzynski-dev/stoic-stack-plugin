// The shared hook chores — unit tests for the half integration cannot reach.
//
// `readHookPayload` is deliberately absent from this file. Every branch it has
// (unreadable fd 0, non-JSON text, a non-object, an object with no session id)
// is already pinned by the real-hook suites, which spawn the actual
// entrypoints and assert the `malformed_input` trace line those branches
// produce — `stop.test.js`, `user-prompt-submit.test.js`, `post-tool-use.js`
// and `subagent-lifecycle.test.js`. Re-asserting it here would test the same
// behavior through a weaker seam, and reading fd 0 in-process would fight the
// test runner for the same file descriptor.
//
// `traceErrorMessage` is the opposite case: it only runs when a module that
// swallows its own failures throws anyway, so no integration test can reach it
// without simulating a bug. Its promise — one line, at most 200 characters,
// from ANY thrown value — is what keeps that trace line greppable.
import assert from "node:assert/strict";
import { test } from "node:test";

import { traceErrorMessage } from "../../src/hooks/hook-runtime.js";

test("an Error is reduced to its message", () => {
  assert.equal(
    traceErrorMessage(new Error("EACCES: permission denied")),
    "EACCES: permission denied",
  );
});

test("a thrown non-Error is stringified", () => {
  assert.equal(traceErrorMessage("plain string throw"), "plain string throw");
  assert.equal(traceErrorMessage(42), "42");
  assert.equal(traceErrorMessage(undefined), "undefined");
  assert.equal(traceErrorMessage(null), "null");
});

test("only the first line survives, so one throw is one trace line", () => {
  const error = new Error("first line\n    at somewhere\n    at elsewhere");

  assert.equal(traceErrorMessage(error), "first line");
});

test("a stack-carrying throw cannot smuggle newlines through the message", () => {
  // A real Error's `stack` holds newlines; only `message` is ever read, and it
  // is split anyway. Both together are what keeps trace.jsonl one-line-per-row.
  const error = new Error("boom");

  assert.equal(traceErrorMessage(error).includes("\n"), false);
});

test("the message is capped at 200 characters", () => {
  const long = traceErrorMessage(new Error("x".repeat(5000)));

  assert.equal(long.length, 200);
  assert.equal(long, "x".repeat(200));
});

test("the cap applies to the first line, not to the whole value", () => {
  const error = new Error(`${"a".repeat(300)}\n${"b".repeat(300)}`);
  const line = traceErrorMessage(error);

  assert.equal(line, "a".repeat(200));
});

test("an object with a message field is read like an Error", () => {
  // Anything can be thrown; the duck-typed `message` read is the reason a
  // rejected promise or a custom error class traces usefully too.
  assert.equal(
    traceErrorMessage({ message: "custom failure" }),
    "custom failure",
  );
});
