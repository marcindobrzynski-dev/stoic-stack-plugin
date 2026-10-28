# Security policy

This file says which versions get security fixes, what data the plugin sends, and how to report a vulnerability.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |
| < 0.1   | No        |

## What data leaves your machine

What leaves your machine:

- **Default path.** The Classifier runs `claude -p` with Claude Haiku 5.5 (`claude-haiku-5-5`) on your own Claude Code login. The turn content goes to Anthropic, and nowhere else.
- **Opt-in Jev path.** This applies only when all conditions in [The Jev classifier](README.md#the-jev-classifier-experimental) are met. The transcript window goes to Anthropic for the Claude Sonnet 5.5 (`claude-sonnet-5-5`) call that builds the session state. Each category's part of that state (your request, the described changes, the touched file paths) goes to TypeSafe, the company that runs Jev, as a second provider.

Nothing else leaves your machine. There is no server of ours and no telemetry.

## Where local data lives

- `~/.claude/stoic-stack/` holds engine state and logs.
- `.stoic/decisions/` in your project holds the Decision Bank (git-ignored).
- `.stoic/.env` (git-ignored) holds the optional Jev key `TYPESAFE_API_KEY`.
- `.stoic/config.json` is meant to be committed, so a team can share it.

## Reporting a vulnerability

Email `contact@stoicstack.com`. Please do not open a public issue for security problems.

## What happens next

We reply to a security report within 14 days.
