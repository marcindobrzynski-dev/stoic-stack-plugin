// Offline evaluation harness for the structured-state Jev classifier pipeline.
//
// Runs the real pipeline modules (`buildTurnGroup`, `scoreTurn`,
// `relievedScore`, `classifyTurn`, `combineProbabilities`, `buildVerdict`,
// `runJev`, `classify`, `decideFire`) over synthetic fixtures (`SIMULATED`)
// with stubs injected through existing parameter seams, and optionally replays
// read-only field logs (`local-trace.jsonl`, `jev-experiment.jsonl`, and human
// labels) under `"data_label": "REAL-DATA"`.
//
// Zero dependencies (Node.js built-ins only) and zero live Claude, Sonnet,
// Jev, or TypeSafe network calls.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §Offline evaluation harness output (`experiments/jev/eval/run-eval.js`).
//
// Experiment only (`feature/jev-classifier-experiment`, never merged).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { buildTurnGroup } from "../../../src/core/group.js";
import {
  clampFinite,
  isFiniteNumber,
  isNonEmptyString,
  isPlainObject,
} from "../../../src/core/predicates.js";
import {
  decayScore,
  relievedScore,
  scoreTurn,
} from "../../../src/core/scoring.js";
import { decideFire } from "../../../src/hooks/stop-decision.js";
import {
  buildClassificationPrompt,
  VETO_REASONS,
} from "../../../src/io/classifier.js";
import {
  AUTO_ACCEPT_MULTIPLIER,
  configuredConfidenceFloor,
  DIFF_LINE_CAP,
  EDIT_COUNT_CAP,
  normalizeConfig,
  PRESET_NAMES,
  resolveKnobs,
} from "../../../src/io/config/config.js";
import { CATEGORY_REGISTRY } from "../categories/index.js";
import {
  FALLBACK_MODEL,
  FALLBACK_TIMEOUT_MS,
  PAUSE_THRESHOLDS,
  STATE_MODEL,
  STATE_TIMEOUT_MS,
  SUMMARY_SCHEMA_VERSION,
  VETO_COOLDOWN_RATIO,
} from "../constants.js";
import {
  joinSummaryWithLocalTrace,
  parseSummaryLine,
  parseTimestampMs,
} from "../log.js";
import { classifyTurn, combineProbabilities } from "../run.js";
import { runJev } from "../runner.js";
import { JEV_TIMEOUT_MS, MARGIN_MS, SDK_TIMEOUT_MS } from "../timing.js";

/** Data label carried by all synthetic fixture evaluation objects. */
export const SIMULATED_DATA_LABEL = "SIMULATED";

/** Data label carried by logged real summary lines. */
export const REAL_DATA_LABEL = "REAL-DATA";

/**
 * Data label for counterfactual scores and call counts replayed over real
 * traces. The traces are real; the cooled trajectory is a projection.
 */
export const REPLAY_PROJECTION_LABEL = "REAL-DATA (replay projection)";

/** Stop hook wall-clock timeout in `hooks/hooks.json` (90 seconds). */
export const STOP_HOOK_TIMEOUT_MS = 90_000;

/** Default child spawn and JSON IPC framing overhead in milliseconds. */
export const DEFAULT_IPC_OVERHEAD_MS = 12;

/** Ordered histogram bin keys for `pause_probability` in [0, 1]. */
export const PAUSE_PROBABILITY_BINS = Object.freeze([
  "0.0-0.2",
  "0.2-0.4",
  "0.4-0.6",
  "0.6-0.8",
  "0.8-1.0",
]);

/** Required formula input keys for recomputing the v3 pause formula. */
const FORMULA_INPUT_KEYS = Object.freeze([
  "decision_weight",
  "decision_ownership",
  "developer_reflection",
  "developer_intent",
]);

/** Administrative Stop outcomes that are neither scored nor classified. */
const ADMINISTRATIVE_STOP_OUTCOMES = Object.freeze([
  "disabled",
  "malformed_input",
  "continuation_truncated",
  "no_project_root",
  "error",
]);

/** Dummy API key written only inside a temporary sandbox directory. */
const SANDBOX_DUMMY_API_KEY = "ts_synthetic_offline_eval_stub_key";

/** Rounding factor for summary ratios and rates (4 decimal places). */
const RATE_ROUND_SCALE = 10_000;

/**
 * Round a finite number to 4 decimal places for stable metric reporting.
 *
 * @param {number} value - Raw numeric value.
 * @returns {number} Rounded number.
 */
function roundMetric(value) {
  if (!isFiniteNumber(value)) {
    return 0;
  }
  return Math.round(value * RATE_ROUND_SCALE) / RATE_ROUND_SCALE;
}

/**
 * Round a finite duration in milliseconds to an integer, or return null.
 *
 * @param {unknown} value - Duration in milliseconds.
 * @returns {number|null} Rounded integer milliseconds, or null.
 */
function roundDurationMs(value) {
  if (!isFiniteNumber(value)) {
    return null;
  }
  return Math.round(value);
}

/**
 * Map a `pause_probability` in [0, 1] to its histogram bin key.
 *
 * @param {number} probability - Probability in [0, 1].
 * @returns {string} Bin identifier from `PAUSE_PROBABILITY_BINS`.
 */
function probabilityBinOf(probability) {
  const clamped = clampFinite(probability, 0, 1);
  if (clamped < 0.2) {
    return "0.0-0.2";
  }
  if (clamped < 0.4) {
    return "0.2-0.4";
  }
  if (clamped < 0.6) {
    return "0.4-0.6";
  }
  if (clamped < 0.8) {
    return "0.6-0.8";
  }
  return "0.8-1.0";
}

/**
 * Build an injectable TypeSafe SDK stub with `noul` and `choice` builders.
 *
 * @returns {{ noul: Function, choice: Function }} Stubbed SDK builders.
 */
function createStubbedSdk() {
  return {
    noul(instructions, criteria) {
      return { type: "noul", instructions, criteria };
    },
    choice(instructions, choices) {
      return { type: "choice", instructions, choices };
    },
  };
}

/**
 * Match a `client.systemOne` request payload back to its category in
 * `CATEGORY_REGISTRY` by comparing question keys.
 *
 * @param {unknown} questionsPayload - `requestPayload.questions` passed to `systemOne`.
 * @param {readonly object[]} [registry] - Active category registry.
 * @returns {string|null} Matching category name, or null.
 */
function identifyCategoryFromQuestions(
  questionsPayload,
  registry = CATEGORY_REGISTRY,
) {
  if (!isPlainObject(questionsPayload)) {
    return null;
  }
  const payloadKeys = Object.keys(questionsPayload).sort().join(",");
  for (const category of registry) {
    const categoryKeys = Object.keys(category.questions).sort().join(",");
    if (payloadKeys === categoryKeys) {
      return category.name;
    }
  }
  return null;
}

/**
 * Create a stubbed TypeSafe client (`{ systemOne }`) driven by a fixture turn's
 * `stubbed_jev` specification. Never makes network calls.
 *
 * @param {object} stubbedJev - Fixture turn's `stubbed_jev` specification.
 * @param {readonly object[]} [registry] - Active category registry.
 * @returns {{ systemOne: Function }} Injectable client for `classifyTurn`.
 */
function createStubbedClient(stubbedJev, registry = CATEGORY_REGISTRY) {
  const categoriesSpec = isPlainObject(stubbedJev?.categories)
    ? stubbedJev.categories
    : {};
  const modelVersion = isNonEmptyString(stubbedJev?.model_version)
    ? stubbedJev.model_version
    : "jev-synthetic-v3";

  return {
    systemOne(requestPayload) {
      const categoryName = identifyCategoryFromQuestions(
        requestPayload?.questions,
        registry,
      );
      const spec =
        categoryName && isPlainObject(categoriesSpec[categoryName])
          ? categoriesSpec[categoryName]
          : null;

      if (!spec) {
        const missingError = new Error("Missing synthetic category stub");
        missingError.name = "MissingStubError";
        return Promise.reject(missingError);
      }

      if (isNonEmptyString(spec.error)) {
        const simulatedError = new Error(
          `Synthetic category failure: ${spec.error}`,
        );
        simulatedError.name = spec.error;
        return Promise.reject(simulatedError);
      }

      return Promise.resolve({
        model: modelVersion,
        answers: isPlainObject(spec.answers) ? spec.answers : {},
      });
    },
  };
}

/**
 * Append one synthetic turn's human prompt and assistant response/edits to a
 * transcript JSONL file in the format `readTurns` consumes.
 *
 * @param {string} transcriptPath - Path to the temporary transcript JSONL file.
 * @param {object} turnSpec - Fixture turn specification.
 */
function appendSyntheticTranscriptTurn(transcriptPath, turnSpec) {
  const transcriptTurn = isPlainObject(turnSpec.transcript_turn)
    ? turnSpec.transcript_turn
    : {};
  const promptText =
    typeof transcriptTurn.prompt === "string"
      ? transcriptTurn.prompt
      : "synthetic prompt";
  const answerText =
    typeof transcriptTurn.answer === "string"
      ? transcriptTurn.answer
      : "synthetic answer";
  const rawChanges = Array.isArray(transcriptTurn.changes)
    ? transcriptTurn.changes
    : [];

  const userLine = {
    type: "user",
    promptId: turnSpec.prompt_id ?? null,
    origin: { kind: "human" },
    message: { content: promptText },
  };

  const assistantBlocks = [{ type: "text", text: answerText }];
  for (const change of rawChanges) {
    if (isPlainObject(change) && isNonEmptyString(change.file_path)) {
      assistantBlocks.push({
        type: "tool_use",
        name: "Edit",
        input: {
          file_path: change.file_path,
          new_string:
            typeof change.new_string === "string" ? change.new_string : "",
        },
      });
    }
  }

  const assistantLine = {
    type: "assistant",
    message: { content: assistantBlocks },
  };

  fs.appendFileSync(
    transcriptPath,
    `${JSON.stringify(userLine)}\n${JSON.stringify(assistantLine)}\n`,
    "utf8",
  );
}

/**
 * Check whether `decideFire` will invoke the classifier on a turn by passing a
 * side-effect-free probe runner. Because `decideFire` is pure, this probe
 * mutates nothing and duplicates zero gate logic.
 *
 * @param {object} personalState - `{ score, preset, mutes }`.
 * @param {object} config - Canonical project configuration.
 * @param {object} group - Turn group from `buildTurnGroup`.
 * @param {object} turnContext - Turn context object.
 * @returns {boolean} True when the hard or soft gate fires and reaches `classify`.
 */
function willReachClassifier(personalState, config, group, turnContext) {
  let reached = false;
  decideFire(personalState, config, group, turnContext, {
    runner() {
      reached = true;
      return { status: "unavailable" };
    },
  });
  return reached;
}

/**
 * Resolve the known classifier confidence for a turn decision, returning a
 * rounded number when confidence is genuinely known and `null` only when the
 * classifier never produced a numeric confidence (`below_gates`,
 * `no_classification`, or `category_failed`).
 *
 * @param {object} decision - Return value from `decideFire`.
 * @param {object|null} prepared - Prepared classification outcome, if called.
 * @returns {number|null} Rounded confidence in [0, 1], or null when unknown.
 */
function resolveDecisionConfidence(decision, prepared) {
  if (!isPlainObject(decision) || decision.outcome === "below_gates") {
    return null;
  }
  if (prepared?.isCategoryFailed === true) {
    return null;
  }
  if (isFiniteNumber(decision.classification?.confidence)) {
    return roundMetric(decision.classification.confidence);
  }
  if (isFiniteNumber(prepared?.verdictConfidence)) {
    return roundMetric(prepared.verdictConfidence);
  }
  return null;
}

