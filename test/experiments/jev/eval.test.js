import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  FALLBACK_TIMEOUT_MS,
  STATE_TIMEOUT_MS,
  VETO_COOLDOWN_RATIO,
} from "../../../experiments/jev/constants.js";
import {
  REAL_DATA_LABEL,
  SIMULATED_DATA_LABEL,
  STOP_HOOK_TIMEOUT_MS,
  parseCliArgs,
  runEvaluation,
} from "../../../experiments/jev/eval/run-eval.js";
import {
  JEV_TIMEOUT_MS,
  MARGIN_MS,
  SDK_TIMEOUT_MS,
} from "../../../experiments/jev/timing.js";
import { PRESETS, PRESET_NAMES } from "../../../src/io/config/config.js";

const FIXTURES_DIR = path.resolve("experiments/jev/eval/fixtures");

test("trivial_css_change synthetic fixture never pauses on any preset", async () => {
  const report = await runEvaluation({ fixturesDir: FIXTURES_DIR });

  for (const preset of PRESET_NAMES) {
    const cssCase = report.presets[preset].cases.trivial_css_change;
    assert.equal(cssCase.paused_turns, 0);
    for (const turn of cssCase.turns) {
      assert.notEqual(turn.with_veto_cooldown.outcome, "fire");
    }
  }
});

test("reflex_approval_bare_pick_streak synthetic fixture over an important AI decision pauses on every preset", async () => {
  const report = await runEvaluation({ fixturesDir: FIXTURES_DIR });

  for (const preset of PRESET_NAMES) {
    const reflexCase =
      report.presets[preset].cases.reflex_approval_bare_pick_streak;
    assert.equal(reflexCase.paused_turns, 1);
    const firstTurn = reflexCase.turns[0].with_veto_cooldown;
    assert.equal(firstTurn.outcome, "fire");
    assert.equal(firstTurn.subcategory, "security_auth");
    assert.equal(
      firstTurn.score_after,
      PRESETS[preset].threshold * PRESETS[preset].cooldown_ratio,
    );
  }
});

test("developer_refined_proposal synthetic fixture is vetoed because developer_intent raises effective_reflection", async () => {
  const report = await runEvaluation({ fixturesDir: FIXTURES_DIR });

  for (const preset of PRESET_NAMES) {
    const refinedCase = report.presets[preset].cases.developer_refined_proposal;
    assert.equal(refinedCase.paused_turns, 0);
    const firstTurn = refinedCase.turns[0].with_veto_cooldown;
    assert.equal(firstTurn.outcome, "veto");
    assert.equal(firstTurn.veto_reason, "low_confidence");
    assert.equal(firstTurn.score_after < PRESETS[preset].threshold, true);
    assert.equal(
      refinedCase.turns[1].with_veto_cooldown.outcome,
      "below_gates",
    );
  }
});

test("small_one_way_decision and adr_without_code synthetic fixtures pause despite small or empty code diffs", async () => {
  const report = await runEvaluation({ fixturesDir: FIXTURES_DIR });

  for (const preset of PRESET_NAMES) {
    const oneWayCase = report.presets[preset].cases.small_one_way_decision;
    const adrCase = report.presets[preset].cases.adr_without_code;

    assert.equal(oneWayCase.paused_turns, 1);
    assert.equal(
      oneWayCase.turns[0].with_veto_cooldown.subcategory,
      "migration_strategy",
    );

    assert.equal(adrCase.paused_turns, 1);
    assert.equal(
      adrCase.turns[0].with_veto_cooldown.subcategory,
      "architecture_pattern",
    );
  }
});

test("veto cooldown lowers classifier call count and frequency compared to the e4b111e baseline", async () => {
  const report = await runEvaluation({ fixturesDir: FIXTURES_DIR });

  for (const preset of PRESET_NAMES) {
    const comparison = report.presets[preset].classifier_call_comparison;
    assert.equal(
      comparison.with_veto_cooldown.call_count <
        comparison.baseline_e4b111e_no_veto_cooldown.call_count,
      true,
    );
    assert.equal(
      comparison.with_veto_cooldown.call_frequency <
        comparison.baseline_e4b111e_no_veto_cooldown.call_frequency,
      true,
    );
    assert.equal(comparison.calls_saved, 3);
  }
});

test("one_category_failing vetoes with no_decision without fallback while all_four_failing_fallback runs headless_fallback", async () => {
  const report = await runEvaluation({ fixturesDir: FIXTURES_DIR });

  for (const preset of PRESET_NAMES) {
    const oneFailTurn =
      report.presets[preset].cases.one_category_failing.turns[0]
        .with_veto_cooldown;
    assert.equal(oneFailTurn.outcome, "veto");
    assert.equal(oneFailTurn.veto_reason, "no_decision");
    assert.equal(oneFailTurn.provider, "jev");

    const allFailTurn =
      report.presets[preset].cases.all_four_failing_fallback.turns[0]
        .with_veto_cooldown;
    assert.equal(allFailTurn.provider, "headless_fallback");
    assert.equal(allFailTurn.outcome, "fire");
  }
});

