#!/usr/bin/env node
// SubagentStop — record that a sub-agent finished.
//
// The twin of subagent-start.js, and deliberately just as thin. Pairing starts
// with stops is the turn group's job; this hook only states what happened, so
// an unmatched start (a session that ended mid-fan-out) costs nothing here.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §`Session event log` (subagent_stop event).
import { agentTypeOf, runCaptureHook } from "./capture.js";

runCaptureHook("SubagentStop", (payload) => ({
  event: {
    type: "subagent_stop",
    ts: Date.now(),
    agent_type: agentTypeOf(payload),
  },
}));