/**
 * Run one turn's classification through the real `classifyTurn` and `runJev`
 * functions with deterministic stubbed runners and timings.
 *
 * Models `runnerTotalMs` (the Jev SDK evaluation span plus any fallback CLI
 * span) separately from `endToEndMs` (Sonnet structured-state extraction +
 * `runnerTotalMs` + child spawn/IPC overhead).
 *
 * @param {object} params - Turn classification parameters.
 * @param {object} params.turnSpec - Fixture turn specification.
 * @param {object} params.group - Assembled turn group.
 * @param {object} params.config - Canonical configuration for the active preset.
 * @param {object} params.personalState - Personal state `{ score, preset }`.
 * @param {object} params.turnContext - Turn context `{ stopInput, projectDir, ... }`.
 * @param {string} params.homeDir - Sandbox home directory.
 * @returns {Promise<{
 *   runnerFn: Function,
 *   sonnetMs: number,
 *   jevMs: number,
 *   categoriesMs: Record<string, number|null>,
 *   fallbackMs: number|null,
 *   overheadMs: number,
 *   runnerTotalMs: number,
 *   endToEndMs: number,
 *   pauseProbability: number|null,
 *   verdictConfidence: number|null,
 *   verdictSubcategory: string|null,
 *   isCategoryFailed: boolean,
 *   getProvider: Function,
 * }>} Prepared runner function and deterministic latency breakdown.
 */
async function prepareStubbedTurnClassification({
  turnSpec,
  group,
  config,
  personalState,
  turnContext,
  homeDir,
}) {
  const prompt = buildClassificationPrompt(group, config);
  const sonnetSpec = isPlainObject(turnSpec.stubbed_sonnet)
    ? turnSpec.stubbed_sonnet
    : {};
  const jevSpec = isPlainObject(turnSpec.stubbed_jev)
    ? turnSpec.stubbed_jev
    : {};
  const fallbackSpec = isPlainObject(turnSpec.stubbed_fallback)
    ? turnSpec.stubbed_fallback
    : null;

  const sonnetMs = roundDurationMs(
    isFiniteNumber(sonnetSpec.latency_ms) ? sonnetSpec.latency_ms : 0,
  );
  const categoriesMs = {};
  for (const category of CATEGORY_REGISTRY) {
    const rawCatMs = jevSpec.categories?.[category.name]?.latency_ms;
    categoriesMs[category.name] = isFiniteNumber(rawCatMs)
      ? roundDurationMs(rawCatMs)
      : null;
  }
  const maxCategoryMs = Math.max(
    0,
    ...Object.values(categoriesMs).filter((value) => isFiniteNumber(value)),
  );
  const jevMs = roundDurationMs(
    isFiniteNumber(jevSpec.jev_ms) ? jevSpec.jev_ms : maxCategoryMs,
  );
  const overheadMs = roundDurationMs(
    isFiniteNumber(turnSpec.ipc_overhead_ms)
      ? turnSpec.ipc_overhead_ms
      : DEFAULT_IPC_OVERHEAD_MS,
  );

  const stateRunner = () => ({
    status: isNonEmptyString(sonnetSpec.status) ? sonnetSpec.status : "ok",
    value: sonnetSpec.state,
    ...(isNonEmptyString(sonnetSpec.reason)
      ? { reason: sonnetSpec.reason }
      : {}),
  });

  const childOutcome = await classifyTurn(
    {
      prompt,
      model: config.classifier_model,
      group,
      context: { ...turnContext, score_before: personalState.score },
    },
    {
      stateRunner,
      sdk: createStubbedSdk(),
      client: createStubbedClient(jevSpec, CATEGORY_REGISTRY),
      config,
      personalState,
      homeDir,
    },
  );

  // Stamp the fixture's deterministic stubbed timings onto child.log so
  // summary lines and latency budget calculations are reproducible.
  childOutcome.log = {
    ...childOutcome.log,
    sonnet_ms: sonnetMs,
    jev_ms: jevMs,
    category_latency_ms: categoriesMs,
  };

  const childSucceeded =
    childOutcome.status === "ok" && isPlainObject(childOutcome.value);
  let fallbackMs = null;
  if (!childSucceeded) {
    if (isFiniteNumber(fallbackSpec?.latency_ms)) {
      fallbackMs = roundDurationMs(fallbackSpec.latency_ms);
    } else {
      fallbackMs = 0;
    }
  }
  const runnerTotalMs = roundDurationMs(jevMs + (fallbackMs ?? 0));
  const endToEndMs = roundDurationMs(sonnetMs + runnerTotalMs + overheadMs);

  const allFourPresent =
    isPlainObject(childOutcome.probabilities) &&
    CATEGORY_REGISTRY.every((category) =>
      isFiniteNumber(childOutcome.probabilities[category.name]),
    );
  const pauseProbability = allFourPresent
    ? roundMetric(
        combineProbabilities(childOutcome.probabilities).pauseProbability,
      )
    : null;

  const hasCategoryError =
    isPlainObject(childOutcome.log?.category_errors) &&
    Object.values(childOutcome.log.category_errors).some((errorEntry) =>
      isNonEmptyString(errorEntry),
    );
  const isCategoryFailed =
    childSucceeded &&
    (childOutcome.log?.status === "category_failed" ||
      hasCategoryError ||
      (typeof childOutcome.value?.reason === "string" &&
        childOutcome.value.reason.startsWith("jev: category_failed")));

  let verdictConfidence = null;
  if (!isCategoryFailed) {
    if (isFiniteNumber(childOutcome.value?.confidence)) {
      verdictConfidence = roundMetric(childOutcome.value.confidence);
    } else if (isFiniteNumber(fallbackSpec?.result?.value?.confidence)) {
      verdictConfidence = roundMetric(fallbackSpec.result.value.confidence);
    }
  }
  let verdictSubcategory = null;
  if (isNonEmptyString(childOutcome.value?.subcategory)) {
    verdictSubcategory = childOutcome.value.subcategory;
  } else if (isNonEmptyString(fallbackSpec?.result?.value?.subcategory)) {
    verdictSubcategory = fallbackSpec.result.value.subcategory;
  }

  let capturedProvider = null;

  const runnerFn = (classificationPrompt, runnerOptions) => {
    const runResult = runJev(classificationPrompt, {
      ...runnerOptions,
      homeDir,
      spawn() {
        return {
          status: childSucceeded ? 0 : 1,
          stdout: `${JSON.stringify(childOutcome)}\n`,
          stderr: "",
        };
      },
      fallback() {
        if (isPlainObject(fallbackSpec?.result)) {
          return fallbackSpec.result;
        }
        return { status: "unavailable", reason: "no_fallback_stub" };
      },
    });
    capturedProvider = runResult.provider ?? null;
    return runResult;
  };

  return {
    runnerFn,
    classificationScoreBefore: roundMetric(personalState.score),
    sonnetMs,
    jevMs,
    categoriesMs,
    fallbackMs,
    overheadMs,
    runnerTotalMs,
    endToEndMs,
    pauseProbability,
    verdictConfidence,
    verdictSubcategory,
    isCategoryFailed,
    getProvider: () => capturedProvider,
  };
}

/**
 * Load all synthetic fixture JSON files from a directory, sorted by filename.
 *
 * @param {string} fixturesDir - Directory containing `synthetic-*.json` files.
 * @returns {object[]} Parsed synthetic fixture objects.
 */
export function loadSyntheticFixtures(fixturesDir) {
  const entries = fs
    .readdirSync(fixturesDir)
    .filter((fileName) => fileName.endsWith(".json"))
    .sort();

  const fixtures = [];
  for (const fileName of entries) {
    const fullPath = path.join(fixturesDir, fileName);
    const parsed = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    if (isPlainObject(parsed) && Array.isArray(parsed.turns)) {
      fixtures.push({
        file_name: fileName,
        ...parsed,
      });
    }
  }
  return fixtures;
}

/**
 * Evaluate all synthetic fixtures for a single preset (`calm`, `balanced`, or
 * `vigilant`) using the real pipeline modules and comparing the `0.8` veto
 * cooldown against the `e4b111e` baseline where vetoes leave score unchanged.
 *
 * @param {object[]} fixtures - Loaded synthetic fixtures.
 * @param {string} preset - Preset name (`calm`, `balanced`, or `vigilant`).
 * @returns {Promise<object>} Per-preset `SIMULATED` evaluation metrics.
 */
