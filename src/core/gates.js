// The fire path's decision core — three questions, no side effects.
//
// The Stop hook asks this module three things and acts on the answers itself:
// did this turn touch a watched path (`matchCriticalPaths`, the hard gate),
// has this decision already been settled recently (`isMuted`), and which
// stored mutes have outlived their window (`pruneMutes`). Everything the hook
// does with those answers — comparing the score against the effective
// threshold, applying the cooldown, running the classifier, writing state —
// stays out here. This module answers; the hook decides.
//
// It is Domain-layer pure: deterministic, no filesystem, no child processes,
// no environment, and no clock. `now` always arrives as an argument, exactly
// as `scoring.js` takes `elapsedMs`, so every expiry boundary is testable
// without waiting for one.
//
// Both inputs are untrusted. Touched files come from a hand-editable session
// log, keywords from a user's `critical_paths` setting, and mutes from a
// `state.json` a user may have opened in an editor. So every field is coerced
// and no input shape can make a gate throw. The safe degradation differs per
// question and is chosen deliberately in each: an unreadable gate input
// matches nothing (a corrupt setting must not pause every turn), while an
// unreadable mute suppresses nothing (a corrupt mute must not silence the
// plugin forever).
//
// Contract: thoughts/shared/.project/architecture/payloads.md § state.json
// (the frozen `{ category, files, expires_at }` mute shape, `files: null`
// meaning the whole category) and
// thoughts/shared/.project/architecture/configuration.md (`critical_paths`,
// substring patterns whose touch hard-triggers a pause).
import {
  isFiniteNumber,
  isNonEmptyString,
  isPlainObject,
} from "./predicates.js";

/**
 * A path or pattern in the one form comparisons happen in: lower-cased, with
 * every backslash read as a separator.
 *
 * Capture already stores project-relative forward-slash paths on every
 * platform, but this module is the last line before a user-visible pause
 * fires and its inputs are hand-editable, so it normalizes rather than
 * assumes. Keywords go through the same funnel: a Windows user who typed
 * `src\auth` into their settings means the same watch as `src/auth`.
 *
 * @param {unknown} value - A path or keyword of any shape.
 * @returns {string} The comparable form; `""` for anything unusable.
 */
const comparable = (value) =>
  isNonEmptyString(value) ? value.replaceAll("\\", "/").toLowerCase() : "";

/**
 * Which watched keywords did this turn's files touch?
 *
 * The hard gate: one match bypasses the score entirely. Matching is blunt
 * case-insensitive substring containment, not globbing or path-segment
 * matching — deliberately, because the developer writes these keywords by
 * hand during setup and must be able to predict what they will catch without
 * learning a pattern language. The cost is false positives (`service` catches
 * `userservice.ts`), which is the right way for this gate to fail: a
 * needless pause is recoverable, a missed one is the failure mode the plugin
 * exists to prevent.
 *
 * An empty keyword is skipped rather than compared. Every string contains the
 * empty string, so an unguarded search would turn a stray `""` in a settings
 * file into a pause on every single turn.
 *
 * The matched KEYWORDS are returned, not the matched files: the pause tells
 * the developer which of their own watches fired, and the files are already
 * in the turn group.
 *
 * @param {unknown} files - The turn's touched paths. Any shape is tolerated;
 *   unusable entries match nothing.
 * @param {unknown} keywords - The `critical_paths` setting. Any shape is
 *   tolerated; unusable entries match nothing.
 * @returns {string[]} The matching keywords as configured (original casing,
 *   configured order, each at most once). Never throws.
 */
export function matchCriticalPaths(files, keywords) {
  if (!Array.isArray(files) || !Array.isArray(keywords)) {
    return [];
  }
  const paths = files.map(comparable).filter((path) => path.length > 0);
  if (paths.length === 0) {
    return [];
  }
  const matched = [];
  for (const keyword of keywords) {
    const needle = comparable(keyword);
    if (needle.length === 0 || matched.includes(keyword)) {
      continue;
    }
    if (paths.some((path) => path.includes(needle))) {
      matched.push(keyword);
    }
  }
  return matched;
}

