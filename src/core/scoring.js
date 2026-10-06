// Pure scoring mathematics — how one turn moves the autopilot score, and how
// a pause relieves it.
//
// The Stop hook reads the previous score and its timestamp from personal
// state, assembles the turn group, resolves the knobs, and calls `scoreTurn`
// here; nothing else in the engine turns evidence into a number. Three
// exports, one per question: `decayScore` (what is the old score worth now?),
// `turnDelta` (how much did this turn move the needle?), and `scoreTurn`
// (their composition, floored at zero).
//
// Two more exports answer a different question — not "what did this turn
// cost?" but "what does a pause forgive?" — and they matter because the score
// has TWO writers, not one. The Stop hook applies `relievedScore` when a pause
// fires, capping the score so one loud turn cannot fire again on the next. The
// recorder applies `rewardedScore` when a manual reflection is completed: the
// same cap, then a further discount, because a reflection the developer chose
// is worth more than one the engine imposed. This module is the one place in
// the Domain layer that must know both callers exist, so the arithmetic of
// relief lives here once rather than inlined at each writer.
//
// This module is Domain-layer pure: deterministic, no filesystem, no
// environment, no clock — elapsed time arrives as an argument, never as a
// `Date.now()` read. It NEVER imports from `src/io/`: the calibration
// constants (`EDIT_COUNT_CAP`, `DIFF_LINE_CAP`, `AUTO_ACCEPT_MULTIPLIER`)
// live in `src/io/config/config.js` beside the presets, because that is where
// calibration lives, and the Stop hook merges them into the resolved knobs
// object as `edit_count_cap` / `diff_line_cap` / `auto_accept_multiplier`
// before calling in. One object, snake_case like every other knob, so the
// scorer needs no second parameter and no knowledge of which numbers are
// user-tunable and which are not. `MANUAL_RELIEF_FACTOR` obeys the same rule:
// it lives beside the presets and arrives inside the knobs object as
// `manual_relief_factor`, so `rewardedScore` never has to import it.
//
// Both the group and the knobs are untrusted here — the group is built from a
// hand-editable log and the knobs pass through a user's `advanced` overrides
// — so every field is coerced, never assumed, and no input shape can make a
// score throw or go NaN. An unusable field costs itself alone: it scores as
// if it were absent, mirroring `group.js`'s one-bad-line-degrades-the-group
// stance.
//
// The arithmetic below is the decision. The numbers it consumes live in the
// presets. Most are still placeholders; `weight_effort`, `question_relief`,
// and the preset defaults of `delegated_discount` were field-adjusted, and
// `advanced` can replace any of them. Which numbers that covers is recorded
// in configuration.md (Calibration status) and trade-off 2.
//
// Contract: thoughts/shared/.project/architecture/configuration.md
// (knob meanings, the non-configurable scoring constants, and the
// cap-and-weight-recalibrate-together rule).
import { effortOf, isFiniteNumber, isPlainObject } from "./predicates.js";

/** Milliseconds per hour — elapsed time arrives in ms, the half-life in hours. */
const HOUR_MS = 60 * 60 * 1000;

/** A group count as a usable volume: unreadable or negative counts as 0. */
const volumeOf = (value) => (isFiniteNumber(value) && value > 0 ? value : 0);

/** A knob weight as usable: negative or unreadable weights weigh nothing. */
const weightOf = (value) => (isFiniteNumber(value) && value >= 0 ? value : 0);

/**
 * A discount as a usable fraction. An unreadable discount forgives NOTHING
 * (1, full cost) rather than everything (0): the discount is a forgiveness
 * feature, and the safe degradation of forgiveness is to withhold it, not to
 * let a corrupt knob wave whole delegated turns through for free.
 */
const discountOf = (value) =>
  isFiniteNumber(value) && value >= 0 && value <= 1 ? value : 1;

/** A multiplier as usable: anything unreadable or non-positive scales by 1. */
const multiplierOf = (value) =>
  isFiniteNumber(value) && value > 0 ? value : 1;

/**
 * One volume term: weight times the capped share of its unit.
 *
 * The cap is a DIVISOR, not just a clamp — it is the unit its weight is
 * denominated in, so a turn at the cap earns exactly its weight. The weights
 * are small (balanced `weight_edits: 4` against `threshold: 10`), so
 * multiplying raw capped counts instead would put an ordinary turn thirty
 * times past the threshold. This is also why cap and weight must be
 * recalibrated together: moving one silently redefines the other.
 *
 * A missing or non-positive cap silences the term entirely — no unit, no
 * signal — because dividing by zero or NaN is the one way this module could
 * poison the persisted score.
 */
const volumeTerm = (weight, effective, cap) =>
  isFiniteNumber(cap) && cap > 0
    ? (weight * Math.min(effective, cap)) / cap
    : 0;

