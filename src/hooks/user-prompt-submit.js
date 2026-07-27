#!/usr/bin/env node
// UserPromptSubmit — record what the developer just asked for.
//
// The prompt event is the engine's primary autopilot signal, and it is written
// here rather than derived later: effort is computed at submit time from the
// text as typed, and the log keeps that judgment. The Stop hook never
// recomputes it, so a change to the heuristic cannot retroactively rescore a
// turn that already happened.
//
// Two prompts are not the user's thinking and are treated accordingly:
// the plugin's own `/stoic-stack` invocations are not observed at all (using
// Stoic Stack must never feed Stoic Stack's score), and harness-injected
// notifications are logged as `neutralized` at zero effort — the turn happened,
// but no human typed it.
//
// Contract: thoughts/shared/.project/architecture/payloads.md
// §`Session event log` (prompt event).
import {
  isHarnessInjection,
  isOwnPluginPrompt,
  promptEffort,
  truncatePrompt,
} from "../core/prompts.js";
import { permissionModeOf, runCaptureHook } from "./capture.js";

runCaptureHook("UserPromptSubmit", (payload) => {
  const { prompt } = payload;
  if (isOwnPluginPrompt(prompt)) {
    return { outcome: "own_prompt_ignored" };
  }
  // A missing or non-string prompt is logged as an empty one rather than
  // rejected: the signal functions judge any input shape, and the turn group
  // still needs to know a turn began.
  return {
    event: {
      type: "prompt",
      ts: Date.now(),
      prompt: truncatePrompt(prompt),
      effort: promptEffort(prompt),
      permission_mode: permissionModeOf(payload),
      neutralized: isHarnessInjection(prompt),
    },
  };
});
