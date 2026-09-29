# Loop suites

Composition suites that chain real processes over a real temporary project.
They have no single module under test, which is why this folder sits outside
the mirror of `src/`.

## What belongs here

A suite belongs in `test/loop/` only when it chains two or more real processes
and each step consumes what the previous one produced.

A suite that runs one entrypoint per test, however many entrypoints it covers,
is not a loop: it lives beside the module it exercises (as
`test/io/project-root/entrypoints.test.js` does).

## Current suites

- `automatic.test.js` - the Stop hook, `record.js`, and the next Stop, for
  every Outcome of the engine-fired pause.
- `manual.test.js` - `reflect.js` and `record.js` over a real git repository,
  for the manual reflection.

This rule is a copy of the Loop bullet in
`thoughts/shared/.project/architecture/testing.md` §Loop, which is binding. Change
both together.
