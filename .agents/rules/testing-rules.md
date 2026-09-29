---
trigger: manual
version: 0.1.0
created_at: 2026-09-19
updated_at: 2026-09-29
---

# Testing Rules

The invariant this file protects: **every test can fail, and only for a reason
a user would care about.** The strategy itself — three tiers, two levels, the
seams — is defined in `thoughts/shared/.project/architecture/testing.md` and is
not restated here. TDD is the T1 cycle below; what "done" means is defined
under "Done means run". T1 and T2 decide whether a test is written at all;
T3–T9 decide how.

## The suite is a PoC suite

The suite that exists today was written while the PoC was being discovered,
before T1 and T2 applied. Part of it will be removed as the PoC closes. So:

- An existing test is not evidence that a similar new test is justified, and
  its density is not a target to match. The number of tests is not a measure
  of quality.
- Deleting an existing test is the lead's decision. In interactive mode, ask;
  in autonomous mode, propose the deletion in the PR description and leave the
  test in place (`collaboration-rules.md`).

## Done means run

You MUST NOT report anything as working until it has been run. Done means: the
relevant tests green, `npm run lint` and `npm run format:check` clean, and — for
a user-facing flow — exercised end to end. When a test fails or a step was
skipped, report it plainly, with its output.

## T1 — Every test earns its place through the full cycle

Quality over quantity: a test is kept only once it has been seen to fail for
the reason it names. Every new test MUST go through this cycle, with a test run
after every step:

1. **Red** — write the test and run it. It MUST fail for the reason you
   predicted before running it — not an import error, a typo, or a missing
   file.
2. **Minimal green** — write the least code that makes it pass.
3. **Mutate** — break that implementation in one deliberate way the test must
   catch. Run: the test MUST go red. If it stays green, the test is too weak —
   return to step 1. Restore the code.
4. **Full implementation** — bring the code to the shape the task asks for.
   Run: green.
5. **Guard check** — break the finished implementation once more, targeting
   the behaviour the test names. Run: red. Restore, run: green. This proves
   the test still guards the code that actually ships, not only the minimal
   version.

- A mutation MUST be selective: only the target test (or the tests that pin the
  same behaviour) may go red. A mutation that reddens the whole suite — a
  syntax error, a broken import — proves nothing about this test.
- Every mutation MUST be recorded in one line — what was broken, which test
  went red: in the report to the lead in interactive mode, in the PR
  description in autonomous mode. A test whose mutations were never run is not
  done.
- In interactive mode the lead drives this cycle with the `/md-pair-drive`
  skill, one test per slice. The skill is the lead's own tool and is not in
  this repository; in autonomous mode run the same five steps alone.

```text
✅ Mutate: relievedScore returns the cap unconditionally
   → red: "a score already below the cap is left exactly as it stands by the
     fire-time relief"
✅ Guard check: rewardedScore ignores manual_relief_factor
   → red: "the rewarded score is the capped score scaled by the manual reward
     factor"

❌ Test written after the code, run once, green — never seen red
❌ Mutation: deleted an import → 40 tests red, the target among them
```

## T2 — Every test has a business reason

A test MUST pin behaviour a developer using the plugin would notice, or a
contract written in an approved document (`payloads.md`, `architecture.md`,
`project-idea.md`). Invented cases do not qualify.

- **Litmus test** — answer before writing the test: _which user-visible
  behaviour or which written contract breaks if this test is deleted?_ No
  answer, no test.
- The test name MUST state that behaviour in the project's domain language
  (`architecture/glossary.md`), not the mechanics of
  the code.
- A corner case is justified only when a real caller can produce it — Claude
  Code, git, the file system, or the developer. Non-ASCII paths in
  `git diff` output qualify: git produces them. An input no caller can produce
  does not.
- A branch unreachable from any real caller is guarded by review, not by a
  test — as the `no_project_root` branch is (`payloads.md` §shared-trace).
- MUST NOT write a test to raise coverage, to mirror every function, or to pin
  a case already pinned at another level unless T8 requires both levels.

```js
// ✅ test/loop/manual.test.js — a developer notices this: withdrawing a
//    reflection must not buy score relief (the anti-gaming guarantee)
test("a reflection asked for and then withdrawn earns nothing, however it is withdrawn", ...);

// ❌ no developer, no contract: pins how the code is written, not what it does
test("resolveKnobs calls defaultConfig exactly once", ...);
```

## T3 — Placement

- A test for `src/x/y.js` MUST live at `test/x/y.test.js`. `test/` mirrors
  `src/`; tests are never co-located with source.
- A suite MUST NOT go in `test/loop/` unless it chains two or more real
  processes, each consuming what the previous one produced. The criterion is in
  `architecture/testing.md` §Loop and copied in `test/loop/README.md`;
  change both together.
- `test/helpers/` and `test/fixtures/` hold harness code. A `*.test.js` there
  tests the harness itself (`test/helpers/sandbox.test.js`), never `src/`.

## T4 — Calibration values enter a test through their named exports

