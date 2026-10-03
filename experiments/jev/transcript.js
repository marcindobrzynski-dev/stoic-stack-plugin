// Reads a Claude Code transcript into the developer's turns, the raw material
// of the Jev `state`.
//
// A transcript is an event log, not a conversation: `user` lines also carry
// tool results, injected skill bodies (`isMeta`), task notifications and
// built-in command output. Only a line with `origin.kind === "human"` is the
// developer typing, so only that line opens a turn. Everything up to the next
// such line belongs to the turn.
//
// Experiment only (`feature/jev-classifier-experiment`, never merged).
import { readFileSync } from "node:fs";

import { isPlainObject } from "../../src/core/predicates.js";

/** A prompt that invokes one of this plugin's skills, e.g. `/stoic-reflect`. */
const STOIC_SKILL_PROMPT = /<command-name>\/(?:stoic-stack:)?stoic-/;

/**
 * Parse one JSONL line, or null when it is not a JSON object.
 *
 * @param {string} line - One transcript line.
 * @returns {object|null} The parsed line, or null.
 */
function parseLine(line) {
  try {
    const parsed = JSON.parse(line);

    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Whether a transcript line is a prompt the developer typed.
 *
 * @param {object} line - A parsed transcript line.
 * @returns {boolean} True for a human prompt.
 */
function isHumanPrompt(line) {
  return (
    line.type === "user" &&
    line.origin?.kind === "human" &&
    typeof line.message?.content === "string"
  );
}

/**
 * Fold one assistant line into the open turn: its last `text` block becomes
 * the answer, its `Write`/`Edit` calls become changes. `thinking` is dropped.
 *
 * @param {object} turn - The open turn, mutated.
 * @param {object} line - A parsed `assistant` line.
 */
function absorbAssistant(turn, line) {
  const blocks = Array.isArray(line.message?.content)
    ? line.message.content
    : [];

  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") {
      turn.answer = block.text;
    } else if (block?.type === "tool_use" && isPlainObject(block.input)) {
      const { file_path: path } = block.input;

      if (block.name === "Write") {
        turn.changes.push({ path, content: block.input.content });
      } else if (block.name === "Edit") {
        turn.changes.push({ path, content: block.input.new_string });
      }
    }
  }
}

/**
 * Read a transcript into the developer's turns, oldest first. Turns that
 * invoke a Stoic Stack skill are kept and flagged `stoicSkill`, so the caller
 * still knows which turn is the last one. The last turn may still be open;
 * its answer is whatever the transcript holds so far. Never throws: an
 * unreadable file yields no turns, a broken line is skipped.
 *
 * @param {string} transcriptPath - The Stop payload's `transcript_path`.
 * @returns {{prompt: string, promptId: string|null, answer: string,
 *   stoicSkill: boolean, changes: {path: string, content: string}[]}[]} The
 *   turns.
 */
export function readTurns(transcriptPath) {
  let text;

  try {
    text = readFileSync(transcriptPath, "utf8");
  } catch {
    return [];
  }

  const turns = [];
  let turn = null;

  for (const raw of text.split("\n")) {
    const line = parseLine(raw);

    if (!line) {
      continue;
    }

    if (isHumanPrompt(line)) {
      const prompt = line.message.content;

      turn = {
        prompt,
        promptId: typeof line.promptId === "string" ? line.promptId : null,
        answer: "",
        stoicSkill: STOIC_SKILL_PROMPT.test(prompt),
        changes: [],
      };
      turns.push(turn);
    } else if (turn && line.type === "assistant") {
      absorbAssistant(turn, line);
    }
  }

  return turns;
}
