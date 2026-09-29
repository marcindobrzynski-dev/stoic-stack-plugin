---
trigger: manual
version: 0.1.0
created_at: 2026-09-19
updated_at: 2026-09-29
---

# Collaboration Rules

The invariant this file protects: **nothing reaches `develop` without the lead's
personal review.** The two working modes below are two ways of honouring it —
one where the lead is in the room, one where the pull request stands in for him.

## Which mode am I in?

- **Interactive** — a human (the lead) is present in the session and answering.
- **Autonomous** — no human in the loop: a cloud agent, an agent started from a
  GitHub issue, feature, quick win, a scheduled or background run.
- **When in doubt**: if nobody can answer a question within this session, you
  are autonomous.

## Common to both modes

- Never add a `Co-Authored-By` trailer or any AI-attribution footer to a commit
  message or a pull request body.
- The lead makes the architectural decisions. Recommend, ask, and educate;
  never decide for him.
- Never apply the findings of any review — human or automated — without the
  lead's explicit approval.
- TDD is mandatory, and nothing is "done" until it has been run. Both are
  defined in `.agents/rules/testing-rules.md`: TDD is its T1 cycle, "done" is
  its "Done means run" section.

## Interactive mode

- Leave work uncommitted until the lead has personally reviewed it, even when a
  skill or workflow says to commit.
- Implement step by step — one test, one function, one comment at a time —
  pausing for the lead between steps on anything non-trivial. Trivial changes
  do not need a pause.

## Autonomous mode

- Work on a `feature/*` branch created from `develop`. Branch naming and commit
  format are in `.agents/rules/git-rules.md`.
- Commit in small, logical commits. The pull request against `develop` is the
  review point, so it is where the lead's review happens.
- Never merge your own pull request. Never push to `develop` or `main`
  directly.
- When a decision would normally require asking the lead — architecture,
  contracts, scope — do not guess silently: take the most conservative option,
  then record both the question and the choice you made prominently in the PR
  description so the lead can overturn it.
- Write the PR description for a reader with no context: open with a recap of
  what was done and why, name the project, branch, and PR, use plain language
  with no invented names, and end with the single thing waiting on the lead. He juggles many sessions and
  remembers none of this one.
