# Jev Structured-State Offline Evaluation Harness

Offline evaluation harness for the structured-state Jev classifier pipeline (`experiments/jev/eval/run-eval.js`). Uses Node.js built-ins only and never makes live Claude, Sonnet, Jev, or TypeSafe network calls.

## 1. Run on Synthetic Fixtures (`SIMULATED`)

```bash
node experiments/jev/eval/run-eval.js \
  --fixtures experiments/jev/eval/fixtures \
  --out /tmp/jev-eval-simulated.json
```

All objects in the output carry `"data_label": "SIMULATED"`.

## 2. Rerun on Real Turn Logs (`REAL-DATA`)

To replay score dynamics and classifier call frequency (veto cooldown `0.8` vs `e4b111e` baseline) over real `local-trace.jsonl` records and evaluate logged `jev-experiment.jsonl` lines (v1, v2, and v3) against optional human labels:

```bash
node experiments/jev/eval/run-eval.js \
  --fixtures experiments/jev/eval/fixtures \
  --traces "<personalStateDir>/local-trace.jsonl" \
  --summaries "<personalStateDir>/jev-experiment.jsonl" \
  --labels "<path/to/turn-labels.json>" \
  --out /tmp/jev-eval-report.json
```

Where `<personalStateDir>` is `~/.claude/stoic-stack/<project-slug>`. All input files are opened read-only; blank or malformed JSONL lines are skipped without throwing. Real-log sections carry `"data_label": "REAL-DATA"`.
