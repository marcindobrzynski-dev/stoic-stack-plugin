---
version: 0.3.0
created_at: 2026-07-11
updated_at: 2026-09-29
---

# `.agents/` — the operating library for coding agents

This directory is the tracked operating library for AI coding agents working in
this repository (Claude, Codex, Cursor, and cloud agents that see nothing but
the repo). It is not human-facing documentation and not a duplicate of the
project's architecture: it holds the obligations an agent must honour, the
lessons this repository has already taught, and the configuration that external
engineering skills read.

## Where it sits in the hierarchy

`.agents/` is subordinate. When it conflicts with a higher source, the higher
source wins:

1. `AGENTS.md` at the repo root — the shared operating context, imported by
   `CLAUDE.md`.
2. The approved documents under `thoughts/shared/.project/` — architecture,
   its companions, the product idea, the tech stack.
3. This directory.

Nothing here may contradict them, and nothing here restates them. Generic
guidance inherited from a template for a different stack (Astro, Preact,
Tailwind, Zod, UI component architecture) does not apply to this project and
must not be reintroduced.

`.agents/local.md` is an optional, unversioned maintainer file. Its absence is
normal and means the tracked documents are all an agent needs.

## The three folders, one responsibility each

```
.agents/
├── rules/       # Obligations: MUST / MUST NOT, one file per area
├── memory/      # Dated lessons learned in this repository, with evidence
└── standards/   # Configuration consumed by external engineering skills
```

**`rules/`** — obligations. One file per area (`git-rules.md`,
`documentation-rules.md`, `code-rules.md`, `testing-rules.md`), loaded on
demand when a task touches that area. A rule is binding: it says what an agent
must or must not do here. The one exception to on-demand loading is
`collaboration-rules.md` — how an agent works with the lead, interactively or
autonomously — which applies to every task, so read it first.

**`memory/`** — what this repository has taught, not what is generally true.
`conventions.md` holds lessons that shape how code is written here;
`anti-patterns.md` holds mistakes that have actually occurred here. Every
entry is dated and carries its evidence.

**`standards/`** — configuration, not project rules. It holds
`triage-labels.md`, the triage-label vocabulary that external engineering
skills read. Nothing in `standards/` is an obligation on the codebase.

## Two hard rules

1. **`memory/` accepts only entries that carry a date and evidence from this
   repository.** A general best practice, a habit imported from another
   project, or a rule harvested from reading the code is not a memory entry.
   If it has not happened here and cannot be pointed at, it does not go in.
2. **When a memory entry matures into an obligation, it is MOVED to `rules/`
   and DELETED from `memory/` — never copied.** One fact lives in exactly one
   place. A convention that also appears as a rule is a defect, not redundancy.

## Where does a new fact go?

| The fact is…                                                      | It belongs in…                         |
| ----------------------------------------------------------------- | -------------------------------------- |
| A binding MUST / MUST NOT for anyone working here                 | `rules/<area>-rules.md`                |
| A lesson this repo taught, with a date and a source               | `memory/conventions.md`                |
| A mistake that actually happened here, and how to avoid repeating | `memory/anti-patterns.md`              |
| Configuration an external skill reads (triage labels)             | `standards/`                           |
| How the system is built, or why it is built that way              | `thoughts/shared/.project/` — not here |
| A general best practice with no evidence from this repo           | Nowhere. Leave it out.                 |

If a fact seems to fit two rows, it belongs in exactly one: pick the stronger
claim (a rule beats a convention) and delete the other.

## Entry format for `memory/`

Every entry in `conventions.md` and `anti-patterns.md` is a short heading, the
lesson in one or two sentences, and the evidence that produced it — a date plus
its source (review feedback, a bug, a PR, a live session). The existing ternary
entry in `conventions.md` is the model:

```markdown
### Ternary operator depth

Maximum depth is one — never nest a ternary inside another ternary. A branching
value that needs two levels gets separate `if` statements instead.
```

No entry without evidence. No evidence without a date.

## Dates in front matter

Every file under `.agents/` carries `created_at` and `updated_at`
(`YYYY-MM-DD`) in its front matter. Set both when creating a file; change
`updated_at` to today on every edit. `created_at` never changes.

## A note on `.gitignore`

`.gitignore` ignores `.agents/**` and re-admits files by allow-list. New files
under `rules/` and `standards/` are already covered by their `!.agents/rules/**`
and `!.agents/standards/**` lines. `memory/` is admitted file by file, so a new
file under `memory/` stays invisible to cloud agents until it gets its own
un-ignore line.