export async function evaluatePresetOnFixtures(fixtures, preset) {
  const sandboxRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), `stoic-jev-eval-${preset}-`),
  );
  const projectDir = path.join(sandboxRoot, "project");
  const homeDir = path.join(sandboxRoot, "home");

  fs.mkdirSync(path.join(projectDir, ".stoic"), { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, ".stoic", ".env"),
    `TYPESAFE_API_KEY=${SANDBOX_DUMMY_API_KEY}\n`,
    "utf8",
  );

  try {
    const config = normalizeConfig({
      preset,
      classifier_model: "jev-latest",
    });
    const scoringKnobs = {
      ...resolveKnobs(config, { preset }),
      edit_count_cap: EDIT_COUNT_CAP,
      diff_line_cap: DIFF_LINE_CAP,
      auto_accept_multiplier: AUTO_ACCEPT_MULTIPLIER,
    };
    const threshold = scoringKnobs.threshold;
    const pauseCooldownRatio = scoringKnobs.cooldown_ratio;

    const vetoReasonCounts = {
      no_classification: 0,
      no_decision: 0,
      category_failed: 0,
      low_confidence: 0,
      bad_category: 0,
      total_vetoes: 0,
    };
    const histogramBins = Object.fromEntries(
      PAUSE_PROBABILITY_BINS.map((bin) => [bin, 0]),
    );
    const observedProbabilities = [];
    let nullProbabilityCount = 0;

    const scoreTrajectory = [];
    const perTurnLatency = [];
    const caseOutcomes = {};

    let totalTurns = 0;
    let pauseCount = 0;
    let callsWithVetoCooldown = 0;
    let callsBaselineNoVetoCooldown = 0;

    for (const fixture of fixtures) {
      const caseId = fixture.case_id ?? fixture.file_name;
      const transcriptPath = path.join(
        sandboxRoot,
        `transcript-${String(caseId).replace(/[^A-Za-z0-9_-]/g, "-")}.jsonl`,
      );
      fs.writeFileSync(transcriptPath, "", "utf8");

      let currentScoreWithCooldown = isFiniteNumber(fixture.initial_score)
        ? fixture.initial_score
        : 0;
      let currentScoreBaseline = currentScoreWithCooldown;

      const caseTurns = [];

      for (const turnSpec of fixture.turns) {
        totalTurns += 1;
        appendSyntheticTranscriptTurn(transcriptPath, turnSpec);

        const group = buildTurnGroup(turnSpec.events);
        const elapsedMs = isFiniteNumber(turnSpec.elapsed_ms)
          ? turnSpec.elapsed_ms
          : 0;

        // 1. Primary trajectory: with veto cooldown (0.8 * threshold)
        const scoreBeforeCooldown = scoreTurn(
          currentScoreWithCooldown,
          elapsedMs,
          group,
          scoringKnobs,
        );
        const stopInput = {
          session_id: turnSpec.session_id ?? `session-${caseId}`,
          prompt_id: turnSpec.prompt_id ?? null,
          transcript_path: transcriptPath,
          cwd: projectDir,
          last_assistant_message: turnSpec.transcript_turn?.answer ?? "",
        };
        const turnContext = {
          stopInput,
          projectDir,
          homeDir,
          prompt_id: turnSpec.prompt_id ?? null,
          session_id: stopInput.session_id,
          turn_ts: turnSpec.turn_ts ?? "2026-10-18T10:00:00.000Z",
        };
        const personalStateWithCooldown = {
          score: scoreBeforeCooldown,
          preset,
          mutes: Array.isArray(turnSpec.mutes) ? turnSpec.mutes : [],
        };

        const gateReachedForCooldown = willReachClassifier(
          personalStateWithCooldown,
          config,
          group,
          turnContext,
        );

        let preparedCooldown = null;
        let decisionWithCooldown;

        if (gateReachedForCooldown) {
          preparedCooldown = await prepareStubbedTurnClassification({
            turnSpec,
            group,
            config,
            personalState: personalStateWithCooldown,
            turnContext,
            homeDir,
          });
          decisionWithCooldown = decideFire(
            personalStateWithCooldown,
            config,
            group,
            turnContext,
            { runner: preparedCooldown.runnerFn },
          );
        } else {
          decisionWithCooldown = decideFire(
            personalStateWithCooldown,
            config,
            group,
            turnContext,
          );
        }

        const classifierCalledWithCooldown =
          gateReachedForCooldown && decisionWithCooldown.outcome !== "muted";
        if (classifierCalledWithCooldown) {
          callsWithVetoCooldown += 1;
        }

        const scoreAfterCooldown = isFiniteNumber(
          decisionWithCooldown.cooled_score,
        )
          ? decisionWithCooldown.cooled_score
          : scoreBeforeCooldown;
        currentScoreWithCooldown = scoreAfterCooldown;

        let cooldownVetoBucket = null;
        if (decisionWithCooldown.outcome === "fire") {
          pauseCount += 1;
        } else if (decisionWithCooldown.outcome === "veto") {
          vetoReasonCounts.total_vetoes += 1;
          if (
            decisionWithCooldown.reason === "no_decision" &&
            preparedCooldown?.isCategoryFailed === true
          ) {
            vetoReasonCounts.category_failed += 1;
            cooldownVetoBucket = "category_failed";
          } else if (VETO_REASONS.includes(decisionWithCooldown.reason)) {
            vetoReasonCounts[decisionWithCooldown.reason] += 1;
            cooldownVetoBucket = decisionWithCooldown.reason;
          }
        }

        const turnPauseProbability = preparedCooldown
          ? preparedCooldown.pauseProbability
          : null;
        if (isFiniteNumber(turnPauseProbability)) {
          histogramBins[probabilityBinOf(turnPauseProbability)] += 1;
          observedProbabilities.push(turnPauseProbability);
        } else {
          nullProbabilityCount += 1;
        }

        // 2. Baseline trajectory (e4b111e): computes its own classification
        // decision from personalStateBaseline and never reuses preparedCooldown.
        const scoreBeforeBaseline = scoreTurn(
          currentScoreBaseline,
          elapsedMs,
          group,
          scoringKnobs,
        );
        const personalStateBaseline = {
          score: scoreBeforeBaseline,
          preset,
          mutes: Array.isArray(turnSpec.mutes) ? turnSpec.mutes : [],
        };
        const gateReachedForBaseline = willReachClassifier(
          personalStateBaseline,
          config,
          group,
          turnContext,
        );

        let preparedBaseline = null;
        let decisionBaseline;
        if (gateReachedForBaseline) {
          preparedBaseline = await prepareStubbedTurnClassification({
            turnSpec,
            group,
            config,
            personalState: personalStateBaseline,
            turnContext,
            homeDir,
          });
          decisionBaseline = decideFire(
            personalStateBaseline,
            config,
            group,
            turnContext,
            { runner: preparedBaseline.runnerFn },
          );
        } else {
          decisionBaseline = decideFire(
            personalStateBaseline,
            config,
            group,
            turnContext,
          );
        }

        const classifierCalledBaseline =
          gateReachedForBaseline && decisionBaseline.outcome !== "muted";
        if (classifierCalledBaseline) {
          callsBaselineNoVetoCooldown += 1;
        }

        let baselineVetoBucket = null;
        if (decisionBaseline.outcome === "veto") {
          if (
            decisionBaseline.reason === "no_decision" &&
            preparedBaseline?.isCategoryFailed === true
          ) {
            baselineVetoBucket = "category_failed";
          } else {
            baselineVetoBucket = decisionBaseline.reason;
          }
        }

        // In e4b111e, only `fire` cools the score (to 0.5 * threshold);
        // `veto` leaves the score unchanged.
        const scoreAfterBaseline =
          decisionBaseline.outcome === "fire" &&
          isFiniteNumber(decisionBaseline.cooled_score)
            ? decisionBaseline.cooled_score
            : scoreBeforeBaseline;
        currentScoreBaseline = scoreAfterBaseline;

        const provider = preparedCooldown
          ? preparedCooldown.getProvider()
          : null;
        const endToEndMs = preparedCooldown ? preparedCooldown.endToEndMs : 0;
        const sonnetMs = preparedCooldown ? preparedCooldown.sonnetMs : null;
        const jevMs = preparedCooldown ? preparedCooldown.jevMs : null;
        const categoriesMs = preparedCooldown
          ? preparedCooldown.categoriesMs
          : null;
        const fallbackMs = preparedCooldown
          ? preparedCooldown.fallbackMs
          : null;
        const overheadMs = preparedCooldown
          ? preparedCooldown.overheadMs
          : null;
        const runnerTotalMs = preparedCooldown
          ? preparedCooldown.runnerTotalMs
          : 0;

        const cooldownConfidence = resolveDecisionConfidence(
          decisionWithCooldown,
          preparedCooldown,
        );
        const baselineConfidence = resolveDecisionConfidence(
          decisionBaseline,
          preparedBaseline,
        );

        const trajectoryEntry = {
          case_id: caseId,
          turn_id: turnSpec.turn_id,
          prompt_id: turnSpec.prompt_id ?? null,
          preset,
          threshold,
          pause_cooldown_ratio: roundMetric(pauseCooldownRatio),
          veto_cooldown_ratio: roundMetric(VETO_COOLDOWN_RATIO),
          with_veto_cooldown: {
            score_before: roundMetric(scoreBeforeCooldown),
            classified_score_before: preparedCooldown
              ? preparedCooldown.classificationScoreBefore
              : null,
            outcome: decisionWithCooldown.outcome,
            veto_reason:
              decisionWithCooldown.outcome === "veto"
                ? decisionWithCooldown.reason
                : null,
            veto_bucket: cooldownVetoBucket,
            category_failed: preparedCooldown?.isCategoryFailed === true,
            pause_probability: turnPauseProbability,
            confidence: cooldownConfidence,
            subcategory:
              decisionWithCooldown.classification?.subcategory ??
              preparedCooldown?.verdictSubcategory ??
              null,
            provider,
            classifier_called: classifierCalledWithCooldown,
            score_after: roundMetric(scoreAfterCooldown),
          },
          baseline_e4b111e_no_veto_cooldown: {
            score_before: roundMetric(scoreBeforeBaseline),
            classified_score_before: preparedBaseline
              ? preparedBaseline.classificationScoreBefore
              : null,
            outcome: decisionBaseline.outcome,
            veto_reason:
              decisionBaseline.outcome === "veto"
                ? decisionBaseline.reason
                : null,
            veto_bucket: baselineVetoBucket,
            category_failed: preparedBaseline?.isCategoryFailed === true,
            pause_probability: preparedBaseline
              ? preparedBaseline.pauseProbability
              : null,
            confidence: baselineConfidence,
            subcategory:
              decisionBaseline.classification?.subcategory ??
              preparedBaseline?.verdictSubcategory ??
              null,
            provider: preparedBaseline ? preparedBaseline.getProvider() : null,
            classifier_called: classifierCalledBaseline,
            score_after: roundMetric(scoreAfterBaseline),
          },
        };
        scoreTrajectory.push(trajectoryEntry);
        caseTurns.push(trajectoryEntry);

        perTurnLatency.push({
          case_id: caseId,
          turn_id: turnSpec.turn_id,
          classifier_called: classifierCalledWithCooldown,
          provider,
          sonnet_ms: sonnetMs,
          jev_ms: jevMs,
          categories_ms: categoriesMs,
          fallback_ms: fallbackMs,
          ipc_overhead_ms: overheadMs,
          runner_total_ms: runnerTotalMs,
          end_to_end_ms: endToEndMs,
          within_jev_timeout:
            sonnetMs === null || jevMs === null
              ? true
              : sonnetMs + jevMs <= JEV_TIMEOUT_MS,
          within_hook_budget: endToEndMs <= STOP_HOOK_TIMEOUT_MS,
          remaining_hook_budget_ms: STOP_HOOK_TIMEOUT_MS - endToEndMs,
        });
      }

      caseOutcomes[caseId] = {
        data_label: SIMULATED_DATA_LABEL,
        case_id: caseId,
        turn_count: caseTurns.length,
        paused_turns: caseTurns.filter(
          (entry) => entry.with_veto_cooldown.outcome === "fire",
        ).length,
        vetoed_turns: caseTurns.filter(
          (entry) => entry.with_veto_cooldown.outcome === "veto",
        ).length,
        below_gates_turns: caseTurns.filter(
          (entry) => entry.with_veto_cooldown.outcome === "below_gates",
        ).length,
        calls_with_veto_cooldown: caseTurns.filter(
          (entry) => entry.with_veto_cooldown.classifier_called,
        ).length,
        calls_baseline_e4b111e: caseTurns.filter(
          (entry) => entry.baseline_e4b111e_no_veto_cooldown.classifier_called,
        ).length,
        turns: caseTurns,
      };
    }

    const minProbability =
      observedProbabilities.length > 0
        ? roundMetric(Math.min(...observedProbabilities))
        : null;
    const maxProbability =
      observedProbabilities.length > 0
        ? roundMetric(Math.max(...observedProbabilities))
        : null;
    const meanProbability =
      observedProbabilities.length > 0
        ? roundMetric(
            observedProbabilities.reduce((sum, item) => sum + item, 0) /
              observedProbabilities.length,
          )
        : null;

    const classifiedEntries = perTurnLatency.filter(
      (entry) => entry.classifier_called,
    );
    const classifiedEndToEndLatencies = classifiedEntries.map(
      (entry) => entry.end_to_end_ms,
    );
    const classifiedRunnerLatencies = classifiedEntries.map(
      (entry) => entry.runner_total_ms,
    );
    const maxEndToEndMs =
      perTurnLatency.length > 0
        ? Math.round(
            Math.max(...perTurnLatency.map((entry) => entry.end_to_end_ms)),
          )
        : 0;
    const meanClassifiedEndToEndMs =
      classifiedEndToEndLatencies.length > 0
        ? Math.round(
            classifiedEndToEndLatencies.reduce((sum, value) => sum + value, 0) /
              classifiedEndToEndLatencies.length,
          )
        : 0;
    const maxRunnerTotalMs =
      perTurnLatency.length > 0
        ? Math.round(
            Math.max(...perTurnLatency.map((entry) => entry.runner_total_ms)),
          )
        : 0;
    const meanClassifiedRunnerTotalMs =
      classifiedRunnerLatencies.length > 0
        ? Math.round(
            classifiedRunnerLatencies.reduce((sum, value) => sum + value, 0) /
              classifiedRunnerLatencies.length,
          )
        : 0;

    const callsSaved = callsBaselineNoVetoCooldown - callsWithVetoCooldown;

    return {
      data_label: SIMULATED_DATA_LABEL,
      preset,
      score_threshold: threshold,
      preset_pause_threshold: roundMetric(PAUSE_THRESHOLDS[preset]),
      pause_cooldown_ratio: roundMetric(pauseCooldownRatio),
      veto_cooldown_ratio: roundMetric(VETO_COOLDOWN_RATIO),
      total_turns: totalTurns,
      pause_count: pauseCount,
      pause_rate: totalTurns > 0 ? roundMetric(pauseCount / totalTurns) : 0,
      veto_reason_counts: vetoReasonCounts,
      pause_probability_distribution: {
        bins: histogramBins,
        classified_with_probability_count: observedProbabilities.length,
        null_count: nullProbabilityCount,
        min: minProbability,
        max: maxProbability,
        mean: meanProbability,
      },
      classifier_call_comparison: {
        total_turns: totalTurns,
        with_veto_cooldown: {
          call_count: callsWithVetoCooldown,
          call_frequency:
            totalTurns > 0
              ? roundMetric(callsWithVetoCooldown / totalTurns)
              : 0,
        },
        baseline_e4b111e_no_veto_cooldown: {
          call_count: callsBaselineNoVetoCooldown,
          call_frequency:
            totalTurns > 0
              ? roundMetric(callsBaselineNoVetoCooldown / totalTurns)
              : 0,
        },
        calls_saved: callsSaved,
        call_reduction_ratio:
          callsBaselineNoVetoCooldown > 0
            ? roundMetric(callsSaved / callsBaselineNoVetoCooldown)
            : 0,
      },
      score_trajectory: scoreTrajectory,
      latency_budget: {
        constants_ms: {
          state_timeout_ms: STATE_TIMEOUT_MS,
          sdk_timeout_ms: SDK_TIMEOUT_MS,
          margin_ms: MARGIN_MS,
          jev_timeout_ms: JEV_TIMEOUT_MS,
          fallback_timeout_ms: FALLBACK_TIMEOUT_MS,
          worst_case_child_plus_fallback_ms:
            JEV_TIMEOUT_MS + FALLBACK_TIMEOUT_MS,
          stop_hook_timeout_ms: STOP_HOOK_TIMEOUT_MS,
          hook_headroom_ms:
            STOP_HOOK_TIMEOUT_MS - (JEV_TIMEOUT_MS + FALLBACK_TIMEOUT_MS),
        },
        max_runner_total_ms: maxRunnerTotalMs,
        mean_classified_runner_total_ms: meanClassifiedRunnerTotalMs,
        max_end_to_end_ms: maxEndToEndMs,
        mean_classified_end_to_end_ms: meanClassifiedEndToEndMs,
        per_turn: perTurnLatency,
      },
      cases: caseOutcomes,
    };
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  }
}

