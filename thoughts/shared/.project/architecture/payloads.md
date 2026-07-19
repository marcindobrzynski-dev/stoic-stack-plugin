---
status: approved
version: 0.1.1
last_update: 2026-07-19
created_at: 2026-07-11
---

# Payloads & schemas

> Companion to [../architecture.md](../architecture.md). The load-bearing
> data shapes: what hooks read, what the engine logs and persists, and the
> pause-delivery contract. A change to any shape here must land together with
> its integration test.

## Hook inputs (stdin, JSON from Claude Code)

Only the fields the plugin actually reads are listed.

| Hook                                             | Fields read                                                                                                                              |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `UserPromptSubmit`                               | `session_id`, `prompt`, `permission_mode`, `cwd`                                                                                         |
| `PostToolUse` (matcher `Edit\|MultiEdit\|Write`) | `session_id`, `tool_name`, `tool_input.file_path`, `tool_response` (diff/patch data), `agent_id`, `agent_type`, `permission_mode`, `cwd` |
| `SubagentStart` / `SubagentStop`                 | `session_id`, `agent_id`, `agent_type`                                                                                                   |
| `Stop`                                           | `session_id`, `stop_hook_active`, `cwd`                                                                                                  |

Every hook exits 0 and stays silent on malformed input (fail-silent).

## Session event log

`~/.claude/stoic-stack/<project-slug>/sessions/<session_id>.jsonl` —
append-only during the turn, read and truncated by the Stop hook. The file
name is not the raw session id: every character outside `[A-Za-z0-9]` is
first replaced with a dash, the same rule the project slug uses. The id
arrives on hook stdin from outside the plugin, so this rewrite is a
path-traversal guard — an id like `../../x` can only ever name a file
inside `sessions/`. Accepted cost: two ids that differ only in punctuation
(`a.b`, `a_b`) share one log file. One JSON object per line:

```jsonc
{ "type": "prompt", "ts": 0, "prompt": "<text, truncated to 2000 chars>",
  "effort": 0.0, "permission_mode": "default", "neutralized": false }
{ "type": "edit", "ts": 0, "file": "src/x.js", "lines_added": 0,
  "lines_removed": 0, "permission_mode": "default",
  "delegated": false, "agent_type": null }
{ "type": "subagent_start", "ts": 0, "agent_type": "..." }
{ "type": "subagent_stop", "ts": 0, "agent_type": "..." }
```

The prompt event stores the **truncated text** (the classifier and the pause
context both need it) plus `effort`, computed at write time by
`src/core/prompts.js` — the Stop hook never recomputes it. `delegated` and
`agent_type` are always present on edit events (never omitted-when-false).
`permission_mode` feeds the auto-accept multiplier in the turn delta.

Prompts matching the harness-injection marker (`<task-notification>`) are
logged with `neutralized: true` and zero effort.

## `trace.jsonl` (bounded trace sink)

`~/.claude/stoic-stack/<project-slug>/trace.jsonl` — the only field-debugging
surface. Every hook invocation appends exactly one compact JSON line,
fail-silently, so a dead pipeline is distinguishable from a quiet one. Growth
is bounded by a single rotation: past `TRACE_MAX_BYTES` (an uncalibrated
placeholder defined in `src/io/trace.js`) the file replaces `trace.jsonl.1`
and a fresh generation starts. There is no other log — no unbounded
`debug.log`, no `STOIC_DEBUG` capture mode.

```jsonc
{ "ts": 0, "hook": "UserPromptSubmit", "outcome": "logged" }
```

`ts` (ms epoch) and `hook` (the name registered in `hooks/hooks.json`) are
stamped by the sink itself; `outcome` is a short snake_case verdict owned by
the hook entrypoint that wrote it (e.g. `logged`, `dropped`, `scored`,
`error`). Per-outcome extras ride on the same line:

