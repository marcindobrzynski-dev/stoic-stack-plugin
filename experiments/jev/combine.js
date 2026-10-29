// Combines per-category Jev probabilities into `pause_probability` and picks
// the category that drove a pause or limited a negative verdict.
//
// Pure leaf module so `run.js` and `log.js` share one probability combination
// without importing each other. No I/O, no clock, no environment reads, never
// throws.
import {
  clampFinite,
  isFraction,
  isPlainObject,
} from "../../src/core/predicates.js";
import {
  DECISION_OWNERSHIP_NAME,
  DECISION_WEIGHT_NAME,
  DEVELOPER_INTENT_NAME,
  DEVELOPER_REFLECTION_NAME,
  INTENT_MAX_REDUCTION,
  REFLECTION_MAX_REDUCTION,
} from "./jev.constants.js";

/** Decimal rounding scale to eliminate binary IEEE-754 representation drift. */
const FLOAT_ROUND_SCALE = 1e12;

/**
 * Read one `noul` probability in [0, 1], accepting `{ noul }` or a number.
 *
 * @param {object} answers - Answer map from Jev.
 * @param {string} key - Question key.
 * @returns {number|null} Probability in [0, 1], or null when invalid.
 */
export function readProbability(answers, key) {
  if (!isPlainObject(answers)) {
    return null;
  }
  const entry = answers[key];
  const raw = isPlainObject(entry) ? entry.noul : entry;
  return isFraction(raw) ? raw : null;
}

/**
 * Round a floating-point number to 12 decimal places so an exact ratio of the
 * configured confidence floor to itself never suffers binary IEEE-754 drift
 * below that floor.
 *
 * @param {number} value - Raw floating-point number.
 * @returns {number} Rounded number.
 */
export function roundProbability(value) {
  return Math.round(value * FLOAT_ROUND_SCALE) / FLOAT_ROUND_SCALE;
}

/**
 * Read one category probability in [0, 1] from a probabilities map, defaulting
 * missing or non-numeric entries to 0.
 *
 * @param {unknown} probabilities - Map of `{ [category.name]: number }`.
 * @param {string} categoryName - Registry category identifier.
 * @returns {number} Clamped probability in [0, 1].
 */
function readCategoryProbability(probabilities, categoryName) {
  if (!isPlainObject(probabilities)) {
    return 0;
  }
  return clampFinite(probabilities[categoryName], 0, 1);
}

/**
 * Combine per-category probabilities into `pause_probability`.
 *
 * Formula:
 *   `pause_probability = decision_weight * decision_ownership
 *     * (1 - REFLECTION_MAX_REDUCTION * developer_reflection)
 *     * (1 - INTENT_MAX_REDUCTION * developer_intent)`
 *
 * `developer_reflection` and `developer_intent` are separate reduction
 * multipliers. Either one can only lower the probability. Intent never
 * raises it, including when intent is higher than reflection.
 *
 * @param {unknown} probabilities - Map of `{ [category.name]: number }`.
 * @returns {{
 *   pauseProbability: number,
 *   decisionWeight: number,
 *   decisionOwnership: number,
 *   developerReflection: number,
 *   developerIntent: number,
 *   developerReflectionReductionMultiplier: number,
 *   developerIntentReductionMultiplier: number,
 * }} Combined probabilities and the two reduction multipliers.
 */
export function combineProbabilities(probabilities) {
  const decisionWeight = readCategoryProbability(
    probabilities,
    DECISION_WEIGHT_NAME,
  );
  const decisionOwnership = readCategoryProbability(
    probabilities,
    DECISION_OWNERSHIP_NAME,
  );
  const developerReflection = readCategoryProbability(
    probabilities,
    DEVELOPER_REFLECTION_NAME,
  );
  const developerIntent = readCategoryProbability(
    probabilities,
    DEVELOPER_INTENT_NAME,
  );
  const developerReflectionReductionMultiplier = clampFinite(
    1 - REFLECTION_MAX_REDUCTION * developerReflection,
    0,
    1,
  );
  const developerIntentReductionMultiplier = clampFinite(
    1 - INTENT_MAX_REDUCTION * developerIntent,
    0,
    1,
  );
  const rawPauseProbability =
    decisionWeight *
    decisionOwnership *
    developerReflectionReductionMultiplier *
    developerIntentReductionMultiplier;
  const pauseProbability = clampFinite(
    roundProbability(rawPauseProbability),
    0,
    1,
  );

  return {
    pauseProbability,
    decisionWeight,
    decisionOwnership,
    developerReflection,
    developerIntent,
    developerReflectionReductionMultiplier,
    developerIntentReductionMultiplier,
  };
}

/**
 * Select the category name that drove the combined verdict.
 *
 * Rule:
 * - When `pauseProbability >= presetPauseThreshold` (pause), pick the
 *   dominant positive factor (`decision_weight` vs `decision_ownership`,
 *   ties to `decision_weight`).
 * - When `pauseProbability < presetPauseThreshold` (negative verdict), pick
 *   the limiting factor with the smallest multiplicative contribution among
 *   `decision_weight`, `decision_ownership`,
 *   `developer_reflection_reduction_multiplier`, and
 *   `developer_intent_reduction_multiplier`.
 *
 * @param {ReturnType<typeof combineProbabilities>} combination - Combined
 *   category factors.
 * @param {number} presetPauseThreshold - Active preset's pause threshold.
 * @returns {string} Driving category name.
 */
export function selectDrivingCategory(combination, presetPauseThreshold) {
  const {
    pauseProbability,
    decisionWeight,
    decisionOwnership,
    developerReflectionReductionMultiplier,
    developerIntentReductionMultiplier,
  } = combination;

  if (pauseProbability >= presetPauseThreshold) {
    return decisionWeight >= decisionOwnership
      ? DECISION_WEIGHT_NAME
      : DECISION_OWNERSHIP_NAME;
  }

  let limitingCategory = DECISION_WEIGHT_NAME;
  let smallestFactor = decisionWeight;

  if (decisionOwnership < smallestFactor) {
    limitingCategory = DECISION_OWNERSHIP_NAME;
    smallestFactor = decisionOwnership;
  }
  if (developerReflectionReductionMultiplier < smallestFactor) {
    limitingCategory = DEVELOPER_REFLECTION_NAME;
    smallestFactor = developerReflectionReductionMultiplier;
  }
  if (developerIntentReductionMultiplier < smallestFactor) {
    limitingCategory = DEVELOPER_INTENT_NAME;
  }

  return limitingCategory;
}
