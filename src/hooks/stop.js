#!/usr/bin/env node
// Stop — the turn boundary: the only place a turn is scored, and the only
// place an automatic pause is born.
//
// Everything before this hook is append-only observation; this is where the
// turn is closed: the session log is consumed, summarized, scored against the
// time that passed, and persisted. Principle 4 of the architecture ("state is
// written once per turn, at Stop") is what makes the engine free of mid-turn
// races. The score has exactly one other writer — `src/cli/record.js`, which
// applies the shared relief formula when a manual reflection is completed,
// outside any turn (architecture/trade-offs.md §14) — and no third.
//
// Consumption is read-then-delete, not an atomic snapshot, so it is very
// nearly — not exactly — once per event. An append racing this hook's two
// filesystem calls can be discarded, and a delete that fails leaves already
// read events to resurface in a later turn's group. Both are accepted PoC
// trade-offs; see architecture/trade-offs.md §11.
//
// The binding order of operations is read-and-truncate the log → build the
// turn group → decay by half-life, add the turn delta, floor at zero → drop
// expired mutes → SAVE STATE BEFORE GATING → decide → deliver. The save comes
// before the gating because everything after it can stall or fail: a
// classifier that never answers must still cost only the pause, never the
// score, and the pruned mutes ride that same write.
//
// Delivery is three writes in a fixed order, and the order is the fail-safe.
// The cooled score is persisted first, so a turn cannot fire twice even if the
// rest goes wrong; then `stoic-pending-pause.json`, the hand-off the pause
// skill reads; and only then the Stop-block on stdout. A block announcing a
// document that was never written would send the skill after a file that does
// not exist, so stdout goes last and, on any failure before it, never at all.
// Which is also why stdout is otherwise untouched: a stray line from this file
// would reach the user's conversation as if it were a pause.
//
// The judgment itself is NOT here. `stop-decision.js` answers whether this
// turn should interrupt the developer — gates, classifier veto, mutes,
// cooldown arithmetic — and this file only acts on the answer. That split is
// what lets the decision be tested without a spawn and this file be tested
// only for what an outside observer sees.
//
// Two invocations are NOT turns and must not be scored:
//
// - A `STOIC_INTERNAL` child is the plugin's own machinery; it leaves before
//   reading or writing anything, exactly as the capture frame does.
// - A continuation Stop (`stop_hook_active`) follows a pause, so its log holds
//   the pause machinery's own events. It truncates them and exits without
//   touching state, recording what it dropped by kind so calibration can later
//   see how much real evidence a pause costs.
//
// The frame around all of that mirrors `capture.js` — same guard order, same
// fail-silent contract, same one-trace-line-per-invocation promise — but the
// body orchestrates rather than delegating one decision, so it is written out
// here instead of squeezed through `runCaptureHook`. The two files share only
// `hook-runtime.js`, the leaf holding the chores neither orchestration owns;
// neither imports the other, and the resemblance between their frames is a
// resemblance, not a dependency.
//
// Contract: thoughts/shared/.project/architecture/data-flow.md (Stop order of
// operations) and architecture/payloads.md §`local-trace.jsonl`,
// §`shared-trace.jsonl`, §`state.json`,
// §`stoic-pending-pause.json` (part 1), §"Stop hook output" (part 2).
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pruneMutes } from "../core/gates.js";
import { buildTurnGroup } from "../core/group.js";
import { isNonEmptyString, isPlainObject } from "../core/predicates.js";
import { scoreTurn } from "../core/scoring.js";
import { readTurns } from "../../experiments/jev/transcript.js";
import {
  AUTO_ACCEPT_MULTIPLIER,
  DIFF_LINE_CAP,
  EDIT_COUNT_CAP,
  loadConfig,
  resolveKnobs,
} from "../io/config/config.js";
import { writeJsonFileAtomic } from "../io/json-file.js";
import { pendingPausePath } from "../io/paths.js";
import { resolveProjectRoot } from "../io/project-root.js";
import { readSessionEvents, truncateSessionLog } from "../io/session-log.js";
import { loadState, saveState } from "../io/state.js";
import { writeLocalTraceLine, writeSharedTraceLine } from "../io/trace.js";
import { readHookPayload, traceErrorMessage } from "./hook-runtime.js";
import { decideFire } from "./stop-decision.js";

