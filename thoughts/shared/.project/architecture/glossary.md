---
version: 0.2.0
last_update: 2026-09-29
created_at: 2026-07-11
---

# Glossary — Stoic Stack

> Companion to [../architecture.md](../architecture.md). The ubiquitous
> language of the plugin: code, documentation, skills, and prompts use these
> words with exactly these meanings, and a term that appears here is never
> paraphrased elsewhere. Where a term has a literal in code, the literal is
> named once here as the link between the word and the identifier; its schema
> lives in [payloads.md](payloads.md). When a term here and a document
> elsewhere disagree, this file wins and the other document is corrected.

## Autopilot

The state the plugin exists to detect: the developer has stopped thinking
about the work — short prompts without ideas, plans, or constraints, while
changes keep landing. Autopilot is a property of the developer's input, not
of the machine's output; a deliberate, planned fan-out to parallel agents is
not autopilot by itself.

## Project Root

The directory that gives a project its one identity: the project's shared
configuration lives under it and the developer's personal engine state is
keyed on it. It is found by resolution through five gates, the first that
names a directory winning: the enclosing Git working tree; the nearest
project configuration above the working directory, searched below the home
directory; the project directory Claude Code reports (`CLAUDE_PROJECT_DIR`);
the directory the hook payload reports (`cwd`); and last the process working
directory. A session that starts in a subdirectory, or moves into one,
therefore keeps the same Project Root. When every gate is empty there is no
Project Root: the engine stays silent and leaves one trace line
(`no_project_root`).

## Stoic Pause

A short reflection moment in the main conversation, arriving either way
round: the engine surfaces one when it decides the developer is drifting into
autopilot, or the developer asks for one directly — a manual reflection. An
engine pause offers Reflect, Skip, and Defer; a manual reflection offers only
Keep and Correct, since a developer who asked for it has already declined to
skip or defer.

## Turn

One prompt-to-Stop cycle in a Claude Code session. The turn boundary is the
`Stop` hook — the single point where scoring and pause decisions happen.

## Turn Group

The summary of one turn assembled at its boundary: the prompt, the edits
(files, line counts, delegation attribution), and sub-agent lifecycle events.

## Score

The running measure of autopilot drift. It decays over time, rises with each
turn's signals, and drops when the developer asks genuine questions. Crossing
its threshold makes the turn a pause candidate. Relief arrives in three ways.
When an engine pause fires, the score is capped at a fraction of the
threshold (`cooldown_ratio`), so one loud turn cannot fire twice; a cap never
raises a score. When a classifier veto cools the turn — every veto except
`bad_category`, on the headless Haiku path as well as Jev — the score is
capped at `VETO_COOLDOWN_RATIO` times the threshold. When a manual reflection
is completed with Keep or Correct, the fire cap applies and the result is
reduced further by the manual relief factor, outside any scored turn; a
manual reflection that ends in Skip or Defer relieves nothing.

## Prompt Effort

A heuristic for how much thinking a prompt shows — constraints, plans, paths,
structure. It is the primary autopilot signal: low effort raises the score.

## Trigger

Why a pause candidate fired: the score crossed its threshold (`score`, the
soft gate), a critical path was touched (`critical_path`, the hard gate), or
the developer asked for a manual reflection (`manual`).

## Critical Path

A configured path keyword whose touch hard-triggers a pause candidate,
bypassing the score. Reserved for files where an unnoticed decision hurts most.

## Classifier (Veto Gate)

A cheap model call made only when a gate fires. It labels the turn with a
decision subcategory and vetoes the pause for one of four reasons, checked in
this order: the call failed or returned no usable verdict
(`no_classification`), no real decision was found (`no_decision`,
`decision_found` false), confidence is below the threshold
(`low_confidence`), or the label falls outside the enabled vocabulary — an
unknown, pruned, or disabled area (`bad_category`).

## Outcome

What the developer did with a pause: kept the decision (`keep`), corrected it
(`correct`), skipped it for now (`skip`), or deferred it for later (`defer`).
The vocabulary is the choice menu the developer picks from.

## Decision

A kept or corrected reflection, persisted to the decision bank.

## Decision Bank

The per-day, per-branch record of decisions inside the project — the durable
trace of what was decided and why.

## Fingerprint Mute

After a pause, the same category and touched-files combination is muted for a
window, so one decision is not re-litigated turn after turn.

## Category Mute

After three consecutive skips in a category, the whole category is muted for
a longer window — the developer has said "not this topic right now."

## Preset

A named sensitivity bundle mapping to scoring knobs: calm (rare pauses),
balanced, vigilant (frequent). The team default is shared; a personal choice
overrides it.
