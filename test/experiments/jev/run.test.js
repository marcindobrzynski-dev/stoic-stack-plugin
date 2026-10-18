import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CATEGORY_NAMES,
  CATEGORY_REGISTRY,
  probabilitiesByCategory,
} from "../../../experiments/jev/categories/index.js";
import {
  CATEGORY_TIMEOUT_MS,
  FALLBACK_MODEL,
  FALLBACK_TIMEOUT_MS,
  STATE_SCHEMA_VERSION,
  STATE_TIMEOUT_MS,
} from "../../../experiments/jev/constants.js";
import {
  buildVerdict,
  classifyTurn,
  combineProbabilities,
} from "../../../experiments/jev/run.js";
import { runJev } from "../../../experiments/jev/runner.js";
import {
  DECISION_KIND_VALUES,
  DECISION_MADE_BY_VALUES,
  INTENT_SCALE_VALUES,
} from "../../../experiments/jev/state-schema.js";
import {
  JEV_TIMEOUT_MS,
  MARGIN_MS,
  SDK_TIMEOUT_MS,
} from "../../../experiments/jev/timing.js";
import { decideFire } from "../../../src/hooks/stop-decision.js";
import { VETO_REASONS, classify } from "../../../src/io/classifier.js";
import {
  DEFAULT_CLASSIFIER_MODEL,
  PRESET_NAMES,
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
    reflex_approval: 0.1,
    justified_choice: 0.7,
    asked_questions: 0.6,
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
        reflex_approval: false,
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

test("one failed or timed-out category produces a negative verdict naming that category and error class without leaking the error message", async (t) => {
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

  assert.equal(outcome.status, "ok");
  assert.deepEqual(Object.keys(outcome.value).sort(), [
    "confidence",
    "decision_found",
    "reason",
    "subcategory",
  ]);
  assert.equal(outcome.value.decision_found, false);
  assert.equal(outcome.value.subcategory, null);
  assert.equal(outcome.value.confidence, 0);
  assert.equal(outcome.value.reason.includes("decision_weight"), true);
  assert.equal(outcome.value.reason.includes("APITimeoutError"), true);
  assert.equal(
    outcome.value.reason.includes("SECRET_INTERNAL_BODY_DO_NOT_LEAK"),
    false,
  );

  const decision = classify(input.group, undefined, input.context, {
    runner: () => ({ status: outcome.status, value: outcome.value }),
  });
  assert.equal(decision.status, "veto");
  assert.equal(VETO_REASONS.includes(decision.reason), true);
  assert.equal(decision.reason, "no_decision");
});

test("unusable answers in one category count as a failed category and return a negative verdict", async (t) => {
  const { homeDir, input } = makeTurnFixture(t);
  const { sdk } = makeStubSdk((categoryName) => {
    if (categoryName === "developer_reflection") {
      return Promise.resolve({
        model: "jev-2026-10",
        answers: {
          ...VALID_ANSWERS_BY_CATEGORY.developer_reflection,
          reflex_approval: { type: "noul", noul: 1.5 },
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
  assert.deepEqual(runnerResult, { status: "ok", value: fallbackVerdict });
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
    stateRunner: () => ({ status: "ok", value: validStateFixture() }),
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
  assert.equal(outcome.value.subcategory, "general");
  assert.equal(outcome.value.confidence, 0.306);
  assert.equal(outcome.value.reason.includes("stage_3_interim"), false);
  assert.equal(outcome.value.reason.includes("developer_intent"), true);

  const decision = classify(input.group, undefined, input.context, {
    runner: () => ({ status: outcome.status, value: outcome.value }),
  });
  assert.equal(decision.status, "veto");
  assert.equal(decision.reason, "low_confidence");
});

test("the per-call budgets fit inside the runner kill and child plus fallback fit inside the Stop hook timeout", () => {
  const hooksConfig = JSON.parse(fs.readFileSync(HOOKS_JSON_PATH, "utf8"));
  const stopHookSeconds = hooksConfig.hooks.Stop[0].hooks[0].timeout;
  const stopHookTimeoutMs = stopHookSeconds * 1000;

  assert.equal(SDK_TIMEOUT_MS, CATEGORY_TIMEOUT_MS);
  assert.ok(MARGIN_MS > 0);
  assert.ok(
    STATE_TIMEOUT_MS + CATEGORY_TIMEOUT_MS < JEV_TIMEOUT_MS,
    "Sonnet state timeout plus parallel category timeout must finish before the runner kills the child",
  );
  assert.equal(
    STATE_TIMEOUT_MS + SDK_TIMEOUT_MS + MARGIN_MS,
    JEV_TIMEOUT_MS,
    "JEV_TIMEOUT_MS must equal the state budget plus parallel SDK timeout plus margin",
  );
  assert.ok(
    JEV_TIMEOUT_MS + FALLBACK_TIMEOUT_MS < stopHookTimeoutMs,
    "worst-case child kill plus fallback timeout must fit inside the Stop hook budget",
  );
});

test("an important AI decision accepted reflexively pauses on every preset, while the developer's own justified decision or a trivial change does not pause", async (t) => {
  const { homeDir, input } = makeTurnFixture(t);

  const importantReflexiveAnswers = {
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
  };

  for (const preset of PRESET_NAMES) {
    const { sdk } = makeStubSdk((categoryName) =>
      Promise.resolve({
        model: "jev-2026-10",
        answers: importantReflexiveAnswers[categoryName],
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
      { runner: () => ({ status: outcome.status, value: outcome.value }) },
    );

    assert.equal(decision.status, "pass", `expected pause on ${preset}`);
    assert.equal(decision.classification.category, "security");
    assert.equal(decision.classification.subcategory, "security_auth");
    assert.equal(outcome.value.reason.includes("decision_weight"), true);
  }

  const ownJustifiedAnswers = {
    ...importantReflexiveAnswers,
    developer_intent: noulAnswers({
      own_idea: 1,
      refining_own_proposal: 0.9,
      specific_request: 1,
      accepting_ai_proposal: 0,
    }),
    developer_reflection: noulAnswers({
      reflex_approval: 0,
      justified_choice: 1,
      asked_questions: 0.8,
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
      { runner: () => ({ status: outcome.status, value: outcome.value }) },
    );

    assert.equal(decision.status, "veto");
    assert.equal(decision.reason, "no_decision");
    assert.equal(outcome.value.confidence, 0);
  }

  const trivialReflexiveAnswers = {
    ...importantReflexiveAnswers,
    decision_weight: noulAnswers({
      logic_and_size: 0.05,
      one_way_decision: 0,
      non_code_decision: 0,
      unaware_decision_cascade: 0,
    }),
  };
  const { sdk: trivialSdk } = makeStubSdk((categoryName) =>
    Promise.resolve({
      model: "jev-2026-10",
      answers: trivialReflexiveAnswers[categoryName],
    }),
  );
  const trivialOutcome = await classifyTurn(input, {
    homeDir,
    config: { preset: "vigilant", classifier_model: "jev-latest" },
    stateRunner: () => ({
      status: "ok",
      value: validStateFixture({ area_label: "security_auth" }),
    }),
    sdk: trivialSdk,
  });
  const trivialDecision = classify(
    input.group,
    { preset: "vigilant", classifier_model: "jev-latest" },
    input.context,
    {
      runner: () => ({
        status: trivialOutcome.status,
        value: trivialOutcome.value,
      }),
    },
  );
  assert.equal(trivialDecision.status, "veto");
  assert.equal(trivialDecision.reason, "low_confidence");
  assert.equal(trivialOutcome.value.reason.includes("decision_weight"), true);
});

test("a non-code ADR decision pauses with an empty diff, refining one's own proposal or asking questions lowers p without double-counting, and repeated unaware acceptances raise p", async (t) => {
  const { homeDir, input } = makeTurnFixture(t);

  const adrAnswers = {
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
      reflex_approval: 0.9,
      justified_choice: 0,
      asked_questions: 0,
      suggested_fixes: 0,
      bare_pick_streak: 0.5,
    }),
  };

  const { sdk: adrSdk } = makeStubSdk((categoryName) =>
    Promise.resolve({
      model: "jev-2026-10",
      answers: adrAnswers[categoryName],
    }),
  );
  const adrOutcome = await classifyTurn(
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
      sdk: adrSdk,
    },
  );
  const adrDecision = classify(
    input.group,
    { classifier_model: "jev-latest" },
    input.context,
    { runner: () => ({ status: adrOutcome.status, value: adrOutcome.value }) },
  );
  assert.equal(adrDecision.status, "pass");
  assert.equal(adrDecision.classification.category, "architecture");
  assert.equal(adrDecision.classification.subcategory, "architecture_pattern");

  const baselineReactive = combineProbabilities({
    decision_weight: 0.8,
    decision_ownership: 0.8,
    developer_reflection: 0.2,
    developer_intent: 0.0,
  });
  const refiningOwnProposal = combineProbabilities({
    decision_weight: 0.8,
    decision_ownership: 0.8,
    developer_reflection: 0.2,
    developer_intent: 0.81,
  });
  const bothHighReflectionAndIntent = combineProbabilities({
    decision_weight: 0.8,
    decision_ownership: 0.8,
    developer_reflection: 0.8,
    developer_intent: 0.8,
  });

  assert.ok(
    refiningOwnProposal.effectiveReflection >
      baselineReactive.effectiveReflection,
  );
  assert.ok(
    refiningOwnProposal.pauseProbability < baselineReactive.pauseProbability,
  );
  assert.equal(
    bothHighReflectionAndIntent.effectiveReflection,
    0.8,
    "combining developer_intent and developer_reflection by max must not double-count",
  );

  const withQuestionsAnswers = {
    ...adrAnswers,
    developer_reflection: noulAnswers({
      reflex_approval: 0,
      justified_choice: 0,
      asked_questions: 0.8,
      suggested_fixes: 0.75,
      bare_pick_streak: 0,
    }),
  };
  const adrProbs = probabilitiesByCategory(adrAnswers, CATEGORY_REGISTRY);
  const questionedProbs = probabilitiesByCategory(
    withQuestionsAnswers,
    CATEGORY_REGISTRY,
  );
  assert.ok(
    combineProbabilities(questionedProbs).pauseProbability <
      combineProbabilities(adrProbs).pauseProbability,
  );

  const singleUnawareProbs = probabilitiesByCategory(
    {
      ...adrAnswers,
      decision_weight: noulAnswers({
        logic_and_size: 0.35,
        one_way_decision: 0,
        non_code_decision: 0,
        unaware_decision_cascade: 0,
      }),
    },
    CATEGORY_REGISTRY,
  );
  const cascadingUnawareProbs = probabilitiesByCategory(
    {
      ...adrAnswers,
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
    combineProbabilities(cascadingUnawareProbs).pauseProbability >
      combineProbabilities(singleUnawareProbs).pauseProbability,
  );
});

test("pause_probability = 0.35 maps to calm 0.42 (veto low_confidence), balanced 0.60 (pause), vigilant 0.84 (pause), and personal state.preset overrides config.preset", async (t) => {
  const { projectDir, homeDir, input } = makeTurnFixture(t);
  const answersForPointThreeFive = {
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
      reflex_approval: 1,
      justified_choice: 0,
      asked_questions: 0,
      suggested_fixes: 0,
      bare_pick_streak: 0,
    }),
  };

  const { sdk } = makeStubSdk((categoryName) =>
    Promise.resolve({
      model: "jev-2026-10",
      answers: answersForPointThreeFive[categoryName],
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
  const calmDecision = classify(
    input.group,
    { classifier_model: "jev-latest" },
    input.context,
    {
      runner: () => ({
        status: calmOutcome.status,
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
  const balancedDecision = classify(
    input.group,
    { classifier_model: "jev-latest" },
    input.context,
    {
      runner: () => ({
        status: balancedOutcome.status,
        value: balancedOutcome.value,
      }),
    },
  );
  assert.equal(balancedDecision.status, "pass");

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
  const vigilantDecision = classify(
    input.group,
    { classifier_model: "jev-latest" },
    input.context,
    {
      runner: () => ({
        status: personalOverrideOutcome.status,
        value: personalOverrideOutcome.value,
      }),
    },
  );
  assert.equal(vigilantDecision.status, "pass");
});

test("low pause_probability maps to an existing veto reason, reason names the driving category, general obeys mutes on the Jev path, and a negative Jev verdict never falls back", (t) => {
  const { input } = makeTurnFixture(t);

  const limitedByWeight = buildVerdict(
    {
      decision_weight: 0.05,
      decision_ownership: 0.9,
      developer_reflection: 0,
      developer_intent: 0,
    },
    "none",
    { preset: "balanced" },
    {},
  );
  assert.equal(limitedByWeight.decision_found, true);
  assert.equal(limitedByWeight.subcategory, "general");
  assert.equal(limitedByWeight.reason.includes("decision_weight"), true);
  assert.equal(limitedByWeight.reason.includes("decision_ownership"), false);

  const limitedByOwnership = buildVerdict(
    {
      decision_weight: 0.9,
      decision_ownership: 0.05,
      developer_reflection: 0,
      developer_intent: 0,
    },
    "security_auth",
    { preset: "balanced" },
    {},
  );
  assert.equal(limitedByOwnership.subcategory, "security_auth");
  assert.equal(limitedByOwnership.reason.includes("decision_ownership"), true);
  assert.equal(limitedByOwnership.reason.includes("decision_weight"), false);

  const limitedByReflection = buildVerdict(
    {
      decision_weight: 0.9,
      decision_ownership: 0.9,
      developer_reflection: 1,
      developer_intent: 0,
    },
    "security_auth",
    { preset: "balanced" },
    {},
  );
  assert.equal(limitedByReflection.decision_found, false);
  assert.equal(
    limitedByReflection.reason.includes("developer_reflection"),
    true,
  );

  const generalPassVerdict = buildVerdict(
    {
      decision_weight: 0.9,
      decision_ownership: 0.9,
      developer_reflection: 0,
      developer_intent: 0,
    },
    "none",
    { preset: "balanced", classifier_model: "jev-latest" },
    {},
  );
  assert.equal(generalPassVerdict.subcategory, "general");

  const mutedGeneralDecision = decideFire(
    {
      score: 20,
      last_update: 0,
      mutes: [{ category: "general", files: null, expires_at: 2_000_000_000 }],
      skip_streak: {},
      skip_totals: {},
    },
    { classifier_model: "jev-latest" },
    input.group,
    input.context,
    {
      now: 1_000_000_000,
      runner: () => ({ status: "ok", value: generalPassVerdict }),
    },
  );
  assert.equal(mutedGeneralDecision.outcome, "muted");
  assert.equal(mutedGeneralDecision.classification.category, "general");

  const fallbackCalls = [];
  const negativeChildOutput = {
    status: "ok",
    value: limitedByWeight,
    log: { status: "ok" },
  };
  const negativeRunnerResult = runJev(input.prompt, {
    model: "jev-latest",
    group: input.group,
    context: input.context,
    spawn: () => ({
      status: 0,
      stdout: `${JSON.stringify(negativeChildOutput)}\n`,
    }),
    fallback: (prompt, options) => {
      fallbackCalls.push({ prompt, options });
      return { status: "ok", value: generalPassVerdict };
    },
  });
  assert.equal(
    fallbackCalls.length,
    0,
    "a negative Jev verdict must never fall back to Haiku",
  );
  assert.deepEqual(negativeRunnerResult, {
    status: "ok",
    value: limitedByWeight,
  });

  for (const infraStatus of [
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
    runJev(input.prompt, {
      model: "jev-latest",
      group: input.group,
      context: input.context,
      spawn: () => ({
        status: 1,
        stdout: `${JSON.stringify({ status: infraStatus, error: infraStatus })}\n`,
      }),
      fallback: (prompt, options) => {
        calls.push({ prompt, options });
        return { status: "ok", value: limitedByReflection };
      },
    });
    assert.equal(calls.length, 1, `expected fallback on ${infraStatus}`);
    assert.equal(calls[0].options.model, FALLBACK_MODEL);
    assert.equal(calls[0].options.model, "claude-haiku-5-5");
    assert.equal(calls[0].options.timeoutMs, FALLBACK_TIMEOUT_MS);
  }
});
