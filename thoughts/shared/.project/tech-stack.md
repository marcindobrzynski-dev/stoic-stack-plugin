---
version: 0.2.0
last_update: 2026-09-29
created_at: 2026-07-11
---

# Tech stack

Installed tooling lives in the root `package.json`; read it rather than this
file for the linter, formatter, and their versions. This file holds only what
`package.json` cannot tell you: runtime requirements, the binding dependency
rule, and what is deliberately not here yet.

## Runtime

- **Node.js 24 or newer.** `.nvmrc` pins the exact version. The hard floor is
  Node 21: `npm test` relies on `node --test` expanding its own glob, and on an
  older Node the run finds no files and passes green.
- **JavaScript, ESM, no build step.** `"type": "module"`; hooks and CLIs run
  directly via `node`.
- **Zero runtime dependencies.** Plugin code uses Node.js built-ins only;
  `package.json` holds `devDependencies` exclusively. The rule is binding and
  defined in [architecture.md](./architecture.md) (Design principles); adding a
  dependency updates that document and this file first.

## External binaries required at runtime

Neither is an npm dependency, and neither is checked at install time.

- **`git`** on `PATH`. The decision bank reads the current branch, and the
  manual reflection measures `git diff HEAD`. Every failure degrades to a
  clean tree or a `detached` / `no-branch` fallback; nothing throws.
- **`claude`** (the Claude Code CLI) on `PATH`. The classifier veto runs
  `claude -p` headless. On Windows the binary is a `.cmd` shim, so
  `src/io/headless.js` cascades `claude` → `claude.cmd` → shell. An
  unavailable CLI means no veto, never a broken session.

The test suite additionally needs real `git` on `PATH` and refuses to run
without it; `claude` is never called by tests, a stub fixture stands in.

## Code quality

- ESLint and Prettier, both wired: `npm run lint`, `npm run format:check`.
- No git hooks and no extra static checker. Husky and Fallow were removed on
  2026-09-29 as installed-but-unused; the local checks above are run by hand.

## Not here yet (planned)

- **CI.** There is no `.github/` and no pipeline; the local checks are the
  only gate. GitHub Actions is the intended target when CI is added.
- **First explicit dependency: TypeSafe SDK** (`@typesafe-ai/sdk`,
  <https://docs.typesafe.ai/sdk>). A candidate for turning classifier-style
  judgments into typed answers. Adopting it would be the first exception to
  the zero-dependency rule and must land in `architecture.md` before any
  code. Not referenced anywhere else until that decision is made.
