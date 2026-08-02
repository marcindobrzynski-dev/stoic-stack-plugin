---
status: approved
version: 0.1.3
last_update: 2026-08-02
created_at: 2026-07-11
---

# Known limitations & design trade-offs

> Companion to [../architecture.md](../architecture.md). Deliberate
> compromises in the PoC — documented so contributors don't "fix" intentional
> decisions, and so testers know what is untuned by design.

1. **Pause delivery is a workaround, kept on purpose.** Claude Code hooks
   cannot render UI, so a pause is a Stop-block with an injected instruction
   that asks the main conversation to invoke a skill. The injection text and
   `stoic-pending-pause.json` form a prompt-level contract between engine and
   content — fragile by nature, mitigated by dedicated integration tests, not
   by a cleverer mechanism (none exists today).

2. **Scoring is uncalibrated.** Every threshold, weight, and half-life is a
   placeholder; the prompt-effort heuristic is a crude regex-based signal.
   Calibration against real usage is explicitly post-PoC work — do not read
   meaning into the current numbers.

3. **State is written once per turn, at Stop.** No live feedback during long
   turns, and the session-log truncation at each Stop is load-bearing for
   correctness. Accepted for simplicity: one writer, one turn boundary, no
   mid-turn race conditions.

4. **Delegation attribution is per-event only.** The sandbox's live
   sub-agent counter and prompt-suppression window were dropped: too much
   mutable state for the value. Consequence: sub-agent activity that arrives
   without an `agent_id` in the payload is attributed to the user.

5. **The classifier adds latency and cost to firing turns.** A headless
   `claude -p` call runs on every turn where a gate fires. Accepted because
   it only happens at pause candidates and vetoes false alarms cheaply; a
   `Stop` hook timeout bounds the worst case.

6. **The default classifier model is a pinned snapshot id.** A hardcoded
   model default will age; it is user-overridable via `classifier_model` and
   must be reviewed at release time.

7. **Windows-first process spawning is pragmatic, not pretty.** Launching
   `claude -p` on Windows requires a spawn fallback cascade (`claude` →
   `claude.cmd` → shell). Isolated in `src/io/headless.js`, which returns
   `null` on any failure so the engine degrades to "no classifier veto".

8. **Background delegation scores one turn late.** The parent turn's Stop can
   fire before background sub-agents or workflows write their files (sandbox
   Finding #1): the delegating turn may close with zero edits, and the
   delegated edits land in the _next_ turn's group. Accepted: the signal is
   delayed, not lost — with one known edge: the pause-continuation Stop
   (`stop_hook_active`) truncates the session log, swallowing any events that
   arrived during the pause. Accepted, but no longer blind: the continuation
   Stop counts what it drops by event kind and records the tally in its
   `continuation_truncated` trace line (`dropped`), so calibration can judge
   the real cost from field evidence rather than intuition. Re-attribution
   stays unbuilt until that evidence justifies it; no timestamp reconciliation
   by design.

9. **Project slugs can collide in theory.** The personal-state directory name
   is derived by replacing every non-alphanumeric character of the absolute
   project path with a dash — the same convention Claude Code uses for its
   own per-project directories. Two paths that differ only in punctuation
   (e.g. `b-c` vs `b/c`) would share a slug and therefore a state directory.
   Accepted: the collision requires pathological sibling layouts, the
   convention stays aligned with the host tool, and the worst case is blended
   scores, not data loss.

10. **Delegated edits are discounted, not ignored.** Autopilot is defined as
    low user thought, not high machine output (see the
    [domain glossary](2026-07-11_CONTEXT.md)) — a planned fan-out must not
    fire pauses on volume alone, while a low-effort prompt that fans out
    agents should still score. The `delegated_discount` knob weighs delegated
    volume down; prompt effort stays the primary signal. This refines (does
    not remove) the earlier per-event attribution decision in trade-off 4.

11. **Session-log consumption is read-then-delete, not an atomic take.** The
    Stop hook reads `sessions/<session_id>.jsonl` and then deletes it — two
    ordinary filesystem calls, deliberately not a snapshot-and-consume
    operation. Two consequences are accepted:

    - **An append racing the pair can be lost.** A capture hook that appends
      between the read and the delete has its event discarded unread. The
      window is the gap between two adjacent calls, and the appenders are
      hooks belonging to a turn that has already ended, so the race needs a
      late-arriving background sub-agent (see trade-off 8) to occur at all.
    - **A failed delete can replay.** `truncateSessionLog` is fail-silent and
      reports nothing, so a deletion blocked by a lock or a permission problem
      leaves the events just scored in place, and a later Stop scores them a
      second time.

    Atomic consumption (rename-then-read into a per-turn file, or an
    advisory lock) is **deliberately deferred**, not overlooked. It would buy
    exactness in a system whose whole input is heuristic and whose numbers are
    uncalibrated (trade-off 2) — a duplicated or missing event shifts a score
    that decays by half-life anyway. Revisit only if field traces show real
    turns hitting either window; the fix is local to `src/io/session-log.js`
    and the Stop hook's consume step.

    Code documenting this: `src/io/session-log.js` (module header,
    `truncateSessionLog`) and `src/hooks/stop.js` (`scoreTurnBoundary`).