/**
 * The plugin rotates a trace once: `local-trace.jsonl` replaces
 * `local-trace.jsonl.1`, and the previous generation is discarded.
 *
 * @param {string} fileName - Base name of a candidate file.
 * @returns {boolean} True for the live trace or its single rotated copy.
 */
function isPluginLocalTraceFile(fileName) {
  return fileName === "local-trace.jsonl" || fileName === "local-trace.jsonl.1";
}

/**
 * Summary snapshots written by the experiment logger.
 *
 * @param {string} fileName - Base name of a candidate file.
 * @returns {boolean} True for `jev-experiment.jsonl`.
 */
function isPluginSummaryFile(fileName) {
  return fileName === "jev-experiment.jsonl";
}

/**
 * Tell the operator that a requested input path is not on disk. A typo would
 * otherwise shrink a real-data run without any signal.
 *
 * @param {string} flagName - The CLI flag the path was given to.
 * @param {string} inputPath - The path that could not be read.
 */
function warnMissingInputPath(flagName, inputPath) {
  process.stderr.write(
    `jev eval: ${flagName} path does not exist: ${inputPath}\n`,
  );
}

/**
 * Convert a basic wildcard pattern (`*` and `?`) into a RegExp.
 *
 * @param {string} pattern - Filename pattern containing `*` or `?`.
 * @returns {RegExp} Anchored regular expression.
 */
function wildcardPatternToRegExp(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/**
 * Expand one or more trace path specifications (individual files, rotated
 * `.jsonl.1` files, directories, or wildcard globs) into an ordered list of
 * existing file paths.
 *
 * @param {string|string[]} tracesInput - Trace file path(s), directory, or glob(s).
 * @returns {string[]} Distinct resolved file paths.
 */
export function resolveTraceInputPaths(tracesInput) {
  const rawSpecs = [];
  if (Array.isArray(tracesInput)) {
    for (const item of tracesInput) {
      if (isNonEmptyString(item)) {
        rawSpecs.push(item.trim());
      }
    }
  } else if (isNonEmptyString(tracesInput)) {
    rawSpecs.push(tracesInput.trim());
  }

  const resolvedPaths = [];
  const seenPaths = new Set();

  function addResolvedFile(candidatePath) {
    const resolved = path.resolve(candidatePath);
    if (!seenPaths.has(resolved)) {
      seenPaths.add(resolved);
      resolvedPaths.push(resolved);
    }
  }

  function collectTraceFilesFromDirectory(dirPath) {
    let dirEntries;
    try {
      dirEntries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    const sortedEntries = [...dirEntries].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    const matchingFiles = [];
    const subdirectories = [];

    for (const entry of sortedEntries) {
      const fullEntryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        // Session logs live under sessions/ and are not trace snapshots.
        if (entry.name !== "sessions") {
          subdirectories.push(fullEntryPath);
        }
      } else if (entry.isFile() && isPluginLocalTraceFile(entry.name)) {
        matchingFiles.push(fullEntryPath);
      }
    }

    // Order rotated backups (`.jsonl.1`) before the active `.jsonl` file.
    matchingFiles.sort((left, right) => {
      const leftRotated = /\.jsonl\.\d+$/.test(left);
      const rightRotated = /\.jsonl\.\d+$/.test(right);
      if (leftRotated !== rightRotated) {
        return leftRotated ? -1 : 1;
      }
      return left.localeCompare(right);
    });

    for (const filePath of matchingFiles) {
      addResolvedFile(filePath);
    }
    for (const subdirPath of subdirectories) {
      collectTraceFilesFromDirectory(subdirPath);
    }
  }

  for (const spec of rawSpecs) {
    if (spec.includes("*") || spec.includes("?")) {
      const parentDir = path.resolve(path.dirname(spec));
      const basePattern = path.basename(spec);
      const matcher = wildcardPatternToRegExp(basePattern);
      try {
        const entries = fs
          .readdirSync(parentDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && matcher.test(entry.name))
          .map((entry) => path.join(parentDir, entry.name))
          .sort((left, right) => {
            const leftRotated = /\.jsonl\.\d+$/.test(left);
            const rightRotated = /\.jsonl\.\d+$/.test(right);
            if (leftRotated !== rightRotated) {
              return leftRotated ? -1 : 1;
            }
            return left.localeCompare(right);
          });
        for (const matchedPath of entries) {
          addResolvedFile(matchedPath);
        }
      } catch {
        warnMissingInputPath("--traces", parentDir);
      }
      continue;
    }

    try {
      const stat = fs.statSync(spec);
      if (stat.isDirectory()) {
        collectTraceFilesFromDirectory(spec);
      } else if (stat.isFile()) {
        addResolvedFile(spec);
      }
    } catch {
      warnMissingInputPath("--traces", spec);
      addResolvedFile(spec);
    }
  }

  return resolvedPaths;
}

/**
 * Derive a stable project identifier for a trace record from its fields
 * (`project`, `project_id`, `project_dir`, `cwd`) or from the containing file
 * path.
 *
 * @param {object} record - Parsed trace record.
 * @param {string} [sourceFilePath] - Path of the trace file the record came from.
 * @returns {string} Derived project identifier.
 */
export function deriveTraceProjectId(record, sourceFilePath = "") {
  if (isPlainObject(record)) {
    for (const fieldName of ["project", "project_id", "project_dir", "cwd"]) {
      if (isNonEmptyString(record[fieldName])) {
        return record[fieldName].trim();
      }
    }
  }
  if (isNonEmptyString(sourceFilePath)) {
    const resolvedPath = path.resolve(sourceFilePath);
    const parentName = path.basename(path.dirname(resolvedPath));
    const fileName = path.basename(resolvedPath);
    if (
      /^local-trace\.jsonl(?:\.\d+)?$/.test(fileName) &&
      isNonEmptyString(parentName)
    ) {
      return parentName;
    }
    const strippedFileName = fileName.replace(/\.jsonl(?:\.\d+)?$/, "");
    if (
      isNonEmptyString(strippedFileName) &&
      strippedFileName !== "local-trace"
    ) {
      return strippedFileName;
    }
    if (isNonEmptyString(parentName)) {
      return parentName;
    }
  }
  return "default";
}

/**
 * Parse one or more `local-trace.jsonl` files (including rotated `.jsonl.1`
 * files, directories, or globs) read-only, deduplicating identical raw lines
 * across overlapping snapshots and skipping blank or malformed lines without
 * throwing.
 *
 * @param {string|string[]} tracesInput - Path(s), directory, or glob for trace files.
 * @returns {{
 *   records: object[],
 *   files_read: string[],
 *   skipped_malformed_lines: number,
 *   duplicate_lines_skipped: number,
 *   total_non_empty_lines: number,
 * }} Deduplicated trace records and line counts.
 */
export function readTraceFileReadOnly(tracesInput) {
  const filePaths = resolveTraceInputPaths(tracesInput);
  const records = [];
  const seenLines = new Set();
  const filesRead = [];
  let skippedMalformedLines = 0;
  let duplicateLinesSkipped = 0;
  let totalNonEmptyLines = 0;

  for (const filePath of filePaths) {
    let rawText;
    try {
      rawText = fs.readFileSync(filePath, "utf8");
      filesRead.push(filePath);
    } catch {
      continue;
    }

    for (const rawLine of rawText.split(/\r?\n/)) {
      const trimmedLine = rawLine.trim();
      if (trimmedLine === "") {
        continue;
      }
      totalNonEmptyLines += 1;
      try {
        const parsed = JSON.parse(trimmedLine);
        if (!isPlainObject(parsed)) {
          skippedMalformedLines += 1;
          continue;
        }
        if (seenLines.has(trimmedLine)) {
          duplicateLinesSkipped += 1;
          continue;
        }
        seenLines.add(trimmedLine);
        const derivedProject = deriveTraceProjectId(parsed, filePath);
        records.push({
          ...parsed,
          project: isNonEmptyString(parsed.project)
            ? parsed.project
            : derivedProject,
        });
      } catch {
        skippedMalformedLines += 1;
      }
    }
  }

  return {
    records,
    files_read: filesRead,
    skipped_malformed_lines: skippedMalformedLines,
    duplicate_lines_skipped: duplicateLinesSkipped,
    total_non_empty_lines: totalNonEmptyLines,
  };
}

/**
 * Expand summary path specifications (files, directories, or basename globs)
 * into an ordered list of snapshot files. A directory contributes
 * `jev-experiment.jsonl` from itself and from nested project folders, and
 * skips `sessions/`.
 *
 * @param {string|string[]} summariesInput - Summary file path(s), directory, or glob(s).
 * @returns {string[]} Distinct resolved file paths.
 */
export function resolveSummaryInputPaths(summariesInput) {
  const rawSpecs = [];
  if (Array.isArray(summariesInput)) {
    for (const item of summariesInput) {
      if (isNonEmptyString(item)) {
        rawSpecs.push(item.trim());
      }
    }
  } else if (isNonEmptyString(summariesInput)) {
    rawSpecs.push(summariesInput.trim());
  }

  const resolvedPaths = [];
  const seenPaths = new Set();

  function addResolvedFile(candidatePath) {
    const resolved = path.resolve(candidatePath);
    if (!seenPaths.has(resolved)) {
      seenPaths.add(resolved);
      resolvedPaths.push(resolved);
    }
  }

  function collectSummaryFilesFromDirectory(dirPath) {
    let dirEntries;
    try {
      dirEntries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    const sortedEntries = [...dirEntries].sort((leftEntry, rightEntry) =>
      leftEntry.name.localeCompare(rightEntry.name),
    );
    for (const entry of sortedEntries) {
      const fullEntryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "sessions") {
          collectSummaryFilesFromDirectory(fullEntryPath);
        }
      } else if (entry.isFile() && isPluginSummaryFile(entry.name)) {
        addResolvedFile(fullEntryPath);
      }
    }
  }

  for (const spec of rawSpecs) {
    if (spec.includes("*") || spec.includes("?")) {
      const parentDir = path.resolve(path.dirname(spec));
      const matcher = wildcardPatternToRegExp(path.basename(spec));
      try {
        const matchedPaths = fs
          .readdirSync(parentDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && matcher.test(entry.name))
          .map((entry) => path.join(parentDir, entry.name))
          .sort((leftPath, rightPath) => leftPath.localeCompare(rightPath));
        for (const matchedPath of matchedPaths) {
          addResolvedFile(matchedPath);
        }
      } catch {
        warnMissingInputPath("--summaries", parentDir);
      }
      continue;
    }

    try {
      const stat = fs.statSync(spec);
      if (stat.isDirectory()) {
        collectSummaryFilesFromDirectory(spec);
      } else if (stat.isFile()) {
        addResolvedFile(spec);
      }
    } catch {
      warnMissingInputPath("--summaries", spec);
      addResolvedFile(spec);
    }
  }

  return resolvedPaths;
}

