// Process timing for the Jev experiment, in one place.
//
// The runner kills the child at `JEV_TIMEOUT_MS`; the SDK inside the child
// gives up at `SDK_TIMEOUT_MS`. The SDK must give up first: only the child can
// say what went wrong and write the full input file, while a killed child
// leaves nothing but `timeout`. `MARGIN_MS` is the gap between the two — it
// covers the child's start-up, the transcript read, the SDK import and the
// file write.
//
// Kept free of imports so both processes can load it without cost.
//
// Experiment only (`feature/jev-classifier-experiment`, never merged).

/** Wall-clock budget for the Jev child, SDK call included. */
export const JEV_TIMEOUT_MS = 15_000;

/** The child's own work around the SDK call. */
export const MARGIN_MS = 3_000;

/** One SDK attempt, no retries, ending before the runner kills the child. */
export const SDK_TIMEOUT_MS = JEV_TIMEOUT_MS - MARGIN_MS;
