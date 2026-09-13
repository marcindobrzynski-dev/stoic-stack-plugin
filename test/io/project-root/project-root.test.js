import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { resolveProjectRoot } from "../../../src/io/project-root.js";
import { initRepo } from "../../helpers/git-repo.js";
import { makeTempDir } from "../../helpers/temp-dir.js";

// --- Gate 1: git names the root -----------------------------------------------

test("a start deep inside a repository resolves to the repository root", (t) => {
  const repo = initRepo(
    path.join(makeTempDir(t, "stoic-project-root-"), "repo"),
  );
  const start = path.join(repo, "src", "deep");
  fs.mkdirSync(start, { recursive: true });

  // A hook sees the subdirectory twice: as its own cwd and as the payload's.
  assert.equal(resolveProjectRoot(start, start), path.resolve(repo));
});

// --- Gate 2: the nearest configuration names the root -------------------------

test("a start below a configured project, outside any repository, resolves to the configured directory", (t) => {
  const project = path.join(makeTempDir(t, "stoic-project-root-"), "project");
  fs.mkdirSync(path.join(project, ".stoic"), { recursive: true });
  fs.writeFileSync(path.join(project, ".stoic", "config.json"), "{}\n");
  const start = path.join(project, "src", "deep");
  fs.mkdirSync(start, { recursive: true });

  assert.equal(resolveProjectRoot(start, start), path.resolve(project));
});

// --- Precedence: git outranks a subproject's own configuration ----------------

test("a start inside a configured subproject of a repository still resolves to the repository root", (t) => {
  const repo = initRepo(
    path.join(makeTempDir(t, "stoic-project-root-"), "repo"),
  );
  const subproject = path.join(repo, "packages", "sub");
  fs.mkdirSync(path.join(subproject, ".stoic"), { recursive: true });
  fs.writeFileSync(path.join(subproject, ".stoic", "config.json"), "{}\n");
  const start = path.join(subproject, "src");
  fs.mkdirSync(start, { recursive: true });

  // Gate 2 alone would answer `subproject`; the test only means something
  // because the two gates disagree.
  assert.equal(resolveProjectRoot(start, start), path.resolve(repo));
});
