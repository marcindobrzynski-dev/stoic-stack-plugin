---
version: 0.2.0
last_update: 2026-09-29
created_at: 2026-07-11
---

# Payloads & schemas

> Companion to [../architecture.md](../architecture.md). The load-bearing
> data shapes: what hooks read, what the engine logs and persists, and the
> pause-delivery contract — both the automatic pause the Stop hook writes and
> the manual reflection `src/cli/reflect.js` writes. A change to any shape here
> must land together with its integration test.

## Hook inputs (stdin, JSON from Claude Code)

Only the fields the plugin actually reads are listed.

| Hook                                             | Fields read                                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `UserPromptSubmit`                               | `session_id`, `prompt`, `permission_mode`, `cwd`                                                                            |
| `PostToolUse` (matcher `Edit\|MultiEdit\|Write`) | `session_id`, `tool_input.file_path`, `tool_response` (diff/patch data), `agent_id`, `agent_type`, `permission_mode`, `cwd` |
| `SubagentStart` / `SubagentStop`                 | `session_id`, `agent_type`, `cwd`                                                                                           |
| `Stop`                                           | `session_id`, `stop_hook_active`, `cwd`                                                                                     |

`cwd` is read by every hook, including the sub-agent pair, but it is not the
project's identity. That identity is the **Project Root**
(`src/io/project-root.js`), resolved once per invocation from the process
directory and the payload: the git working-tree root wins, then the nearest
`.stoic/config.json` above, then `CLAUDE_PROJECT_DIR`, and only then the
payload's `cwd`, with `process.cwd()` last. The resolved root is what the
event log, the local trace, and the outside-the-project edit drop all have to
agree about, so a session that starts in a subdirectory, or moves into one
mid-way, keeps one identity. `tool_name` is
deliberately **not** read — `src/core/diffstats.js` measures an edit from the
shape of its `tool_response`, so the tool's name would be a second, weaker
answer to a question already settled. Nothing downstream carries it: the edit
event has no `tool` field.

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
`permission_mode` feeds the auto-accept multiplier in the turn delta: of the
six documented Claude Code modes, `default` (the mode labeled Manual, which
never arrives as `"manual"`) and `plan` still ask before an edit, so
`acceptEdits`, `auto`, `dontAsk`, and `bypassPermissions` are the
auto-accepting set — named in `src/core/group.js`. A payload that states no
mode is logged as `"default"`.

Prompts matching the harness-injection marker (`<task-notification>`) are
logged with `neutralized: true` and zero effort.

## Turn group

Built by `src/core/group.js` from the parsed session events at Stop; consumed
by the scorer, and embedded unchanged as the `group` field of
`stoic-pending-pause.json`. It is a value, never a file. `reflect.js` reuses
the same shape for a manual reflection, populating only its file and volume
fields from the working-tree diff.

```jsonc
{
  "prompt": "<genuine prompts, joined in submission order by a blank line>",
  "prompt_effort": 0.0, // MEAN over the genuine prompts; 0 when none
  "genuine_prompt_count": 0, // the mean's denominator
  "neutralized_prompt_count": 0,
  "prompt_neutralized": false, // prompts happened, none of them genuine
  "had_question": false, // some genuine prompt asks a real question
  "auto_accept": false, // some event ran in an auto-accepting mode
  "edit_count": 0, // totals INCLUDE delegated work
  "lines_added": 0,
  "lines_removed": 0,
  "delegated_edit_count": 0, // the delegated share of the same totals
  "delegated_lines_added": 0,
  "delegated_lines_removed": 0,
  "delegated": false, // agent_count > 0 || delegated_edit_count > 0
  "agent_count": 0, // sub-agents started during this turn
  "edits": [
    {
      "ts": 0,
      "file": "src/x.js",
      "lines_added": 0,
      "lines_removed": 0,
      "delegated": false,
      "agent_type": null,
    },
  ],
  "subagent_events": [{ "lifecycle": "start", "ts": 0, "agent_type": "..." }],
  "understood_event_count": 0, // log lines this reader understood
  "skipped_event_count": 0, // log lines that were not
}
```

