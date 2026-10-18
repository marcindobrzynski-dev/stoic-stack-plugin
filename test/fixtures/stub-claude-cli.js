// Test fixture: a stub standing in for the Claude CLI's headless mode.
// The headless runner's spawn seam points at this script, so the integration
// suite exercises the real spawn path — real stdin delivery, real child
// environment, real timeout and buffer bounds — without a network call, an
// LLM, or an installed CLI.
//
// The first argument is the scenario; everything after it is the argument
// vector the runner itself built, echoed back so a test can assert the fixed
// flags (and the absence of the prompt) on the command line.
//
// The `verdict-*` scenarios are the exception to the echo rule: the classifier
// needs the envelope's result text to BE a verdict, so those answer one of the
// shared fixtures in `classifier-verdicts.js` instead of the received call.
//
// Guarded so it is inert outside the sandbox harness.
import fs from "node:fs";

import {
  NO_DECISION_VERDICT,
  PASS_VERDICT,
  VERDICT_SCENARIOS,
} from "./classifier-verdicts.js";

if (process.env.STOIC_TEST_SANDBOX !== "1") {
  process.exit(0);
}

const [scenario, ...args] = process.argv.slice(2);

let prompt = "";
try {
  prompt = fs.readFileSync(0, "utf8");
} catch {
  // No stdin attached; an empty prompt is the observable outcome.
}

const received = {
  prompt,
  args,
  stoic_internal: process.env.STOIC_INTERNAL ?? null,
};

/**
 * Emit what the CLI's `--output-format json` envelope looks like.
 *
 * @param {string} resultText - Model text carried in the envelope's `result`.
 * @param {string} [prefix] - Noise printed before the envelope.
 */
function printEnvelope(resultText, prefix = "") {
  process.stdout.write(
    prefix + JSON.stringify({ type: "result", result: resultText }),
  );
}

switch (scenario) {
  case "envelope":
    printEnvelope(JSON.stringify({ received }));
    break;

  case "structured_output":
    process.stdout.write(
      JSON.stringify({
        type: "result",
        result: "",
        structured_output: { received },
      }),
    );
    break;

  case "prose":
    printEnvelope(
      "Sure — here is the verdict:\n```json\n" +
        JSON.stringify({ received }) +
        "\n```\nLet me know if the shape { is wrong.",
    );
    break;

  case "banner":
    printEnvelope(JSON.stringify({ received }), "Warning: update available\n");
    break;

  case "malformed-result":
    printEnvelope("I could not produce a verdict, sorry.");
    break;

  case "malformed-envelope":
    process.stdout.write("not json at all");
    break;

  case "resultless-envelope":
    process.stdout.write(JSON.stringify({ type: "result", result: 42 }));
    break;

  case "nonzero":
    printEnvelope(JSON.stringify({ received }));
    process.exitCode = 3;
    break;

  case "oversized":
    printEnvelope(JSON.stringify({ filler: "x".repeat(200_000) }));
    break;

  case "hang":
    setTimeout(() => {}, 60_000);
    break;

  case VERDICT_SCENARIOS.pass:
    printEnvelope(JSON.stringify(PASS_VERDICT));
    break;

  case VERDICT_SCENARIOS.noDecision:
    printEnvelope(JSON.stringify(NO_DECISION_VERDICT));
    break;

  default:
    process.exit(9);
}
