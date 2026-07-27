// Hook registration — the manifest Claude Code actually reads.
//
// `hooks/hooks.json` is the one file nothing else in the suite exercises: a
// typo there is invisible to every other test and fatal in the field, because
// the plugin simply never runs. So this suite treats the manifest as a
// contract with the filesystem and with the trace sink: every registered
// command must point at an entrypoint that exists, and each entrypoint must
// label its trace lines with the event name it was registered under — the
// property `payloads.md` states as "`hook` is the name registered in
// hooks/hooks.json".
//
// Deliberately absent: an assertion that ONLY these events are registered.
// `Stop` joins the manifest with the scoring hook, and a test that has to be
// edited to add a hook it already accepts would be a speed bump, not a check.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { readTrace, runHook } from "../helpers/capture-hook.js";
import { createSandbox } from "../helpers/sandbox.js";

const PLUGIN_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The command form every hook is registered with, and what it must contain. */
const COMMAND_PATTERN =
  /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/(src\/hooks\/[a-z-]+\.js)"$/;

const manifest = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf8"),
);

/** Every registered entry, flattened to one row per command. */
function registrations() {
  const rows = [];
  for (const [event, matchers] of Object.entries(manifest.hooks)) {
    for (const matcher of matchers) {
      for (const entry of matcher.hooks) {
        rows.push({ event, matcher: matcher.matcher, entry });
      }
    }
  }
  return rows;
}

/** The entrypoint file name (`user-prompt-submit`) a command runs. */
const entrypointOf = (command) =>
  path.basename(COMMAND_PATTERN.exec(command)[1], ".js");

test("the four capture hooks are registered", () => {
  const events = registrations().map((row) => row.event);
  for (const event of [
    "UserPromptSubmit",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
  ]) {
    assert.ok(events.includes(event), `${event} is not registered`);
  }
});

test("PostToolUse observes only the tools that write files", () => {
  const [postToolUse] = manifest.hooks.PostToolUse;

  assert.equal(postToolUse.matcher, "Edit|MultiEdit|Write");
});

test("every registration runs an entrypoint that exists", () => {
  for (const { event, entry } of registrations()) {
    assert.equal(entry.type, "command", `${event} must run a command`);
    const match = COMMAND_PATTERN.exec(entry.command);
    assert.ok(match, `${event} runs an unexpected command: ${entry.command}`);
    assert.ok(
      fs.existsSync(path.join(PLUGIN_ROOT, match[1])),
      `${event} points at a missing entrypoint: ${match[1]}`,
    );
  }
});

test("each entrypoint traces under the event name it is registered as", (t) => {
  for (const { event, entry } of registrations()) {
    const sandbox = createSandbox(t);

    // Malformed stdin is the one payload every hook answers identically, which
    // makes it the cheapest way to ask an entrypoint what it calls itself.
    const run = runHook(sandbox, entrypointOf(entry.command), "not json");

    assert.equal(run.status, 0, `${event} exited non-zero:\n${run.stderr}`);
    const trace = readTrace(sandbox);
    assert.equal(trace.length, 1, `${event} wrote ${trace.length} trace lines`);
    assert.equal(trace[0].hook, event);
  }
});
