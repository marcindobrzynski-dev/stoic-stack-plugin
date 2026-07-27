import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTO_ACCEPT_PERMISSION_MODES,
  buildTurnGroup,
} from "../../src/core/group.js";

/** A prompt event as `user-prompt-submit.js` writes it. */
function promptEvent(overrides = {}) {
  return {
    type: "prompt",
    ts: 1_000,
    prompt: "do the thing",
    effort: 0,
    permission_mode: "default",
    neutralized: false,
    ...overrides,
  };
}

/** An edit event as `post-tool-use.js` writes it. */
function editEvent(overrides = {}) {
  return {
    type: "edit",
    ts: 2_000,
    file: "src/x.js",
    lines_added: 0,
    lines_removed: 0,
    permission_mode: "default",
    delegated: false,
    agent_type: null,
    ...overrides,
  };
}

/** Assert a mean that does not divide evenly, without pinning float noise. */
function assertClose(actual, expected) {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `expected ${actual} to be within 1e-9 of ${expected}`,
  );
}

// ---------------------------------------------------------------------------
// The prompt: joined text, mean effort, and what "neutralized" does to both.
// ---------------------------------------------------------------------------

test("a single-prompt turn carries its text and its write-time effort", () => {
  const group = buildTurnGroup([
    promptEvent({ prompt: "refactor src/io/paths.js", effort: -0.5 }),
  ]);
  assert.equal(group.prompt, "refactor src/io/paths.js");
  assert.equal(group.prompt_effort, -0.5);
  assert.equal(group.genuine_prompt_count, 1);
  assert.equal(group.prompt_neutralized, false);
});

test("a multi-prompt turn averages effort over its genuine prompts", () => {
  const group = buildTurnGroup([
    promptEvent({ prompt: "first", effort: 0.5 }),
    editEvent(),
    promptEvent({ prompt: "second", effort: -0.5 }),
    promptEvent({ prompt: "third", effort: 0.75 }),
  ]);
  assertClose(group.prompt_effort, 0.25);
  assert.equal(group.genuine_prompt_count, 3);
});

test("a multi-prompt turn joins its genuine prompts in submission order", () => {
  const group = buildTurnGroup([
    promptEvent({ prompt: "first", ts: 1 }),
    promptEvent({ prompt: "second", ts: 2 }),
  ]);
  assert.equal(group.prompt, "first\n\nsecond");
});

test("neutralized prompts leave the mean and the joined text alone", () => {
  const group = buildTurnGroup([
    promptEvent({ prompt: "typed by hand", effort: -0.4 }),
    promptEvent({
      prompt: "<task-notification>agent finished</task-notification>",
      effort: 0,
      neutralized: true,
    }),
  ]);
  assert.equal(group.prompt, "typed by hand");
  assert.equal(group.prompt_effort, -0.4);
  assert.equal(group.genuine_prompt_count, 1);
  assert.equal(group.neutralized_prompt_count, 1);
  assert.equal(group.prompt_neutralized, false);
});

test("a turn of only neutralized prompts scores zero effort but still happened", () => {
  const group = buildTurnGroup([
    promptEvent({
      prompt: "<task-notification>one</task-notification>",
      neutralized: true,
    }),
    promptEvent({
      prompt: "<task-notification>two</task-notification>",
      neutralized: true,
    }),
  ]);
  assert.equal(group.prompt, "");
  assert.equal(group.prompt_effort, 0);
  assert.equal(group.genuine_prompt_count, 0);
  assert.equal(group.neutralized_prompt_count, 2);
  assert.equal(group.prompt_neutralized, true);
});

test("a turn with no prompt at all is not a neutralized turn", () => {
  const group = buildTurnGroup([editEvent()]);
  assert.equal(group.prompt, "");
  assert.equal(group.prompt_effort, 0);
  assert.equal(group.genuine_prompt_count, 0);
  assert.equal(group.neutralized_prompt_count, 0);
  assert.equal(group.prompt_neutralized, false);
});

test("a hand-edited effort outside the signal range is clamped", () => {
  const group = buildTurnGroup([
    promptEvent({ effort: 99 }),
    promptEvent({ effort: -99 }),
  ]);
  assert.equal(group.prompt_effort, 0);

  const single = buildTurnGroup([promptEvent({ effort: 42 })]);
  assert.equal(single.prompt_effort, 1);
});

