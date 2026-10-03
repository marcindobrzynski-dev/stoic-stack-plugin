// The experiment's two logs, beside the personal engine state and never in
// the repository:
//
// - `jev-experiment.jsonl`: one summary line per classification, written by
//   `runner.js`, the only place that knows whether the fallback ran;
// - `jev-experiment/<ts>.json`: the full Jev input and raw response, written
//   by `run.js`, the only place that holds them.
//
// Writing a log never throws: observation must not break the observed turn.
// Neither record ever carries the API key.
//
// Experiment only (`feature/jev-classifier-experiment`, never merged).
import fs from "node:fs";
import path from "node:path";

import { personalStateDir } from "../../src/io/paths.js";

/** The summary log's file name. */
const SUMMARY_FILE_NAME = "jev-experiment.jsonl";

/** The directory holding one full-input file per Jev call. */
const INPUT_DIR_NAME = "jev-experiment";

/**
 * A timestamp that can name a file on every platform: Windows forbids `:`.
 *
 * @param {Date} date - The moment.
 * @returns {string} For example `2026-10-03T08-15-30-123Z`.
 */
export function fileTimestamp(date) {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Append one summary line. Never throws.
 *
 * @param {string} projectDir - The project directory.
 * @param {object} line - The summary record.
 */
export function appendSummaryLine(projectDir, line) {
  try {
    const directory = personalStateDir(projectDir);

    fs.mkdirSync(directory, { recursive: true });
    fs.appendFileSync(
      path.join(directory, SUMMARY_FILE_NAME),
      `${JSON.stringify(line)}\n`,
      "utf8",
    );
  } catch {
    // A lost line costs the experiment one data point, nothing more.
  }
}

/**
 * Write one full-input file. Never throws.
 *
 * @param {string} projectDir - The project directory.
 * @param {Date} date - The moment that names the file.
 * @param {object} record - `{ state, questions, response }`.
 * @returns {string|null} The file name, or null when nothing was written.
 */
export function writeInputFile(projectDir, date, record) {
  try {
    const directory = path.join(personalStateDir(projectDir), INPUT_DIR_NAME);
    const fileName = `${fileTimestamp(date)}.json`;

    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, fileName),
      `${JSON.stringify(record, null, 2)}\n`,
      "utf8",
    );

    return fileName;
  } catch {
    return null;
  }
}
