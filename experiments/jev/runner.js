// The Jev runner — the experiment's stand-in for `runClaude`, selected by
// `classify` when `classifier_model` starts with `jev`.
//
// The TypeSafe SDK is async and the Stop chain is not, so the call runs in a
// child process (`run.js`), the same way `headless.js` isolates `claude -p`.
// This module only spawns that child and judges its answer; the state, the
// questions and the logs live in the child.
//
// Any failure falls back to today's Haiku classifier, so the experiment can
// cost the developer a worse verdict, never a missing one. A negative Jev
// verdict is a result, not a failure, and never falls back. The result keeps
// the `runClaude` guarantee `classify` relies on: `value` travels only with
// `status: "ok"`.
//
// Experiment only (`feature/jev-classifier-experiment`, never merged).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DEFAULT_CLASSIFIER_MODEL } from "../../src/io/config/config.js";
import { runClaude } from "../../src/io/headless.js";
import { isPlainObject } from "../../src/core/predicates.js";

/** Wall-clock budget for the Jev child, SDK call included. */
export const JEV_TIMEOUT_MS = 15_000;

/** The child that talks to TypeSafe. */
const RUN_SCRIPT = fileURLToPath(new URL("./run.js", import.meta.url));

/**
 * Turn the child's stdout into a classifier-shaped result, or null when it is
 * anything other than an `ok` result carrying an object value.
 *
 * @param {unknown} stdout - Raw child stdout.
 * @returns {{status: "ok", value: object}|null} The result, or null.
 */
function readResult(stdout) {
  try {
    const parsed = JSON.parse(stdout);

    if (
      !isPlainObject(parsed) ||
      parsed.status !== "ok" ||
      !isPlainObject(parsed.value)
    ) {
      return null;
    }

    return { status: "ok", value: parsed.value };
  } catch {
    return null;
  }
}

/**
 * Classify through Jev, falling back to the headless Haiku call on any
 * failure. Never throws.
 *
 * @param {string} prompt - The classification prompt; the fallback uses it.
 * @param {object} [options] - Call options.
 * @param {string} [options.model] - The `jev…` model id, passed to the child.
 * @param {object} [options.group] - The turn group.
 * @param {object} [options.context] - `{ stopInput, projectDir }`.
 * @param {Function} [options.spawn] - Spawn seam with the `spawnSync`
 *   signature; defaults to the real one.
 * @param {Function} [options.fallback] - Seam with the `runClaude` signature;
 *   defaults to the real one.
 * @returns {object} A `runClaude`-shaped result.
 */
export function runJev(prompt, options) {
  const settings = isPlainObject(options) ? options : {};

  const fallback =
    typeof settings.fallback === "function" ? settings.fallback : runClaude;

  try {
    const spawn =
      typeof settings.spawn === "function" ? settings.spawn : spawnSync;

    const { model, group, context } = settings;

    const child = spawn(process.execPath, [RUN_SCRIPT], {
      input: JSON.stringify({ prompt, model, group, context }),
      encoding: "utf8",
      timeout: JEV_TIMEOUT_MS,
      windowsHide: true,
    });

    const result =
      child && !child.error && child.status === 0
        ? readResult(child.stdout)
        : null;

    if (result) {
      return result;
    }
  } catch {
    // A runner that broke is a failure like any other: fall back.
  }

  // The fallback must not inherit the `jev…` model id: the CLI would reject it.
  return fallback(prompt, { model: DEFAULT_CLASSIFIER_MODEL });
}
