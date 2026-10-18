// The canonical configuration model — one authoritative source for safe
// defaults, the decision taxonomy, presets, validation, normalization, and
// effective setting resolution. Every future consumer (setup CLI, hooks,
// status, skill content) resolves settings through this module, so none of
// them can drift from one another.
//
// Two audiences, deliberately different failure behavior:
//
// - Runtime reads (`loadConfig`) are fail-silent. A missing or corrupt
//   document resolves to defaults and never throws into a hook, and reading
//   never creates a project file.
// - Explicit setup (`mergeGuidedChoices`) is a foreground operation. Invalid
//   guided input throws an actionable error so the caller can report it and
//   write nothing.
//
// Invalid values are dropped, never clamped: silently repairing a number
// would invent a setting the user never chose. Contract:
// thoughts/shared/.project/architecture/configuration.md.
import { readJsonFile, writeJsonFileAtomic } from "../json-file.js";
import { projectConfigPath } from "../paths.js";
import {
  isFiniteNumber,
  isNonEmptyString,
  isPlainObject,
} from "../../core/predicates.js";

// ---------------------------------------------------------------------------
// Decision taxonomy — four top-level areas, each expanding into subcategories.
// The classifier emits a SUBCATEGORY (the finer signal); resolveCategory maps
// it back to its area, which is what gating, mutes, state keys, and the
// decision bank are keyed by. The subcategory lists are the user's editable
// vocabulary: they prune entries they do not care about and may add their own.
// ---------------------------------------------------------------------------
const DEFAULT_SUBCATEGORIES = {
  data_domain: [
    "data_model",
    "database_schema",
    "domain_logic",
    "validation_rules",
    "migration_strategy",
    "data_normalization",
  ],
  api_integration: [
    "api_contract",
    "endpoint_design",
    "request_response_shape",
    "webhook_contract",
    "external_integration",
    "versioning_strategy",
  ],
  security: [
    "security_auth",
    "authorization",
    "authentication",
    "role_permissions",
    "secret_management",
    "rate_limiting",
    "privacy_boundary",
    "audit_log",
  ],
  architecture: [
    "architecture_pattern",
    "new_dependency",
    "module_boundary",
    "state_management",
    "caching_strategy",
    "background_jobs",
    "deployment_model",
    "observability",
    "testing_strategy",
  ],
};

/** The four top-level decision areas — the only ids guided setup exposes. */
export const CATEGORIES = Object.freeze(Object.keys(DEFAULT_SUBCATEGORIES));

/** The built-in subcategory vocabulary, keyed by top-level area. */
export const SUBCATEGORIES = Object.freeze(
  Object.fromEntries(
    CATEGORIES.map((area) => [
      area,
      Object.freeze([...DEFAULT_SUBCATEGORIES[area]]),
    ]),
  ),
);

/** How the pause skill collects the reflection. */
export const PAUSE_MODES = Object.freeze(["hybrid", "choices", "freeform"]);

/** The headless model the classifier runs on when the project names none. */
export const DEFAULT_CLASSIFIER_MODEL = "claude-haiku-4-5-20251001";

/** The lowest classifier confidence a pause may carry when the project names none. */
export const DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLD = 0.6; // uncalibrated placeholder

