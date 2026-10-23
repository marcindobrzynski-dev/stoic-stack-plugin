import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CATEGORY_NAMES,
  CATEGORY_REGISTRY,
  probabilitiesByCategory,
} from "../../../experiments/jev/categories/index.js";
import { name as decisionOwnershipName } from "../../../experiments/jev/categories/decision-ownership.js";
import { name as decisionWeightName } from "../../../experiments/jev/categories/decision-weight.js";
import { name as developerIntentName } from "../../../experiments/jev/categories/developer-intent.js";
import { name as developerReflectionName } from "../../../experiments/jev/categories/developer-reflection.js";
import {
  FALLBACK_MODEL,
  INTENT_MAX_REDUCTION,
  PAUSE_THRESHOLDS,
  REFLECTION_MAX_REDUCTION,
  STATE_SCHEMA_VERSION,
} from "../../../experiments/jev/constants.js";
import {
  buildVerdict,
  classifyTurn,
  combineProbabilities,
} from "../../../experiments/jev/run.js";
import {
  summaryLogPath,
  buildSummaryLine,
} from "../../../experiments/jev/log.js";
import { runJev } from "../../../experiments/jev/runner.js";
import {
  DECISION_KIND_VALUES,
  DECISION_MADE_BY_VALUES,
  INTENT_SCALE_VALUES,
} from "../../../experiments/jev/state-schema.js";
import {
  CATEGORY_TIMEOUT_MS,
  FALLBACK_TIMEOUT_MS,
  JEV_TIMEOUT_MS,
  MARGIN_MS,
  STATE_TIMEOUT_MS,
} from "../../../experiments/jev/timing.js";
import { decideFire } from "../../../src/hooks/stop-decision.js";
import {
  JEV_GENERAL_CATEGORY,
  VETO_REASONS,
  classify,
} from "../../../src/io/classifier.js";
import {
  DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLD,
  DEFAULT_CLASSIFIER_MODEL,
  PRESET_NAMES,
  PRESETS,
  saveConfig,
} from "../../../src/io/config/config.js";
import { saveState } from "../../../src/io/state.js";
import { makeTempDir } from "../../helpers/temp-dir.js";

const HOOKS_JSON_PATH = fileURLToPath(
  new URL("../../../hooks/hooks.json", import.meta.url),
);

/** Wrap a plain map of numbers into TypeSafe `noul` answer objects. */
function noulAnswers(values) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      { type: "noul", noul: value },
    ]),
  );
}

/** Valid sample answers for each registered category. */
const VALID_ANSWERS_BY_CATEGORY = Object.freeze({
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
    justified_choice: 0.7,
    asked_questions: 0.6,
    discussed_alternatives: 0.2,
    suggested_fixes: 0.4,
    bare_pick_streak: 0.0,
  }),
});

/**
 * Build a valid v3 structured state fixture with distinct values per section.
 *
 * @param {object} [overrides] - Optional top-level overrides.
 * @returns {object} Complete v3 structured state object.
 */
function validStateFixture(overrides = {}) {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    developer_intent: {
      developer_request: "Add exponential backoff to webhook delivery.",
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
      },
      bare_pick_streak: 0,
    },
    area_label: "api_integration_marker",
    summary: "Rolling summary marker that must never reach any Jev request.",
    ...overrides,
  };
}

/**
 * Create a project directory containing a synthetic transcript and optionally
 * `.stoic/.env` with a fake TypeSafe API key.
 *
 * @param {object} t - Node test context.
 * @param {{ withKey?: boolean }} [options] - Setup options.
 * @returns {{ projectDir: string, homeDir: string, input: object }}
 *   Prepared test fixture.
 */
