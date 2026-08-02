#!/usr/bin/env node
// Stop — the turn boundary, and the only place a score moves.
//
// Everything before this hook is append-only observation; this is where the
// turn is closed: the session log is consumed, summarized, scored against the
// time that passed, and persisted. Principle 4 of the architecture ("state is
// written once per turn, at Stop") is what makes the engine free of mid-turn
// races, and it holds only because this file is the sole writer of the score.
//
// Consumption is read-then-delete, not an atomic snapshot, so it is very
// nearly — not exactly — once per event. An append racing this hook's two
// filesystem calls can be discarded, and a delete that fails leaves already
// read events to resurface in a later turn's group. Both are accepted PoC
// trade-offs; see architecture/trade-offs.md §11.
//
// The binding order of operations is read-and-truncate the log → build the
// turn group → decay by half-life, add the turn delta, floor at zero → SAVE
// STATE BEFORE GATING. This stage deliberately stops at the save: no hard or
// soft gate, no classifier, no mutes, no `stoic-pending-pause.json`, no
// Stop-block. Which means stdout stays empty — a stray line here would reach
// the user's conversation as if it were a pause.
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
// Contract: thoughts/shared/.project/architecture.md (Stop order of
// operations) and architecture/payloads.md §`trace.jsonl`, §`state.json`.
import { buildTurnGroup } from "../core/group.js";
import { isNonEmptyString, isPlainObject } from "../core/predicates.js";
import { scoreTurn } from "../core/scoring.js";
import {
  AUTO_ACCEPT_MULTIPLIER,
  DIFF_LINE_CAP,
  EDIT_COUNT_CAP,
  loadConfig,
  resolveKnobs,
} from "../io/config.js";
import { readSessionEvents, truncateSessionLog } from "../io/session-log.js";
import { loadState, saveState } from "../io/state.js";
import { writeTraceLine } from "../io/trace.js";
import { readHookPayload, traceErrorMessage } from "./hook-runtime.js";

/** The name this hook is registered under; it labels every trace line below. */
const HOOK = "Stop";

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
 * @param {string} projectDir - The session's project directory.
 * @param {string} sessionId - Session identifier from the payload.
 * @param {object} config - The project configuration already loaded.
 * @returns {{outcome: string, score_before: number, score_after: number}} The
 *   trace line describing the score movement.
 */
function scoreTurnBoundary(projectDir, sessionId, config) {
  const events = readSessionEvents(projectDir, sessionId);
  truncateSessionLog(projectDir, sessionId);
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
  // this hook does not own — mutes, skip history, a personal preset — and
  // moving two of them is the whole of what a turn boundary changes.
  state.score = scoreAfter;
  state.last_update = now;
  saveState(projectDir, state);

  return {
    outcome: "scored",
    score_before: scoreBefore,
    score_after: scoreAfter,
  };
}

function main() {
  // Presence, not value: the guard exists so the plugin cannot score its own
  // child processes, and any value at all means one is running.
  if (process.env.STOIC_INTERNAL !== undefined) {
    return;
  }

  // Before a payload is parsed, the running directory is the only project we
  // know of — enough to trace that a malformed invocation happened at all.
  let projectDir = process.cwd();
  try {
    const payload = readHookPayload();
    if (payload === undefined) {
      // With no session there is no log to consume and no turn to close.
      writeTraceLine(projectDir, HOOK, { outcome: "malformed_input" });
      return;
    }

    // The payload's cwd wins over the process's: it is the session's project,
    // which is what the event log, the state document, and the trace all have
    // to agree about.
    if (isNonEmptyString(payload.cwd)) {
      projectDir = payload.cwd;
    }

    const config = loadConfig(projectDir);
    if (!config.enabled) {
      // The master switch is off, not a truncation instruction: like every
      // capture hook, a disabled Stop leaves the log exactly as it found it.
      writeTraceLine(projectDir, HOOK, { outcome: "disabled" });
      return;
    }

    if (payload.stop_hook_active === true) {
      const dropped = countByKind(
        readSessionEvents(projectDir, payload.session_id),
      );
      truncateSessionLog(projectDir, payload.session_id);
      writeTraceLine(projectDir, HOOK, {
        outcome: "continuation_truncated",
        dropped,
      });
      return;
    }

    writeTraceLine(
      projectDir,
      HOOK,
      scoreTurnBoundary(projectDir, payload.session_id, config),
    );
  } catch (error) {
    // The safety net under a pipeline whose every I/O module already swallows
    // its own failures — except the state save, which is allowed to throw so
    // that a lost score is visible here rather than silently pretended.
    writeTraceLine(projectDir, HOOK, {
      outcome: "error",
      error: traceErrorMessage(error),
    });
  }
}

main();
