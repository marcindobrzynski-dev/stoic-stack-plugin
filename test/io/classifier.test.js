import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROMPT_TEXT_LIMIT,
  TOUCHED_FILE_LIMIT,
  VETO_REASONS,
  buildClassificationPrompt,
  classify,
  validateClassification,
} from "../../src/io/classifier.js";
import {
  CATEGORIES,
  SUBCATEGORIES,
  allowedSubcategories,
  defaultConfig,
} from "../../src/io/config/config.js";

/** Every built-in subcategory name, flattened — the taxonomy the prompt must not restate. */
const ALL_SUBCATEGORIES = CATEGORIES.flatMap((area) => [
  ...SUBCATEGORIES[area],
]);

/** A turn group carrying only the fields the classifier prompt reads. */
function group(overrides) {
  return {
    prompt: "Should the session token live in a cookie or in local storage?",
    edit_count: 3,
    lines_added: 40,
    lines_removed: 12,
    edits: [
      { file: "src/auth/session.js", lines_added: 30, lines_removed: 10 },
      { file: "src/auth/token.js", lines_added: 10, lines_removed: 2 },
    ],
    ...overrides,
  };
}

// --- Prompt: vocabulary ----------------------------------------------------

test("the prompt offers exactly the enabled subcategory vocabulary", () => {
  const prompt = buildClassificationPrompt(group(), undefined);

  assert.ok(prompt.includes(JSON.stringify(allowedSubcategories(undefined))));
  for (const subcategory of ALL_SUBCATEGORIES) {
    assert.ok(prompt.includes(subcategory), `missing ${subcategory}`);
  }
});

test("a pruned subcategory is never offered to the classifier", () => {
  const config = { subcategories: { security: ["authorization"] } };

  const prompt = buildClassificationPrompt(group(), config);

  assert.ok(prompt.includes("authorization"));
  assert.ok(!prompt.includes("secret_management"));
});

test("a disabled decision area contributes no vocabulary", () => {
  const config = { categories: ["security"] };

  const prompt = buildClassificationPrompt(group(), config);

  assert.ok(prompt.includes("security_auth"));
  for (const subcategory of SUBCATEGORIES.architecture) {
    assert.ok(!prompt.includes(subcategory), `leaked ${subcategory}`);
  }
});

test("an empty enabled vocabulary still builds a prompt and restates no taxonomy", () => {
  const prompt = buildClassificationPrompt(group(), { categories: [] });

  assert.ok(prompt.includes("[]"));
  for (const subcategory of ALL_SUBCATEGORIES) {
    assert.ok(!prompt.includes(subcategory), `hardcoded ${subcategory}`);
  }
  for (const area of CATEGORIES) {
    assert.ok(!prompt.includes(area), `hardcoded ${area}`);
  }
});

// --- Prompt: turn data -----------------------------------------------------

test("the prompt embeds the turn group's prompt text, volume, and touched files", () => {
  const prompt = buildClassificationPrompt(group(), undefined);

  assert.ok(prompt.includes(JSON.stringify(group().prompt)));
  assert.ok(prompt.includes("3"));
  assert.ok(prompt.includes("+40"));
  assert.ok(prompt.includes("-12"));
  assert.ok(
    prompt.includes(
      JSON.stringify(["src/auth/session.js", "src/auth/token.js"]),
    ),
  );
});

test("a file touched by several edits is listed once", () => {
  const edits = [
    { file: "src/auth/session.js" },
    { file: "src/auth/session.js" },
    { file: "src/auth/token.js" },
  ];

  const prompt = buildClassificationPrompt(group({ edits }), undefined);

  assert.ok(
    prompt.includes(
      JSON.stringify(["src/auth/session.js", "src/auth/token.js"]),
    ),
  );
});