/**
 * A total and its delegated share, discounted BEFORE the cap.
 *
 * Discount-before-cap is deliberate: the discount buys exactly proportional
 * headroom before saturating (at a 0.5 discount, twice the cap of fully
 * delegated work costs what one cap of the developer's own costs) and washes
 * out entirely past that. The rejected alternative — cap first, then scale by
 * the delegated fraction — would halve a fully delegated turn no matter its
 * size, a blanket exemption; at forty edits in one turn something is worth
 * noticing regardless of who typed them.
 *
 * The delegated share is clamped to the total first: `group.js` guarantees
 * share <= total, but a hand-edited log does not, and an oversized share must
 * not drive the developer's own portion negative.
 */
const effectiveVolume = (total, delegated, discount) => {
  const share = Math.min(delegated, total);
  return total - share + discount * share;
};

/**
 * What is the old score worth after this much time away?
 *
 * Exponential decay by half-lives: `previousScore * 0.5 ^ (elapsed / half
 * life)`. Decay is the score's only way down between turns, so it must never
 * be a way UP: non-positive and unreadable elapsed times return the score
 * unchanged (clock skew must never inflate a score — `0.5 ^ negative` is
 * greater than 1), and an unreadable half-life also returns it unchanged
 * rather than wiping accumulated evidence over a corrupt knob. An unreadable
 * or negative previous score decays as 0, the invariant floor `scoreTurn`
 * maintains.
 *
 * @param {unknown} previousScore - The persisted score; non-finite or
 *   negative values read as 0.
 * @param {unknown} elapsedMs - Milliseconds since that score was written;
 *   non-finite or non-positive values decay nothing.
 * @param {unknown} halfLifeHours - The `half_life_hours` knob; non-finite or
 *   non-positive values decay nothing.
 * @returns {number} The decayed score, in [0, previousScore]. Never throws,
 *   never NaN.
 */
export function decayScore(previousScore, elapsedMs, halfLifeHours) {
  const score =
    isFiniteNumber(previousScore) && previousScore > 0 ? previousScore : 0;
  if (score === 0) {
    return 0;
  }
  if (!isFiniteNumber(elapsedMs) || elapsedMs <= 0) {
    return score;
  }
  if (!isFiniteNumber(halfLifeHours) || halfLifeHours <= 0) {
    return score;
  }
  return score * 0.5 ** (elapsedMs / (halfLifeHours * HOUR_MS));
}

/**
 * How much did this turn move the needle?
 *
 * The delta is four terms, each answering exactly one question:
 *
 * - Edit term — how many edits, in cap units, discounted for delegation.
 * - Diff term — how many changed lines (added PLUS removed: a 50-for-50
 *   rewrite is not a small change), likewise discounted.
 * - Effort term — `weight_effort * prompt_effort`, consumed AS-IS with no
 *   sign flip: `promptEffort` already returns positive for low effort (the
 *   autopilot pattern) and negative for visible thinking, so a well-specified
 *   turn can post a negative delta. A neutralized turn arrives with effort 0
 *   and needs no branch here.
 * - Question relief — subtracted when the turn asked a genuine question.
 *
 * The auto-accept multiplier scales the SUMMED VOLUME TERMS ONLY. It answers
 * "did these edits reach disk without approval?" — a question about volume,
 * meaningless about a sentence the developer typed. Scaling the whole delta
 * would make question relief worth more in auto-accept mode than in manual,
 * rewarding a question for being asked in the riskier mode. (The abandoned
 * sandbox prototype applied the multiplier to the edits term only; covering
 * both volume terms is a deliberate correction, not an oversight.) Likewise
 * the delegated discount touches volume only: "just fix it" followed by a
 * six-agent fan-out still scores through the effort term. Delegation is
 * forgiven; not thinking is not.
 *
 * @param {unknown} group - A turn group as `buildTurnGroup` shapes it. Any
 *   input shape is tolerated; a non-object is an empty turn.
 * @param {unknown} knobs - Resolved knobs plus the scoring constants the
 *   caller merges in from `src/io/config/config.js` (`edit_count_cap`,
 *   `diff_line_cap`, `auto_accept_multiplier`). Any input shape is tolerated;
 *   unusable knobs silence their own terms.
 * @returns {number} The signed turn delta — unfloored, so callers see a
 *   negative delta as the good news it is. Never throws, never NaN.
 */
