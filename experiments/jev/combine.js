// Combines per-category Jev probabilities into `pause_probability` and picks
// the category that drove a pause or limited a negative verdict.
//
// Pure leaf module so `run.js` and `log.js` share one probability combination
// without importing each other. No I/O, no clock, no environment reads, never
// throws.
import {
  clampFinite,
  isFiniteNumber,
  isFraction,
  isPlainObject,
} from "../../src/core/predicates.js";
import { name as decisionOwnershipName } from "./categories/decision-ownership.js";
import { name as decisionWeightName } from "./categories/decision-weight.js";
import { name as developerIntentName } from "./categories/developer-intent.js";
import { name as developerReflectionName } from "./categories/developer-reflection.js";
import { INTENT_MAX_REDUCTION, REFLECTION_MAX_REDUCTION } from "./constants.js";

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
  const candidate = probabilities[categoryName];
  return isFiniteNumber(candidate) ? clampFinite(candidate, 0, 1) : 0;
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
    decisionWeightName,
  );
  const decisionOwnership = readCategoryProbability(
    probabilities,
    decisionOwnershipName,
  );
  const developerReflection = readCategoryProbability(
    probabilities,
    developerReflectionName,
  );
  const developerIntent = readCategoryProbability(
    probabilities,
    developerIntentName,
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
      ? decisionWeightName
      : decisionOwnershipName;
  }

  let limitingCategory = decisionWeightName;
  let smallestFactor = decisionWeight;

  if (decisionOwnership < smallestFactor) {
    limitingCategory = decisionOwnershipName;
    smallestFactor = decisionOwnership;
  }
  if (developerReflectionReductionMultiplier < smallestFactor) {
    limitingCategory = developerReflectionName;
    smallestFactor = developerReflectionReductionMultiplier;
  }
  if (developerIntentReductionMultiplier < smallestFactor) {
    limitingCategory = developerIntentName;
  }

  return limitingCategory;
}
