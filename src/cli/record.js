#!/usr/bin/env node
// The recording CLI — the single writer of a pause outcome, and the only seam
// between the `stoic-pause` skill and everything a recorded Decision changes.
//
// The skill owns the conversation; this CLI owns its consequences. That split
// matters more here than anywhere else in the plugin: a reflection is text the
// developer just wrote and cannot be regenerated, so where it lands, what it
// silences, and how long for are decisions made in code rather than in a
// prompt. The skill may pass an outcome from a fixed vocabulary and two file
// paths — nothing it says can change what gets written.
//
//   node src/cli/record.js --outcome keep|correct|skip|defer \
//     --pause <path to stoic-pending-pause.json> \
//     [--data <path to pause-answer.json>]
//
// Both paths are explicit and are NEVER derived from the invocation cwd: a
// session opened in a subdirectory would resolve a different project slug and
// miss the pending pause entirely. The project root the decision bank needs
// comes from the pause document's own `cwd` field, which is why there is no
// `--project` flag.
//
// Free text never travels as an argument — Windows shell quoting is too
// fragile to trust a multi-paragraph reflection to — so `keep` and `correct`
// read it from the answer file the skill wrote, and `--data` is required for
// exactly those two and refused for the other two.
//
// The score is not this file's business under any outcome. The Stop hook is
// the sole scorer; state is loaded, its mutes and skip history are moved, and
// the same object is saved back, so `score`, `last_update`, and a personal
// `preset` survive by construction rather than by care.
//
// stdout is always exactly one JSON result, success or failure, so the caller
// parses one stream and branches on `ok`. Human-readable diagnostics — the only
// place a filesystem path may appear — go to stderr and are not part of the
// contract.
//
// Exit status: 0 success, 2 the request was rejected and nothing was written,
// 1 the request was fine but persistence failed partway — in which case the
// result says honestly what had already landed. These are separate atomic
// writes, not one transaction, and there is no rollback to pretend otherwise.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// (§ `record.js` CLI, § `pause-answer.json`, § Decision bank entry,
//  § `state.json`, § `stoic-pending-pause.json`).
import fs from "node:fs";
import { parseArgs } from "node:util";

import { BANK_OUTCOMES, writeDecisionEntry } from "../io/bank.js";
import { loadConfig, resolveKnobs } from "../io/config.js";
import { readJsonFile } from "../io/json-file.js";
import { loadState, saveState } from "../io/state.js";
import { isNonEmptyString, isPlainObject } from "../core/predicates.js";

/**
 * The outcome vocabulary — imperatives, because it is the menu the user picks
 * from. `keep` and `correct` reach the bank (the bank names those two itself);
 * `skip` and `defer` are the quiet ones.
 */
const OUTCOMES = Object.freeze([...BANK_OUTCOMES, "skip", "defer"]);

/** Consecutive skips of one category before the whole category goes quiet. */
const SKIPS_BEFORE_CATEGORY_MUTE = 3;

const MS_PER_HOUR = 3_600_000;

const USAGE = `Usage:
  record.js --outcome <${OUTCOMES.join("|")}> --pause <path to stoic-pending-pause.json>
            [--data <path to pause-answer.json>, required for ${BANK_OUTCOMES.join(" and ")}]`;

const OPTIONS = {
  outcome: { type: "string" },
  pause: { type: "string" },
  data: { type: "string" },
};

/** Truthfully describes a run that touched nothing. */
const NOTHING_WRITTEN = Object.freeze({
  bank: "unchanged",
  state: "unchanged",
});

const REJECTED = 2;
const FAILED = 1;

/**
 * A failure worth reporting rather than crashing on: it carries the stable
 * error code, the exit status, and — never a guess — what the run had already
 * written by the time it failed.
 */
class RecordError extends Error {
  constructor(code, message, exitCode, changed = NOTHING_WRITTEN) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.changed = changed;
  }
}

const reject = (code, message) => new RecordError(code, message, REJECTED);

/**
 * Decode the request from flags. Shape and vocabulary only — every rejection
 * here leaves the pending pause exactly where it was, so the user can answer
 * again rather than lose the turn.
 */
function readRequest(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    throw reject("usage", error.message);
  }

  if (!OUTCOMES.includes(values.outcome)) {
    throw reject(
      "usage",
      `Unknown outcome ${JSON.stringify(values.outcome ?? null)}: expected one of ${OUTCOMES.join(", ")}.`,
    );
  }
  if (!isNonEmptyString(values.pause)) {
    throw reject("usage", "Every outcome needs --pause: the pending pause.");
  }

  const needsData = BANK_OUTCOMES.includes(values.outcome);
  if (needsData && !isNonEmptyString(values.data)) {
    throw reject(
      "usage",
      `The ${values.outcome} outcome needs --data: the answer file holding the reflection.`,
    );
  }
  if (!needsData && values.data !== undefined) {
    throw reject(
      "usage",
      `The ${values.outcome} outcome records no reflection, so --data would be read by nothing.`,
    );
  }

  return {
    outcome: values.outcome,
    pausePath: values.pause,
    data: values.data,
  };
}

