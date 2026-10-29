---
version: 0.2.0
last_update: 2026-10-25
created_at: 2026-07-18
---

# Stoic Stack Plugin - Think, and don't lose your resolve

This is a proof of concept (PoC). The document states what the plugin is for
and who it serves, at a high level. How it works lives in `architecture.md`;
the terms used below are defined in `architecture/glossary.md`.

## Mission

Stoic Stack is a startup that joins Stoic practice with pragmatic programming
in the age of AI. Its mission is tools that strengthen the developer across the
whole software-engineering process, so AI amplifies their skill and judgement
rather than eroding it. This plugin is that mission's first, deliberately
narrow step; the sections below set its scope.

## Context

Long Claude Code sessions push developers into autopilot. As more decisions get
offloaded to the AI, people stop truly understanding and owning the choices being
made on their behalf. Stoic Stack is a reflection guardian: it observes the local
activity of a session, notices when a developer is drifting, and offers a moment
of reflection so they stay the author of their own decisions.

## Goal

Improve mid-level developers' judgment by turning AI-assisted work into clearer,
more deliberate decision-making. The plugin creates well-timed moments to pause,
reflect, and consciously own each significant decision instead of accepting AI
output on autopilot. Reflection arrives either way round: the engine surfaces a
pause when it detects drift, and the developer can ask for one whenever they
want to think a change through.

## Audience

Mid-level developers using Claude Code who are most exposed to AI over-reliance.
The PoC is an individual, local, single-user experience. Distribution: published
to the Claude Code plugin marketplace and an open-source GitHub repo (MIT), with
Reddit/X and social posts driving early adoption.

## Focus & positioning

A reflection guardian for Claude Code. Its edge is local behavior analysis: the
plugin reads real session activity through Claude Code hooks to time
interventions well, rather than nagging on a fixed timer. There is no server of
ours and no telemetry; state, logs, and decisions stay on the developer's
machine. The one thing that leaves it is the classifier call, which sends turn
content to the model provider the developer chose — Claude by default, with the
Jev experiment as an opt-in second provider. The tone is direct and practical,
and pause frequency is user-configurable so it fits into fast work instead of
interrupting it.

## PoC scope

- **Score engine** — an autopilot score built from session signals (prompt
  effort, edit activity, decay over time) that decides when a stoic pause
  fires. A cheap classifier call vetoes the pause when no real decision was
  made in the turn.
- **Stoic pause (automatic)** — Reflect / Skip / Defer; choosing Reflect
  surfaces direct, Socratic questions about the decision just made.
- **Manual reflection** — the developer asks for a pause on their current
  uncommitted changes and resolves it with Keep / Correct.
- **Decision bank** — kept and corrected reflections are saved as decisions in
  the project; a correction may carry a follow-up prompt to act on it.
- **Critical path** — touching a configured sensitive path hard-triggers a
  pause, bypassing the score.
- **Configuration** — presets for pause frequency, plus user-tunable pause
  mode, critical paths, decision categories, and number of questions.

## Not included in PoC

- Team / shared features (shared decision banks, multi-user, syncing).
- Adaptive or ML-based tuning of pause frequency.
- Analytics dashboard or reflection-history visualizations.
- Stoic quotes library and heavier philosophy content beyond Socratic questions.
- Creation of a user profile, along with recursive self-improvement and adaptation.

## Success metrics

- **Reception** — user feedback, interest, and reach from the marketplace
  launch, promotion, and the Reddit/social rollout, signaling the reflection
  guardian resonates with mid-level developers.
- **Scoring behavior** — session logs showing the score settling as intended
  over time across different working modes (fast iteration, careful design,
  routine edits). How these logs are collected is still to be defined.
