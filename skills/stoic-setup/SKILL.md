---
name: stoic-setup
description: Configure Stoic Stack in four plain questions — sensitivity, decision areas, pause style, and follow-up drafting.
disable-model-invocation: true
---

# Stoic Stack setup

Four plain-language questions, one conversation. You **own the conversation**;
`setup.js` **owns every consequence** — it is the only thing that validates a
choice or writes a file. You never build or edit `config.json` yourself.

The table in step 2 is your **entire vocabulary**. Presets are chosen by name;
the thresholds, weights, half-lives, mute durations, confidence values, model
ids, and the `advanced` object all stay inside the engine, out of the
conversation.

This skill only configures. It hands the choices to `setup.js` and stops — it
never scores, pauses, reflects, shows status, or reads the decision bank.

## 1. Read the choices in effect

Run:

    node "$CLAUDE_PLUGIN_ROOT/src/cli/setup.js" --current

Parse the single JSON line. On `ok: true` you hold `choices` (`preset`,
`categories`, `pause_mode`, `followup_draft`) plus `enabled` — the current
answers on a configured project, or the recommended defaults on a fresh one. On
`ok: false`, go straight to step 4.

Done when you hold the four current choices.

## 2. Ask the four questions

Ask all four in a single `AskUserQuestion` call — its four questions are the
four groups below, so the user answers them in one interaction. Make **Decision
areas** `multiSelect: true`; the other three are single-select. Each option's
label comes straight from its table, and its `header` is a short chip
(`Sensitivity`, `Areas`, `Pause style`, `Follow-up`). Put the
current choice from step 1 first and append `(current)` to it. Speak only in
these labels.

**Sensitivity** — one of:

| Label                                               | id         |
| --------------------------------------------------- | ---------- |
| Calm — pause rarely, only the biggest decisions     | `calm`     |
| Balanced — a moderate check-in rhythm (recommended) | `balanced` |
| Vigilant — pause often                              | `vigilant` |

**Decision areas** — any of, multi-select (choosing none turns Stoic Stack off):

| Label                       | id                |
| --------------------------- | ----------------- |
| Data & domain modeling      | `data_domain`     |
| APIs & integrations         | `api_integration` |
| Security & auth             | `security`        |
| Architecture & dependencies | `architecture`    |

**Pause style** — one of:

| Label                                  | id         |
| -------------------------------------- | ---------- |
| Offer choices, and let me write my own | `hybrid`   |
| Just give me choices to pick from      | `choices`  |
| Let me write my reflection freely      | `freeform` |

**Follow-up drafting** — one of:

| Label                                       | id      |
| ------------------------------------------- | ------- |
| Draft a follow-up prompt from my reflection | `true`  |
| Don't draft one                             | `false` |

Done when the user has answered all four.

## 3. Apply the complete set

Translate the four answers to their ids and pass all four to the CLI in one
call. `--categories` is a comma-separated list of ids, or `""` for none:

    node "$CLAUDE_PLUGIN_ROOT/src/cli/setup.js" --apply --preset <id> --categories <id,id,...> --pause-mode <id> --followup-draft <true|false>

Worked examples — match the shape, not the values:

    # All four areas on, balanced, hybrid pauses, follow-ups drafted (the fresh defaults)
    node "$CLAUDE_PLUGIN_ROOT/src/cli/setup.js" --apply --preset balanced --categories data_domain,api_integration,security,architecture --pause-mode hybrid --followup-draft true

    # Only security + architecture, pause often, pick-from-choices, no follow-up draft
    node "$CLAUDE_PLUGIN_ROOT/src/cli/setup.js" --apply --preset vigilant --categories security,architecture --pause-mode choices --followup-draft false

    # A single area, calm, free-form reflections
    node "$CLAUDE_PLUGIN_ROOT/src/cli/setup.js" --apply --preset calm --categories data_domain --pause-mode freeform --followup-draft true

    # No areas — this turns Stoic Stack off; the empty string is the answer
    node "$CLAUDE_PLUGIN_ROOT/src/cli/setup.js" --apply --preset balanced --categories "" --pause-mode hybrid --followup-draft false

Parse the single JSON line. Done when the CLI has returned.

## 4. Report the outcome

**On `ok: true`,** confirm in plain language:

- the sensitivity, the enabled decision areas, the pause style, and whether
  follow-ups are drafted — or, if no area was chosen, that Stoic Stack is now
  off;
- that these settings live in the team-shareable `.stoic/config.json`, while
  your personal history and score are kept separately and were preserved;
- that changes apply immediately, and rerunning setup revisits only these four
  guided fields.

**On `ok: false`,** show `error.message` as one concise, actionable line. Do not
claim setup succeeded, and do not repair or write anything yourself — `setup.js`
is the only writer.
