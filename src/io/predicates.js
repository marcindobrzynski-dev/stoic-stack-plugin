// Shared validation predicates for the Infrastructure layer.
//
// Home for the checks that more than one io module needs when coercing an
// untrusted document — a parsed JSON file, an LLM verdict — into something a
// runtime consumer may safely see. A predicate earns a place here once it has
// a second caller; single-caller checks stay private to their module.

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
