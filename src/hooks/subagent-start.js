#!/usr/bin/env node
// SubagentStart — record that a sub-agent began working.
//
// The lifecycle events carry no volume of their own; the work a sub-agent does
// arrives as delegated edit events. What they add is shape: a turn group can
// tell a deliberate fan-out from a single stream of edits without the plugin
// keeping any live count of who is running.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §`Session event log` (subagent_start event).
import { agentTypeOf, runCaptureHook } from "./capture.js";

runCaptureHook("SubagentStart", (payload) => ({
  event: {
    type: "subagent_start",
    ts: Date.now(),
    agent_type: agentTypeOf(payload),
  },
}));
