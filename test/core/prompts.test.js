import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isGenuineQuestion,
  isHarnessInjection,
  isOwnPluginPrompt,
  LONG_PROMPT_WORD_LIMIT,
  OWN_PROMPT_PREFIX,
  PROMPT_TRUNCATION_CHARS,
  promptEffort,
  QUESTION_MIN_WORDS,
  SHORT_PROMPT_WORD_LIMIT,
  TASK_NOTIFICATION_MARKER,
  truncatePrompt,
} from "../../src/core/prompts.js";

/** A prose filler of exactly `count` unremarkable words. */
function words(count) {
  return Array.from({ length: count }, () => "word").join(" ");
}

// ---------------------------------------------------------------------------
// promptEffort — the signed autopilot signal. Tests assert the sign and the
// bounds of each prompt class, never the internal sub-scores, so the crude
// heuristic can be replaced without rewriting this suite.
// ---------------------------------------------------------------------------

test("effort of an empty or absent prompt is exactly zero", () => {
  assert.equal(promptEffort(""), 0);
  assert.equal(promptEffort("   \n\t  "), 0);
  assert.equal(promptEffort(undefined), 0);
  assert.equal(promptEffort(null), 0);
  assert.equal(promptEffort(42), 0);
});

test("a short vague command is maximally low-effort", () => {
  assert.equal(promptEffort("fix it"), 1);
  assert.equal(promptEffort("continue"), 1);
  assert.equal(promptEffort("just do it again"), 1);
});

test("a short prompt without a vague command still reads as low effort", () => {
  const effort = promptEffort("update the readme");
  assert.ok(effort > 0);
  assert.ok(effort < 1);
});

test("a structured, specific prompt earns negative effort", () => {
  const prompt = [
    "Refactor src/io/config.js so the loader stays fail-silent.",
    "- must keep the existing resolveKnobs signature",
    "- avoid touching the preset table",
    "```js",
    "resolveKnobs(config, state)",
    "```",
  ].join("\n");
  assert.ok(promptEffort(prompt) < 0);
});

test("a constraint-rich prose prompt earns negative effort without structure", () => {
  const prompt =
    "The migration must preserve all 3 legacy columns and should never " +
    "drop rows; ensure the rollback path stays reversible.";
  assert.ok(promptEffort(prompt) < 0);
});

test("a fully loaded long prompt saturates at minus one", () => {
  const prompt = [
    `${words(LONG_PROMPT_WORD_LIMIT)} in src/core/scoring.js`,
    "- must keep decay pure",
    "```js",
    "turnDelta(group, knobs)",
    "```",
    "keep the cap at 200 lines",
  ].join("\n");
  assert.equal(promptEffort(prompt), -1);
});

test("effort is always within its signed bounds", () => {
  const prompts = [
    "fix",
    "why?",
    words(SHORT_PROMPT_WORD_LIMIT + 1),
    words(LONG_PROMPT_WORD_LIMIT + 10),
    "```\ncode\n```",
    "- a\n- b\n- c",
  ];
  for (const prompt of prompts) {
    const effort = promptEffort(prompt);
    assert.ok(effort >= -1 && effort <= 1, `out of bounds for: ${prompt}`);
  }
});

test("a harness-injected prompt has zero effort regardless of content", () => {
  const injected = `${TASK_NOTIFICATION_MARKER}\nfix it`;
  assert.equal(promptEffort(injected), 0);
});

// ---------------------------------------------------------------------------
// isHarnessInjection — the neutralized-logging trigger.
// ---------------------------------------------------------------------------

test("the harness-injection marker is detected wherever it appears", () => {
  assert.equal(isHarnessInjection(TASK_NOTIFICATION_MARKER), true);
  assert.equal(isHarnessInjection(`${TASK_NOTIFICATION_MARKER} done`), true);
  assert.equal(
    isHarnessInjection(`[SYSTEM]\n${TASK_NOTIFICATION_MARKER}\nbody`),
    true,
  );
});

test("ordinary prompts and non-strings are not harness injections", () => {
  assert.equal(isHarnessInjection("please add task notifications"), false);
  assert.equal(isHarnessInjection(""), false);
  assert.equal(isHarnessInjection(undefined), false);
  assert.equal(isHarnessInjection(null), false);
});

// ---------------------------------------------------------------------------
// isGenuineQuestion — the question-relief trigger.
// ---------------------------------------------------------------------------

test("a substantial prompt ending in a question mark is a genuine question", () => {
  assert.equal(
    isGenuineQuestion("why did we pick a half-life over a linear decay?"),
    true,
  );
});

test("a question line inside a longer prompt still counts", () => {
  const prompt = [
    "I looked at the scoring module.",
    "should the delegated discount apply before the cap?",
    "No rush.",
  ].join("\n");
  assert.equal(isGenuineQuestion(prompt), true);
});

test("a question below the minimum word count earns no relief", () => {
  assert.equal(isGenuineQuestion("ok?"), false);
  assert.equal(isGenuineQuestion(`${words(QUESTION_MIN_WORDS - 1)}?`), false);
});

test("a question at the minimum word count earns relief", () => {
  assert.equal(isGenuineQuestion(`${words(QUESTION_MIN_WORDS)}?`), true);
});

test("statements, harness injections, and non-strings are not questions", () => {
  assert.equal(isGenuineQuestion("fix the failing test"), false);
  assert.equal(
    isGenuineQuestion(`${TASK_NOTIFICATION_MARKER} did the task finish?`),
    false,
  );
  assert.equal(isGenuineQuestion(""), false);
  assert.equal(isGenuineQuestion(undefined), false);
});

// ---------------------------------------------------------------------------
// isOwnPluginPrompt — self-instrumentation guard for /stoic-stack prompts.
// ---------------------------------------------------------------------------

test("the plugin's own prompts are recognized as a whole token", () => {
  assert.equal(isOwnPluginPrompt(OWN_PROMPT_PREFIX), true);
  assert.equal(isOwnPluginPrompt(`${OWN_PROMPT_PREFIX} status`), true);
  assert.equal(isOwnPluginPrompt(`  ${OWN_PROMPT_PREFIX}:setup`), true);
});

test("prompts merely resembling the prefix are not the plugin's own", () => {
  assert.equal(isOwnPluginPrompt(`${OWN_PROMPT_PREFIX}er`), false);
  assert.equal(isOwnPluginPrompt(`run ${OWN_PROMPT_PREFIX} for me`), false);
  assert.equal(isOwnPluginPrompt(""), false);
  assert.equal(isOwnPluginPrompt(undefined), false);
});

// ---------------------------------------------------------------------------
// truncatePrompt — the bounded stored text.
// ---------------------------------------------------------------------------

test("short prompts pass through truncation unchanged", () => {
  assert.equal(truncatePrompt("keep me"), "keep me");
});

test("overlong prompts are cut to the truncation limit", () => {
  const long = "x".repeat(PROMPT_TRUNCATION_CHARS + 500);
  const truncated = truncatePrompt(long);
  assert.equal(truncated.length, PROMPT_TRUNCATION_CHARS);
  assert.equal(truncated, long.slice(0, PROMPT_TRUNCATION_CHARS));
});

test("non-string prompts truncate to the empty string", () => {
  assert.equal(truncatePrompt(undefined), "");
  assert.equal(truncatePrompt(null), "");
  assert.equal(truncatePrompt(42), "");
});