test("a missing or malformed turn group falls back to empty, zeroed data", () => {
  for (const candidate of [undefined, null, "not a group", [], 7]) {
    const prompt = buildClassificationPrompt(candidate, undefined);

    assert.ok(prompt.includes('""'));
    assert.ok(prompt.includes("+0"));
    assert.ok(prompt.includes("-0"));
    assert.ok(prompt.includes("[]"));
  }
});

test("mistyped turn-group fields fall back rather than reaching the prompt", () => {
  const prompt = buildClassificationPrompt(
    group({
      prompt: 42,
      edit_count: "many",
      lines_added: Number.NaN,
      lines_removed: Number.POSITIVE_INFINITY,
      edits: [{ file: "" }, { file: 3 }, "not an edit", null],
    }),
    undefined,
  );

  assert.ok(prompt.includes('""'));
  assert.ok(prompt.includes("+0"));
  assert.ok(prompt.includes("-0"));
  assert.ok(prompt.includes("[]"));
  assert.ok(!prompt.includes("many"));
});

// --- Prompt: caps ----------------------------------------------------------

test("an oversized prompt text is truncated to the documented limit", () => {
  const text = `${"a".repeat(PROMPT_TEXT_LIMIT)}TAIL_MARKER`;

  const prompt = buildClassificationPrompt(group({ prompt: text }), undefined);

  assert.ok(prompt.includes(JSON.stringify("a".repeat(PROMPT_TEXT_LIMIT))));
  assert.ok(!prompt.includes("TAIL_MARKER"));
});

test("an oversized touched-file list is bounded to the documented limit", () => {
  const edits = Array.from({ length: TOUCHED_FILE_LIMIT + 5 }, (_, index) => ({
    file: `src/file-${index}.js`,
  }));

  const prompt = buildClassificationPrompt(group({ edits }), undefined);

  assert.ok(prompt.includes(`src/file-${TOUCHED_FILE_LIMIT - 1}.js`));
  assert.ok(!prompt.includes(`src/file-${TOUCHED_FILE_LIMIT}.js`));
});

// --- Prompt: requested verdict shape ---------------------------------------

test("the prompt requests exactly the canonical verdict shape as bare JSON", () => {
  const prompt = buildClassificationPrompt(group(), undefined);

  for (const field of [
    "decision_found",
    "subcategory",
    "reason",
    "confidence",
  ]) {
    assert.ok(prompt.includes(field), `missing ${field}`);
  }
  assert.ok(!prompt.includes("in_control"));
  assert.ok(/no prose/i.test(prompt));
  assert.ok(/no markdown/i.test(prompt));
});

// --- Verdict validation: rejection -----------------------------------------

test("anything that is not a JSON object is no classification at all", () => {
  for (const candidate of [undefined, null, "{}", 7, true, [], () => {}]) {
    assert.equal(validateClassification(candidate, undefined), null);
  }
});

test("a verdict without a boolean decision_found is no classification at all", () => {
  for (const candidate of [
    {},
    { decision_found: "true" },
    { decision_found: 1 },
    { decision_found: null },
    { subcategory: "security_auth", confidence: 0.9 },
  ]) {
    assert.equal(validateClassification(candidate, undefined), null);
  }
});

// --- Verdict validation: coercion ------------------------------------------

test("a validated classification carries exactly the pending-pause fields", () => {
  const classification = validateClassification(
    {
      decision_found: true,
      subcategory: "security_auth",
      reason: "The turn chose a token storage strategy.",
      confidence: 0.82,
      in_control: true,
      extra: "ignored",
    },
    undefined,
  );

  assert.deepEqual(Object.keys(classification).sort(), [
    "category",
    "confidence",
    "decision_found",
    "reason",
    "subcategory",
  ]);
  assert.deepEqual(classification, {
    decision_found: true,
    category: "security",
    subcategory: "security_auth",
    reason: "The turn chose a token storage strategy.",
    confidence: 0.82,
  });
});

test("decision_found false is a classification, not a rejection", () => {
  const classification = validateClassification(
    { decision_found: false, subcategory: "security_auth", confidence: 0.9 },
    undefined,
  );

  assert.equal(classification.decision_found, false);
  assert.equal(classification.category, "security");
});