/**
 * Turn key for overlapping summary snapshots: `session_id` plus the turn
 * timestamp in epoch milliseconds. Returns null when either half is missing,
 * so those lines stay distinct unless their raw text matches.
 *
 * @param {object} summary - Normalized summary line.
 * @returns {string|null} Dedupe key.
 */
function summaryTurnKey(summary) {
  const sessionId = isNonEmptyString(summary?.session_id)
    ? summary.session_id.trim()
    : null;
  const timestampMs = parseTimestampMs(summary?.ts);
  if (sessionId === null || timestampMs === null) {
    return null;
  }
  return `${sessionId}|${timestampMs}`;
}

/**
 * Parse one or more `jev-experiment.jsonl` snapshots read-only using
 * `parseSummaryLine` (tolerating v1, v2, and v3 lines and unknown fields).
 * Identical lines and lines that share `session_id` + `ts` are merged once.
 * Blank or malformed lines are skipped. Never throws.
 *
 * @param {string|string[]} summariesInput - Path, directory, glob, or list of them.
 * @returns {{
 *   summaries: object[],
 *   files_read: string[],
 *   skipped_malformed_lines: number,
 *   duplicate_summaries_skipped: number,
 *   total_non_empty_lines: number,
 * }} Normalized summary records and line counts.
 */
export function readSummaryFileReadOnly(summariesInput) {
  const filePaths = resolveSummaryInputPaths(summariesInput);
  const summaries = [];
  const seenRawLines = new Set();
  const seenTurnKeys = new Set();
  const filesRead = [];
  let skippedMalformedLines = 0;
  let duplicateSummariesSkipped = 0;
  let totalNonEmptyLines = 0;

  for (const filePath of filePaths) {
    let rawText;
    try {
      rawText = fs.readFileSync(filePath, "utf8");
      filesRead.push(filePath);
    } catch {
      continue;
    }

    for (const rawLine of rawText.split(/\r?\n/)) {
      const trimmedLine = rawLine.trim();
      if (trimmedLine === "") {
        continue;
      }
      totalNonEmptyLines += 1;
      const parsed = parseSummaryLine(trimmedLine);
      if (parsed === null) {
        skippedMalformedLines += 1;
        continue;
      }
      if (seenRawLines.has(trimmedLine)) {
        duplicateSummariesSkipped += 1;
        continue;
      }
      const turnKey = summaryTurnKey(parsed);
      if (turnKey !== null && seenTurnKeys.has(turnKey)) {
        duplicateSummariesSkipped += 1;
        seenRawLines.add(trimmedLine);
        continue;
      }
      seenRawLines.add(trimmedLine);
      if (turnKey !== null) {
        seenTurnKeys.add(turnKey);
      }
      summaries.push(parsed);
    }
  }

  return {
    summaries,
    files_read: filesRead,
    skipped_malformed_lines: skippedMalformedLines,
    duplicate_summaries_skipped: duplicateSummariesSkipped,
    total_non_empty_lines: totalNonEmptyLines,
  };
}

/**
 * Build canonical lookup keys for a turn label or summary line, prioritizing
 * the unique `{ session_id, ts }` join key (with timestamp normalized to epoch
 * milliseconds via `parseTimestampMs`) before falling back to timestamp or
 * `prompt_id`.
 *
 * @param {object} fields - `{ session_id, ts, turn_ts, prompt_id }`.
 * @returns {{
 *   primaryKey: string|null,
 *   candidateKeys: string[],
 * }} Primary join key and ordered lookup keys.
 */
export function buildTurnLabelKeys(fields) {
  const sessionId = isNonEmptyString(fields?.session_id)
    ? fields.session_id.trim()
    : null;
  const rawTimestamp = fields?.ts ?? fields?.turn_ts ?? null;
  const timestampMs = parseTimestampMs(rawTimestamp);
  const rawTsText = isNonEmptyString(rawTimestamp) ? rawTimestamp.trim() : null;
  const promptId = isNonEmptyString(fields?.prompt_id)
    ? fields.prompt_id.trim()
    : null;

  const candidateKeys = [];
  if (sessionId !== null && timestampMs !== null) {
    candidateKeys.push(`session_ts:${sessionId}|${timestampMs}`);
  }
  if (sessionId !== null && rawTsText !== null) {
    candidateKeys.push(`session_raw_ts:${sessionId}|${rawTsText}`);
  }
  if (timestampMs !== null) {
    candidateKeys.push(`ts_ms:${timestampMs}`);
  }
  if (rawTsText !== null) {
    candidateKeys.push(`raw_ts:${rawTsText}`);
  }
  if (promptId !== null) {
    candidateKeys.push(`prompt_id:${promptId}`);
  }

  return {
    primaryKey: candidateKeys[0] ?? null,
    candidateKeys,
  };
}

/**
 * Extract a boolean pause label from a raw label entry.
 *
 * @param {unknown} rawValue - Boolean or object carrying `should_pause` / `expected_pause` / `decision_found`.
 * @returns {boolean|null} Boolean pause expectation, or null when absent.
 */
function extractBooleanLabel(rawValue) {
  if (typeof rawValue === "boolean") {
    return rawValue;
  }
  if (isPlainObject(rawValue)) {
    if (typeof rawValue.should_pause === "boolean") {
      return rawValue.should_pause;
    }
    if (typeof rawValue.expected_pause === "boolean") {
      return rawValue.expected_pause;
    }
    if (typeof rawValue.decision_found === "boolean") {
      return rawValue.decision_found;
    }
  }
  return null;
}

/**
 * Read optional human turn labels from a JSON or JSONL file read-only without
 * throwing.
 *
 * Supported formats:
 * - JSON array of `[{ session_id, ts, should_pause }]` (or `turn_ts`, `prompt_id`, `decision_found`)
 * - JSONL lines of `{ session_id, ts, should_pause }`
 * - JSON object mapping `"<session_id>|<ts>"`, `ts`, or `prompt_id` to `boolean`
 *   or `{ should_pause: boolean }`
 *
 * @param {string} labelsFilePath - Path to the labels file.
 * @returns {Map<string, boolean>} Map of normalized lookup keys to boolean pause labels, with `.entriesList` metadata attached.
 */
export function readLabelsFileReadOnly(labelsFilePath) {
  const labelMap = new Map();
  const entriesList = [];
  Object.defineProperty(labelMap, "entriesList", {
    value: entriesList,
    enumerable: false,
  });

  if (!isNonEmptyString(labelsFilePath)) {
    return labelMap;
  }

  function registerLabelObject(item) {
    if (!isPlainObject(item)) {
      return;
    }
    const booleanLabel = extractBooleanLabel(item);
    if (booleanLabel === null) {
      return;
    }
    const { primaryKey, candidateKeys } = buildTurnLabelKeys(item);
    if (primaryKey === null || candidateKeys.length === 0) {
      return;
    }
    entriesList.push({
      primaryKey,
      candidateKeys,
      shouldPause: booleanLabel,
    });
    for (const key of candidateKeys) {
      labelMap.set(key, booleanLabel);
    }
  }

  function registerKeyedLabel(rawKey, rawValue) {
    if (!isNonEmptyString(rawKey)) {
      return;
    }
    const trimmedKey = rawKey.trim();
    if (isPlainObject(rawValue) && (rawValue.session_id || rawValue.ts)) {
      registerLabelObject({
        ...rawValue,
        prompt_id: rawValue.prompt_id ?? trimmedKey,
      });
      return;
    }
    const booleanLabel = extractBooleanLabel(rawValue);
    if (booleanLabel === null) {
      return;
    }
    const candidateKeys = [trimmedKey];
    if (trimmedKey.includes("|")) {
      const [sessionPart, tsPart] = trimmedKey.split("|", 2);
      const parsedMs = parseTimestampMs(tsPart);
      if (isNonEmptyString(sessionPart) && parsedMs !== null) {
        candidateKeys.unshift(`session_ts:${sessionPart.trim()}|${parsedMs}`);
      }
      candidateKeys.push(`session_raw_ts:${trimmedKey}`);
    } else {
      const parsedMs = parseTimestampMs(trimmedKey);
      if (parsedMs !== null) {
        candidateKeys.unshift(`ts_ms:${parsedMs}`);
      }
      candidateKeys.push(`prompt_id:${trimmedKey}`);
      candidateKeys.push(`raw_ts:${trimmedKey}`);
    }
    const primaryKey = candidateKeys[0];
    entriesList.push({
      primaryKey,
      candidateKeys,
      shouldPause: booleanLabel,
    });
    for (const key of candidateKeys) {
      labelMap.set(key, booleanLabel);
    }
  }

  try {
    const rawText = fs.readFileSync(labelsFilePath, "utf8").trim();
    if (rawText === "") {
      return labelMap;
    }

    try {
      const parsedJson = JSON.parse(rawText);
      if (Array.isArray(parsedJson)) {
        for (const item of parsedJson) {
          registerLabelObject(item);
        }
        return labelMap;
      }
      if (isPlainObject(parsedJson)) {
        for (const [key, value] of Object.entries(parsedJson)) {
          registerKeyedLabel(key, value);
        }
        return labelMap;
      }
    } catch {
      // Fall through to line-by-line JSONL parsing.
    }

    for (const line of rawText.split(/\r?\n/)) {
      if (line.trim() === "") {
        continue;
      }
      try {
        const item = JSON.parse(line);
        registerLabelObject(item);
      } catch {
        // Ignore malformed label lines.
      }
    }
  } catch {
    // Missing or unreadable file returns an empty map.
  }

  return labelMap;
}

/**
 * Create a fresh logged-outcomes counter structure for real-trace classification.
 *
 * @returns {object} Initialized outcome counters.
 */
function createLoggedOutcomeCounts() {
  return {
    paused: 0,
    vetoed: {
      total: 0,
      no_classification: 0,
      no_decision: 0,
      category_failed: 0,
      low_confidence: 0,
      bad_category: 0,
      unknown: 0,
    },
    muted: 0,
    below_gates: 0,
    fallback: 0,
    disabled: 0,
    malformed_input: 0,
    continuation_truncated: 0,
    no_project_root: 0,
    error: 0,
    unknown: 0,
    logged_classifier_calls: 0,
  };
}

/**
 * Explicitly classify a single logged Stop trace record from its fields
 * (`outcome`, `reason`, `provider`, `category_failed`) without assuming that
 * every non-pause call is a veto. Unrecognized outcomes and unrecognized veto
 * reasons go to explicit `unknown` buckets.
 *
 * @param {object} record - Parsed Stop trace record.
 * @returns {{
 *   bucket: string,
 *   vetoReasonBucket: string|null,
 *   isFallback: boolean,
 *   isScoredTurn: boolean,
 *   isClassifierCall: boolean,
 *   coolsOnVeto: boolean,
 * }} Explicit classification of the trace record.
 */