function makeTurnFixture(t, options = {}) {
  const withKey = options.withKey ?? true;
  const projectDir = makeTempDir(t, "stoic-jev-run-proj-");
  const homeDir = makeTempDir(t, "stoic-jev-run-home-");
  const transcriptPath = path.join(projectDir, "transcript.jsonl");

  const lines = [
    JSON.stringify({
      type: "user",
      origin: { kind: "human" },
      promptId: "prompt-stage-3",
      message: { content: "Add exponential backoff to webhook delivery." },
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Added exponential backoff." },
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

  if (withKey) {
    const stoicDir = path.join(projectDir, ".stoic");
    fs.mkdirSync(stoicDir, { recursive: true });
    fs.writeFileSync(
      path.join(stoicDir, ".env"),
      "TYPESAFE_API_KEY=test-key-not-real\n",
      "utf8",
    );
  }

  const input = {
    prompt: "Classifier prompt text",
    model: "jev-latest",
    group: {
      prompt: "Add exponential backoff to webhook delivery.",
      edit_count: 1,
      lines_added: 1,
      lines_removed: 0,
      edits: [{ file: "src/webhook.js", lines_added: 1, lines_removed: 0 }],
    },
    context: {
      projectDir,
      stopInput: {
        transcript_path: transcriptPath,
        last_assistant_message: "Added exponential backoff with 4 retries.",
        session_id: "session-stage-3",
        cwd: projectDir,
      },
    },
  };

  return { projectDir, homeDir, input };
}

/**
 * Identify which category a Jev `systemOne` request belongs to from its
 * question keys.
 *
 * @param {object} request - `{ state, questions, model }` passed to `systemOne`.
 * @returns {string|null} Matching category name.
 */
function categoryForRequest(request) {
  const questionKeys = Object.keys(request?.questions ?? {}).sort();
  for (const category of CATEGORY_REGISTRY) {
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

/**
 * Build a stubbed TypeSafe SDK seam recording client construction and
 * per-category `systemOne` calls.
 *
 * @param {(categoryName: string, request: object) => Promise<object>} [handler]
 *   Optional per-category response handler.
 * @returns {{
 *   sdk: object,
 *   clientConfigs: object[],
 *   requestsByCategory: Record<string, object>,
 *   callOrder: string[],
 * }} Stub SDK and recorded calls.
 */
function makeStubSdk(handler) {
  const clientConfigs = [];
  const requestsByCategory = {};
  const callOrder = [];

  class StubTypeSafeClient {
    constructor(config) {
      clientConfigs.push(config);
    }

    systemOne(request) {
      const categoryName = categoryForRequest(request);
      callOrder.push(categoryName);
      if (categoryName) {
        requestsByCategory[categoryName] = request;
      }
      if (typeof handler === "function") {
        return handler(categoryName, request);
      }
      return Promise.resolve({
        model: "jev-2026-10",
        answers: VALID_ANSWERS_BY_CATEGORY[categoryName],
      });
    }
  }

  const sdk = {
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

  return { sdk, clientConfigs, requestsByCategory, callOrder };
}

test("each category receives only its own section in its Jev request, with no sibling sections, area_label, or summary", async (t) => {
  const { homeDir, input } = makeTurnFixture(t);
  const state = validStateFixture();
  const { sdk, requestsByCategory } = makeStubSdk();

  const outcome = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: state }),
    sdk,
  });

  assert.equal(outcome.status, "ok");
  assert.deepEqual(
    Object.keys(requestsByCategory).sort(),
    [...CATEGORY_NAMES].sort(),
  );

  for (const category of CATEGORY_REGISTRY) {
    const request = requestsByCategory[category.name];
    assert.equal(typeof request.state, "string");
    assert.equal(request.model, "jev-latest");
    assert.deepEqual(
      Object.keys(request.questions),
      Object.keys(category.questions),
    );

    const parsedSection = JSON.parse(request.state);
    assert.deepEqual(parsedSection, state[category.stateSection]);

    for (const sibling of CATEGORY_REGISTRY) {
      if (sibling.name !== category.name) {
        assert.equal(
          sibling.stateSection in parsedSection,
          false,
          `${category.name} request must not include ${sibling.stateSection}`,
        );
        assert.equal(
          request.state.includes(sibling.stateSection),
          false,
          `${category.name} serialized state must not mention ${sibling.stateSection}`,
        );
      }
    }

    assert.equal("area_label" in parsedSection, false);
    assert.equal("summary" in parsedSection, false);
    assert.equal("schema_version" in parsedSection, false);
    assert.equal(request.state.includes(state.area_label), false);
    assert.equal(request.state.includes(state.summary), false);
  }
});

test("classifyTurn makes one Sonnet call and issues all four category Jev requests in parallel with CATEGORY_TIMEOUT_MS and zero retries", async (t) => {
  const { homeDir, input } = makeTurnFixture(t);
  const sonnetCalls = [];
  const pendingResolvers = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const { sdk, clientConfigs, callOrder } = makeStubSdk((categoryName) => {
    inFlight += 1;
    if (inFlight > maxInFlight) {
      maxInFlight = inFlight;
    }
    return new Promise((resolve) => {
      pendingResolvers.push(() => {
        inFlight -= 1;
        resolve({
          model: "jev-2026-10",
          answers: VALID_ANSWERS_BY_CATEGORY[categoryName],
        });
      });
    });
  });

  const turnPromise = classifyTurn(input, {
    homeDir,
    stateRunner: (prompt, options) => {
      sonnetCalls.push({ prompt, options });
      return { status: "ok", value: validStateFixture() };
    },
    sdk,
  });

  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sonnetCalls.length, 1);
  assert.equal(
    pendingResolvers.length,
    CATEGORY_REGISTRY.length,
    "all category Jev requests must start in parallel before any resolves",
  );
  assert.equal(maxInFlight, CATEGORY_REGISTRY.length);
  assert.deepEqual(callOrder, [...CATEGORY_NAMES]);

  for (const resolveCall of pendingResolvers) {
    resolveCall();
  }

  const outcome = await turnPromise;
  assert.equal(outcome.status, "ok");
  assert.equal(clientConfigs.length, 1);
  assert.equal(clientConfigs[0].timeout, CATEGORY_TIMEOUT_MS);
  assert.deepEqual(clientConfigs[0].retry, { maxRetries: 0 });
});

test("a failed Jev category is discarded and Haiku classifies the same context", async (t) => {
  const { homeDir, input } = makeTurnFixture(t);
  const { sdk } = makeStubSdk((categoryName) => {
    if (categoryName === "decision_weight") {
      const timeoutError = new Error("SECRET_INTERNAL_BODY_DO_NOT_LEAK");
      timeoutError.name = "APITimeoutError";
      return Promise.reject(timeoutError);
    }
    return Promise.resolve({
      model: "jev-2026-10",
      answers: VALID_ANSWERS_BY_CATEGORY[categoryName],
    });
  });

  const outcome = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk,
  });

  assert.equal(outcome.log.category_errors.decision_weight, "APITimeoutError");
  assert.equal(
    JSON.stringify(outcome).includes("SECRET_INTERNAL_BODY_DO_NOT_LEAK"),
    false,
  );

  const haikuVerdict = {
    decision_found: true,
    subcategory: "security_auth",
    reason: "The retry cap is a security-sensitive choice.",
    confidence: 0.9,
  };
  const fallbackCalls = [];
  let jevPrompt = null;
  const decision = classify(
    input.group,
    { classifier_model: "jev-latest" },
    input.context,
    {
      runner: (prompt, options) => {
        jevPrompt = prompt;
        return runJev(prompt, {
          ...options,
          homeDir,
          spawn: () => ({
            status: 0,
            stdout: `${JSON.stringify(outcome)}\n`,
          }),
          fallback: (fallbackPrompt, fallbackOptions) => {
            fallbackCalls.push({
              prompt: fallbackPrompt,
              options: fallbackOptions,
            });
            return { status: "ok", value: haikuVerdict };
          },
        });
      },
    },
  );

  assert.equal(fallbackCalls.length, 1);
  assert.equal(fallbackCalls[0].prompt, jevPrompt);
  assert.deepEqual(fallbackCalls[0].options.group, input.group);
  assert.deepEqual(fallbackCalls[0].options.context, input.context);
  assert.equal(fallbackCalls[0].options.model, FALLBACK_MODEL);
  assert.equal(fallbackCalls[0].options.timeoutMs, FALLBACK_TIMEOUT_MS);
  assert.equal(decision.status, "pass");
  assert.equal(decision.classification.subcategory, "security_auth");
  assert.equal(decision.classification.category, "security");
});

test("a failed Jev category whose Haiku fallback also fails is a classifier error", async (t) => {
  const { homeDir, input } = makeTurnFixture(t);
  const { sdk } = makeStubSdk((categoryName) => {
    if (categoryName === "decision_weight") {
      const timeoutError = new Error("SECRET_INTERNAL_BODY_DO_NOT_LEAK");
      timeoutError.name = "APITimeoutError";
      return Promise.reject(timeoutError);
    }
    return Promise.resolve({
      model: "jev-2026-10",
      answers: VALID_ANSWERS_BY_CATEGORY[categoryName],
    });
  });

  const outcome = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk,
  });

  const decision = classify(
    input.group,
    { classifier_model: "jev-latest" },
    input.context,
    {
      runner: (prompt, options) =>
        runJev(prompt, {
          ...options,
          homeDir,
          spawn: () => ({
            status: 0,
            stdout: `${JSON.stringify(outcome)}\n`,
          }),
          fallback: () => ({ status: "unavailable", reason: "cli_failed" }),
        }),
    },
  );

  assert.equal(decision.status, "veto");
  assert.equal(decision.reason, "no_classification");
});

test("unusable answers in one category count as a failed category and return a negative verdict", async (t) => {
  const { homeDir, input } = makeTurnFixture(t);
  const { sdk } = makeStubSdk((categoryName) => {
    if (categoryName === "developer_reflection") {
      return Promise.resolve({
        model: "jev-2026-10",
        answers: {
          ...VALID_ANSWERS_BY_CATEGORY.developer_reflection,
          justified_choice: { type: "noul", noul: 1.5 },
        },
      });
    }
    return Promise.resolve({
      model: "jev-2026-10",
      answers: VALID_ANSWERS_BY_CATEGORY[categoryName],
    });
  });

  const outcome = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk,
  });

  assert.equal(outcome.status, "ok");
  assert.equal(outcome.value.decision_found, false);
  assert.equal(outcome.value.reason.includes("developer_reflection"), true);
  assert.equal(outcome.value.reason.includes("unusable_answer"), true);
  assert.equal(outcome.probabilities.developer_reflection, null);
  assert.equal(typeof outcome.probabilities.developer_intent, "number");
});

