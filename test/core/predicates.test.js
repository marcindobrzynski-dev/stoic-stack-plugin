// The shared coercions in the Domain-layer leaf. The boolean predicates are
// exercised through every suite that reads an untrusted document; these tests
// pin the numeric coercions, which carry range logic of their own.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EFFORT_RANGE,
  clampFinite,
  effortOf,
} from "../../src/core/predicates.js";

test("clampFinite clamps at both bounds and leaves the inside alone", () => {
  assert.equal(clampFinite(5, 0, 1), 1);
  assert.equal(clampFinite(-5, 0, 1), 0);
  assert.equal(clampFinite(0.4, 0, 1), 0.4);
  assert.equal(clampFinite(0, 0, 1), 0);
  assert.equal(clampFinite(1, 0, 1), 1);
});

test("clampFinite turns anything unusable for arithmetic into the fallback", () => {
  for (const value of [NaN, Infinity, -Infinity, "0.5", null, undefined, {}]) {
    assert.equal(clampFinite(value, 0, 1), 0);
  }
});

test("clampFinite honors a caller-chosen fallback", () => {
  assert.equal(clampFinite(undefined, 0, 1, 1), 1);
  assert.equal(clampFinite(NaN, -1, 1, -1), -1);
  assert.equal(clampFinite(0.5, 0, 1, 1), 0.5);
});

test("the effort range is the promised signal range and is frozen", () => {
  assert.deepEqual(EFFORT_RANGE, { min: -1, max: 1 });
  assert.ok(Object.isFrozen(EFFORT_RANGE));
});

test("effortOf clamps a logged effort to the promised range", () => {
  assert.equal(effortOf(3), EFFORT_RANGE.max);
  assert.equal(effortOf(-3), EFFORT_RANGE.min);
  assert.equal(effortOf(0.25), 0.25);
});

test("an unreadable effort is no signal at all", () => {
  for (const value of [NaN, Infinity, "1", null, undefined, []]) {
    assert.equal(effortOf(value), 0);
  }
});
