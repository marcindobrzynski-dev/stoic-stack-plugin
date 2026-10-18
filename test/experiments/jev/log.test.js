import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  CATEGORY_NAMES,
  CATEGORY_REGISTRY,
  createCategoryRegistry,
  probabilitiesByCategory,
} from "../../../experiments/jev/categories/index.js";
import { name as decisionOwnershipName } from "../../../experiments/jev/categories/decision-ownership.js";
import { name as decisionWeightName } from "../../../experiments/jev/categories/decision-weight.js";
import { name as developerIntentName } from "../../../experiments/jev/categories/developer-intent.js";
import { name as developerReflectionName } from "../../../experiments/jev/categories/developer-reflection.js";
import {
  FALLBACK_MODEL,
  PAUSE_THRESHOLDS,
  STATE_MODEL,
  STATE_SCHEMA_VERSION,
  VETO_COOLDOWN_RATIO,
} from "../../../experiments/jev/constants.js";
import {
  INPUT_DIR_NAME,
  SUMMARY_FILE_NAME,
  appendSummaryLine,
  buildSummaryLine,
  inputDirPath,
  joinSummaryWithLocalTrace,
  readInputRecord,
  readSummaryLines,
  summaryLogPath,
  writeInputFile,
} from "../../../experiments/jev/log.js";
import {
  buildVerdict,
  classifyTurn,
  combineProbabilities,
  combineReflectionAndIntent,
  selectDrivingCategory,
} from "../../../experiments/jev/run.js";
import { runJev } from "../../../experiments/jev/runner.js";
import {
  DECISION_KIND_VALUES,
  DECISION_MADE_BY_VALUES,
  INTENT_SCALE_VALUES,
} from "../../../experiments/jev/state-schema.js";
import { relievedScore } from "../../../src/core/scoring.js";
import {
  DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLD,
  PRESETS,
  saveConfig,
} from "../../../src/io/config/config.js";
import { VERDICT_SCENARIOS } from "../../fixtures/classifier-verdicts.js";
import {
  hookEntrypoint,
  readTrace,
  seedStateDocument,
} from "../../helpers/capture-hook.js";
import { claudeShimEnv } from "../../helpers/claude-shim.js";
import { createSandbox } from "../../helpers/sandbox.js";
import { makeTempDir } from "../../helpers/temp-dir.js";

/** Wrap a plain map of numbers into TypeSafe `noul` answer objects. */
function noulAnswers(values) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      { type: "noul", noul: value },
    ]),
  );
}

/** Sample per-category answers that trigger a pause on balanced preset. */
const PAUSE_ANSWERS_BY_CATEGORY = Object.freeze({
  developer_intent: noulAnswers({
    own_idea: 0,
    refining_own_proposal: 0,
    specific_request: 0,
    accepting_ai_proposal: 1,
  }),
  decision_ownership: noulAnswers({
    unaware_ai_decision: 0.9,
    ai_beyond_request: 0.8,
    unacknowledged_ai_tradeoff: 0.7,
  }),
  decision_weight: noulAnswers({
    logic_and_size: 0.8,
    one_way_decision: 0.9,
    non_code_decision: 0,
    unaware_decision_cascade: 0.2,
  }),
  developer_reflection: noulAnswers({
    reflex_approval: 1,
    justified_choice: 0,
    asked_questions: 0,
    suggested_fixes: 0,
    bare_pick_streak: 0.8,
  }),
});

/**
 * Sample per-category answers where `developer_intent > developer_reflection`
 * and `1 - effective_reflection` is the smallest factor, vetoing the pause.
 */
const VETO_ANSWERS_BY_CATEGORY = Object.freeze({
  developer_intent: noulAnswers({
    own_idea: 0.95,
    refining_own_proposal: 0.8,
    specific_request: 0.7,
    accepting_ai_proposal: 0,
  }),
  decision_ownership: noulAnswers({
    unaware_ai_decision: 0.75,
    ai_beyond_request: 0.4,
    unacknowledged_ai_tradeoff: 0.3,
  }),
  decision_weight: noulAnswers({
    logic_and_size: 0.3,
    one_way_decision: 0.85,
    non_code_decision: 0.1,
    unaware_decision_cascade: 0.2,
  }),
  developer_reflection: noulAnswers({
    reflex_approval: 0.4,
    justified_choice: 0.3,
    asked_questions: 0.2,
    suggested_fixes: 0.1,
    bare_pick_streak: 0,
  }),
});

/** Removed duplicated flat top-level fields that must not appear on v3 lines. */
const REMOVED_FLAT_V3_FIELDS = Object.freeze([
  "decision_weight",
  "decision_ownership",
  "developer_reflection",
  "developer_intent",
  "effective_reflection",
  "sonnet_ms",
  "jev_ms",
  "category_latency_ms",
  "fallback_ms",
  "total_ms",
  "latency_ms",
  "state_model",
  "jev_model",
  "model_version",
  "fallback_model",
  "score_after",
]);

/**
 * Build a valid v3 structured state fixture.
 *
 * @param {object} [overrides] - Optional field overrides.
 * @returns {object} Valid v3 structured state.
 */