test("when all four categories fail, classifyTurn returns an infrastructure status and runJev falls back", async (t) => {
  const { homeDir, input } = makeTurnFixture(t);

  const rejectingSdk = makeStubSdk(() => {
    const error = new Error("DO_NOT_LEAK_MESSAGE");
    error.name = "APITimeoutError";
    return Promise.reject(error);
  });

  const rejectedOutcome = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk: rejectingSdk.sdk,
  });

  assert.notEqual(rejectedOutcome.status, "ok");
  assert.equal(rejectedOutcome.status, "api_error");
  assert.equal(rejectedOutcome.value, undefined);
  assert.equal(rejectedOutcome.error.includes("DO_NOT_LEAK_MESSAGE"), false);

  const unusableSdk = makeStubSdk(() =>
    Promise.resolve({ model: "jev-2026-10", answers: {} }),
  );

  const unusableOutcome = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk: unusableSdk.sdk,
  });

  assert.notEqual(unusableOutcome.status, "ok");
  assert.equal(unusableOutcome.status, "unusable_answer");
  assert.equal(unusableOutcome.value, undefined);

  const fallbackCalls = [];
  const fallbackVerdict = {
    decision_found: false,
    subcategory: null,
    reason: "fallback answered",
    confidence: 0.2,
  };

  const runnerResult = runJev(input.prompt, {
    model: input.model,
    group: input.group,
    context: input.context,
    homeDir,
    spawn: () => ({
      status: 1,
      stdout: `${JSON.stringify(rejectedOutcome)}\n`,
    }),
    fallback: (prompt, options) => {
      fallbackCalls.push({ prompt, options });
      return { status: "ok", value: fallbackVerdict };
    },
  });

  assert.equal(fallbackCalls.length, 1);
  assert.equal(fallbackCalls[0].options.model, DEFAULT_CLASSIFIER_MODEL);
  assert.equal(fallbackCalls[0].options.timeoutMs, FALLBACK_TIMEOUT_MS);
  assert.deepEqual(runnerResult, {
    status: "ok",
    provider: "headless_fallback",
    value: fallbackVerdict,
  });
});

test("when the Sonnet structured state is invalid or unavailable, classifyTurn returns an infrastructure status and makes no Jev calls", async (t) => {
  const { homeDir, input } = makeTurnFixture(t);
  const { sdk, callOrder } = makeStubSdk();

  const unavailableOutcome = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({ status: "unavailable", reason: "timeout" }),
    sdk,
  });

  assert.equal(unavailableOutcome.status, "state_unavailable");
  assert.equal(unavailableOutcome.reason, "timeout");
  assert.equal(unavailableOutcome.error, "timeout");
  assert.equal(unavailableOutcome.value, undefined);
  assert.equal(callOrder.length, 0);

  const invalidOutcome = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({
      status: "ok",
      value: validStateFixture({ schema_version: 2 }),
    }),
    sdk,
  });

  assert.equal(invalidOutcome.status, "state_invalid");
  assert.equal(invalidOutcome.reason, "invalid_schema_version");
  assert.equal(invalidOutcome.error, "invalid_schema_version");
  assert.equal(invalidOutcome.value, undefined);
  assert.equal(callOrder.length, 0);
});

test("a missing API key or missing SDK returns an infrastructure status without making Jev calls", async (t) => {
  const keylessFixture = makeTurnFixture(t, { withKey: false });
  const { sdk, callOrder } = makeStubSdk();

  const noKeyOutcome = await classifyTurn(keylessFixture.input, {
    homeDir: keylessFixture.homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk,
  });

  assert.equal(noKeyOutcome.status, "no_key");
  assert.equal(noKeyOutcome.value, undefined);
  assert.equal(callOrder.length, 0);

  const keyedFixture = makeTurnFixture(t, { withKey: true });
  const sdkMissingOutcome = await classifyTurn(keyedFixture.input, {
    homeDir: keyedFixture.homeDir,
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
    sdk: async () => {
      throw new Error("Cannot find package '@typesafe-ai/sdk'");
    },
  });

  assert.equal(sdkMissingOutcome.status, "sdk_missing");
  assert.equal(sdkMissingOutcome.value, undefined);
});

test("a successful run returns per-category probabilities, preserves turn metadata, and maps them into the combined verdict", async (t) => {
  const { homeDir, input } = makeTurnFixture(t);
  const { sdk } = makeStubSdk();

  const outcome = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({
      status: "ok",
      value: validStateFixture({ area_label: "security_auth" }),
    }),
    sdk,
  });

  const expectedProbabilities = probabilitiesByCategory(
    VALID_ANSWERS_BY_CATEGORY,
    CATEGORY_REGISTRY,
  );

  assert.equal(outcome.status, "ok");
  assert.deepEqual(outcome.probabilities, expectedProbabilities);
  assert.equal(outcome.currentHasChanges, true);
  assert.equal(outcome.promptId, "prompt-stage-3");
  assert.equal(typeof outcome.stateChars, "number");
  assert.ok(outcome.stateChars > 0);
  assert.equal(outcome.turnsIncluded, 1);

  assert.deepEqual(Object.keys(outcome.value).sort(), [
    "confidence",
    "decision_found",
    "reason",
    "subcategory",
  ]);
  assert.equal(outcome.value.decision_found, true);
  assert.equal(outcome.value.subcategory, "security_auth");
  assert.ok(
    outcome.value.confidence > 0 &&
      outcome.value.confidence < DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLD,
  );
  const combined = combineProbabilities(expectedProbabilities);
  assert.ok(
    combined.developerReflectionReductionMultiplier < combined.decisionWeight,
  );
  assert.ok(
    combined.developerReflectionReductionMultiplier <
      combined.decisionOwnership,
  );
  assert.ok(
    combined.developerReflectionReductionMultiplier <
      combined.developerIntentReductionMultiplier,
  );
  assert.equal(outcome.value.reason.includes(developerReflectionName), true);

  const decision = classify(
    input.group,
    { classifier_model: "jev-latest" },
    input.context,
    {
      runner: () => ({
        status: outcome.status,
        provider: "jev",
        value: outcome.value,
      }),
    },
  );
  assert.equal(decision.status, "veto");
  assert.equal(decision.reason, "low_confidence");
});

test("the per-call budgets fit inside the runner kill and child plus fallback fit inside the Stop hook timeout", () => {
  const hooksConfig = JSON.parse(fs.readFileSync(HOOKS_JSON_PATH, "utf8"));
  const stopHookSeconds = hooksConfig.hooks.Stop[0].hooks[0].timeout;
  const stopHookTimeoutMs = stopHookSeconds * 1000;

  assert.ok(MARGIN_MS > 0);
  assert.equal(
    JEV_TIMEOUT_MS,
    STATE_TIMEOUT_MS + CATEGORY_TIMEOUT_MS + MARGIN_MS,
    "the child kill budget must equal the state timeout plus the category timeout plus the margin",
  );
  assert.ok(
    STATE_TIMEOUT_MS + CATEGORY_TIMEOUT_MS < JEV_TIMEOUT_MS,
    "Sonnet state timeout plus parallel category timeout must finish before the runner kills the child",
  );
  assert.ok(
    JEV_TIMEOUT_MS + FALLBACK_TIMEOUT_MS < stopHookTimeoutMs,
    "worst-case child kill plus fallback timeout must fit inside the Stop hook budget",
  );
});

