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
import { appendSummaryLine } from "./log.js";
import { JEV_TIMEOUT_MS } from "./timing.js";

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
 * Build the summary line: the child's `log`, completed with what only the
 * runner knows — the provider, the whole latency, a killed child — and the
 * verdict that reached `classify`, whichever provider gave it.
 *
 * @param {object} parts - The pieces of the line.
 * @param {Date} parts.startedAt - When the runner started.
 * @param {object} parts.context - `{ stopInput, projectDir }`.
 * @param {string} parts.provider - `jev`, `skipped` or `headless_fallback`.
 * @param {string} parts.status - The child's status, or how the child failed.
 * @param {object|null} parts.child - The parsed child result.
 * @param {object} parts.result - The result returned to `classify`.
 * @returns {object} The summary line.
 */
function buildSummaryLine({
  startedAt,
  context,
  provider,
  status,
  child,
  result,
}) {
  const { session_id: sessionId } = isPlainObject(context?.stopInput)
    ? context.stopInput
    : {};
  const childLog = isPlainObject(child?.log) ? child.log : {};
  const verdict =
    result?.status === "ok" && isPlainObject(result.value) ? result.value : {};

  return {
    ts: startedAt.toISOString(),
    session_id: typeof sessionId === "string" ? sessionId : null,
    prompt_id: childLog.prompt_id ?? null,
    provider,
    status,
    error: typeof child?.error === "string" ? child.error : null,
    latency_ms: Date.now() - startedAt.getTime(),
    model_version: childLog.model_version ?? null,
    reflex_approval: childLog.reflex_approval ?? null,
    assistant_choice: childLog.assistant_choice ?? null,
    developer_named_it: childLog.developer_named_it ?? null,
    category: childLog.category ?? null,
    category_probability: childLog.category_probability ?? null,
    decision_found:
      typeof verdict.decision_found === "boolean"
        ? verdict.decision_found
        : null,
    confidence:
      typeof verdict.confidence === "number" ? verdict.confidence : null,
    state_chars: childLog.state_chars ?? null,
    turns_included: childLog.turns_included ?? null,
    input_file: childLog.input_file ?? null,
  };
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
 * @param {Function} [options.spawn] - Spawn seam with the `spawnSync`
 *   signature; defaults to the real one.
 * @param {Function} [options.fallback] - Seam with the `runClaude` signature;
 *   defaults to the real one.
 * @returns {object} A `runClaude`-shaped result.
 */
export function runJev(prompt, options) {
  const startedAt = new Date();
  const settings = isPlainObject(options) ? options : {};
  const { model, group, context } = settings;

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
  const accepted =
    childProcess?.status === 0 &&
    child?.status === "ok" &&
    isPlainObject(child.value);
  const status =
    child?.log?.status ??
    child?.status ??
    (childProcess?.error?.code === "ETIMEDOUT" ? "timeout" : "child_failed");

  // The fallback must not inherit the `jev…` model id: the CLI would reject it.
  const result = accepted
    ? { status: "ok", value: child.value }
    : fallback(prompt, { model: DEFAULT_CLASSIFIER_MODEL });

  let provider = "headless_fallback";

  if (accepted) {
    provider = status === "stoic_skill" ? "skipped" : "jev";
  }

  appendSummaryLine(
    context?.projectDir,
    buildSummaryLine({ startedAt, context, provider, status, child, result }),
  );

  return result;
}
