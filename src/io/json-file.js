// Fail-safe JSON document helpers used by the configuration and state
// writers — two plain functions, not a persistence layer.
//
// Reads never throw and never create anything; they report a status so
// callers can distinguish a document that is absent (safe to initialize)
// from one that is present but unusable (must not be silently overwritten).
// Writes are atomic: the document is serialized up front, written to a
// temporary file in the target directory, then renamed over the target, so a
// successful write always leaves exactly one complete, parseable document
// and a failed write leaves the previous document untouched.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * @typedef {{ status: "ok", value: unknown }
 *   | { status: "missing" }
 *   | { status: "invalid", error: Error }} JsonReadResult
 */

/**
 * Read and parse a JSON document without throwing.
 *
 * @param {string} filePath - Document location.
 * @returns {JsonReadResult} `ok` with the parsed value, `missing` when the
 *   document does not exist, or `invalid` when it exists but cannot be read
 *   or parsed.
 */
export function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return { status: "missing" };
    }
    return { status: "invalid", error };
  }
  try {
    return { status: "ok", value: JSON.parse(raw) };
  } catch (error) {
    return { status: "invalid", error };
  }
}

/**
 * Atomically persist a value as a complete JSON document, creating missing
 * parent directories. Serialization failures throw before the filesystem is
 * touched; write failures leave the previous document byte-for-byte intact.
 *
 * @param {string} filePath - Target document location.
 * @param {unknown} value - JSON-serializable value.
 * @throws {TypeError} When the value is not JSON-serializable.
 * @throws {Error} When the filesystem write or rename fails.
 */
export function writeJsonFileAtomic(filePath, value) {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) {
    throw new TypeError("value is not JSON-serializable");
  }
  const target = path.resolve(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmpPath = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${json}\n`, "utf8");
    fs.renameSync(tmpPath, target);
  } catch (error) {
    try {
      fs.rmSync(tmpPath, { force: true, maxRetries: 2 });
    } catch {
      // Best-effort cleanup; the write failure below is the error that matters.
    }
    throw error;
  }
}
