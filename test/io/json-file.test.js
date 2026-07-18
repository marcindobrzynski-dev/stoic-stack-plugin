import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { readJsonFile, writeJsonFileAtomic } from "../../src/io/json-file.js";
import { makeTempDir } from "../helpers/temp-dir.js";

test("reading a missing document reports missing", (t) => {
  const dir = makeTempDir(t, "stoic-json-");

  const result = readJsonFile(path.join(dir, "absent.json"));

  assert.deepEqual(result, { status: "missing" });
});

test("reading a missing document never creates its parent directories", (t) => {
  const dir = makeTempDir(t, "stoic-json-");

  readJsonFile(path.join(dir, ".stoic", "config.json"));

  assert.deepEqual(fs.readdirSync(dir), []);
});

test("reading a valid document returns its parsed value", (t) => {
  const dir = makeTempDir(t, "stoic-json-");
  const filePath = path.join(dir, "doc.json");
  fs.writeFileSync(filePath, '{ "enabled": true, "score": 0 }', "utf8");

  const result = readJsonFile(filePath);

  assert.equal(result.status, "ok");
  assert.deepEqual(result.value, { enabled: true, score: 0 });
});

test("reading a corrupt document reports invalid instead of throwing", (t) => {
  const dir = makeTempDir(t, "stoic-json-");
  const filePath = path.join(dir, "corrupt.json");
  fs.writeFileSync(filePath, "{ not json", "utf8");

  const result = readJsonFile(filePath);

  assert.equal(result.status, "invalid");
  assert.ok(result.error instanceof Error);
});

test("an unreadable document reports invalid instead of throwing", (t) => {
  const dir = makeTempDir(t, "stoic-json-");

  const result = readJsonFile(dir);

  assert.equal(result.status, "invalid");
  assert.ok(result.error instanceof Error);
});

test("a successful write leaves one complete, parseable document", (t) => {
  const dir = makeTempDir(t, "stoic-json-");
  const filePath = path.join(dir, "state.json");

  writeJsonFileAtomic(filePath, { score: 0, mutes: [] });

  assert.deepEqual(readJsonFile(filePath), {
    status: "ok",
    value: { score: 0, mutes: [] },
  });
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
});

test("writing creates missing parent directories", (t) => {
  const dir = makeTempDir(t, "stoic-json-");
  const filePath = path.join(
    dir,
    ".claude",
    "stoic-stack",
    "slug",
    "state.json",
  );

  writeJsonFileAtomic(filePath, { score: 0 });

  assert.equal(readJsonFile(filePath).status, "ok");
});

test("overwriting replaces the document and leaves no temporary files", (t) => {
  const dir = makeTempDir(t, "stoic-json-");
  const filePath = path.join(dir, "config.json");
  writeJsonFileAtomic(filePath, { preset: "balanced" });

  writeJsonFileAtomic(filePath, { preset: "vigilant" });

  assert.deepEqual(readJsonFile(filePath).value, { preset: "vigilant" });
  assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
});

test("a non-serializable value throws and leaves the previous document untouched", (t) => {
  const dir = makeTempDir(t, "stoic-json-");
  const filePath = path.join(dir, "config.json");
  writeJsonFileAtomic(filePath, { preset: "calm" });
  const before = fs.readFileSync(filePath);
  const circular = {};
  circular.self = circular;

  assert.throws(() => writeJsonFileAtomic(filePath, circular), TypeError);

  assert.deepEqual(fs.readFileSync(filePath), before);
  assert.deepEqual(fs.readdirSync(dir), ["config.json"]);
});

test("an undefined value is rejected before touching the filesystem", (t) => {
  const dir = makeTempDir(t, "stoic-json-");
  const filePath = path.join(dir, "config.json");

  assert.throws(() => writeJsonFileAtomic(filePath, undefined), TypeError);

  assert.deepEqual(fs.readdirSync(dir), []);
});
