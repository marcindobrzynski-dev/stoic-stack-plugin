---
trigger: manual
version: 0.1.0
created_at: 2026-09-19
updated_at: 2026-09-29
---

# Code Rules

Obligations for code under `src/`. Each rule is the imperative plus where its
reason is written; read the pointer instead of expecting the rationale here.
Test-side obligations live in `testing-rules.md`.

## C1 — A runtime dependency is a gated decision

The default is zero runtime dependencies: Node.js built-ins only, and
`package.json` holds `devDependencies` exclusively. You MUST NOT add a
`dependencies` entry without the lead's explicit decision AND
`thoughts/shared/.project/tech-stack.md` plus `architecture.md` updated before
or in the same change.

Read: `architecture.md` → "Design principles (binding)", principle 1.

## C2 — `src/core/` imports nothing above it and never reads the clock

`src/core/` MUST NOT import from `src/io/`, `src/hooks/`, or `src/cli/`, and
MUST NOT call `Date.now()` or `new Date()` — time arrives as a parameter.
`src/io/` importing `src/core/predicates.js` is the permitted direction, not an
exception to copy in reverse.

```js
// ❌ src/core/ — a clock read makes every expiry test wait for real time
export function pruneMutes(mutes) {
  return mutes.filter((mute) => isActive(mute, Date.now()));
}

// ✅ the caller owns the clock
export function pruneMutes(mutes, now) {
  return mutes.filter((mute) => isActive(mute, now));
}
```

Read: `architecture.md` → "Layered structure" (the paragraph after the
directory layout); the header of `src/core/scoring.js`.

## C3 — Nothing on the hook path throws; it degrades toward silence

The plugin must never obstruct the developer's work. Concretely:

- A new capture hook MUST run inside `runCaptureHook` (`src/hooks/capture.js`)
  and supply only its `buildEvent`. It MUST NOT print anything: stdout belongs
  to the Stop hook's pause-delivery contract.
- A hook entrypoint MUST end every path — including a caught exception — as a
  successful exit with exactly one trace line (`writeLocalTraceLine`, or
  `writeSharedTraceLine` when no Project Root resolved).
- A `src/io/` reader, appender, or external-process runner MUST NOT throw. It
  returns a documented degraded value: `readJsonFile` → a `missing` / `invalid`
  status, `readWorkingTreeDiff` → "failure as emptiness" (`src/io/git-diff.js`), `runHeadlessJson` →
  `{ status: "unavailable", reason }`, `resolveProjectRoot` → `null`.
- A `src/io/` function that **persists a document** (`saveState`, `saveConfig`,
  `writeDecisionEntry`, the atomic helpers) throws on failure by design — a
  save that lied would corrupt the next turn. Its caller MUST be the one place
  that catches: the hook's single outer `try`, or the CLI's result envelope.
  You MUST NOT swallow a write failure inside the writer.

Read: `architecture.md` → "Design principles (binding)", principle 3; the
headers of `src/io/session-log.js` and `src/io/config/config.js` (the
read/write asymmetry); the JSDoc of `saveState` in `src/io/state.js`.

## C4 — A CLI sets `process.exitCode`; it never calls `process.exit()`

`process.exit()` can truncate a pending stdout write when stdout is a pipe, and
a CLI's stdout is its contract: exactly one JSON result.

```js
// ❌
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(code);

// ✅ as in record.js, reflect.js, setup.js
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = code;
```

Exit statuses are 0 / 2 / 1 with the meanings in each CLI's header and in
`payloads.md`; a new CLI under `src/cli/` MUST keep them.

## C5 — A child process is substituted through a parameter, never the environment

A module that spawns a child process MUST expose the substitution point as a
function argument whose production default is the real implementation
(`options.spawn` in `headless.js`, `git-diff.js`, `bank.js`; `options.runner`
in `classifier.js`), and MUST NOT read an environment variable to change what
it spawns — "a test seam must never be able to alter a real user's session"
(`src/io/headless.js` header).

```js
// ❌
const command = process.env.STOIC_CLAUDE_BIN ?? "claude";

// ✅
const spawn = typeof settings.spawn === "function" ? settings.spawn : spawnSync;
```

`src/io/project-root.js` deliberately has no seam at all (its header says why);
that is a recorded decision for one module, not a precedent. The test half —
PATH shim, sandbox environment — is in `testing-rules.md`.

## C6 — Variable text never reaches a command line unvalidated

The last Windows strategy in `spawnAttempts` runs under `shell: true`, where an
argument is shell text. Therefore:

- Prompts, model output, file paths from payloads, branch names, and any other
  externally-derived text MUST travel over stdin (`input:` in `runHeadlessJson`)
  or stay out of the invocation entirely. Argument vectors MUST be fixed
  (`GIT_DIFF_ARGS`, `buildHeadlessArgs`); you MUST NOT build a command string by
  interpolation.
- A configured value that has to be an argument MUST first pass a strict
  allow-list pattern, and a mismatch MUST refuse the spawn — as
  `classifier_model` does against `MODEL_ID_PATTERN`, returning
  `invalid_request` before any strategy is tried.

```js
// ❌ args.push("--append-system-prompt", group.last_prompt);
// ✅ spawn(attempt.command, buildHeadlessArgs(model), { input: prompt, shell: attempt.shell });
```

The same reasoning is why free text reaches `record.js` through the `--data`
file and never as an argument (see its header).

## C7 — Documents are replaced atomically

Every document that is written whole — `state.json`, both pause documents,
`.stoic/config.json`, a decision-bank day file — MUST go through
`writeJsonFileAtomic` or `writeTextFileAtomic` from `src/io/json-file.js`
(usually via `saveState` / `saveConfig` / `writeDecisionEntry`), never a direct
`fs.writeFileSync` to the final path.

```js
// ❌ fs.writeFileSync(manualPausePath(projectDir), JSON.stringify(document));
// ✅ writeJsonFileAtomic(manualPausePath(projectDir), document);
```

The exception is the append-only line logs — the per-session event log
(`appendSessionEvent`) and the two trace sinks — which use `fs.appendFileSync`
on purpose; readers tolerate a torn line. You MUST NOT add a new append-only
file without the same tolerance on its reader.

Read: `architecture.md` → "State locations"; `trade-offs.md` #11; the header of
`src/io/session-log.js`.

## C8 — One designated writer per document

You MUST NOT add a second writer to anything in this index.

| Written thing                                         | Its writer(s), exhaustively                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `score` in `state.json`                               | `src/hooks/stop.js` (turn scoring; `relievedScore` on a fire) and `src/cli/record.js` (`rewardedScore`, manual `keep`/`correct` only) |
| Pause Outcomes, new mutes, skip streaks, bank entries | `src/cli/record.js` (the Stop hook only prunes expired mutes)                                                                         |
| `stoic-pending-pause.json`                            | `src/hooks/stop.js`                                                                                                                   |
| `stoic-manual-pause.json`                             | `src/cli/reflect.js`                                                                                                                  |
| `.stoic/config.json`                                  | `src/cli/setup.js`                                                                                                                    |
| Session event log                                     | the capture hooks, through `runCaptureHook`                                                                                           |

Score arithmetic MUST stay in `src/core/scoring.js`; neither writer inlines it.

Read: `architecture.md` → "Design principles", principle 4;
`architecture/configuration.md` §Score relief; `architecture/components.md`;
`trade-offs.md` #14.
