// Should this turn interrupt the developer? — the fire path's one decision.
//
// The Stop hook's body is I/O: it consumes the session log, scores the turn,
// persists state, writes the pending pause, and prints the block. This module
// is the judgment in between, lifted out whole. `stop.js` self-executes on
// import, so a test that wanted this question answered directly could never
// import it there; here it is a plain function a test calls with the inputs it
// chooses.
//
// It is Orchestration-layer code, the same layer as the hook body: it may reach
// for the gates, the classifier, and the configuration model. What it may not
// do is act. No file is read or written, nothing reaches stdout, and the clock
// arrives as `now` — so every expiry boundary and every cooldown sum is
// reproducible without waiting for one or spawning anything.
//
// The answer is data, never control flow: exactly one outcome object, carrying
// what the hook needs to trace the turn and — when it fires — to write the
// pause document. Four outcomes, in the order the question is actually asked:
// `below_gates` (no candidate), `veto` (a gate fired, the classifier refused to
// justify it), `muted` (justified, but already settled), `fire`.
//
// Two gates lead in, and their asymmetry is the point. The hard gate — a
// touched critical path — fires at any score, because a change to a watched
// area is consequential regardless of how calm the session has been. The soft
// gate is the accumulated autopilot score reaching the effective threshold.
// When both apply the hard gate names the trigger: the developer configured
// that watch by hand and should be told it is what spoke.
//
// A fire also reports the cooldown: the score the hook should persist so one
// loud turn cannot fire again on the next. The arithmetic is not this
// module's — it is `relievedScore` in the Domain layer, a CAP against a
// fraction of the threshold and never an assignment, so a critical-path pause
// at a low score cannot have its score raised by having paused. That formula
// is shared: the recorder applies the same cap, plus a reward, when a manual
// reflection is completed, and the two writers must not drift apart.
//
// The classifier runs BEFORE the mute check, which means a muted turn still
// paid for its verdict: a mute is keyed by category, and the category is the
// classifier's output, so there is nothing to match a mute against until the
// call has been made. A category mute over a still-loud score therefore costs
// one discarded headless call per above-threshold turn for the mute's window —
// accepted deliberately, and bounded; see architecture/trade-offs.md §13.
//
// Every input is untrusted — a hand-editable `state.json`, a user's settings,
// a group built from an appendable log — so the whole function is fail-safe:
// it never throws, and every degradation errs toward silence, because a
// needless pause costs the developer the very attention this plugin exists to
// protect.
//
// Contract: thoughts/shared/.project/architecture/data-flow.md (Stop order of
// operations), architecture/payloads.md (§ `stoic-pending-pause.json`,
// § "Classifier verdict (LLM #1)") and architecture/configuration.md
// (`critical_paths`, `cooldown_ratio`).
import { isMuted, matchCriticalPaths } from "../core/gates.js";
import { isFiniteNumber, isPlainObject } from "../core/predicates.js";
import { relievedScore } from "../core/scoring.js";
import { classify } from "../io/classifier.js";
import { normalizeConfig, resolveKnobs } from "../io/config/config.js";

/**
 * The distinct paths a turn touched, in first-touch order.
 *
 * The turn group carries edits, not a file list, and both gates and the mute
 * check ask about files — so the derivation happens once, here. Unusable
 * entries are dropped rather than rejected: a single malformed edit must not
 * blind the hard gate to the rest of the turn.
 *
 * `src/io/classifier.js` (`readTouchedFiles`) makes the same derivation for
 * the prompt, deliberately WITH a bound (`TOUCHED_FILE_LIMIT`): a gate must
 * see every file, a prompt must stay small. A change to what counts as a
 * usable edit belongs in both places.
 *
 * @param {object} group - A turn group already known to be a plain object.
 * @returns {string[]} Distinct touched paths; empty for a turn with no edits.
 */
function touchedFiles(group) {
  if (!Array.isArray(group.edits)) {
    return [];
  }
  const files = [];
  for (const edit of group.edits) {
    if (isPlainObject(edit) && !files.includes(edit.file)) {
      files.push(edit.file);
    }
  }
  return files.filter((file) => typeof file === "string" && file.length > 0);
}

/**
 * @typedef {{outcome: "below_gates"}
 *   | {outcome: "veto", reason: string, trigger: string}
 *   | {outcome: "muted", trigger: string, classification: object}
 *   | {outcome: "fire", trigger: string, classification: object,
 *      score: number, threshold: number, cooled_score: number}}
 *   FireDecision
 */

/**
 * Decide whether this turn boundary should become a pause.
 *
 * The order is deliberate and cheap-first: the gates are pure arithmetic over
 * data already in hand, so a turn that fires neither of them never pays for a
 * classifier call. Only a candidate is classified, and only a justified
 * candidate is checked against the mutes — the mute question needs the
 * category, which does not exist until the classifier has answered.
 *
 * The reported `score` is the fire-time score exactly as it arrived, before
 * the cooldown: it is what the pause document tells the developer about the
 * turn that interrupted them. `cooled_score` is the separate number the hook
 * persists afterwards.
 *
 * A group that is not an object is not a turn this can judge. Rather than
 * classifying the empty summary it would read as, it decides `below_gates`:
 * the soft gate alone must never manufacture a pause out of a turn whose
 * evidence went missing.
 *
 * @param {unknown} state - Personal engine state as loaded. Any shape is
 *   tolerated; an unreadable score reads as no score.
 * @param {unknown} config - Project configuration (canonical or raw).
 * @param {unknown} group - The turn group just built, or anything else.
 * @param {unknown} [context] - The turn context, passed through to `classify`
 *   untouched; this function never reads it.
 * @param {object} [options] - Call options.
 * @param {number} [options.now] - The caller's ms-epoch time, for mute expiry.
 * @param {Function} [options.runner] - Classifier seam, passed through to
 *   `classify`; production leaves it unset and the real headless call runs.
 * @returns {FireDecision} The decision. Never throws: any internal failure
 *   decides `below_gates`, the silent answer.
 */
export function decideFire(state, config, group, context, options) {
  try {
    if (!isPlainObject(group)) {
      return { outcome: "below_gates" };
    }

    const personal = isPlainObject(state) ? state : {};
    const settings = isPlainObject(options) ? options : {};
    const knobs = resolveKnobs(config, personal);
    const score = isFiniteNumber(personal.score) ? personal.score : 0;
    const threshold = knobs.threshold;

    const files = touchedFiles(group);
    const watched = matchCriticalPaths(
      files,
      normalizeConfig(config).critical_paths,
    );
    if (watched.length === 0 && score < threshold) {
      return { outcome: "below_gates" };
    }
    const trigger = watched.length > 0 ? "critical_path" : "score";

    const decision = classify(group, config, context, {
      runner: settings.runner,
    });
    if (decision.status !== "pass") {
      return { outcome: "veto", reason: decision.reason, trigger };
    }
    const { classification } = decision;

    if (isMuted(personal.mutes, classification.category, files, settings.now)) {
      return { outcome: "muted", trigger, classification };
    }

    return {
      outcome: "fire",
      trigger,
      classification,
      score,
      threshold,
      cooled_score: relievedScore(score, threshold, knobs.cooldown_ratio),
    };
  } catch {
    return { outcome: "below_gates" };
  }
}
