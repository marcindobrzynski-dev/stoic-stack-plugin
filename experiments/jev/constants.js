// Temporary configuration constants for the structured-state Jev experiment.
//
// Holds the model identifiers, state-window bounds, preset pause-probability
// thresholds, and schema versions in one pure module so the child classifier
// and the runner share one source of truth without adding experimental fields
// to `PRESETS` or `.stoic/config.json`. Wall-clock budgets live in `timing.js`.
// The veto cooldown ratio lives in `src/io/config/config.js`.
//
// Pure constants: no I/O, no clock, no environment reads, never throws.
//
// Contract: thoughts/shared/.project/architecture/configuration.md §Presets,
// §Score relief.
import {
  DEFAULT_CLASSIFIER_MODEL,
  PRESET_NAMES,
} from "../../src/io/config/config.js";

/**
 * Subcategory and category accepted on the Jev path when Sonnet's
 * `area_label` does not resolve to an enabled area. One spelling, shared by
 * the verdict adapter and the classifier.
 */
export const JEV_GENERAL_CATEGORY = "general";

/** Prefix of a classifier model id that selects the Jev path. */
export const JEV_MODEL_PREFIX = "jev";

/** Headless Claude model that builds the structured turn state. */
export const STATE_MODEL = "claude-sonnet-5-5";

/** Headless Claude model used when the Jev pipeline fails on infrastructure. */
export const FALLBACK_MODEL = DEFAULT_CLASSIFIER_MODEL;

const PRESET_PAUSE_THRESHOLDS = {
  calm: 0.5,
  balanced: 0.35,
  vigilant: 0.25,
};

/** Pause-probability thresholds keyed by the canonical plugin preset names. */
export const PAUSE_THRESHOLDS = Object.freeze(
  Object.fromEntries(
    PRESET_NAMES.filter((name) =>
      Object.prototype.hasOwnProperty.call(PRESET_PAUSE_THRESHOLDS, name),
    ).map((name) => [name, PRESET_PAUSE_THRESHOLDS[name]]),
  ),
);

/**
 * Largest share of `pause_probability` that `developer_reflection` can remove.
 * Full reflection multiplies the probability by `1 - REFLECTION_MAX_REDUCTION`.
 */
export const REFLECTION_MAX_REDUCTION = 0.6;

/**
 * Largest share of `pause_probability` that `developer_intent` can remove.
 * Intent only lowers the probability, and full intent multiplies it by
 * `1 - INTENT_MAX_REDUCTION`.
 */
export const INTENT_MAX_REDUCTION = 0.3;

/**
 * Schema version of `jev-experiment.jsonl` summary lines.
 * Version 4 logs `developer_reflection` and `developer_intent` as separate
 * reduction multipliers. Versions 1–3 remain readable.
 */
export const SUMMARY_SCHEMA_VERSION = 4;

/** First summary-line schema: flat fields, before later renames. */
export const SUMMARY_SCHEMA_VERSION_ONE = 1;

/** Second summary-line schema: the renamed flat fields. */
export const SUMMARY_SCHEMA_VERSION_TWO = 2;

/** Third summary-line schema: nested categories, before reduction multipliers. */
export const SUMMARY_SCHEMA_VERSION_THREE = 3;

/** Maximum character length of the rolling session summary passed to Sonnet. */
export const SUMMARY_MAX_CHARS = 1500;

/** Number of completed turns before the current turn included in the window. */
export const PREVIOUS_TURNS = 2;

/** Total turns in the structured-state window: current turn plus previous turns. */
export const WINDOW_TURNS = 1 + PREVIOUS_TURNS;

/** Schema version for the structured state and v3 experiment log records. */
export const STATE_SCHEMA_VERSION = 3;
