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
5. The implementation and tests, once present - evidence of what currently
   works, but not permission to silently depart from the binding architecture.

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

The repository is in the pre-implementation PoC phase. The product and
architecture are approved, while the runtime described by the architecture has
not yet been built. In particular, `src/`, `test/`, `hooks/hooks.json`, and the
plugin-facing `skills/` content are not yet implemented.

Existing scaffolding includes the Claude plugin and marketplace manifests,
JavaScript quality tooling, installed engineering-agent skills, GitHub issue
tracking, and the approved product and architecture documents. Numeric scoring
defaults remain intentionally uncalibrated and must be treated as placeholders.

Before reporting work complete, run the checks relevant to the files changed.
The currently available checks are `npm run lint` and
`npm run format:check`. Add and use `npm test` when the test suite described by
the architecture is introduced.

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
