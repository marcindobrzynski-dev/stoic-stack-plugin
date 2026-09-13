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
approved, and every component of both loops now exists - observation, scoring,
the fired pause, the reflection a developer asks for, the conversations that
deliver them, and the recorded outcome. Two automated loop suites live under
`test/loop/` and chain real processes rather than modules: `automatic.test.js`
chains the real Stop hook, the real `record.js`, and the next Stop as child
processes for every Outcome, the fire-time cooldown, and the three-skip
category mute; `manual.test.js` chains the real `reflect.js` writer and the
real `record.js` over a real temporary git repository for every manual
outcome, the score reward and the two outcomes that earn none, coexistence
with a pending automatic pause, a clean tree, and a disabled plugin. What has
not been fully run is the live Claude Code acceptance check of the interactive
skills - that half is manual, not automatable.

Every entrypoint now derives configuration and personal state from the
**Project Root** (`thoughts/shared/.project/glossary.md`), resolved by
`src/io/project-root.js` rather than assumed to be the directory the session
started in: `resolveProjectRoot(startDir, payloadCwd)` tries the git
working-tree root, then the nearest `.stoic/config.json` above, then
`CLAUDE_PROJECT_DIR`, then the payload's `cwd`, then `process.cwd()`, and
returns `null` only when every gate is empty. The capture hooks, the Stop
hook, `setup.js`, and the default `reflect.js` path resolve through it; an
explicit `reflect.js --project` bypasses it; `record.js` is unchanged and
keeps reading `pause.cwd`, which both pause writers fill with the resolved
root. A `null` root is one `no_project_root` line in the shared trace; the
CLIs add one stderr sentence and their usual `ok: false` JSON. That branch is
unreachable from a child process and is guarded by review, not by a test. The
resolver is tested in `test/io/project-root/`: `project-root.test.js` (three
unit tests over real git and real directories: gate 1, gate 2, precedence)
and `entrypoints.test.js` (one real entrypoint per test: a Stop started in a
subfolder, a session moving into one, a worktree, a submodule, setup and
reflect from a subfolder), with `addSubdirectory`, `addWorktree`, and
`addSubmodule` in `test/helpers/git-repo.js`. `test/helpers/sandbox.js`
withholds `CLAUDE_PROJECT_DIR` from child processes so a suite run inside a
Claude Code session cannot resolve to the real repository. The temporary path
diagnostics (`src/io/debug.js`) are gone, archived under `thoughts/private/`.

Built and tested:

- `src/io/` - path resolution (`paths.js`, now including `manualPausePath` for
  the second pause document, `stoic-manual-pause.json`, beside the automatic
  `pendingPausePath`), fail-safe JSON and atomic text documents, the canonical
  configuration model (moved to `src/io/config/config.js`, tested at
  `test/io/config/config.test.js`), personal engine state, the per-session
  event log, the bounded trace sinks (`local-trace.jsonl` per project,
  `shared-trace.jsonl` above every project), and the decision bank (`bank.js`: per-day,
  per-branch markdown entries under `<project>/.stoic/decisions/` in the
  frozen `payloads.md` entry format, unconditional `.stoic/.gitignore`
  privacy enforcement before every write, never-throwing branch resolution
  with `detached` and `no-branch` fallbacks, and a never-throwing aggregate
  reader keyed on top-level categories for the future status surface;
  `record.js` is its only writer-side caller).
- `src/io/git-diff.js` - the working-tree reader behind a manual reflection:
  one frozen `git --no-pager diff --numstat -z --find-renames HEAD --`
  invocation with a 10s timeout and an 8 MiB output ceiling, NUL-grammar
  parsing that handles renames and non-ASCII paths, and failure as emptiness —
  no repository, no commits, no git on PATH, unreadable output all read as a
  clean tree. Never throws; git is substituted through an `options.spawn` seam,
  never an environment variable.
- `src/io/config/manual-reflection.js` - the small settings resolution the
  manual path consumes and nothing more (`pause_mode`, `max_questions`,
  `followup_draft`, `threshold`, `cooldown_ratio`, `manual_relief_factor`),
  delegating to `config.js` so presets and `advanced` overrides behave
  identically. It also holds `MANUAL_RELIEF_FACTOR`, deliberately not a knob:
  registering it would make `config.js` import this module while this one
  imports that, a cycle, and the value describes the mechanism rather than a
  sensitivity setting. Covered by `test/io/config/manual-reflection.test.js`.
- `src/cli/reflect.js` - the manual pause writer, and the only producer of
  `stoic-manual-pause.json`: it measures `git diff HEAD` rather than a session,
  writes the shared pause schema with `trigger: "manual"` and with score,
  threshold, and classification absent, leaves any pending automatic pause
  byte-for-byte alone, saves no engine state, gives no reward (that belongs to
  the recorder, on completion), and ignores `enabled`, which gates the engine's
  initiative rather than the developer. One JSON result on stdout with `ok` and
  `material`; one contractual stderr line, `manual pause: <absolute path>`,
  which the reflect skill passes on to `record.js`. Exit 0 / 2 / 1. Covered by
  `test/cli/reflect.test.js` driving the real CLI as a child process.