function validStateFixture(overrides = {}) {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    developer_intent: {
      developer_request: "Add retry backoff to webhook delivery.",
      intent_scale: INTENT_SCALE_VALUES[1],
    },
    decision_ownership: {
      decisions: [
        {
          what: "Cap webhook retries at 4 attempts",
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
          diff_size: 18,
          logic_touched: true,
          one_way: false,
        },
      ],
      non_code_decision: false,
      unaware_decision_count: 1,
    },
    developer_reflection: {
      reflection_signals: {
        justified_choice: true,
        asked_questions: false,
        discussed_alternatives: false,
        suggested_fixes: false,
        reflex_approval: false,
      },
      bare_pick_streak: 0,
    },
    area_label: "security_auth",
    summary: "Developer asked for retry backoff; assistant chose 4 retries.",
    ...overrides,
  };
}

/**
 * Create a synthetic turn fixture with a transcript and optional `.stoic/.env`.
 *
 * @param {object} t - Node test context.
 * @param {{ apiKey?: string, rawTranscriptMarker?: string }} [options] - Setup
 *   options.
 * @returns {{ projectDir: string, homeDir: string, input: object }}
 *   Prepared fixture.
 */
function makeLogFixture(t, options = {}) {
  const apiKey = options.apiKey ?? "test-key-not-real";
  const rawTranscriptMarker =
    options.rawTranscriptMarker ?? "PRIVATE_TRANSCRIPT_PROSE_DO_NOT_LOG";
  const projectDir = makeTempDir(t, "stoic-jev-log-proj-");
  const homeDir = makeTempDir(t, "stoic-jev-log-home-");
  const transcriptPath = path.join(projectDir, "transcript.jsonl");

  const lines = [
    JSON.stringify({
      type: "user",
      origin: { kind: "human" },
      promptId: "prompt-stage-5",
      message: {
        content: `Add retry backoff. ${rawTranscriptMarker}`,
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Added retry backoff." },
          {
            type: "tool_use",
            name: "Edit",
            input: {
              file_path: "src/webhook.js",
              new_string: "export const maxRetries = 4;\n",
            },
          },
        ],
      },
    }),
  ];
  fs.writeFileSync(transcriptPath, `${lines.join("\n")}\n`, "utf8");

  const stoicDir = path.join(projectDir, ".stoic");
  fs.mkdirSync(stoicDir, { recursive: true });
  fs.writeFileSync(
    path.join(stoicDir, ".env"),
    `TYPESAFE_API_KEY=${apiKey}\n`,
    "utf8",
  );

  const input = {
    prompt: "Classifier prompt text",
    model: "jev-latest",
    group: {
      prompt: "Add retry backoff.",
      edit_count: 1,
      lines_added: 1,
      lines_removed: 0,
      edits: [{ file: "src/webhook.js", lines_added: 1, lines_removed: 0 }],
    },
    context: {
      projectDir,
      homeDir,
      score_before: 14,
      stopInput: {
        transcript_path: transcriptPath,
        last_assistant_message: "Added retry backoff with 4 retries.",
        session_id: "session-stage-5",
        cwd: projectDir,
      },
    },
  };

  return { projectDir, homeDir, input };
}

/**
 * Build a stubbed TypeSafe SDK seam for a given category registry and answer
 * map.
 *
 * @param {Record<string, object>} answersByCategory - Per-category answer map.
 * @param {readonly object[]} [registry] - Active category registry.
 * @returns {object} Stub SDK module.
 */
function makeStubSdk(answersByCategory, registry = CATEGORY_REGISTRY) {
  function identifyCategory(request) {
    const questionKeys = Object.keys(request?.questions ?? {}).sort();
    for (const category of registry) {
      const expectedKeys = Object.keys(category.questions).sort();
      if (
        questionKeys.length === expectedKeys.length &&
        questionKeys.every((key, index) => key === expectedKeys[index])
      ) {
        return category.name;
      }
    }
    return null;
  }

  class StubTypeSafeClient {
    systemOne(request) {
      const categoryName = identifyCategory(request);
      return Promise.resolve({
        model: "jev-2026-10",
        answers: answersByCategory[categoryName],
      });
    }
  }

  return {
    noul: (instructions, criteria = null) => ({
      type: "noul",
      instructions,
      criteria,
    }),
    choice: (instructions, criteria) => ({
      type: "choice",
      instructions,
      criteria,
    }),
    TypeSafeClient: StubTypeSafeClient,
  };
}

test("buildSummaryLine groups category questions, answers, and probabilities by iterating the category registry rather than a hardcoded list", async (t) => {
  const { homeDir, input } = makeLogFixture(t);

  const fifthCategory = {
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
  };

  const extendedRegistry = createCategoryRegistry([
    ...CATEGORY_REGISTRY,
    fifthCategory,
  ]);
  const extendedAnswers = {
    ...VETO_ANSWERS_BY_CATEGORY,
    scope_discipline: noulAnswers({ unrequested_refactor: 0.65 }),
  };
  const extendedState = validStateFixture({
    scope_discipline: { out_of_scope_files: 2 },
  });

  const childOutcome = await classifyTurn(input, {
    homeDir,
    registry: extendedRegistry,
    stateRunner: () => ({ status: "ok", value: extendedState }),
    sdk: makeStubSdk(extendedAnswers, extendedRegistry),
  });

  const summaryLine = buildSummaryLine({
    startedAt: new Date("2026-10-18T08:00:00.000Z"),
    context: input.context,
    model: input.model,
    provider: "jev",
    status: childOutcome.log.status,
    child: childOutcome,
    result: { status: "ok", provider: "jev", value: childOutcome.value },
    registry: extendedRegistry,
  });

  assert.deepEqual(Object.keys(summaryLine.categories), [
    ...CATEGORY_NAMES,
    "scope_discipline",
  ]);

  const expectedProbabilities = probabilitiesByCategory(
    extendedAnswers,
    extendedRegistry,
  );
  for (const category of extendedRegistry) {
    const entry = summaryLine.categories[category.name];
    assert.equal(entry.readable_name, category.readableName);
    assert.deepEqual(entry.questions, Object.keys(category.questions));
    for (const questionKey of Object.keys(category.questions)) {
      assert.equal(
        entry.answers[questionKey],
        extendedAnswers[category.name][questionKey].noul,
      );
    }
    assert.equal(entry.probability, expectedProbabilities[category.name]);
  }
});

