---
version: 0.2.0
last_update: 2026-09-29
created_at: 2026-07-11
---

# Configuration reference

> Companion to [../architecture.md](../architecture.md). Concepts, presets,
> and the full knob list for `.stoic/config.json`.

## Concepts

Config resolution is layered, later wins:

1. **Built-in defaults** — hardcoded in `src/io/config/config.js` (the single
   source of truth for default values; this document names knobs, code owns
   numbers).
2. **Preset** — a named bundle of numeric knobs (`calm` / `balanced` /
   `vigilant`). `config.preset` is the team default (committed); a personal
   choice, `state.preset` in the personal `state.json`, wins (no plugin
   surface writes it in the PoC; the read side is the contract):
   effective preset = `state.preset ?? config.preset ?? "balanced"`, resolved
   in one place (`effectivePreset`, used by `resolveKnobs`). Each layer must be
   _valid_ to win; an unrecognized name falls through to the next. Both
   overrides are optional — `state.preset` is absent until the user personally
   chooses one, which is what lets a committed team preset reach a teammate.
   (The sandbox wrote `state.preset` but never read it — the read side is part
   of this contract.)
3. **`advanced` overrides** — any individual knob set numerically by the user.

A missing or corrupt `config.json` silently resolves to defaults — config
loading never throws (fail-silent principle). Users normally never touch raw
numbers: `/stoic-stack:setup` maps a few plain-language questions to a preset,
categories, and pause mode.

## Presets

| Preset     | Intent                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calm`     | Rare pauses — high threshold, fast score decay. (Renamed from the sandbox's `conservative`, which read ambiguously: conservative about interrupting vs. about risk.) |
| `balanced` | Default.                                                                                                                                                             |
| `vigilant` | Frequent pauses — low threshold, slow decay.                                                                                                                         |

Presets differ only in the numeric knobs listed under `advanced` below.

## `config.json` fields

| Field                             | Type     | Meaning                                                                                                                                                                                                                                                                           |
| --------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enabled`                         | boolean  | Master switch; `false` makes every hook a no-op.                                                                                                                                                                                                                                  |
| `preset`                          | string   | Team default: `calm` \| `balanced` \| `vigilant`. Personally overridable via `state.preset`.                                                                                                                                                                                      |
| `categories`                      | string[] | Enabled top-level decision areas (4 built-in ids).                                                                                                                                                                                                                                |
| `subcategories`                   | object   | Per-area editable map — the classifier's output vocabulary.                                                                                                                                                                                                                       |
| `pause_mode`                      | string   | `hybrid` \| `choices` \| `freeform` — how the skill collects the reflection (sandbox `choice_only`/`write_only` renamed; "write" was ambiguous in a coding tool).                                                                                                                 |
| `followup_draft`                  | boolean  | Whether a follow-up prompt is drafted from a recorded decision.                                                                                                                                                                                                                   |
| `critical_paths`                  | string[] | Substring patterns; a touched match is a Critical Path and hard-triggers a pause. Defaults: `package.json`, `auth`, `migration`, `dockerfile`, `middleware` — precise on purpose; the sandbox's broad `client`/`service`/`package` substrings hard-gated half a typical codebase. |
| `classifier_confidence_threshold` | number   | Minimum classifier confidence, below it the pause is vetoed.                                                                                                                                                                                                                      |
| `classifier_model`                | string   | Model id for LLM #1 (a cheap/fast model, e.g. current Haiku).                                                                                                                                                                                                                     |
| `max_questions`                   | number   | Upper bound on Socratic questions per pause (1–3).                                                                                                                                                                                                                                |
| `advanced`                        | object   | Numeric knob escape hatch, overrides the preset per knob.                                                                                                                                                                                                                         |

### Guided vs manual fields

Guided setup owns exactly four of the fields above — `preset`, `categories`,
`pause_mode`, `followup_draft` — plus `enabled`, which it _derives_ from
`categories` rather than asking about. Everything else in the table is the
manual layer: hand-edited, and never touched by a setup re-run.

That split is declared once, as `GUIDED_CHOICES` in `src/io/config/config.js`.
It names each guided field and how to decode its answer from text;
`src/cli/setup.js` derives its whole surface from it — flag names, the
completeness check, decoding — and re-lists nothing. A fifth guided question is
one row there and **no change to the CLI**, which is what keeps the skill, the
CLI, and this model from drifting apart. It does still need its own assignment
branch in `mergeGuidedChoices`: the surface derives, the merge does not, and a
row added without that branch is accepted and then silently ignored. Decoding is
shape only (text → value); which values are _supported_ stays with
`mergeGuidedChoices`, so every enum has exactly one validator.