const IMPORTANT_REFLEXIVE_ANSWERS = Object.freeze({
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
    justified_choice: 0,
    asked_questions: 0,
    discussed_alternatives: 0,
    suggested_fixes: 0,
    bare_pick_streak: 0.8,
  }),
});

test("an important AI decision accepted reflexively pauses on every preset", async (t) => {
  const { homeDir, input } = makeTurnFixture(t);

  for (const preset of PRESET_NAMES) {
    const { sdk } = makeStubSdk((categoryName) =>
      Promise.resolve({
        model: "jev-2026-10",
        answers: IMPORTANT_REFLEXIVE_ANSWERS[categoryName],
      }),
    );
    const outcome = await classifyTurn(input, {
      homeDir,
      config: { preset, classifier_model: "jev-latest" },
      stateRunner: () => ({
        status: "ok",
        value: validStateFixture({ area_label: "security_auth" }),
      }),
      sdk,
    });
    const decision = classify(
      input.group,
      { preset, classifier_model: "jev-latest" },
      input.context,
      {
        runner: () => ({
          status: outcome.status,
          provider: "jev",
          value: outcome.value,
        }),
      },
    );

    assert.ok(
      outcome.value.confidence >= DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLD,
    );
    assert.equal(decision.status, "pass", `expected pause on ${preset}`);
    assert.equal(decision.classification.category, "security");
    assert.equal(decision.classification.subcategory, "security_auth");
    assert.equal(outcome.value.reason.includes(decisionWeightName), true);
  }
});

test("the developer's own justified decision never pauses on any preset", async (t) => {
  const { homeDir, input } = makeTurnFixture(t);

  const ownJustifiedAnswers = {
    ...IMPORTANT_REFLEXIVE_ANSWERS,
    developer_intent: noulAnswers({
      own_idea: 1,
      refining_own_proposal: 0.9,
      specific_request: 1,
      accepting_ai_proposal: 0,
    }),
    developer_reflection: noulAnswers({
      justified_choice: 1,
      asked_questions: 0.8,
      discussed_alternatives: 0,
      suggested_fixes: 0,
      bare_pick_streak: 0,
    }),
  };

  for (const preset of PRESET_NAMES) {
    const { sdk } = makeStubSdk((categoryName) =>
      Promise.resolve({
        model: "jev-2026-10",
        answers: ownJustifiedAnswers[categoryName],
      }),
    );
    const outcome = await classifyTurn(input, {
      homeDir,
      config: { preset, classifier_model: "jev-latest" },
      stateRunner: () => ({
        status: "ok",
        value: validStateFixture({ area_label: "security_auth" }),
      }),
      sdk,
    });
    const decision = classify(
      input.group,
      { preset, classifier_model: "jev-latest" },
      input.context,
      {
        runner: () => ({
          status: outcome.status,
          provider: "jev",
          value: outcome.value,
        }),
      },
    );

    assert.equal(outcome.value.decision_found, true);
    assert.equal(decision.status, "veto");
    assert.equal(decision.reason, "low_confidence");
  }
});

test("a trivial change accepted reflexively does not pause", async (t) => {
  const { homeDir, input } = makeTurnFixture(t);

  const trivialReflexiveAnswers = {
    ...IMPORTANT_REFLEXIVE_ANSWERS,
    decision_weight: noulAnswers({
      logic_and_size: 0.05,
      one_way_decision: 0,
      non_code_decision: 0,
      unaware_decision_cascade: 0,
    }),
  };
  const { sdk } = makeStubSdk((categoryName) =>
    Promise.resolve({
      model: "jev-2026-10",
      answers: trivialReflexiveAnswers[categoryName],
    }),
  );
  const outcome = await classifyTurn(input, {
    homeDir,
    config: { preset: "vigilant", classifier_model: "jev-latest" },
    stateRunner: () => ({
      status: "ok",
      value: validStateFixture({ area_label: "security_auth" }),
    }),
    sdk,
  });
  const decision = classify(
    input.group,
    { preset: "vigilant", classifier_model: "jev-latest" },
    input.context,
    {
      runner: () => ({
        status: outcome.status,
        provider: "jev",
        value: outcome.value,
      }),
    },
  );

  assert.ok(outcome.value.confidence < DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLD);
  assert.equal(decision.status, "veto");
  assert.equal(decision.reason, "low_confidence");
  assert.equal(outcome.value.reason.includes(decisionWeightName), true);
});

const ADR_ANSWERS = Object.freeze({
  developer_intent: noulAnswers({
    own_idea: 0,
    refining_own_proposal: 0,
    specific_request: 0.1,
    accepting_ai_proposal: 0.9,
  }),
  decision_ownership: noulAnswers({
    unaware_ai_decision: 0.85,
    ai_beyond_request: 0.7,
    unacknowledged_ai_tradeoff: 0.8,
  }),
  decision_weight: noulAnswers({
    logic_and_size: 0,
    one_way_decision: 0,
    non_code_decision: 0.9,
    unaware_decision_cascade: 0,
  }),
  developer_reflection: noulAnswers({
    justified_choice: 0,
    asked_questions: 0,
    discussed_alternatives: 0,
    suggested_fixes: 0,
    bare_pick_streak: 0.5,
  }),
});

test("a non-code ADR decision pauses even when the turn diff is empty", async (t) => {
  const { homeDir, input } = makeTurnFixture(t);

  const { sdk } = makeStubSdk((categoryName) =>
    Promise.resolve({
      model: "jev-2026-10",
      answers: ADR_ANSWERS[categoryName],
    }),
  );
  const outcome = await classifyTurn(
    {
      ...input,
      group: {
        ...input.group,
        edit_count: 0,
        lines_added: 0,
        lines_removed: 0,
        edits: [],
      },
    },
    {
      homeDir,
      stateRunner: () => ({
        status: "ok",
        value: validStateFixture({
          decision_weight: {
            file_changes: [],
            non_code_decision: true,
            unaware_decision_count: 1,
          },
          area_label: "architecture_pattern",
        }),
      }),
      sdk,
    },
  );
  const decision = classify(
    input.group,
    { classifier_model: "jev-latest" },
    input.context,
    {
      runner: () => ({
        status: outcome.status,
        provider: "jev",
        value: outcome.value,
      }),
    },
  );

  assert.equal(decision.status, "pass");
  assert.equal(decision.classification.category, "architecture");
  assert.equal(decision.classification.subcategory, "architecture_pattern");
});

test("the worked calibration example pauses near 0.494", () => {
  const combined = combineProbabilities({
    [decisionWeightName]: 0.8,
    [decisionOwnershipName]: 0.9,
    [developerReflectionName]: 0.1,
    [developerIntentName]: 0.9,
  });

  assert.ok(Math.abs(combined.pauseProbability - 0.494064) < 1e-9);
  assert.ok(Math.abs(combined.pauseProbability - 0.494) < 1e-3);
});

test("zero developer intent leaves the pause probability at the reflection-only value", () => {
  const decisionWeight = 0.8;
  const decisionOwnership = 0.5;
  const developerReflection = 0.5;
  const reflectionOnly =
    decisionWeight *
    decisionOwnership *
    (1 - REFLECTION_MAX_REDUCTION * developerReflection);
  const combined = combineProbabilities({
    [decisionWeightName]: decisionWeight,
    [decisionOwnershipName]: decisionOwnership,
    [developerReflectionName]: developerReflection,
    [developerIntentName]: 0,
  });

  assert.ok(Math.abs(combined.pauseProbability - reflectionOnly) < 1e-9);
});