```jsonc
// a swallowed internal failure — the error becomes an outcome, not a throw
{ "ts": 0, "hook": "PostToolUse", "outcome": "error", "error": "<one line>" }
// the Stop hook's score movement
{ "ts": 0, "hook": "Stop", "outcome": "scored",
  "score_before": 0.0, "score_after": 0.0 }
// the continuation Stop counts what its truncation dropped, keyed by event
// type (resolved Open Decision 2, Option C — field evidence for calibration)
{ "ts": 0, "hook": "Stop", "outcome": "continuation_truncated",
  "dropped": { "prompt": 0, "edit": 0 } }
```

Trace lines are diagnostic output, not input: nothing in the engine reads
them back, so extras may grow per outcome without a migration — but `ts`,
`hook`, and `outcome` are required on every line.

## `state.json`

`~/.claude/stoic-stack/<project-slug>/state.json` — atomic writes only.

```jsonc
{
  "score": 0.0,
  "last_update": 0, // ms epoch of last Stop evaluation
  "mutes": [], // { category, files, expires_at } — files null ⇒ whole category
  "skip_streak": {}, // per-category consecutive-skip counters
  "skip_totals": {}, // per-category lifetime skips
  // "preset": "vigilant"  — OPTIONAL personal override, absent until the user
  // sets one. Effective preset = state.preset ?? config.preset ?? "balanced".
}
```

`preset` is the only optional field, and its absence is meaningful: initialized
state omits it so that a committed team preset actually reaches a teammate.
Writing `"balanced"` into fresh state would pin every user to the built-in
default and make the team preset unreachable — the personal layer must stay
empty until the user personally chooses.

## `setup.js` CLI (guided-setup contract)

The only writer of guided configuration, shelled to by the `setup` skill. The
skill owns the conversation and nothing else: it may pass canonical identifiers
and may not construct a config document.

```
node src/cli/setup.js --current
node src/cli/setup.js --apply --preset <calm|balanced|vigilant> \
                              --categories <comma-separated areas, "" for none> \
                              --pause-mode <hybrid|choices|freeform> \
                              --followup-draft <true|false>
```

`--current` reads the guided choices in effect and writes nothing, so it is safe
to call merely to populate the questions. It reports the **team** preset, never
`effectivePreset` — offering a personal override as the current answer would let
an unchanged re-run publish a private choice to the team.

`--apply` requires **all four** choices. Setup is not a patch protocol: a
complete request keeps "the user answered this" distinct from "the user left it
alone". `--categories ""` is an answer, not an omission — it writes an empty
category list and disables the plugin; any area re-enables it. Setup never
writes a personal preset override.

stdout is always exactly one JSON result, success or failure, so the caller
parses one stream and branches on `ok`:

```jsonc
// success
{
  "ok": true,
  "operation": "current" | "apply",
  "choices": { "preset": "...", "categories": [], "pause_mode": "...", "followup_draft": true },
  "enabled": true,
  "state": "created" | "preserved",  // --apply only
  "config": "written",               // --apply only
}
// failure
{
  "ok": false,
  "error": { "code": "...", "message": "..." },
  "state": "unchanged" | "created",  // what the run had ALREADY written
  "config": "unchanged",
}
```

Error codes: `usage`, `invalid_choice`, `state_init_failed`,
`config_write_failed`, `unexpected`.

Exit status: `0` success, `2` the request was rejected and nothing was written,
`1` the request was valid but persistence failed.

**Filesystem locations are deliberately absent from the result.** Paths appear
only in the human-readable stderr diagnostic, which is not part of this
contract. Expanding the result to carry a path is a deliberate change to make
here first.

The `state` and `config` fields report what happened, and the failure case is
load-bearing: config and state are two atomic writes, **not one transaction**.
A `config_write_failed` after state was created reports `"state": "created"`
rather than pretending nothing happened. Ordering makes that rare — state is
initialized first, because a corrupt state document is the one thing setup must
refuse to repair, and discovering it before the config write leaves the project
untouched.

