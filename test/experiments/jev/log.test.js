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
  resolveKnobs,
  saveConfig,
} from "../../../src/io/config/config.js";
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

/** Sample per-category answers where reflection and intent veto the pause. */
const VETO_ANSWERS_BY_CATEGORY = Object.freeze({
  developer_intent: noulAnswers({
    own_idea: 0.2,
    refining_own_proposal: 0.8,
    specific_request: 0.7,
    accepting_ai_proposal: 0.1,
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
    reflex_approval: 0.1,
    justified_choice: 0.7,
    asked_questions: 0.6,
    suggested_fixes: 0.4,
    bare_pick_streak: 0,
  }),
});

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

test("buildSummaryLine groups category questions, answers, probabilities, and decisions by iterating the category registry rather than a hardcoded list", async (t) => {
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

  assert.equal(childOutcome.status, "ok");

  const summaryLine = buildSummaryLine({
    startedAt: new Date("2026-10-18T08:00:00.000Z"),
    context: input.context,
    model: input.model,
    group: input.group,
    provider: "jev",
    status: childOutcome.log.status,
    child: childOutcome,
    result: { status: "ok", provider: "jev", value: childOutcome.value },
    registry: extendedRegistry,
  });

  assert.equal(summaryLine.schema_version, STATE_SCHEMA_VERSION);
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
    assert.deepEqual(
      Object.keys(entry.answers),
      Object.keys(category.questions),
    );
    for (const questionKey of Object.keys(category.questions)) {
      assert.equal(
        entry.answers[questionKey],
        extendedAnswers[category.name][questionKey].noul,
      );
    }
    assert.equal(entry.probability, expectedProbabilities[category.name]);
    assert.equal(
      ["pause", "no_pause"].includes(entry.decision),
      true,
      `${category.name} decision must be pause or no_pause`,
    );
    assert.equal(typeof entry.latency_ms, "number");
    assert.ok(entry.latency_ms >= 0);
  }
});