// ---------------------------------------------------------------------------
// Presets — named sensitivity bundles, the only sanctioned way to move the
// scoring knobs as a set.
//
// The knob shape and the ordering between presets are decisions. Most values
// are still uncalibrated placeholders — do not cite those as findings. Three
// knobs were field-adjusted on 2026-10-06 and are calibration, not
// placeholders: `weight_effort`, `question_relief`, and `delegated_discount`
// (trade-off 10). Every value here is a default. `advanced` replaces any knob
// on any preset. Do not surface the numbers in skill-facing content — users
// choose a preset by name, never by number.
//
// calm     — rare pauses:     high threshold, fast decay (short half-life).
// balanced — the default.
// vigilant — frequent pauses: low threshold, slow decay (long half-life).
//
// `weight_edits` and `weight_diff` still follow the 0.8x / 1.2x scaling
// around balanced. `weight_effort` does not. `question_relief` is 1 on every
// preset on purpose: shared forgiveness, not a sensitivity axis.
//
// `delegated_discount` defaults to 0.5 on calm and to 1 (full cost) on
// balanced and vigilant. `advanced.delegated_discount` overrides that default
// on any preset, including calm.
//
// `cooldown_ratio` is the fraction of the effective threshold a fired score is
// capped down to, so a single loud turn cannot fire again on the next turn. It
// is still an uncalibrated placeholder, and identical across the presets on
// purpose: how far a fire cools is a property of the pause, not of how eagerly
// a preset reaches one.
// ---------------------------------------------------------------------------
export const PRESETS = Object.freeze({
  calm: Object.freeze({
    threshold: 16,
    half_life_hours: 4,
    weight_edits: 3.2,
    weight_diff: 2.4,
    weight_effort: 1.5,
    question_relief: 1,
    delegated_discount: 0.5,
    mute_window_ms: 15 * 60 * 1000,
    category_mute_ms: 24 * 60 * 60 * 1000,
    cooldown_ratio: 0.5,
  }),
  balanced: Object.freeze({
    threshold: 10,
    half_life_hours: 6,
    weight_edits: 4,
    weight_diff: 3,
    weight_effort: 2,
    question_relief: 1,
    delegated_discount: 1,
    mute_window_ms: 15 * 60 * 1000,
    category_mute_ms: 24 * 60 * 60 * 1000,
    cooldown_ratio: 0.5,
  }),
  vigilant: Object.freeze({
    threshold: 6,
    half_life_hours: 9,
    weight_edits: 4.8,
    weight_diff: 3.6,
    weight_effort: 2.5,
    question_relief: 1,
    delegated_discount: 1,
    mute_window_ms: 15 * 60 * 1000,
    category_mute_ms: 24 * 60 * 60 * 1000,
    cooldown_ratio: 0.5,
  }),
});

// ---------------------------------------------------------------------------
// Scoring constants — calibration numbers that are deliberately NOT knobs.
//
// They live here because this file is where calibration lives, but they are
// excluded from KNOB_NAMES / KNOB_RULES / the sandbox aliases on purpose: a
// cap is the UNIT its weight is denominated in (the turn delta divides by
// it), so cap and weight are only meaningful when recalibrated together, and
// letting `advanced` move one without the other would silently redefine what
// every preset's weights mean. `normalizeAdvanced` iterates KNOB_NAMES only,
// so a user config carrying any of these names is dropped.
//
// `src/core/scoring.js` never imports this module (Domain never imports
// Infrastructure); the Stop hook merges these into the resolved knobs as
// `edit_count_cap` / `diff_line_cap` / `auto_accept_multiplier`.
//
// EVERY NUMBER HERE IS AN UNCALIBRATED PLACEHOLDER, carried over from the
// abandoned sandbox prototype and never tuned against real usage. Do not
// cite them as findings.
// ---------------------------------------------------------------------------

/** Edits at which the edit term saturates — the edit weight's unit. */
export const EDIT_COUNT_CAP = 10; // uncalibrated placeholder

/** Changed lines at which the diff term saturates — the diff weight's unit. */
export const DIFF_LINE_CAP = 200; // uncalibrated placeholder

/** Scales the summed volume terms when edits reached disk unapproved. */
export const AUTO_ACCEPT_MULTIPLIER = 1.25; // uncalibrated placeholder

// ---------------------------------------------------------------------------
// Mute constants — the other half of a rule whose duration IS a knob.
//
// `category_mute_ms` says how long a retired category stays quiet;
// SKIPS_BEFORE_CATEGORY_MUTE says what earns the retirement. The two are only
// meaningful read together, so the count lives beside the duration rather than
// inside `src/cli/record.js`, its one applier. That file is a self-executing
// script — importing it runs the CLI — so a constant its tests must agree with
// cannot be exported from there.
// ---------------------------------------------------------------------------

