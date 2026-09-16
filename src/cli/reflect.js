#!/usr/bin/env node
// The manual reflection's writer — the developer's own way to open a pause, and
// the only producer of `stoic-manual-pause.json`.
//
// The Stop hook writes the automatic pause; this CLI writes the one a developer
// asked for. The conversation that follows is the same in both cases, which is
// exactly why the request is served by code rather than by a prompt: the skill
// may only run this script, and nothing it says can change what the document
// says the pause is about.
//
//   node src/cli/reflect.js [--project <directory>]
//
// The material comes from `git diff HEAD`, measured, not observed. A manual
// pause has no session behind it — no prompts, no tool events, no turn to
// summarize — so the only honest account of what is in play is the work still
// uncommitted, and it is counted by git rather than described by a model. A
// model asked "what changed?" would answer from whatever it happened to
// remember of the conversation; git answers from the tree. Every way that
// measurement can fail — no repository, no commits, no git at all — reads as a
// clean tree, because a reflection is worth more than a diagnostic.
//
// The document is a SECOND file, never the pending one. That path is keyed on
// the project rather than the session, so writing a manual pause there would
// silently replace an automatic pause the developer had interrupted; two files
// remove the ambiguity, and every consumer is handed an explicit path anyway.
//
// stdout is always exactly one JSON result, success or failure, so the caller
// parses one stream and branches on `ok` — and on `material`, which is what
// tells the skill whether there is anything to reflect on. Human-readable
// diagnostics go to stderr, the only place a filesystem path may appear. One of
// those lines is contractual: `manual pause: <absolute path>` names the document
// just written, and the reflection skill passes that path to `record.js`.
//
// Exit status: 0 success, 2 the request was rejected and nothing was written,
// 1 the request was fine but no project root could be resolved or the document
// could not be persisted.
//
// What this CLI must not do: it writes one document and nothing else. No score,
// no mutes, no decision bank, no engine state — state is read, never saved. The
// reward for a reflection belongs to the recorder, on completion; a writer that
// rewarded would be paying for the request rather than for the thinking, and
// "invoke, then press Escape" would become the cheapest way in the plugin to a
// lower score. It also ignores the `enabled` flag, which gates the engine's
// initiative — a developer asking for a reflection is not using it.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// (§ `stoic-pending-pause.json`, whose schema this document shares).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { emptyGroup } from "../core/group.js";
import { loadConfig } from "../io/config/config.js";
import { resolveManualReflection } from "../io/config/manual-reflection.js";
import { readWorkingTreeDiff } from "../io/git-diff.js";
import { writeJsonFileAtomic } from "../io/json-file.js";
import { manualPausePath } from "../io/paths.js";
import { resolveProjectRoot } from "../io/project-root.js";
import { loadState } from "../io/state.js";
import { writeSharedTraceLine } from "../io/trace.js";

/** The trigger this CLI writes, and the one the recorder gives relief for. */
const MANUAL_TRIGGER = "manual";

/** How this CLI labels the one trace line it may write. */
const TRACE_NAME = "reflect";

const USAGE = `Usage:
  reflect.js [--project <directory>]
  Without --project the project root is resolved from the working directory.`;

const OPTIONS = {
  project: { type: "string" },
};

/**
 * Truthfully describes every run that failed, without a ledger to keep it
 * honest. There is exactly one write here and it is the last thing that
 * happens, so no failure can be reported while the document is on disk.
 */
const NOTHING_WRITTEN = Object.freeze({ pause: "unchanged" });
const REJECTED = 2;
const FAILED = 1;

/**
 * Where the plugin is installed, resolved from this file's own location — two
 * directories above `src/cli/`. The document carries it so the skill can find
 * `record.js` whatever project the session is in, and no environment variable is
 * involved: a marketplace install can sit anywhere, but it always sits at the
 * same distance from this file. Derived exactly as the Stop hook derives it, so
 * the two writers of a pause cannot disagree about where the plugin is.
 */
const PLUGIN_ROOT = path.resolve(
  fileURLToPath(new URL("../..", import.meta.url)),
);

/**
 * The command the reflection skill shells to once the developer has answered.
 * The path is quoted because the skill runs this string verbatim and an install
 * can sit under a path with spaces.
 */
const RECORD_CMD = `node "${path.join(PLUGIN_ROOT, "src", "cli", "record.js")}"`;

/**
 * A failure worth reporting rather than crashing on: it carries the stable
 * error code and the exit status.
 */