test("latency_budget reports runner_total_ms and end_to_end_ms as different spans", async () => {
  const report = await runEvaluation({ fixturesDir: FIXTURES_DIR });
  const latencyBudget = report.presets.balanced.latency_budget;

  assert.deepEqual(latencyBudget.constants_ms, {
    state_timeout_ms: STATE_TIMEOUT_MS,
    sdk_timeout_ms: SDK_TIMEOUT_MS,
    margin_ms: MARGIN_MS,
    jev_timeout_ms: JEV_TIMEOUT_MS,
    fallback_timeout_ms: FALLBACK_TIMEOUT_MS,
    worst_case_child_plus_fallback_ms: JEV_TIMEOUT_MS + FALLBACK_TIMEOUT_MS,
    stop_hook_timeout_ms: STOP_HOOK_TIMEOUT_MS,
    hook_headroom_ms:
      STOP_HOOK_TIMEOUT_MS - (JEV_TIMEOUT_MS + FALLBACK_TIMEOUT_MS),
  });

  const fallbackTurnLatency = latencyBudget.per_turn.find(
    (entry) => entry.case_id === "all_four_failing_fallback",
  );
  assert.equal(fallbackTurnLatency.sonnet_ms, 480);
  assert.equal(fallbackTurnLatency.jev_ms, 5000);
  assert.equal(fallbackTurnLatency.fallback_ms, 620);
  assert.equal(fallbackTurnLatency.ipc_overhead_ms, 12);
  assert.equal(
    fallbackTurnLatency.runner_total_ms,
    fallbackTurnLatency.jev_ms + fallbackTurnLatency.fallback_ms,
  );
  assert.equal(
    fallbackTurnLatency.end_to_end_ms,
    fallbackTurnLatency.sonnet_ms +
      fallbackTurnLatency.runner_total_ms +
      fallbackTurnLatency.ipc_overhead_ms,
  );
  assert.notEqual(
    fallbackTurnLatency.runner_total_ms,
    fallbackTurnLatency.end_to_end_ms,
  );
  assert.equal(typeof latencyBudget.max_runner_total_ms, "number");
  assert.equal(typeof latencyBudget.max_end_to_end_ms, "number");
  assert.notEqual(
    latencyBudget.max_runner_total_ms,
    latencyBudget.max_end_to_end_ms,
  );
  assert.notEqual(
    latencyBudget.mean_classified_runner_total_ms,
    latencyBudget.mean_classified_end_to_end_ms,
  );
  assert.equal(fallbackTurnLatency.within_hook_budget, true);
});

test("runEvaluation tags every top-level synthetic object SIMULATED and emits REAL-DATA only when real files are supplied", async () => {
  const simulatedReport = await runEvaluation({ fixturesDir: FIXTURES_DIR });

  assert.equal(simulatedReport.data_label, SIMULATED_DATA_LABEL);
  assert.equal("real_data" in simulatedReport, false);

  for (const topValue of Object.values(simulatedReport)) {
    if (typeof topValue === "object" && topValue !== null) {
      assert.equal(topValue.data_label, SIMULATED_DATA_LABEL);
    }
  }
  for (const preset of PRESET_NAMES) {
    assert.equal(
      simulatedReport.presets[preset].data_label,
      SIMULATED_DATA_LABEL,
    );
  }
  assert.equal(
    JSON.stringify(simulatedReport).includes(REAL_DATA_LABEL),
    false,
  );
});