test("a missing or mistyped reason becomes an empty string", () => {
  for (const candidate of [undefined, null, 42, { text: "x" }, ["x"]]) {
    const classification = validateClassification(
      { decision_found: true, reason: candidate },
      undefined,
    );

    assert.equal(classification.reason, "");
  }
});

test("a missing or unusable confidence becomes zero", () => {
  for (const candidate of [
    undefined,
    null,
    "0.9",
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    const classification = validateClassification(
      { decision_found: true, confidence: candidate },
      undefined,
    );

    assert.equal(classification.confidence, 0);
  }
});

test("confidence is clamped at both bounds and left alone inside them", () => {
  const confidenceOf = (value) =>
    validateClassification(
      { decision_found: true, confidence: value },
      undefined,
    ).confidence;

  assert.equal(confidenceOf(1.5), 1);
  assert.equal(confidenceOf(-0.5), 0);
  assert.equal(confidenceOf(0), 0);
  assert.equal(confidenceOf(1), 1);
  assert.equal(confidenceOf(0.6), 0.6);
});

// --- Verdict validation: category resolution -------------------------------

test("an enabled subcategory resolves to its top-level area", () => {
  const classification = validateClassification(
    { decision_found: true, subcategory: "migration_strategy" },
    undefined,
  );

  assert.equal(classification.category, "data_domain");
  assert.equal(classification.subcategory, "migration_strategy");
});

test("an emitted area name resolves to itself", () => {
  const classification = validateClassification(
    { decision_found: true, subcategory: "architecture" },
    undefined,
  );

  assert.equal(classification.category, "architecture");
  assert.equal(classification.subcategory, "architecture");
});

test("a pruned subcategory does not resolve but is preserved verbatim", () => {
  const classification = validateClassification(
    { decision_found: true, subcategory: "secret_management" },
    { subcategories: { security: ["authorization"] } },
  );

  assert.equal(classification.category, null);
  assert.equal(classification.subcategory, "secret_management");
});

test("a subcategory of a disabled area does not resolve but is preserved verbatim", () => {
  const classification = validateClassification(
    { decision_found: true, subcategory: "architecture_pattern" },
    { categories: ["security"] },
  );

  assert.equal(classification.category, null);
  assert.equal(classification.subcategory, "architecture_pattern");
});

test("an unknown name does not resolve but is preserved verbatim", () => {
  const classification = validateClassification(
    { decision_found: true, subcategory: "vibes" },
    undefined,
  );

  assert.equal(classification.category, null);
  assert.equal(classification.subcategory, "vibes");
});

test("a missing or mistyped subcategory resolves to nothing at all", () => {
  for (const candidate of [undefined, null, "", 42, ["security_auth"]]) {
    const classification = validateClassification(
      { decision_found: true, subcategory: candidate },
      undefined,
    );

    assert.equal(classification.category, null);
    assert.equal(classification.subcategory, null);
  }
});

test("an empty enabled vocabulary resolves nothing", () => {
  const classification = validateClassification(
    { decision_found: true, subcategory: "security_auth", confidence: 1 },
    { categories: [] },
  );

  assert.equal(classification.category, null);
  assert.equal(classification.subcategory, "security_auth");
});

test("a missing or corrupt configuration validates against the built-in taxonomy", () => {
  for (const candidate of [undefined, null, "corrupt", 7, []]) {
    const classification = validateClassification(
      { decision_found: true, subcategory: "api_contract" },
      candidate,
    );

    assert.equal(classification.category, "api_integration");
  }
});

// --- classify: seam helpers ------------------------------------------------

/** The built-in classifier settings, read through their owning module. */
const DEFAULT_MODEL = defaultConfig().classifier_model;
const DEFAULT_THRESHOLD = defaultConfig().classifier_confidence_threshold;

/** A verdict the model could plausibly have emitted, with overrides. */
function verdict(overrides) {
  return {
    decision_found: true,
    subcategory: "security_auth",
    reason: "The turn chose a token storage strategy.",
    confidence: 0.9,
    ...overrides,
  };
}

/**
 * A runner seam returning one canned headless result and recording every call,
 * standing in for `runClaude` without spawning anything.
 *
 * @param {unknown} result - The headless result the seam answers with.
 * @returns {{runner: Function, calls: object[]}} Seam and its recorded calls.
 */
function runnerReturning(result) {
  const calls = [];
  const runner = (prompt, options) => {
    calls.push({ prompt, options });
    return result;
  };
  return { runner, calls };
}

/** A runner seam answering with one verdict, as a successful headless call. */
function runnerAnswering(value) {
  return runnerReturning({ status: "ok", value });
}

// --- classify: pass path ---------------------------------------------------

test("a confident, resolvable decision passes the veto gate", () => {
  const { runner } = runnerAnswering(verdict());

  const decision = classify(group(), undefined, undefined, { runner });

  assert.deepEqual(decision, {
    status: "pass",
    reason: null,
    classification: {
      decision_found: true,
      category: "security",
      subcategory: "security_auth",
      reason: "The turn chose a token storage strategy.",
      confidence: 0.9,
    },
  });
});

test("every decision is data with the same three fields", () => {
  const decisions = [
    classify(group(), undefined, undefined, {
      runner: runnerAnswering(verdict()).runner,
    }),
    classify(group(), undefined, undefined, {
      runner: runnerReturning({ status: "unavailable", reason: "timeout" })
        .runner,
    }),
  ];

  for (const decision of decisions) {
    assert.deepEqual(Object.keys(decision).sort(), [
      "classification",
      "reason",
      "status",
    ]);
  }
});

test("the classification prompt, the configured model, the turn group and its context reach the runner", () => {
  const config = { categories: ["security"], classifier_model: "test-model-1" };
  const turn = group({ prompt: "move the session token to a cookie" });
  const context = { stopInput: { session_id: "session-under-test" } };
  const { runner, calls } = runnerAnswering(verdict());

  classify(turn, config, context, { runner });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, buildClassificationPrompt(turn, config));
  assert.equal(calls[0].options.model, "test-model-1");
  assert.equal(calls[0].options.group, turn);
  assert.equal(calls[0].options.context, context);
});

