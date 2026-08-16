---
name: stoic-reflect
description: Start a Stoic Stack reflection on the work in progress — the developer's own to invoke, never the model's.
disable-model-invocation: true
---

# Stoic Stack reflection

One short moment on the work **still in progress**, asked for rather than
interrupted, and then the turn ends. You **own the conversation**; the two CLIs
**own every consequence** — `reflect.js` alone decides what this pause is about,
and `record.js` alone writes a decision, a mute, or engine state. The single
file you write is `pause-answer.json`, and only to carry your questions and the
developer's own words to that recorder.

**Offering options.** Each choice below is an `AskUserQuestion` call. When that
tool is unavailable or the developer declines it, put the same options in one
plain numbered message and read the answer from their next message. The choice
is the contract; the tool is its nicer form.

## 1. Open the pause

Run:

    node "$CLAUDE_PLUGIN_ROOT/src/cli/reflect.js"

Parse the single JSON line on stdout. On `ok: false`, say one short line naming
`error.message` and end the turn.

On `ok: true`, `material` is the branch the next step takes: `found` when the
working tree carries changed files, `clean` when it does not. The document just
written is named on stderr, in the line `manual pause: <absolute path>` — hold
that path; step 6 needs it, and `pause-answer.json` belongs in the same
directory.

Read the document for `group.edits`, `pause_mode`, `max_questions`,
`followup_draft`, and `record_cmd`. It carries no `classification`, no `score`,
and no `threshold`: nothing gated this pause, so nothing measured it.

Done when you hold the parsed result, the document, and its path — or the turn
has ended.

## 2. Gather the material

**Send a subagent to read the code.** You are running inside the developer's own
conversation, and every file opened here stays in their context for the rest of
the session. Dispatch one subagent on the latest Sonnet — the project's default
tier for research — and let it do the reading:

> Read these files: `<the paths in group.edits>`. For each, report the concrete
> facts of what changed and what surrounds it — names, shapes, branches,
> dependencies, and any immediate import the decision reaches across. Report facts only.

The facts come back; the files stay out.

**On `clean`,** there is no file list — the tree is committed, or the project is
not under git. Ask the developer in one short question what they want to reflect
on, then send the subagent to find what they named and report facts the same way.

Those found files stay out of the document. `edits` means "files I changed", and
a subagent's reading list is not that. The developer's focus reaches the decision
bank through the questions and their answer, which `pause-answer.json` already
carries.

Done when you hold a report of concrete facts.

## 3. Write the questions

Each question stands on a **concrete** fact from that report: a name, a shape, a
branch, a dependency. Ask one for a contained decision, up to `max_questions`
for one that reshapes something. Fewer, sharper questions beat filling the
quota.

Phrase them about work **in progress** — a decision that can still change, not
one that has already landed. A question naming `applyDiscount` or the nullable
`customer_id` column is the target; a question that would fit any codebase is a
draft to rewrite.

There is no category here and so no angle to sharpen to. A real diff, read
closely, is richer material than a one-word label — build the questions straight
from it.

Done when every question names a fact from the report.

## 4. Collect the reflection

Deliver all questions **batched in one message**, and collect one answer
exchange. Two shapes, by `pause_mode`:

- `hybrid` and `freeform` — the questions as a short numbered list, answered in
  writing.
- `choices` — one `AskUserQuestion` carrying every question, each with 2–4
  options drawn from the code the subagent read (real alternatives the decision
  still has, phrased in the developer's nouns), alongside the free-text escape
  the tool already offers.

Done when the developer has answered, in whatever form.

## 5. Read the outcome

The answer resolves to one of two:

- **keep** — the decision stands as made.
- **correct** — the answer names something to change.

Those two are the whole vocabulary. A developer who asked for this is not
answering "not now", so neither Skip nor Defer is offered here. Ask a single
Keep-or-Correct `AskUserQuestion` when the answer genuinely could be either. An
answer that plainly reads one way is already the outcome.

On `correct` with `followup_draft` enabled, draft one follow-up prompt:
concrete, imperative, one job, phrased so the developer can edit it and send it.
Present it as text for them to send.

Done when you hold `keep` or `correct`.

## 6. Record it

Write `pause-answer.json` in the same directory as the manual pause document:

```json
{
  "questions": ["the questions you actually asked"],
  "answer": "the developer's reflection, verbatim",
  "correction": "what they said to change — on correct",
  "followup_prompt": "the drafted prompt — when one was drafted"
}
```

Then pass its path via `--data`. Everything else in the recorded entry — the
files, the trigger — `record.js` reads from the pause document, so your file
carries only the conversation.

Worked examples — match the shape, not the values. Take the command from the
document's own `record_cmd` field and the pause path from the `manual pause:`
line of step 1. In the paths below, `me` stands for the developer's home-folder
name and `my-project` for their project slug; both are stand-ins for whatever
the real path holds:

    # The decision stands — the answer file carries the reflection
    node "C:/plugins/stoic-stack/src/cli/record.js" --outcome keep --pause "C:/Users/me/.claude/stoic-stack/my-project/stoic-manual-pause.json" --data "C:/Users/me/.claude/stoic-stack/my-project/pause-answer.json"

    # The developer wants a change, and approved the drafted follow-up
    node "C:/plugins/stoic-stack/src/cli/record.js" --outcome correct --pause "C:/Users/me/.claude/stoic-stack/my-project/stoic-manual-pause.json" --data "C:/Users/me/.claude/stoic-stack/my-project/pause-answer.json"

Parse the single JSON line. On `ok: true`, relay every entry of `notices`
verbatim — they are the engine speaking to the developer. On `ok: false`, show
`error.message` as one concise line; `record.js` stays the only writer, so an
unrecorded reflection simply waits.

Done when the CLI has returned, its notices are relayed, and the turn has ended.

## Tone

Stoic, calm, curious, brief. This moment was asked for, not imposed, so it owes
the developer no justification for existing — get to the questions quickly.
Close with one short line and stop.
