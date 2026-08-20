import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDirectorySkipPredicate,
  IGNORED_GLOBS,
  isIgnoredDirectoryName,
} from "./ignored-directories.mjs";

test("skips worktree roots in every location tooling creates them", () => {
  // `.worktrees` is this repository's own convention. The bare name covers
  // nested locations such as `.claude/worktrees`, which previously produced
  // false nested-lockfile findings in the dependency checker and the scanner.
  assert.ok(isIgnoredDirectoryName(".worktrees"));
  assert.ok(isIgnoredDirectoryName("worktrees"));
});

test("skips generated bundler output whatever it is named", () => {
  // next.config.ts resolves its output directory from NEXT_DIST_DIR, so the
  // name cannot be enumerated. Matching is by prefix for that reason.
  for (const name of [
    ".next",
    ".next-dev",
    ".next-build",
    ".next-learn-verify",
    ".next-inspector-preview",
  ]) {
    assert.ok(isIgnoredDirectoryName(name), `${name} should be ignored`);
  }
});

test("skips dependency, build, and report directories", () => {
  for (const name of [
    ".git",
    ".turbo",
    "node_modules",
    "build",
    "dist",
    "coverage",
    "playwright-report",
    "test-results",
  ]) {
    assert.ok(isIgnoredDirectoryName(name), `${name} should be ignored`);
  }
});

test("does not skip source directories", () => {
  for (const name of [
    "apps",
    "packages",
    "scripts",
    "src",
    "server",
    "convex",
    "prisma",
    "next-steps",
    "nextcloud",
  ]) {
    assert.ok(!isIgnoredDirectoryName(name), `${name} must stay visible`);
  }
});

test("honours a consumer's own additions alongside the shared set", () => {
  const skip = createDirectorySkipPredicate(["_generated", "legacy"]);
  assert.ok(skip("_generated"));
  assert.ok(skip("legacy"));
  assert.ok(skip("node_modules"));
  assert.ok(skip(".worktrees"));
  assert.ok(!skip("apps"));
});

test("exposes the same rules as globs for glob-configured tools", () => {
  assert.ok(IGNORED_GLOBS.includes("**/node_modules/**"));
  assert.ok(IGNORED_GLOBS.includes("**/.worktrees/**"));
  assert.ok(IGNORED_GLOBS.includes("**/worktrees/**"));
  assert.ok(IGNORED_GLOBS.includes("**/.next*/**"));
});
