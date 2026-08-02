---
status: approved
version: 0.1.6
last_update: 2026-08-02
created_at: 2026-07-11
---

# Architecture for Stoic Stack Plugin PoC

> Site structure, layers, data flow, and component map — the how the code is organized. The what/why lives in project-idea.md and the tooling in tech-stack.md. Engineering rules in .agents/rules/ apply on top of this document.

All code, identifiers, file names, and documentation are English.

**This document is a binding contract.** The implementation must match it; an
architectural change lands in this document first, then in code. Detailed
references live next to it in `architecture/`:

- [architecture/2026-07-11_CONTEXT.md](architecture/2026-07-11_CONTEXT.md) — the ubiquitous language: canonical domain terms and their meanings.
- [architecture/configuration.md](architecture/configuration.md) — config concepts, presets, full knob list.
- [architecture/payloads.md](architecture/payloads.md) — hook payloads, event log shapes, state file schemas.
- [architecture/trade-offs.md](architecture/trade-offs.md) — known limitations and deliberate design trade-offs.

## Overview

Stoic Stack is a Claude Code plugin: hooks plus skills, no server, no build
step. Five Claude Code hooks observe the session; a score engine decides when
the developer is drifting into autopilot; a "stoic pause" is then surfaced in
the main conversation as a short reflection moment (Reflect / Skip / Defer).
Answered reflections are persisted as decisions.

Two LLM roles keep the cost split deliberate:

- **LLM #1 — classifier (veto gate).** A cheap headless `claude -p` call made
  from the Stop hook only when a pause is about to fire. It labels the turn
  with a decision category and can veto low-confidence or out-of-scope pauses.
- **LLM #2 — the main conversation.** Runs the `stoic-pause` skill: reads the
  pause context, asks the user, generates 1–3 Socratic questions, and records
  the outcome.

Design principles (binding):

1. **Zero runtime dependencies.** Plugin code uses Node.js built-ins only
   (`fs`, `path`, `os`, `child_process`). `package.json` holds
   devDependencies exclusively (lint, format, test tooling).
2. **ESM everywhere.** `"type": "module"`, `import`/`export`, no build step —
   hooks run directly via `node`.
3. **Fail silent.** A hook must never break the user's session: any internal
   error is swallowed into a debug sink and the hook exits successfully.
4. **State is written once per turn, at Stop.** Collection hooks only append
   events to a per-session log; the Stop hook is the single writer of scores
   and decisions to fire.
5. **Everything is local.** No telemetry, no network calls other than the
   headless `claude -p` classifier.

## Layered structure

Four layers with a strict downward dependency rule — a layer may only import
from layers below it:

```mermaid
graph TD
    E["Entrypoints — src/hooks/*, src/cli/*<br/>parse stdin/argv, delegate, print"] --> O
    O["Orchestration — turn evaluation<br/>build turn group, score, gate, veto, fire"] --> D
    O --> I
    D["Domain (pure) — src/core/*<br/>scoring, gates, diff stats, prompt signals — no I/O"]
    I["Infrastructure — src/io/*<br/>paths, state, config, session log, headless LLM, decision bank"]
    I -. "pure predicates only" .-> D
```

Directory layout:

```
stoic-stack-plugin/
├─ .claude-plugin/plugin.json    # plugin manifest
├─ hooks/hooks.json              # hook registration -> node src/hooks/<x>.js
├─ skills/                       # LLM-facing content (see Content layer)
├─ src/
│  ├─ hooks/                     # hook entrypoints (one per registered hook)
│  ├─ core/                      # pure domain logic, no I/O
│  ├─ io/                        # filesystem, config, headless LLM, git
│  └─ cli/                       # record.js, status.js (shelled to by skills)
└─ test/                         # node:test suites, mirrors src/
```

The Domain layer is pure (deterministic functions, no filesystem, no child
processes) — this is what makes scoring unit-testable. The Infrastructure
layer owns every side effect. Orchestration (the body of the Stop hook and of
`record.js`) is the only place the two meet. One deliberate exception keeps
shared checks DRY: Infrastructure may import the pure validation predicates
in `src/core/predicates.js` (a dependency-free Domain leaf); the reverse
direction — Domain importing anything from `src/io/*` — remains forbidden.

## Data flow

```mermaid
flowchart TD
    subgraph collect [During the turn — append-only]
        UPS[UserPromptSubmit] -->|prompt event| LOG[(session log .jsonl)]
        PTU["PostToolUse (Edit|Write)"] -->|edit event, diff stats| LOG
        SAS[SubagentStart / SubagentStop] -->|subagent events| LOG
    end
    LOG --> STOP[Stop hook — turn boundary]
    STOP --> GROUP[build turn group] --> SCORE["decay + turn delta -> save state.json"]
    SCORE --> GATES{hard gate: critical paths<br/>soft gate: score >= threshold}
    GATES -- neither --> QUIET[no pause, exit]
    GATES -- fired --> CLASS{classifier veto — LLM #1}
    CLASS -- veto / muted --> QUIET
    CLASS -- pass --> FIRE["write stoic-pending-pause.json<br/>Stop-block + injected instruction"]
    FIRE --> SKILL["stoic-pause skill — LLM #2<br/>Reflect / Skip / Defer -> Socratic questions"]
    SKILL --> REC["src/cli/record.js — single outcome writer"]
    REC --> BANK[(.stoic/decisions/*.md)]
    REC --> MUTES[mutes + score adjustment in state.json]
```