/** Consecutive skips of one category before the whole category goes quiet. */
export const SKIPS_BEFORE_CATEGORY_MUTE = 3; // uncalibrated placeholder

/** The preset used when neither a personal override nor a team preset applies. */
const DEFAULT_PRESET = "balanced";

/** The only presets setup may emit — also the vocabulary its callers document. */
export const PRESET_NAMES = Object.freeze(Object.keys(PRESETS));

/** The knobs a preset defines and `advanced` may override, in resolution order. */
const KNOB_NAMES = Object.freeze(Object.keys(PRESETS[DEFAULT_PRESET]));

// ---------------------------------------------------------------------------
// Validity rules — shape, not calibration. They reject values that are
// meaningless for the engine (a negative half-life, a confidence of 7), never
// values that are merely untuned; calibration may move any number freely
// inside these bounds.
// ---------------------------------------------------------------------------
const isPositive = (value) => isFiniteNumber(value) && value > 0;
const isNonNegative = (value) => isFiniteNumber(value) && value >= 0;
const isFraction = (value) => isFiniteNumber(value) && value >= 0 && value <= 1;

/**
 * Whether a value is a valid cooldown ratio: a finite fraction in [0, 1).
 *
 * A cooldown ratio of exactly 1 is a no-op cap: a just-over-threshold fire
 * would re-fire on the very next turn, defeating the binding no-refire
 * property the cooldown exists to provide (architecture/configuration.md
 * §Score relief). Zero stays legal — a full reset is aggressive but still
 * relieves pressure.
 *
 * @param {unknown} value - Candidate ratio; any non-number or out-of-range
 *   value is rejected.
 * @returns {boolean} True for finite numbers in [0, 1) only. Never throws.
 */
export const isCooldownRatio = (value) => isFraction(value) && value < 1;

/** Per-knob validity rule; a knob failing its rule falls back to the preset value. */
const KNOB_RULES = Object.freeze({
  threshold: isPositive,
  half_life_hours: isPositive,
  weight_edits: isNonNegative,
  weight_diff: isNonNegative,
  weight_effort: isNonNegative,
  question_relief: isNonNegative,
  delegated_discount: isFraction,
  mute_window_ms: isNonNegative,
  category_mute_ms: isNonNegative,
  cooldown_ratio: isCooldownRatio,
});

const isMaxQuestions = (value) =>
  Number.isInteger(value) && value >= 1 && value <= 3;

// ---------------------------------------------------------------------------
// Migration input — sandbox names accepted ONLY from a persisted document and
// normalized on the way in. New programmatic setup input is canonical-only, so
// these aliases deliberately do not apply to mergeGuidedChoices.
// ---------------------------------------------------------------------------
const PRESET_ALIASES = Object.freeze({ conservative: "calm" });
const PAUSE_MODE_ALIASES = Object.freeze({
  choice_only: "choices",
  write_only: "freeform",
});
const KNOB_ALIASES = Object.freeze({
  THRESHOLD: "threshold",
  HALF_LIFE_HOURS: "half_life_hours",
  w_edits: "weight_edits",
  w_diff: "weight_diff",
  w_effort: "weight_effort",
  r_quest: "question_relief",
  MUTE_WINDOW_MS: "mute_window_ms",
  CATEGORY_MUTE_MS: "category_mute_ms",
});

/** Canonical knob → its sandbox name, for reading persisted documents. */
const SANDBOX_KNOB_NAMES = Object.freeze(
  Object.fromEntries(
    Object.entries(KNOB_ALIASES).map(([sandbox, canonical]) => [
      canonical,
      sandbox,
    ]),
  ),
);

const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

