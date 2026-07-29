// Pure scoring mathematics — how one turn moves the autopilot score.
//
// The Stop hook (not yet built) will read the previous score and its
// timestamp from personal state, assemble the turn group, resolve the knobs,
// and call `scoreTurn` here; nothing else in the engine turns evidence into a
// number. Three exports, one per question: `decayScore` (what is the old
// score worth now?), `turnDelta` (how much did this turn move the needle?),
// and `scoreTurn` (their composition, floored at zero).
//
// This module is Domain-layer pure: deterministic, no filesystem, no
// environment, no clock — elapsed time arrives as an argument, never as a
// `Date.now()` read. It NEVER imports from `src/io/`: the calibration
// constants (`EDIT_COUNT_CAP`, `DIFF_LINE_CAP`, `AUTO_ACCEPT_MULTIPLIER`)
// live in `src/io/config.js` beside the presets, because that is where
// calibration lives, and the Stop hook merges them into the resolved knobs
// object as `edit_count_cap` / `diff_line_cap` / `auto_accept_multiplier`
// before calling in. One object, snake_case like every other knob, so the
// scorer needs no second parameter and no knowledge of which numbers are
// user-tunable and which are not.
//
// Both the group and the knobs are untrusted here — the group is built from a
// hand-editable log and the knobs pass through a user's `advanced` overrides
// — so every field is coerced, never assumed, and no input shape can make a
// score throw or go NaN. An unusable field costs itself alone: it scores as
// if it were absent, mirroring `group.js`'s one-bad-line-degrades-the-group
// stance.
//
// Every weight, cap, and multiplier this module consumes is an UNCALIBRATED
// PLACEHOLDER; the arithmetic below is the decision, the numbers are not.
//
// Contract: thoughts/shared/.project/architecture/configuration.md
// (knob meanings, the non-configurable scoring constants, and the
// cap-and-weight-recalibrate-together rule).
import { isFiniteNumber, isPlainObject } from "./predicates.js";

/** Milliseconds per hour — elapsed time arrives in ms, the half-life in hours. */
const HOUR_MS = 60 * 60 * 1000;

/** The signal range `prompt_effort` promises; a hand-edited log may not. */
const EFFORT_RANGE = Object.freeze({ min: -1, max: 1 });

/** A group count as a usable volume: unreadable or negative counts as 0. */
const volumeOf = (value) => (isFiniteNumber(value) && value > 0 ? value : 0);

/** A knob weight as usable: negative or unreadable weights weigh nothing. */
const weightOf = (value) => (isFiniteNumber(value) && value >= 0 ? value : 0);

/** A group effort as a usable signal, clamped to the promised range. */
const effortOf = (value) =>
  isFiniteNumber(value)
    ? Math.min(EFFORT_RANGE.max, Math.max(EFFORT_RANGE.min, value))
    : 0;

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
 *   caller merges in from `src/io/config.js` (`edit_count_cap`,
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