test("the summary line records the formula inputs, pause_probability, preset and pause threshold, verdict, provider, cooled score_after, per-call timings, model ids, and turn metadata", async (t) => {
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

  const pauseResult = runJev(input.prompt, {
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

  assert.equal(pauseResult.status, "ok");
  assert.equal(pauseResult.provider, "jev");

  const vetoChild = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk: makeStubSdk(VETO_ANSWERS_BY_CATEGORY),
  });

  runJev(input.prompt, {
    model: input.model,
    group: input.group,
    context: input.context,
    homeDir,
    spawn: () => ({
      status: 0,
      stdout: `${JSON.stringify(vetoChild)}\n`,
    }),
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

  const lines = readSummaryLines(projectDir, { homeDir });
  assert.equal(lines.length, 3);

  const [pauseLine, vetoLine, fallbackLine] = lines;
  const expectedPauseFormula = combineProbabilities(pauseChild.probabilities);
  const knobs = resolveKnobs({ preset: "balanced" }, {});

  assert.equal(pauseLine.schema_version, STATE_SCHEMA_VERSION);
  assert.equal(pauseLine.provider, "jev");
  assert.equal(pauseLine.status, "ok");
  assert.equal(pauseLine.error, null);
  assert.equal(pauseLine.preset, "balanced");
  assert.equal(pauseLine.preset_pause_threshold, PAUSE_THRESHOLDS.balanced);

  assert.equal(pauseLine.decision_weight, expectedPauseFormula.decisionWeight);
  assert.equal(
    pauseLine.decision_ownership,
    expectedPauseFormula.decisionOwnership,
  );
  assert.equal(
    pauseLine.developer_reflection,
    expectedPauseFormula.developerReflection,
  );
  assert.equal(
    pauseLine.developer_intent,
    expectedPauseFormula.developerIntent,
  );
  assert.equal(
    pauseLine.effective_reflection,
    combineReflectionAndIntent(
      expectedPauseFormula.developerReflection,
      expectedPauseFormula.developerIntent,
    ),
  );
  assert.deepEqual(pauseLine.formula_inputs, {
    decision_weight: expectedPauseFormula.decisionWeight,
    decision_ownership: expectedPauseFormula.decisionOwnership,
    developer_reflection: expectedPauseFormula.developerReflection,
    developer_intent: expectedPauseFormula.developerIntent,
    effective_reflection: expectedPauseFormula.effectiveReflection,
  });
  assert.equal("W" in pauseLine, false);
  assert.equal("O" in pauseLine, false);
  assert.equal("R" in pauseLine, false);

  assert.equal(
    pauseLine.pause_probability,
    expectedPauseFormula.pauseProbability,
  );
  assert.ok(pauseLine.confidence >= DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLD);
  assert.equal(pauseLine.decision_found, true);
  assert.equal(pauseLine.subcategory, "security_auth");
  assert.deepEqual(pauseLine.verdict, pauseChild.value);

  assert.equal(pauseLine.score_before, input.context.score_before);
  assert.equal(
    pauseLine.score_after,
    relievedScore(
      input.context.score_before,
      knobs.threshold,
      knobs.cooldown_ratio,
    ),
  );

  assert.equal(vetoLine.score_before, input.context.score_before);
  assert.equal(
    vetoLine.score_after,
    relievedScore(
      input.context.score_before,
      knobs.threshold,
      VETO_COOLDOWN_RATIO,
    ),
  );

  assert.equal(typeof pauseLine.sonnet_ms, "number");
  assert.equal(typeof pauseLine.jev_ms, "number");
  assert.equal(pauseLine.fallback_ms, null);
  assert.equal(typeof pauseLine.total_ms, "number");
  assert.equal(pauseLine.latency_ms, pauseLine.total_ms);
  for (const categoryName of CATEGORY_NAMES) {
    assert.equal(typeof pauseLine.timings.categories[categoryName], "number");
  }

  assert.equal(pauseLine.state_model, STATE_MODEL);
  assert.equal(pauseLine.jev_model, "jev-latest");
  assert.equal(pauseLine.model_version, "jev-2026-10");
  assert.equal(pauseLine.fallback_model, null);
  assert.equal(pauseLine.prompt_id, "prompt-stage-5");
  assert.equal(typeof pauseLine.input_file, "string");
  assert.ok(pauseLine.input_file.endsWith(".json"));
  assert.equal(pauseLine.turns_included, 1);
  assert.ok(pauseLine.state_chars > 0);
  assert.equal(pauseLine.current_has_changes, true);

  assert.equal(fallbackLine.provider, "headless_fallback");
  assert.equal(fallbackLine.status, "api_error");
  assert.equal(fallbackLine.error, "APITimeoutError");
  assert.equal(fallbackLine.fallback_model, FALLBACK_MODEL);
  assert.equal(typeof fallbackLine.fallback_ms, "number");
  assert.equal(
    fallbackLine.score_after,
    relievedScore(
      input.context.score_before,
      knobs.threshold,
      VETO_COOLDOWN_RATIO,
    ),
  );
});

test("the full record in jev-experiment/<ts>.json carries schema_version 3, the Sonnet state input summary without raw private transcript, and all four category question and answer sets", async (t) => {
  const rawMarker = "RAW_PRIVATE_TRANSCRIPT_NEVER_PERSISTED_9941";
  const { projectDir, homeDir, input } = makeLogFixture(t, {
    rawTranscriptMarker: rawMarker,
  });
  const state = validStateFixture();

  const outcome = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: state }),
    sdk: makeStubSdk(VETO_ANSWERS_BY_CATEGORY),
  });

  assert.equal(outcome.status, "ok");
  assert.equal(typeof outcome.log.input_file, "string");

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
    assert.equal(typeof entry.decision, "string");
    assert.equal(typeof entry.latency_ms, "number");
  }
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

test("logging swallows filesystem failures without throwing in both tiers and preserves all prior log records without pruning", (t) => {
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

test("readSummaryLines parses a mixed jev-experiment.jsonl containing v1, v2, and v3 lines while dropping blank or torn lines", (t) => {
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
    group: input.group,
    provider: "jev",
    status: "ok",
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
  assert.equal(parsedLines[0].significant_choice, 0.8);
  assert.equal(parsedLines[0].visible_reflection, 0.2);
  assert.equal(parsedLines[0].context_sufficient, 0.9);
  assert.equal(parsedLines[0].total_ms, 310);

  assert.equal(parsedLines[1].schema_version, 2);
  assert.equal(parsedLines[1].prompt_id, "prompt-v2");
  assert.equal(parsedLines[1].reflex_approval, 0.75);
  assert.equal(parsedLines[1].assistant_choice, 0.8);
  assert.equal(parsedLines[1].developer_named_it, 0.1);
  assert.equal(parsedLines[1].total_ms, 280);

  assert.equal(parsedLines[2].schema_version, STATE_SCHEMA_VERSION);
  assert.equal(parsedLines[2].prompt_id, "prompt-v3");
  assert.deepEqual(Object.keys(parsedLines[2].categories), [...CATEGORY_NAMES]);
  assert.equal(typeof parsedLines[2].pause_probability, "number");
});