## `advanced` knobs

All knob keys are flat snake_case — consistent with every other config key.
The sandbox names (a mix of SCREAMING_CASE and abbreviations) are listed for
migration; the meanings are unchanged.

| Knob                 | Meaning                                                                                                                                        | Sandbox name       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `threshold`          | Score level at which the soft gate fires.                                                                                                      | `THRESHOLD`        |
| `half_life_hours`    | Score decay half-life between turns.                                                                                                           | `HALF_LIFE_HOURS`  |
| `weight_edits`       | Weight: number of edit events in the turn.                                                                                                     | `w_edits`          |
| `weight_diff`        | Weight: total changed lines in the turn.                                                                                                       | `w_diff`           |
| `weight_effort`      | Weight: prompt-effort heuristic (low effort raises the score).                                                                                 | `w_effort`         |
| `question_relief`    | Relief applied when the turn contained a genuine user question.                                                                                | `r_quest`          |
| `delegated_discount` | Multiplier (0..1, default 0.5) applied to delegated edits/lines in the turn delta — delegation is not autopilot by itself (see trade-offs.md). | — (new)            |
| `cooldown_ratio`     | Fraction of the threshold the score is capped at when a pause fires; also the cap step of the manual reward (see §Score relief).               | — (new)            |
| `mute_window_ms`     | Fingerprint mute duration after a pause (same category + files).                                                                               | `MUTE_WINDOW_MS`   |
| `category_mute_ms`   | Category mute duration after 3 consecutive skips.                                                                                              | `CATEGORY_MUTE_MS` |

**Calibration status:** every numeric default is a placeholder. Nothing has
been tuned against real usage yet; treat the numbers in
`src/io/config/config.js` as starting points, not findings (see
[trade-offs.md](trade-offs.md)).

### Non-configurable scoring constants

Three calibration numbers live beside the presets in `src/io/config/config.js`
but are **deliberately not knobs** — `advanced` cannot set them, under any
spelling:

| Constant                 | Value  | Role                                                                                              |
| ------------------------ | ------ | ------------------------------------------------------------------------------------------------- |
| `EDIT_COUNT_CAP`         | `10`   | Edit count at which the edit term saturates; the unit `weight_edits` is denominated in.           |
| `DIFF_LINE_CAP`          | `200`  | Changed-line count (added + removed) at which the diff term saturates; the unit of `weight_diff`. |
| `AUTO_ACCEPT_MULTIPLIER` | `1.25` | Scales the summed volume terms when a turn's edits reached disk without edit-by-edit approval.    |

The caps are divisors, not just clamps: the turn delta scores
`weight * min(volume, cap) / cap`, so a turn at the cap earns exactly its
weight. That makes a cap and its weight one calibration decision — **they
must be recalibrated together**, and letting a user move one through
`advanced` would silently redefine what every preset's weights mean, which is
why these are constants rather than knobs. They reach the scorer
(`src/core/scoring.js`) as arguments merged into the resolved knobs, never as
an import — Domain never imports Infrastructure.

**Calibration status:** all three values are uncalibrated placeholders
carried over from the sandbox prototype, not findings.

### Non-configurable mute constant

One more constant sits beside the presets for the same reason, though it is a
policy number rather than a scoring one:

| Constant                     | Value | Role                                                            |
| ---------------------------- | ----- | --------------------------------------------------------------- |
| `SKIPS_BEFORE_CATEGORY_MUTE` | `3`   | Consecutive skips of one category before the category is muted. |

It is the other half of the `category_mute_ms` knob: the knob says how long a
retired category stays quiet, the constant says what earns the retirement, and
neither reads as a policy on its own. `src/cli/record.js` is its only applier
and would otherwise be its natural home, but that file is a self-executing
script — importing it runs the CLI — so a constant its tests must agree with
cannot be exported from there.

**Calibration status:** an uncalibrated placeholder, like the three above.

### Non-configurable reward constant

One constant does not sit beside the presets at all. It belongs to the manual
reflection path and lives with it, in `src/io/config/manual-reflection.js`:

| Constant               | Value  | Role                                                                      |
| ---------------------- | ------ | ------------------------------------------------------------------------- |
| `MANUAL_RELIEF_FACTOR` | `0.25` | Fraction of the capped score that survives a completed manual reflection. |

It is **deliberately not a knob**, for two reasons. Registering it would mean
adding it to `KNOB_NAMES` / `KNOB_RULES`, which live in `src/io/config/config.js`
— forcing that module to import from `manual-reflection.js` while
`manual-reflection.js` already imports from it, a cycle; the dependency between
the two runs one way and must stay that way. Beyond the cycle, the value
describes the mechanism rather than a sensitivity setting, exactly like
`cooldown_ratio`, which is identical across all three presets for the same
reason. `normalizeAdvanced` iterates `KNOB_NAMES` only, so a user config
carrying this name is dropped rather than honored.

