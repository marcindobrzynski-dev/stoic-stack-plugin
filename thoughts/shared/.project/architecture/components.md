---
version: 0.1.0
last_update: 2026-09-29
created_at: 2026-09-29
---

# Components

> Companion to [../architecture.md](../architecture.md). Every module under
> `src/` with its layer and responsibility, and the content layer under
> `skills/` that talks to those modules. The layer rules the table obeys are in
> the hub; the flow the modules implement is in [data-flow.md](data-flow.md).

## Module map

| Module                                            | Layer                       | Responsibility                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/hooks/hook-runtime.js`                       | Entrypoints (shared leaf)   | Shared leaf for `capture.js` and `stop.js` (which never import each other): read and validate the stdin payload, one-line a thrown value.                                                                                                                                                             |
| `src/hooks/capture.js`                            | Entrypoints (shared)        | The frame every capture hook runs inside: `STOIC_INTERNAL` guard, stdin parse, enabled check, append, one trace line, swallow everything.                                                                                                                                                             |
| `src/hooks/user-prompt-submit.js`                 | Entrypoints                 | Append `prompt` event (truncated text + effort computed at write time); skip own prompts; log harness-injected notifications as `neutralized`.                                                                                                                                                        |
| `src/hooks/post-tool-use.js`                      | Entrypoints                 | Append `edit` event with diff stats and delegation attribution.                                                                                                                                                                                                                                       |
| `src/hooks/subagent-start.js`, `subagent-stop.js` | Entrypoints                 | Append sub-agent lifecycle events.                                                                                                                                                                                                                                                                    |
| `src/hooks/stop.js`                               | Entrypoints + Orchestration | The turn boundary: consume the log, score, save, then orchestrate the fire path — I/O only, the decision is delegated. A cooled classifier veto also saves the capped score.                                                                                                                          |
| `src/hooks/stop-decision.js`                      | Orchestration (pure)        | The fire path's decision: hard gate, soft gate, classifier veto, mute check, cooldown cap. No I/O, no clock, never throws; every degradation errs toward silence.                                                                                                                                     |
| `src/cli/record.js`                               | Entrypoints + Orchestration | Single writer for pause outcomes (keep / correct / skip / defer), for both documents. Also the second of the score's two writers: applies `rewardedScore` when a `manual` pause is kept or corrected, and touches the score under no other condition.                                                 |
| `src/cli/reflect.js`                              | Entrypoints + Orchestration | Single writer for the manual pause document (`stoic-manual-pause.json`): measures `git diff HEAD` into the turn-group fields and writes nothing else — no score, no mutes, no bank entry, no engine state.                                                                                            |
| `src/cli/setup.js`                                | Entrypoints + Orchestration | Single writer for guided setup: inspect current choices (`--current`), or validate and apply a complete set (`--apply`).                                                                                                                                                                              |
| `src/core/scoring.js`                             | Domain                      | Score decay, turn delta (incl. the delegated-edit discount), and the arithmetic of relief both score writers share: `relievedScore` (the fire-time cap, also used when a classifier veto cools the score by `VETO_COOLDOWN_RATIO`) and `rewardedScore` (that cap, then the manual-reflection reward). |
| `src/core/prompts.js`                             | Domain                      | Prompt-effort heuristic, harness-injection (task-notification) detection.                                                                                                                                                                                                                             |
| `src/core/group.js`                               | Domain                      | Turn-group builder: session events → turn summary (the `group` in `stoic-pending-pause.json`).                                                                                                                                                                                                        |
| `src/core/gates.js`                               | Domain                      | Critical-path matching, mute evaluation and pruning.                                                                                                                                                                                                                                                  |
| `src/core/diffstats.js`                           | Domain                      | Edit-size extraction from tool payloads.                                                                                                                                                                                                                                                              |
| `src/core/predicates.js`                          | Domain (leaf)               | Shared pure validation predicates and value coercions, importable from every layer.                                                                                                                                                                                                                   |
| `src/io/project-root.js`                          | Infrastructure              | Resolves the Project Root through five gates in order (git working-tree root, nearest `.stoic/config.json` above, `CLAUDE_PROJECT_DIR`, payload `cwd`, `process.cwd()`); returns `null` when every gate is exhausted, never throws, never prints. Called by every entrypoint but `record.js`.         |
| `src/io/paths.js`                                 | Infrastructure              | All path resolution — pure; directories come into existence only through writers.                                                                                                                                                                                                                     |
| `src/io/trace.js`                                 | Infrastructure              | Fail-silent bounded trace sinks, local per project and shared: one outcome line per hook invocation, each size-capped with a single rotation.                                                                                                                                                         |
| `src/io/json-file.js`                             | Infrastructure              | Fail-safe JSON document helpers: status-reporting reads, atomic tmp+rename writes (used by config and state).                                                                                                                                                                                         |
| `src/io/state.js`                                 | Infrastructure              | Atomic load/save of `state.json`.                                                                                                                                                                                                                                                                     |
| `src/io/config/config.js`                         | Infrastructure              | Config defaults, presets, category taxonomy, knob resolution, the guided-choice model, atomic save.                                                                                                                                                                                                   |
| `src/io/config/manual-reflection.js`              | Infrastructure              | The small config subset the manual-reflection path needs (`pause_mode`, `max_questions`, `followup_draft`, `threshold`, `cooldown_ratio`, `manual_relief_factor`), plus `MANUAL_RELIEF_FACTOR` — a mechanism constant, deliberately not a knob. Imports one-way from `./config.js`.                   |
| `src/io/git-diff.js`                              | Infrastructure              | Working-tree reader: `git diff HEAD --numstat` (staged and unstaged, committed work excluded) into diff-stat fields, through an injectable spawn. Every failure degrades to a clean tree; never throws.                                                                                               |
| `src/io/session-log.js`                           | Infrastructure              | Append/read/truncate the per-session event log.                                                                                                                                                                                                                                                       |
| `src/io/headless.js`                              | Infrastructure              | Cross-platform `claude -p` runner; returns a clean "unavailable" result on any failure, never throwing.                                                                                                                                                                                               |
| `src/io/classifier.js`                            | Infrastructure              | LLM #1 prompt build, verdict validation, category resolution, and the fail-safe `classify` seam evaluating the veto reasons in contract order.                                                                                                                                                        |
| `src/io/bank.js`                                  | Infrastructure              | Decision-bank markdown writer (enforces `.gitignore`) and aggregate reader.                                                                                                                                                                                                                           |

## Content layer

All LLM-facing content is markdown under `skills/` — no `commands/` directory
(Claude Code merged commands into skills; skills are the recommended layout
for new plugins). Content is prompts, not code; it talks to code only through
two seams: reading a pause document (`stoic-pending-pause.json` or
`stoic-manual-pause.json`) and shelling to `src/cli/*.js`.

| Skill                   | Invocation                                   | Purpose                                                                                                                        |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `skills/stoic-setup/`   | user only (`disable-model-invocation: true`) | ≤4 plain-language questions → shells to `setup.js`; never constructs config itself.                                            |
| `skills/stoic-reflect/` | user only (`disable-model-invocation: true`) | A manual reflection: shells to `reflect.js` for the material, asks in the in-progress tense, resolves to Keep or Correct only. |
| `skills/stoic-pause/`   | model and user (no invocation key)           | The pause cascade: gate question → read touched files → 1–3 Socratic questions → record outcome.                               |

Keep `SKILL.md` bodies lean; only descriptions are always in context, bodies
load on invocation.

`stoic-pause` is the one skill both the model and the user can invoke. The
model path is the Stop-block instruction and is what the pause is for; the user
path costs nothing extra — a description that lets the hook fire the skill
already lets the developer type it — and it is the only way to finish a pause
that was interrupted, since the pending document outlives the turn and nothing
else consumes it. Typing the skill never creates a pause: with no pending
document it says one line and ends the turn.

`stoic-reflect` is the one skill the model may _not_ invoke: the premise of its
score reward is that the developer chose to reflect, so a model-triggered
invocation would counterfeit exactly that. It has its own writer,
`src/cli/reflect.js`, and its own document, `stoic-manual-pause.json` (see
[data-flow.md §Pause delivery](data-flow.md)).

Two prose/code pairings are held by hand, not by any test:
`skills/stoic-pause/SKILL.md` against `blockReason()` in `src/hooks/stop.js`,
and `skills/stoic-reflect/SKILL.md` against the `reflect.js` result contract
plus the `record.js` flags both skills invoke. Changing either CLI means
re-reading the skill that calls it.
