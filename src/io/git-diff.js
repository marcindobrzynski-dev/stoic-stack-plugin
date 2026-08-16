// The working-tree reader — what the developer has changed since the last
// commit, measured rather than observed.
//
// The engine's own picture of a turn comes from session events; a manual
// reflection has no session behind it, so the material has to be measured from
// the repository instead. `git diff HEAD` is that measurement: staged and
// unstaged changes together, which is exactly the work still reversible — and
// a reflection is only worth holding over work that can still change. Committed
// work is deliberately outside the frame, and a clean tree gets no fallback to
// the previous commit: that decision is closed, and offering its diff would
// blur "nothing changed" into "changed, and already settled".
//
// Failure is emptiness, never an error. Not a repository, no commits yet, git
// missing from PATH, a hung command, output this parser cannot read — every one
// of them produces the same result a clean tree does. A reflection is worth
// more than a diagnostic, so nothing here throws.
//
// Testability is programmatic, as everywhere in `src/io`: `options.spawn`
// substitutes the git invocation and defaults to the real `spawnSync`. No
// environment variable can reach it.
import { spawnSync } from "node:child_process";
import path from "node:path";

import { isNonEmptyString, isPlainObject } from "../core/predicates.js";

/**
 * Wall-clock budget for the diff. Twice what the decision bank allows its
 * branch lookup: `rev-parse` answers from a ref file, while numstat with rename
 * detection has to walk and compare a whole tree, which on a large repository
 * genuinely takes seconds. Still bounded — a hung git must not hold a pause.
 */
export const GIT_DIFF_TIMEOUT_MS = 10_000;

/**
 * Output ceiling. `spawnSync` defaults to 1 MiB and reports an overflow as an
 * ENOBUFS error, which here would silently read as "nothing changed" on exactly
 * the largest turns. Eight MiB is far past any believable numstat, and an
 * overflow beyond it still degrades to emptiness rather than throwing.
 */
export const GIT_DIFF_MAX_BUFFER = 8 * 1024 * 1024;

/**
 * The one question this module asks, frozen so no caller can reshape it:
 *
 * - `--no-pager` — a misconfigured `core.pager` or `GIT_PAGER` can wrap even a
 *   machine format; nothing may sit between git and this process.
 * - `--numstat` — added, removed and path per file, in decimal, with `-`/`-`
 *   standing in for a binary file.
 * - `-z` — removes C-style path quoting entirely, so unusual and non-ASCII
 *   paths arrive as raw bytes, and gives the NUL grammar whose extra leading
 *   terminator disambiguates a rename record without lookahead.
 * - `--find-renames` — pins rename detection on regardless of the developer's
 *   `diff.renames`, so one repository's config cannot turn a refactor into
 *   delete-and-add pairs while another counts it once.
 * - `HEAD` then `--` — the trailing separator keeps `HEAD` unambiguously a
 *   revision even in a tree that happens to contain a file named `HEAD`.
 */
export const GIT_DIFF_ARGS = Object.freeze([
  "--no-pager",
  "diff",
  "--numstat",
  "-z",
  "--find-renames",
  "HEAD",
  "--",
]);

/** One numstat record: two counts, then either a path or the rename marker. */
const RECORD_PATTERN = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/;

/** A count as a number: `-` is git's binary marker, worth zero lines. */
const countOf = (token) => (token === "-" ? 0 : Number(token));

/**
 * The reading of a tree with nothing to say — a clean tree, and equally every
 * way this module can fail. Fresh each call, because the caller owns what it
 * gets back and routinely embeds it in a document it then edits.
 *
 * @returns {{edits: object[], edit_count: number, lines_added: number,
 *   lines_removed: number}} The zeroed reading.
 */
export function emptyDiff() {
  return { edits: [], edit_count: 0, lines_added: 0, lines_removed: 0 };
}

/**
 * Read git's NUL-terminated numstat output into the four fields the pause
 * cascade consumes.
 *
 * The grammar, exactly as `-z` defines it: every record is `added TAB removed
 * TAB path`, terminated by NUL. When the path is empty the record is a rename
 * or copy, and the next two NUL-terminated chunks are the old and the new path.
 * Such a record becomes ONE edit at the NEW path — that is the file the
 * developer now has open and the one a fingerprint should key on; recording the
 * source as well would count a single move twice.
 *
 * Partial readings are refused. A record this grammar cannot explain discards
 * the whole reading, because a number assembled from half of git's answer would
 * reach the decision bank as a measurement and read as the truth.
 *
 * @param {unknown} text - Raw stdout of the numstat command.
 * @returns {{edits: object[], edit_count: number, lines_added: number,
 *   lines_removed: number}} The reading, or {@link emptyDiff} when the text is
 *   empty or unreadable. Never throws.
 */
export function parseNumstat(text) {
  if (typeof text !== "string" || text.length === 0) {
    return emptyDiff();
  }

  const tokens = text.split("\0");
  const edits = [];
  let index = 0;

  while (index < tokens.length) {
    const record = tokens[index];
    index += 1;

    // The final NUL leaves an empty tail; an empty token anywhere else means
    // this is not the output the grammar describes.
    if (record === "") {
      if (index === tokens.length) {
        break;
      }
      return emptyDiff();
    }

    const fields = RECORD_PATTERN.exec(record);
    if (!fields) {
      return emptyDiff();
    }

    let file = fields[3];
    if (file === "") {
      const source = tokens[index];
      const destination = tokens[index + 1];
      index += 2;
      if (!isNonEmptyString(source) || !isNonEmptyString(destination)) {
        return emptyDiff();
      }
      file = destination;
    }

    edits.push({
      file,
      lines_added: countOf(fields[1]),
      lines_removed: countOf(fields[2]),
    });
  }

  return {
    edits,
    edit_count: edits.length,
    lines_added: edits.reduce((total, edit) => total + edit.lines_added, 0),
    lines_removed: edits.reduce((total, edit) => total + edit.lines_removed, 0),
  };
}

/**
 * Measure the project's working tree against its last commit.
 *
 * Each edit carries `file`, `lines_added` and `lines_removed` — the same keys
 * turn-group assembly uses, so the recorder's file fingerprint reads a measured
 * pause exactly as it reads an observed one. The event-shaped fields a turn
 * group also carries — `ts`, `delegated`, `agent_type` — are deliberately
 * absent here: there is no session event behind a git measurement, and absent
 * says "does not apply" where a default would claim a reading nobody took.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {object} [options] - Call options.
 * @param {Function} [options.spawn] - Seam with the `spawnSync` signature;
 *   defaults to the real one.
 * @returns {{edits: object[], edit_count: number, lines_added: number,
 *   lines_removed: number}} The reading, or {@link emptyDiff} for a clean tree
 *   and for every degradation. Never throws.
 */
export function readWorkingTreeDiff(projectDir, options = {}) {
  try {
    const settings = isPlainObject(options) ? options : {};
    const spawn =
      typeof settings.spawn === "function" ? settings.spawn : spawnSync;

    const result = spawn("git", GIT_DIFF_ARGS, {
      cwd: path.resolve(projectDir),
      encoding: "utf8",
      timeout: GIT_DIFF_TIMEOUT_MS,
      maxBuffer: GIT_DIFF_MAX_BUFFER,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (!isPlainObject(result) || result.error || result.status !== 0) {
      return emptyDiff();
    }
    if (typeof result.stdout !== "string") {
      return emptyDiff();
    }
    return parseNumstat(result.stdout);
  } catch {
    return emptyDiff();
  }
}
