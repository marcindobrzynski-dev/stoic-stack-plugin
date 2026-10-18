// JSON Schema v3 and strict validator for the Sonnet structured session state.
//
// Exists as its own module so the schema constant passed to `claude -p
// --json-schema` and the code-side validator stay in lockstep, with per-category
// sections derived from `CATEGORY_REGISTRY` rather than duplicated by hand.
//
// Pure: no I/O, no clock, no environment reads, and no runtime dependencies.
// `validateStructuredState` never throws and never guesses or repairs invalid
// fields: any mismatch returns `{ ok: false, reason }` so the caller treats it
// as an infrastructure failure (`state_invalid`) and falls back.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §Classifier verdict (LLM #1).
//
// Experiment only (`feature/jev-classifier-experiment`, never merged).
import { isNonEmptyString, isPlainObject } from "../../src/core/predicates.js";
import { CATEGORY_REGISTRY } from "./categories/index.js";
import { STATE_SCHEMA_VERSION, SUMMARY_MAX_CHARS } from "./constants.js";

/** Allowed values for `developer_intent.intent_scale`. */
export const INTENT_SCALE_VALUES = Object.freeze([
  "asks_for_solution",
  "refines_own_proposal",
  "brings_ready_decision",
]);

/** Allowed values for `decision_ownership.decisions[].made_by`. */
export const DECISION_MADE_BY_VALUES = Object.freeze(["ai", "developer"]);

/** Allowed values for `decision_ownership.decisions[].decision_kind`. */
export const DECISION_KIND_VALUES = Object.freeze(["code", "non_code"]);

/** Required boolean keys inside `developer_reflection.reflection_signals`. */
export const REFLECTION_SIGNAL_KEYS = Object.freeze([
  "justified_choice",
  "asked_questions",
  "discussed_alternatives",
  "suggested_fixes",
  "reflex_approval",
]);

/** JSON Schema definitions for the four agreed category state sections. */
export const SECTION_SCHEMAS = Object.freeze({
  developer_intent: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["developer_request", "intent_scale"]),
    properties: Object.freeze({
      developer_request: Object.freeze({ type: "string", minLength: 1 }),
      intent_scale: Object.freeze({
        type: "string",
        enum: INTENT_SCALE_VALUES,
      }),
    }),
  }),
  decision_ownership: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["decisions"]),
    properties: Object.freeze({
      decisions: Object.freeze({
        type: "array",
        items: Object.freeze({
          type: "object",
          additionalProperties: false,
          required: Object.freeze([
            "what",
            "made_by",
            "developer_aware",
            "decision_kind",
          ]),
          properties: Object.freeze({
            what: Object.freeze({ type: "string", minLength: 1 }),
            made_by: Object.freeze({
              type: "string",
              enum: DECISION_MADE_BY_VALUES,
            }),
            developer_aware: Object.freeze({ type: "boolean" }),
            decision_kind: Object.freeze({
              type: "string",
              enum: DECISION_KIND_VALUES,
            }),
          }),
        }),
      }),
    }),
  }),
  decision_weight: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze([
      "file_changes",
      "non_code_decision",
      "unaware_decision_count",
    ]),
    properties: Object.freeze({
      file_changes: Object.freeze({
        type: "array",
        items: Object.freeze({
          type: "object",
          additionalProperties: false,
          required: Object.freeze([
            "file_path",
            "diff_size",
            "logic_touched",
            "one_way",
          ]),
          properties: Object.freeze({
            file_path: Object.freeze({ type: "string", minLength: 1 }),
            diff_size: Object.freeze({ type: "integer", minimum: 0 }),
            logic_touched: Object.freeze({ type: "boolean" }),
            one_way: Object.freeze({ type: "boolean" }),
          }),
        }),
      }),
      non_code_decision: Object.freeze({ type: "boolean" }),
      unaware_decision_count: Object.freeze({ type: "integer", minimum: 0 }),
    }),
  }),
  developer_reflection: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze(["reflection_signals", "bare_pick_streak"]),
    properties: Object.freeze({
      reflection_signals: Object.freeze({
        type: "object",
        additionalProperties: false,
        required: REFLECTION_SIGNAL_KEYS,
        properties: Object.freeze({
          justified_choice: Object.freeze({ type: "boolean" }),
          asked_questions: Object.freeze({ type: "boolean" }),
          discussed_alternatives: Object.freeze({ type: "boolean" }),
          suggested_fixes: Object.freeze({ type: "boolean" }),
          reflex_approval: Object.freeze({ type: "boolean" }),
        }),
      }),
      bare_pick_streak: Object.freeze({ type: "integer", minimum: 0 }),
    }),
  }),
});