/**
 * Is a mute still within its window at this instant?
 *
 * The boundary is exclusive: a mute is active while `now` is strictly before
 * `expires_at`, and the expiry instant itself is already expired. An
 * unreadable expiry counts as expired — a mute that cannot say when it ends
 * must not silence a category forever — and so does an unreadable `now`,
 * because a clock the caller could not read is no reason to suppress a pause.
 *
 * @param {object} mute - A mute entry already known to be a plain object.
 * @param {unknown} now - The caller's current ms-epoch time.
 * @returns {boolean} True only for a readable, unexpired window.
 */
const isActive = (mute, now) =>
  isFiniteNumber(now) &&
  isFiniteNumber(mute.expires_at) &&
  now < mute.expires_at;

/**
 * Is this decision already settled — same category, same ground?
 *
 * A match needs the same category (compared exactly: categories are
 * identifiers from a fixed vocabulary, not user prose) and one of three
 * reasons to consider the ground the same:
 *
 * - A category-wide mute (`files: null`) — the developer has said "not this
 *   topic right now", so no file needs to match.
 * - File overlap — the fingerprint's whole point: the same decision over the
 *   same files is not re-litigated turn after turn.
 * - An EMPTY stored fingerprint — a pause can fire on a prompt-only turn with
 *   no edits, and the fingerprint recorded from it lists no files. Read
 *   literally it would overlap nothing and the identical pause would re-fire
 *   every turn, so an empty fingerprint is treated as category-scoped for its
 *   (short) window. Note the direction: it is the STORED mute being empty
 *   that widens it, never the incoming turn — a turn that touched nothing is
 *   not suppressed by a mute pinned to specific files.
 *
 * @param {unknown} mutes - The `mutes` array from personal state. Any shape
 *   is tolerated; unusable entries suppress nothing.
 * @param {unknown} category - The resolved top-level category of the pause
 *   candidate, from the classifier.
 * @param {unknown} files - The turn's touched paths; an unusable list reads
 *   as a turn that touched nothing.
 * @param {unknown} now - The caller's current ms-epoch time.
 * @returns {boolean} True only when an active mute covers this decision.
 *   Never throws.
 */
export function isMuted(mutes, category, files, now) {
  if (!Array.isArray(mutes) || !isNonEmptyString(category)) {
    return false;
  }
  const touched = Array.isArray(files)
    ? files.map(comparable).filter((path) => path.length > 0)
    : [];

  return mutes.some((mute) => {
    if (!isPlainObject(mute) || mute.category !== category) {
      return false;
    }
    if (!isActive(mute, now)) {
      return false;
    }
    // `== null` covers the frozen `null` spelling and a hand-edited omission
    // alike: both mean the whole category.
    if (mute.files == null || !Array.isArray(mute.files)) {
      return true;
    }
    // Only a literally empty stored list is the prompt-only, category-scoped
    // case. A non-empty list is judged by its usable entries alone: one whose
    // every entry is garbage is a corrupt mute and suppresses nothing.
    if (mute.files.length === 0) {
      return true;
    }
    const fingerprint = mute.files
      .map(comparable)
      .filter((path) => path.length > 0);
    return fingerprint.some((path) => touched.includes(path));
  });
}

/**
 * The mute list with everything past its window dropped.
 *
 * State hygiene rather than correctness — `isMuted` independently ignores an
 * expired mute — but without it the list grows for the life of the project.
 * The Stop hook applies it before gating, so the same boundary governs what
 * is kept and what suppresses: an entry expiring exactly now is dropped.
 *
 * Pure like everything else here: the given list is never mutated, a new one
 * is returned, and the caller decides whether to persist it. A `now` the
 * caller could not read judges nothing — the list comes back intact rather
 * than emptied.
 *
 * @param {unknown} mutes - The `mutes` array from personal state. Any shape
 *   is tolerated.
 * @param {unknown} now - The caller's current ms-epoch time.
 * @returns {object[]} A new array of the surviving mutes. Never throws.
 */
export function pruneMutes(mutes, now) {
  if (!Array.isArray(mutes)) {
    return [];
  }
  if (!isFiniteNumber(now)) {
    return [...mutes];
  }
  return mutes.filter((mute) => isPlainObject(mute) && isActive(mute, now));
}