/**
 * Map any category name onto its top-level area using the BUILT-IN taxonomy: an
 * area maps to itself, a built-in subcategory maps to its area, anything else
 * to null. The five flat v01 category names all survive as subcategories, so
 * this doubles as the migration path for a sandbox `categories` list. Runtime
 * resolution goes through resolveCategory, which honors the user's pruning.
 *
 * @param {unknown} name - Candidate category or subcategory name.
 * @returns {string|null} Top-level area id, or null when unrecognized.
 */
function builtInAreaOf(name) {
  if (!isNonEmptyString(name)) {
    return null;
  }
  if (has(DEFAULT_SUBCATEGORIES, name)) {
    return name;
  }
  return (
    CATEGORIES.find((area) => DEFAULT_SUBCATEGORIES[area].includes(name)) ??
    null
  );
}

/** Normalize a `categories` list to deduped area ids; unknown names are dropped. */
function normalizeCategories(value) {
  if (!Array.isArray(value)) {
    return [...CATEGORIES];
  }
  const areas = [];
  for (const entry of value) {
    const area = builtInAreaOf(entry);
    if (area && !areas.includes(area)) {
      areas.push(area);
    }
  }
  return areas;
}

/** A fresh, mutable copy of the built-in subcategory vocabulary. */
function defaultSubcategories() {
  return Object.fromEntries(
    CATEGORIES.map((area) => [area, [...DEFAULT_SUBCATEGORIES[area]]]),
  );
}

/**
 * Normalize the per-area subcategory map. An area key present with an array
 * replaces that area's vocabulary — dropping entries narrows what the
 * classifier may emit, and `[]` prunes the area entirely. A missing key keeps
 * the built-in list, so a config written before an area existed still resolves.
 * Entries are free vocabulary: any non-empty string is kept, deduped.
 */
function normalizeSubcategories(value) {
  const map = defaultSubcategories();
  if (!isPlainObject(value)) {
    return map;
  }
  for (const area of CATEGORIES) {
    if (!Array.isArray(value[area])) {
      continue;
    }
    const subcategories = [];
    for (const entry of value[area]) {
      if (isNonEmptyString(entry) && !subcategories.includes(entry)) {
        subcategories.push(entry);
      }
    }
    map[area] = subcategories;
  }
  return map;
}

/**
 * Normalize the `advanced` escape hatch: recognized knobs with valid values
 * only. Sandbox knob names are translated, canonical names win when both are
 * present, and unknown or invalid knobs are dropped so they cannot reach a
 * runtime consumer.
 */
function normalizeAdvanced(value) {
  if (!isPlainObject(value)) {
    return {};
  }
  const advanced = {};
  for (const knob of KNOB_NAMES) {
    const alias = SANDBOX_KNOB_NAMES[knob];
    let candidate;
    if (has(value, knob)) {
      candidate = value[knob];
    } else if (alias && has(value, alias)) {
      candidate = value[alias];
    }
    if (KNOB_RULES[knob](candidate)) {
      advanced[knob] = candidate;
    }
  }
  return advanced;
}

/**
 * The built-in configuration — what an unconfigured project resolves to, and
 * the starting point of an explicit setup run.
 *
 * Critical paths are narrow on purpose. They hard-trigger a pause, so the
 * sandbox's broad `client`/`service` substrings hard-gated half a codebase.
 *
 * @returns {object} A fresh, fully mutable canonical configuration.
 */
export function defaultConfig() {
  return {
    enabled: true,
    preset: DEFAULT_PRESET,
    categories: [...CATEGORIES],
    subcategories: defaultSubcategories(),
    pause_mode: "hybrid",
    followup_draft: true,
    critical_paths: [
      "package.json",
      "auth",
      "migration",
      "dockerfile",
      "middleware",
    ],
    classifier_confidence_threshold: DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLD,
    classifier_model: DEFAULT_CLASSIFIER_MODEL,
    max_questions: 3,
    advanced: {},
  };
}

/** Resolve an enum value through its migration aliases; unknown → null. */
function normalizeEnum(value, allowed, aliases) {
  if (!isNonEmptyString(value)) {
    return null;
  }
  if (allowed.includes(value)) {
    return value;
  }
  return has(aliases, value) ? aliases[value] : null;
}