// --- classify: no_classification -------------------------------------------

test("an unavailable runner vetoes as no_classification", () => {
  for (const reason of [
    "invalid_request",
    "spawn_failed",
    "cli_failed",
    "timeout",
    "output_too_large",
    "unparseable",
  ]) {
    const { runner } = runnerReturning({ status: "unavailable", reason });

    const decision = classify(group(), undefined, undefined, { runner });

    assert.deepEqual(decision, {
      status: "veto",
      reason: "no_classification",
      classification: null,
    });
  }
});

test("a throwing runner vetoes as no_classification rather than escaping", () => {
  const runner = () => {
    throw new Error("the runner exploded");
  };

  const decision = classify(group(), undefined, undefined, { runner });

  assert.equal(decision.status, "veto");
  assert.equal(decision.reason, "no_classification");
  assert.equal(decision.classification, null);
});

test("a verdict without a boolean decision_found vetoes as no_classification", () => {
  for (const candidate of [
    {},
    { decision_found: "true", confidence: 1, subcategory: "security_auth" },
    { subcategory: "security_auth", confidence: 1 },
  ]) {
    const { runner } = runnerAnswering(candidate);

    const decision = classify(group(), undefined, undefined, { runner });

    assert.equal(decision.reason, "no_classification");
    assert.equal(decision.classification, null);
  }
});

// --- classify: no_decision -------------------------------------------------

