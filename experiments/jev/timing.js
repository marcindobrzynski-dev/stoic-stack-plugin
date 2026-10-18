// Process timing for the Jev experiment, in one place.
//
// The runner kills the child (`run.js`) at `JEV_TIMEOUT_MS`. Inside the child,
// two bounded stages run sequentially:
//   1. Headless Sonnet builds the v3 structured state (`STATE_TIMEOUT_MS` =
//      30 000 ms in `constants.js`).
//   2. Four per-category TypeSafe Jev requests run in parallel under
//      `Promise.allSettled`, each bounded at `SDK_TIMEOUT_MS` (5 000 ms,
//      matching `CATEGORY_TIMEOUT_MS` in `constants.js`).
//   3. `MARGIN_MS` (3 000 ms) covers child start-up, transcript and summary
//      I/O, SDK import, and writing the diagnostic input file.
//
// Timing arithmetic:
//   - Child internal ceiling: 30 000 ms + 5 000 ms = 35 000 ms
//   - Child kill (`JEV_TIMEOUT_MS`): 35 000 ms + 3 000 ms = 38 000 ms
//     (both Sonnet and the parallel SDK calls give up before the runner kills
//     the child, so the child can report the failure status itself)
//   - Headless fallback (`FALLBACK_TIMEOUT_MS` in `constants.js`): 30 000 ms
//   - Worst-case child + fallback: 38 000 ms + 30 000 ms = 68 000 ms
//   - Stop hook budget (`hooks/hooks.json`): 90 000 ms (22 000 ms headroom;
//     using the 45 000 ms default `HEADLESS_TIMEOUT_MS` would reach 83 000 ms
//     and leave only 7 000 ms headroom)
//
// Kept free of imports so both processes can load it without cost.
//
// Experiment only (`feature/jev-classifier-experiment`, never merged).

/** One per-category SDK attempt, no retries, matching `CATEGORY_TIMEOUT_MS`. */
export const SDK_TIMEOUT_MS = 5_000;

/** The child's own work around the Sonnet state call and parallel SDK calls. */
export const MARGIN_MS = 3_000;

/**
 * Wall-clock budget for the Jev child: 30 s Sonnet state + 5 s parallel
 * category Jev calls + 3 s child margin = 38 s.
 */
export const JEV_TIMEOUT_MS = 30_000 + SDK_TIMEOUT_MS + MARGIN_MS;