**Calibration status:** an uncalibrated placeholder, never tuned against real
usage — not a finding.

## Score relief

One pressure-relief mechanism, applied at two moments, specified here and
nowhere else. Both moments go through one pure function in
`src/core/scoring.js`; neither writer does score arithmetic of its own, and
neither can raise the score.

**The cap, at a fire.** When a pause fires, the Stop hook applies
`relievedScore`, capping the persisted score:

```
score = min(score, threshold × cooldown_ratio)
```

A cap never raises a score. A low-score critical-path fire therefore leaves
the score untouched, a just-over-threshold fire cannot re-fire on the next
turn, and a far-over-threshold streak drains in one step. The pause
document's `score` field carries the fire-time value from _before_ the cap,
so the skill and later analytics see why the pause fired.

**The reward, on a completed manual reflection.** When `record.js` records a
`keep` or `correct` on a `manual` pause document, it applies `rewardedScore`:
the same cap, then a further discount by `MANUAL_RELIEF_FACTOR`:

```
score = min(score, threshold × cooldown_ratio) × MANUAL_RELIEF_FACTOR
```

A reflection the developer chose is worth more than one the engine imposed,
and a cap alone would reward a developer who reflects _before_ drifting with
nothing. It is the reward for thinking, not for asking: `skip` and `defer` on
a manual document leave the score alone, so "invoke, then escape" is not a
cheaper route to a low score than reflecting is. The automatic path never
earns the reward; its own fire already applied the cap.

Those two writers are exhaustive. The decision to allow the second one, and
the alternatives rejected, are [trade-off 14](trade-offs.md).

## Validity rules

These rules are about **shape, not calibration**: they reject values that are
meaningless for the engine (a negative half-life, a confidence of 7), never
values that are merely untuned. Calibration may move any number freely inside
these bounds.

| Field                                                             | Rule                                                                                                          |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `threshold`, `half_life_hours`                                    | finite, greater than zero                                                                                     |
| `weight_edits`, `weight_diff`, `weight_effort`, `question_relief` | finite, zero or greater                                                                                       |
| `mute_window_ms`, `category_mute_ms`                              | finite, zero or greater                                                                                       |
| `delegated_discount`, `classifier_confidence_threshold`           | finite, from zero to one                                                                                      |
| `cooldown_ratio`                                                  | finite, from zero to below one (1 would be a no-op cap, letting a just-over-threshold fire re-fire next turn) |
| `max_questions`                                                   | integer from one to three                                                                                     |
| `enabled`, `followup_draft`                                       | boolean                                                                                                       |
| `preset`                                                          | one of the three preset names                                                                                 |
| `pause_mode`                                                      | one of the three mode names                                                                                   |
| `classifier_model`                                                | non-empty string                                                                                              |
| `categories`                                                      | known top-level area ids                                                                                      |
| `critical_paths`, `subcategories[area]`                           | non-empty strings                                                                                             |

A value that breaks its rule is **dropped**, not clamped and not repaired: a
runtime read falls back to the built-in default for that field, and the whole
document falls back when it is not a JSON object. Clamping would silently
invent a setting the user never chose. `subcategories` and `critical_paths`
are free vocabulary — any non-empty string is valid, since users prune and
extend them by hand.

Two audiences, two behaviors, one rule set: **runtime reads are fail-silent**
(drop and default, never throw into a hook), while **explicit setup rejects**
invalid guided input with an actionable error and writes nothing.

## Migration input

The sandbox names below are accepted **only when reading a persisted
document**, and are normalized to the canonical vocabulary on the way in. New
programmatic setup input is canonical-only — a sandbox name supplied as a
setup choice is a validation error, not an alias. Canonical wins if both are
present.

| Sandbox (accepted on read)                                                                                                 | Canonical                            |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `conservative`                                                                                                             | `calm`                               |
| `choice_only`, `write_only`                                                                                                | `choices`, `freeform`                |
| `THRESHOLD`, `HALF_LIFE_HOURS`, `w_edits`, `w_diff`, `w_effort`, `r_quest`                                                 | the flat snake_case knob             |
| `MUTE_WINDOW_MS`, `CATEGORY_MUTE_MS`                                                                                       | `mute_window_ms`, `category_mute_ms` |
| the five flat v01 category names (`data_model`, `api_contract`, `security_auth`, `new_dependency`, `architecture_pattern`) | their top-level area                 |
