---
status: approved
version: 0.1.4
last_update: 2026-08-12
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
   `claude.cmd` → shell). Isolated in `src/io/headless.js`, which returns a
   clean "unavailable" result on any failure so the engine degrades to "no
   classifier veto".

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
    `truncateSessionLog`) and `src/hooks/stop.js` (`closeTurnBoundary`).

12. **Fire-path tests spawn a stub CLI, and that is the accepted breach.**
    Two requirements collide and cannot both be met. The load-bearing
    pause-delivery contract is observable only from **outside** a real hook
    process — it is a file on disk and a line on stdout — so its tests must
    drive the real entrypoint as a child. But the classifier's fixed-verdict
    seam (`options.runner`, and `options.spawn` below it) is an ordinary
    function argument, which cannot cross a process boundary. A hook running
    as a child can therefore never be _handed_ a verdict.

    Three resolutions were weighed:

    - **Child process only**, with a stub CLI on the child's `PATH`. Proves
      everything, but pays a full sandbox and spawn per case and reports
      failures bluntly — an eight-stage chain says only "something broke".
    - **In-process only**, via `options.runner`. Fast and precise, but proves
      nothing about the pending-pause document or the Stop block, which is
      the entire subject of the contract. Rejected.
    - **Both, split by observability** — adopted. Artifacts visible only from
      outside go to the child-process level; the combinatorial surface (four
      veto reasons, fingerprint and category mutes, expired-mute pruning,
      below-both-gates, cooldown arithmetic, trigger precedence) goes
      in-process.

    The breach is precise and worth naming: the child-process level **does**
    launch a process under the CLI's name. What the no-network rule actually
    protects — no network, no model, no cost, no nondeterminism — is fully
    preserved, because the stub is a fixture that prints a canned envelope
    and is inert unless `STOIC_TEST_SANDBOX=1`. The earlier wording "no
    headless child" named the mechanism instead of the harm, and forbade the
    only workable arrangement; it now reads "no network, no real Claude CLI".

    Two costs are accepted. Two test mechanisms must be maintained instead of
    one. And a case could end up proven only in-process, where it cannot fail
    for the reason a user would hit — mitigated by requiring at least one
    child-process test per contract part, plus one proving that a suppressed
    turn really leaves stdout empty.

    This trade-off also imposes a design constraint: a hook whose fire path is
    tested this way must separate _deciding_ from _doing_, exposing a pure
    decision function the in-process level can call — the shape
    `src/core/gates.js` already has.

13. **A muted turn still pays for its classifier call.** The binding order
    runs the classifier before the mute check, because a mute is keyed by
    category and the category is the classifier's output — there is nothing
    to match a mute against until the verdict exists. Only a _fire_ cools the
    score, so a category mute over a still-loud score means every turn above
    the threshold spawns a real headless call (cost, plus up to its 45s
    budget of turn-end latency) whose verdict is then discarded as `muted` —
    for up to `category_mute_ms`, the worst case being the 24-hour
    three-skips mute.

    Two remedies were weighed and rejected for the PoC:

    - **Cooling the score on `muted`** would relieve the pressure, but it
      breaks the approved invariant that the fire-time cap is the _only_
      pressure relief — a mute would become a second, quieter cooldown, the
      exact layered-mechanism creep the sandbox taught against.
    - **Pre-skipping the classifier when mutes make a fire impossible** is
      sound only in the corner where _every_ enabled category is under an
      active category-wide mute; the common case — one category muted after
      three skips — still needs the verdict to know whether the mute even
      applies.

    Accepted as-is, deliberately: the cost is bounded by the mute window,
    every such turn leaves a `muted` trace line, and the trace is exactly the
    field evidence that will show whether the window is ever loud enough to
    matter. Revisit only if it is; the fix would be local to
    `src/hooks/stop-decision.js`.

    Code documenting this: `src/hooks/stop-decision.js` (module header).
