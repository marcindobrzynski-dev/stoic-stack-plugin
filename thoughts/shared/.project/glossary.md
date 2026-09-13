# Glossary — Stoic Stack

## Overview

The ubiquitous language of the Stoic Stack plugin. Every term below is
canonical: code, documentation, skills, and prompts use these words with
exactly these meanings, and a term that appears here is never paraphrased
elsewhere. The glossary describes the domain only — it holds no
implementation detail, no file layout, and no configuration knob. When a term
here and a document elsewhere disagree, this file wins and the other document
is corrected.

## Autopilot

The state the plugin exists to detect: the developer has stopped thinking
about the work — short prompts without ideas, plans, or constraints, while
changes keep landing. Autopilot is a property of the developer's input, not
of the machine's output; a deliberate, planned fan-out to parallel agents is
not autopilot by itself.

## Project Root

The directory that gives a project its one identity: the project's shared
configuration lives under it and the developer's personal engine state is
keyed on it. It is found by resolution, not taken from wherever the session
happens to be: the enclosing Git working tree wins, then the nearest project
configuration above the working directory, and only when neither names a
boundary does the working directory itself stand in as the root. A session
that starts in a subdirectory, or moves into one, therefore keeps the same
Project Root.

## Stoic Pause

A short reflection moment in the main conversation, arriving either way
round: the engine surfaces one when it decides the developer is drifting into
autopilot, or the developer requests one directly. An engine pause offers
Reflect, Skip, and Defer; a requested pause offers only Keep and Correct.

## Turn

One prompt-to-Stop cycle in a Claude Code session. The turn boundary is the
single point where scoring and pause decisions happen.

## Turn Group

The summary of one turn assembled at its boundary: the prompt, the edits
(files, line counts, delegation attribution), and sub-agent lifecycle events.

## Score

The running measure of autopilot drift. It decays over time, rises with each
turn's signals, drops when the developer asks genuine questions, and is
relieved by a completed requested pause.

## Prompt Effort

A heuristic for how much thinking a prompt shows — constraints, plans, paths,
structure. It is the primary autopilot signal: low effort raises the score.

## Trigger

Why a pause candidate fired: the score crossed its threshold, a critical path
was touched, or the developer asked for a reflection.

## Critical Path

A configured path keyword whose touch hard-triggers a pause candidate,
bypassing the score. Reserved for files where an unnoticed decision hurts most.

## Classifier (Veto Gate)

A cheap model call made only when a gate fires. It labels the turn with a
decision subcategory and vetoes the pause when no real decision was found,
confidence is low, or the area is disabled.

## Outcome

What the developer did with a pause: kept the decision, corrected it, skipped
it for now, or deferred it for later.

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

A named sensitivity bundle: calm (rare pauses), balanced, vigilant (frequent).
The team default is shared; a personal choice overrides it.