test("buildSummaryLine sets role to dominant on the category named in verdict.reason when pause_probability reaches preset_pause_threshold and null on all other categories", async (t) => {
  const { homeDir, input } = makeLogFixture(t);
  const pauseChild = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk: makeStubSdk(PAUSE_ANSWERS_BY_CATEGORY),
  });

  const summaryLine = buildSummaryLine({
    startedAt: new Date("2026-10-18T08:01:00.000Z"),
    context: input.context,
    model: input.model,
    provider: "jev",
    status: pauseChild.log.status,
    child: pauseChild,
    result: { status: "ok", provider: "jev", value: pauseChild.value },
  });

  const expectedCombination = combineProbabilities(pauseChild.probabilities);
  const expectedDominantCategory = selectDrivingCategory(
    expectedCombination,
    PAUSE_THRESHOLDS.balanced,
  );
  assert.ok(
    summaryLine.verdict.reason.includes(`dominant=${expectedDominantCategory}`),
  );

  for (const categoryName of CATEGORY_NAMES) {
    assert.equal(
      "decision" in summaryLine.categories[categoryName],
      false,
      "per-category decision field must be replaced by role",
    );
    const expectedRole =
      categoryName === expectedDominantCategory ? "dominant" : null;
    assert.equal(summaryLine.categories[categoryName].role, expectedRole);
  }
});

test("buildSummaryLine sets role to limiting on the category named in verdict.reason when pause_probability is below preset_pause_threshold including reflection attributed to developer_intent", async (t) => {
  const { homeDir, input } = makeLogFixture(t);
  const vetoChild = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk: makeStubSdk(VETO_ANSWERS_BY_CATEGORY),
  });

  const summaryLine = buildSummaryLine({
    startedAt: new Date("2026-10-18T08:02:00.000Z"),
    context: input.context,
    model: input.model,
    provider: "jev",
    status: vetoChild.log.status,
    child: vetoChild,
    result: { status: "ok", provider: "jev", value: vetoChild.value },
  });

  const expectedCombination = combineProbabilities(vetoChild.probabilities);
  assert.ok(
    expectedCombination.developerIntent >
      expectedCombination.developerReflection,
  );
  const expectedLimitingCategory = selectDrivingCategory(
    expectedCombination,
    PAUSE_THRESHOLDS.balanced,
  );
  assert.equal(expectedLimitingCategory, developerIntentName);
  assert.ok(
    summaryLine.verdict.reason.includes(`limiting=${expectedLimitingCategory}`),
  );

  for (const categoryName of CATEGORY_NAMES) {
    const expectedRole =
      categoryName === expectedLimitingCategory ? "limiting" : null;
    assert.equal(summaryLine.categories[categoryName].role, expectedRole);
  }
});

test("buildSummaryLine records formula_inputs with full readable category names and effective_reflection from combineReflectionAndIntent", async (t) => {
  const { homeDir, input } = makeLogFixture(t);
  const vetoChild = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk: makeStubSdk(VETO_ANSWERS_BY_CATEGORY),
  });

  const summaryLine = buildSummaryLine({
    startedAt: new Date("2026-10-18T08:03:00.000Z"),
    context: input.context,
    model: input.model,
    provider: "jev",
    status: vetoChild.log.status,
    child: vetoChild,
    result: { status: "ok", provider: "jev", value: vetoChild.value },
  });

  const expectedFormula = combineProbabilities(vetoChild.probabilities);
  assert.deepEqual(summaryLine.formula_inputs, {
    decision_weight: expectedFormula.decisionWeight,
    decision_ownership: expectedFormula.decisionOwnership,
    developer_reflection: expectedFormula.developerReflection,
    developer_intent: expectedFormula.developerIntent,
    effective_reflection: combineReflectionAndIntent(
      expectedFormula.developerReflection,
      expectedFormula.developerIntent,
    ),
  });
  assert.equal("W" in summaryLine.formula_inputs, false);
  assert.equal("O" in summaryLine.formula_inputs, false);
  assert.equal("R" in summaryLine.formula_inputs, false);
});