export function turnDelta(group, knobs) {
  // A non-object input is an empty turn and a settings-free run: reading
  // fields off `{}` yields the same `undefined` every coercer below already
  // treats as absent, so no caller shape needs its own branch.
  const safeGroup = isPlainObject(group) ? group : {};
  const safeKnobs = isPlainObject(knobs) ? knobs : {};

  const discount = discountOf(safeKnobs.delegated_discount);

  const effectiveEdits = effectiveVolume(
    volumeOf(safeGroup.edit_count),
    volumeOf(safeGroup.delegated_edit_count),
    discount,
  );
  const effectiveLines = effectiveVolume(
    volumeOf(safeGroup.lines_added) + volumeOf(safeGroup.lines_removed),
    volumeOf(safeGroup.delegated_lines_added) +
      volumeOf(safeGroup.delegated_lines_removed),
    discount,
  );

  const volume =
    volumeTerm(
      weightOf(safeKnobs.weight_edits),
      effectiveEdits,
      safeKnobs.edit_count_cap,
    ) +
    volumeTerm(
      weightOf(safeKnobs.weight_diff),
      effectiveLines,
      safeKnobs.diff_line_cap,
    );

  // Booleans are checked strictly: a truthy non-boolean in a hand-edited log
  // ("yes", 1) is a corrupt flag, and corrupt evidence never raises the cost.
  const multiplier =
    safeGroup.auto_accept === true
      ? multiplierOf(safeKnobs.auto_accept_multiplier)
      : 1;
  const relief =
    safeGroup.had_question === true ? weightOf(safeKnobs.question_relief) : 0;

  return (
    volume * multiplier +
    weightOf(safeKnobs.weight_effort) * effortOf(safeGroup.prompt_effort) -
    relief
  );
}

/**
 * The whole turn: decay the previous score, apply the delta, floor at zero.
 *
 * The floor is per turn and there is no ceiling: a run of thoughtful turns
 * cannot bank negative credit against a future autopilot streak, but an
 * autopilot streak keeps accumulating until the developer stops. The
 * half-life is read from the same knobs object as everything else, so the
 * caller resolves settings exactly once.
 *
 * @param {unknown} previousScore - The persisted score; see `decayScore`.
 * @param {unknown} elapsedMs - Milliseconds since it was written.
 * @param {unknown} group - The turn group; see `turnDelta`.
 * @param {unknown} knobs - Resolved knobs plus scoring constants; the
 *   `half_life_hours` knob drives the decay.
 * @returns {number} The new score, >= 0. Never throws, never NaN.
 */
export function scoreTurn(previousScore, elapsedMs, group, knobs) {
  const halfLifeHours = isPlainObject(knobs)
    ? knobs.half_life_hours
    : undefined;
  return Math.max(
    0,
    decayScore(previousScore, elapsedMs, halfLifeHours) +
      turnDelta(group, knobs),
  );
}

/**
 * What a fired pause leaves behind: the score capped at a fraction of the
 * threshold.
 *
 * A CAP (`Math.min`), never an assignment. A critical-path pause can fire at
 * any score, including a calm one, and having paused must not cost the
 * developer a raised score — the cap only ever bites downward.
 *
 * The floor is the one `volumeTerm` already applies to a missing cap: a score,
 * threshold, or ratio that cannot be read is worth zero. An unreadable cap is
 * therefore a cap of zero, which forgives everything. That is the direction to
 * fail in — the score is never raised, and a broken configuration errs toward
 * silence rather than toward interrupting a developer over arithmetic it could
 * not do.
 *
 * @param {unknown} score - The fire-time score; non-finite or negative reads
 *   as 0.
 * @param {unknown} threshold - The effective `threshold` knob; unreadable
 *   reads as 0.
 * @param {unknown} ratio - The `cooldown_ratio` knob; unreadable reads as 0.
 * @returns {number} The relieved score, in [0, score]. Never throws, never
 *   NaN.
 */
export function relievedScore(score, threshold, ratio) {
  return Math.min(volumeOf(score), volumeOf(threshold) * volumeOf(ratio));
}

/**
 * What a completed manual reflection leaves behind: the same cap, then the
 * reward.
 *
 * The composition is the decision. A cap alone bites only a score already
 * above it, so a developer who reflects BEFORE drifting would be rewarded with
 * nothing — inverting the intent. A multiplier alone can leave a very high
 * score still at the threshold, leaving open the gap the feature exists to
 * close. Capped first, then scaled, the result is always at or below what the
 * automatic path gives and always below a positive score.
 *
 * The factor uses `discountOf` semantics, not `multiplierOf`: an unreadable
 * factor is 1 — no reward, but never a raise — and a factor above 1 is itself
 * unreadable, because a reward that raises the score is not a reward. Reading
 * both numbers off one object means a caller resolves settings exactly once,
 * as everywhere else in this module.
 *
 * @param {unknown} score - The score standing when the reflection completed.
 * @param {unknown} threshold - The effective `threshold` knob; see
 *   `relievedScore`.
 * @param {unknown} knobs - The resolved manual-reflection numbers, read for
 *   `cooldown_ratio` and `manual_relief_factor`. Any shape is tolerated; a
 *   non-object falls to the floors of both.
 * @returns {number} The rewarded score, in [0, score]. Never throws, never
 *   NaN.
 */
export function rewardedScore(score, threshold, knobs) {
  const safeKnobs = isPlainObject(knobs) ? knobs : {};
  return (
    relievedScore(score, threshold, safeKnobs.cooldown_ratio) *
    discountOf(safeKnobs.manual_relief_factor)
  );
}
