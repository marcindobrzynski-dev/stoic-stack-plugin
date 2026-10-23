import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REFINING_PROPOSAL_WEIGHT,
  developerIntentCategory,
} from "../../../experiments/jev/categories/developer-intent.js";
import { decisionOwnershipCategory } from "../../../experiments/jev/categories/decision-ownership.js";
import { decisionWeightCategory } from "../../../experiments/jev/categories/decision-weight.js";
import {
  BARE_PICK_STREAK_PENALTY,
  developerReflectionCategory,
} from "../../../experiments/jev/categories/developer-reflection.js";
import {
  CATEGORY_NAMES,
  CATEGORY_REGISTRY,
  createCategoryRegistry,
  probabilitiesByCategory,
  questionsByCategory,
  sectionFor,
  sectionsByCategory,
} from "../../../experiments/jev/categories/index.js";

/** Fake SDK builders matching the TypeSafe `noul` and `choice` signatures. */
const fakeSdk = {
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
};

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
const SAMPLE_ANSWERS_BY_CATEGORY = {
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
};

test("the registry lists the four agreed categories in order with questions, mappings, and full readable names", () => {
  assert.deepEqual(CATEGORY_NAMES, [
    "developer_intent",
    "decision_ownership",
    "decision_weight",
    "developer_reflection",
  ]);
  assert.equal(CATEGORY_REGISTRY.length, 4);

  for (const category of CATEGORY_REGISTRY) {
    assert.ok(
      category.readableName.includes(" ") && category.readableName.length > 5,
      `${category.name} must carry a full readable name, not an abbreviation`,
    );
    assert.equal(category.stateSection, category.name);

    const declaredKeys = Object.keys(category.questions);
    assert.ok(
      declaredKeys.length > 0,
      `${category.name} must declare at least one question`,
    );

    const built = category.buildQuestions(fakeSdk);
    assert.deepEqual(Object.keys(built), declaredKeys);
    for (const key of declaredKeys) {
      assert.equal(built[key].type, category.questions[key].type);
      assert.ok(built[key].instructions.length > 0);
    }

    const probability = category.toProbability(
      SAMPLE_ANSWERS_BY_CATEGORY[category.name],
    );
    assert.ok(
      typeof probability === "number" && probability >= 0 && probability <= 1,
      `${category.name}.toProbability must return a probability in [0, 1]`,
    );
  }
});

test("the registry rejects a malformed category module at load", () => {
  const valid = developerIntentCategory;

  const malformedCases = [
    null,
    { ...valid, name: "" },
    { ...valid, name: "CamelCase" },
    { ...valid, readableName: "di" },
    { ...valid, stateSection: "" },
    { ...valid, questions: {} },
    {
      ...valid,
      questions: { broken: { type: "unknown", instructions: "What?" } },
    },
    { ...valid, buildQuestions: null },
    { ...valid, toProbability: null },
  ];

  for (const malformed of malformedCases) {
    assert.throws(() => createCategoryRegistry([malformed]), TypeError);
  }

  assert.throws(
    () => createCategoryRegistry([valid, { ...valid }]),
    TypeError,
    "duplicate category names must be rejected",
  );
  assert.throws(
    () =>
      createCategoryRegistry([
        valid,
        { ...decisionOwnershipCategory, stateSection: valid.stateSection },
      ]),
    TypeError,
    "duplicate stateSection keys must be rejected",
  );
});

