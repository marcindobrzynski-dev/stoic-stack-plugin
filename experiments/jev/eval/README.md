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

To replay score dynamics and classifier call frequency (veto cooldown `0.8` vs `e4b111e` baseline) over raw plugin traces and evaluate logged `jev-experiment.jsonl` lines (v1, v2, and v3) against optional human labels:

```bash
node experiments/jev/eval/run-eval.js \
  --fixtures experiments/jev/eval/fixtures \
  --traces "$HOME/.claude/stoic-stack/<project-slug>" \
  --summaries "$HOME/.claude/stoic-stack/<project-slug>/jev-experiment.jsonl" \
  --labels ./turn-labels.json \
  --out /tmp/jev-eval-report.json
```

`<project-slug>` is the directory under `~/.claude/stoic-stack/` for that project. Passing the directory reads `local-trace.jsonl` and rotated `local-trace.jsonl.1` together. Repeat `--traces` for more files, or pass a basename glob such as `"$HOME/.claude/stoic-stack/<project-slug>/local-trace.jsonl*"`. Numeric epoch-millisecond `ts` values and ISO strings are both accepted. `turn-labels.json` may be a `{ "<prompt_id>": true }` map or an array of `{ "session_id", "ts", "should_pause" }`. All input files are opened read-only; blank or malformed JSONL lines are skipped without throwing. Real-log sections carry `"data_label": "REAL-DATA"`.