/** The name this hook is registered under; it labels every trace line below. */
const STOP_HOOK_NAME = "Stop";

/**
 * Where the plugin is installed, resolved from this file's own location — two
 * directories above `src/hooks/`. The pause document carries it so the skill
 * can find `record.js` no matter which project the session is in, and no
 * environment variable is involved: a marketplace install can sit anywhere,
 * but it always sits at the same distance from this file.
 *
 * `hooks.json` names that root as `${CLAUDE_PLUGIN_ROOT}`, but that is a
 * command-line template Claude Code expands before this process exists rather
 * than something the file can read back, and reading it from the environment
 * instead would rest the hook on a variable no test may set (architecture.md
 * §Testing strategy) — so the location is derived here, never received.
 */
const PLUGIN_ROOT = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);

/**
 * The command the pause skill shells to when the developer has answered. The
 * path is quoted because the skill runs this string verbatim and a marketplace
 * install can sit under a path with spaces.
 */
const RECORD_CMD = `node "${path.join(PLUGIN_ROOT, "src", "cli", "record.js")}"`;

/**
 * How much time the persisted score has had to decay.
 *
 * `last_update: 0` means "never evaluated", and reading it as an elapsed time
 * since 1970 would wipe an accumulated score on the first Stop after an
 * upgrade. A clock that went backwards is treated the same way: decay is the
 * score's only way down, never a way up.
 *
 * @param {unknown} lastUpdate - The persisted `last_update`, in ms epoch.
 * @param {number} now - This invocation's clock reading, in ms epoch.
 * @returns {number} Milliseconds of decay to apply; 0 when there are none.
 */
function elapsedSince(lastUpdate, now) {
  if (!Number.isFinite(lastUpdate) || lastUpdate <= 0) {
    return 0;
  }
  const elapsed = now - lastUpdate;
  return Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0;
}

/**
 * Tally events by kind, for the continuation Stop's trace line. Only readable
 * events are counted — an unreadable line is evidence of nothing — and a kind
 * the turn did not have is absent rather than zero, so the line says what was
 * dropped instead of enumerating every event type that exists.
 *
 * @param {unknown[]} events - Parsed session-log lines.
 * @returns {Record<string, number>} Counts keyed by event type.
 */