test("decision_found false vetoes as no_decision and keeps the classification", () => {
  const { runner } = runnerAnswering(verdict({ decision_found: false }));

  const decision = classify(group(), undefined, undefined, { runner });

  assert.equal(decision.status, "veto");
  assert.equal(decision.reason, "no_decision");
  assert.equal(decision.classification.decision_found, false);
  assert.equal(decision.classification.category, "security");
});

// --- classify: low_confidence ----------------------------------------------

test("a confidence below the threshold vetoes as low_confidence", () => {
  const { runner } = runnerAnswering(
    verdict({ confidence: DEFAULT_THRESHOLD - 0.01 }),
  );

  const decision = classify(group(), undefined, undefined, { runner });

  assert.equal(decision.status, "veto");
  assert.equal(decision.reason, "low_confidence");
  assert.equal(decision.classification.confidence, DEFAULT_THRESHOLD - 0.01);
});

test("a confidence exactly at the threshold is not low confidence", () => {
  const { runner } = runnerAnswering(
    verdict({ confidence: DEFAULT_THRESHOLD }),
  );

  const decision = classify(group(), undefined, undefined, { runner });

  assert.equal(decision.status, "pass");
  assert.equal(decision.reason, null);
});

test("the configured threshold, not the built-in one, decides low confidence", () => {
  const strict = classify(
    group(),
    { classifier_confidence_threshold: 0.95 },
    undefined,
    {
      runner: runnerAnswering(verdict({ confidence: 0.9 })).runner,
    },
  );
  const lenient = classify(
    group(),
    { classifier_confidence_threshold: 0.1 },
    undefined,
    {
      runner: runnerAnswering(verdict({ confidence: 0.2 })).runner,
    },
  );

  assert.equal(strict.reason, "low_confidence");
  assert.equal(lenient.status, "pass");
});

// --- classify: bad_category ------------------------------------------------

test("an unknown, pruned, or disabled category vetoes as bad_category", () => {
  const cases = [
    { config: undefined, emitted: "vibes" },
    {
      config: { subcategories: { security: ["authorization"] } },
      emitted: "secret_management",
    },
    { config: { categories: ["security"] }, emitted: "architecture_pattern" },
    { config: undefined, emitted: null },
  ];

  for (const { config, emitted } of cases) {
    const { runner } = runnerAnswering(verdict({ subcategory: emitted }));

    const decision = classify(group(), config, undefined, { runner });

    assert.equal(decision.status, "veto", `expected a veto for ${emitted}`);
    assert.equal(decision.reason, "bad_category");
    assert.equal(decision.classification.category, null);
    assert.equal(decision.classification.subcategory, emitted);
  }
});

test("an empty enabled vocabulary vetoes every confident verdict", () => {
  const { runner } = runnerAnswering(verdict({ confidence: 1 }));

  const decision = classify(group(), { categories: [] }, undefined, { runner });

  assert.equal(decision.status, "veto");
  assert.equal(decision.reason, "bad_category");
});

test("general passes on the Jev path when areas are enabled and still vetoes as bad_category on the Haiku path", () => {
  const generalVerdict = verdict({
    subcategory: "general",
    reason: "Cross-cutting decision outside the four built-in areas.",
  });

  const haikuDecision = classify(group(), undefined, undefined, {
    runner: runnerAnswering(generalVerdict).runner,
  });
  assert.equal(haikuDecision.status, "veto");
  assert.equal(haikuDecision.reason, "bad_category");
  assert.equal(haikuDecision.classification.category, null);
  assert.equal(haikuDecision.classification.subcategory, "general");

  const jevDecision = classify(
    group(),
    { classifier_model: "jev-latest" },
    undefined,
    { runner: runnerAnswering(generalVerdict).runner },
  );
  assert.deepEqual(jevDecision, {
    status: "pass",
    reason: null,
    classification: {
      decision_found: true,
      category: "general",
      subcategory: "general",
      reason: "Cross-cutting decision outside the four built-in areas.",
      confidence: 0.9,
    },
  });

  const disabledJevDecision = classify(
    group(),
    { classifier_model: "jev-latest", categories: [] },
    undefined,
    { runner: runnerAnswering(generalVerdict).runner },
  );
  assert.equal(disabledJevDecision.status, "veto");
  assert.equal(disabledJevDecision.reason, "bad_category");
});

