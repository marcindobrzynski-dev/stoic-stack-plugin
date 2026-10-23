import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  CATEGORY_REGISTRY,
  createCategoryRegistry,
} from "../../../experiments/jev/categories/index.js";
import {
  PREVIOUS_TURNS,
  STATE_MODEL,
  STATE_SCHEMA_VERSION,
  SUMMARY_MAX_CHARS,
  WINDOW_TURNS,
} from "../../../experiments/jev/constants.js";
import { STATE_TIMEOUT_MS } from "../../../experiments/jev/timing.js";
import {
  DECISION_KIND_VALUES,
  DECISION_MADE_BY_VALUES,
  INTENT_SCALE_VALUES,
  REFLECTION_SIGNAL_KEYS,
  STATE_SCHEMA,
  validateStructuredState,
} from "../../../experiments/jev/state-schema.js";
import {
  SUMMARIES_DIR_NAME,
  buildStructuredState,
  emptySessionSummary,
  loadSessionSummary,
  sessionSummaryPath,
} from "../../../experiments/jev/structured-state.js";
import { personalStateDir, personalStatePath } from "../../../src/io/paths.js";
import { makeTempDir } from "../../helpers/temp-dir.js";

/**
 * Build a valid v3 structured state fixture with optional section overrides.
 *
 * @param {object} [overrides] - Top-level field overrides.
 * @returns {object} Complete v3 structured state object.
 */
function validStateFixture(overrides = {}) {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    developer_intent: {
      developer_request: "Add retry backoff to the webhook sender.",
      intent_scale: INTENT_SCALE_VALUES[1],
    },
    decision_ownership: {
      decisions: [
        {
          what: "Cap retries at 4 attempts with exponential backoff",
          made_by: DECISION_MADE_BY_VALUES[0],
          developer_aware: false,
          decision_kind: DECISION_KIND_VALUES[0],
        },
      ],
    },
    decision_weight: {
      file_changes: [
        {
          file_path: "src/webhook.js",
          diff_size: 14,
          logic_touched: true,
          one_way: false,
        },
      ],
      non_code_decision: false,
      unaware_decision_count: 1,
    },
    developer_reflection: {
      reflection_signals: {
        justified_choice: false,
        asked_questions: true,
        discussed_alternatives: false,
        suggested_fixes: false,
      },
      bare_pick_streak: 0,
    },
    area_label: "api_integration",
    summary: "Developer refined retry policy; AI picked 4-attempt cap.",
    ...overrides,
  };
}

/**
 * Write a synthetic Claude Code transcript JSONL file from an array of turn
 * descriptors.
 *
 * @param {string} dir - Temp directory to write the transcript into.
 * @param {object[]} turns - Synthetic turns (`{ prompt, promptId, answer,
 *   changes }`).
 * @returns {string} Absolute path of the transcript JSONL file.
 */
function writeSyntheticTranscript(dir, turns) {
  const filePath = path.join(dir, "transcript.jsonl");
  const lines = [];

  for (const turn of turns) {
    lines.push(
      JSON.stringify({
        type: "user",
        origin: { kind: "human" },
        promptId: turn.promptId ?? null,
        message: { content: turn.prompt },
      }),
    );

    const contentBlocks = [];
    if (typeof turn.answer === "string") {
      contentBlocks.push({ type: "text", text: turn.answer });
    }
    if (Array.isArray(turn.changes)) {
      for (const change of turn.changes) {
        if (change.tool === "Edit") {
          contentBlocks.push({
            type: "tool_use",
            name: "Edit",
            input: {
              file_path: change.path,
              new_string: change.content,
            },
          });
        } else {
          contentBlocks.push({
            type: "tool_use",
            name: "Write",
            input: {
              file_path: change.path,
              content: change.content,
            },
          });
        }
      }
    }

    if (contentBlocks.length > 0) {
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: { content: contentBlocks },
        }),
      );
    }
  }

  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

test("the state schema derives its category sections from the registry", () => {
  assert.equal(
    STATE_SCHEMA.properties.schema_version.const,
    STATE_SCHEMA_VERSION,
  );
  assert.equal(STATE_SCHEMA.properties.summary.maxLength, SUMMARY_MAX_CHARS);
  assert.equal(STATE_SCHEMA.properties.area_label.type, "string");

  for (const category of CATEGORY_REGISTRY) {
    assert.equal(
      STATE_SCHEMA.required.includes(category.stateSection),
      true,
      `STATE_SCHEMA must require ${category.stateSection}`,
    );
    assert.equal(
      STATE_SCHEMA.properties[category.stateSection]?.type,
      "object",
      `STATE_SCHEMA must define an object property for ${category.stateSection}`,
    );
  }
});

