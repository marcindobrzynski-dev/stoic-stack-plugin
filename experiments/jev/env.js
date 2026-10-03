// Reads the TypeSafe API key from the project's `.stoic/.env`.
//
// The key is the experiment's only secret: it is returned to the caller and
// goes nowhere else — not to stdout, not to errors, not to logs. A missing
// file, a missing key and an empty value all read as "no key", so `run.js`
// exits non-zero and `runner.js` falls back to Haiku.
//
// Experiment only (`feature/jev-classifier-experiment`, never merged).
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

/** The variable that holds the TypeSafe API key. */
export const API_KEY_NAME = "TYPESAFE_API_KEY";

/**
 * Read the TypeSafe API key from `<projectDir>/.stoic/.env`. Never throws.
 *
 * @param {unknown} projectDir - The project root.
 * @returns {string|null} The key, or null when there is none to use.
 */
export function readApiKey(projectDir) {
  if (typeof projectDir !== "string" || projectDir === "") {
    return null;
  }

  try {
    const text = readFileSync(path.join(projectDir, ".stoic", ".env"), "utf8");
    const key = parseEnv(text)[API_KEY_NAME];

    return typeof key === "string" && key !== "" ? key : null;
  } catch {
    // An unreadable file is the same as no key; the error may quote the path,
    // never the key, but it is not worth surfacing either way.
    return null;
  }
}
