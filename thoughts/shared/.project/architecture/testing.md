---
version: 0.1.0
last_update: 2026-10-25
created_at: 2026-09-29
---

# Testing strategy

> Companion to [../architecture.md](../architecture.md). The three tiers under
> `test/`, the two seams that keep the classifier off the network, and the
> sandbox every child process runs in. Rules for writing an individual test
> are in `.agents/rules/testing-rules.md`.

`node:test` (built-in runner, zero extra dependencies), run via `npm test`.
The first two tiers mirror `src/` one directory for one, each file holding a
single module under test; the third deliberately does not.

## Unit

The Domain layer (`src/core/*`): pure functions tested exhaustively, including
scoring edge cases and gate/mute logic.

## Integration

Real hook scripts executed as child processes against throwaway temp
projects, asserting the full pipeline moves (prompt → edit → Stop →
`state.json` → pause fired). No network: the classifier and headless runner
are faked through a programmatic spawn seam.

`src/io/headless.js` accepts an optional spawn implementation
(`options.spawn`) whose production default is the real platform cascade; tests
pass a seam that substitutes only the executable — a stub Node script under
`test/fixtures/` standing in for the Claude CLI — so the real stdin delivery,
child environment, timeout, and output cap are still exercised.
`src/io/classifier.js` carries the same seam one level up: `classify` accepts
an optional `options.runner`, defaulting to `runJev` for a `jev…` model and
to `runClaude` otherwise, so a suite that needs a fixed verdict substitutes
the whole call rather than the executable.

`test/experiments/jev/` mirrors `experiments/jev/` the same way the first two
tiers mirror `src/`. The Jev seams — `spawn`, `fallback`, and `sdk` (see
`test/io/classifier.test.js` and `test/experiments/jev/run.test.js`) — keep
those tests off the network too.

Neither seam crosses a process boundary. A hook driven as a child process
cannot be handed a runner, so the two needs — exercising the real entrypoint,
and fixing the verdict — are met at two levels rather than one:

- **In-process** — the pure decision function a hook exposes is called
  directly, with `options.runner` returning a fixed verdict. This level covers
  the combinatorial surface exhaustively (every veto reason, every mute state,
  score arithmetic) and spawns nothing.
- **Child process** — the real entrypoint runs under `createSandbox`, with the
  stub CLI placed on the child's `PATH` under the name the runner resolves
  (`claude.cmd` on Windows, matching the production cascade). Nothing in the
  production path changes; only what the operating system finds under that
  name does. This level asserts what is observable only from outside: files
  written, stdout, exit code, and state carried across two consecutive runs.

The child-process level therefore does spawn a process standing in for the
CLI. That is deliberate and bounded — see [trade-off 12](trade-offs.md) — and
carries none of the properties the no-network rule protects: no network, no
model, no cost, and a fixed answer.

No environment variable can activate any of these seams, so a test hook can
never alter a real user's session.

## Loop

`test/loop/` holds composition suites that chain real processes — the Stop
hook, `reflect.js`, `record.js` — over a real temporary project and have no
single module under test, which is why they sit outside the mirror.
`automatic.test.js` drives the engine-fired pause through every Outcome;
`manual.test.js` drives the manual reflection over a real git
repository, including its reward and its coexistence with a pending automatic
pause.

A suite belongs in `test/loop/` only when it chains two or more real processes
and each step consumes what the previous one produced. A suite that runs one
entrypoint per test, however many entrypoints it covers, is not a loop: it
lives beside the module it exercises (as
`test/io/project-root/entrypoints.test.js` does). The same rule is repeated in
`test/loop/README.md`; change both together.

## Live acceptance

The two interactive skills are prose for the model, so their acceptance is a
live Claude Code session, which no suite replaces. As of 2026-08-16 both are
partial passes. `stoic-pause` was not run through every scenario.
`stoic-reflect` passed `correct` on a dirty tree, the score drop, the bank
entry, and model-cannot-invoke; clean-tree focus and coexistence with a waiting
automatic pause have not been run live. `manual.test.js` covers both, but a
green loop suite is evidence of the processes, not of the conversation.

## Sandbox

Child processes run against an isolated temporary project and temporary home
(`HOME`/`USERPROFILE` overrides, and `CLAUDE_PROJECT_DIR` withheld so the
project root cannot resolve to the repository the suite was started from), so
suites can never touch a contributor's real project or personal state. Test
fixtures under `test/fixtures/` are inert unless the harness sets
`STOIC_TEST_SANDBOX=1` — a safety interlock, not a runtime seam.

## Contracts

The load-bearing contracts (pause delivery, `record.js` CLI, payload schemas)
each have a dedicated integration test; changing a contract without updating
its test must fail the local suite.
