// Test fixture: persist a probe document at the resolved personal-state
// location for the current project. Guarded so it is inert outside the
// sandbox harness — it must never write into a contributor's real home.
import { writeJsonFileAtomic } from "../../src/io/json-file.js";
import { personalStatePath } from "../../src/io/paths.js";

if (process.env.STOIC_TEST_SANDBOX !== "1") {
  process.exit(0);
}

const statePath = personalStatePath(process.cwd());
writeJsonFileAtomic(statePath, { probe: true });

console.log(JSON.stringify({ statePath }));
