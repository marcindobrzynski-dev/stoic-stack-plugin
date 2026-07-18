// Test fixture: resolve every Stoic Stack location for the current project
// and inspect the (absent) configuration, proving reads create nothing.
// Guarded so it is inert outside the sandbox harness — it must never run
// against a contributor's real home.
import os from "node:os";

import { readJsonFile } from "../../src/io/json-file.js";
import {
  personalStateDir,
  personalStatePath,
  projectConfigPath,
  projectSlug,
  projectStoicDir,
} from "../../src/io/paths.js";

if (process.env.STOIC_TEST_SANDBOX !== "1") {
  process.exit(0);
}

const projectDir = process.cwd();

console.log(
  JSON.stringify({
    home: os.homedir(),
    slug: projectSlug(projectDir),
    stoicDir: projectStoicDir(projectDir),
    configPath: projectConfigPath(projectDir),
    configReadStatus: readJsonFile(projectConfigPath(projectDir)).status,
    stateDir: personalStateDir(projectDir),
    statePath: personalStatePath(projectDir),
  }),
);