function writeRealReplayFixture(tempDir) {
  const tracesPath = path.join(tempDir, "local-trace.jsonl");
  const summariesPath = path.join(tempDir, "jev-experiment.jsonl");
  const labelsPath = path.join(tempDir, "labels.json");
  const traceLines = [
    "",
    "{not-valid-json",
    JSON.stringify({
      ts: "2026-10-18T11:00:00.000Z",
      hook: "Stop",
      outcome: "veto",
      reason: "no_decision",
      score_before: 9.5,
      score_after: 10.5,
      session_id: "sess-1",
      prompt_id: "p-1",
      turn_ts: "2026-10-18T11:00:00.000Z",
    }),
    JSON.stringify({
      ts: "2026-10-18T11:01:00.000Z",
      hook: "Stop",
      outcome: "veto",
      reason: "no_decision",
      score_before: 10.5,
      score_after: 11.0,
      session_id: "sess-1",
      prompt_id: "p-2",
      turn_ts: "2026-10-18T11:01:00.000Z",
    }),
    JSON.stringify({
      ts: "2026-10-18T11:02:00.000Z",
      hook: "Stop",
      outcome: "veto",
      reason: "no_decision",
      score_before: 11.0,
      score_after: 11.4,
      session_id: "sess-1",
      prompt_id: "p-3",
      turn_ts: "2026-10-18T11:02:00.000Z",
    }),
  ].join("\n");
  const summaryLines = [
    "   ",
    "corrupt-summary-line",
    JSON.stringify({
      ts: "2026-10-18T11:00:00.000Z",
      session_id: "sess-1",
      prompt_id: "p-1",
      significant_choice: 0.1,
      visible_reflection: 0.8,
      context_sufficient: 0.9,
      decision_found: false,
      confidence: 0,
      unknown_legacy_field: "ignored",
    }),
    JSON.stringify({
      schema_version: 2,
      ts: "2026-10-18T11:01:00.000Z",
      session_id: "sess-1",
      prompt_id: "p-2",
      decision_weight: 0.2,
      assistant_choice: 0.1,
      reflex_approval: 0.1,
      developer_named_it: 0.8,
      decision_found: false,
      confidence: 0.1,
      extra_v2_field: 123,
    }),
    JSON.stringify({
      schema_version: 3,
      ts: "2026-10-18T11:02:00.000Z",
      session_id: "sess-1",
      prompt_id: "p-3",
      categories: {},
      formula_inputs: {
        decision_weight: 0.9,
        decision_ownership: 0.9,
        developer_reflection: 0.0,
        developer_intent: 0.0,
        effective_reflection: 0.0,
      },
      pause_probability: 0.81,
      preset_pause_threshold: 0.35,
      decision_found: true,
      confidence: 1.0,
      unknown_v3_field: true,
    }),
  ].join("\n");
  const labelsText = JSON.stringify({
    "p-1": false,
    "p-2": false,
    "p-3": true,
  });
  fs.writeFileSync(tracesPath, traceLines, "utf8");
  fs.writeFileSync(summariesPath, summaryLines, "utf8");
  fs.writeFileSync(labelsPath, labelsText, "utf8");
  return {
    tracesPath,
    summariesPath,
    labelsPath,
    traceLines,
    summaryLines,
    labelsText,
  };
}