test("a prompt whose effort is unusable counts as zero without dropping the prompt", () => {
  const group = buildTurnGroup([
    promptEvent({ prompt: "measured", effort: 1 }),
    promptEvent({ prompt: "unmeasured", effort: "not a number" }),
  ]);
  assert.equal(group.prompt, "measured\n\nunmeasured");
  assert.equal(group.genuine_prompt_count, 2);
  assert.equal(group.prompt_effort, 0.5);
});

// ---------------------------------------------------------------------------
// Question relief — read from the stored text, never from a logged flag.
// ---------------------------------------------------------------------------

test("a genuine question anywhere in the turn earns the turn its relief", () => {
  const group = buildTurnGroup([
    promptEvent({ prompt: "start with the parser" }),
    promptEvent({ prompt: "should this stay pure?" }),
  ]);
  assert.equal(group.had_question, true);
});

test("a turn without a genuine question earns no relief", () => {
  const group = buildTurnGroup([
    promptEvent({ prompt: "ship it" }),
    promptEvent({ prompt: "ok?" }),
  ]);
  assert.equal(group.had_question, false);
});

test("a question inside a neutralized prompt earns no relief", () => {
  const group = buildTurnGroup([
    promptEvent({
      prompt:
        "<task-notification>did the agent finish the work?</task-notification>",
      neutralized: true,
    }),
  ]);
  assert.equal(group.had_question, false);
});

// ---------------------------------------------------------------------------
// Edits: totals stay delegation-inclusive, with the delegated share alongside.
// ---------------------------------------------------------------------------

test("edit volume totals include delegated work and report its share", () => {
  const group = buildTurnGroup([
    editEvent({ file: "src/a.js", lines_added: 10, lines_removed: 2 }),
    editEvent({
      file: "src/b.js",
      lines_added: 30,
      lines_removed: 5,
      delegated: true,
      agent_type: "Explore",
    }),
  ]);
  assert.equal(group.edit_count, 2);
  assert.equal(group.lines_added, 40);
  assert.equal(group.lines_removed, 7);
  assert.equal(group.delegated_edit_count, 1);
  assert.equal(group.delegated_lines_added, 30);
  assert.equal(group.delegated_lines_removed, 5);
});

test("the edit list keeps each edit's file, size, and attribution in order", () => {
  const group = buildTurnGroup([
    editEvent({ ts: 10, file: "src/a.js", lines_added: 1, lines_removed: 0 }),
    editEvent({
      ts: 20,
      file: "src/b.js",
      lines_added: 0,
      lines_removed: 3,
      delegated: true,
      agent_type: "general-purpose",
    }),
  ]);
  assert.deepEqual(group.edits, [
    {
      ts: 10,
      file: "src/a.js",
      lines_added: 1,
      lines_removed: 0,
      delegated: false,
      agent_type: null,
    },
    {
      ts: 20,
      file: "src/b.js",
      lines_added: 0,
      lines_removed: 3,
      delegated: true,
      agent_type: "general-purpose",
    },
  ]);
});

test("unusable line counts degrade to zero rather than poisoning the totals", () => {
  const group = buildTurnGroup([
    editEvent({ lines_added: -5, lines_removed: "many" }),
    editEvent({ lines_added: 4, lines_removed: Number.NaN }),
  ]);
  assert.equal(group.edit_count, 2);
  assert.equal(group.lines_added, 4);
  assert.equal(group.lines_removed, 0);
});

// ---------------------------------------------------------------------------
// Permission mode — the auto-accept presence the turn delta multiplies by.
// ---------------------------------------------------------------------------

test("an auto-accepting mode on any event marks the whole turn auto-accepting", () => {
  for (const mode of AUTO_ACCEPT_PERMISSION_MODES) {
    const group = buildTurnGroup([
      editEvent({ permission_mode: "default" }),
      editEvent({ permission_mode: mode }),
    ]);
    assert.equal(group.auto_accept, true, `expected ${mode} to auto-accept`);
  }
});

test("modes that still ask for approval leave the turn manual", () => {
  const group = buildTurnGroup([
    promptEvent({ permission_mode: "plan" }),
    editEvent({ permission_mode: "default" }),
    editEvent({ permission_mode: "" }),
  ]);
  assert.equal(group.auto_accept, false);
});

// ---------------------------------------------------------------------------
// Sub-agent lifecycle and the delegation verdict.
// ---------------------------------------------------------------------------

