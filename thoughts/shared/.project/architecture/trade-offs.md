---
version: 0.2.0
last_update: 2026-10-06
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

2. **Scoring is only partly calibrated.** On 2026-10-06 real-usage logs
   adjusted three knobs: `weight_effort`, `question_relief`, and the preset
   defaults of `delegated_discount` (trade-off 10). Read those as
   calibration. Every other threshold, weight, half-life, cap, and mute
   duration is still a placeholder, and the prompt-effort heuristic is still
   a crude regex-based signal. Do not read meaning into the numbers this
   trade-off does not name. Calibrating the rest remains post-PoC work.

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

6. **The default classifier model is a canonical model id (`claude-haiku-5-5`).**
   A hardcoded model default will age; it is user-overridable via
   `classifier_model` and must be reviewed at release time. On the
   structured-state Jev experiment branch, `FALLBACK_MODEL` re-exports
   `DEFAULT_CLASSIFIER_MODEL` so the default classifier and the Jev
   infrastructure fallback share a single source of truth.

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

10. **Delegated volume is weighed by `delegated_discount`, not dropped.**
    Autopilot is defined as low user thought, not high machine output (see the
    [domain glossary](glossary.md)). The knob weighs delegated volume; prompt
    effort stays in the delta either way. A value of 1 charges delegated
    edits and lines in full, and `advanced.delegated_discount` may set any
    fraction from 0 to 1 on any preset. This refines (does not remove) the
    earlier per-event attribution decision in trade-off 4.

    The preset defaults, adjusted 2026-10-06 from real-usage logs, are
    calibration and nothing more than defaults. `calm` ships at 0.5.
    `balanced` and `vigilant` ship at 1. The logs showed that once the
    developer's work moved to orchestrating sub-agents, a 0.5 discount on
    the default preset halved what little volume remained and the score
    stopped reaching the threshold. The same pass lowered `question_relief`,
    which wiped out much of a turn, and raised `weight_effort`. A project
    that wants the old discount back sets `advanced.delegated_discount`;
    that override is the supported path, not a contradiction of this
    trade-off. The other scoring numbers stay placeholders (trade-off 2).

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
    mostly still placeholders (trade-off 2) — a duplicated or missing event
    shifts a score that decays by half-life anyway. Revisit only if field
    traces show real
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
    score (and, on the structured-state Jev experiment branch, a veto of
    `no_classification`, `no_decision`, or `low_confidence` caps the score to
    `threshold × VETO_COOLDOWN_RATIO`), so a category mute over a still-loud
    score means every turn above
    the threshold spawns a real headless call (cost, plus up to its 45s
    budget of turn-end latency) whose verdict is then discarded as `muted` —
    for up to `category_mute_ms`, the worst case being the 24-hour
    three-skips mute.

    Two remedies were weighed and rejected for the PoC:

    - **Cooling the score on `muted`** would relieve the pressure, but it
      breaks the approved rule that relief belongs to a pause that actually
      happened — a mute would become a second, quieter cooldown attached to no
      pause at all, the exact layered-mechanism creep the sandbox taught
      against. (Trade-off 14 later added a second relief _moment_; it did not
      loosen this rule, since that moment is a completed reflection.)
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