/**
 * Coerce any value into a complete canonical configuration: field-level
 * defaults for what is missing or invalid, document-level defaults for
 * anything that is not a JSON object. Sandbox names are accepted here — this
 * is the persisted-document boundary — and normalized to the public
 * vocabulary. The result contains only recognized fields with valid values, so
 * malformed data can never reach a later consumer.
 *
 * @param {unknown} value - A parsed configuration document, or anything else.
 * @returns {object} A canonical configuration. Never throws.
 */
export function normalizeConfig(value) {
  const config = defaultConfig();
  if (!isPlainObject(value)) {
    return config;
  }

  if (typeof value.enabled === "boolean") {
    config.enabled = value.enabled;
  }
  const preset = normalizeEnum(value.preset, PRESET_NAMES, PRESET_ALIASES);
  if (preset) {
    config.preset = preset;
  }
  if (Array.isArray(value.categories)) {
    config.categories = normalizeCategories(value.categories);
  }
  if (has(value, "subcategories")) {
    config.subcategories = normalizeSubcategories(value.subcategories);
  }
  const pauseMode = normalizeEnum(
    value.pause_mode,
    PAUSE_MODES,
    PAUSE_MODE_ALIASES,
  );
  if (pauseMode) {
    config.pause_mode = pauseMode;
  }
  if (typeof value.followup_draft === "boolean") {
    config.followup_draft = value.followup_draft;
  }
  if (Array.isArray(value.critical_paths)) {
    config.critical_paths = value.critical_paths.filter(isNonEmptyString);
  }
  if (isFraction(value.classifier_confidence_threshold)) {
    config.classifier_confidence_threshold =
      value.classifier_confidence_threshold;
  }
  if (isNonEmptyString(value.classifier_model)) {
    config.classifier_model = value.classifier_model;
  }
  if (isMaxQuestions(value.max_questions)) {
    config.max_questions = value.max_questions;
  }
  config.advanced = normalizeAdvanced(value.advanced);

  return config;
}

/**
 * Read the project's configuration, fail-silently. A missing or corrupt
 * document resolves to built-in defaults rather than throwing, because this
 * runs inside hooks that must never break the user's session. Reading creates
 * nothing: an unconfigured project stays unconfigured until setup writes.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @returns {object} A canonical configuration. Never throws.
 */
export function loadConfig(projectDir) {
  const result = readJsonFile(projectConfigPath(projectDir));
  return normalizeConfig(result.status === "ok" ? result.value : undefined);
}

/**
 * Persist the project configuration, atomically.
 *
 * The counterpart to `loadConfig`, and its deliberate opposite in failure
 * behavior: writing is only ever reached from an explicit foreground setup
 * run, so a failure throws for the caller to report rather than being
 * swallowed. Reading is what must never break a session; writing is what must
 * never lie about having succeeded.
 *
 * The value is normalized before serialization, so the document on disk is
 * canonical by construction — no caller can persist a shape that a later
 * `loadConfig` would have to repair. Writing is also the only thing that
 * brings the project's `.stoic` directory into existence.
 *
 * @param {string} projectDir - Project directory (absolute or relative to cwd).
 * @param {unknown} config - Configuration to persist; normalized first.
 * @throws {Error} When the filesystem write or rename fails.
 */
export function saveConfig(projectDir, config) {
  writeJsonFileAtomic(projectConfigPath(projectDir), normalizeConfig(config));
}

/**
 * Resolve which preset is in effect: a valid personal override wins, then the
 * committed team preset, then the built-in default. Personal state is passed
 * in rather than read here — state ownership lives in its own module.
 *
 * The personal layer is an override, not a default: state without a `preset`
 * is the normal case and is exactly what lets a committed team preset reach a
 * teammate.
 *
 * @param {object} [config] - Project configuration (canonical or raw).
 * @param {object} [state] - Personal engine state; `preset` is optional.
 * @returns {string} `calm`, `balanced`, or `vigilant`.
 */
