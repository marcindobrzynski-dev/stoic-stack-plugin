// Reading mutes out of personal state, the way the frozen contract spells them.
//
// Named for the artifact rather than a seam, like ./sandbox.js and
// ./temp-dir.js: `state.json` is written by BOTH the Stop hook and
// `src/cli/record.js`, so no seam-named helper owns it.
//
// These readers are deliberately STRICTER than production. `src/core/gates.js`
// checks `mute.files == null`, so `undefined` and `null` behave identically at
// the gate — that leniency is the fail-safe principle, and it is correct there.
// It is wrong here: payloads.md freezes `null` as the spelling `record.js` must
// write, and a test that shrugs at `undefined` stops testing.
//
// The failure this guards is specific. `categoryMute` is read by NEGATIVE
// assertions ("this category is not muted yet"), and a finder that can never
// match satisfies those forever. So every entry is shape-checked before any
// search runs: an off-contract mute fails the test that reads it, rather than
// quietly widening every negative assertion in the suite.
//
// Contract: thoughts/shared/.project/architecture/payloads.md §`state.json`.
import assert from "node:assert/strict";

/** Every key a mute carries, and the only keys it may carry. */
export const MUTE_KEYS = Object.freeze(["category", "expires_at", "files"]);

/**
 * The `mutes` array, with every entry held to the frozen shape. Throws on
 * anything off-contract — including the `files: undefined` spelling production
 * tolerates.
 *
 * @param {unknown} state - A personal state document, as read from disk.
 * @returns {object[]} The `mutes` array, unmodified.
 */
export function readMutes(state) {
  assert.ok(Array.isArray(state?.mutes), "state.mutes must be an array");
  for (const mute of state.mutes) {
    assert.deepEqual(
      Object.keys(mute).sort(),
      [...MUTE_KEYS],
      `mute carries off-contract keys: ${JSON.stringify(mute)}`,
    );
    assert.equal(typeof mute.category, "string");
    assert.ok(mute.category.length > 0, "a mute needs a category");
    assert.ok(Number.isFinite(mute.expires_at), "expires_at must be a number");
    // The load-bearing line: `null` is the category-wide spelling, an array is
    // a fingerprint, and there is deliberately no third option.
    assert.ok(
      mute.files === null || Array.isArray(mute.files),
      `files must be null or an array, got ${JSON.stringify(mute.files)}`,
    );
  }
  return state.mutes;
}

/** The mute carrying a file fingerprint; there is at most one per invocation. */
export const fingerprintMute = (state) =>
  readMutes(state).find((mute) => Array.isArray(mute.files));

/** The category-wide mute, which the contract spells with `files: null`. */
export const categoryMute = (state) =>
  readMutes(state).find((mute) => mute.files === null);

/**
 * An expiry stamped during a run: the writer reads its own clock, so the only
 * honest assertion is that it landed inside the window the run spanned.
 */
export function assertExpiresWithin(
  expiresAt,
  { startedAt, finishedAt, windowMs },
) {
  assert.ok(
    expiresAt >= startedAt + windowMs && expiresAt <= finishedAt + windowMs,
    `expected an expiry ${windowMs}ms after the run, got ${expiresAt}`,
  );
}