test("a higher developer intent lowers the pause probability", () => {
  const shared = {
    [decisionWeightName]: 0.8,
    [decisionOwnershipName]: 0.9,
    [developerReflectionName]: 0.9,
  };
  const lowerIntent = combineProbabilities({
    ...shared,
    [developerIntentName]: 0.1,
  });
  const higherIntent = combineProbabilities({
    ...shared,
    [developerIntentName]: 0.5,
  });

  assert.ok(higherIntent.pauseProbability < lowerIntent.pauseProbability);
});

test("decision weight multiplies the pause probability", () => {
  const decisionWeight = 0.4;
  const decisionOwnership = 0.5;
  const lighterDecision = combineProbabilities({
    [decisionWeightName]: decisionWeight,
    [decisionOwnershipName]: decisionOwnership,
    [developerReflectionName]: 0,
    [developerIntentName]: 0,
  });
  const heavierDecision = combineProbabilities({
    [decisionWeightName]: decisionWeight * 2,
    [decisionOwnershipName]: decisionOwnership,
    [developerReflectionName]: 0,
    [developerIntentName]: 0,
  });

  assert.equal(
    lighterDecision.pauseProbability,
    decisionWeight * decisionOwnership,
  );
  assert.equal(
    heavierDecision.pauseProbability,
    lighterDecision.pauseProbability * 2,
  );
});

test("the developer's own intent lowers the pause probability by the intent reduction", () => {
  const decisionWeight = 0.8;
  const decisionOwnership = 0.5;
  const developerIntent = 1;
  const withoutOwnIntent = combineProbabilities({
    [decisionWeightName]: decisionWeight,
    [decisionOwnershipName]: decisionOwnership,
    [developerReflectionName]: 0,
    [developerIntentName]: 0,
  });
  const withOwnIntent = combineProbabilities({
    [decisionWeightName]: decisionWeight,
    [decisionOwnershipName]: decisionOwnership,
    [developerReflectionName]: 0,
    [developerIntentName]: developerIntent,
  });
  const expectedPauseProbability =
    decisionWeight *
    decisionOwnership *
    (1 - INTENT_MAX_REDUCTION * developerIntent);

  assert.ok(
    Math.abs(
      withoutOwnIntent.pauseProbability - decisionWeight * decisionOwnership,
    ) < 1e-9,
  );
  assert.ok(
    Math.abs(withOwnIntent.pauseProbability - expectedPauseProbability) < 1e-9,
  );
  assert.ok(withOwnIntent.pauseProbability < withoutOwnIntent.pauseProbability);
});

test("unusable category probabilities stay inside the legal pause and reduction ranges", () => {
  const reflectionMultiplierFloor = 1 - REFLECTION_MAX_REDUCTION;
  const intentMultiplierFloor = 1 - INTENT_MAX_REDUCTION;
  const cases = [
    {
      name: "missing map",
      probabilities: undefined,
    },
    {
      name: "not a number",
      probabilities: {
        [decisionWeightName]: Number.NaN,
        [decisionOwnershipName]: 0.5,
        [developerReflectionName]: 0.2,
        [developerIntentName]: 0.2,
      },
    },
    {
      name: "missing category",
      probabilities: {
        [decisionOwnershipName]: 0.5,
        [developerReflectionName]: 0.2,
        [developerIntentName]: 0.2,
      },
    },
    {
      name: "above one",
      probabilities: {
        [decisionWeightName]: 2,
        [decisionOwnershipName]: 1.5,
        [developerReflectionName]: 4,
        [developerIntentName]: 3,
      },
    },
    {
      name: "below zero",
      probabilities: {
        [decisionWeightName]: -1,
        [decisionOwnershipName]: -0.2,
        [developerReflectionName]: -3,
        [developerIntentName]: -0.4,
      },
    },
    {
      name: "infinity",
      probabilities: {
        [decisionWeightName]: Infinity,
        [decisionOwnershipName]: -Infinity,
        [developerReflectionName]: Infinity,
        [developerIntentName]: Number.NaN,
      },
    },
  ];

  for (const entry of cases) {
    const combined = combineProbabilities(entry.probabilities);

    assert.ok(
      Number.isFinite(combined.pauseProbability),
      `${entry.name} pause probability must be finite`,
    );
    assert.ok(
      combined.pauseProbability >= 0 && combined.pauseProbability <= 1,
      `${entry.name} pause probability must stay inside [0, 1]`,
    );
    assert.ok(
      combined.developerReflectionReductionMultiplier >=
        reflectionMultiplierFloor &&
        combined.developerReflectionReductionMultiplier <= 1,
      `${entry.name} reflection reduction must stay inside [${reflectionMultiplierFloor}, 1]`,
    );
    assert.ok(
      combined.developerIntentReductionMultiplier >= intentMultiplierFloor &&
        combined.developerIntentReductionMultiplier <= 1,
      `${entry.name} intent reduction must stay inside [${intentMultiplierFloor}, 1]`,
    );
    if (entry.name === "missing map") {
      assert.equal(
        combined.pauseProbability,
        0,
        "a missing probability map must not raise a pause probability",
      );
    }
  }

  const aboveOne = combineProbabilities({
    [decisionWeightName]: 2,
    [decisionOwnershipName]: 1.5,
    [developerReflectionName]: 4,
    [developerIntentName]: 3,
  });
  assert.equal(aboveOne.decisionWeight, 1);
  assert.equal(aboveOne.decisionOwnership, 1);
  assert.equal(aboveOne.developerReflection, 1);
  assert.equal(aboveOne.developerIntent, 1);
  assert.ok(
    Math.abs(
      aboveOne.pauseProbability -
        reflectionMultiplierFloor * intentMultiplierFloor,
    ) < 1e-9,
  );

  const belowZero = combineProbabilities({
    [decisionWeightName]: -1,
    [decisionOwnershipName]: -0.2,
    [developerReflectionName]: -3,
    [developerIntentName]: -0.4,
  });
  assert.equal(belowZero.pauseProbability, 0);
  assert.equal(belowZero.developerReflectionReductionMultiplier, 1);
  assert.equal(belowZero.developerIntentReductionMultiplier, 1);

  const fullOtherFactors = {
    [decisionOwnershipName]: 1,
    [developerReflectionName]: 0,
    [developerIntentName]: 0,
  };
  for (const [caseName, decisionWeight] of [
    ["missing category", undefined],
    ["not a number", Number.NaN],
    ["infinity", Infinity],
  ]) {
    const probabilities = { ...fullOtherFactors };
    if (decisionWeight !== undefined) {
      probabilities[decisionWeightName] = decisionWeight;
    }
    const combined = combineProbabilities(probabilities);
    assert.equal(
      combined.pauseProbability,
      0,
      `${caseName} must not contribute a pause probability`,
    );
    assert.equal(combined.decisionWeight, 0, caseName);
  }
});

