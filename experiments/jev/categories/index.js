// Ordered category registry for the structured-state Jev experiment.
//
// Single place that registers the evaluation categories and exposes generic
// helpers for state-section isolation, question construction, and probability
// mapping so adding a category requires no switch statements or hardcoded
// category lists elsewhere.
//
// Pure and SDK-injectable: no I/O, no clock, no environment reads, and no
// import of `@typesafe-ai/sdk` at module load. `validateCategory` and
// `createCategoryRegistry` throw a `TypeError` when a category definition is
// malformed; runtime helpers (`sectionFor`, `sectionsByCategory`,
// `probabilitiesByCategory`) never throw.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §Classifier verdict (LLM #1).
import {
  isNonEmptyString,
  isPlainObject,
} from "../../../src/core/predicates.js";
import { readProbability } from "../combine.js";
import { decisionOwnershipCategory } from "./decision-ownership.js";
import { decisionWeightCategory } from "./decision-weight.js";
import { developerIntentCategory } from "./developer-intent.js";
import { developerReflectionCategory } from "./developer-reflection.js";

/** Pattern for canonical snake_case category and question identifiers. */
const SNAKE_CASE_ID = /^[a-z][a-z0-9_]*$/;

/** Supported declarative Jev question types. */
const QUESTION_TYPES = new Set(["noul", "choice"]);

/**
 * Minimum length for `readableName` so short abbreviations are rejected at
 * registration time.
 */
const MIN_READABLE_NAME_LENGTH = 4;

/**
 * Validate a single declarative question specification.
 *
 * @param {string} categoryName - Owning category name, for error messages.
 * @param {string} questionKey - Question identifier.
 * @param {unknown} spec - Declarative question specification.
 * @throws {TypeError} When the question key or specification is malformed.
 */
function validateQuestionSpec(categoryName, questionKey, spec) {
  if (!SNAKE_CASE_ID.test(questionKey)) {
    throw new TypeError(
      `Invalid question key "${questionKey}" in category "${categoryName}": expected snake_case.`,
    );
  }
  if (!isPlainObject(spec) || !QUESTION_TYPES.has(spec.type)) {
    throw new TypeError(
      `Invalid question "${questionKey}" in category "${categoryName}": expected type "noul" or "choice".`,
    );
  }
  if (!isNonEmptyString(spec.instructions)) {
    throw new TypeError(
      `Invalid question "${questionKey}" in category "${categoryName}": expected non-empty instructions.`,
    );
  }
}

/**
 * Validate and freeze a category module descriptor.
 *
 * @param {unknown} category - Candidate category descriptor.
 * @returns {object} A frozen category descriptor.
 * @throws {TypeError} When any required property is missing or malformed.
 */
export function validateCategory(category) {
  if (!isPlainObject(category)) {
    throw new TypeError("Expected a category descriptor object.");
  }

  const {
    name,
    readableName,
    stateSection,
    questions,
    buildQuestions,
    toProbability,
  } = category;

  if (!isNonEmptyString(name) || !SNAKE_CASE_ID.test(name)) {
    throw new TypeError(
      `Invalid category name "${String(name)}": expected snake_case identifier.`,
    );
  }
  if (
    !isNonEmptyString(readableName) ||
    readableName.trim().length < MIN_READABLE_NAME_LENGTH
  ) {
    throw new TypeError(
      `Invalid readableName for category "${name}": expected a full readable name, not an abbreviation.`,
    );
  }
  if (!isNonEmptyString(stateSection) || !SNAKE_CASE_ID.test(stateSection)) {
    throw new TypeError(
      `Invalid stateSection for category "${name}": expected snake_case key.`,
    );
  }
  if (!isPlainObject(questions) || Object.keys(questions).length === 0) {
    throw new TypeError(
      `Invalid questions for category "${name}": expected a non-empty question map.`,
    );
  }

  for (const [questionKey, spec] of Object.entries(questions)) {
    validateQuestionSpec(name, questionKey, spec);
  }

  if (typeof buildQuestions !== "function") {
    throw new TypeError(
      `Invalid buildQuestions for category "${name}": expected a function.`,
    );
  }
  if (typeof toProbability !== "function") {
    throw new TypeError(
      `Invalid toProbability for category "${name}": expected a function.`,
    );
  }

  return Object.freeze({
    name,
    readableName,
    stateSection,
    questions: Object.freeze({ ...questions }),
    buildQuestions,
    toProbability,
  });
}