Order of operations in the Stop hook (binding): read and truncate the session
log → build the turn group → decay score by half-life, add turn delta, floor
at zero → **save state before gating** → evaluate hard gate (critical-path
match, bypasses score) and soft gate (score ≥ threshold) → on a fired gate,
run the classifier and apply its veto → check mutes (category and touched-file
fingerprint) → fire: reduce score by one threshold, write
`stoic-pending-pause.json`, emit the Stop-block.

`Stop` is registered with a **90-second timeout** — the only hook that carries
one, since the other four only append a line and return. The headroom is
reserved for the classifier's headless `claude -p` call, which runs inside this
same invocation once Epic 2 lands.

### Pause delivery contract

Hooks cannot render UI, so a pause is delivered as a deliberate workaround:
the Stop hook returns `{"decision": "block", "reason": <instruction>}`, where
the instruction tells the main conversation to invoke the `stoic-pause` skill.
The skill reads its context from `stoic-pending-pause.json` and reports the outcome
by shelling to `src/cli/record.js`, which deletes the file on success.

The injection text, the `stoic-pending-pause.json` schema, and the `record.js` CLI
interface are **load-bearing**: a change to any of them must update the Stop
hook, the skill, and the integration tests together. Schemas live in
[architecture/payloads.md](architecture/payloads.md).

### Delegation

Edits made by sub-agents are attributed per event: a `PostToolUse` payload
carrying `agent_id` marks the edit event `delegated: true` (plus
`agent_type`). Delegated edits weigh into the score at a **reduced weight**
(the `delegated_discount` knob) — refining the earlier "like any other
autopilot signal" decision: autopilot is a property of the user's input, not
of the machine's output, and a deliberate, planned fan-out is normal
engineering (see the [domain glossary](architecture/2026-07-11_CONTEXT.md)).
A low-effort prompt that fans out agents still scores, through the
prompt-effort signal plus the discounted delegated volume. There is no live
sub-agent counter and no prompt-suppression window — that sandbox mechanism
was dropped as too stateful for its value (see trade-offs.md). Consequence:
edits from background delegation that land after the parent turn's Stop are
scored one turn late (see trade-offs.md).

### Self-instrumentation guards

The plugin must never score its own machinery. These guards are correctness
conditions, not optimizations — the easiest place to introduce a regression:

- `STOIC_INTERNAL=1` is set in the classifier's headless child environment;
  every hook exits immediately when it is present.
- Edit events under `.stoic/` or outside the project cwd are dropped.
- Prompts starting with `/stoic-stack` are ignored by UserPromptSubmit.
- The Stop invocation that follows a pause (`stop_hook_active`) truncates the
  session log and exits, so pause machinery never feeds the next score.

### State locations

| What                                                                                                                     | Where                                   | Git policy                                  |
| ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------- |
| Engine state: `state.json` (score, mutes, streaks), per-session event log, `stoic-pending-pause.json`, trace/debug sinks | `~/.claude/stoic-stack/<project-slug>/` | outside the repo                            |
| User config: `config.json`                                                                                               | `<project>/.stoic/`                     | committed (team-shareable)                  |
| Decision bank: `YYYY-MM-DD_<branch>.md`                                                                                  | `<project>/.stoic/decisions/`           | in repo, gitignored (written by the plugin) |

All engine writes are atomic (tmp file + rename). Schemas are specified in
[architecture/payloads.md](architecture/payloads.md); config in
[architecture/configuration.md](architecture/configuration.md).

## Component map