14. **The score has two writers, not one.** Manual reflection needed a reward,
    and a reward is a write to the score from outside any turn boundary — so
    `src/cli/record.js` joins the Stop hook as a second writer. This
    _partially supersedes_ trade-off 3: its claims still hold for the
    automatic path (one writer, one turn boundary, load-bearing session-log
    truncation), but "one writer" is no longer true of the score. Accepted
    because the alternative is worse than the exception: a reflection that
    left the score untouched would leave the developer who reflected facing
    the same pressure as the developer who did not, which is the whole point
    of the feature.

    The exception is kept narrow by construction — one shared pure function,
    no writer able to raise the score, and a reward paid only for a completed
    reflection — as specified in
    [configuration.md §Score relief](configuration.md). An unreadable factor
    floors to no reward rather than to a raise, so a second writer cannot
    manufacture pressure — only forgive it.

    Three alternatives were weighed and rejected:

    - **Reward in the writer (`reflect.js`) instead.** One writer's worth of
      code less, but it pays at the moment of the _request_, making the
      escape hatch above the cheapest path in the plugin. Rejected.
    - **No reward at all — a manual reflection is its own payment.** Keeps
      the single-writer invariant intact, but leaves a reflecting developer
      pressed toward a pause they have just pre-empted, and the engine then
      fires over work already reflected on. Rejected.
    - **A knob for the factor.** Rejected twice over: registering
      `manual_relief_factor` in `KNOB_NAMES` forces `config.js` to import the
      manual-reflection module that already imports it — a cycle — and the
      value describes the mechanism rather than a user's sensitivity, exactly
      like `cooldown_ratio`, which is identical across all three presets. It
      is a module constant; `normalizeAdvanced` iterates `KNOB_NAMES` only, so
      a config carrying the name is dropped rather than honored.

    The number itself is an uncalibrated placeholder, as are the scoring
    numbers trade-off 2 still leaves untouched.

    Code documenting this: `src/core/scoring.js` (module header,
    `relievedScore`, `rewardedScore`), `src/cli/record.js`
    (`rewardManualReflection`), and `src/io/config/manual-reflection.js`
    (`MANUAL_RELIEF_FACTOR`).

15. **Edits outside the Project Root stay dropped.** The PostToolUse hook
    drops them as `outside_project`, one of the
    [self-instrumentation guards](data-flow.md) that keep the plugin from
    scoring its own machinery. Counting them would add volume back for a
    developer who orchestrates sub-agents, but they stay dropped for a second
    reason, scope: work outside the repository (visualizations, helper tests,
    other folders) is not work on the project the score measures, so it is
    not evidence of autopilot there.

    Code documenting this: `src/hooks/post-tool-use.js` (`locateEdit`).

16. **Veto cooldown (`0.8 * threshold`) prevents repeated classifier calls on
    consecutive turns after a veto.** Under the `e4b111e` baseline, a
    classifier veto left `state.score` above `threshold`, so every subsequent
    turn whose decayed score plus turn delta stayed at or above `threshold`
    triggered another full classifier call even when the work was routine. On
    the structured-state Jev experiment branch, `decideFire` caps `state.score`
    to `relievedScore(score, threshold, VETO_COOLDOWN_RATIO)` (`0.8 * threshold`)
    on `no_classification`, `no_decision`, and `low_confidence` vetoes, on the
    plain Haiku path as well as the Jev path, while
    a fired pause cools further to `0.5 * threshold`. `bad_category` does not
    cool. Jev `confidence` is
    `min(1, configuredConfidenceFloor × pause_probability / PAUSE_THRESHOLDS[preset])`.
    The floor is the preset's `classifier_confidence_threshold` when the
    preset defines one; the shipped presets do not, so it is the project
    setting, default `0.6`. Any Jev category failure discards that result and
    runs the Haiku classifier on the same prompt and context. The summary log
    keeps `category_failed`, names the broken Jev categories in
    `jev_failed_categories`, and stores Haiku's label in `haiku_category` and
    `haiku_subcategory`, so a broken Jev category is not read as Haiku's
    category. If Haiku also fails, the veto reason is `no_classification`.
    Offline evaluation
    (`experiments/jev/eval/run-eval.js`) compares both trajectories explicitly,
    labels synthetic fixture runs `"SIMULATED"` and read-only trace/summary
    replays `"REAL-DATA"`, and does not report a real-data formula accuracy
    built by treating a missing input as zero. Replay accepts numeric epoch
    milliseconds and ISO timestamps, keeps a separate score per project, and
    does not count a muted Stop as a classifier call. A below-gates Stop that
    crosses the gate only inside the replay is cooled as a veto on the default
    trajectory (logged `below_gates` only); `replay_only_calls_not_cooled`
    keeps the uncooled alternative. Those replayed numbers are labelled
    `"REAL-DATA (replay projection)"`.
    Calm and vigilant do not rebuild the turn delta with their own
    `weight_edits` and `weight_diff`: they reuse the delta already stored in
    the trace, which field logs wrote under balanced weights. A logged pause
    receives the `0.5 * threshold` relief only when the replay calls the
    classifier on that same turn; a logged pause the replay never reaches is
    left without that relief.
