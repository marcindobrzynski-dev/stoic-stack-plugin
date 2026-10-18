// Temporary configuration constants for the structured-state Jev experiment.
//
// Holds the model identifiers, wall-clock budgets, state-window bounds, preset
// pause-probability thresholds, and veto cooldown ratio in one pure module so
// the child classifier, the runner, and the Stop decision share one source of
// truth without adding experimental fields to `PRESETS` or `.stoic/config.json`.
//
// Pure constants and re-exported predicate: no I/O, no clock, no environment
// reads, never throws.
//
// Contract: thoughts/shared/.project/architecture/configuration.md §Presets,
// §Score relief.
//
// Experiment only (`feature/jev-classifier-experiment`, never merged).
import {
  DEFAULT_CLASSIFIER_MODEL,
  PRESET_NAMES,
  isCooldownRatio,
} from "../../src/io/config/config.js";

/**
 * Subcategory and category accepted on the Jev path when Sonnet's
 * `area_label` does not resolve to an enabled area. One spelling, shared by
 * the verdict adapter and the classifier.
 */
export const JEV_GENERAL_CATEGORY = "general";

/** Headless Claude model that builds the structured turn state. */
export const STATE_MODEL = "claude-sonnet-5-5";

/** Headless Claude model used when the Jev pipeline fails on infrastructure. */
export const FALLBACK_MODEL = DEFAULT_CLASSIFIER_MODEL;

/** Wall-clock budget in milliseconds for the structured-state Sonnet call. */
export const STATE_TIMEOUT_MS = 30_000;

/** Wall-clock budget in milliseconds for one per-category Jev request. */
export const CATEGORY_TIMEOUT_MS = 5_000;

/** Wall-clock budget in milliseconds for the headless Haiku fallback call. */
export const FALLBACK_TIMEOUT_MS = 30_000;

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

/** Fraction of the score threshold a vetoed candidate is capped down to. */
export const VETO_COOLDOWN_RATIO = 0.8;

/** Maximum character length of the rolling session summary passed to Sonnet. */
export const SUMMARY_MAX_CHARS = 1500;

/** Number of completed turns before the current turn included in the window. */
export const PREVIOUS_TURNS = 2;

/** Total turns in the structured-state window: current turn plus previous turns. */
export const WINDOW_TURNS = 1 + PREVIOUS_TURNS;

/** Schema version for the structured state and v3 experiment log records. */
export const STATE_SCHEMA_VERSION = 3;

export { isCooldownRatio };