test("full developer reflection applies the maximum reflection reduction", () => {
  const open = combineProbabilities({
    [decisionWeightName]: 0.5,
    [decisionOwnershipName]: 0.8,
    [developerReflectionName]: 0,
    [developerIntentName]: 0,
  });
  const fullReflection = combineProbabilities({
    [decisionWeightName]: 0.5,
    [decisionOwnershipName]: 0.8,
    [developerReflectionName]: 1,
    [developerIntentName]: 0,
  });

  assert.ok(
    Math.abs(
      fullReflection.pauseProbability -
        open.pauseProbability * (1 - REFLECTION_MAX_REDUCTION),
    ) < 1e-9,
  );
});

test("asking questions or suggesting fixes lowers pause_probability", () => {
  const reflexiveProbabilities = probabilitiesByCategory(
    ADR_ANSWERS,
    CATEGORY_REGISTRY,
  );
  const questionedProbabilities = probabilitiesByCategory(
    {
      ...ADR_ANSWERS,
      developer_reflection: noulAnswers({
        justified_choice: 0,
        asked_questions: 0.8,
        discussed_alternatives: 0,
        suggested_fixes: 0.75,
        bare_pick_streak: 0,
      }),
    },
    CATEGORY_REGISTRY,
  );

  assert.ok(
    combineProbabilities(questionedProbabilities).pauseProbability <
      combineProbabilities(reflexiveProbabilities).pauseProbability,
  );
});

test("repeated unaware acceptances raise pause_probability", () => {
  const singleUnawareProbabilities = probabilitiesByCategory(
    {
      ...ADR_ANSWERS,
      decision_weight: noulAnswers({
        logic_and_size: 0.35,
        one_way_decision: 0,
        non_code_decision: 0,
        unaware_decision_cascade: 0,
      }),
    },
    CATEGORY_REGISTRY,
  );
  const cascadingUnawareProbabilities = probabilitiesByCategory(
    {
      ...ADR_ANSWERS,
      decision_weight: noulAnswers({
        logic_and_size: 0.35,
        one_way_decision: 0,
        non_code_decision: 0,
        unaware_decision_cascade: 0.5,
      }),
    },
    CATEGORY_REGISTRY,
  );

  assert.ok(
    combineProbabilities(cascadingUnawareProbabilities).pauseProbability >
      combineProbabilities(singleUnawareProbabilities).pauseProbability,
  );
});

const ANSWERS_FOR_POINT_THREE_FIVE = Object.freeze({
  developer_intent: noulAnswers({
    own_idea: 0,
    refining_own_proposal: 0,
    specific_request: 0,
    accepting_ai_proposal: 1,
  }),
  decision_ownership: noulAnswers({
    unaware_ai_decision: 0.5,
    ai_beyond_request: 0,
    unacknowledged_ai_tradeoff: 0,
  }),
  decision_weight: noulAnswers({
    logic_and_size: 0.7,
    one_way_decision: 0,
    non_code_decision: 0,
    unaware_decision_cascade: 0,
  }),
  developer_reflection: noulAnswers({
    justified_choice: 0,
    asked_questions: 0,
    discussed_alternatives: 0,
    suggested_fixes: 0,
    bare_pick_streak: 0,
  }),
});

/**
 * The verdict reason and the summary line must log the active preset's
 * pause threshold, not a neighbouring preset's threshold.
 *
 * @param {object} outcome - `classifyTurn` result whose verdict is `value`.
 * @param {string} preset - Active preset name.
 * @param {object} context - Turn context carrying `projectDir`.
 * @param {string} homeDir - Sandbox home directory.
 */
function assertLoggedPresetPauseThreshold(outcome, preset, context, homeDir) {
  const presetPauseThreshold = PAUSE_THRESHOLDS[preset];
  assert.ok(
    outcome.value.reason.includes(
      `threshold=${presetPauseThreshold.toFixed(2)}`,
    ),
    `verdict reason must log the ${preset} pause threshold`,
  );
  const summaryLine = buildSummaryLine({
    startedAt: new Date("2026-10-18T12:00:00.000Z"),
    context,
    model: "jev-latest",
    provider: "jev",
    status: "ok",
    child: outcome,
    result: { status: "ok", provider: "jev", value: outcome.value },
    homeDir,
  });
  assert.equal(summaryLine.preset, preset);
  assert.equal(summaryLine.preset_pause_threshold, presetPauseThreshold);
}

test("pause_probability = 0.35 maps to calm 0.42 (veto low_confidence), balanced 0.60 (pause), and vigilant 0.84 (pause)", async (t) => {
  const { projectDir, homeDir, input } = makeTurnFixture(t);
  const { sdk } = makeStubSdk((categoryName) =>
    Promise.resolve({
      model: "jev-2026-10",
      answers: ANSWERS_FOR_POINT_THREE_FIVE[categoryName],
    }),
  );

  saveConfig(projectDir, {
    preset: "calm",
    classifier_model: "jev-latest",
  });
  const calmOutcome = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({
      status: "ok",
      value: validStateFixture({ area_label: "security_auth" }),
    }),
    sdk,
  });
  assert.equal(calmOutcome.value.confidence, 0.42);
  assertLoggedPresetPauseThreshold(calmOutcome, "calm", input.context, homeDir);
  const calmDecision = classify(
    input.group,
    { classifier_model: "jev-latest" },
    input.context,
    {
      runner: () => ({
        status: calmOutcome.status,
        provider: "jev",
        value: calmOutcome.value,
      }),
    },
  );
  assert.equal(calmDecision.status, "veto");
  assert.equal(calmDecision.reason, "low_confidence");

  saveConfig(projectDir, {
    preset: "balanced",
    classifier_model: "jev-latest",
  });
  const balancedOutcome = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({
      status: "ok",
      value: validStateFixture({ area_label: "security_auth" }),
    }),
    sdk,
  });
  assert.equal(balancedOutcome.value.confidence, 0.6);
  assertLoggedPresetPauseThreshold(
    balancedOutcome,
    "balanced",
    input.context,
    homeDir,
  );
  const balancedDecision = classify(
    input.group,
    { classifier_model: "jev-latest" },
    input.context,
    {
      runner: () => ({
        status: balancedOutcome.status,
        provider: "jev",
        value: balancedOutcome.value,
      }),
    },
  );
  assert.equal(balancedDecision.status, "pass");

  saveConfig(projectDir, {
    preset: "vigilant",
    classifier_model: "jev-latest",
  });
  const vigilantOutcome = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({
      status: "ok",
      value: validStateFixture({ area_label: "security_auth" }),
    }),
    sdk,
  });
  assert.equal(vigilantOutcome.value.confidence, 0.84);
  assertLoggedPresetPauseThreshold(
    vigilantOutcome,
    "vigilant",
    input.context,
    homeDir,
  );
  const vigilantDecision = classify(
    input.group,
    { classifier_model: "jev-latest" },
    input.context,
    {
      runner: () => ({
        status: vigilantOutcome.status,
        provider: "jev",
        value: vigilantOutcome.value,
      }),
    },
  );
  assert.equal(vigilantDecision.status, "pass");
});

