#!/usr/bin/env node
// The setup CLI — the one programmatic seam between the guided setup skill and
// the filesystem.
//
// The skill owns the conversation; this CLI owns every consequence of it. That
// split is the point. When a prompt serializes `config.json` itself, the file
// format lives in English, its defaults drift from the code that reads them,
// and "preserve the user's hand-tuned settings" becomes a sentence a model can
// skip. Here the skill may pass nothing but validated canonical identifiers, so
// no wording it chooses can change what a valid document looks like.
//
// Two operations:
//
//   node src/cli/setup.js --current
//   node src/cli/setup.js --apply --preset <name> --categories <csv> \
//                         --pause-mode <mode> --followup-draft <true|false>
//
// `--current` writes nothing, which is what makes it safe to call merely to
// populate the questions. `--apply` takes a COMPLETE set of choices: setup is
// not a patch protocol, and demanding all of them keeps "the user answered
// this" distinct from "the user left it alone" without the CLI having to guess.
//
// This file knows no field names. Flags, the completeness check, and decoding
// are all derived from `GUIDED_CHOICES` in the configuration model, so setup's
// surface cannot drift from the document it writes.
//
// stdout is always exactly one JSON result, success or failure, so the caller
// parses one stream and branches on `ok`. Human-readable diagnostics — the only
// place a filesystem path may appear — go to stderr and are not part of the
// contract.
//
// Both operations work on the Project Root resolved from the directory the CLI
// starts in, never on that directory itself: setup run from a subfolder must
// configure the same project the hooks will observe.
//
// Exit status: 0 success, 2 the request was rejected and nothing was written,
// 1 the request was fine but no project root was found or persistence failed.
//
// Contract: thoughts/shared/.project/architecture/payloads.md §`setup.js` CLI.
import { parseArgs } from "node:util";
import {
  CATEGORIES,
  GUIDED_CHOICES,
  PAUSE_MODES,
  PRESET_NAMES,
  loadConfig,
  mergeGuidedChoices,
  saveConfig,
} from "../io/config/config.js";
import { resolveProjectRoot } from "../io/project-root.js";
import { initializeState } from "../io/state.js";
import { writeSharedTraceLine } from "../io/trace.js";

/** How this CLI labels the one trace line it may write. */
const TRACE_NAME = "setup";

/** Config speaks snake_case fields; a CLI speaks kebab flags. One transform. */
const flagOf = (field) => field.replaceAll("_", "-");

const GUIDED_FIELDS = Object.keys(GUIDED_CHOICES);

const USAGE = `Usage:
  setup.js --current
  setup.js --apply --preset <${PRESET_NAMES.join("|")}>
                   --categories <comma-separated ${CATEGORIES.join("|")}, or "" for none>
                   --pause-mode <${PAUSE_MODES.join("|")}>
                   --followup-draft <true|false>`;

const OPTIONS = {
  current: { type: "boolean", default: false },
  apply: { type: "boolean", default: false },
  // Every guided answer arrives as text and is decoded by its own table row.
  ...Object.fromEntries(
    GUIDED_FIELDS.map((field) => [flagOf(field), { type: "string" }]),
  ),
};

/** Truthfully describes a run that touched nothing. */
const NOTHING_WRITTEN = Object.freeze({
  state: "unchanged",
  config: "unchanged",
});

const REJECTED = 2;
const FAILED = 1;

/**
 * A failure worth reporting rather than crashing on: it carries the stable
 * error code, the exit status, and — never a guess — what the run had already
 * written by the time it failed.
 */
class SetupError extends Error {
  constructor(code, message, exitCode, changed = NOTHING_WRITTEN) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
    this.changed = changed;
  }
}

const reject = (code, message) => new SetupError(code, message, REJECTED);

/**
 * Project the guided subset out of a full configuration. This is setup's entire
 * public vocabulary: the other fields are real, but they are the manual layer,
 * and a guided flow that reported them would invite a guided flow that
 * overwrites them.
 */