export function effectivePreset(config, state) {
  const personal = isPlainObject(state)
    ? normalizeEnum(state.preset, PRESET_NAMES, PRESET_ALIASES)
    : null;
  const team = isPlainObject(config)
    ? normalizeEnum(config.preset, PRESET_NAMES, PRESET_ALIASES)
    : null;
  return personal ?? team ?? DEFAULT_PRESET;
}

/**
 * Expand the effective preset into scoring knobs, then apply recognized
 * `advanced` overrides last — the single place any consumer turns settings
 * into numbers, so setup, status, and hooks can never disagree.
 *
 * @param {object} [config] - Project configuration (canonical or raw).
 * @param {object} [state] - Personal engine state; `preset` is optional.
 * @returns {object} Every knob, resolved. Never throws.
 */
export function resolveKnobs(config, state) {
  const preset = PRESETS[effectivePreset(config, state)];
  const advanced = normalizeAdvanced(
    isPlainObject(config) ? config.advanced : undefined,
  );
  return { ...preset, ...advanced };
}

/**
 * The flat vocabulary the classifier may emit: every subcategory under an
 * ENABLED area. Empty when everything is disabled or pruned — the classifier
 * then has no vocabulary and every pause is vetoed.
 *
 * @param {object} [config] - Project configuration (canonical or raw).
 * @returns {string[]} Deduped subcategory names.
 */
export function allowedSubcategories(config) {
  const { categories, subcategories } = normalizeConfig(config);
  const allowed = [];
  for (const area of categories) {
    for (const subcategory of subcategories[area]) {
      if (!allowed.includes(subcategory)) {
        allowed.push(subcategory);
      }
    }
  }
  return allowed;
}

/**
 * Resolve a classifier-emitted name against the config's ENABLED areas and its
 * possibly pruned vocabulary. An enabled area resolves to itself; a listed
 * subcategory resolves to its area. Unknown, pruned, or disabled names resolve
 * to null, which the caller treats as "no decision" — a veto.
 *
 * @param {unknown} name - Category or subcategory name from a verdict.
 * @param {object} [config] - Project configuration (canonical or raw).
 * @returns {{category: string, subcategory: string|null}|null} Resolution, or null.
 */
export function resolveCategory(name, config) {
  if (!isNonEmptyString(name)) {
    return null;
  }
  const { categories, subcategories } = normalizeConfig(config);
  if (categories.includes(name)) {
    return { category: name, subcategory: null };
  }
  const area = categories.find((candidate) =>
    subcategories[candidate].includes(name),
  );
  return area ? { category: area, subcategory: name } : null;
}

/** Reject a guided choice with an actionable, foreground-safe error. */
function rejectChoice(field, expectation) {
  throw new Error(
    `Invalid setup choice for "${field}": expected ${expectation}.`,
  );
}

/**
 * Decode a comma-separated decision-area list.
 *
 * An empty string is an ANSWER, not an omission: it is how the user says they
 * deselected every area, which `mergeGuidedChoices` turns into a global mute.
 * Conflating it with "not provided" would silently ignore the one choice a
 * user is most entitled to make.
 */
function readCategoryList(raw, field) {
  if (typeof raw !== "string") {
    rejectChoice(field, `a comma-separated list of ${CATEGORIES.join(", ")}`);
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return [];
  }
  return trimmed.split(",").map((entry) => entry.trim());
}

function readBoolean(raw, field) {
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return rejectChoice(field, "true or false");
}

/** Enum answers travel as themselves; `mergeGuidedChoices` judges the value. */
function readVerbatim(raw) {
  return raw;
}

