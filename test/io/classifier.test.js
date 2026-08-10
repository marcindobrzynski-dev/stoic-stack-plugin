import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROMPT_TEXT_LIMIT,
  TOUCHED_FILE_LIMIT,
  buildClassificationPrompt,
  validateClassification,
} from "../../src/io/classifier.js";
import {
  CATEGORIES,
  SUBCATEGORIES,
  allowedSubcategories,
} from "../../src/io/config.js";

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
