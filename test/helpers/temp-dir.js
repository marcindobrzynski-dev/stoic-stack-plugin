import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Create a throwaway directory under the system temp root, removed
 * automatically after the owning test.
 *
 * @param {import("node:test").TestContext} t - Test context that owns the directory.
 * @param {string} prefix - Prefix for the generated directory name.
 * @returns {string} Absolute path of the new directory.
 */
export function makeTempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() =>
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }),
  );
  return dir;
}
