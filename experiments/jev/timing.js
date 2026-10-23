// Process timing for the Jev experiment, in one place.
//
// The child kill budget is `STATE_TIMEOUT_MS` plus `CATEGORY_TIMEOUT_MS`
// plus `MARGIN_MS`. That budget plus `FALLBACK_TIMEOUT_MS` stays under the
// Stop hook timeout in `hooks/hooks.json`. The fallback stays at 30 seconds
// rather than the 45-second `HEADLESS_TIMEOUT_MS` default, which would leave
// less headroom under that timeout.
//
// Pure constants: no I/O, no clock, no environment reads, never throws.

/** Wall-clock budget in milliseconds for the structured-state Sonnet call. */
export const STATE_TIMEOUT_MS = 30_000;

/** Wall-clock budget in milliseconds for one per-category Jev request. */
export const CATEGORY_TIMEOUT_MS = 5_000;

/** Wall-clock budget in milliseconds for the headless Haiku fallback call. */
export const FALLBACK_TIMEOUT_MS = 30_000;

/** One per-category SDK attempt, the same budget as `CATEGORY_TIMEOUT_MS`. */
export const SDK_TIMEOUT_MS = CATEGORY_TIMEOUT_MS;

/** The child's own work around the Sonnet state call and parallel SDK calls. */
export const MARGIN_MS = 3_000;

/** Wall-clock budget for the Jev child before the runner kills it. */
export const JEV_TIMEOUT_MS =
  STATE_TIMEOUT_MS + CATEGORY_TIMEOUT_MS + MARGIN_MS;