/**
 * Whether a value is a non-negative safe integer.
 *
 * @param {unknown} value - Candidate value.
 * @returns {boolean} True for integers >= 0.
 */
function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Validate `developer_intent` section fields.
 *
 * @param {object} section - Candidate `developer_intent` object.
 * @returns {string|null} Failure reason, or null when valid.
 */
function validateDeveloperIntentSection(section) {
  if (!isNonEmptyString(section.developer_request)) {
    return "invalid_developer_intent:developer_request";
  }
  if (!INTENT_SCALE_VALUES.includes(section.intent_scale)) {
    return "invalid_developer_intent:intent_scale";
  }
  return null;
}

/**
 * Validate `decision_ownership` section fields.
 *
 * @param {object} section - Candidate `decision_ownership` object.
 * @returns {string|null} Failure reason, or null when valid.
 */
function validateDecisionOwnershipSection(section) {
  if (!Array.isArray(section.decisions)) {
    return "invalid_decision_ownership:decisions";
  }
  for (const decision of section.decisions) {
    if (
      !isPlainObject(decision) ||
      !isNonEmptyString(decision.what) ||
      !DECISION_MADE_BY_VALUES.includes(decision.made_by) ||
      typeof decision.developer_aware !== "boolean" ||
      !DECISION_KIND_VALUES.includes(decision.decision_kind)
    ) {
      return "invalid_decision_ownership:decision_entry";
    }
  }
  return null;
}

/**
 * Validate `decision_weight` section fields.
 *
 * @param {object} section - Candidate `decision_weight` object.
 * @returns {string|null} Failure reason, or null when valid.
 */
function validateDecisionWeightSection(section) {
  if (!Array.isArray(section.file_changes)) {
    return "invalid_decision_weight:file_changes";
  }
  for (const change of section.file_changes) {
    if (
      !isPlainObject(change) ||
      !isNonEmptyString(change.file_path) ||
      !isNonNegativeInteger(change.diff_size) ||
      typeof change.logic_touched !== "boolean" ||
      typeof change.one_way !== "boolean"
    ) {
      return "invalid_decision_weight:file_change_entry";
    }
  }
  if (typeof section.non_code_decision !== "boolean") {
    return "invalid_decision_weight:non_code_decision";
  }
  if (!isNonNegativeInteger(section.unaware_decision_count)) {
    return "invalid_decision_weight:unaware_decision_count";
  }
  return null;
}

/**
 * Validate `developer_reflection` section fields.
 *
 * @param {object} section - Candidate `developer_reflection` object.
 * @returns {string|null} Failure reason, or null when valid.
 */
function validateDeveloperReflectionSection(section) {
  if (!isPlainObject(section.reflection_signals)) {
    return "invalid_developer_reflection:reflection_signals";
  }
  for (const key of REFLECTION_SIGNAL_KEYS) {
    if (typeof section.reflection_signals[key] !== "boolean") {
      return `invalid_developer_reflection:reflection_signals.${key}`;
    }
  }
  if (!isNonNegativeInteger(section.bare_pick_streak)) {
    return "invalid_developer_reflection:bare_pick_streak";
  }
  return null;
}

