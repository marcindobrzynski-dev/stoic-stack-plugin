// Cross-platform, fail-safe runner for a headless Claude CLI call — the one
// place in the plugin that knows how to spawn `claude -p` and the only place
// that carries the platform's spawn quirks.
//
// Contract: thoughts/shared/.project/architecture/payloads.md (the classifier
// verdict this runner carries) and the approved architecture's component map,
// which places the runner in the Infrastructure layer.
//
// Three disciplines hold this module together:
//
//   Safety — the prompt is written to the child's stdin, never onto a command
//   line, so no prompt text is ever shell-quoted. Only fixed flags are passed
//   as arguments.
//
//   Boundedness — execution is capped by a timeout and an output buffer, both
//   module constants. A hung or runaway CLI can neither stall a turn nor
//   exhaust the session's memory.
//
//   Fail-safety — every failure mode (launch error, non-zero exit, timeout,
//   oversized output, unparseable output) collapses into one clean
//   "unavailable" result. The module never throws into a caller, so a
//   fail-silent hook needs no try/catch of its own.
//
// Testability is programmatic: `options.spawn` substitutes the spawn
// implementation. Its production default is the real cascade, and no
// environment variable can reach it — a test seam must never be able to alter
// a real user's session.
import { spawnSync } from "node:child_process";
import { isPlainObject } from "../core/predicates.js";

/** Wall-clock budget for one headless call, in milliseconds. */
export const HEADLESS_TIMEOUT_MS = 45_000;

/** Maximum bytes of child output retained before the call is abandoned. */
export const HEADLESS_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * The only shape a model id may take on the command line. The last Windows
 * spawn strategy runs through a shell, where any other character in a
 * config-supplied model id could become a command, so anything else is
 * rejected before a spawn is attempted.
 */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;

/**
 * @typedef {"invalid_request"|"spawn_failed"|"cli_failed"|"timeout"
 *   |"output_too_large"|"unparseable"} HeadlessUnavailableReason
 */

/**
 * @typedef {{ status: "ok", value: object }
 *   | { status: "unavailable", reason: HeadlessUnavailableReason }}
 *   HeadlessResult
 */

/**
 * Build the immutable argument vector for a headless call. The prompt is
 * deliberately absent: it travels on stdin.
 *
 * @param {string} model - Model id to run the call against.
 * @returns {string[]} Fixed flags only.
 */
export function buildHeadlessArgs(model) {
  return [
    "-p",
    "--model",
    String(model),
    "--output-format",
    "json",
    "--max-turns",
    "1",
    "--disallowedTools",
    "*",
  ];
}

/**
 * The spawn strategies to try, in order, for a platform. On Windows the
 * `claude` binary is a `.cmd` shim, so a plain spawn of the bare name can fail
 * to launch even when the CLI is installed; the `.cmd` name is tried next and
 * a shell spawn last, letting the OS resolve PATH and extensions itself.
 * Elsewhere a single plain spawn is enough.
 *
 * @param {string} platform - A `process.platform` value.
 * @returns {{command: string, shell: boolean}[]} Ordered strategies.
 */
export function spawnAttempts(platform) {
  if (platform === "win32") {
    return [
      { command: "claude", shell: false },
      { command: "claude.cmd", shell: false },
      { command: "claude", shell: true },
    ];
  }
  return [{ command: "claude", shell: false }];
}

/**
 * Extract the first balanced JSON object from text, tolerating prose or
 * markdown fences around it. The scan is string- and escape-aware, so braces
 * inside quoted values cannot unbalance it.
 *
 * @param {unknown} text - Text that may contain a JSON object.
 * @returns {object|null} The parsed object, or null when none is found.
 */
export function extractFirstJsonObject(text) {
  if (typeof text !== "string") {
    return null;
  }
  // Prose can contain braced regions that are not JSON, so a balanced region
  // that fails to parse does not end the search — the scan resumes at the
  // next opening brace.
  for (
    let start = text.indexOf("{");
    start !== -1;
    start = text.indexOf("{", start + 1)
  ) {
    const end = balancedRegionEnd(text, start);
    if (end !== -1) {
      const value = parseObject(text.slice(start, end + 1));
      if (value) {
        return value;
      }
    }
  }
  return null;
}

/**
 * Find the closing brace balancing the opening brace at `start`. The scan is
 * string- and escape-aware, so braces inside quoted values cannot unbalance
 * it.
 *
 * @param {string} text - Text being scanned.
 * @param {number} start - Index of an opening brace.
 * @returns {number} Index of the balancing brace, or -1 when unbalanced.
 */
function balancedRegionEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

/**
 * Parse text that should be a JSON object, without throwing.
 *
 * @param {string} text - Candidate JSON text.
 * @returns {object|null} The object, or null when it is not one.
 */
function parseObject(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return isPlainObject(value) ? value : null;
}

/**
 * Classify a `spawnSync` error into the outcome it represents. A launch
 * failure means this strategy could not start the CLI at all, so the cascade
 * should advance; a timeout or buffer overflow means the CLI did run, so the
 * call is over.
 *
 * @param {Error & {code?: string}} error - Error reported by the spawn.
 * @returns {HeadlessUnavailableReason|null} A terminal reason, or null when
 *   the cascade should advance.
 */
function terminalSpawnError(error) {
  const code = error?.code;
  const message = String(error?.message ?? "");
  if (code === "ETIMEDOUT") {
    return "timeout";
  }
  if (code === "ENOBUFS" || /maxBuffer/i.test(message)) {
    return "output_too_large";
  }
  return null;
}

/**
 * Turn raw CLI stdout into the model's JSON object: unwrap the CLI's output
 * envelope, then extract the first balanced object from its result text.
 *
 * @param {unknown} stdout - Raw child stdout.
 * @returns {HeadlessResult} The object, or an unavailable result.
 */
function unwrapEnvelope(stdout) {
  if (typeof stdout !== "string" || stdout.length === 0) {
    return { status: "unavailable", reason: "unparseable" };
  }
  const envelope = parseObject(stdout) ?? extractFirstJsonObject(stdout);
  if (!envelope || typeof envelope.result !== "string") {
    return { status: "unavailable", reason: "unparseable" };
  }
  const value = extractFirstJsonObject(envelope.result);
  return value
    ? { status: "ok", value }
    : { status: "unavailable", reason: "unparseable" };
}

/**
 * Run one headless Claude call and return the JSON object the model produced.
 * Never throws: every failure yields `{ status: "unavailable", reason }`.
 *
 * @param {string} prompt - Prompt text, delivered on the child's stdin.
 * @param {object} [options] - Call options.
 * @param {string} [options.model] - Model id; required.
 * @param {number} [options.timeoutMs] - Wall-clock budget.
 * @param {number} [options.maxOutputBytes] - Output buffer cap.
 * @param {Function} [options.spawn] - Spawn seam with the `spawnSync`
 *   signature; defaults to the real cascade.
 * @returns {HeadlessResult} The model's JSON object, or an unavailable result.
 */
export function runHeadlessJson(prompt, options) {
  try {
    const settings = options ?? {};
    const model = settings.model;
    if (
      typeof prompt !== "string" ||
      prompt.length === 0 ||
      typeof model !== "string" ||
      !MODEL_ID_PATTERN.test(model)
    ) {
      return { status: "unavailable", reason: "invalid_request" };
    }

    const spawn = typeof settings.spawn === "function" ? settings.spawn : null;
    const args = buildHeadlessArgs(model);
    const spawnOptions = {
      input: prompt,
      encoding: "utf8",
      timeout: settings.timeoutMs ?? HEADLESS_TIMEOUT_MS,
      maxBuffer: settings.maxOutputBytes ?? HEADLESS_MAX_OUTPUT_BYTES,
      windowsHide: true,
      // The self-instrumentation guard: the plugin's own hooks must never
      // observe the session this call opens.
      env: { ...process.env, STOIC_INTERNAL: "1" },
    };

    for (const attempt of spawnAttempts(process.platform)) {
      let result;
      try {
        result = (spawn ?? spawnSync)(attempt.command, args, {
          ...spawnOptions,
          shell: attempt.shell,
        });
      } catch {
        // The strategy could not be launched; try the next one.
        continue;
      }
      if (!result || typeof result !== "object") {
        continue;
      }
      if (result.error) {
        const reason = terminalSpawnError(result.error);
        if (reason) {
          return { status: "unavailable", reason };
        }
        continue;
      }
      if (result.status !== 0) {
        // The CLI ran and failed. That is an answer, not a resolution
        // problem, so the cascade ends here.
        return { status: "unavailable", reason: "cli_failed" };
      }
      return unwrapEnvelope(result.stdout);
    }

    return { status: "unavailable", reason: "spawn_failed" };
  } catch {
    return { status: "unavailable", reason: "spawn_failed" };
  }
}
