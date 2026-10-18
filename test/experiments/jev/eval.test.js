import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  FALLBACK_TIMEOUT_MS,
  STATE_TIMEOUT_MS,
} from "../../../experiments/jev/constants.js";
import {
  REAL_DATA_LABEL,
  SIMULATED_DATA_LABEL,
  STOP_HOOK_TIMEOUT_MS,
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

test("latency_budget reports explicit end_to_end_ms alongside runner_total_ms and the real timeout constants", async () => {
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
  assert.equal(
    fallbackTurnLatency.end_to_end_ms,
    fallbackTurnLatency.sonnet_ms +
      fallbackTurnLatency.jev_ms +
      fallbackTurnLatency.fallback_ms,
  );
  assert.equal(
    fallbackTurnLatency.runner_total_ms,
    fallbackTurnLatency.end_to_end_ms,
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

test("real-data trace and summary readers skip malformed lines, replay veto cooldown savings, and compute accuracy read-only", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stoic-eval-real-"));

  try {
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

    const report = await runEvaluation({
      fixturesDir: FIXTURES_DIR,
      tracesPath,
      summariesPath,
      labelsPath,
    });

    assert.equal(report.real_data.data_label, REAL_DATA_LABEL);
    assert.equal(report.real_data.trace_replay.data_label, REAL_DATA_LABEL);
    assert.equal(
      report.real_data.summary_evaluation.data_label,
      REAL_DATA_LABEL,
    );

    assert.equal(report.real_data.trace_replay.skipped_malformed_lines, 1);
    assert.equal(report.real_data.trace_replay.parsed_records_count, 3);
    assert.equal(
      report.real_data.trace_replay.presets.balanced.with_veto_cooldown
        .call_count,
      1,
    );
    assert.equal(
      report.real_data.trace_replay.presets.balanced
        .baseline_e4b111e_no_veto_cooldown.call_count,
      3,
    );

    assert.equal(
      report.real_data.summary_evaluation.skipped_malformed_lines,
      1,
    );
    assert.deepEqual(
      report.real_data.summary_evaluation.schema_version_counts,
      { v1: 1, v2: 1, v3: 1 },
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

    // Input files remain completely unmodified (read-only).
    assert.equal(fs.readFileSync(tracesPath, "utf8"), traceLines);
    assert.equal(fs.readFileSync(summariesPath, "utf8"), summaryLines);
    assert.equal(fs.readFileSync(labelsPath, "utf8"), labelsText);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