/**
 * The guided-choice table — the one description of what setup asks about.
 *
 * Each row names a field the guided flow owns and how to decode that answer
 * from the text form a CLI caller transmits it in. Everything else about
 * setup's surface is derived from these keys rather than re-typed: the CLI's
 * flags, its completeness check, and the unknown-field rejection below. A
 * fifth guided question therefore costs one row here and NO change to the CLI,
 * which is the property that keeps a prompt, a CLI, and this model from
 * drifting apart.
 *
 * It does still need its own assignment branch in `mergeGuidedChoices` — the
 * surface derives, the merge does not. A row added without that branch is
 * accepted and then silently ignored, so add both or neither.
 *
 * `read` decodes SHAPE only — text to value. Which values are *supported* is
 * `mergeGuidedChoices`'s judgment, so every enum keeps exactly one validator
 * and this table can never become a second, quieter one.
 */
export const GUIDED_CHOICES = Object.freeze({
  preset: Object.freeze({ read: readVerbatim }),
  categories: Object.freeze({ read: readCategoryList }),
  pause_mode: Object.freeze({ read: readVerbatim }),
  followup_draft: Object.freeze({ read: readBoolean }),
});

/** The fields guided setup owns; everything else in a config is hand-tuned. */
const GUIDED_FIELDS = Object.freeze(Object.keys(GUIDED_CHOICES));

/**
 * Apply guided setup answers to a configuration, immutably.
 *
 * Only the fields the guided flow owns can change; every hand-tuned field —
 * pruned subcategories, critical paths, classifier settings, question limits,
 * advanced overrides — is preserved, so a friendly reconfiguration is never
 * destructive. Omitted choices keep their current value, which is what makes
 * changing exactly one answer safe.
 *
 * Unlike a persisted document, guided input is canonical-only: sandbox names
 * are a validation error here, not an alias. Setup is a foreground operation,
 * so invalid input throws and the caller writes nothing rather than silently
 * persisting something the user did not ask for.
 *
 * @param {object} [config] - Current configuration; normalized before merging.
 * @param {object} [choices] - Any of `preset`, `categories`, `pause_mode`,
 *   `followup_draft`. `enabled` is derived from `categories`, never passed.
 * @returns {object} A new canonical configuration; inputs are not mutated.
 * @throws {Error} When a choice is unknown, unsupported, or malformed.
 */
export function mergeGuidedChoices(config, choices) {
  const merged = normalizeConfig(config);
  if (!isPlainObject(choices)) {
    rejectChoice("choices", "an object of guided answers");
  }

  const unknown = Object.keys(choices).find(
    (field) => !GUIDED_FIELDS.includes(field),
  );
  if (unknown) {
    rejectChoice(unknown, `one of ${GUIDED_FIELDS.join(", ")}`);
  }

  if (has(choices, "preset")) {
    if (!PRESET_NAMES.includes(choices.preset)) {
      rejectChoice("preset", `one of ${PRESET_NAMES.join(", ")}`);
    }
    merged.preset = choices.preset;
  }

  if (has(choices, "pause_mode")) {
    if (!PAUSE_MODES.includes(choices.pause_mode)) {
      rejectChoice("pause_mode", `one of ${PAUSE_MODES.join(", ")}`);
    }
    merged.pause_mode = choices.pause_mode;
  }

  if (has(choices, "followup_draft")) {
    if (typeof choices.followup_draft !== "boolean") {
      rejectChoice("followup_draft", "true or false");
    }
    merged.followup_draft = choices.followup_draft;
  }

  if (has(choices, "categories")) {
    if (!Array.isArray(choices.categories)) {
      rejectChoice("categories", `an array of ${CATEGORIES.join(", ")}`);
    }
    const invalid = choices.categories.find(
      (area) => !CATEGORIES.includes(area),
    );
    if (invalid !== undefined) {
      rejectChoice("categories", `only ${CATEGORIES.join(", ")}`);
    }
    merged.categories = [...new Set(choices.categories)];
    // Choosing no areas is a deliberate way to mute the plugin; choosing any
    // area turns it back on.
    merged.enabled = merged.categories.length > 0;
  }

  return merged;
}