/**
 * A category the built-in schema and validator maps do not know.
 *
 * @param {object} [extras] - Optional `sectionSchema` or `validateSection`.
 * @returns {object} Category descriptor.
 */
function scopeDisciplineCategory(extras = {}) {
  return {
    name: "scope_discipline",
    readableName: "Scope discipline",
    stateSection: "scope_discipline",
    questions: {
      unrequested_refactor: {
        type: "noul",
        instructions: "Did the assistant refactor unrelated modules?",
      },
    },
    buildQuestions: (sdk) => ({
      unrequested_refactor: sdk.noul(
        "Did the assistant refactor unrelated modules?",
      ),
    }),
    toProbability: (answers) => answers?.unrequested_refactor?.noul ?? null,
    ...extras,
  };
}

/**
 * Ask for a structured state and return the outcome. The runner is ready to
 * succeed so a registry defect is not confused with a headless failure.
 *
 * @param {import("node:test").TestContext} t - Test context.
 * @param {readonly object[]} registry - Category registry under test.
 * @param {object} state - Structured state the runner would return.
 * @returns {object} `buildStructuredState` outcome.
 */
function buildStateForRegistry(t, registry, state) {
  const dir = makeTempDir(t, "stoic-jev-registry-defect-");
  const transcriptPath = writeSyntheticTranscript(dir, [
    {
      prompt: "Keep the change inside the webhook module.",
      promptId: "prompt-registry-defect",
      answer: "Kept the change inside the webhook module.",
    },
  ]);

  return buildStructuredState(
    {
      transcript_path: transcriptPath,
      session_id: "session-registry-defect",
      cwd: dir,
    },
    {
      projectDir: dir,
      homeDir: dir,
      registry,
      runner: () => ({ status: "ok", value: state }),
    },
  );
}

test("a category section without a schema is state_invalid", (t) => {
  const registered = createCategoryRegistry([scopeDisciplineCategory()])[0];
  const registry = [
    ...CATEGORY_REGISTRY,
    {
      ...registered,
      validateSection: () => null,
    },
  ];
  const state = validStateFixture({
    scope_discipline: { unrequested_refactor: false },
  });

  assert.deepEqual(validateStructuredState(state, registry), {
    ok: false,
    reason: "missing_section_schema:scope_discipline",
  });
  assert.doesNotThrow(() => buildStateForRegistry(t, registry, state));
  const outcome = buildStateForRegistry(t, registry, state);
  assert.equal(outcome.status, "state_invalid");
  assert.equal(outcome.reason, "missing_section_schema:scope_discipline");
});

test("a category section without a validator is state_invalid", (t) => {
  const registered = createCategoryRegistry([scopeDisciplineCategory()])[0];
  const registry = [
    ...CATEGORY_REGISTRY,
    {
      ...registered,
      sectionSchema: {
        type: "object",
        additionalProperties: false,
      },
    },
  ];
  const state = validStateFixture({
    scope_discipline: {},
  });

  assert.deepEqual(validateStructuredState(state, registry), {
    ok: false,
    reason: "missing_section_validator:scope_discipline",
  });
  assert.doesNotThrow(() => buildStateForRegistry(t, registry, state));
  const outcome = buildStateForRegistry(t, registry, state);
  assert.equal(outcome.status, "state_invalid");
  assert.equal(outcome.reason, "missing_section_validator:scope_discipline");
});

test("reflex approval is not accepted as a reflection signal", () => {
  assert.equal(REFLECTION_SIGNAL_KEYS.includes("reflex_approval"), false);
  const state = validStateFixture();
  state.developer_reflection.reflection_signals.reflex_approval = true;
  const outcome = validateStructuredState(state);
  assert.equal(outcome.ok, false);
});

test("a state missing schema_version 3 is rejected with invalid_schema_version", (t) => {
  const dir = makeTempDir(t, "stoic-jev-schema-version-");
  const transcriptPath = writeSyntheticTranscript(dir, [
    {
      prompt: "Implement retry backoff.",
      promptId: "prompt-1",
      answer: "Implemented retry backoff.",
    },
  ]);

  const missingVersion = validStateFixture();
  delete missingVersion.schema_version;

  for (const invalidCandidate of [
    missingVersion,
    validStateFixture({ schema_version: STATE_SCHEMA_VERSION - 1 }),
    validStateFixture({ schema_version: String(STATE_SCHEMA_VERSION) }),
  ]) {
    assert.deepEqual(validateStructuredState(invalidCandidate), {
      ok: false,
      reason: "invalid_schema_version",
    });

    const outcome = buildStructuredState(
      {
        transcript_path: transcriptPath,
        session_id: "session-version-check",
        cwd: dir,
      },
      {
        projectDir: dir,
        homeDir: dir,
        runner: () => ({ status: "ok", value: invalidCandidate }),
      },
    );

    assert.equal(outcome.status, "state_invalid");
    assert.equal(outcome.reason, "invalid_schema_version");
    assert.equal(outcome.state, undefined);
  }
});