/**
 * Read the pending pause. Only `cwd` is load-bearing — it names the project
 * whose bank and state this recording belongs to — so everything else is
 * tolerated, including the missing classification of a manual reflection.
 */
function readPause(pausePath) {
  const document = readJsonFile(pausePath);
  if (document.status !== "ok" || !isPlainObject(document.value)) {
    throw reject(
      "invalid_pause",
      "The pending pause could not be read as a pause document. It may already have been recorded.",
    );
  }
  if (!isNonEmptyString(document.value.cwd)) {
    throw reject(
      "invalid_pause",
      "The pending pause names no project directory, so there is nowhere to record it.",
    );
  }
  return document.value;
}

/**
 * Read the reflection the skill wrote. Coerced leniently, as everywhere else
 * in the engine: a field the skill got wrong degrades to empty rather than
 * costing the developer the whole entry. A file that is not a document at all
 * is a different matter and is refused before anything is written.
 */
function readAnswer(dataPath) {
  const document = readJsonFile(dataPath);
  if (document.status !== "ok" || !isPlainObject(document.value)) {
    throw reject(
      "invalid_data",
      "The answer file could not be read as a reflection document. Nothing was recorded.",
    );
  }
  const value = document.value;
  return {
    questions: Array.isArray(value.questions)
      ? value.questions.filter(isNonEmptyString)
      : [],
    answer: typeof value.answer === "string" ? value.answer : "",
    correction: typeof value.correction === "string" ? value.correction : "",
    followup_prompt: isNonEmptyString(value.followup_prompt)
      ? value.followup_prompt
      : undefined,
  };
}

/**
 * The turn's fingerprint: the files it touched, unique and in first-seen order.
 * An empty list is a real answer — a prompt-only turn — and stays empty rather
 * than becoming `null`, which the mute reader would widen into a whole category.
 */
function touchedFiles(pause) {
  const edits = isPlainObject(pause.group) && pause.group.edits;
  if (!Array.isArray(edits)) {
    return [];
  }
  const seen = [];
  for (const item of edits) {
    if (isPlainObject(item) && isNonEmptyString(item.file)) {
      if (!seen.includes(item.file)) {
        seen.push(item.file);
      }
    }
  }
  return seen;
}

/** The resolved top-level category, or undefined for a manual reflection. */
function pauseCategory(pause) {
  const classification = isPlainObject(pause.classification)
    ? pause.classification
    : {};
  return isNonEmptyString(classification.category)
    ? classification.category
    : undefined;
}

/** A counter as a counter, whatever a hand-edited document put there. */
const counterAt = (table, key) =>
  Number.isFinite(table[key]) ? table[key] : 0;

/** The one notice this CLI owns: a category has just gone quiet, and why. */
const categoryMuteNotice = (category, durationMs) =>
  `Three skips in a row — ${category} is quiet for the next ${Math.round(durationMs / MS_PER_HOUR)} hours. Run /stoic-stack:setup to change this.`;

/**
 * Apply an outcome to personal state, in place.
 *
 * Everything here keys on a category, which is why a categoryless (manual)
 * reflection changes nothing: it has no repeat to suppress and no streak to
 * belong to. Expired mutes are left alone — pruning is the Stop hook's job, and
 * a recorder that also pruned would make two writers of the same list.
 *
 * @returns {string[]} Notices the user should see, usually none.
 */
function applyOutcome(state, { outcome, category, files, knobs, now }) {
  const notices = [];
  if (category === undefined) {
    return notices;
  }
  if (!Array.isArray(state.mutes)) {
    state.mutes = [];
  }
  if (!isPlainObject(state.skip_streak)) {
    state.skip_streak = {};
  }
  if (!isPlainObject(state.skip_totals)) {
    state.skip_totals = {};
  }

  // Every outcome silences this exact turn for the short window: the developer
  // has now answered it, in one way or another.
  state.mutes.push({
    category,
    files,
    expires_at: now + knobs.mute_window_ms,
  });

  if (BANK_OUTCOMES.includes(outcome)) {
    // Answering restarts the streak, but only where one was already counted —
    // a category the user never skipped gains no counter from being answered.
    if (category in state.skip_streak) {
      state.skip_streak[category] = 0;
    }
    return notices;
  }
  if (outcome !== "skip") {
    // Defer means "later", not "not this topic", so it leaves history alone.
    return notices;
  }

  const streak = counterAt(state.skip_streak, category) + 1;
  state.skip_totals[category] = counterAt(state.skip_totals, category) + 1;

  if (streak < SKIPS_BEFORE_CATEGORY_MUTE) {
    state.skip_streak[category] = streak;
    return notices;
  }

  // Three refusals in a row is an answer of its own: stop asking about this
  // area for a while, and say so rather than going quiet unexplained.
  state.mutes.push({
    category,
    files: null,
    expires_at: now + knobs.category_mute_ms,
  });
  state.skip_streak[category] = 0;
  notices.push(categoryMuteNotice(category, knobs.category_mute_ms));
  return notices;
}

