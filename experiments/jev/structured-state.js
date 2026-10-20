// Builds the v3 structured session state through a headless Sonnet call with
// JSON Schema enforcement and per-session rolling summaries.
//
// Exists as its own module so turn-window selection, rolling summary
// persistence (`personalStateDir/jev-summaries/<session_id>.json`), stdin
// prompt assembly, headless invocation, and strict validation stay decoupled
// from the per-category Jev evaluation that consumes the resulting state.
//
// Fail-safe: never throws, never writes to `state.json` or the repository, and
// never puts turn text on a command line. The headless runner (`options.runner`)
// and child spawn (`options.spawn`) are substituted through parameters, never
// environment variables.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §Classifier verdict (LLM #1).
//
// Experiment only (`feature/jev-classifier-experiment`, never merged).
import os from "node:os";
import path from "node:path";

import { isNonEmptyString, isPlainObject } from "../../src/core/predicates.js";
import { runClaude } from "../../src/io/headless.js";
import { readJsonFile, writeJsonFileAtomic } from "../../src/io/json-file.js";
import { personalStateDir } from "../../src/io/paths.js";
import { CATEGORY_REGISTRY } from "./categories/index.js";
import {
  PREVIOUS_TURNS,
  STATE_MODEL,
  STATE_SCHEMA_VERSION,
  STATE_TIMEOUT_MS,
  SUMMARY_MAX_CHARS,
} from "./constants.js";
import {
  REFLECTION_SIGNAL_KEYS,
  buildStateSchema,
  validateStructuredState,
} from "./state-schema.js";
import { countLines, readTurns } from "./transcript.js";

/** Maximum characters allowed for the stdin prompt sent to Sonnet. */
export const MAX_STATE_CHARS = 28_000 * 4;

/** Subdirectory under `personalStateDir` holding per-session summaries. */
export const SUMMARIES_DIR_NAME = "jev-summaries";

/** Maximum number of turns retained in `bare_pick_history`. */
const MAX_BARE_PICK_HISTORY = 20;

/**
 * Reduce a session identifier to the plugin's filesystem-safe `[A-Za-z0-9]`
 * alphabet so an untrusted `session_id` from hook stdin can never escape the
 * `jev-summaries` directory.
 *
 * @param {unknown} value - Candidate session identifier.
 * @returns {string} Single-segment safe filename stem.
 */