| Module                                            | Layer                       | Responsibility                                                                                                                                 |
| ------------------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/hooks/hook-runtime.js`                       | Entrypoints (shared leaf)   | Shared leaf for `capture.js` and `stop.js` (which never import each other): read and validate the stdin payload, one-line a thrown value.      |
| `src/hooks/capture.js`                            | Entrypoints (shared)        | The frame every capture hook runs inside: `STOIC_INTERNAL` guard, stdin parse, enabled check, append, one trace line, swallow everything.      |
| `src/hooks/user-prompt-submit.js`                 | Entrypoints                 | Append `prompt` event (truncated text + effort computed at write time); skip own prompts; log harness-injected notifications as `neutralized`. |
| `src/hooks/post-tool-use.js`                      | Entrypoints                 | Append `edit` event with diff stats and delegation attribution.                                                                                |
| `src/hooks/subagent-start.js`, `subagent-stop.js` | Entrypoints                 | Append sub-agent lifecycle events.                                                                                                             |
| `src/hooks/stop.js`                               | Entrypoints + Orchestration | The turn-boundary brain: score, gate, veto, fire the pause.                                                                                    |
| `src/cli/record.js`                               | Entrypoints + Orchestration | Single writer for pause outcomes (keep / correct / skip / defer).                                                                              |
| `src/cli/setup.js`                                | Entrypoints + Orchestration | Single writer for guided setup: inspect current choices (`--current`), or validate and apply a complete set (`--apply`).                       |
| `src/cli/status.js`                               | Entrypoints                 | Read-only observability (`--json`) plus preset switching (writes the personal `state.preset` override).                                        |
| `src/core/scoring.js`                             | Domain                      | Score decay, turn delta (incl. the delegated-edit discount).                                                                                   |
| `src/core/prompts.js`                             | Domain                      | Prompt-effort heuristic, harness-injection (task-notification) detection.                                                                      |
| `src/core/group.js`                               | Domain                      | Turn-group builder: session events → turn summary (the `group` in `stoic-pending-pause.json`).                                                 |
| `src/core/gates.js`                               | Domain                      | Critical-path matching, mute evaluation and pruning.                                                                                           |
| `src/core/diffstats.js`                           | Domain                      | Edit-size extraction from tool payloads.                                                                                                       |
| `src/core/predicates.js`                          | Domain (leaf)               | Shared pure validation predicates, importable from every layer.                                                                                |
| `src/io/paths.js`                                 | Infrastructure              | All path resolution — pure; directories come into existence only through writers.                                                              |
| `src/io/trace.js`                                 | Infrastructure              | Fail-silent bounded trace sink: one outcome line per hook invocation, size-capped with a single rotation.                                      |
| `src/io/json-file.js`                             | Infrastructure              | Fail-safe JSON document helpers: status-reporting reads, atomic tmp+rename writes (used by config and state).                                  |
| `src/io/state.js`                                 | Infrastructure              | Atomic load/save of `state.json`.                                                                                                              |
| `src/io/config.js`                                | Infrastructure              | Config defaults, presets, category taxonomy, knob resolution, the guided-choice model, atomic save.                                            |
| `src/io/session-log.js`                           | Infrastructure              | Append/read/truncate the per-session event log.                                                                                                |
| `src/io/headless.js`                              | Infrastructure              | Cross-platform `claude -p` runner; returns `null` on any failure.                                                                              |
| `src/io/classifier.js`                            | Infrastructure              | LLM #1 prompt build, verdict validation, category resolution.                                                                                  |
| `src/io/bank.js`                                  | Infrastructure              | Decision-bank markdown writer (enforces `.gitignore`) and aggregate reader.                                                                    |

## Content layer

All LLM-facing content is markdown under `skills/` — no `commands/` directory
(Claude Code merged commands into skills; skills are the recommended layout
for new plugins). Content is prompts, not code; it talks to code only through
two seams: reading `stoic-pending-pause.json` and shelling to `src/cli/*.js`.

| Skill                 | Invocation                                   | Purpose                                                                                          |
| --------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `skills/setup/`       | user only (`disable-model-invocation: true`) | ≤4 plain-language questions → shells to `setup.js`; never constructs config itself.              |
| `skills/status/`      | user only (`disable-model-invocation: true`) | Show score, recent decisions, heartbeat — via `status.js --json`.                                |
| `skills/reflect/`     | user only (`disable-model-invocation: true`) | Trigger a reflection on demand.                                                                  |
| `skills/stoic-pause/` | model only (`user-invocable: false`)         | The pause cascade: gate question → read touched files → 1–3 Socratic questions → record outcome. |

Keep `SKILL.md` bodies lean; only descriptions are always in context, bodies
load on invocation.

## Testing

`node:test` (built-in runner, zero extra dependencies), run via `npm test`.
Two tiers under `test/`, mirroring `src/`:

- **Unit** — the Domain layer (`src/core/*`): pure functions tested
  exhaustively, including scoring edge cases and gate/mute logic.
- **Integration** — real hook scripts executed as child processes against
  throwaway temp projects, asserting the full pipeline moves
  (prompt → edit → Stop → `state.json` → pause fired). No network: the
  classifier and headless runner are faked through documented env seams
  (`STOIC_TEST_CLASSIFICATION`, `STOIC_TEST_HEADLESS_RESULT`).

Child processes run against an isolated temporary project and temporary home
(`HOME`/`USERPROFILE` overrides), so suites can never touch a contributor's
real project or personal state. Test fixtures under `test/fixtures/` are
inert unless the harness sets `STOIC_TEST_SANDBOX=1` — a safety interlock,
not a runtime seam.

The load-bearing contracts (pause delivery, `record.js` CLI, payload schemas)
each have a dedicated integration test; changing a contract without updating
its test must fail CI.
