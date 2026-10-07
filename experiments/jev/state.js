// Builds the Jev `state`: the developer's last few turns rendered as one
// Markdown text, the only thing Jev sees of the session.
//
// The transcript may not yet hold the current turn's final answer when Stop
// fires, so that answer comes from the Stop payload's `last_assistant_message`.
// The budget is measured on the rendered text, headings included, and is met
// by dropping whole oldest turns; nothing is trimmed inside a turn.
//
// Experiment only (`feature/jev-classifier-experiment`, never merged).
import { isPlainObject } from "../../src/core/predicates.js";
import { readTurns } from "./transcript.js";

/** How many completed turns Jev sees, the current one included. */
export const WINDOW_TURNS = 5;

/** About 28k tokens at four characters a token, leaving room for a question. */
export const MAX_STATE_CHARS = 28_000 * 4;

/**
 * Render one turn under English headings. A turn without changes has no
 * `Changes` section.
 *
 * @param {{prompt: string, answer: string,
 *   changes: {path: string, content: string}[]}} turn - The turn.
 * @param {number} number - Its 1-based position in the window.
 * @param {number} count - How many turns the window holds.
 * @returns {string} The rendered turn.
 */
function renderTurn(turn, number, count) {
  const current = number === count ? " (current)" : "";
  const sections = [
    `## Turn ${number} of ${count}${current}`,
    `### Developer\n\n${turn.prompt}`,
    `### Assistant\n\n${turn.answer}`,
  ];

  if (turn.changes.length > 0) {
    const changes = turn.changes.map(
      ({ path, content }) => `#### ${path}\n\n${content ?? ""}`,
    );

    sections.push(`### Changes\n\n${changes.join("\n\n")}`);
  }

  return sections.join("\n\n");
}

/**
 * Render a window of turns, oldest first.
 *
 * @param {object[]} turns - The turns.
 * @returns {string} The rendered state.
 */
function render(turns) {
  return turns
    .map((turn, index) => renderTurn(turn, index + 1, turns.length))
    .join("\n\n");
}

/**
 * Build the Jev `state` from the Stop payload, and report whether the current
 * turn wrote files. Fails, so the caller can fall back or skip, when the
 * transcript holds no turns (`no_turns`), when the current turn invokes a
 * Stoic Stack skill (`stoic_skill`), or when the current turn alone exceeds
 * the budget (`state_too_large`). Older skill turns are left out of the
 * window. `state_too_large` still carries the oversized state, so the
 * experiment log can show what did not fit. `stoic_skill` carries only the
 * turn's `promptId`, so the summary line can name the skipped turn; no state
 * is built for it.
 *
 * @param {unknown} stopInput - The Stop payload.
 * @returns {{status: "ok"|"state_too_large", value: {state: string,
 *   stateChars: number, turnsIncluded: number, promptId: string|null,
 *   currentHasChanges: boolean}}
 *   | {status: "stoic_skill", value: {promptId: string|null}}
 *   | {status: "no_turns"}} The result.
 */
export function buildState(stopInput) {
  const {
    transcript_path: transcriptPath,
    last_assistant_message: lastAnswer,
  } = isPlainObject(stopInput) ? stopInput : {};
  const allTurns = readTurns(transcriptPath);
  const lastTurn = allTurns.at(-1);

  if (!lastTurn) {
    return { status: "no_turns" };
  }

  if (lastTurn.stoicSkill) {
    return {
      status: "stoic_skill",
      value: { promptId: lastTurn.promptId },
    };
  }

  const current =
    typeof lastAnswer === "string" && lastAnswer !== ""
      ? { ...lastTurn, answer: lastAnswer }
      : lastTurn;
  const older = allTurns
    .slice(0, -1)
    .filter((turn) => !turn.stoicSkill)
    .slice(-(WINDOW_TURNS - 1));
  let turns = [...older, current];
  let state = render(turns);

  while (state.length > MAX_STATE_CHARS && turns.length > 1) {
    turns = turns.slice(1);
    state = render(turns);
  }

  return {
    status: state.length > MAX_STATE_CHARS ? "state_too_large" : "ok",
    value: {
      state,
      stateChars: state.length,
      turnsIncluded: turns.length,
      promptId: current.promptId,
      currentHasChanges: current.changes.length > 0,
    },
  };
}