function safeSegment(value) {
  return String(value).replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Resolve the per-session rolling summary path under `personalStateDir`.
 * Pure path resolution; creates no files or directories.
 *
 * @param {unknown} projectDir - Project root directory.
 * @param {unknown} sessionId - Session identifier from the Stop payload.
 * @param {string} [homeDir] - Home directory override for tests.
 * @returns {string|null} Absolute path of `<session_id>.json`, or null when
 *   `projectDir` or `sessionId` is missing.
 */
export function sessionSummaryPath(
  projectDir,
  sessionId,
  homeDir = os.homedir(),
) {
  if (!isNonEmptyString(projectDir) || !isNonEmptyString(sessionId)) {
    return null;
  }
  return path.join(
    personalStateDir(projectDir, homeDir),
    SUMMARIES_DIR_NAME,
    `${safeSegment(sessionId)}.json`,
  );
}

/**
 * Create a fresh empty session summary record for a new or unreadable session.
 *
 * @returns {{
 *   schema_version: number,
 *   summary: string,
 *   bare_pick_streak: number,
 *   bare_pick_history: boolean[],
 *   unaware_decision_count: number,
 *   last_analysed_turn: string|null,
 * }} Fresh empty summary.
 */
export function emptySessionSummary() {
  return {
    schema_version: STATE_SCHEMA_VERSION,
    summary: "",
    bare_pick_streak: 0,
    bare_pick_history: [],
    unaware_decision_count: 0,
    last_analysed_turn: null,
  };
}

/**
 * Check whether a parsed JSON value is a valid v3 session summary document.
 *
 * @param {unknown} candidate - Value read from disk or supplied by a caller.
 * @returns {boolean} True when all summary fields match the v3 contract.
 */
function isValidSessionSummary(candidate) {
  if (!isPlainObject(candidate)) {
    return false;
  }
  if (candidate.schema_version !== STATE_SCHEMA_VERSION) {
    return false;
  }
  if (
    typeof candidate.summary !== "string" ||
    candidate.summary.length > SUMMARY_MAX_CHARS
  ) {
    return false;
  }
  if (
    !Number.isInteger(candidate.bare_pick_streak) ||
    candidate.bare_pick_streak < 0
  ) {
    return false;
  }
  if (
    !Array.isArray(candidate.bare_pick_history) ||
    !candidate.bare_pick_history.every((entry) => typeof entry === "boolean")
  ) {
    return false;
  }
  if (
    !Number.isInteger(candidate.unaware_decision_count) ||
    candidate.unaware_decision_count < 0
  ) {
    return false;
  }
  return (
    candidate.last_analysed_turn === null ||
    typeof candidate.last_analysed_turn === "string"
  );
}

/**
 * Load the stored session summary for `sessionId`, degrading to an empty
 * summary when the file is missing, unreadable, corrupt, or from another
 * schema version. Never throws.
 *
 * @param {unknown} projectDir - Project root directory.
 * @param {unknown} sessionId - Session identifier from the Stop payload.
 * @param {string} [homeDir] - Home directory override for tests.
 * @returns {ReturnType<typeof emptySessionSummary>} Valid session summary.
 */
export function loadSessionSummary(
  projectDir,
  sessionId,
  homeDir = os.homedir(),
) {
  const filePath = sessionSummaryPath(projectDir, sessionId, homeDir);
  if (filePath === null) {
    return emptySessionSummary();
  }
  const readResult = readJsonFile(filePath);
  if (readResult.status !== "ok" || !isValidSessionSummary(readResult.value)) {
    return emptySessionSummary();
  }
  return {
    schema_version: STATE_SCHEMA_VERSION,
    summary: readResult.value.summary,
    bare_pick_streak: readResult.value.bare_pick_streak,
    bare_pick_history: [...readResult.value.bare_pick_history],
    unaware_decision_count: readResult.value.unaware_decision_count,
    last_analysed_turn: readResult.value.last_analysed_turn,
  };
}

/**
 * Atomically persist a validated session summary under `jev-summaries/`.
 * Never throws; returns `false` when the path or record is unusable or the
 * write fails.
 *
 * @param {unknown} projectDir - Project root directory.
 * @param {unknown} sessionId - Session identifier from the Stop payload.
 * @param {unknown} summaryRecord - Session summary document to persist.
 * @param {string} [homeDir] - Home directory override for tests.
 * @returns {boolean} True when the summary document was written.
 */
export function saveSessionSummary(
  projectDir,
  sessionId,
  summaryRecord,
  homeDir = os.homedir(),
) {
  const filePath = sessionSummaryPath(projectDir, sessionId, homeDir);
  if (filePath === null || !isValidSessionSummary(summaryRecord)) {
    return false;
  }
  try {
    writeJsonFileAtomic(filePath, summaryRecord);
    return true;
  } catch {
    return false;
  }
}

/**
 * A turn is recorded in `bare_pick_history` when none of the kept reflection
 * signals is present. The history is context for the next Sonnet summary,
 * not an input to pause probability.
 *
 * @param {unknown} reflectionSignals - Boolean map of kept reflection signals.
 * @returns {boolean} True when every kept signal is false.
 */
function turnLacksReflectionSignals(reflectionSignals) {
  if (!isPlainObject(reflectionSignals)) {
    return false;
  }
  return REFLECTION_SIGNAL_KEYS.every(
    (key) => reflectionSignals[key] === false,
  );
}

/**
 * Derive the next persisted session summary from a validated structured state.
 *
 * @param {ReturnType<typeof emptySessionSummary>} previousSummary - Prior
 *   rolling summary.
 * @param {object} validState - Validated v3 structured state from Sonnet.
 * @param {string|null} promptId - Current turn's `promptId`.
 * @returns {ReturnType<typeof emptySessionSummary>} Next session summary.
 */
function buildNextSessionSummary(previousSummary, validState, promptId) {
  const isBarePick = turnLacksReflectionSignals(
    validState.developer_reflection?.reflection_signals,
  );
  const priorHistory = Array.isArray(previousSummary?.bare_pick_history)
    ? previousSummary.bare_pick_history
    : [];
  const nextHistory = [...priorHistory, isBarePick].slice(
    -MAX_BARE_PICK_HISTORY,
  );

  return {
    schema_version: STATE_SCHEMA_VERSION,
    summary: validState.summary,
    bare_pick_streak: validState.developer_reflection.bare_pick_streak,
    bare_pick_history: nextHistory,
    unaware_decision_count: validState.decision_weight.unaware_decision_count,
    last_analysed_turn: typeof promptId === "string" ? promptId : null,
  };
}

/**
 * Select the turn window for structured-state extraction: the current turn
 * (with `last_assistant_message` overriding its transcript answer when
 * non-empty) plus up to `PREVIOUS_TURNS` preceding non-Stoic-skill turns.
 *
 * @param {unknown} stopInput - Stop hook payload.
 * @returns {{ status: "no_turns" }
 *   | { status: "stoic_skill", promptId: string|null, value: { promptId: string|null } }
 *   | { status: "ok", turns: object[], current: object }} Selected window.
 */
export function selectTurnWindow(stopInput) {
  const payload = isPlainObject(stopInput) ? stopInput : {};
  const allTurns = readTurns(payload.transcript_path);
  const lastTurn = allTurns.at(-1);

  if (!lastTurn) {
    return { status: "no_turns" };
  }

  if (lastTurn.stoicSkill) {
    return {
      status: "stoic_skill",
      promptId: lastTurn.promptId,
      value: { promptId: lastTurn.promptId },
    };
  }

  const lastAnswer = payload.last_assistant_message;
  const hasLastAnswer = typeof lastAnswer === "string" && lastAnswer !== "";
  const current = hasLastAnswer
    ? { ...lastTurn, answer: lastAnswer }
    : lastTurn;

  const older = allTurns
    .slice(0, -1)
    .filter((turn) => !turn.stoicSkill)
    .slice(-PREVIOUS_TURNS);

  return {
    status: "ok",
    turns: [...older, current],
    current,
  };
}

/**
 * Render one turn for the Sonnet structured-state prompt, annotating each file
 * change with its line count.
 *
 * @param {object} turn - Turn from `readTurns`.
 * @param {number} number - 1-based index in the window.
 * @param {number} count - Total turns in the window.
 * @returns {string} Rendered Markdown section for the turn.
 */
function renderTurn(turn, number, count) {
  const suffix = number === count ? " (current)" : "";
  const sections = [
    `## Turn ${number} of ${count}${suffix}`,
    `### Developer\n\n${turn.prompt}`,
    `### Assistant\n\n${turn.answer}`,
  ];

  if (Array.isArray(turn.changes) && turn.changes.length > 0) {
    const renderedChanges = turn.changes.map((change) => {
      const content = change.content ?? "";
      const lines = Number.isInteger(change.linesChanged)
        ? change.linesChanged
        : countLines(content);
      return `#### ${change.path} (${lines} lines)\n\n${content}`;
    });
    sections.push(`### Changes\n\n${renderedChanges.join("\n\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * Build the stdin prompt sent to Sonnet to produce the v3 structured state.
 *
 * @param {object[]} turns - Selected turn window, oldest first.
 * @param {ReturnType<typeof emptySessionSummary>} previousSummary - Rolling
 *   summary from prior analyses in the same session.
 * @returns {string} Complete stdin prompt text.
 */
export function buildStatePrompt(turns, previousSummary) {
  const summary = isValidSessionSummary(previousSummary)
    ? previousSummary
    : emptySessionSummary();
  const summaryText =
    summary.summary.length > 0 ? summary.summary : "(none — new session)";
  const renderedTurns = turns
    .map((turn, index) => renderTurn(turn, index + 1, turns.length))
    .join("\n\n");

  return [
    "Analyse the current turn in the context of the previous turns and the " +
      "rolling session summary. Produce the structured session state " +
      `matching schema_version ${STATE_SCHEMA_VERSION} and update the ` +
      `rolling summary (at most ${SUMMARY_MAX_CHARS} characters).`,
    "## Previous Rolling Summary\n\n" +
      `- summary: ${summaryText}\n` +
      `- bare_pick_streak: ${summary.bare_pick_streak}\n` +
      `- bare_pick_history: ${JSON.stringify(summary.bare_pick_history)}\n` +
      `- unaware_decision_count: ${summary.unaware_decision_count}\n` +
      `- last_analysed_turn: ${summary.last_analysed_turn ?? "none"}`,
    renderedTurns,
  ].join("\n\n");
}

/**
 * Build and validate the v3 structured session state for the current turn,
 * reading the previous session summary beforehand and persisting the updated
 * summary only when Sonnet returns a valid v3 state. Never throws.
 *
 * @param {unknown} stopInput - Stop hook payload (`transcript_path`,
 *   `last_assistant_message`, `session_id`, `cwd`).
 * @param {object} [options] - Execution options and test seams.
 * @param {string} [options.projectDir] - Project root directory; defaults to
 *   `stopInput.cwd`.
 * @param {string} [options.homeDir] - Home directory override for tests.
 * @param {object} [options.previousSummary] - Explicit prior summary override.
 * @param {Function} [options.runner] - Headless runner seam with the
 *   `runClaude` signature; defaults to `runClaude`.
 * @param {Function} [options.spawn] - Spawn seam forwarded to `runner`.
 * @param {readonly object[]} [options.registry] - Category registry override.
 * @param {number} [options.maxInputChars] - Maximum prompt length in chars.
 * @returns {object} Structured state outcome (`ok`, `no_turns`, `stoic_skill`,
 *   `state_too_large`, `state_unavailable`, or `state_invalid`).
 */
export function buildStructuredState(stopInput, options = {}) {
  const settings = isPlainObject(options) ? options : {};
  const payload = isPlainObject(stopInput) ? stopInput : {};
  const windowResult = selectTurnWindow(payload);

  if (windowResult.status !== "ok") {
    return windowResult;
  }

  const projectDir = isNonEmptyString(settings.projectDir)
    ? settings.projectDir
    : payload.cwd;
  const sessionId = payload.session_id;
  const homeDir = isNonEmptyString(settings.homeDir)
    ? settings.homeDir
    : os.homedir();
  const registry = Array.isArray(settings.registry)
    ? settings.registry
    : CATEGORY_REGISTRY;
  const maxInputChars =
    Number.isInteger(settings.maxInputChars) && settings.maxInputChars > 0
      ? settings.maxInputChars
      : MAX_STATE_CHARS;

  const priorSummary = isValidSessionSummary(settings.previousSummary)
    ? settings.previousSummary
    : loadSessionSummary(projectDir, sessionId, homeDir);

  let turns = windowResult.turns;
  const current = windowResult.current;
  let prompt = buildStatePrompt(turns, priorSummary);

  while (prompt.length > maxInputChars && turns.length > 1) {
    turns = turns.slice(1);
    prompt = buildStatePrompt(turns, priorSummary);
  }

  const currentHasChanges = current.changes.length > 0;
  const meta = {
    promptId: current.promptId,
    currentHasChanges,
    stateChars: prompt.length,
    turnsIncluded: turns.length,
    previousSummary: priorSummary,
  };

  if (prompt.length > maxInputChars) {
    return {
      status: "state_too_large",
      reason: "state_too_large",
      ...meta,
      value: {
        prompt,
        ...meta,
      },
    };
  }

  const runner =
    typeof settings.runner === "function" ? settings.runner : runClaude;
  const jsonSchema = buildStateSchema(registry);
  const runnerOptions = {
    model: STATE_MODEL,
    jsonSchema,
    timeoutMs: STATE_TIMEOUT_MS,
  };
  if (typeof settings.spawn === "function") {
    runnerOptions.spawn = settings.spawn;
  }

  let headlessResult;
  try {
    headlessResult = runner(prompt, runnerOptions);
  } catch {
    headlessResult = { status: "unavailable", reason: "runner_threw" };
  }

  if (!isPlainObject(headlessResult) || headlessResult.status !== "ok") {
    const unavailableReason = isNonEmptyString(headlessResult?.reason)
      ? headlessResult.reason
      : "headless_failed";
    return {
      status: "state_unavailable",
      reason: unavailableReason,
      ...meta,
    };
  }

  const validation = validateStructuredState(headlessResult.value, registry);
  if (!validation.ok) {
    return {
      status: "state_invalid",
      reason: validation.reason,
      ...meta,
    };
  }

  const validState = validation.value;
  const nextSummary = buildNextSessionSummary(
    priorSummary,
    validState,
    current.promptId,
  );
  saveSessionSummary(projectDir, sessionId, nextSummary, homeDir);

  return {
    status: "ok",
    state: validState,
    summary: nextSummary,
    reason: null,
    ...meta,
    value: {
      state: validState,
      summary: nextSummary,
      ...meta,
    },
  };
}
