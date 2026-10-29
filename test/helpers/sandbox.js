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
  // Inherited from a Claude Code session, it names the real repository, and
  // the resolver would pick it over the sandbox project.
  delete env.CLAUDE_PROJECT_DIR;

  return {
    projectDir,
    homeDir,
    env,
    /**
     * Run a real entrypoint as a child process inside the sandbox.
     *
     * @param {string} scriptPath - Absolute path of the entrypoint.
     * @param {string[]} [args] - Process arguments.
     * @param {{input?: string, env?: Record<string, string|undefined>, cwd?: string}} [options]
     *   `input` is written to the child's stdin (hooks read their payload from
     *   fd 0); `env` replaces the sandbox environment wholesale, so a caller
     *   that only wants to add a variable spreads `sandbox.env` itself; `cwd`
     *   starts the child somewhere other than the project directory.
     */
    runNode(scriptPath, args = [], options = {}) {
      return spawnSync(process.execPath, [scriptPath, ...args], {
        cwd: options.cwd ?? projectDir,
        env: options.env ?? env,
        encoding: "utf8",
        input: options.input,
      });
    },
  };
}