test("buildSummaryLine records pause_probability, preset, preset_pause_threshold, confidence, and verdict", async (t) => {
  const { projectDir, homeDir, input } = makeLogFixture(t);
  saveConfig(projectDir, {
    preset: "balanced",
    classifier_model: "jev-latest",
  });

  const pauseChild = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk: makeStubSdk(PAUSE_ANSWERS_BY_CATEGORY),
  });

  const summaryLine = buildSummaryLine({
    startedAt: new Date("2026-10-18T08:04:00.000Z"),
    context: input.context,
    model: input.model,
    provider: "jev",
    status: pauseChild.log.status,
    child: pauseChild,
    result: { status: "ok", provider: "jev", value: pauseChild.value },
    homeDir,
  });

  const expectedFormula = combineProbabilities(pauseChild.probabilities);
  assert.equal(summaryLine.pause_probability, expectedFormula.pauseProbability);
  assert.equal(summaryLine.preset, "balanced");
  assert.equal(summaryLine.preset_pause_threshold, PAUSE_THRESHOLDS.balanced);
  assert.ok(summaryLine.confidence >= DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLD);
  assert.equal(summaryLine.decision_found, true);
  assert.equal(summaryLine.subcategory, "security_auth");
  assert.deepEqual(summaryLine.verdict, pauseChild.value);
});

test("runJev logs provider jev on an accepted child verdict and headless_fallback when the child fails", async (t) => {
  const { projectDir, homeDir, input } = makeLogFixture(t);
  const pauseChild = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk: makeStubSdk(PAUSE_ANSWERS_BY_CATEGORY),
  });

  runJev(input.prompt, {
    model: input.model,
    group: input.group,
    context: input.context,
    homeDir,
    spawn: () => ({
      status: 0,
      stdout: `${JSON.stringify(pauseChild)}\n`,
    }),
    fallback: () => {
      throw new Error("fallback must not run on accepted Jev verdict");
    },
  });

  const fallbackVerdict = buildVerdict(
    {
      [decisionWeightName]: 0.9,
      [decisionOwnershipName]: 0.9,
      [developerReflectionName]: 1,
      [developerIntentName]: 0,
    },
    "security_auth",
    { preset: "balanced" },
    {},
  );
  runJev(input.prompt, {
    model: input.model,
    group: input.group,
    context: input.context,
    homeDir,
    spawn: () => ({
      status: 1,
      stdout: `${JSON.stringify({ status: "api_error", error: "APITimeoutError" })}\n`,
    }),
    fallback: () => ({ status: "ok", value: fallbackVerdict }),
  });

  const [jevLine, fallbackLine] = readSummaryLines(projectDir, { homeDir });
  assert.equal(jevLine.provider, "jev");
  assert.equal(jevLine.status, "ok");
  assert.equal(jevLine.error, null);

  assert.equal(fallbackLine.provider, "headless_fallback");
  assert.equal(fallbackLine.status, "api_error");
  assert.equal(fallbackLine.error, "APITimeoutError");
});

test("buildSummaryLine records nested timings for sonnet_ms, jev_ms, per-category latency, fallback_ms, and runner_total_ms", async (t) => {
  const { homeDir, input } = makeLogFixture(t);
  const pauseChild = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk: makeStubSdk(PAUSE_ANSWERS_BY_CATEGORY),
  });

  const summaryLine = buildSummaryLine({
    startedAt: new Date("2026-10-18T08:05:00.000Z"),
    context: input.context,
    model: input.model,
    provider: "jev",
    status: pauseChild.log.status,
    child: pauseChild,
    result: { status: "ok", provider: "jev", value: pauseChild.value },
    fallbackMs: null,
    runnerTotalMs: 42,
  });

  assert.equal(typeof summaryLine.timings.sonnet_ms, "number");
  assert.equal(typeof summaryLine.timings.jev_ms, "number");
  assert.equal(summaryLine.timings.fallback_ms, null);
  assert.equal(summaryLine.timings.runner_total_ms, 42);
  assert.equal("total_ms" in summaryLine.timings, false);
  for (const categoryName of CATEGORY_NAMES) {
    assert.equal(typeof summaryLine.timings.categories[categoryName], "number");
  }
});

test("buildSummaryLine records nested models for state_model, jev_model, model_version, and fallback_model", async (t) => {
  const { homeDir, input } = makeLogFixture(t);
  const pauseChild = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk: makeStubSdk(PAUSE_ANSWERS_BY_CATEGORY),
  });

  const jevSummaryLine = buildSummaryLine({
    startedAt: new Date("2026-10-18T08:06:00.000Z"),
    context: input.context,
    model: input.model,
    provider: "jev",
    status: pauseChild.log.status,
    child: pauseChild,
    result: { status: "ok", provider: "jev", value: pauseChild.value },
  });

  assert.deepEqual(jevSummaryLine.models, {
    state_model: STATE_MODEL,
    jev_model: "jev-latest",
    model_version: "jev-2026-10",
    fallback_model: null,
  });

  const fallbackSummaryLine = buildSummaryLine({
    startedAt: new Date("2026-10-18T08:06:01.000Z"),
    context: input.context,
    model: input.model,
    provider: "headless_fallback",
    status: "api_error",
    child: { status: "api_error", error: "APITimeoutError" },
    result: { status: "ok", provider: "headless_fallback", value: {} },
  });

  assert.equal(fallbackSummaryLine.models.fallback_model, FALLBACK_MODEL);
});

