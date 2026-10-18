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

`<project-slug>` is the directory under `~/.claude/stoic-stack/` for that project. Passing that directory reads `local-trace.jsonl` and the one rotated copy the plugin writes, `local-trace.jsonl.1`, including copies in nested project folders. `sessions/`, `jev-experiment.jsonl`, and every other `*.jsonl` are left unread. Repeat `--traces` for more files, or pass a basename glob such as `"$HOME/.claude/stoic-stack/<project-slug>/local-trace.jsonl*"`.

`--summaries` is repeatable and also accepts a directory or a basename glob. A directory contributes each nested `jev-experiment.jsonl`. Overlapping snapshots collapse to one line per `session_id` + `ts`. Numeric epoch-millisecond `ts` values and ISO strings are both accepted. `turn-labels.json` may be a `{ "<prompt_id>": true }` map or an array of `{ "session_id", "ts", "should_pause" }`. All input files are opened read-only; blank or malformed JSONL lines are skipped without throwing. Real-log sections carry `"data_label": "REAL-DATA"`.

A Stop the log recorded as below the gates, which the replay nevertheless scores as a classifier call, is cooled as a veto (`<= 0.8 * threshold`) on the default trajectory. `replay_only_calls_not_cooled` reports the same replay with that call left uncooled.

Two limits of the replay stay as they are:

- Calm and vigilant reuse the turn delta already stored in the trace. That delta was produced with the weights of the preset that wrote the log (balanced, for this experiment's field data). The replay does not rebuild it with calm or vigilant `weight_edits` / `weight_diff`.
- A pause the log recorded is relieved to `0.5 * threshold` only when the replay also calls the classifier on that turn. A logged pause the replay does not reach gets no `0.5x` relief.