// --- classify: veto ordering -----------------------------------------------

test("the veto reasons are the contract's four, in the contract's order", () => {
  assert.deepEqual(
    [...VETO_REASONS],
    ["no_classification", "no_decision", "low_confidence", "bad_category"],
  );
});

test("exactly one veto reason is returned, the earliest that applies", () => {
  const everythingWrong = {
    decision_found: false,
    subcategory: "vibes",
    confidence: 0,
  };
  const belowAndUnresolvable = verdict({
    subcategory: "vibes",
    confidence: 0,
  });

  assert.equal(
    classify(group(), undefined, undefined, {
      runner: runnerAnswering(everythingWrong).runner,
    }).reason,
    "no_decision",
  );
  assert.equal(
    classify(group(), undefined, undefined, {
      runner: runnerAnswering(belowAndUnresolvable).runner,
    }).reason,
    "low_confidence",
  );
  assert.equal(
    classify(group(), undefined, undefined, {
      runner: runnerAnswering("not a verdict at all").runner,
    }).reason,
    "no_classification",
  );
});

// --- classify: configuration fallback --------------------------------------

test("a missing or corrupt configuration falls back to the built-in classifier settings", () => {
  for (const candidate of [undefined, null, "corrupt", 7, [], { preset: 9 }]) {
    const { runner, calls } = runnerAnswering(
      verdict({ confidence: DEFAULT_THRESHOLD }),
    );

    const decision = classify(group(), candidate, undefined, { runner });

    assert.equal(calls[0].options.model, DEFAULT_MODEL);
    assert.equal(decision.status, "pass");
  }
});

test("a corrupt classifier threshold falls back to the built-in one", () => {
  const config = { classifier_confidence_threshold: "very sure" };
  const below = classify(group(), config, undefined, {
    runner: runnerAnswering(verdict({ confidence: DEFAULT_THRESHOLD - 0.01 }))
      .runner,
  });
  const at = classify(group(), config, undefined, {
    runner: runnerAnswering(verdict({ confidence: DEFAULT_THRESHOLD })).runner,
  });

  assert.equal(below.reason, "low_confidence");
  assert.equal(at.status, "pass");
});

// --- classify: fail-safe boundary ------------------------------------------

test("hostile group and options input still yield a decision, never an exception", () => {
  for (const hostileGroup of [undefined, null, "not a group", [], 7]) {
    const { runner } = runnerAnswering(verdict());

    const decision = classify(hostileGroup, undefined, undefined, { runner });

    assert.equal(decision.status, "veto");
    assert.equal(decision.reason, "no_classification");
  }

  // A plain object with garbage fields is still a group: its fields read
  // defensively as an empty summary, and the verdict decides the outcome.
  {
    const { runner } = runnerAnswering(verdict());

    const decision = classify(
      { prompt: 7, edits: "none" },
      undefined,
      undefined,
      {
        runner,
      },
    );

    assert.equal(decision.status, "pass");
  }

  for (const hostileOptions of [undefined, null, "runner", 7, [], {}]) {
    const decision = classify(
      group(),
      { classifier_model: "no such model!" },
      undefined,
      hostileOptions,
    );

    assert.equal(decision.status, "veto");
    assert.equal(decision.reason, "no_classification");
  }
});

test("the production default runner is the real headless module", () => {
  // A model id the headless runner rejects before it ever spawns: the call
  // reaching that validation is what proves the default seam is the real one.
  const decision = classify(group(), { classifier_model: "not a valid id!" });

  assert.equal(decision.status, "veto");
  assert.equal(decision.reason, "no_classification");
  assert.equal(decision.classification, null);
});
