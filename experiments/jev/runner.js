// The Jev runner — the experiment's stand-in for `runClaude`, selected by
// `classify` when `classifier_model` starts with `jev`.
//
// The TypeSafe SDK is async and the Stop chain is not, so the call runs in a
// child process (`run.js`), the same way `headless.js` isolates `claude -p`.
// This module spawns that child, judges its answer and writes the summary
// log line, because only here is it known whether the fallback ran or the
// child was killed; the state, the questions and the full-input file live in
// the child.
//
// Any infrastructure failure, and any Jev category failure, falls back to
// today's Haiku classifier on the same prompt and context, bounded by
// `FALLBACK_TIMEOUT_MS`. The Jev result is discarded. A negative verdict from
// a complete set of Jev categories is a result, not a failure, and never
// falls back. If Haiku also fails, the result is that classifier error.
// The result keeps the `runClaude` guarantee `classify` relies on: `value`
// travels only with `status: "ok"`.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { runClaude } from "../../src/io/headless.js";
import { isNonEmptyString, isPlainObject } from "../../src/core/predicates.js";
import { FALLBACK_MODEL } from "./constants.js";
import {
  appendSummaryLine,
  buildSummaryLine,
  isCategoryFailed,
} from "./log.js";
import { FALLBACK_TIMEOUT_MS, JEV_TIMEOUT_MS } from "./timing.js";

/** The child that talks to TypeSafe. */
const RUN_SCRIPT = fileURLToPath(new URL("./run.js", import.meta.url));

/**
 * Parse the child's stdout, or null when it is not one JSON object.
 *
 * @param {unknown} stdout - Raw child stdout.
 * @returns {object|null} The parsed object, or null.
 */
function parseChild(stdout) {
  try {
    const parsed = JSON.parse(stdout);

    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Classify through Jev, falling back to the headless Haiku call on any
 * failure, and append exactly one summary line per call. Never throws.
 *
 * @param {string} prompt - The classification prompt; the fallback uses it.
 * @param {object} [options] - Call options.
 * @param {string} [options.model] - The `jev…` model id, passed to the child.
 * @param {object} [options.group] - The turn group.
 * @param {object} [options.context] - `{ stopInput, projectDir }`.
 * @param {string} [options.homeDir] - Home directory override for logs/state.
 * @param {Function} [options.spawn] - Spawn seam with the `spawnSync`
 *   signature; defaults to the real one.
 * @param {Function} [options.fallback] - Seam with the `runClaude` signature;
 *   defaults to the real one.
 * @returns {object} A `runClaude`-shaped result.
 */
export function runJev(prompt, options) {
  const settings = isPlainObject(options) ? options : {};
  const { model, group, context } = settings;
  const runnerStartedAt = Date.now();
  let startedAt = new Date(runnerStartedAt);
  if (settings.startedAt instanceof Date) {
    startedAt = settings.startedAt;
  } else if (isNonEmptyString(context?.turn_ts)) {
    startedAt = new Date(context.turn_ts);
  }

  const fallback =
    typeof settings.fallback === "function" ? settings.fallback : runClaude;

  let childProcess = null;

  try {
    const spawn =
      typeof settings.spawn === "function" ? settings.spawn : spawnSync;

    childProcess = spawn(process.execPath, [RUN_SCRIPT], {
      input: JSON.stringify({ prompt, model, group, context }),
      encoding: "utf8",
      timeout: JEV_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    // A runner that broke is a failure like any other: fall back.
  }

  const child =
    childProcess && !childProcess.error
      ? parseChild(childProcess.stdout)
      : null;
  const categoryFailed = isCategoryFailed({
    status: child?.log?.status,
    category_errors: child?.log?.category_errors,
    reason: child?.value?.reason,
    verdict: child?.value,
  });
  const accepted =
    childProcess?.status === 0 &&
    child?.status === "ok" &&
    isPlainObject(child.value) &&
    !categoryFailed;

  let status = child?.log?.status ?? child?.status ?? null;
  if (status === null) {
    status =
      childProcess?.error?.code === "ETIMEDOUT" ? "timeout" : "child_failed";
  }

  let provider = "headless_fallback";

  if (accepted) {
    provider = status === "stoic_skill" ? "skipped" : "jev";
  }

  // The fallback must not inherit the `jev…` model id: the CLI would reject it.
  let fallbackResult = null;
  let fallbackMs = null;

  if (!accepted) {
    const fallbackStartedAt = Date.now();
    fallbackResult = fallback(prompt, {
      model: FALLBACK_MODEL,
      timeoutMs: FALLBACK_TIMEOUT_MS,
      group: settings.group,
      context: settings.context,
    });
    fallbackMs = Date.now() - fallbackStartedAt;
  }

  let result;
  if (accepted) {
    result = { status: "ok", provider, value: child.value };
  } else if (isPlainObject(fallbackResult)) {
    result = { ...fallbackResult, provider };
  } else {
    result = { status: "unavailable", reason: "invalid_request", provider };
  }

  const runnerTotalMs = Date.now() - runnerStartedAt;
  const homeDir = settings.homeDir ?? context?.homeDir;
  const summaryLine = buildSummaryLine({
    startedAt,
    context,
    model,
    provider,
    status,
    child,
    result,
    fallbackMs,
    runnerTotalMs,
    homeDir,
  });

  appendSummaryLine(context?.projectDir, summaryLine, { homeDir });

  return result;
}
