// What the manual reflection path — and only that path — needs from the
// configuration. A developer who types the reflection skill is not using the
// engine's initiative, so this module resolves a deliberately small set: the
// three fields that shape the conversation (`pause_mode`, `max_questions`,
// `followup_draft`) and the three numbers of the reward formula (`threshold`,
// `cooldown_ratio`, and the module constant below).
//
// Nothing about categories, subcategories, the classifier, critical paths,
// scoring weights, or mute windows appears here. The manual path touches none
// of them, and carrying them anyway would invite a future reader to assume it
// does.
//
// The dependency on `./config.js` runs one way and must stay that way: this
// module reads the canonical model, the canonical model knows nothing of this
// one. Every resolution below delegates to the functions already there, so
// preset resolution, the personal preset override, and `advanced` overrides
// keep behaving identically to every other consumer.
import { normalizeConfig, resolveKnobs } from "./config.js";

// ---------------------------------------------------------------------------
// The reward constant — a property of the mechanism, not of a preset.
//
// Manual relief caps the score at `threshold * cooldown_ratio` first, exactly
// as the automatic fire-time cooldown does, and then scales what is left by
// this factor. That second step is what makes a reflection the developer chose
// worth more than one the engine imposed.
//
// It is deliberately NOT a knob. Registering it would mean adding it to
// KNOB_NAMES / KNOB_RULES, which live in `./config.js` — forcing that module
// to import from this one while this one imports from it, a cycle. Beyond the
// cycle, the value describes the mechanism rather than a sensitivity setting,
// exactly like `cooldown_ratio`, which is identical across all three presets
// for the same reason. `normalizeAdvanced` iterates KNOB_NAMES only, so a user
// config carrying this name is dropped rather than honored.
//
// THE NUMBER IS AN UNCALIBRATED PLACEHOLDER, never tuned against real usage.
// Do not cite it as a finding.
// ---------------------------------------------------------------------------

/** Fraction of the capped score that survives a completed manual reflection. */
export const MANUAL_RELIEF_FACTOR = 0.25; // uncalibrated placeholder

/**
 * Resolve the settings the manual reflection path consumes, and only those.
 *
 * Fail-silent like every other runtime read: the settings are normalized
 * first, so an absent, corrupt, or outright non-document configuration
 * resolves through the built-in defaults instead of throwing into the skill.
 *
 * @param {unknown} config Loaded project configuration, or anything at all.
 * @param {unknown} state Personal engine state, consulted only for its preset.
 * @returns {object} `{ pause_mode, max_questions, followup_draft, threshold,
 *   cooldown_ratio, manual_relief_factor }` — a fresh object, six fields.
 */
export function resolveManualReflection(config, state) {
  const normalized = normalizeConfig(config);
  const knobs = resolveKnobs(normalized, state);

  return {
    pause_mode: normalized.pause_mode,
    max_questions: normalized.max_questions,
    followup_draft: normalized.followup_draft,
    threshold: knobs.threshold,
    cooldown_ratio: knobs.cooldown_ratio,
    manual_relief_factor: MANUAL_RELIEF_FACTOR,
  };
}