test("a schema mismatch or failed headless call returns an infrastructure status instead of guessing", (t) => {
  const dir = makeTempDir(t, "stoic-jev-mismatch-");
  const transcriptPath = writeSyntheticTranscript(dir, [
    {
      prompt: "Add rate limiting middleware.",
      promptId: "prompt-mismatch",
      answer: "Added rate limiting middleware.",
    },
  ]);

  const missingSection = validStateFixture();
  delete missingSection.decision_weight;

  const badIntentScale = validStateFixture({
    developer_intent: {
      developer_request: "Add rate limiting",
      intent_scale: "guessed_value",
    },
  });

  const badDecisionEntry = validStateFixture({
    decision_ownership: {
      decisions: [
        {
          what: "Picked token bucket",
          made_by: "unknown_actor",
          developer_aware: false,
          decision_kind: "code",
        },
      ],
    },
  });

  const badFileChange = validStateFixture({
    decision_weight: {
      file_changes: [
        {
          file_path: "src/limiter.js",
          diff_size: -5,
          logic_touched: true,
          one_way: false,
        },
      ],
      non_code_decision: false,
      unaware_decision_count: 0,
    },
  });

  const badReflectionSignal = validStateFixture({
    developer_reflection: {
      reflection_signals: Object.fromEntries(
        REFLECTION_SIGNAL_KEYS.map((key) => [key, "yes"]),
      ),
      bare_pick_streak: 0,
    },
  });

  for (const malformed of [
    missingSection,
    badIntentScale,
    badDecisionEntry,
    badFileChange,
    badReflectionSignal,
    validStateFixture({ area_label: "" }),
  ]) {
    const outcome = buildStructuredState(
      {
        transcript_path: transcriptPath,
        session_id: "session-mismatch",
        cwd: dir,
      },
      {
        projectDir: dir,
        homeDir: dir,
        runner: () => ({ status: "ok", value: malformed }),
      },
    );

    assert.equal(outcome.status, "state_invalid");
    assert.equal(typeof outcome.reason, "string");
    assert.ok(outcome.reason.length > 0);
    assert.equal(outcome.state, undefined);
  }

  const capturedCalls = [];
  const unavailableOutcome = buildStructuredState(
    {
      transcript_path: transcriptPath,
      session_id: "session-unavailable",
      cwd: dir,
    },
    {
      projectDir: dir,
      homeDir: dir,
      runner: (prompt, runnerOptions) => {
        capturedCalls.push({ prompt, runnerOptions });
        return { status: "unavailable", reason: "timeout" };
      },
    },
  );

  assert.equal(unavailableOutcome.status, "state_unavailable");
  assert.equal(unavailableOutcome.reason, "timeout");
  assert.equal(unavailableOutcome.state, undefined);
  assert.equal(capturedCalls.length, 1);
  assert.equal(capturedCalls[0].runnerOptions.model, STATE_MODEL);
  assert.equal(capturedCalls[0].runnerOptions.timeoutMs, STATE_TIMEOUT_MS);
  assert.deepEqual(capturedCalls[0].runnerOptions.jsonSchema, STATE_SCHEMA);
});

