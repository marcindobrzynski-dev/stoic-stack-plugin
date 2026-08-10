// Shared validation predicates and coercions — Domain-layer leaf, importable
// from anywhere.
//
// Home for the pure checks and coercions that more than one layer needs when
// turning an untrusted value — a parsed JSON document, a hook payload, an LLM
// verdict — into something a consumer may safely read fields from. Living in
// the Domain layer keeps the dependency arrow pointing the allowed way:
// Infrastructure may import these, Domain never imports Infrastructure. A
// helper earns a place here once it has a second caller; single-caller checks
// stay private to their module.

/**
 * Whether a value is a plain JSON object: the shape a document must have
 * before its fields can be read. Excludes `null` (`typeof null === "object"`)
 * and arrays, both of which are parseable JSON but not readable documents.
 *
 * @param {unknown} value - Any value, typically freshly parsed from disk.
 * @returns {boolean} True for `{...}`, false for arrays, null, and primitives.
 */
export const isPlainObject = (value) =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Whether a value is usable text: present, a string, and not empty. The check
 * every reader of an untrusted document needs before a value may name a file,
 * label an event, or stand in for an identifier — where `""` is indistinguishable
 * from "not provided" and must be treated as absent.
 *
 * @param {unknown} value - Any value, typically a field of a hook payload.
 * @returns {boolean} True for non-empty strings only.
 */
export const isNonEmptyString = (value) =>
  typeof value === "string" && value.length > 0;

/**
 * Whether a value is a number arithmetic may safely use. Excludes `NaN` and
 * both infinities, which are numbers by `typeof` yet poison every total they
 * reach — and, unlike a missing field, propagate silently instead of failing
 * where they were introduced. The guard every reader needs before a value may
 * be weighed, divided by, or persisted as a score.
 *
 * @param {unknown} value - Any value, typically a field of an untrusted
 *   document or a knob a user may have overridden.
 * @returns {boolean} True for finite numbers only.
 */
export const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Clamp a value into a range, coercing anything arithmetic cannot use into a
 * fallback instead. The fallback is a domain choice, not a math property —
 * most readers treat a missing signal as neutral (0), but a caller whose safe
 * degradation differs must say so explicitly.
 *
 * @param {unknown} value - Any value, typically a field of an untrusted
 *   document or an LLM verdict.
 * @param {number} min - Lower bound, inclusive.
 * @param {number} max - Upper bound, inclusive.
 * @param {number} [fallback] - Result for unusable values; defaults to 0.
 * @returns {number} The clamped value, or the fallback.
 */
export const clampFinite = (value, min, max, fallback = 0) =>
  isFiniteNumber(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** The signal range `promptEffort` promises; a hand-edited log may not. */
export const EFFORT_RANGE = Object.freeze({ min: -1, max: 1 });

/**
 * A logged or grouped effort as a usable signal: clamped to the promised
 * range, with unreadable values reading as no signal at all.
 *
 * @param {unknown} value - An effort field from an untrusted document.
 * @returns {number} A number in [{@link EFFORT_RANGE}.min, .max].
 */
export const effortOf = (value) =>
  clampFinite(value, EFFORT_RANGE.min, EFFORT_RANGE.max, 0);
