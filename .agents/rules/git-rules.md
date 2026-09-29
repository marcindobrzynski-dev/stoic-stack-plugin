---
trigger: manual
version: 0.1.0
created_at: 2026-09-19
updated_at: 2026-09-29
---

# Git Rules

## Branching Strategy

- **Main branch**: `main` - Production-ready code
- **Development branch**: `develop` - Integration branch and the GitHub default
  branch; branch from it and open pull requests against it
- **Feature branches**: `feature/feature-name` - New features
- **Bugfix branches**: `bugfix/bug-name` - Bug fixes
- **Hotfix branches**: `hotfix/hotfix-name` - Urgent production fixes

## Commit Messages

- **Conventional Commits**: Use conventional commit format
- **Format**: `type(scope): description`
- **Types**: `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `ci`
- **Examples**:
  - `feat(auth): add user login functionality`
  - `fix(api): resolve timeout issue in data fetching`
  - `docs(readme): update installation instructions`

## Commit Message Rules

- **Imperative mood**: Use "add" not "added" or "adds"
- **Lowercase**: Keep description lowercase
- **No period**: Don't end with period
- **50 chars ideal, 72 maximum**: 50 chars is the ideal and 72 the practical
  ceiling (GitHub's truncation point), but the `type(scope): ` prefix eats into
  the budget. Nothing enforces this mechanically — there is no commitlint in
  this repo — so it is guidance an agent is expected to honour.
- **Body details**: Add body for complex changes

## Pull Request Rules

- **Descriptive title**: Summarize changes clearly
- **Detailed description**: Explain what and why
- **Linked issues**: Reference related issues
- **Tests included**: All changes must have tests

## PR Template

```markdown
## Description

[Brief description of changes]

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing

- [ ] Unit tests added/updated
- [ ] Integration tests added/updated

## Checklist

- [ ] Code follows project standards
- [ ] Tests pass locally
- [ ] Documentation updated
```

## Merge Rules

- **Squash merges**: Use squash for feature branches
- **No merge commits**: Avoid merge commits to main
- **Delete branches**: Delete branch after merge
- **Update main**: Fast-forward or rebase

## Workflow

1. Create branch from `develop`
2. Make changes with clear commits
3. Push branch and create PR
4. Run the local checks listed under "Done means run" in
   `.agents/rules/testing-rules.md` (there is no CI in this repo; the local run
   is the only gate)
5. Merge to `develop`
6. Delete feature branch

## Forbidden Patterns

- **Direct commits to main**: Never commit directly to main
- **Large PRs**: Keep PRs focused and small (<500 lines)
- **WIP commits**: Don't commit work-in-progress code
- **Merge commits**: Avoid merge commits in feature branches