test("a personal state.preset override wins over config.preset when mapping pause_probability to confidence", async (t) => {
  const { projectDir, homeDir, input } = makeTurnFixture(t);
  const { sdk } = makeStubSdk((categoryName) =>
    Promise.resolve({
      model: "jev-2026-10",
      answers: ANSWERS_FOR_POINT_THREE_FIVE[categoryName],
    }),
  );

  saveConfig(projectDir, {
    preset: "calm",
    classifier_model: "jev-latest",
  });
  saveState(
    projectDir,
    {
      score: 12,
      last_update: 0,
      mutes: [],
      skip_streak: {},
      skip_totals: {},
      preset: "vigilant",
    },
    homeDir,
  );

  const personalOverrideOutcome = await classifyTurn(input, {
    homeDir,
    stateRunner: () => ({
      status: "ok",
      value: validStateFixture({ area_label: "security_auth" }),
    }),
    sdk,
  });
  assert.equal(personalOverrideOutcome.value.confidence, 0.84);
  const decision = classify(
    input.group,
    { classifier_model: "jev-latest" },
    input.context,
    {
      runner: () => ({
        status: personalOverrideOutcome.status,
        provider: "jev",
        value: personalOverrideOutcome.value,
      }),
    },
  );
  assert.equal(decision.status, "pass");
});