export function classifyLoggedTraceRecord(record) {
  const rawOutcome = isNonEmptyString(record?.outcome)
    ? record.outcome.trim()
    : null;
  const rawReason = isNonEmptyString(record?.reason)
    ? record.reason.trim()
    : null;
  const isFallback =
    record?.provider === "headless_fallback" ||
    record?.fallback === true ||
    rawOutcome === "fallback";
  const hasNumericScores =
    isFiniteNumber(record?.score_before) && isFiniteNumber(record?.score_after);

  if (rawOutcome === "fired" || rawOutcome === "paused") {
    return {
      bucket: "paused",
      vetoReasonBucket: null,
      isFallback,
      isScoredTurn: hasNumericScores,
      isClassifierCall: true,
      coolsOnVeto: false,
    };
  }

  if (rawOutcome === "veto" || rawOutcome === "vetoed") {
    let vetoReasonBucket = "unknown";
    if (
      rawReason === "category_failed" ||
      record?.category_failed === true ||
      (rawReason === "no_decision" &&
        isNonEmptyString(record?.verdict_reason) &&
        record.verdict_reason.startsWith("jev: category_failed"))
    ) {
      vetoReasonBucket = "category_failed";
    } else if (rawReason !== null && VETO_REASONS.includes(rawReason)) {
      vetoReasonBucket = rawReason;
    }

    const coolsOnVeto =
      vetoReasonBucket === "no_classification" ||
      vetoReasonBucket === "no_decision" ||
      vetoReasonBucket === "category_failed" ||
      vetoReasonBucket === "low_confidence";

    return {
      bucket: "vetoed",
      vetoReasonBucket,
      isFallback,
      isScoredTurn: hasNumericScores,
      isClassifierCall: true,
      coolsOnVeto,
    };
  }

  if (rawOutcome === "muted") {
    return {
      bucket: "muted",
      vetoReasonBucket: null,
      isFallback: false,
      isScoredTurn: hasNumericScores,
      isClassifierCall: false,
      coolsOnVeto: false,
    };
  }

  if (rawOutcome === "scored" || rawOutcome === "below_gates") {
    return {
      bucket: "below_gates",
      vetoReasonBucket: null,
      isFallback: false,
      isScoredTurn: hasNumericScores,
      isClassifierCall: false,
      coolsOnVeto: false,
    };
  }

  if (rawOutcome === "fallback") {
    return {
      bucket: "fallback",
      vetoReasonBucket: null,
      isFallback: true,
      isScoredTurn: hasNumericScores,
      isClassifierCall: true,
      coolsOnVeto: false,
    };
  }

  if (
    rawOutcome !== null &&
    ADMINISTRATIVE_STOP_OUTCOMES.includes(rawOutcome)
  ) {
    return {
      bucket: rawOutcome,
      vetoReasonBucket: null,
      isFallback: false,
      isScoredTurn: false,
      isClassifierCall: false,
      coolsOnVeto: false,
    };
  }

  return {
    bucket: "unknown",
    vetoReasonBucket: null,
    isFallback,
    isScoredTurn: false,
    isClassifierCall: false,
    coolsOnVeto: false,
  };
}

/**
 * Record one trace record's outcome classification into an outcome counter
 * object.
 *
 * @param {object} counts - Outcome counter object from `createLoggedOutcomeCounts`.
 * @param {ReturnType<typeof classifyLoggedTraceRecord>} classified - Classified trace outcome.
 */
function accumulateLoggedOutcome(counts, classified) {
  if (classified.isFallback && classified.bucket !== "fallback") {
    counts.fallback += 1;
  }
  if (classified.isClassifierCall) {
    counts.logged_classifier_calls += 1;
  }

  if (classified.bucket === "vetoed") {
    counts.vetoed.total += 1;
    const reasonKey = classified.vetoReasonBucket ?? "unknown";
    if (reasonKey in counts.vetoed) {
      counts.vetoed[reasonKey] += 1;
    } else {
      counts.vetoed.unknown += 1;
    }
    return;
  }

  if (classified.bucket in counts) {
    counts[classified.bucket] += 1;
  } else {
    counts.unknown += 1;
  }
}

/**
 * Replay score dynamics and classifier call frequency (with `0.8` veto
 * cooldown vs `e4b111e` no-veto-cooldown baseline) over a single project's
 * chronological `local-trace.jsonl` Stop records.
 *
 * @param {object[]} projectTraceRecords - Stop records for a single project.
 * @param {string} [preset] - Preset to replay (`calm`, `balanced`, `vigilant`).
 * @param {string} [projectId] - Identifier of the project being replayed.
 * @returns {object} Single-project `REAL-DATA` replay report for the preset.
 */
function replaySingleProjectTraceForPreset(
  projectTraceRecords,
  preset = "balanced",
  projectId = "default",
) {
  const knobs = resolveKnobs({ preset }, { preset });
  const threshold = knobs.threshold;
  const halfLifeHours = knobs.half_life_hours;
  const pauseCooldownRatio = knobs.cooldown_ratio;

  const stopCandidateRecords = Array.isArray(projectTraceRecords)
    ? projectTraceRecords.filter(
        (record) =>
          isPlainObject(record) &&
          (record.hook === "Stop" || !isNonEmptyString(record.hook)),
      )
    : [];

  // Sort chronologically by parsed timestamp when available while preserving
  // relative file order on ties.
  const indexedCandidates = stopCandidateRecords.map((record, index) => ({
    record,
    index,
    tsMs: parseTimestampMs(record.ts ?? record.turn_ts),
  }));
  indexedCandidates.sort((left, right) => {
    if (left.tsMs !== null && right.tsMs !== null && left.tsMs !== right.tsMs) {
      return left.tsMs - right.tsMs;
    }
    return left.index - right.index;
  });

  const loggedOutcomes = createLoggedOutcomeCounts();
  const scoredStopRecords = [];

  for (const { record } of indexedCandidates) {
    const classified = classifyLoggedTraceRecord(record);
    accumulateLoggedOutcome(loggedOutcomes, classified);
    if (classified.isScoredTurn) {
      scoredStopRecords.push({ record, classified });
    }
  }

  let scoreWithVetoCooldown =
    scoredStopRecords.length > 0 ? scoredStopRecords[0].record.score_before : 0;
  let scoreReplayOnlyNotCooled = scoreWithVetoCooldown;
  let scoreBaseline = scoreWithVetoCooldown;
  let previousTimestampMs = null;

  let callsWithVetoCooldown = 0;
  let callsReplayOnlyNotCooled = 0;
  let callsBaseline = 0;
  const trajectory = [];

  for (let index = 0; index < scoredStopRecords.length; index += 1) {
    const { record, classified } = scoredStopRecords[index];
    const parsedTs = parseTimestampMs(record.ts ?? record.turn_ts);
    const elapsedMs =
      parsedTs !== null &&
      previousTimestampMs !== null &&
      parsedTs > previousTimestampMs
        ? parsedTs - previousTimestampMs
        : 0;
    if (parsedTs !== null) {
      previousTimestampMs = parsedTs;
    }

    const decayedLoggedBefore = decayScore(
      record.score_before,
      elapsedMs,
      halfLifeHours,
    );
    // Recover the pre-cooldown turn delta from the trace record:
    // On `below_gates`, `muted`, or `e4b111e` un-cooled `vetoed` records where
    // `score_after >= score_before`, `score_after - decayedLoggedBefore` is
    // the exact turn delta. When a record was already cooled (`paused` or v3
    // cooled `vetoed`), the turn had to reach at least `record.score_before`
    // (or `threshold` on a score-triggered turn).
    let rawPreCooldownScore = record.score_after;
    if (
      (classified.bucket === "paused" || classified.bucket === "vetoed") &&
      record.score_after < record.score_before
    ) {
      rawPreCooldownScore = Math.max(
        record.score_before,
        record.trigger === "critical_path" ? record.score_before : threshold,
      );
    }
    const inferredDelta = rawPreCooldownScore - decayedLoggedBefore;

    const isCriticalPath = record.trigger === "critical_path";
    const isMutedTurn = classified.bucket === "muted";

    // 1. Replay with veto cooldown (0.8 * threshold).
    // Muted Stops are never classifier calls. A call the replay adds on top of
    // a logged below-gates Stop is cooled as a veto. The parallel score keeps
    // that same call uncooled so both policies stay visible.
    const nextPreGateWithCooldown = Math.max(
      0,
      decayScore(scoreWithVetoCooldown, elapsedMs, halfLifeHours) +
        inferredDelta,
    );
    const nextPreGateReplayOnlyNotCooled = Math.max(
      0,
      decayScore(scoreReplayOnlyNotCooled, elapsedMs, halfLifeHours) +
        inferredDelta,
    );
    const gateReachedWithCooldown =
      isCriticalPath || nextPreGateWithCooldown >= threshold;
    const gateReachedReplayOnlyNotCooled =
      isCriticalPath || nextPreGateReplayOnlyNotCooled >= threshold;
    const calledWithCooldown = !isMutedTurn && gateReachedWithCooldown;
    const calledReplayOnlyNotCooled =
      !isMutedTurn && gateReachedReplayOnlyNotCooled;
    const replayOnlyCall =
      calledWithCooldown && classified.bucket === "below_gates";

    let nextAfterWithCooldown = nextPreGateWithCooldown;
    let nextAfterReplayOnlyNotCooled = nextPreGateReplayOnlyNotCooled;
    if (calledWithCooldown) {
      callsWithVetoCooldown += 1;
      if (classified.bucket === "paused") {
        nextAfterWithCooldown = relievedScore(
          nextPreGateWithCooldown,
          threshold,
          pauseCooldownRatio,
        );
      } else if (classified.bucket === "vetoed" && classified.coolsOnVeto) {
        nextAfterWithCooldown = relievedScore(
          nextPreGateWithCooldown,
          threshold,
          VETO_COOLDOWN_RATIO,
        );
      } else if (replayOnlyCall) {
        nextAfterWithCooldown = relievedScore(
          nextPreGateWithCooldown,
          threshold,
          VETO_COOLDOWN_RATIO,
        );
      }
    }
    if (calledReplayOnlyNotCooled) {
      callsReplayOnlyNotCooled += 1;
      if (classified.bucket === "paused") {
        nextAfterReplayOnlyNotCooled = relievedScore(
          nextPreGateReplayOnlyNotCooled,
          threshold,
          pauseCooldownRatio,
        );
      } else if (classified.bucket === "vetoed" && classified.coolsOnVeto) {
        nextAfterReplayOnlyNotCooled = relievedScore(
          nextPreGateReplayOnlyNotCooled,
          threshold,
          VETO_COOLDOWN_RATIO,
        );
      }
    }
    scoreWithVetoCooldown = nextAfterWithCooldown;
    scoreReplayOnlyNotCooled = nextAfterReplayOnlyNotCooled;

    // 2. Replay under e4b111e baseline (veto leaves score unchanged)
    const nextPreGateBaseline = Math.max(
      0,
      decayScore(scoreBaseline, elapsedMs, halfLifeHours) + inferredDelta,
    );
    const gateReachedBaseline =
      isCriticalPath || nextPreGateBaseline >= threshold;
    const calledBaseline = !isMutedTurn && gateReachedBaseline;
    let nextAfterBaseline = nextPreGateBaseline;
    if (calledBaseline) {
      callsBaseline += 1;
      if (classified.bucket === "paused") {
        nextAfterBaseline = relievedScore(
          nextPreGateBaseline,
          threshold,
          pauseCooldownRatio,
        );
      }
    }
    scoreBaseline = nextAfterBaseline;

    trajectory.push({
      project: projectId,
      turn_index: index + 1,
      ts: record.ts ?? null,
      ts_ms: parsedTs,
      prompt_id: record.prompt_id ?? null,
      session_id: record.session_id ?? null,
      logged_outcome: record.outcome ?? null,
      classified_outcome: classified.bucket,
      veto_reason: classified.vetoReasonBucket,
      with_veto_cooldown: {
        score_before_gate: roundMetric(nextPreGateWithCooldown),
        classifier_called: calledWithCooldown,
        replay_only_call: replayOnlyCall,
        score_after: roundMetric(nextAfterWithCooldown),
      },
      replay_only_calls_not_cooled: {
        score_before_gate: roundMetric(nextPreGateReplayOnlyNotCooled),
        classifier_called: calledReplayOnlyNotCooled,
        score_after: roundMetric(nextAfterReplayOnlyNotCooled),
      },
      baseline_e4b111e_no_veto_cooldown: {
        score_before_gate: roundMetric(nextPreGateBaseline),
        classifier_called: calledBaseline,
        score_after: roundMetric(nextAfterBaseline),
      },
    });
  }

  const totalStopTurns = scoredStopRecords.length;
  const callsSaved = callsBaseline - callsWithVetoCooldown;

  return {
    data_label: REPLAY_PROJECTION_LABEL,
    project: projectId,
    preset,
    threshold,
    total_stop_turns: totalStopTurns,
    logged_outcomes: loggedOutcomes,
    with_veto_cooldown: {
      call_count: callsWithVetoCooldown,
      call_frequency:
        totalStopTurns > 0
          ? roundMetric(callsWithVetoCooldown / totalStopTurns)
          : 0,
    },
    replay_only_calls_not_cooled: {
      call_count: callsReplayOnlyNotCooled,
      call_frequency:
        totalStopTurns > 0
          ? roundMetric(callsReplayOnlyNotCooled / totalStopTurns)
          : 0,
    },
    baseline_e4b111e_no_veto_cooldown: {
      call_count: callsBaseline,
      call_frequency:
        totalStopTurns > 0 ? roundMetric(callsBaseline / totalStopTurns) : 0,
    },
    calls_saved: callsSaved,
    call_reduction_ratio:
      callsBaseline > 0 ? roundMetric(callsSaved / callsBaseline) : 0,
    score_trajectory: trajectory,
  };
}

