# AGENTS.md - Stoic Stack Plugin

Operating context for every coding agent in this repository.

## Stoic Stack

Stoic Stack is a startup that joins Stoic practice — attention to what lies
within your control, deliberate judgement over reflex — with pragmatic
programming in the age of AI. Its mission is tools that strengthen the
developer across the whole software-engineering process: AI amplifies their
skill and judgement, and the developer stays the engineer, sharper for the work
rather than dulled by it. This plugin serves that mission within the PoC scope
set in `thoughts/shared/.project/project-idea.md`.

## Where we stand

Stoic Stack Plugin is a local Claude Code plugin, with no server and no
telemetry, that notices when a developer drifts into autopilot and offers a
short Socratic reflection. The PoC is feature-complete: the automatic pause and
the manual reflection both run end to end under automated tests. What remains
is a full live acceptance check in Claude Code; calibrating the placeholder
scoring defaults is post-PoC work.

## Where the truth lives

When two sources conflict, the glossary wins over every document.
`architecture.md` and its companions are each binding in their own area. Below
them come `project-idea.md`, then the tooling documents, and last `src/` and
`test/`.

| Source                                                   | Holds                                                                              | Read when                                                                 |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `thoughts/shared/.project/architecture/glossary.md`      | domain language; wins over every document                                          | before naming anything                                                    |
| `thoughts/shared/.project/architecture.md`               | binding architecture: principles, layers, directory layout                         | before any structural change                                              |
| `thoughts/shared/.project/architecture/components.md`    | every module, its role, the hand-checked prose/code pairings                       | before changing a module or a skill                                       |
| `thoughts/shared/.project/architecture/data-flow.md`     | Stop order of operations, pause delivery, state locations                          | before touching the hook or CLI chain                                     |
| `thoughts/shared/.project/architecture/payloads.md`      | frozen document and stdout contracts                                               | before changing any written or printed shape                              |
| `thoughts/shared/.project/architecture/configuration.md` | config model, presets, knobs, score relief                                         | before adding or reading a setting                                        |
| `thoughts/shared/.project/architecture/testing.md`       | test tiers, levels, seams, live-acceptance status                                  | before choosing where a test lives or calling a skill live-tested         |
| `thoughts/shared/.project/architecture/trade-offs.md`    | deliberate compromises and their reasons                                           | before "fixing" something that looks wrong                                |
| `thoughts/shared/.project/project-idea.md`               | goal, audience, scope, exclusions                                                  | before proposing scope                                                    |
| `thoughts/shared/.project/tech-stack.md`, `package.json` | runtime, dependency rule, deliberate absences; installed tooling in `package.json` | before changing tooling or adding a dependency                            |
| `src/`, `test/`                                          | evidence of what works                                                             | always; on conflict with a row above, fix the code or update the document |

An architectural change updates the approved documents before, or in the same
change as, the code.

## Agent library

| Read                                   | When                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `.agents/rules/collaboration-rules.md` | before your first message to the lead; it sets interactive or autonomous mode            |
| `.agents/rules/code-rules.md`          | before changing `src/`                                                                   |
| `.agents/rules/testing-rules.md`       | before writing any code or test (the T1 cycle is mandatory) and before calling work done |
| `.agents/rules/git-rules.md`           | before a branch, commit, or PR                                                           |
| `.agents/rules/documentation-rules.md` | before editing documentation or code comments                                            |
| `.agents/memory/`                      | before writing code: recorded conventions and anti-patterns                              |
| `.agents/standards/triage-labels.md`   | when labelling an issue                                                                  |
| `.agents/README.md`                    | before adding anything to `.agents/`                                                     |

Work starts from a prepared GitHub issue
(`marcindobrzynski-dev/stoic-stack-plugin`, via `gh`) or a feature workspace
the lead points to; the lead opens new workspaces and new scope.
