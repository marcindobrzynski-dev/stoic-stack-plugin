# Contributing

Thank you for your interest in Stoic Stack Plugin. This is a proof of concept, so small, focused contributions are welcome. Bigger ideas start as an issue, so we can talk about them first.

## Rules to read first

- [AGENTS.md](AGENTS.md) is the operating context for every contributor and every coding agent.
- [.agents/rules/](.agents/rules/) holds the rules for code, tests, git and documentation.
- [glossary.md](thoughts/shared/.project/architecture/glossary.md) defines the words we use. Please use them with the same meaning.

## Set up

You need Node.js 22.13 or newer and `git`. Then install the development tools:

```sh
npm install
```

## Checks before a pull request

Run all three checks and make sure they pass:

```sh
npm test
npm run lint
npm run format:check
```

There is no CI. These local checks are the only gate.

## Branches and pull requests

- Branch from `develop`.
- Open the pull request against `develop`.
- Branch names start with `feature/`, `bugfix/`, `hotfix/` or `chore/` (see [git-rules.md](.agents/rules/git-rules.md)).
- Commit messages follow Conventional Commits: `type(scope): description`.
- `main` only receives releases.

## Commits

Do not add AI-attribution trailers to commit messages, for example `Co-authored-by` lines for AI tools.