test("the turn window includes only the current turn and two previous non-skill turns, with the current answer from last_assistant_message", (t) => {
  const dir = makeTempDir(t, "stoic-jev-window-");
  const transcriptPath = writeSyntheticTranscript(dir, [
    {
      prompt: "Turn 1 oldest turn that must drop out of the window",
      promptId: "prompt-1",
      answer: "Answer 1 oldest",
    },
    {
      prompt: "Turn 2 first retained previous turn",
      promptId: "prompt-2",
      answer: "Answer 2 retained",
    },
    {
      prompt: "<command-name>/stoic-stack:stoic-reflect</command-name>",
      promptId: "prompt-3-skill",
      answer: "Skill output that must be filtered out",
    },
    {
      prompt: "Turn 4 second retained previous turn",
      promptId: "prompt-4",
      answer: "Answer 4 retained",
      changes: [
        {
          tool: "Write",
          path: "src/retry.js",
          content: "export const retries = 3;\nexport const delay = 100;",
        },
      ],
    },
    {
      prompt: "Turn 5 current developer request",
      promptId: "prompt-5-current",
      answer: "Stale transcript answer that must be replaced",
      changes: [
        {
          tool: "Edit",
          path: "src/retry.js",
          content: "export const retries = 4;\nexport const delay = 200;\n",
        },
      ],
    },
  ]);

  let receivedPrompt = "";
  const outcome = buildStructuredState(
    {
      transcript_path: transcriptPath,
      last_assistant_message: "Final assistant answer from Stop payload",
      session_id: "session-window",
      cwd: dir,
    },
    {
      projectDir: dir,
      homeDir: dir,
      runner: (prompt) => {
        receivedPrompt = prompt;
        return { status: "ok", value: validStateFixture() };
      },
    },
  );

  assert.equal(outcome.status, "ok");
  assert.equal(outcome.turnsIncluded, WINDOW_TURNS);
  assert.equal(outcome.turnsIncluded, 1 + PREVIOUS_TURNS);
  assert.equal(outcome.promptId, "prompt-5-current");
  assert.equal(outcome.currentHasChanges, true);

  assert.equal(
    receivedPrompt.includes("Turn 1 oldest turn"),
    false,
    "turns older than PREVIOUS_TURNS must be excluded",
  );
  assert.equal(
    receivedPrompt.includes("stoic-reflect"),
    false,
    "Stoic skill turns must be filtered out of the window",
  );
  assert.equal(
    receivedPrompt.includes("Stale transcript answer"),
    false,
    "last_assistant_message must replace the current turn's transcript answer",
  );
  assert.equal(
    receivedPrompt.includes("Turn 2 first retained previous turn"),
    true,
  );
  assert.equal(
    receivedPrompt.includes("Turn 4 second retained previous turn"),
    true,
  );
  assert.equal(
    receivedPrompt.includes("src/retry.js (2 lines)"),
    true,
    "diff line counts from transcript changes must be included",
  );
  assert.equal(
    receivedPrompt.includes("Final assistant answer from Stop payload"),
    true,
  );
});

test("a summary longer than SUMMARY_MAX_CHARS is rejected while a summary at the cap is accepted", (t) => {
  const dir = makeTempDir(t, "stoic-jev-summary-cap-");
  const transcriptPath = writeSyntheticTranscript(dir, [
    {
      prompt: "Update summary cap validation.",
      promptId: "prompt-cap",
      answer: "Updated.",
    },
  ]);

  const atCapState = validStateFixture({
    summary: "s".repeat(SUMMARY_MAX_CHARS),
  });
  const overCapState = validStateFixture({
    summary: "s".repeat(SUMMARY_MAX_CHARS + 1),
  });

  const accepted = buildStructuredState(
    {
      transcript_path: transcriptPath,
      session_id: "session-cap",
      cwd: dir,
    },
    {
      projectDir: dir,
      homeDir: dir,
      runner: () => ({ status: "ok", value: atCapState }),
    },
  );
  assert.equal(accepted.status, "ok");
  assert.equal(accepted.state.summary.length, SUMMARY_MAX_CHARS);

  const rejected = buildStructuredState(
    {
      transcript_path: transcriptPath,
      session_id: "session-cap",
      cwd: dir,
    },
    {
      projectDir: dir,
      homeDir: dir,
      runner: () => ({ status: "ok", value: overCapState }),
    },
  );
  assert.equal(rejected.status, "state_invalid");
  assert.equal(rejected.reason, "summary_too_long");
});

