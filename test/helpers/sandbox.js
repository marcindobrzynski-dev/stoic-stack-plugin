import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Create an isolated sandbox for behavioral tests: a throwaway project
 * directory plus a throwaway home directory, so child processes resolving
 * Stoic Stack paths can never touch the contributor's real project or real
 * Claude home. `os.homedir()` honors `HOME` (POSIX) and `USERPROFILE`
 * (Windows), so overriding both redirects personal-state resolution.
 *
 * @param {import("node:test").TestContext} t - Test context; the sandbox is
 *   removed automatically after the test.
 * @returns {{
 *   projectDir: string,
 *   homeDir: string,
 *   env: Record<string, string|undefined>,
 *   runNode: (scriptPath: string, args?: string[]) => import("node:child_process").SpawnSyncReturns<string>,
 * }}
 */
export function createSandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stoic-stack-test-"));
  const projectDir = path.join(root, "project");
  const homeDir = path.join(root, "home");
  fs.mkdirSync(projectDir);
  fs.mkdirSync(homeDir);
  t.after(() =>
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }),
  );

  const env = {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    STOIC_TEST_SANDBOX: "1",
  };

  return {
    projectDir,
    homeDir,
    env,
    runNode(scriptPath, args = []) {
      return spawnSync(process.execPath, [scriptPath, ...args], {
        cwd: projectDir,
        env,
        encoding: "utf8",
      });
    },
  };
}
