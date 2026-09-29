---
version: 0.1.0
created_at: 2026-09-19
updated_at: 2026-09-29
---

# Conventions

Lessons this repository has taught about how code is written here — not general
best practice. Every entry carries a date and its evidence; an entry that has
matured into a binding obligation is moved to `../rules/` and deleted from here,
never copied. See `../README.md` for the entry format and the two hard rules.

## Code style

### Ternary operator depth

Maximum depth is one — never nest a ternary inside another ternary. A branching
value that needs two levels gets separate `if` statements instead.