Prompt effort is **read from the log, never recomputed** — recomputing would
let a later change to the heuristic rescore a turn that already happened. A
turn with several prompts scores the mean of their efforts, over its genuine
prompts only: a harness injection is excluded from the mean and from its
denominator rather than averaged in as a zero, because a machine notification
is not a thought the developer failed to have. The same set is joined into
`prompt`, so the text the classifier reads always matches the number that
scored the turn. `had_question`, unlike effort, IS derived here — the log
carries no question flag, and the judgment reads the same stored text.

Two degraded-log rules keep the mean honest. A genuine prompt whose `effort` is
missing or unreadable counts as **zero and stays in the denominator**: the
developer did type it, only its measurement was lost, and zero is the same
neutral value the heuristic gives text it cannot judge. That is not the
injection rule — an injection leaves the denominator because no developer typed
it at all. An `effort` outside [-1, +1], reachable only by hand-editing the
log, is clamped to that range before it is averaged.

Volume totals stay delegation-inclusive with the delegated share alongside, so
the turn delta discounts a fan-out without a second pass. `delegated` is true
on delegated edits alone: sub-agents are asynchronous, so their edits
routinely land in the turn after the one that started them, whose log holds no
start event.

## `local-trace.jsonl` (bounded per-project trace sink)

`~/.claude/stoic-stack/<project-slug>/local-trace.jsonl` — the only
field-debugging surface for a project. Every hook invocation appends exactly one compact JSON line,
fail-silently, so a dead pipeline is distinguishable from a quiet one. One
invocation writes nothing: a hook that finds `STOIC_INTERNAL` set exits before
the sink, because the self-instrumentation guard is the stronger promise —
"before any read or write" includes this one, and a trace of the plugin
watching its own child is exactly the noise the guard exists to prevent. Growth
is bounded by a single rotation: past `TRACE_MAX_BYTES` (an uncalibrated
placeholder defined in `src/io/trace.js`) the file replaces `local-trace.jsonl.1`
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
// the Stop hook's score movement — `score_before` is the score as loaded from
// state.json (before decay), `score_after` the value persisted back
{ "ts": 0, "hook": "Stop", "outcome": "scored",
  "score_before": 0.0, "score_after": 0.0 }
// the continuation Stop counts what its truncation dropped, keyed by event
// type (resolved Open Decision 2, Option C — field evidence for calibration)
{ "ts": 0, "hook": "Stop", "outcome": "continuation_truncated",
  "dropped": { "prompt": 1, "edit": 2 } }