/** Built-in section validators keyed by `stateSection`. */
const SECTION_VALIDATORS = Object.freeze({
  developer_intent: validateDeveloperIntentSection,
  decision_ownership: validateDecisionOwnershipSection,
  decision_weight: validateDecisionWeightSection,
  developer_reflection: validateDeveloperReflectionSection,
});

/**
 * Build the JSON Schema v3 object for the structured session state, deriving
 * the required category section properties from `registry`.
 *
 * @param {readonly object[]} [registry] - Category registry; defaults to
 *   `CATEGORY_REGISTRY`.
 * @returns {object} Frozen JSON Schema object.
 */
export function buildStateSchema(registry = CATEGORY_REGISTRY) {
  const categories = Array.isArray(registry) ? registry : CATEGORY_REGISTRY;
  const sectionProperties = {};
  const sectionNames = [];

  for (const category of categories) {
    if (isPlainObject(category) && isNonEmptyString(category.stateSection)) {
      sectionNames.push(category.stateSection);
      const customSchema = isPlainObject(category.sectionSchema)
        ? category.sectionSchema
        : SECTION_SCHEMAS[category.stateSection];
      sectionProperties[category.stateSection] =
        customSchema ?? Object.freeze({ type: "object" });
    }
  }

  return Object.freeze({
    type: "object",
    additionalProperties: false,
    required: Object.freeze([
      "schema_version",
      ...sectionNames,
      "area_label",
      "summary",
    ]),
    properties: Object.freeze({
      schema_version: Object.freeze({
        type: "integer",
        const: STATE_SCHEMA_VERSION,
      }),
      ...sectionProperties,
      area_label: Object.freeze({
        type: "string",
        minLength: 1,
      }),
      summary: Object.freeze({
        type: "string",
        maxLength: SUMMARY_MAX_CHARS,
      }),
    }),
  });
}

/** Shared JSON Schema v3 constant for the four agreed categories. */
export const STATE_SCHEMA = buildStateSchema(CATEGORY_REGISTRY);

/**
 * Strictly validate a candidate structured state object in code. Never throws,
 * and never guesses or repairs malformed fields.
 *
 * @param {unknown} candidate - Parsed structured output from Sonnet.
 * @param {readonly object[]} [registry] - Category registry; defaults to
 *   `CATEGORY_REGISTRY`.
 * @returns {{ ok: true, value: object } | { ok: false, reason: string }}
 *   Validation outcome with a readable failure reason when rejected.
 */
export function validateStructuredState(
  candidate,
  registry = CATEGORY_REGISTRY,
) {
  if (!isPlainObject(candidate)) {
    return { ok: false, reason: "state_not_an_object" };
  }

  if (candidate.schema_version !== STATE_SCHEMA_VERSION) {
    return { ok: false, reason: "invalid_schema_version" };
  }

  const categories = Array.isArray(registry) ? registry : CATEGORY_REGISTRY;

  for (const category of categories) {
    const sectionKey = category?.stateSection;
    if (!isNonEmptyString(sectionKey)) {
      continue;
    }
    if (
      !Object.prototype.hasOwnProperty.call(candidate, sectionKey) ||
      !isPlainObject(candidate[sectionKey])
    ) {
      return { ok: false, reason: `missing_section:${sectionKey}` };
    }

    const validator =
      typeof category.validateSection === "function"
        ? category.validateSection
        : SECTION_VALIDATORS[sectionKey];
    if (typeof validator === "function") {
      const sectionReason = validator(candidate[sectionKey]);
      if (typeof sectionReason === "string" && sectionReason.length > 0) {
        return { ok: false, reason: sectionReason };
      }
    }
  }

  if (!isNonEmptyString(candidate.area_label)) {
    return { ok: false, reason: "invalid_area_label" };
  }

  if (typeof candidate.summary !== "string") {
    return { ok: false, reason: "invalid_summary" };
  }

  if (candidate.summary.length > SUMMARY_MAX_CHARS) {
    return { ok: false, reason: "summary_too_long" };
  }

  return { ok: true, value: candidate };
}