test("a low pause_probability maps to an existing veto reason and reason names the driving category", (t) => {
  const { input } = makeTurnFixture(t);

  const limitedByWeight = buildVerdict(
    {
      [decisionWeightName]: 0.05,
      [decisionOwnershipName]: 0.9,
      [developerReflectionName]: 0,
      [developerIntentName]: 0,
    },
    "none",
    { preset: "balanced" },
    {},
  );
  assert.equal(limitedByWeight.decision_found, true);
  assert.equal(limitedByWeight.subcategory, JEV_GENERAL_CATEGORY);
  assert.equal(limitedByWeight.reason.includes(decisionWeightName), true);
  assert.equal(limitedByWeight.reason.includes(decisionOwnershipName), false);
  const weightDecision = classify(
    input.group,
    { classifier_model: "jev-latest" },
    input.context,
    {
      runner: () => ({
        status: "ok",
        provider: "jev",
        value: limitedByWeight,
      }),
    },
  );
  assert.equal(weightDecision.status, "veto");
  assert.equal(weightDecision.reason, "low_confidence");
  assert.equal(VETO_REASONS.includes(weightDecision.reason), true);

  const limitedByOwnership = buildVerdict(
    {
      [decisionWeightName]: 0.9,
      [decisionOwnershipName]: 0.05,
      [developerReflectionName]: 0,
      [developerIntentName]: 0,
    },
    "security_auth",
    { preset: "balanced" },
    {},
  );
  assert.equal(limitedByOwnership.subcategory, "security_auth");
  assert.equal(limitedByOwnership.reason.includes(decisionOwnershipName), true);
  assert.equal(limitedByOwnership.reason.includes(decisionWeightName), false);

  const limitedByReflection = buildVerdict(
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
  assert.equal(limitedByReflection.decision_found, true);
  assert.equal(
    limitedByReflection.reason.includes(developerReflectionName),
    true,
  );
  const reflectionDecision = classify(
    input.group,
    { classifier_model: "jev-latest" },
    input.context,
    {
      runner: () => ({
        status: "ok",
        provider: "jev",
        value: limitedByReflection,
      }),
    },
  );
  assert.equal(reflectionDecision.status, "veto");
  assert.equal(reflectionDecision.reason, "low_confidence");
  assert.equal(VETO_REASONS.includes(reflectionDecision.reason), true);
});

test("a general classification on the Jev path is suppressed by an active general mute", (t) => {
  const { input } = makeTurnFixture(t);

  const generalPassVerdict = buildVerdict(
    {
      [decisionWeightName]: 0.9,
      [decisionOwnershipName]: 0.9,
      [developerReflectionName]: 0,
      [developerIntentName]: 0,
    },
    "none",
    { preset: "balanced", classifier_model: "jev-latest" },
    {},
  );
  assert.equal(generalPassVerdict.subcategory, JEV_GENERAL_CATEGORY);

  const mutedGeneralDecision = decideFire(
    {
      score: 20,
      last_update: 0,
      mutes: [
        {
          category: JEV_GENERAL_CATEGORY,
          files: null,
          expires_at: 2_000_000_000,
        },
      ],
      skip_streak: {},
      skip_totals: {},
    },
    { classifier_model: "jev-latest" },
    input.group,
    input.context,
    {
      now: 1_000_000_000,
      runner: () => ({
        status: "ok",
        provider: "jev",
        value: generalPassVerdict,
      }),
    },
  );
  assert.equal(mutedGeneralDecision.outcome, "muted");
  assert.equal(
    mutedGeneralDecision.classification.category,
    JEV_GENERAL_CATEGORY,
  );
});

test("a negative Jev verdict never triggers the headless fallback", (t) => {
  const { homeDir, input } = makeTurnFixture(t);
  const negativeVerdict = buildVerdict(
    {
      [decisionWeightName]: 0.05,
      [decisionOwnershipName]: 0.9,
      [developerReflectionName]: 0,
      [developerIntentName]: 0,
    },
    "none",
    { preset: "balanced" },
    {},
  );

  const fallbackCalls = [];
  const negativeChildOutput = {
    status: "ok",
    value: negativeVerdict,
    log: { status: "ok" },
  };
  const negativeRunnerResult = runJev(input.prompt, {
    model: "jev-latest",
    group: input.group,
    context: input.context,
    homeDir,
    spawn: () => ({
      status: 0,
      stdout: `${JSON.stringify(negativeChildOutput)}\n`,
    }),
    fallback: (prompt, options) => {
      fallbackCalls.push({ prompt, options });
      return { status: "ok", value: negativeVerdict };
    },
  });

  assert.equal(
    fallbackCalls.length,
    0,
    "a negative Jev verdict must never fall back to Haiku",
  );
  assert.deepEqual(negativeRunnerResult, {
    status: "ok",
    provider: "jev",
    value: negativeVerdict,
  });
});

test("every Jev infrastructure failure triggers the headless fallback with FALLBACK_MODEL and FALLBACK_TIMEOUT_MS", (t) => {
  const { homeDir, input } = makeTurnFixture(t);
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

  for (const infrastructureStatus of [
    "no_turns",
    "state_too_large",
    "state_unavailable",
    "state_invalid",
    "no_key",
    "sdk_missing",
    "api_error",
    "unusable_answer",
  ]) {
    const calls = [];
    const result = runJev(input.prompt, {
      model: "jev-latest",
      group: input.group,
      context: input.context,
      homeDir,
      spawn: () => ({
        status: 1,
        stdout: `${JSON.stringify({ status: infrastructureStatus, error: infrastructureStatus })}\n`,
      }),
      fallback: (prompt, options) => {
        calls.push({ prompt, options });
        return { status: "ok", value: fallbackVerdict };
      },
    });
    assert.equal(
      calls.length,
      1,
      `expected fallback on ${infrastructureStatus}`,
    );
    assert.equal(calls[0].options.model, FALLBACK_MODEL);
    assert.equal(calls[0].options.timeoutMs, FALLBACK_TIMEOUT_MS);
    assert.equal(result.provider, "headless_fallback");
  }
});

test("runJev writes its summary under the supplied homeDir", (t) => {
  const { projectDir, homeDir, input } = makeTurnFixture(t);
  const realHomeSummary = summaryLogPath(projectDir, { homeDir: os.homedir() });
  const beforeRealHome = fs.existsSync(realHomeSummary)
    ? fs.readFileSync(realHomeSummary, "utf8")
    : "";

  runJev(input.prompt, {
    model: input.model,
    group: input.group,
    context: input.context,
    homeDir,
    spawn: () => ({
      status: 0,
      stdout: `${JSON.stringify({
        status: "ok",
        value: {
          decision_found: false,
          subcategory: null,
          reason: "negative",
          confidence: 0,
        },
        log: { status: "ok" },
      })}\n`,
    }),
  });

  const sandboxSummary = summaryLogPath(projectDir, { homeDir });
  assert.equal(fs.existsSync(sandboxSummary), true);
  const afterRealHome = fs.existsSync(realHomeSummary)
    ? fs.readFileSync(realHomeSummary, "utf8")
    : "";
  assert.equal(afterRealHome, beforeRealHome);
});

test("confidence never exceeds 1", () => {
  const certainProbabilities = {
    [decisionWeightName]: 1,
    [decisionOwnershipName]: 1,
    [developerReflectionName]: 0,
    [developerIntentName]: 0,
  };
  const verdict = buildVerdict(
    certainProbabilities,
    "security_auth",
    { preset: "vigilant" },
    { preset: "vigilant" },
  );
  const summaryLine = buildSummaryLine({
    startedAt: new Date("2026-10-18T12:00:00.000Z"),
    context: { score_before: 1, session_id: "session-confidence-cap" },
    model: "jev-latest",
    provider: "jev",
    status: "ok",
    child: { status: "ok", value: verdict, log: { status: "ok" } },
    result: { status: "ok", provider: "jev", value: verdict },
  });

  assert.equal(verdict.confidence, 1);
  assert.equal(summaryLine.confidence, 1);
});

test("a pause_probability at the preset threshold maps exactly to a non-default confidence floor", () => {
  const configuredFloor = 0.45;
  const probabilities = {
    [decisionWeightName]: 0.7,
    [decisionOwnershipName]: 0.5,
    [developerReflectionName]: 0,
    [developerIntentName]: 0,
  };
  assert.equal(
    combineProbabilities(probabilities).pauseProbability,
    PAUSE_THRESHOLDS.balanced,
  );

  const verdict = buildVerdict(
    probabilities,
    "security_auth",
    {
      preset: "balanced",
      classifier_confidence_threshold: configuredFloor,
    },
    {},
  );

  assert.equal(verdict.confidence, configuredFloor);
});

test("a raised confidence floor still pauses when pause_probability equals the preset threshold", (t) => {
  const { input } = makeTurnFixture(t);
  const configuredFloor = 0.9;
  const config = {
    preset: "balanced",
    classifier_model: "jev-latest",
    classifier_confidence_threshold: configuredFloor,
  };
  const verdict = buildVerdict(
    {
      [decisionWeightName]: 0.7,
      [decisionOwnershipName]: 0.5,
      [developerReflectionName]: 0,
      [developerIntentName]: 0,
    },
    "security_auth",
    config,
    {},
  );
  const decision = classify(input.group, config, input.context, {
    runner: () => ({ status: "ok", provider: "jev", value: verdict }),
  });

  assert.equal(decision.status, "pass");
});

test("a lowered confidence floor vetoes low_confidence when pause_probability is below the preset threshold", (t) => {
  const { input } = makeTurnFixture(t);
  const configuredFloor = 0.3;
  const config = {
    preset: "balanced",
    classifier_model: "jev-latest",
    classifier_confidence_threshold: configuredFloor,
  };
  const verdict = buildVerdict(
    {
      [decisionWeightName]: 0.5,
      [decisionOwnershipName]: 0.5,
      [developerReflectionName]: 0,
      [developerIntentName]: 0,
    },
    "security_auth",
    config,
    {},
  );
  const decision = classify(input.group, config, input.context, {
    runner: () => ({ status: "ok", provider: "jev", value: verdict }),
  });

  assert.equal(
    combineProbabilities({
      [decisionWeightName]: 0.5,
      [decisionOwnershipName]: 0.5,
      [developerReflectionName]: 0,
      [developerIntentName]: 0,
    }).pauseProbability < PAUSE_THRESHOLDS.balanced,
    true,
  );
  assert.equal(decision.status, "veto");
  assert.equal(decision.reason, "low_confidence");
});

test("classify judges low_confidence against the personal preset floor when it differs from the project floor", (t) => {
  const { input } = makeTurnFixture(t);
  const personalFloor = 0.9;
  const presets = {
    calm: PRESETS.calm,
    balanced: PRESETS.balanced,
    vigilant: {
      ...PRESETS.vigilant,
      classifier_confidence_threshold: personalFloor,
    },
  };
  const config = {
    preset: "balanced",
    classifier_model: "jev-latest",
    classifier_confidence_threshold: 0.6,
  };
  const personalState = { preset: "vigilant", score: 40, mutes: [] };
  const atPresetThreshold = {
    [decisionWeightName]: 0.5,
    [decisionOwnershipName]: 0.5,
    [developerReflectionName]: 0,
    [developerIntentName]: 0,
  };
  const belowPresetThreshold = {
    [decisionWeightName]: 0.4,
    [decisionOwnershipName]: 0.5,
    [developerReflectionName]: 0,
    [developerIntentName]: 0,
  };

  const atFloorVerdict = buildVerdict(
    atPresetThreshold,
    "security_auth",
    config,
    personalState,
    presets,
  );
  assert.equal(
    combineProbabilities(atPresetThreshold).pauseProbability,
    PAUSE_THRESHOLDS.vigilant,
  );
  assert.equal(atFloorVerdict.confidence, personalFloor);
  const pass = decideFire(personalState, config, input.group, input.context, {
    runner: () => ({ status: "ok", provider: "jev", value: atFloorVerdict }),
    presets,
  });
  assert.equal(pass.outcome, "fire");

  const belowVerdict = buildVerdict(
    belowPresetThreshold,
    "security_auth",
    config,
    personalState,
    presets,
  );
  assert.ok(belowVerdict.confidence < personalFloor);
  const vetoed = decideFire(personalState, config, input.group, input.context, {
    runner: () => ({ status: "ok", provider: "jev", value: belowVerdict }),
    presets,
  });
  assert.equal(vetoed.outcome, "veto");
  assert.equal(vetoed.reason, "low_confidence");
});

test("a Jev child killed with ETIMEDOUT falls back and records status timeout", (t) => {
  const { projectDir, homeDir, input } = makeTurnFixture(t);
  const killed = new Error("spawn timed out");
  killed.code = "ETIMEDOUT";
  const fallbackCalls = [];

  const result = runJev(input.prompt, {
    model: "jev-latest",
    group: input.group,
    context: input.context,
    homeDir,
    spawn: () => ({ status: null, error: killed, stdout: "" }),
    fallback: () => {
      fallbackCalls.push("called");
      return {
        status: "ok",
        value: {
          decision_found: false,
          subcategory: null,
          reason: "fallback after timeout",
          confidence: 0,
        },
      };
    },
  });

  assert.equal(fallbackCalls.length, 1);
  assert.equal(result.provider, "headless_fallback");
  const summaryText = fs.readFileSync(
    summaryLogPath(projectDir, { homeDir }),
    "utf8",
  );
  assert.equal(summaryText.includes('"status":"timeout"'), true);
});