function guidedChoicesOf(config) {
  return Object.fromEntries(
    GUIDED_FIELDS.map((field) => [field, config[field]]),
  );
}

/**
 * Decode a complete set of guided answers from flags. Shape only — which
 * values are supported is the configuration model's judgment, so no enum is
 * ever re-listed here.
 */
function readChoices(values) {
  const missing = GUIDED_FIELDS.filter(
    (field) => values[flagOf(field)] === undefined,
  );
  if (missing.length > 0) {
    throw reject(
      "invalid_choice",
      `Incomplete setup request: --apply needs ${missing.map((field) => `--${flagOf(field)}`).join(", ")}.`,
    );
  }
  try {
    return Object.fromEntries(
      GUIDED_FIELDS.map((field) => [
        field,
        GUIDED_CHOICES[field].read(values[flagOf(field)], field),
      ]),
    );
  } catch (error) {
    throw reject("invalid_choice", error.message);
  }
}

/** Inspect the choices in effect today, writing nothing. */
function currentOperation(projectDir) {
  // The TEAM preset, deliberately — not `effectivePreset`. Guided setup writes
  // the committed team value, so offering a personal override as the current
  // answer would make an unchanged re-run silently publish that private choice
  // to the whole team.
  const config = loadConfig(projectDir);
  return {
    ok: true,
    operation: "current",
    choices: guidedChoicesOf(config),
    enabled: config.enabled,
  };
}

/** Validate a complete set of choices, then persist it. */
function applyOperation(values, projectDir) {
  const choices = readChoices(values);

  let merged;
  try {
    merged = mergeGuidedChoices(loadConfig(projectDir), choices);
  } catch (error) {
    throw reject("invalid_choice", error.message);
  }

  // State before config. State is the one document setup can meet that it must
  // never repair — it is the user's only history — so finding it unreadable has
  // to happen while the project is still untouched. Reversing these two would
  // leave a project reconfigured by a run that reports failure.
  const state = initializeState(projectDir);
  if (state.status === "failed") {
    process.stderr.write(
      `Cannot read personal engine state at ${state.path}: ${state.error.message}\n`,
    );
    throw new SetupError(
      "state_init_failed",
      "Personal engine state exists but could not be read. Setup changed nothing. Repair or move that file, then run setup again.",
      FAILED,
    );
  }

  try {
    saveConfig(projectDir, merged);
  } catch (error) {
    process.stderr.write(
      `Cannot write project configuration: ${error.message}\n`,
    );
    // The state write already happened and is not rolled back. Saying so is the
    // honest move: these are two atomic writes, not one transaction, and
    // claiming otherwise would be a promise this CLI cannot keep. Re-running is
    // safe — initialization preserves whatever state now exists.
    throw new SetupError(
      "config_write_failed",
      "Project configuration could not be written.",
      FAILED,
      { state: state.status, config: "unchanged" },
    );
  }

  return {
    ok: true,
    operation: "apply",
    choices: guidedChoicesOf(merged),
    enabled: merged.enabled,
    state: state.status,
    config: "written",
  };
}

function main(argv) {
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

  if (values.current === values.apply) {
    throw reject(
      "usage",
      "Choose exactly one operation: --current or --apply.",
    );
  }

  // Resolved once, so `--current` reads the very document `--apply` would
  // write.
  const projectDir = resolveProjectRoot(process.cwd());
  if (projectDir === null) {
    writeSharedTraceLine(TRACE_NAME, { outcome: "no_project_root" });
    process.stderr.write(
      "Cannot resolve a project root from the current directory.\n",
    );
    throw new SetupError(
      "no_project_root",
      "No project root could be resolved. Setup changed nothing.",
      FAILED,
    );
  }
  return values.current
    ? currentOperation(projectDir)
    : applyOperation(values, projectDir);
}

function run(argv) {
  try {
    return { result: main(argv), code: 0 };
  } catch (error) {
    if (!(error instanceof SetupError)) {
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
          ...NOTHING_WRITTEN,
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
        ...error.changed,
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
