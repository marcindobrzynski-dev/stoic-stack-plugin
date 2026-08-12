// The verdicts the stub Claude CLI can be told to answer with.
//
// They live in their own module because two processes need to agree on them:
// the stub (`stub-claude-cli.js`, which prints one inside a CLI envelope) and
// the suite that asserts what the classifier made of it. A literal repeated on
// both sides of a spawn is a literal that can silently drift.
//
// Each is a raw model verdict, not a validated classification — the shape
// `payloads.md` § "Classifier verdict (LLM #1)" describes, before
// `validateClassification` resolves the subcategory to its enabled area.

/** A confident, decision-bearing verdict under the `security` area. */
export const PASS_VERDICT = Object.freeze({
  decision_found: true,
  subcategory: "authorization",
  reason: "The turn changed who may read another tenant's records.",
  confidence: 0.9,
});

/** A verdict that found no consequential decision — the `no_decision` veto. */
export const NO_DECISION_VERDICT = Object.freeze({
  decision_found: false,
  subcategory: null,
  reason: "The turn only renamed a local variable.",
  confidence: 0.95,
});

/** The scenario names the stub answers each verdict under. */
export const VERDICT_SCENARIOS = Object.freeze({
  pass: "verdict-pass",
  noDecision: "verdict-no-decision",
});