```

`dropped` is a sparse tally: only kinds actually dropped appear, and a
continuation that found nothing to drop writes `{}` rather than a row of
zeros — an unreadable log line is evidence of nothing and is not counted.

Trace lines are diagnostic output, not input: nothing in the engine reads
them back, so extras may grow per outcome without a migration — but `ts`,
`hook`, and `outcome` are required on every line.

## `shared-trace.jsonl` (shared trace sink)

`~/.claude/stoic-stack/shared-trace.jsonl` — keyed on no project: it sits above
every `<project-slug>` directory, so a hook invocation that could not name its
project still leaves its one line. It is written through the same append as
the local trace, so the line shape, the `ts` and `hook` stamps, and the
`TRACE_MAX_BYTES` rotation (into `shared-trace.jsonl.1`) are identical; the
writer creates `~/.claude/stoic-stack/` when it is missing. It has two
outcomes: `no_project_root`, written when Project Root resolution returns
nothing, and `error`, written when a hook fails before resolution has named a
project (in practice, a working directory deleted under the process), with the
same one-line `error` extra as in the local trace.

```jsonc
{ "ts": 0, "hook": "Stop", "outcome": "no_project_root" }
{ "ts": 0, "hook": "Stop", "outcome": "error", "error": "<one line>" }
```

The `hook` stamp is a trace label rather than strictly a hook name: the two
CLIs write their `no_project_root` line here too, as `setup` and `reflect`.
One rule covers every entrypoint — the shared trace line always; a stderr
sentence only where a person is waiting for the result, which is the CLIs;
and the CLIs still print their one stdout JSON result, `ok: false` with the
error code `no_project_root`, exit 1. Hooks run in the background and stay
silent.

The `no_project_root` branch, in hooks and CLIs alike, is deliberately
untested: it is unreachable from a child process. The last gate reads
`process.cwd()` inside the resolver, and a live process always has one. The
only way to empty it is to delete the directory under the process — Windows
refuses, and on POSIX `process.cwd()` then throws in the entrypoint before the
resolver runs, so the frame's catch writes the shared `error` line instead.
The branch is guarded by review, not by a test.

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

A mute's `files` has exactly three readings: `null` (or omitted) suppresses
the whole category; a literally empty `[]` — the fingerprint of a prompt-only
pause — is category-scoped for its window, so the identical pause cannot
re-fire every turn; a populated array suppresses only a turn touching one of
its usable entries. Anything else — a non-array value, or an array whose every
entry is unusable — is a corrupt entry and suppresses nothing: a corrupt mute
must never widen into silencing a category. Corrupt entries are also dropped by
the turn boundary's pruning at the next Stop, alongside expired ones: an entry
whose expiry cannot be read would otherwise never leave, and it was protecting
nothing while it stayed.

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

Error codes: `usage`, `invalid_choice`, `no_project_root`, `state_init_failed`,
`config_write_failed`, `unexpected`.

Both operations read and write the **Project Root** resolved from the directory
the CLI starts in, not that directory itself, so setup run from a subfolder
configures the project the hooks resolve to. `no_project_root` means every
resolution gate came back empty; nothing was written.

Exit status: `0` success, `2` the request was rejected and nothing was written,
`1` the request was valid but no project root could be resolved or persistence
failed.

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

## `stoic-pending-pause.json` (pause-delivery contract, part 1)

Written by the Stop hook when a pause fires; read by the `stoic-pause` skill;
deleted by `record.js` on success.

```jsonc
{
  "created_at": 0,             // ms epoch
  "trigger": "score" | "critical_path",
  "score": 0.0,
  "threshold": 0.0,
  "classification": { "decision_found": true, "category": "...",
                      "subcategory": "...", "reason": "...", "confidence": 0.0 },
  "group": { /* the turn group, verbatim — see §`Turn group` */ },
  "cwd": "...",               // the resolved Project Root, not the process directory
  "plugin_root": "...",
  "record_cmd": "node \"<plugin_root>/src/cli/record.js\"", // path quoted: installs may sit under paths with spaces
  "pause_mode": "hybrid",
  "followup_draft": true,
  "max_questions": 3
}
```

`trigger` names why the pause exists: `score` (soft gate; the sandbox called
this `streak`, renamed — "streak" now belongs to skip-streaks only),
`critical_path` (hard gate), and `manual`, which never appears in **this**
file. There are two pause documents sharing one schema, and the trigger is
what tells them apart: a gated pause is written here by the Stop hook, a
requested one is written to `stoic-manual-pause.json` by `reflect.js` (next
section). `score`, `threshold` and `classification` are present on every
document this file can hold, because a gate produced all three; they are
**absent** on a `manual` one.

## `reflect.js` CLI (manual-reflection contract)

The only writer of the manual pause document, shelled to by the
`stoic-reflect` skill. It measures `git diff HEAD` rather than a session and
writes one file; the reward for the reflection belongs to `record.js`, on
completion.

```
node src/cli/reflect.js [--project <directory>]
```

Without `--project` the CLI resolves the **Project Root** from the directory it
starts in, exactly as the hooks do. An explicit `--project` bypasses the
resolver and is used literally — checked to be a directory, never resolved
further — because the caller has named the project.

stdout is always exactly one JSON result, success or failure, so the caller
parses one stream and branches on `ok`, then on `material`:

```jsonc
// success
{
  "ok": true,
  "material": "found" | "clean",  // anything measured to reflect on?
  "edit_count": 0,
  "lines_added": 0,
  "lines_removed": 0,
}
// failure
{
  "ok": false,
  "error": { "code": "...", "message": "..." },
  "changed": { "pause": "unchanged" },
}
```

Error codes: `usage`, `invalid_project`, `no_project_root`,
`pause_write_failed`, `unexpected`. `no_project_root` means every resolution
gate came back empty; nothing was written.

Exit status: `0` success, `2` the request was rejected and nothing was written
(`usage`, `invalid_project`), `1` the request was valid but no project root
could be resolved or the document could not be persisted.

Filesystem paths are absent from the result, as in `setup.js`. Unlike
`setup.js`, whose stderr is no part of its contract, this CLI's stderr carries
one contractual line: `manual pause: <absolute path>` names the document just
written, and the skill passes that path to `record.js --pause`. Every other
stderr line is a human-readable diagnostic.

## `stoic-manual-pause.json` (the manual reflection)

`~/.claude/stoic-stack/<project-slug>/stoic-manual-pause.json` — the second
document of the shared pause schema, and a separate file on purpose. Both
paths key on the project rather than the session, so writing a requested
pause to the pending path would silently clobber an automatic pause the
developer had not finished yet. The two coexist.

- **Written by** `src/cli/reflect.js`, its only producer, on a developer's
  request. Atomic write, like every document under the state directory.
- **Read by** the `stoic-reflect` skill, which learns the path from the
  contractual `manual pause: <path>` line on the CLI's stderr — the stdout
  result carries no filesystem paths, matching the `setup.js` discipline.
- **Deleted by** `record.js` on success, exactly as it deletes the automatic
  pause. The recorder is filename-agnostic: it consumes whatever `--pause`
  named.

Same schema as `stoic-pending-pause.json`, minus the three fields only a gate
can fill:

```jsonc
{
  "created_at": 0, // ms epoch
  "trigger": "manual",
  // `score`, `threshold` and `classification` are ABSENT — not zeroed, not
  // nulled. Absent reads as "does not apply", which is the truth: this pause
  // was asked for, not gated. A zero would read as a measurement that came
  // out at zero.
  //
  // `group` keeps the turn group's shape, filled from the working-tree diff:
  // only `edits`, `edit_count`, `lines_added` and `lines_removed` carry
  // values. The scoring inputs keep their zero-signal defaults, because this
  // path does not score.
  "group": {},
  "cwd": "...",
  "plugin_root": "...",
  "record_cmd": "node \"<plugin_root>/src/cli/record.js\"",
  "pause_mode": "hybrid",
  "followup_draft": true,
  "max_questions": 3,
}
```

Every consumer must therefore treat those three fields as optional. The
recorder tolerates every field but `cwd` missing; the skill reads `group.edits`,
`pause_mode`, `max_questions`, `followup_draft` and `record_cmd` and nothing
else.

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

Single writer for pause outcomes, shelled to by whichever skill delivered the
pause:

```
node src/cli/record.js --outcome keep|correct|skip|defer \
  --pause <path to either pause document> \
  [--data <path to pause-answer.json>]
