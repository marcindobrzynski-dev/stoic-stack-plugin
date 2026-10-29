---
trigger: manual
version: 0.1.0
created_at: 2026-09-19
updated_at: 2026-09-29
---

# Documentation Rules

## Code Documentation

- **Self-documenting code**: Write clear, readable code.
- **JSDoc comments**: Document exported functions.
- **Complex logic**: Explain algorithms and business logic.
- **TODO comments**: Mark temporary solutions with TODO.
- **Deprecated**: Mark deprecated code with @deprecated.
- **Comment length**: Keep comments concise and avoid very long comment lines.
  Prefer multiple short sentences or lines over one long comment.

## JSDoc Format

This is plain JavaScript with no type checker, so JSDoc carries the types.
Annotate parameters with `{unknown}` where the function tolerates any input
shape, and say in the description what an unusable value does.

```js
/**
 * Brief description of the function.
 *
 * @param {unknown} first - What it is, and how an unusable value is read.
 * @param {number} second - What it is.
 * @returns {number} What comes back, and the guarantees that hold (never
 *   throws, never NaN, and so on).
 */
export function myFunction(first, second) {
  // Implementation
}
```

## Module Headers

A new non-trivial module under `src/` MUST open with a header comment — `//`
line comments above the imports (after the shebang in a CLI), not a JSDoc
block — that states (abridged from `src/io/trace.js` below):

- **Its one job**: the first line names what the module is, the next paragraph
  why it exists as a separate module.
- **Its guarantees**: pure or not, whether it throws and what a failure
  degrades to, what I/O it performs, whether it reads the clock or the
  environment, and how a test substitutes its side effects.
- **Its contract pointer**: a line beginning `Contract:` with the full path of
  the approved, public document and the section it implements. A module that
  implements no documented contract (a leaf such as `src/core/predicates.js`)
  omits the line rather than inventing one.

```js
// The bounded trace sinks — Stoic Stack's only field-debugging surface.
//
// Every hook invocation appends exactly one compact JSON outcome line, so a
// dead pipeline is distinguishable from a quiet one.
//
// Tracing must never break the traced session: neither writer throws or
// prints, and there are no environment-variable seams.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §`local-trace.jsonl`, §`shared-trace.jsonl`.
import fs from "node:fs";
```

## README Files

- **Project README**: Comprehensive project documentation, in the repo root
- **Update regularly**: Keep docs in sync with code

## Comment Guidelines

- **Why, not what**: Explain why, not what code does
- **Keep current**: Update comments when code changes
- **No obvious comments**: Don't comment obvious code
- **Complex logic**: Document complex algorithms
- **Workarounds**: Document temporary workarounds
- **Comment length**: Concrete yet concise comments

## Changelog

- **Version tracking**: Maintain `CHANGELOG.md` in the repo root
- **Categorized changes**: Group by Added, Changed, Fixed, Removed
- **Link issues**: Reference related issues

## Inline Documentation

- **Complex regex**: Explain regex patterns
- **Magic numbers**: Explain magic numbers
- **Business rules**: Document business logic
- **Edge cases**: Document edge case handling
- **Performance notes**: Note performance considerations

## Forbidden Patterns

- **Outdated docs**: Never let docs get out of sync
- **Missing docs**: Don't skip documentation for exported functions
- **Obvious comments**: Don't comment self-explanatory code
- **Dead docs**: Remove docs for removed features