/**
 * Validate and freeze an ordered list of category descriptors, rejecting
 * empty lists, malformed descriptors, duplicate category names, and duplicate
 * state-section keys.
 *
 * @param {unknown} categories - Ordered array of category descriptors.
 * @returns {readonly object[]} Frozen ordered registry.
 * @throws {TypeError} When the list or any category descriptor is invalid.
 */
export function createCategoryRegistry(categories) {
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new TypeError("Expected a non-empty array of category descriptors.");
  }

  const seenNames = new Set();
  const seenSections = new Set();
  const validated = [];

  for (const candidate of categories) {
    const category = validateCategory(candidate);

    if (seenNames.has(category.name)) {
      throw new TypeError(`Duplicate category name "${category.name}".`);
    }
    if (seenSections.has(category.stateSection)) {
      throw new TypeError(
        `Duplicate stateSection "${category.stateSection}" in category "${category.name}".`,
      );
    }

    seenNames.add(category.name);
    seenSections.add(category.stateSection);
    validated.push(category);
  }

  return Object.freeze(validated);
}

/**
 * The ordered registry of the four agreed Jev categories.
 *
 * Adding a category means registering its module here; generic helpers iterate
 * this array rather than switching on category names.
 */
export const CATEGORY_REGISTRY = createCategoryRegistry([
  developerIntentCategory,
  decisionOwnershipCategory,
  decisionWeightCategory,
  developerReflectionCategory,
]);

/** Ordered snake_case category names in `CATEGORY_REGISTRY`. */
export const CATEGORY_NAMES = Object.freeze(
  CATEGORY_REGISTRY.map((category) => category.name),
);

export { readProbability };

/**
 * Extract ONLY a category's own section from the structured state, returning a
 * fresh copy so no other category's fields, `area_label`, or `summary` can leak
 * into the category's Jev request. Never throws.
 *
 * @param {unknown} category - A category descriptor with `stateSection`.
 * @param {unknown} state - Complete structured state object.
 * @returns {object|null} Isolated section copy, or null when absent/invalid.
 */
export function sectionFor(category, state) {
  if (
    !isPlainObject(category) ||
    !isNonEmptyString(category.stateSection) ||
    !isPlainObject(state) ||
    !Object.prototype.hasOwnProperty.call(state, category.stateSection)
  ) {
    return null;
  }

  const section = state[category.stateSection];
  if (!isPlainObject(section)) {
    return null;
  }

  return structuredClone(section);
}

/**
 * Extract the isolated state section for every category in a registry.
 * Never throws.
 *
 * @param {unknown} state - Complete structured state object.
 * @param {readonly object[]} [registry] - Category registry; defaults to
 *   `CATEGORY_REGISTRY`.
 * @returns {object} Map of `{ [category.name]: section | null }`.
 */
export function sectionsByCategory(state, registry = CATEGORY_REGISTRY) {
  if (!Array.isArray(registry)) {
    return {};
  }

  return Object.fromEntries(
    registry.map((category) => [category.name, sectionFor(category, state)]),
  );
}

/**
 * Build the SDK question sets for every category in a registry, passing each
 * category only its own isolated state section.
 *
 * @param {{noul: Function, choice?: Function}} sdk - Injectable TypeSafe SDK
 *   builders.
 * @param {unknown} [state] - Structured state object.
 * @param {readonly object[]} [registry] - Category registry; defaults to
 *   `CATEGORY_REGISTRY`.
 * @returns {object} Map of `{ [category.name]: questions }`.
 */
export function questionsByCategory(sdk, state, registry = CATEGORY_REGISTRY) {
  return Object.fromEntries(
    registry.map((category) => [
      category.name,
      category.buildQuestions(sdk, sectionFor(category, state)),
    ]),
  );
}

/**
 * Map raw per-category Jev answers onto `[0, 1]` probabilities for every
 * category in a registry. Never throws.
 *
 * @param {unknown} answersByCategory - `{ [category.name]: answers }`.
 * @param {readonly object[]} [registry] - Category registry; defaults to
 *   `CATEGORY_REGISTRY`.
 * @returns {object} Map of `{ [category.name]: number | null }`.
 */
export function probabilitiesByCategory(
  answersByCategory,
  registry = CATEGORY_REGISTRY,
) {
  if (!Array.isArray(registry)) {
    return {};
  }

  const source = isPlainObject(answersByCategory) ? answersByCategory : {};

  return Object.fromEntries(
    registry.map((category) => [
      category.name,
      category.toProbability(source[category.name]),
    ]),
  );
}
