# AGENTS.md - Stoic Stack Plugin

Shared operating context for AI agents (Claude, Codex, Cursor, Antigravity). Read this first, then load the deeper docs it points to. CLAUDE.md imports this file.

## What this is

Stoic Stack is a local Claude Code plugin that helps developers notice when
they are drifting into autopilot during AI-assisted work. It observes session
activity through Claude Code hooks, calculates an autopilot score, and can
surface a short Socratic reflection before work continues.

The PoC targets individual, mid-level developers. It is local-only, has no
server or telemetry, and is intended for distribution through the Claude Code
plugin marketplace. The project uses JavaScript, ESM, and Node.js built-ins;
plugin runtime code has zero runtime dependencies and no build step.

## Where the truth lives (read before deciding)

Read the relevant source before planning or changing behavior. When documents
conflict, use this precedence:

1. `thoughts/shared/.project/architecture.md` - binding PoC architecture,
   dependency boundaries, data flow, component map, and testing strategy.
2. The approved companion documents under
   `thoughts/shared/.project/architecture/` - domain language, configuration,
   payload contracts, and deliberate trade-offs.
3. `thoughts/shared/.project/project-idea.md` - product goal, audience, scope,
   exclusions, and success criteria.
4. `thoughts/shared/.project/tech-stack.md` and `package.json` - intended stack
   and currently installed tooling. Verify both before changing tooling.
5. The implementation under `src/` and its tests under `test/` - evidence of
   what currently works, but not permission to silently depart from the binding
   architecture.

Architectural changes must update the approved architecture documentation
before, or in the same change as, the implementation. Changes to load-bearing
payload, pause-delivery, or CLI contracts must also update their integration
tests.

Do not apply inherited guidance for Astro, Preact, Tailwind, Zod, UI component
architecture, or other stacks not listed in
`thoughts/shared/.project/tech-stack.md`. If generic material under `.agents/`
conflicts with this file or the approved project documents, the project
documents win.

## Current state

The PoC is under active implementation. The product and architecture are
approved, and every component of the loop now exists - observation, scoring,
the fired pause, the conversation that delivers it, and the recorded outcome.
The automated full-loop suite (`test/hooks/full-loop.test.js`) chains the
real Stop hook, the real `record.js`, and the next Stop as child processes
for every Outcome, the fire-time cooldown, and the three-skip category mute.
What has not been run yet is the live Claude Code acceptance check of the
interactive `stoic-pause` skill - that half is manual, not automatable, and
still waits on a scratch-project session.

Built and tested:

- `src/io/` - path resolution, fail-safe JSON and atomic text documents, the
  canonical configuration model, personal engine state, the per-session event
  log, the bounded trace sink, and the decision bank (`bank.js`: per-day,
  per-branch markdown entries under `<project>/.stoic/decisions/` in the
  frozen `payloads.md` entry format, unconditional `.stoic/.gitignore`
  privacy enforcement before every write, never-throwing branch resolution
  with `detached` and `no-branch` fallbacks, and a never-throwing aggregate
  reader keyed on top-level categories for the future status surface;
  `record.js` is its only writer-side caller).
- `src/cli/record.js` - the outcome-recording CLI, the single writer of pause
  Outcomes (`--outcome keep|correct|skip|defer`, `--pause` always, `--data`
  for `keep`/`correct`): decision-bank entries joined deterministically from
  the pause document and the answer file, fingerprint mutes on every
  categorized outcome, skip streaks with the three-consecutive-skips category
  mute and its notice, deletion of the consumed pause and answer documents,
  one JSON result on stdout, and — proven by test — no score access under any
  outcome. Covered by the pause-delivery-contract part 3 and 3b integration
  suite (`test/cli/record.test.js`) driving the real CLI as a child process.
  Its only caller is the `stoic-pause` skill.
- `src/core/` - shared validation predicates, pure prompt signals (effort,
  harness injection, genuine question, own-plugin prompts), diff-stat
  extraction from tool payloads, turn-group assembly from session events,
  scoring (half-life decay, turn delta, floor at zero), and the fire path's
  pure decision core (`gates.js`: critical-path keyword matching, mute
  evaluation against the frozen `{ category, files, expires_at }` shape, and
  expired-mute pruning — no I/O, no clock, never throws; the Stop hook's
  fire path is its caller).