test("buildSummaryLine records turn metadata including join key fields, score_before, input_file, turns_included, state_chars, and current_has_changes", async (t) => {
  const { homeDir, input } = makeLogFixture(t);
  const pauseChild = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk: makeStubSdk(PAUSE_ANSWERS_BY_CATEGORY),
  });

  const startedAt = new Date("2026-10-18T08:07:00.000Z");
  const summaryLine = buildSummaryLine({
    startedAt,
    context: input.context,
    model: input.model,
    provider: "jev",
    status: pauseChild.log.status,
    child: pauseChild,
    result: { status: "ok", provider: "jev", value: pauseChild.value },
  });

  assert.equal(summaryLine.ts, startedAt.toISOString());
  assert.equal(summaryLine.session_id, "session-stage-5");
  assert.equal(summaryLine.prompt_id, "prompt-stage-5");
  assert.equal(summaryLine.score_before, input.context.score_before);
  assert.equal(typeof summaryLine.input_file, "string");
  assert.ok(summaryLine.input_file.endsWith(".json"));
  assert.equal(summaryLine.turns_included, 1);
  assert.equal(summaryLine.state_chars, pauseChild.stateChars);
  assert.equal(summaryLine.current_has_changes, true);
});

test("buildSummaryLine emits only the nested v3 shape with no duplicated flat top-level fields and no score_after", async (t) => {
  const { homeDir, input } = makeLogFixture(t);
  const pauseChild = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk: makeStubSdk(PAUSE_ANSWERS_BY_CATEGORY),
  });

  const summaryLine = buildSummaryLine({
    startedAt: new Date("2026-10-18T08:08:00.000Z"),
    context: input.context,
    model: input.model,
    provider: "jev",
    status: pauseChild.log.status,
    child: pauseChild,
    result: { status: "ok", provider: "jev", value: pauseChild.value },
  });

  assert.equal(typeof summaryLine.formula_inputs, "object");
  assert.equal(typeof summaryLine.timings, "object");
  assert.equal(typeof summaryLine.models, "object");
  assert.equal(typeof summaryLine.categories, "object");

  for (const removedField of REMOVED_FLAT_V3_FIELDS) {
    assert.equal(
      removedField in summaryLine,
      false,
      `v3 summary line must not carry top-level ${removedField}`,
    );
  }
});

