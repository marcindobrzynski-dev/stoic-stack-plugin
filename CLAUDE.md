@AGENTS.md

## Model and delegation defaults

When work is delegated, these are the default tiers:

- **Orchestrator** — the main session. Default model: Fable 5.
- **Researchers** — sub-agents that read, search, and report findings back. Default model:
  Sonnet 5.
- **Workers** — sub-agents that implement changes. Default model: Opus 5.

The orchestrator role belongs to the main session whatever model it happens to be running. A
session on any tier can still assemble a dynamic workflow of Sonnet 5 researchers and Opus 5
workers beneath it — don't refuse to delegate because the session model differs from the
default above.

These are defaults, not constraints. If I name a different tier for a role — "make the
researchers Opus 5", say — take it for the rest of the session and don't re-argue the default.
Delegate when I ask for research, parallel work, or a workflow; a single well-scoped change
does not need a sub-agent.