test("sub-agent lifecycle events are preserved in order and counted", () => {
  const group = buildTurnGroup([
    { type: "subagent_start", ts: 1, agent_type: "Explore" },
    { type: "subagent_start", ts: 2, agent_type: "Plan" },
    { type: "subagent_stop", ts: 3, agent_type: "Explore" },
  ]);
  assert.deepEqual(group.subagent_events, [
    { lifecycle: "start", ts: 1, agent_type: "Explore" },
    { lifecycle: "start", ts: 2, agent_type: "Plan" },
    { lifecycle: "stop", ts: 3, agent_type: "Explore" },
  ]);
  assert.equal(group.agent_count, 2);
  assert.equal(group.delegated, true);
});

test("delegated edits arriving without their start events still read as delegation", () => {
  const group = buildTurnGroup([
    editEvent({ delegated: true, agent_type: "Explore", lines_added: 12 }),
  ]);
  assert.equal(group.agent_count, 0);
  assert.equal(group.delegated, true);
});

test("a turn of the developer's own edits is not delegated", () => {
  const group = buildTurnGroup([promptEvent(), editEvent()]);
  assert.equal(group.delegated, false);
});

// ---------------------------------------------------------------------------
// Degradation: one bad line costs its own event, never the turn.
// ---------------------------------------------------------------------------

test("an empty log assembles an empty group", () => {
  const group = buildTurnGroup([]);
  assert.deepEqual(group, {
    prompt: "",
    prompt_effort: 0,
    genuine_prompt_count: 0,
    neutralized_prompt_count: 0,
    prompt_neutralized: false,
    had_question: false,
    auto_accept: false,
    edit_count: 0,
    lines_added: 0,
    lines_removed: 0,
    delegated_edit_count: 0,
    delegated_lines_added: 0,
    delegated_lines_removed: 0,
    delegated: false,
    agent_count: 0,
    edits: [],
    subagent_events: [],
    understood_event_count: 0,
    skipped_event_count: 0,
  });
});

test("anything that is not an event is skipped and counted", () => {
  const group = buildTurnGroup([
    null,
    "a torn line that still parsed",
    42,
    ["prompt"],
    {},
    { type: 7 },
    { type: "telemetry", ts: 1 },
    promptEvent({ effort: 0.5 }),
  ]);
  assert.equal(group.genuine_prompt_count, 1);
  assert.equal(group.prompt_effort, 0.5);
  assert.equal(group.understood_event_count, 1);
  assert.equal(group.skipped_event_count, 7);
});

test("an edit that names no file is skipped rather than counted as volume", () => {
  const group = buildTurnGroup([
    editEvent({ file: "", lines_added: 100 }),
    editEvent({ file: "src/a.js", lines_added: 3 }),
  ]);
  assert.equal(group.edit_count, 1);
  assert.equal(group.lines_added, 3);
  assert.equal(group.skipped_event_count, 1);
});

test("a corrupt line degrades the group without losing the events around it", () => {
  const group = buildTurnGroup([
    promptEvent({ prompt: "before", effort: 1 }),
    { type: "edit", ts: "torn" },
    editEvent({ lines_added: 5 }),
    promptEvent({ prompt: "after", effort: -1 }),
  ]);
  assert.equal(group.prompt, "before\n\nafter");
  assert.equal(group.prompt_effort, 0);
  assert.equal(group.edit_count, 1);
  assert.equal(group.lines_added, 5);
  assert.equal(group.understood_event_count, 3);
  assert.equal(group.skipped_event_count, 1);
});

test("a non-array input assembles an empty group rather than throwing", () => {
  for (const input of [undefined, null, "events", 42, { type: "prompt" }]) {
    const group = buildTurnGroup(input);
    assert.equal(
      group.understood_event_count,
      0,
      `expected an empty group for ${input}`,
    );
    assert.equal(group.prompt, "");
  }
});

// ---------------------------------------------------------------------------
// Purity — the builder reads events, it never edits the log it was handed.
// ---------------------------------------------------------------------------

test("assembling a group leaves the events it read untouched", () => {
  const events = [promptEvent({ effort: 0.5 }), editEvent({ lines_added: 2 })];
  const before = structuredClone(events);
  buildTurnGroup(events);
  assert.deepEqual(events, before);
});

test("the edit list does not alias the events it was built from", () => {
  const events = [editEvent({ file: "src/a.js" })];
  const group = buildTurnGroup(events);
  group.edits[0].file = "mutated";
  assert.equal(events[0].file, "src/a.js");
});