test("stop.js writes a local-trace decision record carrying the join key that matches the summary line for the same turn", (t) => {
  const sandbox = createSandbox(t);
  const sessionId = "session-join-stop-1";
  const promptId = "prompt-join-stop-1";
  const initialScore = 30;

  saveConfig(sandbox.projectDir, {
    preset: "balanced",
    classifier_model: "jev-latest",
  });
  seedStateDocument(sandbox, {
    score: initialScore,
    last_update: Date.now(),
    mutes: [],
    skip_streak: {},
    skip_totals: {},
  });

  const transcriptPath = path.join(sandbox.projectDir, "transcript.jsonl");
  fs.writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      type: "user",
      origin: { kind: "human" },
      promptId,
      message: {
        content: "<command-name>/stoic-reflect</command-name>",
      },
    })}\n`,
    "utf8",
  );

  const stopRun = sandbox.runNode(hookEntrypoint("stop"), [], {
    input: JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: sandbox.projectDir,
      stop_hook_active: false,
    }),
    env: claudeShimEnv(sandbox, VERDICT_SCENARIOS.noDecision),
  });
  assert.equal(stopRun.status, 0, stopRun.stderr);

  const summaryLines = readSummaryLines(sandbox.projectDir, {
    homeDir: sandbox.homeDir,
  });
  const stopTraceLines = readTrace(sandbox).filter(
    (line) => line.hook === "Stop",
  );

  assert.equal(summaryLines.length, 1);
  assert.equal(stopTraceLines.length, 1);

  const [summaryLine] = summaryLines;
  const [traceRecord] = stopTraceLines;

  assert.equal(traceRecord.prompt_id, promptId);
  assert.equal(traceRecord.session_id, sessionId);
  assert.equal(traceRecord.prompt_id, summaryLine.prompt_id);
  assert.equal(traceRecord.session_id, summaryLine.session_id);
  assert.equal(traceRecord.turn_ts, summaryLine.ts);
  assert.equal(
    traceRecord.score_after,
    relievedScore(
      initialScore,
      PRESETS.balanced.threshold,
      VETO_COOLDOWN_RATIO,
    ),
  );
});

test("joinSummaryWithLocalTrace attaches the traced score_after from a matching local-trace record", () => {
  const expectedScoreAfter = relievedScore(
    14,
    PRESETS.balanced.threshold,
    VETO_COOLDOWN_RATIO,
  );
  const summaryLines = [
    {
      schema_version: STATE_SCHEMA_VERSION,
      ts: "2026-10-18T08:10:00.000Z",
      session_id: "session-join-b",
      prompt_id: "prompt-join-b",
      score_before: 14,
    },
  ];
  const traceRecords = [
    {
      hook: "Stop",
      outcome: "veto",
      session_id: "session-join-b",
      prompt_id: "prompt-join-b",
      turn_ts: "2026-10-18T08:10:00.000Z",
      ts: Date.parse("2026-10-18T08:10:00.000Z") + 15,
      score_before: 14,
      score_after: expectedScoreAfter,
    },
  ];

  const joined = joinSummaryWithLocalTrace(summaryLines, traceRecords);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].score_after, expectedScoreAfter);
});

test("joinSummaryWithLocalTrace sets score_after to null when no local-trace record matches a summary line", () => {
  const summaryLines = [
    {
      schema_version: STATE_SCHEMA_VERSION,
      ts: "2026-10-18T08:11:00.000Z",
      session_id: "session-unmatched",
      prompt_id: "prompt-unmatched",
      score_before: 14,
    },
  ];
  const traceRecords = [
    {
      hook: "Stop",
      outcome: "veto",
      session_id: "session-other",
      prompt_id: "prompt-other",
      turn_ts: "2026-10-18T08:11:00.000Z",
      ts: Date.parse("2026-10-18T08:11:00.000Z"),
      score_before: 14,
      score_after: 2,
    },
  ];

  const joined = joinSummaryWithLocalTrace(summaryLines, traceRecords);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].score_after, null);
});

test("joinSummaryWithLocalTrace does not join when a trace record matches session_id and prompt_id but has a missing or different turn_ts", () => {
  const summaryLines = [
    {
      schema_version: STATE_SCHEMA_VERSION,
      ts: "2026-10-18T08:12:00.000Z",
      session_id: "session-exact-key",
      prompt_id: "prompt-exact-key",
      score_before: 14,
    },
  ];
  const traceRecords = [
    {
      hook: "Stop",
      outcome: "veto",
      session_id: "session-exact-key",
      prompt_id: "prompt-exact-key",
      ts: Date.parse("2026-10-18T08:12:00.000Z") + 10,
      score_before: 14,
      score_after: 2,
    },
    {
      hook: "Stop",
      outcome: "veto",
      session_id: "session-exact-key",
      prompt_id: "prompt-exact-key",
      turn_ts: "2026-10-18T08:12:01.000Z",
      ts: "2026-10-18T08:12:00.000Z",
      score_before: 14,
      score_after: 2,
    },
  ];

  const joined = joinSummaryWithLocalTrace(summaryLines, traceRecords);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].score_after, null);
});

test("the full record in jev-experiment/<ts>.json carries schema_version 3, the Sonnet state input summary, and all four category question and answer sets", async (t) => {
  const { projectDir, homeDir, input } = makeLogFixture(t);
  const state = validStateFixture();

  const outcome = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: state }),
    sdk: makeStubSdk(VETO_ANSWERS_BY_CATEGORY),
  });

  const record = readInputRecord(projectDir, outcome.log.input_file, {
    homeDir,
  });
  assert.equal(record.schema_version, STATE_SCHEMA_VERSION);
  assert.deepEqual(record.state, state);

  assert.equal(record.sonnet_input_summary.state_model, STATE_MODEL);
  assert.equal(record.sonnet_input_summary.prompt_id, "prompt-stage-5");
  assert.equal(record.sonnet_input_summary.turns_included, 1);
  assert.equal(record.sonnet_input_summary.state_chars, outcome.stateChars);
  assert.equal(record.sonnet_input_summary.current_has_changes, true);
  assert.equal(typeof record.sonnet_input_summary.sonnet_ms, "number");
  assert.equal(
    record.sonnet_input_summary.previous_summary.schema_version,
    STATE_SCHEMA_VERSION,
  );

  assert.deepEqual(Object.keys(record.categories), [...CATEGORY_NAMES]);
  for (const category of CATEGORY_REGISTRY) {
    const entry = record.categories[category.name];
    assert.deepEqual(entry.section, state[category.stateSection]);
    assert.deepEqual(
      Object.keys(entry.questions),
      Object.keys(category.questions),
    );
    assert.deepEqual(
      Object.keys(entry.answers),
      Object.keys(category.questions),
    );
    assert.equal(entry.probability, outcome.probabilities[category.name]);
    assert.equal(
      entry.role,
      category.name === developerIntentName ? "limiting" : null,
    );
    assert.equal(typeof entry.latency_ms, "number");
  }
});

test("the full record in jev-experiment/<ts>.json excludes raw private transcript prose beyond the validated structured state", async (t) => {
  const rawMarker = "RAW_PRIVATE_TRANSCRIPT_NEVER_PERSISTED_9941";
  const { projectDir, homeDir, input } = makeLogFixture(t, {
    rawTranscriptMarker: rawMarker,
  });

  const outcome = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk: makeStubSdk(VETO_ANSWERS_BY_CATEGORY),
  });

  const fullPath = path.join(
    inputDirPath(projectDir, homeDir),
    outcome.log.input_file,
  );
  const rawJson = fs.readFileSync(fullPath, "utf8");
  assert.equal(
    rawJson.includes(rawMarker),
    false,
    "full record must not contain raw private transcript prose beyond structured state",
  );
});

test("neither log tier ever writes an API key or environment secret present in .stoic/.env, process.env, or call options", async (t) => {
  const dotenvSecret = "ts_live_secret_from_dotenv_882190";
  const optionsSecret = "ts_live_secret_from_options_441029";
  const envSecret = "ts_live_secret_from_process_env_773104";

  const { projectDir, homeDir, input } = makeLogFixture(t, {
    apiKey: dotenvSecret,
  });

  const previousEnvSecret = process.env.TYPESAFE_API_KEY;
  process.env.TYPESAFE_API_KEY = envSecret;
  t.after(() => {
    if (previousEnvSecret === undefined) {
      delete process.env.TYPESAFE_API_KEY;
    } else {
      process.env.TYPESAFE_API_KEY = previousEnvSecret;
    }
  });

  const childOutcome = await classifyTurn(input, {
    homeDir,
    apiKey: optionsSecret,
    TYPESAFE_API_KEY: optionsSecret,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk: makeStubSdk(VETO_ANSWERS_BY_CATEGORY),
  });

  runJev(input.prompt, {
    model: input.model,
    group: input.group,
    context: input.context,
    homeDir,
    apiKey: optionsSecret,
    TYPESAFE_API_KEY: optionsSecret,
    spawn: () => ({
      status: 0,
      stdout: `${JSON.stringify(childOutcome)}\n`,
    }),
  });

  appendSummaryLine(
    projectDir,
    {
      schema_version: STATE_SCHEMA_VERSION,
      status: "ok",
      apiKey: optionsSecret,
      TYPESAFE_API_KEY: dotenvSecret,
      error: `failed with ${dotenvSecret} and ${envSecret} and ${optionsSecret}`,
    },
    { homeDir, apiKey: optionsSecret },
  );

  const extraFile = writeInputFile(
    projectDir,
    new Date("2026-10-18T09:00:00.000Z"),
    {
      state: validStateFixture(),
      apiKey: optionsSecret,
      TYPESAFE_API_KEY: dotenvSecret,
      note: `leaked ${dotenvSecret} ${envSecret} ${optionsSecret}`,
    },
    { homeDir, apiKey: optionsSecret },
  );

  const summaryRaw = fs.readFileSync(
    summaryLogPath(projectDir, homeDir),
    "utf8",
  );
  const firstInputRaw = fs.readFileSync(
    path.join(inputDirPath(projectDir, homeDir), childOutcome.log.input_file),
    "utf8",
  );
  const secondInputRaw = fs.readFileSync(
    path.join(inputDirPath(projectDir, homeDir), extraFile),
    "utf8",
  );

  for (const secret of [dotenvSecret, optionsSecret, envSecret]) {
    assert.equal(
      summaryRaw.includes(secret),
      false,
      `summary log must never contain secret ${secret}`,
    );
    assert.equal(
      firstInputRaw.includes(secret),
      false,
      `turn input file must never contain secret ${secret}`,
    );
    assert.equal(
      secondInputRaw.includes(secret),
      false,
      `sanitized input file must never contain secret ${secret}`,
    );
  }
});

test("appendSummaryLine and writeInputFile swallow filesystem failures without throwing", (t) => {
  const brokenProjectDir = makeTempDir(t, "stoic-jev-broken-proj-");
  const brokenHomeDir = makeTempDir(t, "stoic-jev-broken-home-");

  const blockedSummaryPath = summaryLogPath(brokenProjectDir, brokenHomeDir);
  const blockedInputDir = inputDirPath(brokenProjectDir, brokenHomeDir);
  fs.mkdirSync(blockedSummaryPath, { recursive: true });
  fs.writeFileSync(blockedInputDir, "not-a-directory", "utf8");

  assert.doesNotThrow(() =>
    appendSummaryLine(
      brokenProjectDir,
      { schema_version: STATE_SCHEMA_VERSION, status: "ok" },
      { homeDir: brokenHomeDir },
    ),
  );
  assert.equal(
    writeInputFile(
      brokenProjectDir,
      new Date("2026-10-18T10:00:00.000Z"),
      { state: validStateFixture() },
      { homeDir: brokenHomeDir },
    ),
    null,
  );
});

test("appendSummaryLine and writeInputFile preserve all prior log records across turns without pruning", (t) => {
  const cleanProjectDir = makeTempDir(t, "stoic-jev-keep-proj-");
  const cleanHomeDir = makeTempDir(t, "stoic-jev-keep-home-");
  const recordCount = 5;

  for (let index = 0; index < recordCount; index += 1) {
    const moment = new Date(Date.UTC(2026, 9, 18, 10, 0, index));
    const fileName = writeInputFile(
      cleanProjectDir,
      moment,
      { state: validStateFixture(), turn_index: index },
      { homeDir: cleanHomeDir },
    );
    assert.equal(typeof fileName, "string");
    appendSummaryLine(
      cleanProjectDir,
      {
        schema_version: STATE_SCHEMA_VERSION,
        ts: moment.toISOString(),
        prompt_id: `prompt-${index}`,
        status: "ok",
        input_file: fileName,
      },
      { homeDir: cleanHomeDir },
    );
  }

  const lines = readSummaryLines(cleanProjectDir, { homeDir: cleanHomeDir });
  const inputFiles = fs.readdirSync(
    inputDirPath(cleanProjectDir, cleanHomeDir),
  );
  assert.equal(lines.length, recordCount);
  assert.equal(inputFiles.length, recordCount);
  assert.equal(SUMMARY_FILE_NAME, "jev-experiment.jsonl");
  assert.equal(INPUT_DIR_NAME, "jev-experiment");
});

test("readSummaryLines normalizes v1, v2, and v3 lines into the nested shape while dropping blank or torn lines", (t) => {
  const { projectDir, homeDir, input } = makeLogFixture(t);

  const v1Line = {
    ts: "2026-10-01T10:00:00.000Z",
    session_id: "session-v1",
    prompt_id: "prompt-v1",
    provider: "jev",
    status: "ok",
    error: null,
    latency_ms: 310,
    model_version: "jev-2026-09",
    significant_choice: 0.8,
    visible_reflection: 0.2,
    context_sufficient: 0.9,
    category: "security_auth",
    category_probability: 0.85,
    decision_found: true,
    confidence: 0.8,
    state_chars: 420,
    turns_included: 2,
    input_file: "2026-10-01T10-00-00-000Z.json",
  };

  const v2Line = {
    ts: "2026-10-05T10:00:00.000Z",
    session_id: "session-v2",
    prompt_id: "prompt-v2",
    provider: "jev",
    status: "ok",
    error: null,
    latency_ms: 280,
    model_version: "jev-2026-10",
    reflex_approval: 0.75,
    assistant_choice: 0.8,
    developer_named_it: 0.1,
    category: "architecture_pattern",
    category_probability: 0.9,
    decision_found: true,
    confidence: 0.75,
    state_chars: 510,
    turns_included: 3,
    input_file: "2026-10-05T10-00-00-000Z.json",
  };

  const v3Line = buildSummaryLine({
    startedAt: new Date("2026-10-18T10:00:00.000Z"),
    context: input.context,
    model: input.model,
    provider: "jev",
    status: "ok",
    totalMs: 315,
    child: {
      status: "ok",
      value: buildVerdict(
        {
          [decisionWeightName]: 0.8,
          [decisionOwnershipName]: 0.8,
          [developerReflectionName]: 0.1,
          [developerIntentName]: 0.2,
        },
        "security_auth",
        { preset: "balanced" },
        {},
      ),
      probabilities: {
        [decisionWeightName]: 0.8,
        [decisionOwnershipName]: 0.8,
        [developerReflectionName]: 0.1,
        [developerIntentName]: 0.2,
      },
      log: {
        status: "ok",
        prompt_id: "prompt-v3",
        model_version: "jev-2026-10",
        probabilities: {
          [decisionWeightName]: 0.8,
          [decisionOwnershipName]: 0.8,
          [developerReflectionName]: 0.1,
          [developerIntentName]: 0.2,
        },
        answers_by_category: PAUSE_ANSWERS_BY_CATEGORY,
        category_latency_ms: {
          [developerIntentName]: 10,
          [decisionOwnershipName]: 12,
          [decisionWeightName]: 14,
          [developerReflectionName]: 11,
        },
        sonnet_ms: 300,
        jev_ms: 15,
        current_has_changes: true,
        state_chars: 600,
        turns_included: 1,
        input_file: "2026-10-18T10-00-00-000Z.json",
      },
    },
    result: {
      status: "ok",
      provider: "jev",
      value: buildVerdict(
        {
          [decisionWeightName]: 0.8,
          [decisionOwnershipName]: 0.8,
          [developerReflectionName]: 0.1,
          [developerIntentName]: 0.2,
        },
        "security_auth",
        { preset: "balanced" },
        {},
      ),
    },
  });

  const filePath = summaryLogPath(projectDir, homeDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    [
      JSON.stringify(v1Line),
      "",
      "{torn json line",
      JSON.stringify(v2Line),
      JSON.stringify(v3Line),
    ].join("\n") + "\n",
    "utf8",
  );

  const parsedLines = readSummaryLines(projectDir, { homeDir });
  assert.equal(parsedLines.length, 3);

  assert.equal(parsedLines[0].schema_version, 1);
  assert.equal(parsedLines[0].prompt_id, "prompt-v1");
  assert.equal(parsedLines[0].formula_inputs.decision_weight, 0.8);
  assert.equal(parsedLines[0].formula_inputs.developer_reflection, 0.2);
  assert.equal(parsedLines[0].timings.runner_total_ms, 310);
  assert.equal(parsedLines[0].models.model_version, "jev-2026-09");
  assert.equal("latency_ms" in parsedLines[0], false);
  assert.equal("model_version" in parsedLines[0], false);

  assert.equal(parsedLines[1].schema_version, 2);
  assert.equal(parsedLines[1].prompt_id, "prompt-v2");
  assert.equal(
    parsedLines[1].formula_inputs.developer_reflection,
    1 - v2Line.reflex_approval,
  );
  assert.equal(parsedLines[1].formula_inputs.decision_ownership, 0.8);
  assert.equal(parsedLines[1].formula_inputs.developer_intent, 0.1);
  assert.equal(parsedLines[1].timings.runner_total_ms, 280);
  assert.equal(parsedLines[1].models.model_version, "jev-2026-10");
  assert.equal("latency_ms" in parsedLines[1], false);
  assert.equal("model_version" in parsedLines[1], false);

  assert.equal(parsedLines[2].schema_version, STATE_SCHEMA_VERSION);
  assert.equal(parsedLines[2].prompt_id, "prompt-v3");
  assert.deepEqual(Object.keys(parsedLines[2].categories), [...CATEGORY_NAMES]);
  assert.equal(parsedLines[2].timings.runner_total_ms, 315);
  assert.equal("total_ms" in parsedLines[2].timings, false);
  assert.equal(parsedLines[2].models.model_version, "jev-2026-10");
});