class ReflectError extends Error {
  constructor(code, message, exitCode) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

const reject = (code, message) => new ReflectError(code, message, REJECTED);

/**
 * Decode which project is being reflected on.
 *
 * By default the Project Root resolved from the working directory is the
 * answer, because a developer typing the skill is somewhere inside the project
 * they mean. `--project` exists for the caller that is not — a hook or a
 * wrapper started elsewhere — and bypasses the resolver: it is used literally,
 * checked rather than trusted, because a path that names no directory would
 * otherwise resolve to a plausible-looking slug and write a pause about a
 * project that does not exist.
 *
 * @param {string[]} argv Command-line arguments, less the node and script paths.
 * @returns {string} The absolute project directory.
 */
function readProjectDir(argv) {
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

  if (values.project === undefined) {
    const projectDir = resolveProjectRoot(process.cwd());
    if (projectDir === null) {
      writeSharedTraceLine(TRACE_NAME, { outcome: "no_project_root" });
      process.stderr.write(
        "Cannot resolve a project root from the current directory.\n",
      );
      throw new ReflectError(
        "no_project_root",
        "No project root could be resolved. Nothing was written.",
        FAILED,
      );
    }
    return projectDir;
  }
  if (values.project === "") {
    throw reject("invalid_project", "--project was given no directory.");
  }

  const projectDir = path.resolve(values.project);
  let stats;
  try {
    stats = fs.statSync(projectDir);
  } catch {
    throw reject("invalid_project", `No such directory: ${projectDir}`);
  }
  if (!stats.isDirectory()) {
    throw reject("invalid_project", `Not a directory: ${projectDir}`);
  }
  return projectDir;
}

/**
 * Assemble the manual pause — the whole hand-off to the reflection skill, in
 * one value, and deliberately self-contained for the same reason the automatic
 * one is: the skill and the recorder behind it are separate processes started
 * later, so nothing here may be derivable-on-arrival.
 *
 * `score`, `threshold` and `classification` are ABSENT rather than zeroed or
 * nulled. Absent reads as "does not apply", which is the truth — this pause was
 * asked for, not gated — where a zero would read as a measurement that happened
 * to come out at zero. The recorder tolerates every field but `cwd` missing.
 *
 * The rest of the turn group keeps its zero-signal defaults. Those fields are
 * scoring inputs and this path does not score, so leaving them alone is
 * accurate rather than lazy.
 *
 * @param {string} projectDir - The project being reflected on, absolute.
 * @param {object} diff - A reading from `readWorkingTreeDiff`.
 * @param {number} now - This invocation's clock reading, in ms epoch.
 * @returns {object} The document, per the shared pause schema.
 */
function manualPauseDocument(projectDir, diff, now) {
  // State is read for its personal preset and nothing else; the reward that
  // preset helps compute is the recorder's, applied on completion.
  const settings = resolveManualReflection(
    loadConfig(projectDir),
    loadState(projectDir),
  );

  return {
    created_at: now,
    trigger: MANUAL_TRIGGER,
    group: {
      ...emptyGroup(),
      edits: diff.edits,
      edit_count: diff.edit_count,
      lines_added: diff.lines_added,
      lines_removed: diff.lines_removed,
    },
    cwd: projectDir,
    plugin_root: PLUGIN_ROOT,
    record_cmd: RECORD_CMD,
    pause_mode: settings.pause_mode,
    followup_draft: settings.followup_draft,
    max_questions: settings.max_questions,
  };
}

function main(argv) {
  const projectDir = readProjectDir(argv);
  const diff = readWorkingTreeDiff(projectDir);
  const pauseFile = manualPausePath(projectDir);
  // Assembled outside the write's try, so the one failure that block reports
  // is the one it names: a document that would not land, never one that would
  // not build.
  const document = manualPauseDocument(projectDir, diff, Date.now());

  try {
    writeJsonFileAtomic(pauseFile, document);
  } catch (error) {
    process.stderr.write(
      `Cannot write the manual pause at ${pauseFile}: ${error.message}\n`,
    );
    throw new ReflectError(
      "pause_write_failed",
      "The manual pause could not be written, so there is nothing to reflect on yet.",
      FAILED,
    );
  }

  // The contractual stderr line: the skill reads the path from here, because
  // the result on stdout deliberately carries no filesystem paths.
  process.stderr.write(`manual pause: ${pauseFile}\n`);

  return {
    ok: true,
    // A clean tree, a directory that is no repository, and a git that never
    // answered are one and the same answer by design: there is nothing measured
    // to reflect on, and the skill branches on that rather than on why.
    material: diff.edits.length > 0 ? "found" : "clean",
    edit_count: diff.edit_count,
    lines_added: diff.lines_added,
    lines_removed: diff.lines_removed,
  };
}

function run(argv) {
  try {
    return { result: main(argv), code: 0 };
  } catch (error) {
    if (!(error instanceof ReflectError)) {
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
          changed: { ...NOTHING_WRITTEN },
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
        changed: { ...NOTHING_WRITTEN },
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
