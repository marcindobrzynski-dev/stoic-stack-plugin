---
name: stoic-pause
description: Run the pending Stoic Stack pause — read stoic-pending-pause.json, ask one to three Socratic questions about the decision in the turn that just ended, and record the outcome through record.js. Use when a Stop hook blocks the turn naming this skill, or when the developer asks to finish a pause that was interrupted.
---

# Stoic Stack pause

One short **retrospective** moment about the turn that just ended, and then the
turn ends. You **own the conversation**; `record.js` **owns every consequence**
— it alone writes a decision, a mute, or engine state. The single file you write
is `pause-answer.json`, and only to carry your questions and the developer's own
words to that CLI.

Every branch below finishes by ending the turn. The interrupted work stays where
it is and resumes when the developer asks for it — including after a `correct`,
where you hand over a drafted prompt for them to send.

**Offering options.** Each choice below is an `AskUserQuestion` call. When that
tool is unavailable or the developer declines it, put the same options in one
plain numbered message and read the answer from their next message. The choice
is the contract; the tool is its nicer form.

## 1. Read the pause

The invoking instruction names the absolute path of `stoic-pending-pause.json`.
When the developer invoked you by hand and named no path, look for
`stoic-pending-pause.json` under `~/.claude/stoic-stack/*/` and take the one
whose `cwd` matches this session's project.

The document holds everything this conversation needs: `classification`
(`category`, `subcategory`, `reason`), `trigger`, `score`, `threshold`, the turn
`group` with its `edits`, plus `pause_mode`, `max_questions`, `followup_draft`,
and `record_cmd`.

When no pending pause exists, or the file will not parse, say one short line
("Nothing is waiting to be reflected on.") and end the turn.

Done when you hold the parsed document, or the turn has ended.

## 2. Offer the gate

Show what fired, in the developer's language: the `category` (with
`subcategory` when present), the classifier's `reason`, and what triggered it —
`score` reads as "this turn's pace", `critical_path` as "this turn touched a
sensitive path".

Offer three options: **Reflect** (a moment on this), **Skip** (not this one),
**Defer** (later, ask me again).

One pause skips this gate and goes straight to step 4 with Reflect assumed: a
`pause_mode` of `freeform`, where the developer asked to write rather than pick.
Skip stays reachable there — a refusal at step 6 records as `skip`.

Done when you hold Reflect, Skip, or Defer.

## 3. Record a Skip or a Defer

Run `record.js` with that outcome, relay every returned notice verbatim, add at
most one short closing line, and end the turn.

Done when the CLI has returned and the turn has ended.

## 4. Write the questions

**Send a subagent to read the code.** You are running inside the developer's own
conversation, and every file opened here stays in their context for the rest of
the session. Dispatch one subagent on the latest Sonnet — the project's default
tier for research — and let it do the reading:

> Read these files: `<the paths in group.edits>`. For each, report the concrete
> facts of what changed and what surrounds it — names, shapes, branches,
> dependencies, and any immediate import the decision reaches across. Report
> facts only.

The facts come back; the files stay out. Each question then stands on a
**concrete** fact from that report: a name, a shape, a branch, a dependency.
Reserve a second subagent for a decision spanning parts the first could not
cover.

Ask one question for a contained decision, up to `max_questions` for one that
reshapes something. Fewer, sharper questions beat filling the quota.

Phrase them retrospectively — about the choice already made, in the developer's
own domain nouns. A question naming `applyDiscount` or the nullable
`customer_id` column is the target; a question that would fit any codebase is a
draft to rewrite.

Sharpen the angle to the category, then to the subcategory:

| Category          | Angle                                                                        |
| ----------------- | ---------------------------------------------------------------------------- |
| `data_domain`     | What this shape makes easy, what it makes expensive, and what it now forbids |
| `api_integration` | Who else depends on this contract, and what breaks when it changes           |
| `security`        | Who can reach this, and what they can do once they are through               |
| `architecture`    | What this couples to what, and how it is undone later                        |

Done when every question names a fact from the report.

## 5. Collect the reflection

Deliver all questions **batched in one message**, and collect one answer
exchange. Two shapes, by `pause_mode`:

- `hybrid` and `freeform` — the questions as a short numbered list, answered in
  writing.
- `choices` — one `AskUserQuestion` carrying every question, each with 2–4
  options drawn from the code you read (real alternatives the decision had,
  phrased in the developer's nouns), alongside the free-text escape the tool
  already offers.

Done when the developer has answered, in whatever form.

## 6. Read the outcome

The answer resolves to one outcome:

- **keep** — the decision stands as made.
- **correct** — the answer names something to change.
- **skip** — the developer declines to reflect after all.

Ask a single Keep-or-Correct `AskUserQuestion` when the answer genuinely could
be either. An answer that plainly reads one way is already the outcome.

On `correct` with `followup_draft` enabled, draft one follow-up prompt: concrete,
imperative, one job, phrased so the developer can edit it and send it. Present it
as text for them to send. This step ends the turn like the others.

Done when you hold `keep`, `correct`, or `skip`.

## 7. Record it

For `skip`, run the CLI directly. For `keep` and `correct`, first write
`pause-answer.json` in the same directory as the pause document:

```json
{
  "questions": ["the questions you actually asked"],
  "answer": "the developer's reflection, verbatim",
  "correction": "what they said to change — on correct",
  "followup_prompt": "the drafted prompt — when one was drafted"
}
```

Then pass its path via `--data`. Everything else in the recorded entry — the
category, the files, the trigger — `record.js` reads from the pause document, so
your file carries only the conversation.

Worked examples — match the shape, not the values. Take the command from the
document's own `record_cmd` field and the pause path from the invoking
instruction. In the paths below, `me` stands for the developer's home-folder
name and `my-project` for their project slug; both are stand-ins for whatever
the real path holds:

    # The developer chose Skip at the gate
    node "C:/plugins/stoic-stack/src/cli/record.js" --outcome skip --pause "C:/Users/me/.claude/stoic-stack/my-project/stoic-pending-pause.json"

    # The developer chose Defer
    node "C:/plugins/stoic-stack/src/cli/record.js" --outcome defer --pause "C:/Users/me/.claude/stoic-stack/my-project/stoic-pending-pause.json"

    # The decision stands — the answer file carries the reflection
    node "C:/plugins/stoic-stack/src/cli/record.js" --outcome keep --pause "C:/Users/me/.claude/stoic-stack/my-project/stoic-pending-pause.json" --data "C:/Users/me/.claude/stoic-stack/my-project/pause-answer.json"

    # The developer wants a change, and approved the drafted follow-up
    node "C:/plugins/stoic-stack/src/cli/record.js" --outcome correct --pause "C:/Users/me/.claude/stoic-stack/my-project/stoic-pending-pause.json" --data "C:/Users/me/.claude/stoic-stack/my-project/pause-answer.json"

Parse the single JSON line. On `ok: true`, relay every entry of `notices`
verbatim — they are the engine speaking to the developer, and the
three-skips-in-a-row notice arrives only here. On `ok: false`, show
`error.message` as one concise line; `record.js` stays the only writer, so the
pause simply waits.

Done when the CLI has returned, its notices are relayed, and the turn has ended.

## Tone

Stoic, calm, curious, brief. You are asking what the developer was thinking
about work that is already done — the pause is an invitation to look, and it
costs them a few seconds either way. Close with one short line and stop.
