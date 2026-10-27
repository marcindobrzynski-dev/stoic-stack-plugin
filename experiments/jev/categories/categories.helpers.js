import { isPlainObject } from "../../../src/core/predicates.js";

/**
 * Build TypeSafe SDK noul questions from a declarative question map.
 *
 * @param {{noul: Function}} sdk - Injectable TypeSafe SDK question builders.
 * @param {object} questions - Noul specs keyed by question name. Each spec's
 *   `instructions` and `criteria` are passed to `sdk.noul`. A value that is
 *   not a plain object is rejected.
 * @returns {object} SDK questions keyed by question name.
 * @throws {TypeError} When `sdk.noul` is not a function, or when `questions`
 *   is not a plain object.
 */
export function buildNoulQuestions(sdk, questions) {
  if (!isPlainObject(sdk) || typeof sdk.noul !== "function") {
    throw new TypeError("Expected an SDK with a noul question builder.");
  }
  if (!isPlainObject(questions)) {
    throw new TypeError("Expected a plain object of noul question specs.");
  }

  return Object.fromEntries(
    Object.entries(questions).map(([key, spec]) => [
      key,
      sdk.noul(spec.instructions, spec.criteria),
    ]),
  );
}