test("adding a category to the registry works through every registry helper without code changes elsewhere", () => {
  const fifthCategory = {
    name: "scope_discipline",
    readableName: "Scope discipline",
    stateSection: "scope_discipline",
    questions: {
      unrequested_refactor: {
        type: "noul",
        instructions: "Did the assistant refactor unrelated modules?",
        criteria: {
          true: "It touched files outside the requested scope.",
          false: "It stayed inside the requested scope.",
        },
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

  const state = {
    schema_version: 3,
    developer_intent: { request: "refine design" },
    decision_ownership: { decisions: [] },
    decision_weight: { diff_lines: 12 },
    developer_reflection: { questions_asked: 1 },
    scope_discipline: { out_of_scope_files: 2 },
    area_label: "architecture",
    summary: "Rolling session summary.",
  };

  const sections = sectionsByCategory(state, extendedRegistry);
  assert.deepEqual(Object.keys(sections), [
    ...CATEGORY_NAMES,
    "scope_discipline",
  ]);
  assert.deepEqual(sections.scope_discipline, { out_of_scope_files: 2 });

  const questions = questionsByCategory(fakeSdk, state, extendedRegistry);
  assert.deepEqual(Object.keys(questions), [
    ...CATEGORY_NAMES,
    "scope_discipline",
  ]);
  assert.equal(questions.scope_discipline.unrequested_refactor.type, "noul");

  const probabilities = probabilitiesByCategory(
    {
      ...SAMPLE_ANSWERS_BY_CATEGORY,
      scope_discipline: noulAnswers({ unrequested_refactor: 0.65 }),
    },
    extendedRegistry,
  );
  assert.deepEqual(Object.keys(probabilities), [
    ...CATEGORY_NAMES,
    "scope_discipline",
  ]);
  assert.equal(probabilities.scope_discipline, 0.65);
});

test("each category receives only its own state section", () => {
  const state = {
    schema_version: 3,
    developer_intent: { request_type: "refining_proposal", prompt_count: 1 },
    decision_ownership: { unaware_decisions: ["chose retry policy"] },
    decision_weight: { one_way: true, lines_changed: 4 },
    developer_reflection: { asked_question: true, bare_pick_streak: 0 },
    area_label: "api_integration",
    summary: "Previous session summary that must not leak into a section.",
  };

  assert.equal(CATEGORY_REGISTRY.length, 4);

  for (const category of CATEGORY_REGISTRY) {
    const isolated = sectionFor(category, state);
    assert.deepEqual(isolated, state[category.stateSection]);

    for (const other of CATEGORY_REGISTRY) {
      if (other.name !== category.name) {
        assert.equal(
          other.stateSection in isolated,
          false,
          `${category.name} section must not contain ${other.stateSection}`,
        );
      }
    }
    assert.equal("area_label" in isolated, false);
    assert.equal("summary" in isolated, false);
    assert.equal("schema_version" in isolated, false);

    isolated.mutated = true;
    assert.equal(
      "mutated" in state[category.stateSection],
      false,
      "mutating the extracted section must not mutate the source state",
    );
  }

  assert.equal(sectionFor(developerIntentCategory, null), null);
  assert.equal(sectionFor(developerIntentCategory, {}), null);
});

test("the area label never vetoes or alters any category probability", () => {
  assert.equal(CATEGORY_REGISTRY.length, 4);

  for (const category of CATEGORY_REGISTRY) {
    const baseAnswers = SAMPLE_ANSWERS_BY_CATEGORY[category.name];
    const baseline = category.toProbability(baseAnswers);

    assert.ok(baseline !== null && baseline > 0);

    for (const areaLabel of ["none", "general", "frontend_ui", null]) {
      const withAreaLabel = category.toProbability({
        ...baseAnswers,
        area_label: areaLabel,
        category: {
          type: "choice",
          choice: areaLabel ?? "none",
          confidence: 1,
        },
      });
      assert.equal(
        withAreaLabel,
        baseline,
        `${category.name} must ignore area_label=${String(areaLabel)}`,
      );
    }
  }
});

test("the developer's own idea scores higher than refining a proposal, which scores higher than accepting the assistant", () => {
  const ownIdeaSignal = 1;
  const refiningOwnProposalSignal = 0.5;
  const specificRequestSignal = 0.7;
  const ownIdea = developerIntentCategory.toProbability(
    noulAnswers({
      own_idea: ownIdeaSignal,
      refining_own_proposal: 0,
      specific_request: 0,
      accepting_ai_proposal: 0,
    }),
  );
  const refiningOwnProposal = developerIntentCategory.toProbability(
    noulAnswers({
      own_idea: 0,
      refining_own_proposal: refiningOwnProposalSignal,
      specific_request: 0,
      accepting_ai_proposal: 0,
    }),
  );
  const acceptingAiProposal = developerIntentCategory.toProbability(
    noulAnswers({
      own_idea: 0,
      refining_own_proposal: 0,
      specific_request: specificRequestSignal,
      accepting_ai_proposal: 1,
    }),
  );

  assert.equal(ownIdea, ownIdeaSignal);
  assert.equal(
    refiningOwnProposal,
    refiningOwnProposalSignal * REFINING_PROPOSAL_WEIGHT,
  );
  assert.equal(acceptingAiProposal, 0);
  assert.ok(ownIdea > refiningOwnProposal);
  assert.ok(refiningOwnProposal > acceptingAiProposal);
});

test("unaware AI decisions raise decision ownership", () => {
  const developerAware = decisionOwnershipCategory.toProbability(
    noulAnswers({
      unaware_ai_decision: 0.1,
      ai_beyond_request: 0.05,
      unacknowledged_ai_tradeoff: 0,
    }),
  );
  const unawareDecisionSignal = 0.85;
  const unawareDecision = decisionOwnershipCategory.toProbability(
    noulAnswers({
      unaware_ai_decision: unawareDecisionSignal,
      ai_beyond_request: 0.2,
      unacknowledged_ai_tradeoff: 0.1,
    }),
  );
  const beyondRequest = decisionOwnershipCategory.toProbability(
    noulAnswers({
      unaware_ai_decision: 0.2,
      ai_beyond_request: 0.9,
      unacknowledged_ai_tradeoff: 0.1,
    }),
  );

  assert.equal(unawareDecision, unawareDecisionSignal);
  assert.ok(unawareDecision > developerAware);
  assert.ok(beyondRequest > developerAware);
});

test("reflex approval is not mapped into developer reflection", () => {
  assert.equal(
    Object.hasOwn(developerReflectionCategory.questions, "reflex_approval"),
    false,
  );
  const answers = {
    justified_choice: 0.4,
    asked_questions: 0.2,
    discussed_alternatives: 0.1,
    suggested_fixes: 0.3,
    bare_pick_streak: 0,
  };
  const withoutApproval = developerReflectionCategory.toProbability(answers);
  const withApproval = developerReflectionCategory.toProbability({
    ...answers,
    reflex_approval: 1,
  });

  assert.notEqual(withoutApproval, null);
  assert.equal(withApproval, withoutApproval);
});

test("asking questions, discussing alternatives, or suggesting fixes counts as developer reflection", () => {
  const noReflection = developerReflectionCategory.toProbability(
    noulAnswers({
      justified_choice: 0,
      asked_questions: 0,
      discussed_alternatives: 0,
      suggested_fixes: 0,
      bare_pick_streak: 0,
    }),
  );
  const askedQuestionsSignal = 0.85;
  const withQuestions = developerReflectionCategory.toProbability(
    noulAnswers({
      justified_choice: 0,
      asked_questions: askedQuestionsSignal,
      discussed_alternatives: 0,
      suggested_fixes: 0,
      bare_pick_streak: 0,
    }),
  );
  const withAlternatives = developerReflectionCategory.toProbability(
    noulAnswers({
      justified_choice: 0,
      asked_questions: 0,
      discussed_alternatives: 0.85,
      suggested_fixes: 0,
      bare_pick_streak: 0,
    }),
  );
  const withSuggestedFixes = developerReflectionCategory.toProbability(
    noulAnswers({
      justified_choice: 0,
      asked_questions: 0,
      discussed_alternatives: 0,
      suggested_fixes: 0.85,
      bare_pick_streak: 0,
    }),
  );

  assert.equal(noReflection, 0);
  assert.equal(withQuestions, askedQuestionsSignal);
  assert.ok(withQuestions > noReflection);
  assert.ok(withAlternatives > noReflection);
  assert.ok(withSuggestedFixes > noReflection);
});

test("a streak of bare choices lowers partial developer reflection by the bare-pick penalty", () => {
  const positiveReflection = 0.5;
  const barePickStreak = 1;
  const cleanReflection = developerReflectionCategory.toProbability(
    noulAnswers({
      justified_choice: positiveReflection,
      asked_questions: 0,
      discussed_alternatives: 0,
      suggested_fixes: 0,
      bare_pick_streak: 0,
    }),
  );
  const withBarePickStreak = developerReflectionCategory.toProbability(
    noulAnswers({
      justified_choice: positiveReflection,
      asked_questions: 0,
      discussed_alternatives: 0,
      suggested_fixes: 0,
      bare_pick_streak: barePickStreak,
    }),
  );
  const barePickDrag =
    barePickStreak * BARE_PICK_STREAK_PENALTY * (1 - positiveReflection);

  assert.equal(cleanReflection, positiveReflection);
  assert.equal(withBarePickStreak, positiveReflection * (1 - barePickDrag));
  assert.ok(withBarePickStreak < cleanReflection);
});

test("a small one-way decision gets high decision weight despite a small diff", () => {
  const oneWayDecisionSignal = 0.9;
  const smallOneWay = decisionWeightCategory.toProbability(
    noulAnswers({
      logic_and_size: 0.05,
      one_way_decision: oneWayDecisionSignal,
      non_code_decision: 0,
      unaware_decision_cascade: 0,
    }),
  );
  const smallReversible = decisionWeightCategory.toProbability(
    noulAnswers({
      logic_and_size: 0.05,
      one_way_decision: 0,
      non_code_decision: 0,
      unaware_decision_cascade: 0,
    }),
  );

  assert.equal(smallOneWay, oneWayDecisionSignal);
  assert.ok(smallOneWay > smallReversible);
});

test("repeated unaware acceptances raise the weight of a small decision", () => {
  const isolatedSmallDecision = decisionWeightCategory.toProbability(
    noulAnswers({
      logic_and_size: 0.35,
      one_way_decision: 0,
      non_code_decision: 0,
      unaware_decision_cascade: 0,
    }),
  );
  const cascadingSmallDecisions = decisionWeightCategory.toProbability(
    noulAnswers({
      logic_and_size: 0.35,
      one_way_decision: 0,
      non_code_decision: 0,
      unaware_decision_cascade: 0.3,
    }),
  );

  assert.ok(cascadingSmallDecisions > isolatedSmallDecision);
});

test("a non-code architectural decision carries weight even with an empty diff", () => {
  const nonCodeDecisionSignal = 0.85;
  const nonCodeWithEmptyDiff = decisionWeightCategory.toProbability(
    noulAnswers({
      logic_and_size: 0,
      one_way_decision: 0,
      non_code_decision: nonCodeDecisionSignal,
      unaware_decision_cascade: 0,
    }),
  );

  const emptyDiff = decisionWeightCategory.toProbability(
    noulAnswers({
      logic_and_size: 0,
      one_way_decision: 0,
      non_code_decision: 0,
      unaware_decision_cascade: 0,
    }),
  );

  assert.equal(nonCodeWithEmptyDiff, nonCodeDecisionSignal);
  assert.ok(nonCodeWithEmptyDiff > emptyDiff);
});

test("unusable or incomplete category answers return null instead of guessing", () => {
  assert.equal(CATEGORY_REGISTRY.length, 4);

  for (const category of CATEGORY_REGISTRY) {
    const validAnswers = SAMPLE_ANSWERS_BY_CATEGORY[category.name];
    const firstKey = Object.keys(validAnswers)[0];

    assert.equal(category.toProbability(null), null);
    assert.equal(category.toProbability({}), null);
    assert.equal(
      category.toProbability({ ...validAnswers, [firstKey]: { noul: 1.2 } }),
      null,
    );
    assert.equal(
      category.toProbability({ ...validAnswers, [firstKey]: { noul: -0.1 } }),
      null,
    );
    assert.equal(
      category.toProbability({
        ...validAnswers,
        [firstKey]: { noul: Number.NaN },
      }),
      null,
    );
  }
});