- `src/cli/setup.js` and `skills/stoic-setup/SKILL.md` - the guided
  four-question setup and safe reconfiguration path.
- `src/hooks/` and `hooks/hooks.json` - the four append-only capture hooks
  (prompt, edit, sub-agent start and stop), their shared fail-silent frame,
  the leaf holding the stdin and trace-error chores both frames share, and
  the `Stop` hook (the only one with a timeout), all registered with
  Claude Code. Each turn boundary now consumes the session log, scores the
  turn group with decay plus delta, prunes expired mutes, and persists
  `state.json` atomically before it gates; continuation Stops truncate without
  scoring and count what they drop.
- `src/hooks/stop-decision.js` - the fire path's pure decision, lifted out of
  the self-executing hook so it can be called directly: hard gate
  (`critical_path`, which wins when both apply), soft gate (`score`), the
  classifier veto in frozen reason order, the mute check after classification,
  and the one fire-time cooldown - the score capped at
  `threshold * cooldown_ratio`, a cap that never raises a score. No I/O, no
  stdout, no clock; it never throws, and every degradation errs toward silence.
- The Stop hook's fire path itself - orchestration and I/O only: save state
  before gating, then on a fire persist the cooled score, write
  `stoic-pending-pause.json` (the full frozen part-1 schema, `plugin_root`
  derived from `import.meta.url`), and print exactly one
  `{"decision":"block","reason":...}` on stdout naming the
  `stoic-stack:stoic-pause` skill, the absolute pause path, and the
  end-the-turn instruction. One trace line per invocation, now also
  `veto` / `muted` / `fired`. Tested at the two levels the testing strategy
  prescribes: in-process over the decision's combinatorial surface
  (`test/hooks/stop-decision.test.js`) and as a real child process for the
  pause-delivery-contract parts 1 and 2 (`test/hooks/stop-fire.test.js`),
  where the child's `PATH` is rebuilt around a shim so the only reachable
  `claude` is `test/fixtures/stub-claude-cli.js`. The full-loop suite
  (`test/hooks/full-loop.test.js`) then chains those same real processes
  through `record.js` and the next Stop for every Outcome, the fire-time
  cooldown, and the three-skip category mute.
