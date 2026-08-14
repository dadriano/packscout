#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(readOption("--root") ?? defaultRoot);
const checkerPath = path.resolve(fileURLToPath(import.meta.url));
const sourceRoots = ["apps", "packages", "scripts"];
const checkedExtensions = new Set([
  ".cjs",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".prisma",
  ".sql",
  ".ts",
  ".tsx",
]);
const skippedDirectories = new Set([
  ".git",
  ".next",
  ".tasks",
  ".worktrees",
  "build",
  "coverage",
  "dist",
  "docs",
  "node_modules",
]);
const forbiddenFragments = [
  ["provider", "-feed"].join(""),
  ["Provider", "FeedPageV1"].join(""),
  ["Provider", "FeedValidatedPageV1"].join(""),
  ["Catalog", "EnvelopeV1"].join(""),
  ["Pull", "EnvelopeV1"].join(""),
  ["Sale", "EnvelopeV1"].join(""),
  ["http", "-cursor-v1"].join(""),
  ["assert", "StreamLocalPageCommitV2"].join(""),
];
const supersededTaskMarker = "Superseded implementation artifact (2026-08-14).";
const historicalTaskArtifacts = [
  "_index.md",
  "002-establish-provider-feed-contract.md",
  "014-map-beezie-and-clutchpacks.md",
  "015-map-collector-crypt-and-courtyard.md",
  "016-map-gamestop-and-phygitals.md",
  "017-map-stadium-vault-and-trove.md",
  "018-validate-backfill-and-incremental-launch.md",
  "tech-002-provider-feed-storage-and-history.md",
  "tech-004-canonical-projections-and-estimated-ev.md",
  "tech-006-provider-mappings-and-launch-verification.md",
];

function relative(filePath) {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

function shouldCheckFile(filePath) {
  if (path.resolve(filePath) === checkerPath) return false;
  return checkedExtensions.has(path.extname(filePath).toLowerCase());
}

async function walk(directory, files = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && skippedDirectories.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(entryPath, files);
    else if (entry.isFile() && shouldCheckFile(entryPath)) files.push(entryPath);
  }
  return files;
}

function findFragment(value) {
  const normalized = value.toLowerCase();
  return forbiddenFragments.find((fragment) =>
    normalized.includes(fragment.toLowerCase()),
  );
}

async function main() {
  const files = [];
  for (const root of sourceRoots) await walk(path.join(repositoryRoot, root), files);
  const violations = [];
  for (const file of [...new Set(files)].sort()) {
    const fileRelative = relative(file);
    const pathFragment = findFragment(fileRelative);
    if (pathFragment) {
      violations.push(`${fileRelative}: legacy V1 path contains ${pathFragment}`);
      continue;
    }
    let content;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const contentFragment = findFragment(content);
    if (contentFragment) {
      violations.push(`${fileRelative}: executable content contains ${contentFragment}`);
    }
  }
  const taskDirectory = path.join(repositoryRoot, ".tasks", "data-pipeline");
  const taskDirectoryExists = await readdir(taskDirectory).then(
    () => true,
    () => false,
  );
  if (taskDirectoryExists) {
    for (const artifact of historicalTaskArtifacts) {
      const artifactPath = path.join(taskDirectory, artifact);
      const content = await readFile(artifactPath, "utf8").catch(() => null);
      if (content === null || !content.includes(supersededTaskMarker)) {
        violations.push(
          `.tasks/data-pipeline/${artifact}: legacy design must stay explicitly superseded`,
        );
      }
    }
  }
  if (violations.length === 0) {
    console.log(`check:provider-v2-only ok — scanned ${files.length} executable files`);
    return;
  }
  console.error(`Provider V2-only check failed with ${violations.length} finding(s):`);
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
}

main().catch(() => {
  console.error("check:provider-v2-only failed unexpectedly.");
  process.exit(2);
});