```

`--pause` takes `stoic-pending-pause.json` or `stoic-manual-pause.json`
indifferently: the recorder never inspects the filename, only the document,
and branches on its `trigger` and its classification.

Outcomes are imperatives — the vocabulary is the choice menu the user picks
from (sandbox's mixed `kept`/`corrected`/`skip`/`defer` unified). Free text
never travels as a CLI argument (Windows shell quoting is fragile): for
`keep`/`correct` the skill first writes the answer file (part 3b) and passes
its path via `--data`.

Both file arguments are explicit paths, never derived from the invocation
`cwd`. The skill already holds the absolute pause path — the Stop-block
reason gives it — and a session opened in a subdirectory would otherwise
derive a different project slug and miss the file entirely. The project root
`record.js` needs for the decision bank comes from the pause document's `cwd`
field, which both pause writers fill with the resolved Project Root rather
than the directory they were started in, so `--project` is deliberately
absent and `record.js` never resolves anything itself.

Effects: `keep`/`correct` → decision-bank entry + fingerprint mute + skip-streak
reset for that category; `skip` → fingerprint mute + skip-streak advance
(3 consecutive skips → category mute, streak reset); `defer` → fingerprint mute
only. Defer means "later", not "not this topic", so it never advances the
streak. Always deletes the pause document it was given on success, whichever of
the two it was; `keep`/`correct` also delete the answer file.

A pause relieves score pressure at **two** moments, through the one shared pure
function in `src/core/scoring.js`. The Stop hook applies the fire-time cap when
it fires a pause; `record.js` applies that cap plus the reward when a
**completed** manual reflection is recorded — `trigger: "manual"` with outcome
`keep` or `correct`. A `skip` or a `defer` earns nothing, so asking for a pause
and withdrawing is not a path to a lower score, and an automatic pause is left
exactly as the Stop hook scored it under every outcome. No other component may
write the score (see § `state.json`).

A pause without a usable classification category — reachable only through a
`stoic-manual-pause.json`, whose `trigger` is `manual` — gets no fingerprint mute and no skip-streak update under
any outcome: both key on a category, and a manual reflection has no
repeat to suppress. `keep`/`correct` still write its bank entry.

stdout is always exactly one JSON result, success or failure, mirroring the
`setup.js` discipline:

```jsonc
// success — `notices` are user-facing lines the skill relays verbatim
{ "ok": true, "outcome": "keep", "notices": [] }
// failure — `changed` reports honestly what had ALREADY been written
{
  "ok": false,
  "error": { "code": "...", "message": "..." },
  "changed": { "bank": "written" | "unchanged", "state": "unchanged" },
}
```

`changed.state` is an invariant rather than a choice: the state save is the last
step that can fail a run, and every step after it — deleting the consumed pause
and answer documents — is reported as a notice, never a failure. So no failure
result can truthfully claim a saved state, and the field stays in the shape to
account for both stores rather than to vary.

Error codes: `usage`, `invalid_pause`, `invalid_data`, `bank_write_failed`,
`state_save_failed`, `unexpected`. Exit status: `0` success, `2` the request
was rejected and nothing was written, `1` the request was valid but a
persistence step failed partway. The three-consecutive-skips notice is the one
notice `record.js` owns; its duration wording derives from `category_mute_ms`,
never a literal. Filesystem paths appear only in the human-readable stderr
diagnostics, never in the stdout JSON.

## `pause-answer.json` (pause-delivery contract, part 3b)

Written by the skill that delivered the pause — `stoic-pause` or
`stoic-reflect` — in the same directory as the pause document it answers;
consumed and deleted by `record.js`:

```jsonc
{
  "questions": ["..."], // the Socratic questions actually asked
  "answer": "...", // the user's reflection, free text
  "correction": "...", // optional; the revised decision, on `correct`
  "followup_prompt": "...", // optional; drafted on `correct` when followup_draft is on
}
```

This file is the conversation's only write. Everything else in a bank entry —
outcome, category, subcategory, files, trigger — comes from the pause document,
so the skill never restates engine facts it could get wrong. `record.js` joins the two and renders the markdown deterministically;
the skill never composes bank prose.

## Decision bank entry

`<project>/.stoic/decisions/YYYY-MM-DD_<branch-slug>.md` — one file per day
per branch, appended in chronological order. Written only for `keep` and
`correct`; `skip` and `defer` leave no entry.

```markdown
---
date: YYYY-MM-DD
branch: <branch>
---

## HH:MM — <category>

- outcome: keep | correct
- subcategory: ...
- files: ...
- trigger: score | critical_path | manual

### Questions

1. ...

### Answer

...

### Correction

...

### Follow-up

...
```

Free text lives in `###` sections, never in list fields: reflections are
multi-line and multi-paragraph, and a `- answer: ...` field breaks on the first
newline. The list fields above it are single-line engine facts, so they stay a
list.

`### Correction` is written only when the outcome is `correct`; `### Follow-up`
only when the user approved a drafted follow-up prompt. A `keep` entry
therefore ends after `### Answer`.

The `## HH:MM — <category>` heading carries the resolved **top-level** category,
because the aggregate reader keys on it; the subcategory stays a field. When
the pause carries no classification the heading reads `## HH:MM — manual`,
matching its `trigger: manual`. This is the only categoryless case that can
reach the bank: an unresolvable category on an automatic pause is the
`bad_category` veto, so no pause fires and nothing is recorded. A categoryless
entry also gets no fingerprint mute and no skip-streak update — both key on a
category, and a manual reflection has no repeat to suppress.

`bank.js` writes `.stoic/.gitignore` (containing `decisions/` and `.env`) before every
write, so the bank never leaks into commits by default.