/**
 * Merge two `logged_outcomes` structures when aggregating across projects.
 *
 * @param {object} target - Accumulator outcome counts.
 * @param {object} source - Single-project outcome counts.
 */
function mergeLoggedOutcomeCounts(target, source) {
  for (const key of [
    "paused",
    "muted",
    "below_gates",
    "fallback",
    "disabled",
    "malformed_input",
    "continuation_truncated",
    "no_project_root",
    "error",
    "unknown",
    "logged_classifier_calls",
  ]) {
    target[key] += source[key] ?? 0;
  }
  for (const vetoKey of Object.keys(target.vetoed)) {
    target.vetoed[vetoKey] += source.vetoed?.[vetoKey] ?? 0;
  }
}

/**
 * Replay score dynamics and classifier call frequency (with `0.8` veto
 * cooldown vs `e4b111e` no-veto-cooldown baseline) over real `local-trace.jsonl`
 * Stop records, splitting state per project so score never carries across
 * projects and reporting both per-project results and aggregated totals.
 *
 * @param {object[]} traceRecords - Parsed trace records from `local-trace.jsonl`.
 * @param {string} [preset] - Preset to replay (`calm`, `balanced`, `vigilant`).
 * @returns {object} `REAL-DATA` replay report for the preset.
 */
export function replayRealTraceForPreset(traceRecords, preset = "balanced") {
  const knobs = resolveKnobs({ preset }, { preset });
  const threshold = knobs.threshold;

  const recordsByProject = new Map();
  if (Array.isArray(traceRecords)) {
    for (const record of traceRecords) {
      if (!isPlainObject(record)) {
        continue;
      }
      const projectId = deriveTraceProjectId(record);
      if (!recordsByProject.has(projectId)) {
        recordsByProject.set(projectId, []);
      }
      recordsByProject.get(projectId).push(record);
    }
  }

  if (recordsByProject.size === 0) {
    recordsByProject.set("default", []);
  }

  const perProjectReplays = {};
  const aggregatedLoggedOutcomes = createLoggedOutcomeCounts();
  const combinedTrajectory = [];
  let totalStopTurns = 0;
  let totalCallsWithCooldown = 0;
  let totalCallsReplayOnlyNotCooled = 0;
  let totalCallsBaseline = 0;

  const sortedProjectIds = [...recordsByProject.keys()].sort();
  for (const projectId of sortedProjectIds) {
    const projectReplay = replaySingleProjectTraceForPreset(
      recordsByProject.get(projectId),
      preset,
      projectId,
    );
    perProjectReplays[projectId] = projectReplay;
    totalStopTurns += projectReplay.total_stop_turns;
    totalCallsWithCooldown += projectReplay.with_veto_cooldown.call_count;
    totalCallsReplayOnlyNotCooled +=
      projectReplay.replay_only_calls_not_cooled.call_count;
    totalCallsBaseline +=
      projectReplay.baseline_e4b111e_no_veto_cooldown.call_count;
    mergeLoggedOutcomeCounts(
      aggregatedLoggedOutcomes,
      projectReplay.logged_outcomes,
    );
    combinedTrajectory.push(...projectReplay.score_trajectory);
  }

  const callsSaved = totalCallsBaseline - totalCallsWithCooldown;

  return {
    data_label: REPLAY_PROJECTION_LABEL,
    preset,
    threshold,
    project_count: sortedProjectIds.length,
    total_stop_turns: totalStopTurns,
    logged_outcomes: aggregatedLoggedOutcomes,
    with_veto_cooldown: {
      call_count: totalCallsWithCooldown,
      call_frequency:
        totalStopTurns > 0
          ? roundMetric(totalCallsWithCooldown / totalStopTurns)
          : 0,
    },
    replay_only_calls_not_cooled: {
      call_count: totalCallsReplayOnlyNotCooled,
      call_frequency:
        totalStopTurns > 0
          ? roundMetric(totalCallsReplayOnlyNotCooled / totalStopTurns)
          : 0,
    },
    baseline_e4b111e_no_veto_cooldown: {
      call_count: totalCallsBaseline,
      call_frequency:
        totalStopTurns > 0
          ? roundMetric(totalCallsBaseline / totalStopTurns)
          : 0,
    },
    calls_saved: callsSaved,
    call_reduction_ratio:
      totalCallsBaseline > 0 ? roundMetric(callsSaved / totalCallsBaseline) : 0,
    per_project: perProjectReplays,
    score_trajectory: combinedTrajectory,
  };
}

/**
 * Look up a human pause label for a summary record by checking the unique
 * `{ session_id, ts }` join key (normalized to epoch milliseconds) first, then
 * falling back to `ts` or `prompt_id` when the label file was keyed without
 * `session_id`.
 *
 * @param {object} summaryRecord - Normalized summary line.
 * @param {Map<string, boolean>} labels - Labels map from `readLabelsFileReadOnly`.
 * @returns {{ matched: boolean, expectedPause: boolean|null, matchedKey: string|null }}
 *   Match result.
 */
function lookupLabelForSummary(summaryRecord, labels) {
  if (!(labels instanceof Map) || labels.size === 0) {
    return { matched: false, expectedPause: null, matchedKey: null };
  }
  const { candidateKeys } = buildTurnLabelKeys(summaryRecord);
  const rawKeys = [
    ...candidateKeys,
    ...(isNonEmptyString(summaryRecord?.ts) ? [summaryRecord.ts] : []),
    ...(isNonEmptyString(summaryRecord?.prompt_id)
      ? [summaryRecord.prompt_id]
      : []),
  ];

  for (const key of rawKeys) {
    if (labels.has(key)) {
      return {
        matched: true,
        expectedPause: labels.get(key),
        matchedKey: key,
      };
    }
  }
  return { matched: false, expectedPause: null, matchedKey: null };
}

/**
 * Evaluate logged `jev-experiment.jsonl` summaries (v1, v2, v3, and v4) against
 * optional human labels and optional `local-trace.jsonl` records.
 *
 * Recomputes pause probability with the current formula from the four category
 * inputs. The report field names keep the `recomputed_v3_formula_*` prefix.
 * Lines lacking any of those four inputs are counted per missing input and
 * excluded from that accuracy. When no labeled lines carry all four,
 * `recomputed_v3_formula_accuracy` is `null` with
 * `recomputed_v3_formula_reason: "missing_inputs"`.
 *
 * @param {object} params - Real-data evaluation inputs.
 * @param {object[]} params.summaries - Normalized summary records from `readSummaryFileReadOnly`.
 * @param {object[]} [params.traceRecords] - Parsed trace records from `readTraceFileReadOnly`.
 * @param {Map<string, boolean>} [params.labels] - Optional human pause labels.
 * @returns {object} `REAL-DATA` summary evaluation object.
 */
export function evaluateRealSummaries({
  summaries,
  traceRecords = [],
  labels = new Map(),
}) {
  const joined = joinSummaryWithLocalTrace(summaries, traceRecords);
  const schemaVersionCounts = { v1: 0, v2: 0, v3: 0, v4: 0 };
  const summaryStatusCounts = {
    ok: 0,
    category_failed: 0,
    fallback_or_error: 0,
  };
  const missingFormulaInputCounts = {
    decision_weight: 0,
    decision_ownership: 0,
    developer_reflection: 0,
    developer_intent: 0,
    lines_missing_any_input: 0,
  };

  let totalLabeled = 0;
  let unlabeledSummariesCount = 0;
  let loggedCorrectCount = 0;
  let recomputedEligibleCount = 0;
  let recomputedMissingInputsCount = 0;
  let recomputedCorrectCount = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;

  const matchedLabelEntries = new Set();
  const labelEntriesList = Array.isArray(labels?.entriesList)
    ? labels.entriesList
    : [];

  for (const record of joined) {
    if (record.schema_version === 1) {
      schemaVersionCounts.v1 += 1;
    } else if (record.schema_version === 2) {
      schemaVersionCounts.v2 += 1;
    } else if (record.schema_version === 3) {
      schemaVersionCounts.v3 += 1;
    } else if (record.schema_version === SUMMARY_SCHEMA_VERSION) {
      schemaVersionCounts.v4 += 1;
    }

    if (
      record.status === "category_failed" ||
      record.category_failed === true
    ) {
      summaryStatusCounts.category_failed += 1;
    } else if (record.status === "ok" && record.provider === "jev") {
      summaryStatusCounts.ok += 1;
    } else {
      summaryStatusCounts.fallback_or_error += 1;
    }

    const formulaInputs = isPlainObject(record.formula_inputs)
      ? record.formula_inputs
      : {};
    let lineMissingAnyFormulaInput = false;
    for (const inputKey of FORMULA_INPUT_KEYS) {
      if (!isFiniteNumber(formulaInputs[inputKey])) {
        missingFormulaInputCounts[inputKey] += 1;
        lineMissingAnyFormulaInput = true;
      }
    }
    if (lineMissingAnyFormulaInput) {
      missingFormulaInputCounts.lines_missing_any_input += 1;
    }

    const labelLookup = lookupLabelForSummary(record, labels);
    if (!labelLookup.matched) {
      unlabeledSummariesCount += 1;
      continue;
    }

    for (
      let entryIndex = 0;
      entryIndex < labelEntriesList.length;
      entryIndex += 1
    ) {
      const entry = labelEntriesList[entryIndex];
      if (entry.candidateKeys.includes(labelLookup.matchedKey)) {
        matchedLabelEntries.add(entryIndex);
      }
    }

    const expectedPause = labelLookup.expectedPause;
    totalLabeled += 1;

    let loggedConfidence = 1;
    if (isFiniteNumber(record.confidence)) {
      loggedConfidence = record.confidence;
    } else if (isFiniteNumber(record.verdict?.confidence)) {
      loggedConfidence = record.verdict.confidence;
    }
    const loggedDecisionFound =
      typeof record.decision_found === "boolean"
        ? record.decision_found
        : record.verdict?.decision_found === true;
    const loggedPaused =
      loggedDecisionFound && loggedConfidence >= configuredConfidenceFloor();

    if (loggedPaused === expectedPause) {
      loggedCorrectCount += 1;
    }
    if (loggedPaused && expectedPause) {
      truePositives += 1;
    } else if (loggedPaused && !expectedPause) {
      falsePositives += 1;
    } else if (!loggedPaused && !expectedPause) {
      trueNegatives += 1;
    } else {
      falseNegatives += 1;
    }

    if (lineMissingAnyFormulaInput) {
      recomputedMissingInputsCount += 1;
    } else {
      recomputedEligibleCount += 1;
      const recomputed = combineProbabilities({
        decision_weight: formulaInputs.decision_weight,
        decision_ownership: formulaInputs.decision_ownership,
        developer_reflection: formulaInputs.developer_reflection,
        developer_intent: formulaInputs.developer_intent,
      });
      const threshold = isFiniteNumber(record.preset_pause_threshold)
        ? record.preset_pause_threshold
        : PAUSE_THRESHOLDS.balanced;
      const recomputedPaused = recomputed.pauseProbability >= threshold;
      if (recomputedPaused === expectedPause) {
        recomputedCorrectCount += 1;
      }
    }
  }

  const joinedWithTraceCount = joined.filter((record) =>
    isFiniteNumber(record.score_after),
  ).length;
  const unjoinedSummariesCount = joined.length - joinedWithTraceCount;

  const stopTraceRecordsCount = Array.isArray(traceRecords)
    ? traceRecords.filter(
        (record) =>
          isPlainObject(record) &&
          (record.hook === "Stop" || !isNonEmptyString(record.hook)) &&
          isFiniteNumber(record.score_after),
      ).length
    : 0;
  const unjoinedTracesCount = Math.max(
    0,
    stopTraceRecordsCount - joinedWithTraceCount,
  );

  const totalLabelEntriesCount =
    labelEntriesList.length > 0 ? labelEntriesList.length : labels.size;
  const matchedLabelsCount =
    labelEntriesList.length > 0
      ? matchedLabelEntries.size
      : Math.min(totalLabelEntriesCount, totalLabeled);
  const unjoinedLabelsCount = Math.max(
    0,
    totalLabelEntriesCount - matchedLabelsCount,
  );

  let recomputedAccuracy = null;
  let recomputedReason = null;
  if (recomputedEligibleCount > 0) {
    recomputedAccuracy = roundMetric(
      recomputedCorrectCount / recomputedEligibleCount,
    );
  } else if (
    recomputedMissingInputsCount > 0 ||
    missingFormulaInputCounts.lines_missing_any_input > 0
  ) {
    recomputedReason = "missing_inputs";
  }

  return {
    data_label: REAL_DATA_LABEL,
    total_summaries: joined.length,
    joined_with_trace_count: joinedWithTraceCount,
    unjoined_summaries_count: unjoinedSummariesCount,
    unjoined_traces_count: unjoinedTracesCount,
    unjoined_labels_count: unjoinedLabelsCount,
    unlabeled_summaries_count: unlabeledSummariesCount,
    unjoined_counts: {
      summaries_without_trace: unjoinedSummariesCount,
      traces_without_summary: unjoinedTracesCount,
      labels_without_summary: unjoinedLabelsCount,
      summaries_without_label: unlabeledSummariesCount,
    },
    schema_version_counts: schemaVersionCounts,
    summary_status_counts: summaryStatusCounts,
    missing_formula_input_counts: missingFormulaInputCounts,
    accuracy_against_labels: {
      total_labeled: totalLabeled,
      unjoined_labels_count: unjoinedLabelsCount,
      unlabeled_summaries_count: unlabeledSummariesCount,
      logged_correct_count: loggedCorrectCount,
      logged_accuracy:
        totalLabeled > 0
          ? roundMetric(loggedCorrectCount / totalLabeled)
          : null,
      recomputed_v3_formula_eligible_count: recomputedEligibleCount,
      recomputed_v3_formula_missing_inputs_count: recomputedMissingInputsCount,
      recomputed_v3_formula_correct_count:
        recomputedEligibleCount > 0 ? recomputedCorrectCount : null,
      recomputed_v3_formula_accuracy: recomputedAccuracy,
      recomputed_v3_formula_reason: recomputedReason,
      missing_input_counts: missingFormulaInputCounts,
      confusion_matrix: {
        true_positives: truePositives,
        false_positives: falsePositives,
        true_negatives: trueNegatives,
        false_negatives: falseNegatives,
      },
    },
  };
}

