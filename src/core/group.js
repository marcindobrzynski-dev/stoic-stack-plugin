// Turn-group assembly — one turn's session events become one turn's summary.
//
// The Stop hook reads the session event log, hands the parsed lines here, and
// gets back the single shape the scorer consumes and the pause context later
// embeds (`group` in `stoic-pending-pause.json`). Nothing else in the engine
// reads raw event lines, so this module is where the log's line shapes stop
// being anyone else's problem.
//
// Two properties of the log drive the design:
//
// - The log IS the turn. Events accumulate between two Stops and the Stop hook
//   truncates what it consumed, so there is no windowing, no turn id, and no
//   clock: a turn is exactly the events handed in, in the order they were
//   appended.
// - The log is untrusted input. It survives a crash mid-append, it can be hand
//   edited, and it outlives the code that wrote it. So every field is coerced,
//   never assumed, and an unusable line costs itself alone — one corrupt event
//   degrades the group rather than the turn.
//
// Prompt effort is READ, never recomputed: `user-prompt-submit.js` computes it
// at submit time from the text as typed, and re-deriving it here would let a
// later change to the heuristic silently rescore a turn that already happened.
// A turn with several prompts therefore scores the MEAN of the efforts its log
// recorded, over its genuine prompts only — see `prompt_effort` below.
//
// This module is Domain-layer pure: deterministic, no filesystem, no
// environment, no clock reads beyond the timestamps the events carry, and it
// never mutates the events it was handed.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §`Session event log` (the line shapes read here) and
// §`stoic-pending-pause.json` (the `group` field this shape fills).
import {
  effortOf,
  isFiniteNumber,
  isNonEmptyString,
  isPlainObject,
} from "./predicates.js";
import { isGenuineQuestion } from "./prompts.js";

/**
 * The permission modes under which an observed edit reached disk without the
 * developer approving it. Derived from the documented Claude Code modes and
 * their "what runs without asking" behavior: `default` (the mode labeled
 * Manual in the UI — it never arrives as `"manual"`) and `plan` still ask, so
 * every other mode belongs here. `dontAsk` is included on the same reading:
 * it can only deny or run silently, so an edit this hook actually observed
 * under it was never approved edit-by-edit.
 *
 * Presence of one of these in a turn is what the turn delta's auto-accept
 * multiplier keys on; the multiplier's VALUE is a scoring knob and lives with
 * the other scoring constants, not here.
 */
export const AUTO_ACCEPT_PERMISSION_MODES = Object.freeze([
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "dontAsk",
]);

/**
 * What joins several prompts of one turn into the group's prompt text. A blank
 * line rather than a space: the classifier and the pause context both read this
 * field, and two prompts run together would read as one rambling instruction.
 */
export const PROMPT_SEPARATOR = "\n\n";

/** A logged line count as a usable volume: unreadable or negative counts as 0. */
const volumeOf = (value) => (isFiniteNumber(value) && value > 0 ? value : 0);

/** A logged timestamp, or 0 — a missing clock reading never drops real work. */
const timestampOf = (value) => (isFiniteNumber(value) ? value : 0);

/** A logged agent type, or null when the event does not name one. */
const agentTypeOf = (value) => (isNonEmptyString(value) ? value : null);

const isAutoAccepting = (mode) => AUTO_ACCEPT_PERMISSION_MODES.includes(mode);

/** One sub-agent lifecycle entry, built the same way for either lifecycle. */
const lifecycleEntry = (lifecycle, event) => ({
  lifecycle,
  ts: timestampOf(event.ts),
  agent_type: agentTypeOf(event.agent_type),
});

/** The zero-signal group: an empty turn, a log of nothing but corrupt lines. */
function emptyGroup() {
  return {
    prompt: "",
    prompt_effort: 0,
    genuine_prompt_count: 0,
    neutralized_prompt_count: 0,
    prompt_neutralized: false,
    had_question: false,
    auto_accept: false,
    edit_count: 0,
    lines_added: 0,
    lines_removed: 0,
    delegated_edit_count: 0,
    delegated_lines_added: 0,
    delegated_lines_removed: 0,
    delegated: false,
    agent_count: 0,
    edits: [],
    subagent_events: [],
    understood_event_count: 0,
    skipped_event_count: 0,
  };
}