/**
 * Consume a document the recording has now superseded. Idempotent: an already
 * missing file is the outcome we wanted. Any other failure is a notice, not a
 * failure — the recording itself already succeeded.
 */
function consume(filePath, notices, what) {
  try {
    fs.rmSync(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      process.stderr.write(`Could not delete ${filePath}: ${error.message}\n`);
      notices.push(
        `The ${what} could not be deleted and may be recorded again.`,
      );
    }
  }
}

function main(argv) {
  const request = readRequest(argv);

  // Validation first, in full: after this point the request is known good, so
  // any failure below is a persistence failure with something already on disk.
  const pause = readPause(request.pausePath);
  const writesBank = BANK_OUTCOMES.includes(request.outcome);
  const answer = writesBank ? readAnswer(request.data) : null;

  const projectDir = pause.cwd;
  const category = pauseCategory(pause);
  const files = touchedFiles(pause);
  const now = Date.now();

  // The reflection goes first. It is the only thing here a developer cannot
  // reproduce, so it must not be lost to a state write that fails after it.
  let bankState = "unchanged";
  if (writesBank) {
    try {
      writeDecisionEntry(
        projectDir,
        {
          outcome: request.outcome,
          category,
          subcategory: isPlainObject(pause.classification)
            ? pause.classification.subcategory
            : undefined,
          files,
          trigger: pause.trigger,
          questions: answer.questions,
          answer: answer.answer,
          correction: answer.correction,
          followup_prompt: answer.followup_prompt,
        },
        { now: new Date(now) },
      );
    } catch (error) {
      process.stderr.write(
        `Cannot write the decision bank: ${error.message}\n`,
      );
      throw new RecordError(
        "bank_write_failed",
        "The reflection could not be recorded, so nothing else was changed either. The pause is still waiting.",
        FAILED,
      );
    }
    bankState = "written";
  }

  const state = loadState(projectDir);
  const knobs = resolveKnobs(loadConfig(projectDir), state);
  const notices = applyOutcome(state, {
    outcome: request.outcome,
    category,
    files,
    knobs,
    now,
  });

  try {
    saveState(projectDir, state);
  } catch (error) {
    process.stderr.write(
      `Cannot write personal engine state: ${error.message}\n`,
    );
    throw new RecordError(
      "state_save_failed",
      "The outcome could not be saved to personal state.",
      FAILED,
      { bank: bankState, state: "unchanged" },
    );
  }

  // The deleted pause IS the completion marker, so it goes last: a crash before
  // this point leaves a pause the user can answer again, never a silent no-op.
  if (writesBank) {
    consume(request.data, notices, "answer file");
  }
  consume(request.pausePath, notices, "pending pause");

  return { ok: true, outcome: request.outcome, notices };
}

function run(argv) {
  try {
    return { result: main(argv), code: 0 };
  } catch (error) {
    if (!(error instanceof RecordError)) {
      // Nothing should reach here, but the contract is "stdout is always one
      // JSON result". A caller parsing a stack trace is a worse outcome than a
      // caller reading an honest `unexpected`.
      process.stderr.write(`${error?.stack ?? error}\n`);
      return {
        result: {
          ok: false,
          error: {
            code: "unexpected",
            message: String(error?.message ?? error),
          },
          changed: NOTHING_WRITTEN,
        },
        code: FAILED,
      };
    }
    if (error.code === "usage") {
      process.stderr.write(`${USAGE}\n`);
    }
    return {
      result: {
        ok: false,
        error: { code: error.code, message: error.message },
        changed: error.changed,
      },
      code: error.exitCode,
    };
  }
}

const { result, code } = run(process.argv.slice(2));
process.stdout.write(`${JSON.stringify(result)}\n`);
// Set the status rather than calling process.exit, which can truncate a pending
// stdout write when stdout is a pipe — exactly how a caller runs this.
process.exitCode = code;
