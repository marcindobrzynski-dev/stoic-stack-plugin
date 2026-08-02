// Personal engine state — the per-project score, mutes, and skip history that
// stay OUTSIDE the repository, under the user's Claude home.
//
// This module owns one question: what does it mean to bring state into
// existence without destroying what a developer already accumulated?
//
// Initialization is a foreground operation, and its failure behavior is the
// deliberate opposite of config's. A missing config resolves to defaults and a
// corrupt one is regenerated, because config is reproducible. State is not:
// it is the only record of a developer's history with the plugin, so a
// document this module cannot understand is reported, never replaced.
//
// The runtime load/save pair below answers the opposite question, for the
// opposite caller. `loadState` and `saveState` run inside the Stop hook, where
// there is no foreground to report to: an unreadable document must resolve to
// neutral state so the turn still gets scored. Reading is still never a
// repair — the unreadable document stays on disk byte-for-byte, and only the
// next successful save replaces it.
//
// Contract: thoughts/shared/.project/architecture/payloads.md §`state.json`.
import { readJsonFile, writeJsonFileAtomic } from "./json-file.js";
import { personalStatePath } from "./paths.js";
import { isPlainObject } from "../core/predicates.js";

/**
 * Neutral engine state: nothing has happened yet.
 *
 * `preset` is deliberately ABSENT rather than `"balanced"`. It is an optional
 * personal override, and its absence is what lets a committed team preset
 * reach a teammate — effective preset resolves as
 * `state.preset ?? config.preset ?? "balanced"`, so materializing a default
 * here would pin every user to the built-in and make the team preset
 * unreachable. The personal layer stays empty until the user chooses.
 *
 * @returns {object} A fresh, fully mutable state document.
 */
export function defaultState() {
  return {
    score: 0,
    last_update: 0, // ms epoch; zero means "never evaluated"
    mutes: [],
    skip_streak: {},
    skip_totals: {},
  };
}

/**
 * Bring personal state into existence without ever destroying history.
 *
 * Idempotent by construction: existing state is left BYTE-FOR-BYTE untouched
 * rather than re-normalized and rewritten. Not rewriting is the strongest
 * guarantee available that a second setup run cannot reset a score, expire a
 * mute early, or drop a personal preset override — there is no merge step in
 * which such a value could be lost.
 *
 * A document that exists but cannot be read or understood is NOT overwritten.
 * State is unrecoverable personal history, so a corrupt document is reported
 * to the foreground for the user to decide about; silently replacing it would
 * destroy exactly what this module exists to protect. (Corrupt *config*, by
 * contrast, setup regenerates freely — config is reproducible, state is not.)
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {string} [homeDir] - Home directory override for tests.
 * @returns {{status: "created"|"preserved"}
 *   | {status: "failed", path: string, error: Error}} What the call did, or an
 *   actionable failure the setup CLI can report. Never throws.
 */
export function initializeState(projectDir, homeDir) {
  const statePath = personalStatePath(projectDir, homeDir);
  const existing = readJsonFile(statePath);

  if (existing.status === "invalid") {
    return { status: "failed", path: statePath, error: existing.error };
  }
  if (existing.status === "ok") {
    // Parseable but not a document — an array or bare literal. Unreadable is
    // unreadable; refuse it rather than clobber whatever the user has there.
    if (!isPlainObject(existing.value)) {
      return {
        status: "failed",
        path: statePath,
        error: new Error("state document is not a JSON object"),
      };
    }
    return { status: "preserved" };
  }

  try {
    writeJsonFileAtomic(statePath, defaultState());
  } catch (error) {
    return { status: "failed", path: statePath, error };
  }
  return { status: "created" };
}

/**
 * Read personal state for scoring, fail-silently.
 *
 * A missing, unreadable, or non-document state resolves to `defaultState()`
 * rather than throwing, because this runs at the turn boundary inside a hook
 * that must never break the user's session. Reading creates nothing: a project
 * whose first Stop crashes still has no state document afterwards.
 *
 * A document that IS readable is merged over the defaults rather than returned
 * raw, so a partial document — one written by an older version, or hand-edited
 * — still carries every field the engine reads, while any field the scorer
 * does not own (including an optional personal `preset`) passes through
 * untouched for the save that follows.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {string} [homeDir] - Home directory override for tests.
 * @returns {object} A complete, mutable state document. Never throws.
 */
export function loadState(projectDir, homeDir) {
  const result = readJsonFile(personalStatePath(projectDir, homeDir));
  if (result.status !== "ok" || !isPlainObject(result.value)) {
    return defaultState();
  }
  return { ...defaultState(), ...result.value };
}

/**
 * Persist personal state atomically — the single writer of the score.
 *
 * The value is written EXACTLY as given, with no normalization step: the Stop
 * hook loads, moves `score` and `last_update`, and saves the same object back,
 * so mutes, skip history, and a personal preset survive by construction rather
 * than by a merge that could drop what a newer writer added.
 *
 * Like `saveConfig`, this throws rather than swallowing: fail-silence is the
 * HOOK's decision, made once around the whole turn boundary, and a save that
 * lied about succeeding would leave the next turn scoring from a stale score.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {object} state - State document to persist, verbatim.
 * @param {string} [homeDir] - Home directory override for tests.
 * @throws {Error} When the filesystem write or rename fails.
 */
export function saveState(projectDir, state, homeDir) {
  writeJsonFileAtomic(personalStatePath(projectDir, homeDir), state);
}