- `src/cli/record.js` - the outcome-recording CLI, the single writer of pause
  Outcomes (`--outcome keep|correct|skip|defer`, `--pause` either pause
  document, `--data` for `keep`/`correct`): decision-bank entries joined
  deterministically from the pause document and the answer file, fingerprint
  mutes on every categorized outcome, skip streaks with the
  three-consecutive-skips category mute and its notice, deletion of the
  consumed pause and answer documents, and one JSON result on stdout. It is
  also the score's SECOND writer, in exactly one case: a `keep` or `correct`
  on a manual document applies `rewardedScore` from `src/core/scoring.js`.
  Under every automatic-trigger outcome, and under `skip`/`defer` on a manual
  one, the score is not read at all — state is loaded, its mutes and skip
  history are moved, and the same object is saved back. Both halves are proven
  in `test/cli/record.test.js`'s score section ("The score — the recorder's one
  write, and everywhere it must not happen"), which drives the real CLI as a
  child process alongside the pause-delivery-contract part 3 and 3b coverage,
  and again end to end in `test/loop/manual.test.js`. Its callers are the
  `stoic-pause` and `stoic-reflect` skills.
- `src/core/` - shared validation predicates, pure prompt signals (effort,
  harness injection, genuine question, own-plugin prompts), diff-stat
  extraction from tool payloads, turn-group assembly from session events,
  scoring (half-life decay, turn delta, floor at zero) together with the two
  relief functions the score's two writers share — `relievedScore`, the
  fire-time cap the Stop hook applies, and `rewardedScore`, which composes that
  same cap with `manual_relief_factor` for a completed manual reflection, so
  the arithmetic of relief exists once and neither writer can drift — and the
  fire path's
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
  `claude` is `test/fixtures/stub-claude-cli.js`. The automatic loop suite
  (`test/loop/automatic.test.js`) then chains those same real processes
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
- `skills/stoic-reflect/SKILL.md` - the manual reflection conversation, and the
  only skill the model may not invoke (`disable-model-invocation: true`): the
  premise of the score relief is that the developer chose to reflect, so a
  model-triggered invocation would counterfeit exactly that, and a reflection's
  own turn boundary can never prompt another. It runs `reflect.js`, branches on
  `material` (a Sonnet subagent reads the changed files, or - on a clean tree -
  searches for whatever focus the developer names), asks questions in the
  in-progress tense, resolves to `keep` or `correct` only, and shells to
  `record.js` with the manual document's path. Deliberately untested, on the
  same grounds as the pause skill.
- `test/loop/` - the two loop suites. They sit outside the mirror of `src/`
  because a loop suite has no module under test: it tests a composition, a hook
  and two CLIs chained as separate processes, each step consuming the path the
  previous step actually produced. `automatic.test.js` (the former
  `test/hooks/full-loop.test.js`, moved unchanged) chains Stop, `record.js`,
  and the next Stop. `manual.test.js` chains `reflect.js` and `record.js` over
  a real temporary git repository: `keep` and `correct` reaching the bank with
  the reward applied, `skip` and `defer` earning nothing — the anti-gaming
  guarantee asserted rather than implied — mutes and skip tables untouched by a
  categoryless manual entry, a pending automatic pause left byte-for-byte
  intact and still completable, a clean tree, and a disabled plugin. Every
  number comes from a named export, never a literal.

There are now two hand-checked prose/code pairings, both unenforced by any test:
`skills/stoic-pause/SKILL.md` against `blockReason()` in `src/hooks/stop.js`,
and `skills/stoic-reflect/SKILL.md` against the `reflect.js` result contract -
its `ok`, `material`, and the contractual `manual pause: <path>` stderr line -
plus the `record.js` flags both skills invoke. Changing either CLI means
re-reading the skill that calls it.

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

Live Claude Code acceptance checks - the half that is manual, not automatable -
are both partial passes. The `stoic-pause` skill's check is recorded in the
pause-delivery feature's task 06 (2026-08-15), checkboxes 6-7 still unchecked.
The `stoic-reflect` skill's check is recorded in the manual-reflection
feature's task 04 (2026-08-16): `correct` on a dirty tree, the score drop, the
bank entry, and model-cannot-invoke all passed live; clean-tree focus and
coexistence with a waiting automatic pause were not run live - the developer
deferred the automatic-pause scenario. Both of those unrun scenarios are
covered automatically in `test/loop/manual.test.js`, which is not the same
thing as a live session and should not be read as one.

There is currently no open feature workspace under `thoughts/shared/features/`.
Five completed features sit under `features/history/`: plugin setup, the
observation-and-scoring engine, the headless classifier veto, pause delivery
and recording, and manual Stoic reflection (closed 2026-08-16, all five tasks
in `tasks/done/`). Note that feature workspaces are gitignored local planning
artifacts, so their task files move between `tasks/to-do/` and `tasks/done/`
without appearing in any commit.

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
`thoughts/shared/.project/architecture/2026-07-11_CONTEXT.md`, with the terms
defined since (currently Project Root) in
`thoughts/shared/.project/glossary.md`, which wins on conflict. Architecture
companions and decisions currently live beside the older file under
`thoughts/shared/.project/architecture/`. The root `CONTEXT.md` and `docs/adr/`
layout described in `docs/agents/domain.md` has not been adopted for this
project.
