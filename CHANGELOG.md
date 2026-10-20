# Changelog

## Unreleased

### Changed

- Pause probability is `decision_weight * decision_ownership * (1 - 0.6 * developer_reflection) * (1 - 0.3 * developer_intent)`.
- `developer_intent` is a separate mild reduction and can only lower the probability.
- Summary lines use schema version 4 and log `developer_reflection_reduction_multiplier` and `developer_intent_reduction_multiplier`.

### Removed

- `combineReflectionAndIntent` and `effective_reflection`, which took `max(developer_reflection, developer_intent)`.
- The `reflex_approval` reflection signal, including bare approval without a reason and approval repeated across turns as a reflection input.