/**
 * Run the complete offline evaluation harness over synthetic fixtures and any
 * optional read-only real trace/summary files.
 *
 * @param {object} options - Harness options.
 * @param {string} options.fixturesDir - Directory containing synthetic fixtures.
 * @param {string|string[]} [options.tracesPath] - Optional path(s), directory, or glob for `local-trace.jsonl`.
 * @param {string[]} [options.tracesPaths] - Optional array of trace paths/globs.
 * @param {string|string[]} [options.summariesPath] - Optional path, directory, or glob for `jev-experiment.jsonl`.
 * @param {string[]} [options.summariesPaths] - Optional array of summary paths, directories, or globs.
 * @param {string} [options.labelsPath] - Optional path to human turn labels.
 * @returns {Promise<object>} Complete evaluation report.
 */
export async function runEvaluation(options = {}) {
  const settings = isPlainObject(options) ? options : {};
  const fixturesDir = isNonEmptyString(settings.fixturesDir)
    ? settings.fixturesDir
    : path.resolve(path.dirname(new URL(import.meta.url).pathname), "fixtures");

  const fixtures = loadSyntheticFixtures(fixturesDir);
  const presetsReport = {
    data_label: SIMULATED_DATA_LABEL,
  };

  for (const preset of PRESET_NAMES) {
    presetsReport[preset] = await evaluatePresetOnFixtures(fixtures, preset);
  }

  const report = {
    data_label: SIMULATED_DATA_LABEL,
    pipeline_models: {
      data_label: SIMULATED_DATA_LABEL,
      state_model: STATE_MODEL,
      jev_model: "jev-latest",
      fallback_model: FALLBACK_MODEL,
    },
    timeout_constants: {
      data_label: SIMULATED_DATA_LABEL,
      state_timeout_ms: STATE_TIMEOUT_MS,
      sdk_timeout_ms: SDK_TIMEOUT_MS,
      margin_ms: MARGIN_MS,
      jev_timeout_ms: JEV_TIMEOUT_MS,
      fallback_timeout_ms: FALLBACK_TIMEOUT_MS,
      stop_hook_timeout_ms: STOP_HOOK_TIMEOUT_MS,
    },
    fixtures_summary: {
      data_label: SIMULATED_DATA_LABEL,
      fixture_count: fixtures.length,
      total_turns_per_preset: fixtures.reduce(
        (sum, fixture) => sum + fixture.turns.length,
        0,
      ),
      fixture_ids: fixtures.map((fixture) => fixture.case_id),
    },
    presets: presetsReport,
  };

  const traceInputs = [];
  if (Array.isArray(settings.tracesPaths)) {
    traceInputs.push(...settings.tracesPaths.filter(isNonEmptyString));
  }
  if (Array.isArray(settings.tracesPath)) {
    traceInputs.push(...settings.tracesPath.filter(isNonEmptyString));
  } else if (isNonEmptyString(settings.tracesPath)) {
    traceInputs.push(settings.tracesPath);
  }

  const summaryInputs = [];
  if (Array.isArray(settings.summariesPaths)) {
    summaryInputs.push(...settings.summariesPaths.filter(isNonEmptyString));
  }
  if (Array.isArray(settings.summariesPath)) {
    summaryInputs.push(...settings.summariesPath.filter(isNonEmptyString));
  } else if (isNonEmptyString(settings.summariesPath)) {
    summaryInputs.push(settings.summariesPath);
  }

  const hasTraces = traceInputs.length > 0;
  const hasSummaries = summaryInputs.length > 0;

  if (hasTraces || hasSummaries) {
    const traceRead = hasTraces
      ? readTraceFileReadOnly(traceInputs)
      : {
          records: [],
          files_read: [],
          skipped_malformed_lines: 0,
          duplicate_lines_skipped: 0,
          total_non_empty_lines: 0,
        };
    const summaryRead = hasSummaries
      ? readSummaryFileReadOnly(summaryInputs)
      : {
          summaries: [],
          files_read: [],
          skipped_malformed_lines: 0,
          duplicate_summaries_skipped: 0,
          total_non_empty_lines: 0,
        };
    const labels = isNonEmptyString(settings.labelsPath)
      ? readLabelsFileReadOnly(settings.labelsPath)
      : new Map();

    const presetReplays = {};
    for (const preset of PRESET_NAMES) {
      presetReplays[preset] = replayRealTraceForPreset(
        traceRead.records,
        preset,
      );
    }

    const projectsBreakdown = {};
    for (const preset of PRESET_NAMES) {
      for (const [projectId, projectPresetReplay] of Object.entries(
        presetReplays[preset].per_project,
      )) {
        if (!projectsBreakdown[projectId]) {
          projectsBreakdown[projectId] = {
            data_label: REPLAY_PROJECTION_LABEL,
            project: projectId,
            total_stop_turns: projectPresetReplay.total_stop_turns,
            logged_outcomes: projectPresetReplay.logged_outcomes,
            presets: {},
          };
        }
        projectsBreakdown[projectId].presets[preset] = projectPresetReplay;
      }
    }

    report.real_data = {
      data_label: REAL_DATA_LABEL,
      trace_replay: {
        data_label: REPLAY_PROJECTION_LABEL,
        files_read: traceRead.files_read,
        total_non_empty_lines: traceRead.total_non_empty_lines,
        parsed_records_count: traceRead.records.length,
        duplicate_lines_skipped: traceRead.duplicate_lines_skipped,
        skipped_malformed_lines: traceRead.skipped_malformed_lines,
        project_count: Object.keys(projectsBreakdown).length,
        logged_outcomes: presetReplays.balanced.logged_outcomes,
        projects: projectsBreakdown,
        totals: {
          data_label: REPLAY_PROJECTION_LABEL,
          total_stop_turns: presetReplays.balanced.total_stop_turns,
          logged_outcomes: presetReplays.balanced.logged_outcomes,
          presets: presetReplays,
        },
        presets: presetReplays,
      },
      summary_evaluation: {
        data_label: REAL_DATA_LABEL,
        files_read: summaryRead.files_read,
        total_non_empty_lines: summaryRead.total_non_empty_lines,
        parsed_summaries_count: summaryRead.summaries.length,
        duplicate_summaries_skipped: summaryRead.duplicate_summaries_skipped,
        skipped_malformed_lines: summaryRead.skipped_malformed_lines,
        ...evaluateRealSummaries({
          summaries: summaryRead.summaries,
          traceRecords: traceRead.records,
          labels,
        }),
      },
    };
  }

  return report;
}

/**
 * Parse CLI arguments (`--fixtures`, `--out`, `--traces` repeatable,
 * `--summaries`, `--labels`).
 *
 * @param {string[]} argv - Command-line arguments after `node <script>`.
 * @returns {{
 *   fixturesDir: string|null,
 *   outPath: string|null,
 *   tracesPath: string|null,
 *   tracesPaths: string[],
 *   summariesPath: string|null,
 *   summariesPaths: string[],
 *   labelsPath: string|null,
 * }} Parsed CLI flags.
 */
export function parseCliArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const parsed = {
    fixturesDir: null,
    outPath: null,
    tracesPath: null,
    tracesPaths: [],
    summariesPath: null,
    summariesPaths: [],
    labelsPath: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const nextValue = args[index + 1];
    if (flag === "--fixtures" && isNonEmptyString(nextValue)) {
      parsed.fixturesDir = nextValue;
      index += 1;
    } else if (flag === "--out" && isNonEmptyString(nextValue)) {
      parsed.outPath = nextValue;
      index += 1;
    } else if (flag === "--traces" && isNonEmptyString(nextValue)) {
      parsed.tracesPaths.push(nextValue);
      parsed.tracesPath = nextValue;
      index += 1;
    } else if (flag === "--summaries" && isNonEmptyString(nextValue)) {
      parsed.summariesPaths.push(nextValue);
      parsed.summariesPath = nextValue;
      index += 1;
    } else if (flag === "--labels" && isNonEmptyString(nextValue)) {
      parsed.labelsPath = nextValue;
      index += 1;
    }
  }

  return parsed;
}

/** CLI entrypoint for `experiments/jev/eval/run-eval.js`. */
async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const report = await runEvaluation({
    fixturesDir: cli.fixturesDir,
    tracesPaths: cli.tracesPaths,
    tracesPath: cli.tracesPath,
    summariesPaths: cli.summariesPaths,
    summariesPath: cli.summariesPath,
    labelsPath: cli.labelsPath,
  });

  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (isNonEmptyString(cli.outPath)) {
    fs.mkdirSync(path.dirname(path.resolve(cli.outPath)), { recursive: true });
    fs.writeFileSync(cli.outPath, serialized, "utf8");
  } else {
    process.stdout.write(serialized);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  void main();
}