test("the rolling summary is persisted per session, passed into the next analysis, and preserved when a later state is invalid", (t) => {
  const projectDir = makeTempDir(t, "stoic-jev-project-");
  const homeDir = makeTempDir(t, "stoic-jev-home-");
  const transcriptPath = writeSyntheticTranscript(projectDir, [
    {
      prompt: "ok, do option A",
      promptId: "turn-101",
      answer: "Applied option A.",
    },
  ]);

  const firstState = validStateFixture({
    summary:
      "Turn 101 summary: developer picked option A without justification.",
    decision_weight: {
      file_changes: [],
      non_code_decision: false,
      unaware_decision_count: 2,
    },
    developer_reflection: {
      reflection_signals: {
        justified_choice: false,
        asked_questions: false,
        discussed_alternatives: false,
        suggested_fixes: false,
      },
      bare_pick_streak: 3,
    },
  });

  const firstOutcome = buildStructuredState(
    {
      transcript_path: transcriptPath,
      session_id: "session-rolling-1",
      cwd: projectDir,
    },
    {
      projectDir,
      homeDir,
      spawn: () => ({
        status: 0,
        stdout: JSON.stringify({
          type: "result",
          result: "",
          structured_output: firstState,
        }),
      }),
    },
  );

  assert.equal(firstOutcome.status, "ok");
  assert.equal(
    fs.existsSync(personalStatePath(projectDir, homeDir)),
    false,
    "session summaries must never write to state.json",
  );

  const persistedAfterFirst = loadSessionSummary(
    projectDir,
    "session-rolling-1",
    homeDir,
  );
  assert.deepEqual(persistedAfterFirst, {
    schema_version: STATE_SCHEMA_VERSION,
    summary: firstState.summary,
    bare_pick_streak: 3,
    bare_pick_history: [true],
    unaware_decision_count: 2,
    last_analysed_turn: "turn-101",
  });

  let secondPrompt = "";
  const secondState = validStateFixture({
    summary: "Turn 102 summary: developer questioned the retry cap.",
    decision_weight: {
      file_changes: [],
      non_code_decision: false,
      unaware_decision_count: 2,
    },
    developer_reflection: {
      reflection_signals: {
        justified_choice: true,
        asked_questions: true,
        discussed_alternatives: false,
        suggested_fixes: false,
      },
      bare_pick_streak: 0,
    },
  });

  const secondTranscriptPath = writeSyntheticTranscript(projectDir, [
    {
      prompt: "Why 4 retries instead of 3?",
      promptId: "turn-102",
      answer: "Explained retry trade-offs.",
    },
  ]);

  const secondOutcome = buildStructuredState(
    {
      transcript_path: secondTranscriptPath,
      session_id: "session-rolling-1",
      cwd: projectDir,
    },
    {
      projectDir,
      homeDir,
      runner: (prompt) => {
        secondPrompt = prompt;
        return { status: "ok", value: secondState };
      },
    },
  );

  assert.equal(secondOutcome.status, "ok");
  assert.equal(secondPrompt.includes(firstState.summary), true);
  assert.equal(secondPrompt.includes("bare_pick_streak: 3"), true);
  assert.equal(secondPrompt.includes("unaware_decision_count: 2"), true);
  assert.equal(secondPrompt.includes("last_analysed_turn: turn-101"), true);

  const persistedAfterSecond = loadSessionSummary(
    projectDir,
    "session-rolling-1",
    homeDir,
  );
  assert.equal(persistedAfterSecond.summary, secondState.summary);
  assert.deepEqual(persistedAfterSecond.bare_pick_history, [true, false]);
  assert.equal(persistedAfterSecond.last_analysed_turn, "turn-102");

  const invalidThirdOutcome = buildStructuredState(
    {
      transcript_path: secondTranscriptPath,
      session_id: "session-rolling-1",
      cwd: projectDir,
    },
    {
      projectDir,
      homeDir,
      runner: () => ({
        status: "ok",
        value: { schema_version: 999 },
      }),
    },
  );

  assert.equal(invalidThirdOutcome.status, "state_invalid");
  assert.deepEqual(
    loadSessionSummary(projectDir, "session-rolling-1", homeDir),
    persistedAfterSecond,
    "an invalid state must not overwrite the previously stored session summary",
  );
});

test("a corrupt or missing session summary file reads as empty without throwing, and a hostile session id cannot escape jev-summaries", (t) => {
  const projectDir = makeTempDir(t, "stoic-jev-corrupt-proj-");
  const homeDir = makeTempDir(t, "stoic-jev-corrupt-home-");

  assert.deepEqual(
    loadSessionSummary(projectDir, "brand-new-session", homeDir),
    emptySessionSummary(),
  );

  const summaryPath = sessionSummaryPath(
    projectDir,
    "corrupt-session",
    homeDir,
  );
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, "{corrupt json", "utf8");

  assert.doesNotThrow(() =>
    loadSessionSummary(projectDir, "corrupt-session", homeDir),
  );
  assert.deepEqual(
    loadSessionSummary(projectDir, "corrupt-session", homeDir),
    emptySessionSummary(),
  );

  const hostilePath = sessionSummaryPath(
    projectDir,
    "../../outside/evil-session",
    homeDir,
  );
  const expectedSummariesDir = path.join(
    personalStateDir(projectDir, homeDir),
    SUMMARIES_DIR_NAME,
  );

  assert.equal(path.dirname(hostilePath), expectedSummariesDir);
  assert.equal(
    path.relative(expectedSummariesDir, hostilePath).startsWith(".."),
    false,
  );
});