- `skills/stoic-pause/SKILL.md` - the pause conversation, and the only skill
  both the model and the user may invoke: the Stop block fires it, and a
  developer may type it to finish a pause that was interrupted, since the
  pending document outlives the turn and nothing else consumes it. Typing it
  never creates a pause - with none pending it says one line and ends the turn.
  It runs the cascade (read the pause, Reflect / Skip / Defer gate, decision-
  specific questions from a Sonnet subagent's report so the files stay out of
  the developer's context, batched in one message, the pause-mode variants) and
  reports every Outcome by shelling to `record.js`. It writes one file,
  `pause-answer.json`, and never engine state. Deliberately untested: it is
  prose for the model, so nothing mechanically holds its wording to
  `blockReason()` in `src/hooks/stop.js` - re-check that pairing by hand
  whenever either side changes.

Also built and tested - the headless classifier veto, all three tasks done:

- `src/io/headless.js` - the fail-safe headless `claude -p` runner. Prompt over
  stdin, fixed flags only on the command line, the Windows
  `claude` -> `claude.cmd` -> `shell: true` cascade, a 45s timeout, a 10 MiB
  output cap, `STOIC_INTERNAL=1` in the child environment, and balanced-JSON
  extraction from the CLI envelope. Every failure returns a clean unavailable
  result; it never throws. Tested against a stub executable
  (`test/fixtures/stub-claude-cli.js`) through a programmatic spawn seam - there
  are deliberately no env-var test seams.
- `src/io/classifier.js` - the two pure halves of the classifier —
  `buildClassificationPrompt` (turn-group summary plus the enabled subcategory
  vocabulary, inputs capped) and `validateClassification` (the `payloads.md`
  verdict contract, confidence clamped, subcategory resolved to its enabled
  category, raw emitted name preserved) — plus `classify`, the fail-safe seam
  joining them to the runner. It vetoes a group that is not a plain object,
  runs the configured `classifier_model` through an injectable runner whose
  production default is the real headless module, and evaluates the four veto
  reasons in contract order (`no_classification`, `no_decision`,
  `low_confidence`, `bad_category`), returning data rather than control flow;
  a confidence exactly at `classifier_confidence_threshold` passes, and any
  internal failure is the `no_classification` veto, never an exception.
  The Stop hook's fire path is its caller.

Not yet run: the live Claude Code acceptance check (task 06 checkboxes
6-7). The automated loop-level suite is in place; the interactive skill
half still needs a scratch-project session.

Work is organized as one open feature workspace under
`thoughts/shared/features/` - pause delivery and recording (all six
implementation tasks sit in `tasks/done/`; the live Claude Code check is
still unchecked). The three completed features - plugin setup, the
observation-and-scoring engine, and the headless classifier veto - sit under
`features/history/`. Note that feature workspaces are gitignored local
planning artifacts, so their task files move between `tasks/to-do/` and
`tasks/done/` without appearing in any commit.

Numeric scoring defaults remain intentionally uncalibrated and must be treated
as placeholders; tests reference them through their named exports so
recalibration does not rewrite the suite.

## Context re-entry (multi-project juggling)

I am juggling several projects, each with several concurrent sessions, and have usually lost
the thread by the time I return to any one of them. Write every user-facing message for cold
re-entry — assume I remember nothing from the scrollback:

- **Open with a recap.** Before any summary, decision point, or question: 2–3 plain sentences on
  what we were just working on, why, and where it stands now.
- **Plain language.** No invented codenames, abbreviations, or callbacks like "the earlier fix"
  or "option B from before" — restate the thing in place, every time.
- **Self-contained questions.** When asking me to decide something, the question itself
  must carry everything needed to answer it: the background, the options, the tradeoffs, and
  your recommendation. Never require scrolling back.
- **One question at a time.** When a summary or decision point holds several open questions or
  next steps, say so up front ("three decisions are waiting; here's the first"), then present
  only the first and wait for the answer before raising the next. Never dump them all at once —
  it's too much mental load.
- **Anchor the work.** Name the project, branch, and PR when reporting status — several other
  sessions look just like this one.
- **End with the next action.** Close long updates with the single thing waiting on me,
  or say explicitly that nothing is.

## TDD is mandatory

Every change follows **failing test first → implement → verify**:

1. Write the test(s) that capture the desired behavior and watch them **fail** (red).
2. Implement the minimum to make them pass.
3. Run the suite and confirm green.

Don't write implementation before a failing test exists. When fixing a bug, reproduce it with a
failing test first.

## Verify before claiming "done"

Never report something as working without running it. "Done" means: relevant tests green, lint
and formatting clean, and — for user-facing flows — exercised end to end. If tests fail or a
step was skipped, say so plainly with the output.

Run the checks relevant to the files changed: `npm test` (`node --test`, no watch mode),
`npm run lint`, and `npm run format:check`.

## Agent skills

The `.agents/` directory is the persistent operating library shared by coding
agents. Read `.agents/README.md` to understand its layout and how rules,
memory, and skills relate.

- Load the relevant file under `.agents/rules/` before work in that area.
- Use `.agents/memory/conventions.md` for established conventions,
  `.agents/memory/decisions.md` for active decisions, and
  `.agents/memory/anti-patterns.md` for patterns to avoid.
- Load skills from `.agents/skills/` when the task or skill trigger calls for
  them.

Rules and conventions are subordinate to the project-specific sources listed
under Where the truth lives. Apply only guidance that matches this repository's
actual stack and current phase.

Implementation may start from either an existing feature workspace under
`thoughts/shared/features/`, following its `README.md`, or a prepared GitHub
issue containing enough context to implement safely.

Agents must not invent a feature workspace or speculative scope. Create a new
feature folder only when the user explicitly asks. For an existing feature or
prepared issue, agents may implement directly from the approved PoC documents
without requiring an additional planning artifact.

### Issue tracker

Issues are tracked in GitHub Issues (marcindobrzynski-dev/stoic-stack-plugin) via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default label vocabulary: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix. See `docs/agents/triage-labels.md`.

### Domain docs

The approved domain glossary is
`thoughts/shared/.project/architecture/2026-07-11_CONTEXT.md`. Architecture
companions and decisions currently live beside it under
`thoughts/shared/.project/architecture/`. The root `CONTEXT.md` and `docs/adr/`
layout described in `docs/agents/domain.md` has not been adopted for this
project.
