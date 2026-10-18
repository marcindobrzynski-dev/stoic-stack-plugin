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
  DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLD,
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
  VETO_COOLDOWN_RATIO,
} from "../constants.js";
import { joinSummaryWithLocalTrace, parseSummaryLine } from "../log.js";
import { classifyTurn, combineProbabilities } from "../run.js";
import { runJev } from "../runner.js";
import { JEV_TIMEOUT_MS, MARGIN_MS, SDK_TIMEOUT_MS } from "../timing.js";

/** Data label carried by all synthetic fixture evaluation objects. */
export const SIMULATED_DATA_LABEL = "SIMULATED";

/** Data label carried by all real trace/summary evaluation objects. */
export const REAL_DATA_LABEL = "REAL-DATA";

/** Stop hook wall-clock timeout in `hooks/hooks.json` (90 seconds). */
export const STOP_HOOK_TIMEOUT_MS = 90_000;

/** Ordered histogram bin keys for `pause_probability` in [0, 1]. */
export const PAUSE_PROBABILITY_BINS = Object.freeze([
  "0.0-0.2",
  "0.2-0.4",
  "0.4-0.6",
  "0.6-0.8",
  "0.8-1.0",
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
 * Run one turn's classification through the real `classifyTurn` and `runJev`
 * functions with deterministic stubbed runners and timings.
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
 *   runnerTotalMs: number,
 *   endToEndMs: number,
 *   pauseProbability: number|null,
 *   provider: string|null,
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

  const sonnetMs = isFiniteNumber(sonnetSpec.latency_ms)
    ? sonnetSpec.latency_ms
    : 0;
  const categoriesMs = {};
  for (const category of CATEGORY_REGISTRY) {
    const rawCatMs = jevSpec.categories?.[category.name]?.latency_ms;
    categoriesMs[category.name] = isFiniteNumber(rawCatMs) ? rawCatMs : null;
  }
  const maxCategoryMs = Math.max(
    0,
    ...Object.values(categoriesMs).filter((value) => isFiniteNumber(value)),
  );
  const jevMs = isFiniteNumber(jevSpec.jev_ms) ? jevSpec.jev_ms : maxCategoryMs;

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
  const fallbackMs =
    !childSucceeded && isFiniteNumber(fallbackSpec?.latency_ms)
      ? fallbackSpec.latency_ms
      : !childSucceeded
        ? 0
        : null;
  const endToEndMs = sonnetMs + jevMs + (fallbackMs ?? 0);
  const runnerTotalMs = endToEndMs;

  const allFourPresent =
    isPlainObject(childOutcome.probabilities) &&
    CATEGORY_REGISTRY.every((category) =>
      isFiniteNumber(childOutcome.probabilities[category.name]),
    );
  const pauseProbability = allFourPresent
    ? combineProbabilities(childOutcome.probabilities).pauseProbability
    : null;

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
    sonnetMs,
    jevMs,
    categoriesMs,
    fallbackMs,
    runnerTotalMs,
    endToEndMs,
    pauseProbability,
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
          mutes: [],
        };

        const classifierNeededForCooldown = willReachClassifier(
          personalStateWithCooldown,
          config,
          group,
          turnContext,
        );

        let preparedCooldown = null;
        let decisionWithCooldown;

        if (classifierNeededForCooldown) {
          callsWithVetoCooldown += 1;
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

        const scoreAfterCooldown = isFiniteNumber(
          decisionWithCooldown.cooled_score,
        )
          ? decisionWithCooldown.cooled_score
          : scoreBeforeCooldown;
        currentScoreWithCooldown = scoreAfterCooldown;

        if (decisionWithCooldown.outcome === "fire") {
          pauseCount += 1;
        } else if (decisionWithCooldown.outcome === "veto") {
          vetoReasonCounts.total_vetoes += 1;
          if (VETO_REASONS.includes(decisionWithCooldown.reason)) {
            vetoReasonCounts[decisionWithCooldown.reason] += 1;
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

        // 2. Baseline trajectory (e4b111e): veto leaves score unchanged
        const scoreBeforeBaseline = scoreTurn(
          currentScoreBaseline,
          elapsedMs,
          group,
          scoringKnobs,
        );
        const personalStateBaseline = {
          score: scoreBeforeBaseline,
          preset,
          mutes: [],
        };
        const classifierNeededForBaseline = willReachClassifier(
          personalStateBaseline,
          config,
          group,
          turnContext,
        );

        let decisionBaseline;
        if (classifierNeededForBaseline) {
          callsBaselineNoVetoCooldown += 1;
          const preparedBaseline =
            preparedCooldown ??
            (await prepareStubbedTurnClassification({
              turnSpec,
              group,
              config,
              personalState: personalStateBaseline,
              turnContext,
              homeDir,
            }));
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
        const runnerTotalMs = preparedCooldown
          ? preparedCooldown.runnerTotalMs
          : null;

        const trajectoryEntry = {
          case_id: caseId,
          turn_id: turnSpec.turn_id,
          prompt_id: turnSpec.prompt_id ?? null,
          preset,
          threshold,
          pause_cooldown_ratio: pauseCooldownRatio,
          veto_cooldown_ratio: VETO_COOLDOWN_RATIO,
          with_veto_cooldown: {
            score_before: roundMetric(scoreBeforeCooldown),
            outcome: decisionWithCooldown.outcome,
            veto_reason:
              decisionWithCooldown.outcome === "veto"
                ? decisionWithCooldown.reason
                : null,
            pause_probability: turnPauseProbability,
            confidence: decisionWithCooldown.classification?.confidence ?? null,
            subcategory:
              decisionWithCooldown.classification?.subcategory ?? null,
            provider,
            classifier_called: classifierNeededForCooldown,
            score_after: roundMetric(scoreAfterCooldown),
          },
          baseline_e4b111e_no_veto_cooldown: {
            score_before: roundMetric(scoreBeforeBaseline),
            outcome: decisionBaseline.outcome,
            veto_reason:
              decisionBaseline.outcome === "veto"
                ? decisionBaseline.reason
                : null,
            classifier_called: classifierNeededForBaseline,
            score_after: roundMetric(scoreAfterBaseline),
          },
        };
        scoreTrajectory.push(trajectoryEntry);
        caseTurns.push(trajectoryEntry);

        perTurnLatency.push({
          case_id: caseId,
          turn_id: turnSpec.turn_id,
          classifier_called: classifierNeededForCooldown,
          provider,
          sonnet_ms: sonnetMs,
          jev_ms: jevMs,
          categories_ms: categoriesMs,
          fallback_ms: fallbackMs,
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

    const classifiedLatencies = perTurnLatency
      .filter((entry) => entry.classifier_called)
      .map((entry) => entry.end_to_end_ms);
    const maxEndToEndMs =
      perTurnLatency.length > 0
        ? Math.max(...perTurnLatency.map((entry) => entry.end_to_end_ms))
        : 0;
    const meanClassifiedEndToEndMs =
      classifiedLatencies.length > 0
        ? roundMetric(
            classifiedLatencies.reduce((sum, value) => sum + value, 0) /
              classifiedLatencies.length,
          )
        : 0;

    const callsSaved = callsBaselineNoVetoCooldown - callsWithVetoCooldown;

    return {
      data_label: SIMULATED_DATA_LABEL,
      preset,
      score_threshold: threshold,
      preset_pause_threshold: PAUSE_THRESHOLDS[preset],
      pause_cooldown_ratio: pauseCooldownRatio,
      veto_cooldown_ratio: VETO_COOLDOWN_RATIO,
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
 * Parse a `local-trace.jsonl` file read-only, skipping blank or malformed
 * lines without throwing.
 *
 * @param {string} tracesFilePath - Path to `local-trace.jsonl`.
 * @returns {{
 *   records: object[],
 *   skipped_malformed_lines: number,
 *   total_non_empty_lines: number,
 * }} Parsed trace records and line counts.
 */
export function readTraceFileReadOnly(tracesFilePath) {
  try {
    const rawText = fs.readFileSync(tracesFilePath, "utf8");
    const records = [];
    let skippedMalformedLines = 0;
    let totalNonEmptyLines = 0;

    for (const rawLine of rawText.split(/\r?\n/)) {
      if (rawLine.trim() === "") {
        continue;
      }
      totalNonEmptyLines += 1;
      try {
        const parsed = JSON.parse(rawLine);
        if (isPlainObject(parsed)) {
          records.push(parsed);
        } else {
          skippedMalformedLines += 1;
        }
      } catch {
        skippedMalformedLines += 1;
      }
    }

    return {
      records,
      skipped_malformed_lines: skippedMalformedLines,
      total_non_empty_lines: totalNonEmptyLines,
    };
  } catch {
    return {
      records: [],
      skipped_malformed_lines: 0,
      total_non_empty_lines: 0,
    };
  }
}

/**
 * Parse a `jev-experiment.jsonl` file read-only using `parseSummaryLine`
 * (tolerating v1, v2, and v3 lines and unknown fields) and skipping blank or
 * malformed lines without throwing.
 *
 * @param {string} summariesFilePath - Path to `jev-experiment.jsonl`.
 * @returns {{
 *   summaries: object[],
 *   skipped_malformed_lines: number,
 *   total_non_empty_lines: number,
 * }} Normalized summary records and line counts.
 */
export function readSummaryFileReadOnly(summariesFilePath) {
  try {
    const rawText = fs.readFileSync(summariesFilePath, "utf8");
    const summaries = [];
    let skippedMalformedLines = 0;
    let totalNonEmptyLines = 0;

    for (const rawLine of rawText.split(/\r?\n/)) {
      if (rawLine.trim() === "") {
        continue;
      }
      totalNonEmptyLines += 1;
      const parsed = parseSummaryLine(rawLine);
      if (parsed !== null) {
        summaries.push(parsed);
      } else {
        skippedMalformedLines += 1;
      }
    }

    return {
      summaries,
      skipped_malformed_lines: skippedMalformedLines,
      total_non_empty_lines: totalNonEmptyLines,
    };
  } catch {
    return {
      summaries: [],
      skipped_malformed_lines: 0,
      total_non_empty_lines: 0,
    };
  }
}

/**
 * Read optional human turn labels from a JSON or JSONL file read-only without
 * throwing.
 *
 * Supported formats:
 * - JSON object mapping `prompt_id` (or `ts`) to `boolean` or
 *   `{ should_pause: boolean }` / `{ decision_found: boolean }`
 * - JSON array of `{ prompt_id?, ts?, should_pause?: boolean, decision_found?: boolean }`
 * - JSONL lines of `{ prompt_id?, ts?, should_pause?: boolean, decision_found?: boolean }`
 *
 * @param {string} labelsFilePath - Path to the labels file.
 * @returns {Map<string, boolean>} Map from `prompt_id` or `ts` key to expected boolean pause label.
 */
export function readLabelsFileReadOnly(labelsFilePath) {
  const labelMap = new Map();
  if (!isNonEmptyString(labelsFilePath)) {
    return labelMap;
  }

  function recordEntry(key, rawValue) {
    if (!isNonEmptyString(key)) {
      return;
    }
    if (typeof rawValue === "boolean") {
      labelMap.set(key, rawValue);
    } else if (isPlainObject(rawValue)) {
      if (typeof rawValue.should_pause === "boolean") {
        labelMap.set(key, rawValue.should_pause);
      } else if (typeof rawValue.expected_pause === "boolean") {
        labelMap.set(key, rawValue.expected_pause);
      } else if (typeof rawValue.decision_found === "boolean") {
        labelMap.set(key, rawValue.decision_found);
      }
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
          if (isPlainObject(item)) {
            recordEntry(item.prompt_id ?? item.ts, item);
          }
        }
        return labelMap;
      }
      if (isPlainObject(parsedJson)) {
        for (const [key, value] of Object.entries(parsedJson)) {
          recordEntry(key, value);
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
        if (isPlainObject(item)) {
          recordEntry(item.prompt_id ?? item.ts, item);
        }
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
 * Replay score dynamics and classifier call frequency (with `0.8` veto
 * cooldown vs `e4b111e` no-veto-cooldown baseline) over real `local-trace.jsonl`
 * Stop records. Never makes live calls and keeps all inputs read-only.
 *
 * @param {object[]} traceRecords - Parsed trace records from `local-trace.jsonl`.
 * @param {string} [preset] - Preset to replay (`calm`, `balanced`, `vigilant`).
 * @returns {object} `REAL-DATA` replay report for the preset.
 */
export function replayRealTraceForPreset(traceRecords, preset = "balanced") {
  const knobs = resolveKnobs({ preset }, { preset });
  const threshold = knobs.threshold;
  const halfLifeHours = knobs.half_life_hours;
  const pauseCooldownRatio = knobs.cooldown_ratio;

  const stopRecords = Array.isArray(traceRecords)
    ? traceRecords.filter(
        (record) =>
          isPlainObject(record) &&
          (record.hook === "Stop" || !isNonEmptyString(record.hook)) &&
          isFiniteNumber(record.score_before) &&
          isFiniteNumber(record.score_after) &&
          ["scored", "veto", "muted", "fired"].includes(record.outcome),
      )
    : [];

  let scoreWithVetoCooldown =
    stopRecords.length > 0 ? stopRecords[0].score_before : 0;
  let scoreBaseline = scoreWithVetoCooldown;
  let previousTimestampMs = null;

  let callsWithVetoCooldown = 0;
  let callsBaseline = 0;
  const trajectory = [];

  for (let index = 0; index < stopRecords.length; index += 1) {
    const record = stopRecords[index];
    const parsedTs = isNonEmptyString(record.ts)
      ? Date.parse(record.ts)
      : Number.NaN;
    const elapsedMs =
      Number.isFinite(parsedTs) &&
      previousTimestampMs !== null &&
      parsedTs > previousTimestampMs
        ? parsedTs - previousTimestampMs
        : 0;
    if (Number.isFinite(parsedTs)) {
      previousTimestampMs = parsedTs;
    }

    const decayedLoggedBefore = decayScore(
      record.score_before,
      elapsedMs,
      halfLifeHours,
    );
    // Recover the pre-cooldown turn delta from the trace record:
    // On `scored`, `muted`, or `e4b111e` un-cooled `veto` records where
    // `score_after >= score_before`, `score_after - decayedLoggedBefore` is
    // the exact turn delta. When a record was already cooled (`fired` or v3
    // cooled `veto`), the turn had to reach at least `record.score_before`
    // (or `threshold` on a score-triggered turn).
    let rawPreCooldownScore = record.score_after;
    if (
      (record.outcome === "fired" || record.outcome === "veto") &&
      record.score_after < record.score_before
    ) {
      rawPreCooldownScore = Math.max(
        record.score_before,
        record.trigger === "critical_path" ? record.score_before : threshold,
      );
    }
    const inferredDelta = rawPreCooldownScore - decayedLoggedBefore;

    const isCriticalPath = record.trigger === "critical_path";

    // 1. Replay with veto cooldown (0.8 * threshold)
    const nextPreGateWithCooldown = Math.max(
      0,
      decayScore(scoreWithVetoCooldown, elapsedMs, halfLifeHours) +
        inferredDelta,
    );
    const calledWithCooldown =
      isCriticalPath || nextPreGateWithCooldown >= threshold;
    let nextAfterWithCooldown = nextPreGateWithCooldown;
    if (calledWithCooldown) {
      callsWithVetoCooldown += 1;
      if (record.outcome === "fired") {
        nextAfterWithCooldown = relievedScore(
          nextPreGateWithCooldown,
          threshold,
          pauseCooldownRatio,
        );
      } else if (
        record.outcome !== "muted" &&
        record.reason !== "bad_category"
      ) {
        nextAfterWithCooldown = relievedScore(
          nextPreGateWithCooldown,
          threshold,
          VETO_COOLDOWN_RATIO,
        );
      }
    }
    scoreWithVetoCooldown = nextAfterWithCooldown;

    // 2. Replay under e4b111e baseline (veto leaves score unchanged)
    const nextPreGateBaseline = Math.max(
      0,
      decayScore(scoreBaseline, elapsedMs, halfLifeHours) + inferredDelta,
    );
    const calledBaseline = isCriticalPath || nextPreGateBaseline >= threshold;
    let nextAfterBaseline = nextPreGateBaseline;
    if (calledBaseline) {
      callsBaseline += 1;
      if (record.outcome === "fired") {
        nextAfterBaseline = relievedScore(
          nextPreGateBaseline,
          threshold,
          pauseCooldownRatio,
        );
      }
    }
    scoreBaseline = nextAfterBaseline;

    trajectory.push({
      turn_index: index + 1,
      ts: record.ts ?? null,
      prompt_id: record.prompt_id ?? null,
      session_id: record.session_id ?? null,
      logged_outcome: record.outcome,
      with_veto_cooldown: {
        score_before_gate: roundMetric(nextPreGateWithCooldown),
        classifier_called: calledWithCooldown,
        score_after: roundMetric(nextAfterWithCooldown),
      },
      baseline_e4b111e_no_veto_cooldown: {
        score_before_gate: roundMetric(nextPreGateBaseline),
        classifier_called: calledBaseline,
        score_after: roundMetric(nextAfterBaseline),
      },
    });
  }

  const totalStopTurns = stopRecords.length;
  const callsSaved = callsBaseline - callsWithVetoCooldown;

  return {
    data_label: REAL_DATA_LABEL,
    preset,
    threshold,
    total_stop_turns: totalStopTurns,
    with_veto_cooldown: {
      call_count: callsWithVetoCooldown,
      call_frequency:
        totalStopTurns > 0
          ? roundMetric(callsWithVetoCooldown / totalStopTurns)
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
 * Evaluate logged `jev-experiment.jsonl` summaries (v1, v2, and v3) against
 * optional human labels and optional `local-trace.jsonl` records.
 *
 * @param {object} params - Real-data evaluation inputs.
 * @param {object[]} params.summaries - Normalized summary records from `readSummaryFileReadOnly`.
 * @param {object[]} [params.traceRecords] - Parsed trace records from `readTraceFileReadOnly`.
 * @param {Map<string, boolean>} [params.labels] - Optional human pause labels keyed by `prompt_id` or `ts`.
 * @returns {object} `REAL-DATA` summary evaluation object.
 */
export function evaluateRealSummaries({
  summaries,
  traceRecords = [],
  labels = new Map(),
}) {
  const joined = joinSummaryWithLocalTrace(summaries, traceRecords);
  const schemaVersionCounts = { v1: 0, v2: 0, v3: 0 };

  let totalLabeled = 0;
  let loggedCorrectCount = 0;
  let recomputedCorrectCount = 0;
  let truePositives = 0;
  let falsePositives = 0;
  let trueNegatives = 0;
  let falseNegatives = 0;

  for (const record of joined) {
    if (record.schema_version === 1) {
      schemaVersionCounts.v1 += 1;
    } else if (record.schema_version === 2) {
      schemaVersionCounts.v2 += 1;
    } else if (record.schema_version === 3) {
      schemaVersionCounts.v3 += 1;
    }

    const labelKey = isNonEmptyString(record.prompt_id)
      ? record.prompt_id
      : record.ts;
    if (!labels.has(labelKey) && !labels.has(record.ts)) {
      continue;
    }
    const expectedPause = labels.get(labelKey) ?? labels.get(record.ts);
    totalLabeled += 1;

    const loggedConfidence = isFiniteNumber(record.confidence)
      ? record.confidence
      : isFiniteNumber(record.verdict?.confidence)
        ? record.verdict.confidence
        : 1;
    const loggedDecisionFound =
      typeof record.decision_found === "boolean"
        ? record.decision_found
        : record.verdict?.decision_found === true;
    const loggedPaused =
      loggedDecisionFound &&
      loggedConfidence >= DEFAULT_CLASSIFIER_CONFIDENCE_THRESHOLD;

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

    const formulaInputs = record.formula_inputs ?? {};
    const recomputed = combineProbabilities({
      decision_weight: formulaInputs.decision_weight ?? 0,
      decision_ownership: formulaInputs.decision_ownership ?? 0,
      developer_reflection: formulaInputs.developer_reflection ?? 0,
      developer_intent: formulaInputs.developer_intent ?? 0,
    });
    const threshold = isFiniteNumber(record.preset_pause_threshold)
      ? record.preset_pause_threshold
      : PAUSE_THRESHOLDS.balanced;
    const recomputedPaused = recomputed.pauseProbability >= threshold;
    if (recomputedPaused === expectedPause) {
      recomputedCorrectCount += 1;
    }
  }

  return {
    data_label: REAL_DATA_LABEL,
    total_summaries: joined.length,
    joined_with_trace_count: joined.filter((record) =>
      isFiniteNumber(record.score_after),
    ).length,
    schema_version_counts: schemaVersionCounts,
    accuracy_against_labels: {
      total_labeled: totalLabeled,
      logged_correct_count: loggedCorrectCount,
      logged_accuracy:
        totalLabeled > 0
          ? roundMetric(loggedCorrectCount / totalLabeled)
          : null,
      recomputed_v3_formula_correct_count: recomputedCorrectCount,
      recomputed_v3_formula_accuracy:
        totalLabeled > 0
          ? roundMetric(recomputedCorrectCount / totalLabeled)
          : null,
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
 * @param {string} [options.tracesPath] - Optional path to `local-trace.jsonl`.
 * @param {string} [options.summariesPath] - Optional path to `jev-experiment.jsonl`.
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

  const hasTraces = isNonEmptyString(settings.tracesPath);
  const hasSummaries = isNonEmptyString(settings.summariesPath);

  if (hasTraces || hasSummaries) {
    const traceRead = hasTraces
      ? readTraceFileReadOnly(settings.tracesPath)
      : { records: [], skipped_malformed_lines: 0, total_non_empty_lines: 0 };
    const summaryRead = hasSummaries
      ? readSummaryFileReadOnly(settings.summariesPath)
      : { summaries: [], skipped_malformed_lines: 0, total_non_empty_lines: 0 };
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

    report.real_data = {
      data_label: REAL_DATA_LABEL,
      trace_replay: {
        data_label: REAL_DATA_LABEL,
        total_non_empty_lines: traceRead.total_non_empty_lines,
        parsed_records_count: traceRead.records.length,
        skipped_malformed_lines: traceRead.skipped_malformed_lines,
        presets: presetReplays,
      },
      summary_evaluation: {
        data_label: REAL_DATA_LABEL,
        total_non_empty_lines: summaryRead.total_non_empty_lines,
        parsed_summaries_count: summaryRead.summaries.length,
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
 * Parse CLI arguments (`--fixtures`, `--out`, `--traces`, `--summaries`,
 * `--labels`).
 *
 * @param {string[]} argv - Command-line arguments after `node <script>`.
 * @returns {{
 *   fixturesDir: string|null,
 *   outPath: string|null,
 *   tracesPath: string|null,
 *   summariesPath: string|null,
 *   labelsPath: string|null,
 * }} Parsed CLI flags.
 */
export function parseCliArgs(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const parsed = {
    fixturesDir: null,
    outPath: null,
    tracesPath: null,
    summariesPath: null,
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
      parsed.tracesPath = nextValue;
      index += 1;
    } else if (flag === "--summaries" && isNonEmptyString(nextValue)) {
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
    tracesPath: cli.tracesPath,
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