/**
 * Summarize one turn from its session events.
 *
 * The returned group is a fresh plain object owning all of its data; the input
 * array and its events are never modified. Fields:
 *
 * - `prompt` — every genuine prompt of the turn, joined in submission order.
 *   The whole turn's asking, not a representative sample of it, because the
 *   effort number below averages the same set: showing the classifier one
 *   prompt while scoring several would make the pause context disagree with
 *   the number that triggered it.
 * - `prompt_effort` — the arithmetic mean of the logged efforts of the turn's
 *   GENUINE prompts, or 0 when it had none. Harness-injected prompts are
 *   excluded from the mean and from its denominator rather than averaged in as
 *   zeros: a machine notification is not a thought the developer failed to
 *   have, and letting one dilute a considered prompt would under-credit
 *   exactly the turns where work was deliberately delegated.
 * - `genuine_prompt_count` / `neutralized_prompt_count` — how many prompts of
 *   each kind. The genuine count is the mean's denominator; the two added
 *   together are every prompt the turn had.
 * - `prompt_neutralized` — the turn had prompts but none genuine. A turn still
 *   happened; no human typed it.
 * - `had_question` — some genuine prompt asks a real question (question
 *   relief). Judged here from the stored text because the log carries no
 *   question flag; unlike effort, this reads the same text the group exposes.
 * - `auto_accept` — some event ran under an auto-accepting permission mode.
 * - `edit_count` / `lines_added` / `lines_removed` — totals INCLUDING
 *   delegated work: real change is real change regardless of who typed it.
 *   The `delegated_*` fields are that work's share, so the turn delta can
 *   discount it without a second pass over the events.
 * - `delegated` / `agent_count` — whether this turn delegated at all, and how
 *   many sub-agents it started. Delegated edits alone are enough: sub-agents
 *   are asynchronous, so their edits routinely land in the turn AFTER the one
 *   that started them, whose log holds no start event at all.
 * - `edits` / `subagent_events` — the per-event detail the pause context and
 *   future gates need, in log order.
 * - `understood_event_count` / `skipped_event_count` — how many lines this
 *   reader understood and how many it could not, so a degraded turn is visible
 *   in the trace rather than silently quiet.
 *
 * @param {unknown} events - Parsed session-log lines, in append order. Any
 *   input shape is tolerated; a non-array is an empty turn.
 * @returns {object} The turn group. Never throws.
 */
/**
 * Fold one well-formed event into the group, and say whether it was understood.
 *
 * The verdict is a RETURNED VALUE, not a choice of keyword. When this switch
 * lived inside the loop, "this event counts" was carried by writing `break`
 * rather than `continue` — two visually interchangeable words, one of which
 * silently skipped the counter. Here every arm states its own verdict, and the
 * caller owns both counters.
 *
 * @param {object} group - The group being assembled; mutated in place. It is
 *   this module's own object, never a caller's, so the module's purity promise
 *   about its INPUTS still holds.
 * @param {object} event - One parsed session-log line with a string `type`.
 * @param {{texts: string[], effortTotal: number}} promptAccumulator - The two
 *   prompt tallies that are not group fields: the texts awaiting their join and
 *   the effort sum awaiting its division. They travel as one object because
 *   they are filled together and consumed together.
 * @returns {boolean} True when the event became evidence.
 */
function absorbEvent(group, event, promptAccumulator) {
  switch (event.type) {
    case "prompt": {
      const text = typeof event.prompt === "string" ? event.prompt : "";
      if (event.neutralized === true) {
        group.neutralized_prompt_count += 1;
      } else {
        group.genuine_prompt_count += 1;
        promptAccumulator.effortTotal += effortOf(event.effort);
        promptAccumulator.texts.push(text);
        group.had_question ||= isGenuineQuestion(text);
      }
      group.auto_accept ||= isAutoAccepting(event.permission_mode);
      return true;
    }

    case "edit": {
      // The file is what makes an edit attributable — to a critical path, to
      // the developer, to a line in the pause context. An edit event without
      // one is a torn line, and counting its volume anyway would move the
      // score for a change nobody can point at.
      if (!isNonEmptyString(event.file)) {
        return false;
      }
      const delegated = event.delegated === true;
      const linesAdded = volumeOf(event.lines_added);
      const linesRemoved = volumeOf(event.lines_removed);

      group.edit_count += 1;
      group.lines_added += linesAdded;
      group.lines_removed += linesRemoved;
      if (delegated) {
        group.delegated_edit_count += 1;
        group.delegated_lines_added += linesAdded;
        group.delegated_lines_removed += linesRemoved;
      }
      group.edits.push({
        ts: timestampOf(event.ts),
        file: event.file,
        lines_added: linesAdded,
        lines_removed: linesRemoved,
        delegated,
        agent_type: delegated ? agentTypeOf(event.agent_type) : null,
      });
      group.auto_accept ||= isAutoAccepting(event.permission_mode);
      return true;
    }

    // The two lifecycle arms stay separate rather than sharing one case with a
    // re-test of `event.type`: the switch has already answered which one this
    // is, and their asymmetry — only a start raises the count — belongs where
    // the reader can see it.
    case "subagent_start":
      group.agent_count += 1;
      group.subagent_events.push(lifecycleEntry("start", event));
      return true;

    case "subagent_stop":
      group.subagent_events.push(lifecycleEntry("stop", event));
      return true;

    default:
      // A line from a newer or older writer than this reader. Unknown is not
      // broken, but it is not evidence either.
      return false;
  }
}

export function buildTurnGroup(events) {
  const group = emptyGroup();
  if (!Array.isArray(events)) {
    return group;
  }

  const promptAccumulator = { texts: [], effortTotal: 0 };

  for (const event of events) {
    // Short-circuit and classification in one expression: a line that is not a
    // readable event never reaches `absorbEvent`, and both outcomes land in the
    // same pair of counters below.
    const is_understood_event =
      isPlainObject(event) &&
      isNonEmptyString(event.type) &&
      absorbEvent(group, event, promptAccumulator);

    if (is_understood_event) {
      group.understood_event_count += 1;
    } else {
      group.skipped_event_count += 1;
    }
  }

  group.prompt = promptAccumulator.texts.join(PROMPT_SEPARATOR);
  group.prompt_effort =
    group.genuine_prompt_count === 0
      ? 0
      : promptAccumulator.effortTotal / group.genuine_prompt_count;
  group.prompt_neutralized =
    group.genuine_prompt_count === 0 && group.neutralized_prompt_count > 0;
  group.delegated = group.agent_count > 0 || group.delegated_edit_count > 0;
  return group;
}