## Classifier verdict (LLM #1)

The classifier emits exactly:

```jsonc
{
  "decision_found": true, // true ⇒ the turn contains a pause-worthy decision
  "subcategory": "...", // from the configured subcategory vocabulary
  "reason": "...", // one short sentence
  "confidence": 0.0,
}
```

Validation resolves `subcategory` to its enabled top-level `category` and
clamps `confidence` to [0, 1]. Veto reasons, checked in order:
`no_classification` (failed/malformed call), `no_decision`
(`decision_found` ≠ true), `low_confidence` (below
`classifier_confidence_threshold`), `bad_category` (unresolvable or disabled
area). (Sandbox names `in_control` — which read backwards: `true` fired the
pause — and the `category` field that actually carried a subcategory are
renamed by this contract.)

## `pending-pause.json` (pause-delivery contract, part 1)

Written by the Stop hook when a pause fires; read by the `stoic-pause` skill;
deleted by `record.js` on success.

```jsonc
{
  "created_at": 0,             // ms epoch
  "trigger": "score" | "critical_path" | "manual",
  "score": 0.0,
  "threshold": 0.0,
  "classification": { "decision_found": true, "category": "...",
                      "subcategory": "...", "reason": "...", "confidence": 0.0 },
  "group": { /* turn summary: prompt, edits with files and line counts */ },
  "cwd": "...",
  "plugin_root": "...",
  "record_cmd": "node <plugin_root>/src/cli/record.js",
  "pause_mode": "hybrid",
  "followup_draft": true,
  "max_questions": 3
}
```

`trigger` names the gate that fired: `score` (soft gate; the sandbox called
this `streak`, renamed — "streak" now belongs to skip-streaks only),
`critical_path` (hard gate), `manual` (the `reflect` skill wrote the file on
user request; classification may be absent).

## Stop hook output (pause-delivery contract, part 2)

On fire, the Stop hook prints to stdout:

```json
{
  "decision": "block",
  "reason": "<instruction to invoke the stoic-pause skill>"
}
```

The `reason` text is load-bearing: it is the only channel instructing the
main conversation to run the skill. Its wording is owned by `src/hooks/stop.js`
and mirrored in the skill's expectations — change both together.

## `record.js` CLI (pause-delivery contract, part 3)

Single writer for pause outcomes, shelled to by the skill:

```
node src/cli/record.js --outcome keep|correct|skip|defer \
  [--data <path to pause-answer.json>]
```

Outcomes are imperatives — the vocabulary is the choice menu the user picks
from (sandbox's mixed `kept`/`corrected`/`skip`/`defer` unified). Free text
never travels as a CLI argument (Windows shell quoting is fragile): for
`keep`/`correct` the skill first writes the answer file (part 3b) and passes
its path via `--data`.

Effects: `keep`/`correct` → decision-bank entry + fingerprint mute + score
cap; `skip`/`defer` → fingerprint mute + skip-streak update (3 consecutive
skips → category mute). Always deletes `pending-pause.json` on success.

## `pause-answer.json` (pause-delivery contract, part 3b)

Written by the `stoic-pause` skill next to `pending-pause.json`; consumed and
deleted by `record.js`:

```jsonc
{
  "questions": ["..."], // the Socratic questions actually asked
  "answer": "...", // the user's reflection, free text
  "followup_prompt": "...", // optional; drafted on `correct` when followup_draft is on
}
```

## Decision bank entry

`<project>/.stoic/decisions/YYYY-MM-DD_<branch-slug>.md` — one file per day
per branch; frontmatter (`date`, `branch`) plus one section per decision:

```markdown
## HH:MM — <category>

- outcome: keep | correct
- subcategory: ...
- files: ...
- trigger: score | critical_path | manual
- questions / answer / correction: ...
```

`bank.js` writes `.stoic/.gitignore` (containing `decisions/`) before every
write, so the bank never leaks into commits by default.