Every threshold, weight, ratio, factor, cap, and half-life is an uncalibrated
placeholder (`architecture/trade-offs.md` #2). A test MUST read them from the
exports — `PRESETS`, `EDIT_COUNT_CAP`, `DIFF_LINE_CAP`,
`AUTO_ACCEPT_MULTIPLIER`, `SKIPS_BEFORE_CATEGORY_MUTE`, `defaultConfig()`,
`resolveKnobs()` in `src/io/config/config.js`; `MANUAL_RELIEF_FACTOR`,
`resolveManualReflection()` in `src/io/config/manual-reflection.js` — and MUST
NOT retype today's value, so that recalibration does not rewrite the suite.

```js
// ✅ test/hooks/stop-decision.test.js
const KNOBS = resolveKnobs(defaultConfig(), defaultState());
decideFire(
  state({ score: KNOBS.threshold }),
  defaultConfig(),
  group(),
  options(),
);

// ❌ today's balanced threshold, retyped
decideFire(state({ score: 10 }), defaultConfig(), group(), options());
```

A hand-chosen number that is an argument of the call, not a copy of a default
(`decayScore(8, 6 * HOUR_MS, 6)`), is an input, not a violation.

## T5 — No tautological tests

T4 governs where a test's **inputs** come from; T5 governs where its **expected
value** comes from. Importing the constant is required; importing the answer is
forbidden.

- A test MUST NOT derive its expected value by calling the function under test,
  or by re-running the same production arithmetic: `assert.equal(f(x), f(x))`
  cannot fail.
- The expected value MUST come from an independent source — one of:
  1. arithmetic spelled out in the test from the imported inputs;
  2. a relational or property assertion (the score dropped; the cap never
     raises a score; floor at zero; a value exactly at the threshold passes);
  3. a hand-chosen input whose outcome is known by construction.
- **Litmus test** — MUST be answerable "yes" before a test is kept: _if the
  production function were replaced by a wrong one, or the constant moved to a
  value that breaks the behaviour, would this test fail?_

```js
// ✅ test/core/scoring.test.js — inputs imported, oracle spelled out
const capOf = (preset) => preset.threshold * preset.cooldown_ratio;
assertClose(
  relievedScore(score, preset.threshold, preset.cooldown_ratio),
  Math.min(score, capOf(preset)),
);
// ✅ property: holds under any calibration
assert.ok(rewardedScore(below, preset.threshold, rewardKnobs(preset)) < below);

// ❌ the function under test is its own oracle
assert.equal(
  relievedScore(score, preset.threshold, preset.cooldown_ratio),
  relievedScore(score, preset.threshold, preset.cooldown_ratio),
);
```

**The wiring-proof pairing.** A child-process or loop test MAY use a production
function as its oracle only when that function is independently proven at unit
level under the rule above. The test then proves the wiring — that the real
process called it, with the right state, and persisted the result — not the
arithmetic, and it MUST say so in a comment. It SHOULD carry one relational
assertion beside the oracle so a no-op cannot pass.

```js
// ✅ test/loop/manual.test.js — rewardedScore is proven in
//    test/core/scoring.test.js; here it only checks what record.js persisted
assert.equal(state.score, rewardFor(seededState(CALM_SCORE)));
assert.ok(state.score < CALM_SCORE);

// ❌ a production function with no independent unit proof used as the oracle:
//    nothing anywhere pins the arithmetic, so both sides drift together
```

A new production function MUST NOT be used as an oracle anywhere until its own
`test/core/` (or mirrored) suite pins it independently. Why the score's
arithmetic exists once and is shared by two writers: `trade-offs.md` #14.

## T6 — Faking an external CLI

- A test that drives a real entrypoint as a child process and needs a fake
  `claude` MUST build the child's environment with
  `claudeShimEnv(sandbox, scenario)` from `test/helpers/claude-shim.js`, which
  rebuilds `PATH` around the stub, and MUST NOT let the child inherit the
  ambient `PATH` — a developer machine has a real Claude CLI on it.
- An in-process test MUST substitute through the programmatic seam
  (`options.spawn`, `options.runner`) instead.
- A test MUST NOT introduce or rely on an environment-variable seam.

Why both levels exist: `trade-offs.md` #12. The production half — modules
expose the seam and never read an env var for it — is in
`.agents/rules/code-rules.md`.

```js
// ✅ test/hooks/stop-fire.test.js
const env = claudeShimEnv(sandbox, VERDICT_SCENARIOS.pass);
sandbox.runNode(hookEntrypoint("stop"), [], { input, env });

// ❌ ambient PATH leaks the real CLI; an env seam leaks into real sessions
sandbox.runNode(hookEntrypoint("stop"), [], {
  input,
  env: { ...process.env, STOIC_FAKE_VERDICT: "pass" },
});
```

## T7 — Sandbox environment

A test that starts a real hook or CLI MUST create it through `createSandbox(t)`
(`test/helpers/sandbox.js`) and run it with `sandbox.runNode` or an environment
derived from `sandbox.env`, never from `process.env`. The sandbox redirects
`HOME`/`USERPROFILE` and withholds `CLAUDE_PROJECT_DIR`; without it a suite run
inside a Claude Code session resolves to — and writes into — the real
repository. Passing `options.env` replaces the environment wholesale, so spread
`sandbox.env` into it.

## T8 — Real processes and real git for load-bearing contracts

- A contract observable only from outside a process — files written, stdout,
  exit code, state across two runs — MUST be tested by driving the real hook or
  CLI as a child process, with at least one child-process test per contract
  part. The split against the in-process level is `architecture/testing.md` and
  `trade-offs.md` #12.
- Behaviour that depends on what git actually does — an entrypoint over a
  working tree, Project Root resolution in a subfolder, worktree, or submodule —
  MUST be tested over a real temporary repository built with
  `test/helpers/git-repo.js` (`initRepo`, `commitAll`, `addWorktree`,
  `addSubmodule`), not a mocked git. Parsing and failure handling of git's
  output is the in-process half and goes through `options.spawn`, as
  `test/io/git-diff.test.js` does.

## T9 — Contract changes carry their tests

A change to a load-bearing payload, pause-delivery, or CLI contract MUST update
its integration test in the same change. Why: `architecture/testing.md`
§Contracts. The documentation half — the approved documents change before, or
with, the code — is the final line of `AGENTS.md` "Where the truth lives".
