---
version: 0.1.0
created_at: 2026-09-19
updated_at: 2026-10-27
---

# Anti-Patterns

Mistakes that have actually occurred in this repository, and how not to repeat
them. A pattern is recorded here only once it has happened here — a hypothetical
risk, a habit from another project, or a general warning does not qualify. Every
entry carries a date and its evidence; an entry that has matured into a binding
obligation is moved to `../rules/` and deleted from here, never copied. See
`../README.md` for the entry format and the two hard rules.

## Deleting a consumer without its orphaned dependencies

### Orphaned reader left behind a deleted evaluation harness

When a consumer is deleted, the same change checks every symbol it imported and
removes each one that has no other caller, with its tests. Green tests on code
nobody calls are not evidence that the code is needed; they make orphaned code
look like a working feature.

Evidence: as part of the Jev experiment, in the commit from 2026-10-23, 
the file `experiments/jev/eval/run-eval.js` was removed from the repository.
out of the repository. That file was the only caller of `parseSummaryLine`,
`joinSummaryWithLocalTrace` and `parseTimestampMs` in `experiments/jev/log.js`,
but the commit did not touch `log.js`, so about 440 lines of reader (schema
guessing by field names, v1/v2 renaming into the v4 shape) and six tests stayed
behind for four days, fully green. The lead noticed on 2026-10-27 while
preparing PR for merge; removing the reader also exposed two test fixtures
stamping summary lines with the wrong schema constant, which the tolerant reader
had masked.
