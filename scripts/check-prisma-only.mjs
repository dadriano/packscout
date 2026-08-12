#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const defaultRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(readOption("--root") ?? defaultRoot);
const checkerPath = path.resolve(fileURLToPath(import.meta.url));
const sourceRoots = ["apps", "packages", "scripts", ".github"];
const rootFiles = ["package.json", "package-lock.json"];
const checkedExtensions = new Set([
  ".cjs",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".sql",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
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
  ["driz", "zle"].join(""),
  ["pgl", "ite"].join(""),
  ["createNode", "PostgresDatabase"].join(""),
  ["Packscout", "Database"].join(""),
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
    if (entry.isDirectory()) {
      await walk(entryPath, files);
    } else if (entry.isFile() && shouldCheckFile(entryPath)) {
      files.push(entryPath);
    }
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
  for (const root of sourceRoots) {
    await walk(path.join(repositoryRoot, root), files);
  }
  for (const file of rootFiles) {
    files.push(path.join(repositoryRoot, file));
  }

  const violations = [];
  for (const file of [...new Set(files)].sort()) {
    const fileRelative = relative(file);
    const pathFragment = findFragment(fileRelative);
    if (pathFragment) {
      violations.push(`${fileRelative}: legacy persistence path contains ${pathFragment}`);
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

  if (violations.length === 0) {
    console.log(`check:prisma-only ok — scanned ${files.length} executable files`);
    return;
  }

  console.error(
    `Prisma-only persistence check failed with ${violations.length} finding(s):`,
  );
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
}

main().catch(() => {
  console.error("check:prisma-only failed unexpectedly.");
  process.exit(2);
});