function countByKind(events) {
  const counts = {};
  for (const event of events) {
    if (isPlainObject(event) && isNonEmptyString(event.type)) {
      counts[event.type] = (counts[event.type] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * Assemble the pending-pause document — the whole hand-off to the pause skill,
 * in one value.
 *
 * It is deliberately self-contained. The skill and the CLI behind it are
 * separate processes started later, in a session that may have been opened in
 * a subdirectory, so nothing here may be derivable-on-arrival: the project, the
 * plugin's location, the command to record an outcome, and the three settings
 * that shape the conversation all travel with it.
 *
 * `score` is the fire-time score, deliberately BEFORE the cooldown: it is what
 * the developer is told about the turn that interrupted them, while the cooled
 * number is only bookkeeping the engine keeps to itself.
 *
 * @param {number} now - This invocation's clock reading, in ms epoch.
 * @param {object} decision - A `fire` decision from `decideFire`.
 * @param {object} group - The turn group, embedded verbatim.
 * @param {string} projectDir - The session's project directory.
 * @param {object} config - The project configuration already loaded.
 * @returns {object} The document, exactly per the frozen part-1 schema.
 */
function pauseDocument(now, decision, group, projectDir, config) {
  return {
    created_at: now,
    trigger: decision.trigger,
    score: decision.score,
    threshold: decision.threshold,
    classification: decision.classification,
    group,
    cwd: projectDir,
    plugin_root: PLUGIN_ROOT,
    record_cmd: RECORD_CMD,
    pause_mode: config.pause_mode,
    followup_draft: config.followup_draft,
    max_questions: config.max_questions,
  };
}

/**
 * The Stop-block's reason — the one channel through which this hook can speak
 * to the conversation, and therefore load-bearing prose.
 *
 * Three things in it are machine-actionable and may not be dropped: the skill's
 * fully qualified name, the ABSOLUTE path of the document it must read (the
 * session may have been opened in a subdirectory, which would resolve to a
 * different project slug), and the instruction to stop afterwards rather than
 * resume the interrupted work. The tone around them is the deliberate part:
 * this is an invitation to look, not an accusation of carelessness.
 *
 * @param {string} pauseFile - Absolute path of the pending-pause document.
 * @returns {string} The reason text; mirrored by the skill's expectations.
 */
function blockReason(pauseFile) {
  return [
    "This turn touched something worth a moment's attention.",
    `Invoke the stoic-stack:stoic-pause skill with the pending pause at ${pauseFile},`,
    "walk the developer through it, and then end the turn —",
    "the interrupted work resumes only when they ask for it.",
  ].join(" ");
}

/**
 * Deliver a fired pause: cool the score, write the hand-off, announce it.
 *
 * The order is the fail-safe. The cooled score is persisted first so a failure
 * afterwards still costs one pause rather than opening the way to a second one
 * next turn; the document is written before the block so the skill can never
 * be sent after a file that does not exist. Both writes may throw, and the
 * frame above is what catches them — silently, which is exactly right: a pause
 * that could not be delivered must cost the pause and nothing else.
 *
 * @param {number} now - This invocation's clock reading, in ms epoch.
 * @param {object} decision - A `fire` decision from `decideFire`.
 * @param {object} state - The state document, already scored and saved once.
 * @param {object} group - The turn group, embedded verbatim.
 * @param {string} projectDir - The session's project directory.
 * @param {object} config - The project configuration already loaded.
 */
function deliverPause(now, decision, state, group, projectDir, config) {
  const pauseFile = pendingPausePath(projectDir);

  state.score = decision.cooled_score;
  saveState(projectDir, state);
  writeJsonFileAtomic(
    pauseFile,
    pauseDocument(now, decision, group, projectDir, config),
  );
  process.stdout.write(
    JSON.stringify({ decision: "block", reason: blockReason(pauseFile) }),
  );
}

/**
 * Close one turn: consume its log, score it, persist the result.
 *
 * The read and the truncation happen together, before anything can fail on the
 * way to the score: a turn that throws afterwards costs its own score rather
 * than re-scoring its events on the next Stop. That ordering is the binding
 * part. It is not a transaction, though — an event appended between the read
 * and the delete is discarded unread, and a delete that fails leaves read
 * events to be scored again next turn. Bounding those two windows to a pair of
 * adjacent calls is as far as the PoC goes deliberately.
 *
 * An empty or missing log is not special-cased away: it still flows through as
 * an empty group, so elapsed time always decays and persists.
 *
 * Everything after the save is the fire path, and it is all disposition: the
 * decision is made elsewhere, and each of its four outcomes maps to one trace
 * line. `fire` writes through `deliverPause`; a cooled `veto` saves its capped
 * score (`VETO_COOLDOWN_RATIO`).
 *
 * @param {string} projectDir - The session's project directory.
 * @param {object} payload - The Stop hook input; its `session_id` names the
 *   event log, and the whole of it reaches the classifier as `stopInput`,
 *   beside the resolved `projectDir`.
 * @param {object} config - The project configuration already loaded.
 * @returns {{outcome: string, score_before: number, score_after: number}} The
 *   trace line describing what this turn boundary did.
 */
function closeTurnBoundary(projectDir, payload, config) {
  const events = readSessionEvents(projectDir, payload.session_id);
  truncateSessionLog(projectDir, payload.session_id);
  const group = buildTurnGroup(events);

  const state = loadState(projectDir);
  const knobs = {
    ...resolveKnobs(config, state),
    edit_count_cap: EDIT_COUNT_CAP,
    diff_line_cap: DIFF_LINE_CAP,
    auto_accept_multiplier: AUTO_ACCEPT_MULTIPLIER,
  };

  const now = Date.now();
  const scoreBefore = state.score;
  const scoreAfter = scoreTurn(
    scoreBefore,
    elapsedSince(state.last_update, now),
    group,
    knobs,
  );

  // Mutated in place rather than rebuilt: the loaded document carries fields
  // this hook does not own — skip history, a personal preset — and moving the
  // score, its timestamp, and the mute list is the whole of what a turn
  // boundary changes. Pruning rides this one save so state hygiene costs no
  // extra write, and it happens before the gating so the same instant governs
  // what is kept and what is allowed to suppress.
  state.score = scoreAfter;
  state.last_update = now;
  state.mutes = pruneMutes(state.mutes, now);
  saveState(projectDir, state);

  const sessionId = isNonEmptyString(payload?.session_id)
    ? payload.session_id
    : null;
  const classifierModel = isNonEmptyString(config?.classifier_model)
    ? config.classifier_model
    : "";
  let promptId = null;
  if (isNonEmptyString(payload?.prompt_id)) {
    promptId = payload.prompt_id;
  } else if (
    classifierModel.startsWith("jev") &&
    isNonEmptyString(payload?.transcript_path)
  ) {
    promptId = readTurns(payload.transcript_path).at(-1)?.promptId ?? null;
  }
  const turnTs = new Date(now).toISOString();
  const joinKey = {
    prompt_id: promptId,
    session_id: sessionId,
    turn_ts: turnTs,
  };
  const turnContext = {
    stopInput: payload,
    projectDir,
    ...joinKey,
  };
  const movement = { score_before: scoreBefore, score_after: scoreAfter };
  const decision = decideFire(state, config, group, turnContext, { now });

  if (decision.outcome === "veto") {
    if (typeof decision.cooled_score === "number") {
      state.score = decision.cooled_score;
      saveState(projectDir, state);
      return {
        outcome: "veto",
        trigger: decision.trigger,
        reason: decision.reason,
        score_before: scoreBefore,
        score_after: decision.cooled_score,
        ...joinKey,
      };
    }
    return {
      outcome: "veto",
      trigger: decision.trigger,
      reason: decision.reason,
      ...movement,
      ...joinKey,
    };
  }
  if (decision.outcome === "muted") {
    return {
      outcome: "muted",
      trigger: decision.trigger,
      category: decision.classification.category,
      ...movement,
      ...joinKey,
    };
  }
  if (decision.outcome !== "fire") {
    return { outcome: "scored", ...movement, ...joinKey };
  }

  deliverPause(now, decision, state, group, projectDir, config);
  return {
    outcome: "fired",
    trigger: decision.trigger,
    score_before: scoreBefore,
    score_after: decision.cooled_score,
    ...joinKey,
  };
}

function main() {
  // Presence, not value: the guard exists so the plugin cannot score its own
  // child processes, and any value at all means one is running.
  if (process.env.STOIC_INTERNAL !== undefined) {
    return;
  }

  // Null until resolution names a project: a failure before that has no local
  // trace to land in.
  let projectDir = null;
  try {
    const payload = readHookPayload();

    // The Project Root, not the directory this process was handed: a session
    // can report a subfolder turns after starting at the root, and the event
    // log, the state document, and the trace all have to agree on one project.
    // A malformed payload offers no `cwd`, but its trace line still belongs to
    // the root rather than to a subfolder.
    projectDir = resolveProjectRoot(process.cwd(), payload?.cwd);
    if (projectDir === null) {
      writeSharedTraceLine(STOP_HOOK_NAME, { outcome: "no_project_root" });
      return;
    }

    if (payload === undefined) {
      // With no session there is no log to consume and no turn to close.
      writeLocalTraceLine(projectDir, STOP_HOOK_NAME, {
        outcome: "malformed_input",
      });
      return;
    }

    const config = loadConfig(projectDir);
    if (!config.enabled) {
      // The master switch is off, not a truncation instruction: like every
      // capture hook, a disabled Stop leaves the log exactly as it found it.
      writeLocalTraceLine(projectDir, STOP_HOOK_NAME, { outcome: "disabled" });
      return;
    }

    if (payload.stop_hook_active === true) {
      const dropped = countByKind(
        readSessionEvents(projectDir, payload.session_id),
      );
      truncateSessionLog(projectDir, payload.session_id);
      writeLocalTraceLine(projectDir, STOP_HOOK_NAME, {
        outcome: "continuation_truncated",
        dropped,
      });
      return;
    }

    const traceLine = closeTurnBoundary(projectDir, payload, config);
    writeLocalTraceLine(projectDir, STOP_HOOK_NAME, traceLine);
  } catch (error) {
    // The safety net under a pipeline whose every I/O module already swallows
    // its own failures — except the state save, which is allowed to throw so
    // that a lost score is visible here rather than silently pretended.
    const line = { outcome: "error", error: traceErrorMessage(error) };
    if (projectDir === null) {
      writeSharedTraceLine(STOP_HOOK_NAME, line);
    } else {
      writeLocalTraceLine(projectDir, STOP_HOOK_NAME, line);
    }
  }
}

main();