test("real-data readers skip malformed trace and summary lines", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "stoic-eval-malformed-"),
  );
  try {
    const written = writeRealReplayFixture(tempDir);
    const report = await runEvaluation({
      fixturesDir: FIXTURES_DIR,
      tracesPath: written.tracesPath,
      summariesPath: written.summariesPath,
      labelsPath: written.labelsPath,
    });

    assert.equal(report.real_data.trace_replay.skipped_malformed_lines, 1);
    assert.equal(report.real_data.trace_replay.parsed_records_count, 3);
    assert.equal(
      report.real_data.summary_evaluation.skipped_malformed_lines,
      1,
    );
    assert.deepEqual(
      report.real_data.summary_evaluation.schema_version_counts,
      {
        v1: 1,
        v2: 1,
        v3: 1,
      },
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("real-data replay saves classifier calls against the e4b111e baseline", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stoic-eval-savings-"));
  try {
    const written = writeRealReplayFixture(tempDir);
    const report = await runEvaluation({
      fixturesDir: FIXTURES_DIR,
      tracesPath: written.tracesPath,
      summariesPath: written.summariesPath,
    });
    const balancedReplay = report.real_data.trace_replay.presets.balanced;

    assert.equal(balancedReplay.data_label, REAL_DATA_LABEL);
    assert.equal(balancedReplay.with_veto_cooldown.call_count, 1);
    assert.equal(
      balancedReplay.baseline_e4b111e_no_veto_cooldown.call_count,
      3,
    );
    assert.equal(balancedReplay.calls_saved, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("real-data summary accuracy is computed read-only against human labels", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "stoic-eval-accuracy-"),
  );
  try {
    const written = writeRealReplayFixture(tempDir);
    const report = await runEvaluation({
      fixturesDir: FIXTURES_DIR,
      tracesPath: written.tracesPath,
      summariesPath: written.summariesPath,
      labelsPath: written.labelsPath,
    });

    assert.equal(
      report.real_data.summary_evaluation.data_label,
      REAL_DATA_LABEL,
    );
    assert.equal(
      report.real_data.summary_evaluation.joined_with_trace_count,
      3,
    );
    assert.equal(
      report.real_data.summary_evaluation.accuracy_against_labels
        .logged_accuracy,
      1,
    );
    assert.equal(
      fs.readFileSync(written.tracesPath, "utf8"),
      written.traceLines,
    );
    assert.equal(
      fs.readFileSync(written.summariesPath, "utf8"),
      written.summaryLines,
    );
    assert.equal(
      fs.readFileSync(written.labelsPath, "utf8"),
      written.labelsText,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("numeric epoch-ms timestamps decay replayed scores the same way ISO timestamps do", async () => {
  const epochMs = Date.parse("2026-10-18T11:00:00.000Z");
  const laterMs = epochMs + 48 * 60 * 60 * 1000;
  const recordsFor = (firstTs, secondTs) => [
    {
      ts: firstTs,
      hook: "Stop",
      outcome: "veto",
      reason: "no_decision",
      score_before: 15,
      score_after: 8,
      trigger: "score",
      session_id: "sess-decay",
      prompt_id: "prompt-decay-1",
    },
    {
      ts: secondTs,
      hook: "Stop",
      outcome: "scored",
      score_before: 8,
      score_after: 8.4,
      trigger: "score",
      session_id: "sess-decay",
      prompt_id: "prompt-decay-2",
    },
  ];

  async function baselineCalls(firstTs, secondTs) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stoic-eval-ts-"));
    try {
      const tracesPath = path.join(tempDir, "local-trace.jsonl");
      fs.writeFileSync(
        tracesPath,
        `${recordsFor(firstTs, secondTs)
          .map((record) => JSON.stringify(record))
          .join("\n")}\n`,
        "utf8",
      );
      const report = await runEvaluation({
        fixturesDir: FIXTURES_DIR,
        tracesPath,
      });
      return report.real_data.trace_replay.presets.balanced
        .baseline_e4b111e_no_veto_cooldown.call_count;
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  const numericCalls = await baselineCalls(epochMs, laterMs);
  const numericStringCalls = await baselineCalls(
    String(epochMs),
    String(laterMs),
  );
  const isoCalls = await baselineCalls(
    new Date(epochMs).toISOString(),
    new Date(laterMs).toISOString(),
  );

  assert.equal(numericCalls, 1);
  assert.equal(numericStringCalls, numericCalls);
  assert.equal(isoCalls, numericCalls);
});

test("recomputed v3 formula accuracy is unavailable when every labeled line lacks an input", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stoic-eval-missing-"));
  try {
    const summariesPath = path.join(tempDir, "jev-experiment.jsonl");
    const labelsPath = path.join(tempDir, "labels.json");
    fs.writeFileSync(
      summariesPath,
      [
        JSON.stringify({
          ts: "2026-10-18T12:00:00.000Z",
          session_id: "sess-v1",
          prompt_id: "prompt-v1-missing",
          significant_choice: 0.9,
          visible_reflection: 0.1,
          decision_found: true,
          confidence: 1,
        }),
        JSON.stringify({
          schema_version: 2,
          ts: "2026-10-18T12:01:00.000Z",
          session_id: "sess-v2",
          prompt_id: "prompt-v2-missing",
          assistant_choice: 0.9,
          reflex_approval: 0.1,
          developer_named_it: 0.2,
          decision_found: true,
          confidence: 1,
        }),
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      labelsPath,
      JSON.stringify([
        {
          session_id: "sess-v1",
          ts: "2026-10-18T12:00:00.000Z",
          should_pause: true,
        },
        {
          session_id: "sess-v2",
          ts: "2026-10-18T12:01:00.000Z",
          should_pause: true,
        },
      ]),
      "utf8",
    );

    const report = await runEvaluation({
      fixturesDir: FIXTURES_DIR,
      summariesPath,
      labelsPath,
    });
    const accuracy =
      report.real_data.summary_evaluation.accuracy_against_labels;

    assert.equal(accuracy.recomputed_v3_formula_accuracy, null);
    assert.equal(accuracy.recomputed_v3_formula_reason, "missing_inputs");
    assert.equal(accuracy.recomputed_v3_formula_eligible_count, 0);
    assert.ok(accuracy.missing_input_counts.decision_ownership >= 1);
    assert.ok(accuracy.missing_input_counts.decision_weight >= 1);
    assert.ok(accuracy.missing_input_counts.developer_intent >= 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("recomputed v3 formula accuracy counts only labeled lines that carry every input", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stoic-eval-partial-"));
  try {
    const summariesPath = path.join(tempDir, "jev-experiment.jsonl");
    const labelsPath = path.join(tempDir, "labels.json");
    fs.writeFileSync(
      summariesPath,
      [
        JSON.stringify({
          ts: "2026-10-18T12:10:00.000Z",
          session_id: "sess-incomplete",
          prompt_id: "prompt-incomplete",
          significant_choice: 0.1,
          visible_reflection: 0.9,
          decision_found: false,
          confidence: 0,
        }),
        JSON.stringify({
          schema_version: 3,
          ts: "2026-10-18T12:11:00.000Z",
          session_id: "sess-complete",
          prompt_id: "prompt-complete",
          formula_inputs: {
            decision_weight: 0.9,
            decision_ownership: 0.9,
            developer_reflection: 0,
            developer_intent: 0,
          },
          preset_pause_threshold: 0.35,
          decision_found: true,
          confidence: 1,
        }),
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      labelsPath,
      JSON.stringify([
        {
          session_id: "sess-incomplete",
          ts: "2026-10-18T12:10:00.000Z",
          should_pause: true,
        },
        {
          session_id: "sess-complete",
          ts: "2026-10-18T12:11:00.000Z",
          should_pause: true,
        },
      ]),
      "utf8",
    );

    const report = await runEvaluation({
      fixturesDir: FIXTURES_DIR,
      summariesPath,
      labelsPath,
    });
    const accuracy =
      report.real_data.summary_evaluation.accuracy_against_labels;

    assert.equal(accuracy.recomputed_v3_formula_eligible_count, 1);
    assert.equal(accuracy.recomputed_v3_formula_missing_inputs_count, 1);
    assert.equal(accuracy.recomputed_v3_formula_accuracy, 1);
    assert.equal(accuracy.recomputed_v3_formula_reason, null);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a muted Stop is not counted as a classifier call", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stoic-eval-muted-"));
  try {
    const tracesPath = path.join(tempDir, "local-trace.jsonl");
    fs.writeFileSync(
      tracesPath,
      `${JSON.stringify({
        ts: "2026-10-18T13:00:00.000Z",
        hook: "Stop",
        outcome: "muted",
        trigger: "score",
        score_before: 30,
        score_after: 31,
        session_id: "sess-muted",
        prompt_id: "prompt-muted",
      })}\n`,
      "utf8",
    );
    const report = await runEvaluation({
      fixturesDir: FIXTURES_DIR,
      tracesPath,
    });
    const balancedReplay = report.real_data.trace_replay.presets.balanced;

    assert.equal(balancedReplay.logged_outcomes.muted, 1);
    assert.equal(balancedReplay.logged_outcomes.logged_classifier_calls, 0);
    assert.equal(balancedReplay.with_veto_cooldown.call_count, 0);
    assert.equal(
      balancedReplay.baseline_e4b111e_no_veto_cooldown.call_count,
      0,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a scored Stop is below the gates and is not cooled as a veto", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stoic-eval-scored-"));
  try {
    const tracesPath = path.join(tempDir, "local-trace.jsonl");
    fs.writeFileSync(
      tracesPath,
      `${JSON.stringify({
        ts: "2026-10-18T13:10:00.000Z",
        hook: "Stop",
        outcome: "scored",
        trigger: "score",
        score_before: 20,
        score_after: 21,
        session_id: "sess-scored",
        prompt_id: "prompt-scored",
      })}\n`,
      "utf8",
    );
    const report = await runEvaluation({
      fixturesDir: FIXTURES_DIR,
      tracesPath,
    });
    const balancedReplay = report.real_data.trace_replay.presets.balanced;
    const turn = balancedReplay.score_trajectory[0];

    assert.equal(turn.classified_outcome, "below_gates");
    assert.equal(balancedReplay.logged_outcomes.below_gates, 1);
    assert.equal(balancedReplay.logged_outcomes.vetoed.total, 0);
    assert.equal(balancedReplay.logged_outcomes.logged_classifier_calls, 0);
    assert.ok(turn.replay_only_calls_not_cooled.score_after > 10);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("an unrecognized Stop outcome is counted in the unknown bucket and is not a classifier call", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stoic-eval-unknown-"));
  try {
    const tracesPath = path.join(tempDir, "local-trace.jsonl");
    fs.writeFileSync(
      tracesPath,
      `${JSON.stringify({
        ts: "2026-10-18T13:20:00.000Z",
        hook: "Stop",
        outcome: "mystery_outcome",
        score_before: 20,
        score_after: 21,
        session_id: "sess-unknown",
        prompt_id: "prompt-unknown",
      })}\n`,
      "utf8",
    );
    const report = await runEvaluation({
      fixturesDir: FIXTURES_DIR,
      tracesPath,
    });
    const balancedReplay = report.real_data.trace_replay.presets.balanced;

    assert.equal(balancedReplay.logged_outcomes.unknown, 1);
    assert.equal(balancedReplay.logged_outcomes.vetoed.total, 0);
    assert.equal(balancedReplay.logged_outcomes.logged_classifier_calls, 0);
    assert.equal(balancedReplay.total_stop_turns, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("multiple trace files are merged, identical lines are deduped, and projects do not share score", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "stoic-eval-projects-"),
  );
  try {
    const alphaDir = path.join(tempDir, "project-alpha");
    const betaDir = path.join(tempDir, "project-beta");
    fs.mkdirSync(alphaDir, { recursive: true });
    fs.mkdirSync(betaDir, { recursive: true });
    const sharedLine = JSON.stringify({
      ts: "2026-10-18T14:00:00.000Z",
      hook: "Stop",
      outcome: "veto",
      reason: "no_decision",
      trigger: "score",
      score_before: 15,
      score_after: 16,
      session_id: "sess-alpha",
      prompt_id: "prompt-alpha",
    });
    const betaLine = JSON.stringify({
      ts: "2026-10-18T14:01:00.000Z",
      hook: "Stop",
      outcome: "veto",
      reason: "no_decision",
      trigger: "score",
      score_before: 15,
      score_after: 16,
      session_id: "sess-beta",
      prompt_id: "prompt-beta",
    });
    fs.writeFileSync(
      path.join(alphaDir, "local-trace.jsonl.1"),
      `${sharedLine}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(alphaDir, "local-trace.jsonl"),
      `${sharedLine}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(betaDir, "local-trace.jsonl"),
      `${betaLine}\n`,
      "utf8",
    );

    const report = await runEvaluation({
      fixturesDir: FIXTURES_DIR,
      tracesPath: tempDir,
    });
    const replay = report.real_data.trace_replay;
    const balanced = replay.presets.balanced;

    assert.equal(replay.duplicate_lines_skipped, 1);
    assert.equal(replay.parsed_records_count, 2);
    assert.equal(replay.project_count, 2);
    assert.equal(
      balanced.per_project["project-alpha"].with_veto_cooldown.call_count,
      1,
    );
    assert.equal(
      balanced.per_project["project-beta"].with_veto_cooldown.call_count,
      1,
    );
    assert.equal(balanced.with_veto_cooldown.call_count, 2);
    assert.equal(
      replay.projects["project-alpha"].presets.balanced.total_stop_turns,
      1,
    );
    assert.equal(
      replay.totals.presets.balanced.with_veto_cooldown.call_count,
      2,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a personal-state directory contributes only local-trace.jsonl and its rotated copy", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "stoic-eval-trace-dir-"),
  );
  try {
    const projectDir = path.join(tempDir, "project-slug");
    const nestedDir = path.join(projectDir, "nested-project");
    const sessionsDir = path.join(projectDir, "sessions");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });

    function stopLine(promptId, scoreBefore) {
      return JSON.stringify({
        ts: `2026-10-18T14:${String(scoreBefore).padStart(2, "0")}:00.000Z`,
        hook: "Stop",
        outcome: "scored",
        score_before: scoreBefore,
        score_after: scoreBefore + 0.2,
        session_id: "sess-dir",
        prompt_id: promptId,
      });
    }

    fs.writeFileSync(
      path.join(projectDir, "local-trace.jsonl.1"),
      `${stopLine("rotated", 1)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectDir, "local-trace.jsonl"),
      `${stopLine("live", 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(nestedDir, "local-trace.jsonl"),
      `${stopLine("nested", 3)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectDir, "local-trace.jsonl.2"),
      `${stopLine("second-rotation", 4)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectDir, "jev-experiment.jsonl"),
      `${stopLine("summary-file", 5)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(projectDir, "notes.jsonl"),
      `${stopLine("notes", 6)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(sessionsDir, "session-1.jsonl"),
      `${stopLine("session-log", 7)}\n`,
      "utf8",
    );

    const report = await runEvaluation({
      fixturesDir: FIXTURES_DIR,
      tracesPath: projectDir,
    });
    const replay = report.real_data.trace_replay;
    const readNames = replay.files_read.map((filePath) =>
      path.basename(filePath),
    );

    assert.deepEqual(readNames.sort(), [
      "local-trace.jsonl",
      "local-trace.jsonl",
      "local-trace.jsonl.1",
    ]);
    assert.equal(replay.parsed_records_count, 3);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("summary snapshots from a directory and a glob merge without counting one turn twice", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "stoic-eval-summaries-"),
  );
  try {
    const snapshotRoot = path.join(tempDir, "snapshots");
    const firstCopy = path.join(snapshotRoot, "copy-a");
    const secondCopy = path.join(snapshotRoot, "copy-b");
    const extraDir = path.join(tempDir, "extra");
    fs.mkdirSync(path.join(firstCopy, "sessions"), { recursive: true });
    fs.mkdirSync(secondCopy, { recursive: true });
    fs.mkdirSync(extraDir, { recursive: true });

    function summaryLine(minute, promptId, confidence) {
      return JSON.stringify({
        ts: `2026-10-18T15:${minute}:00.000Z`,
        session_id: "sess-snapshots",
        prompt_id: promptId,
        decision_found: false,
        confidence,
        significant_choice: 0.1,
        visible_reflection: 0.2,
      });
    }

    fs.writeFileSync(
      path.join(firstCopy, "jev-experiment.jsonl"),
      `${summaryLine("00", "prompt-one", 0)}\n${summaryLine("01", "prompt-two", 0)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(firstCopy, "sessions", "session-1.jsonl"),
      `${summaryLine("09", "prompt-session", 0)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(firstCopy, "local-trace.jsonl"),
      `${summaryLine("08", "prompt-trace", 0)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(secondCopy, "jev-experiment.jsonl"),
      `${summaryLine("01", "prompt-two", 0.4)}\n${summaryLine("02", "prompt-three", 0)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(extraDir, "late-snapshot.jsonl"),
      `${summaryLine("03", "prompt-four", 0)}\n`,
      "utf8",
    );

    const parsed = parseCliArgs([
      "--summaries",
      snapshotRoot,
      "--summaries",
      path.join(extraDir, "*.jsonl"),
    ]);
    const report = await runEvaluation({
      fixturesDir: FIXTURES_DIR,
      summariesPaths: parsed.summariesPaths,
    });
    const summaryEvaluation = report.real_data.summary_evaluation;

    assert.deepEqual(parsed.summariesPaths, [
      snapshotRoot,
      path.join(extraDir, "*.jsonl"),
    ]);
    assert.equal(summaryEvaluation.parsed_summaries_count, 4);
    assert.equal(summaryEvaluation.duplicate_summaries_skipped, 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("a replay-only classifier call on a below-gates Stop cools like a veto and the uncooled score is reported beside it", async () => {
  const tempDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "stoic-eval-replay-only-"),
  );
  try {
    const tracesPath = path.join(tempDir, "local-trace.jsonl");
    const lines = [
      {
        ts: "2026-10-18T16:00:00.000Z",
        hook: "Stop",
        outcome: "scored",
        trigger: "score",
        score_before: 12,
        score_after: 13,
        session_id: "sess-replay-only",
        prompt_id: "prompt-replay-only-1",
      },
      {
        ts: "2026-10-18T16:01:00.000Z",
        hook: "Stop",
        outcome: "scored",
        trigger: "score",
        score_before: 13,
        score_after: 13.4,
        session_id: "sess-replay-only",
        prompt_id: "prompt-replay-only-2",
      },
    ];
    fs.writeFileSync(
      tracesPath,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );

    const report = await runEvaluation({
      fixturesDir: FIXTURES_DIR,
      tracesPath,
    });
    const balancedReplay = report.real_data.trace_replay.presets.balanced;
    const firstTurn = balancedReplay.score_trajectory[0];
    const secondTurn = balancedReplay.score_trajectory[1];
    const vetoCap = PRESETS.balanced.threshold * VETO_COOLDOWN_RATIO;

    assert.equal(firstTurn.classified_outcome, "below_gates");
    assert.equal(firstTurn.with_veto_cooldown.replay_only_call, true);
    assert.ok(firstTurn.with_veto_cooldown.score_after <= vetoCap);
    assert.ok(
      firstTurn.replay_only_calls_not_cooled.score_after >
        PRESETS.balanced.threshold,
    );
    assert.equal(secondTurn.with_veto_cooldown.classifier_called, false);
    assert.equal(
      secondTurn.replay_only_calls_not_cooled.classifier_called,
      true,
    );
    assert.equal(balancedReplay.with_veto_cooldown.call_count, 1);
    assert.equal(balancedReplay.replay_only_calls_not_cooled.call_count, 2);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("parseCliArgs keeps every repeated --traces value", () => {
  const parsed = parseCliArgs([
    "--traces",
    "traces/local-trace.jsonl.1",
    "--traces",
    "traces/local-trace.jsonl",
    "--out",
    "/tmp/jev-eval-report.json",
  ]);

  assert.deepEqual(parsed.tracesPaths, [
    "traces/local-trace.jsonl.1",
    "traces/local-trace.jsonl",
  ]);
});

test("labels join on session_id plus turn ts and report labels that match nothing", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stoic-eval-labels-"));
  try {
    const summariesPath = path.join(tempDir, "jev-experiment.jsonl");
    const labelsPath = path.join(tempDir, "labels.json");
    const repeatedPromptId = "prompt-repeated";
    fs.writeFileSync(
      summariesPath,
      [
        JSON.stringify({
          schema_version: 3,
          ts: "2026-10-18T15:00:00.000Z",
          session_id: "sess-labels",
          prompt_id: repeatedPromptId,
          formula_inputs: {
            decision_weight: 0.1,
            decision_ownership: 0.1,
            developer_reflection: 0.9,
            developer_intent: 0.9,
          },
          decision_found: false,
          confidence: 0,
        }),
        JSON.stringify({
          schema_version: 3,
          ts: "2026-10-18T15:05:00.000Z",
          session_id: "sess-labels",
          prompt_id: repeatedPromptId,
          formula_inputs: {
            decision_weight: 0.9,
            decision_ownership: 0.9,
            developer_reflection: 0,
            developer_intent: 0,
          },
          preset_pause_threshold: 0.35,
          decision_found: true,
          confidence: 1,
        }),
      ].join("\n"),
      "utf8",
    );
    fs.writeFileSync(
      labelsPath,
      JSON.stringify([
        {
          session_id: "sess-labels",
          ts: "2026-10-18T15:00:00.000Z",
          prompt_id: repeatedPromptId,
          should_pause: false,
        },
        {
          session_id: "sess-labels",
          ts: Date.parse("2026-10-18T15:05:00.000Z"),
          prompt_id: repeatedPromptId,
          should_pause: true,
        },
        {
          session_id: "sess-nobody",
          ts: "2026-10-18T16:00:00.000Z",
          should_pause: true,
        },
      ]),
      "utf8",
    );

    const report = await runEvaluation({
      fixturesDir: FIXTURES_DIR,
      summariesPath,
      labelsPath,
    });
    const accuracy =
      report.real_data.summary_evaluation.accuracy_against_labels;

    assert.equal(accuracy.logged_accuracy, 1);
    assert.equal(accuracy.total_labeled, 2);
    assert.equal(accuracy.unjoined_labels_count, 1);
    assert.equal(
      report.real_data.summary_evaluation.unjoined_counts
        .labels_without_summary,
      1,
    );
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test("calm, balanced, and vigilant differ on classifier calls and pauses", async () => {
  const report = await runEvaluation({ fixturesDir: FIXTURES_DIR });
  const calm = report.presets.calm;
  const balanced = report.presets.balanced;
  const vigilant = report.presets.vigilant;

  assert.equal(calm.data_label, SIMULATED_DATA_LABEL);
  assert.ok(calm.pause_count < balanced.pause_count);
  assert.ok(balanced.pause_count < vigilant.pause_count);
  assert.ok(
    calm.classifier_call_comparison.with_veto_cooldown.call_count <
      balanced.classifier_call_comparison.with_veto_cooldown.call_count,
  );
  assert.ok(
    balanced.classifier_call_comparison.with_veto_cooldown.call_count <
      vigilant.classifier_call_comparison.with_veto_cooldown.call_count,
  );
  assert.ok(
    calm.classifier_call_comparison.baseline_e4b111e_no_veto_cooldown
      .call_count <
      balanced.classifier_call_comparison.baseline_e4b111e_no_veto_cooldown
        .call_count,
  );
  assert.ok(
    balanced.classifier_call_comparison.baseline_e4b111e_no_veto_cooldown
      .call_count <
      vigilant.classifier_call_comparison.baseline_e4b111e_no_veto_cooldown
        .call_count,
  );
});

test("reported ratios keep four decimals and reported durations are whole milliseconds", async () => {
  const report = await runEvaluation({ fixturesDir: FIXTURES_DIR });
  const balanced = report.presets.balanced;

  const callFrequency =
    balanced.classifier_call_comparison.with_veto_cooldown.call_frequency;
  const rawCallFrequency =
    balanced.classifier_call_comparison.with_veto_cooldown.call_count /
    balanced.total_turns;
  assert.ok(
    Math.abs(callFrequency * 10000 - Math.round(callFrequency * 10000)) < 1e-8,
  );
  if (
    Math.abs(rawCallFrequency * 10000 - Math.round(rawCallFrequency * 10000)) >=
    1e-8
  ) {
    assert.notEqual(callFrequency, rawCallFrequency);
  }
  for (const turn of balanced.latency_budget.per_turn) {
    assert.equal(Number.isInteger(turn.end_to_end_ms), true);
    assert.equal(Number.isInteger(turn.runner_total_ms), true);
  }
  assert.equal(
    Number.isInteger(balanced.latency_budget.max_end_to_end_ms),
    true,
  );
  assert.equal(
    Number.isInteger(balanced.latency_budget.max_runner_total_ms),
    true,
  );
  assert.equal(
    Number.isInteger(balanced.latency_budget.mean_classified_end_to_end_ms),
    true,
  );
  assert.equal(
    Number.isInteger(balanced.latency_budget.mean_classified_runner_total_ms),
    true,
  );
});

test("veto confidence is a number when the classifier produced one and null when it did not", async () => {
  const report = await runEvaluation({ fixturesDir: FIXTURES_DIR });
  const balanced = report.presets.balanced;
  const lowConfidenceTurn =
    balanced.cases.developer_refined_proposal.turns[0].with_veto_cooldown;
  const genuineNoDecisionTurn =
    balanced.cases.trivial_css_change.turns[0].with_veto_cooldown;
  const categoryFailedTurn =
    balanced.cases.one_category_failing.turns[0].with_veto_cooldown;
  const belowGatesTurn =
    balanced.cases.developer_refined_proposal.turns[1].with_veto_cooldown;

  assert.equal(lowConfidenceTurn.outcome, "veto");
  assert.equal(lowConfidenceTurn.veto_reason, "low_confidence");
  assert.equal(typeof lowConfidenceTurn.confidence, "number");
  assert.equal(genuineNoDecisionTurn.veto_reason, "no_decision");
  assert.equal(genuineNoDecisionTurn.confidence, 0);
  assert.equal(categoryFailedTurn.confidence, null);
  assert.equal(belowGatesTurn.outcome, "below_gates");
  assert.equal(belowGatesTurn.confidence, null);
});

test("the e4b111e baseline classifies from its own score after a veto has cooled only the cooldown trajectory", async () => {
  const report = await runEvaluation({ fixturesDir: FIXTURES_DIR });
  const secondTurn =
    report.presets.balanced.cases.baseline_own_classification.turns[1];
  const cooldown = secondTurn.with_veto_cooldown;
  const baseline = secondTurn.baseline_e4b111e_no_veto_cooldown;

  assert.equal(cooldown.classifier_called, true);
  assert.equal(baseline.classifier_called, true);
  assert.notEqual(cooldown.score_before, baseline.score_before);
  assert.equal(cooldown.classified_score_before, cooldown.score_before);
  assert.equal(baseline.classified_score_before, baseline.score_before);
});

test("a partial category failure keeps veto reason no_decision and is counted as category_failed", async () => {
  const report = await runEvaluation({ fixturesDir: FIXTURES_DIR });
  const balanced = report.presets.balanced;
  const failedTurn =
    balanced.cases.one_category_failing.turns[0].with_veto_cooldown;

  assert.equal(failedTurn.outcome, "veto");
  assert.equal(failedTurn.veto_reason, "no_decision");
  assert.equal(failedTurn.veto_bucket, "category_failed");
  assert.equal(failedTurn.category_failed, true);
  assert.equal(balanced.veto_reason_counts.category_failed, 1);
  assert.equal(balanced.veto_reason_counts.no_decision, 1);
});
