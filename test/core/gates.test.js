import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isMuted,
  matchCriticalPaths,
  pruneMutes,
} from "../../src/core/gates.js";

/** A mute entry exactly as `state.json` stores one, category-wide by default. */
function mute(overrides = {}) {
  return {
    category: "security",
    files: null,
    expires_at: 2_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Critical-path matching — the hard gate's only question.
// ---------------------------------------------------------------------------

test("a touched path containing a keyword returns that keyword", () => {
  assert.deepEqual(matchCriticalPaths(["src/auth/login.js"], ["auth"]), [
    "auth",
  ]);
});

test("matching is case-insensitive on both the path and the keyword", () => {
  assert.deepEqual(matchCriticalPaths(["SRC/Auth/Login.js"], ["auth"]), [
    "auth",
  ]);
  assert.deepEqual(matchCriticalPaths(["src/auth/login.js"], ["AUTH"]), [
    "AUTH",
  ]);
});

test("a backslash-separated path matches the same keywords as a slashed one", () => {
  const slashed = matchCriticalPaths(["src/auth/login.js"], ["auth/login"]);
  const backslashed = matchCriticalPaths(
    ["src\\auth\\login.js"],
    ["auth/login"],
  );
  assert.deepEqual(backslashed, slashed);
  assert.deepEqual(backslashed, ["auth/login"]);
});

test("a backslash-separated keyword also matches a forward-slash path", () => {
  assert.deepEqual(matchCriticalPaths(["src/auth/login.js"], ["auth\\login"]), [
    "auth\\login",
  ]);
});

test("every matching keyword is returned, in configured order", () => {
  const matched = matchCriticalPaths(
    ["src/auth/session.js", "db/migration/001.sql"],
    ["package.json", "auth", "migration"],
  );
  assert.deepEqual(matched, ["auth", "migration"]);
});

test("a keyword matched by several files is returned exactly once", () => {
  assert.deepEqual(
    matchCriticalPaths(["src/auth/a.js", "src/auth/b.js"], ["auth"]),
    ["auth"],
  );
});

test("matching is blunt substring matching, not path-segment matching", () => {
  // Deliberate trade-off, pinned so it cannot change by accident: the gate
  // is explainable and dependency-free at the cost of false positives.
  assert.deepEqual(matchCriticalPaths(["src/userservice.ts"], ["service"]), [
    "service",
  ]);
});

test("a path matching nothing returns no keywords", () => {
  assert.deepEqual(matchCriticalPaths(["src/core/gates.js"], ["auth"]), []);
});

test("no touched files and no keywords both yield no match", () => {
  assert.deepEqual(matchCriticalPaths([], ["auth"]), []);
  assert.deepEqual(matchCriticalPaths(["src/auth/login.js"], []), []);
});

test("an empty keyword never matches everything", () => {
  // An unguarded substring search treats "" as present in every path.
  for (const keyword of ["", null, undefined, 0, false]) {
    assert.deepEqual(matchCriticalPaths(["src/auth/login.js"], [keyword]), []);
  }
});

test("unusable entries are ignored without hiding the usable ones", () => {
  assert.deepEqual(
    matchCriticalPaths(
      [null, 42, { file: "src/auth/login.js" }, "src/auth/login.js"],
      [{}, "auth"],
    ),
    ["auth"],
  );
});

test("anything that is not a list of files or keywords matches nothing", () => {
  for (const input of [undefined, null, 42, "src/auth", { files: [] }]) {
    assert.deepEqual(matchCriticalPaths(input, ["auth"]), []);
    assert.deepEqual(matchCriticalPaths(["src/auth/login.js"], input), []);
  }
});

test("matching leaves its inputs untouched", () => {
  const files = ["SRC\\Auth\\login.js"];
  const keywords = ["auth"];
  matchCriticalPaths(files, keywords);
  assert.deepEqual(files, ["SRC\\Auth\\login.js"]);
  assert.deepEqual(keywords, ["auth"]);
});

// ---------------------------------------------------------------------------
// Mute evaluation — same category, plus one of three reasons.
// ---------------------------------------------------------------------------

test("no mutes at all means nothing is muted", () => {
  assert.equal(isMuted([], "security", ["src/auth/login.js"], 1_000), false);
});

test("a category-wide mute suppresses its category whatever the files", () => {
  const mutes = [mute({ files: null })];
  assert.equal(isMuted(mutes, "security", ["src/auth/a.js"], 1_000), true);
  assert.equal(isMuted(mutes, "security", [], 1_000), true);
});

test("a mute never reaches across categories", () => {
  const mutes = [mute({ category: "security", files: null })];
  assert.equal(isMuted(mutes, "data_model", ["src/auth/a.js"], 1_000), false);
});

test("categories are compared exactly, without case folding", () => {
  const mutes = [mute({ category: "security", files: null })];
  assert.equal(isMuted(mutes, "Security", ["src/auth/a.js"], 1_000), false);
});

test("a fingerprint mute suppresses only a turn that touches one of its files", () => {
  const mutes = [mute({ files: ["src/auth/login.js", "src/auth/token.js"] })];
  assert.equal(isMuted(mutes, "security", ["src/auth/token.js"], 1_000), true);
  assert.equal(isMuted(mutes, "security", ["src/core/gates.js"], 1_000), false);
});

test("fingerprint overlap ignores case and separator differences", () => {
  const mutes = [mute({ files: ["src/auth/login.js"] })];
  assert.equal(
    isMuted(mutes, "security", ["SRC\\Auth\\Login.js"], 1_000),
    true,
  );
});

test("a fingerprint mute recorded with no files is category-scoped", () => {
  // A prompt-only pause has no touched files. Without this rule the identical
  // pause re-fires every turn, because an empty fingerprint overlaps nothing.
  const mutes = [mute({ files: [] })];
  assert.equal(isMuted(mutes, "security", ["src/core/gates.js"], 1_000), true);
  assert.equal(isMuted(mutes, "security", [], 1_000), true);
  assert.equal(isMuted(mutes, "data_model", [], 1_000), false);
});

test("a stored files field that is neither null nor an array suppresses nothing", () => {
  // Only `null` (or omission) means "whole category" — that spelling is the
  // frozen contract. Any other non-array is a corrupt entry, and a corrupt
  // mute must not widen into silencing the whole category.
  for (const files of ["src/auth/login.js", 42, {}, true]) {
    const mutes = [mute({ files })];
    assert.equal(
      isMuted(mutes, "security", ["src/auth/login.js"], 1_000),
      false,
    );
  }
});

test("a fingerprint of only unusable entries suppresses nothing", () => {
  // Only a literally empty stored `files: []` means category-scoped. A
  // non-empty fingerprint whose every entry is garbage is a corrupt mute,
  // and a corrupt mute must not widen into silencing the whole category.
  const mutes = [mute({ files: ["", 42, null] })];
  assert.equal(isMuted(mutes, "security", ["src/core/gates.js"], 1_000), false);
  assert.equal(isMuted(mutes, "security", [], 1_000), false);
});

test("a turn touching no files is not muted by a populated fingerprint", () => {
  const mutes = [mute({ files: ["src/auth/login.js"] })];
  assert.equal(isMuted(mutes, "security", [], 1_000), false);
});

test("one matching mute among many is enough", () => {
  const mutes = [
    mute({ category: "data_model", files: ["db/schema.sql"] }),
    mute({ category: "security", files: ["src/auth/login.js"] }),
  ];
  assert.equal(isMuted(mutes, "security", ["src/auth/login.js"], 1_000), true);
});

// ---------------------------------------------------------------------------
// The expiry boundary — a mute is active while `now` is before `expires_at`.
// ---------------------------------------------------------------------------

test("a mute is active right up to, but not at, its expiry instant", () => {
  const mutes = [mute({ expires_at: 2_000, files: null })];
  assert.equal(isMuted(mutes, "security", [], 1_999), true);
  assert.equal(isMuted(mutes, "security", [], 2_000), false);
  assert.equal(isMuted(mutes, "security", [], 2_001), false);
});

test("an expired mute suppresses nothing even on a perfect fingerprint match", () => {
  const mutes = [mute({ files: ["src/auth/login.js"], expires_at: 500 })];
  assert.equal(isMuted(mutes, "security", ["src/auth/login.js"], 1_000), false);
});

test("a mute with an unusable expiry is treated as expired", () => {
  for (const expires of [undefined, null, "2000", Number.NaN, Infinity]) {
    const mutes = [mute({ files: null, expires_at: expires })];
    assert.equal(isMuted(mutes, "security", [], 1_000), false);
  }
});

test("an unusable current time mutes nothing rather than muting forever", () => {
  const mutes = [mute({ files: null, expires_at: Number.MAX_SAFE_INTEGER })];
  for (const now of [undefined, null, "1000", Number.NaN, Infinity]) {
    assert.equal(isMuted(mutes, "security", [], now), false);
  }
});

// ---------------------------------------------------------------------------
// Mute robustness — a hand-edited state.json can hold anything.
// ---------------------------------------------------------------------------

test("malformed mute entries are skipped without hiding the usable ones", () => {
  const mutes = [
    null,
    42,
    "muted",
    ["security"],
    { category: 7, files: null, expires_at: 2_000 },
    { files: null, expires_at: 2_000 },
    mute({ files: null }),
  ];
  assert.equal(isMuted(mutes, "security", [], 1_000), true);
});

test("anything that is not a mute list mutes nothing", () => {
  for (const input of [undefined, null, 42, "mutes", { mutes: [] }]) {
    assert.equal(isMuted(input, "security", [], 1_000), false);
  }
});

test("an unusable category is never muted", () => {
  const mutes = [mute({ files: null })];
  for (const category of [undefined, null, "", 42, {}]) {
    assert.equal(isMuted(mutes, category, [], 1_000), false);
  }
});

test("an unusable files list reads as a turn that touched nothing", () => {
  const wide = [mute({ files: null })];
  const fingerprint = [mute({ files: ["src/auth/login.js"] })];
  for (const files of [undefined, null, 42, "src/auth/login.js", {}]) {
    assert.equal(isMuted(wide, "security", files, 1_000), true);
    assert.equal(isMuted(fingerprint, "security", files, 1_000), false);
  }
});

test("evaluating a mute leaves the state's mute list untouched", () => {
  const mutes = [mute({ files: ["src/auth/login.js"] })];
  const before = structuredClone(mutes);
  isMuted(mutes, "security", ["SRC\\Auth\\Login.js"], 1_000);
  assert.deepEqual(mutes, before);
});

// ---------------------------------------------------------------------------
// Pruning — state hygiene, on the same boundary as evaluation.
// ---------------------------------------------------------------------------

test("pruning keeps active mutes and drops expired ones", () => {
  const active = mute({ category: "security", expires_at: 2_000 });
  const expired = mute({ category: "data_model", expires_at: 500 });
  assert.deepEqual(pruneMutes([expired, active], 1_000), [active]);
});

test("pruning uses the same boundary as evaluation: expiry instant is expired", () => {
  const atBoundary = mute({ expires_at: 2_000 });
  assert.deepEqual(pruneMutes([atBoundary], 1_999), [atBoundary]);
  assert.deepEqual(pruneMutes([atBoundary], 2_000), []);
});

test("pruning drops entries that are not usable mutes at all", () => {
  const keeper = mute({ expires_at: 2_000 });
  const pruned = pruneMutes(
    [
      null,
      42,
      "mute",
      { category: "security" },
      { expires_at: "2000" },
      keeper,
    ],
    1_000,
  );
  assert.deepEqual(pruned, [keeper]);
});

test("pruning anything that is not a mute list yields an empty list", () => {
  for (const input of [undefined, null, 42, "mutes", { mutes: [] }]) {
    assert.deepEqual(pruneMutes(input, 1_000), []);
  }
});

test("pruning with an unusable time keeps the list as it stands", () => {
  const mutes = [mute({ expires_at: 500 }), mute({ expires_at: 2_000 })];
  for (const now of [undefined, null, "1000", Number.NaN]) {
    assert.deepEqual(pruneMutes(mutes, now), mutes);
  }
});

test("pruning returns a new list and never mutates the one it was given", () => {
  const mutes = [mute({ expires_at: 500 }), mute({ expires_at: 2_000 })];
  const before = structuredClone(mutes);
  const pruned = pruneMutes(mutes, 1_000);
  assert.notEqual(pruned, mutes);
  assert.deepEqual(mutes, before);
  assert.equal(pruned.length, 1);
});

test("a pruned list mutes exactly what evaluation would have muted", () => {
  const mutes = [
    mute({ category: "security", files: null, expires_at: 500 }),
    mute({ category: "data_model", files: null, expires_at: 2_000 }),
  ];
  const pruned = pruneMutes(mutes, 1_000);
  assert.equal(isMuted(pruned, "security", [], 1_000), false);
  assert.equal(isMuted(pruned, "data_model", [], 1_000), true);
});
