#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { escapeGlobPath } from "./glob-escape.mjs";

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const defaultRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(readOption("--root") ?? defaultRoot);

const commonSkipDirectories = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".next",
  ".next-dev",
  ".next-build",
  ".worktrees",
  "playwright-report",
  "test-results",
  "coverage",
]);

const targets = {
  frontend: {
    cwd: "apps/frontend",
    roots: ["."],
    testFile: /\.test\.(ts|tsx)$/,
    loader: true,
    skipDirectories: ["e2e", "public"],
  },
  admin: {
    cwd: "apps/admin",
    roots: ["server", "src"],
    testFile: /\.test\.(ts|tsx)$/,
    loader: true,
  },
  "ops-panel": {
    cwd: "apps/ops-panel",
    roots: ["server", "src"],
    testFile: /\.test\.(ts|tsx)$/,
    loader: true,
  },
  root: {
    cwd: ".",
    roots: ["__tests__", "scripts"],
    testFile: /\.test\.mjs$/,
    loader: false,
  },
};

const argumentsList = process.argv.slice(2);
const targetName = argumentsList[0];
const listOnly = argumentsList.includes("--list");
const target = targets[targetName];

if (!target) {
  console.error(
    `Unknown target "${targetName}". Available: ${Object.keys(targets).join(", ")}`,
  );
  process.exit(1);
}

function shouldSkipDirectory(name, targetSkipDirectories) {
  return (
    commonSkipDirectories.has(name) ||
    targetSkipDirectories.has(name) ||
    name.startsWith(".next-")
  );
}

function walk(directory, testFile, targetSkipDirectories, files = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (
      entry.isDirectory() &&
      !shouldSkipDirectory(entry.name, targetSkipDirectories)
    ) {
      walk(entryPath, testFile, targetSkipDirectories, files);
    } else if (entry.isFile() && testFile.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function normalizedRelative(from, file) {
  return path.relative(from, file).split(path.sep).join("/");
}

function discoverTarget(targetDefinition) {
  const targetDirectory = path.join(repositoryRoot, targetDefinition.cwd);
  const targetSkipDirectories = new Set(
    targetDefinition.skipDirectories ?? [],
  );
  return [
    ...new Set(
      targetDefinition.roots.flatMap((root) =>
        walk(
          path.join(targetDirectory, root),
          targetDefinition.testFile,
          targetSkipDirectories,
        ),
      ),
    ),
  ].sort();
}

function loadQuarantine(discoveredTestFiles) {
  const quarantinePath = path.join(repositoryRoot, "test-quarantine.json");
  if (!existsSync(quarantinePath)) return [];

  let entries;
  try {
    entries = JSON.parse(readFileSync(quarantinePath, "utf8"));
  } catch (error) {
    console.error(`[run-tests] Invalid test-quarantine.json: ${error.message}`);
    process.exit(1);
  }

  if (!Array.isArray(entries)) {
    console.error("[run-tests] test-quarantine.json must contain an array.");
    process.exit(1);
  }

  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    if (
      !entry ||
      typeof entry.file !== "string" ||
      !entry.file.trim() ||
      typeof entry.reason !== "string" ||
      !entry.reason.trim() ||
      typeof entry.owner !== "string" ||
      !entry.owner.trim()
    ) {
      console.error(
        `[run-tests] Quarantine entry ${index + 1} requires non-empty file, reason, and owner fields.`,
      );
      process.exit(1);
    }
    if (seen.has(entry.file)) {
      console.error(`[run-tests] Duplicate quarantine entry: ${entry.file}`);
      process.exit(1);
    }
    seen.add(entry.file);

    const resolvedFile = path.resolve(repositoryRoot, entry.file);
    const normalizedFile = normalizedRelative(repositoryRoot, resolvedFile);
    if (
      path.isAbsolute(entry.file) ||
      normalizedFile === ".." ||
      normalizedFile.startsWith("../") ||
      entry.file.replaceAll("\\", "/") !== normalizedFile
    ) {
      console.error(
        `[run-tests] Quarantine entry must be a normalized repo-relative path: ${entry.file}`,
      );
      process.exit(1);
    }
    if (!existsSync(resolvedFile)) {
      console.error(
        `[run-tests] Stale quarantine entry (file no longer exists): ${entry.file}`,
      );
      process.exit(1);
    }
    if (!discoveredTestFiles.has(entry.file)) {
      console.error(
        `[run-tests] Quarantine entry is not discovered by any test lane: ${entry.file}`,
      );
      process.exit(1);
    }
  }

  return entries;
}

const targetDirectory = path.join(repositoryRoot, target.cwd);
const discoveredAbsolute = discoverTarget(target);
const discoveredRelative = discoveredAbsolute.map((file) =>
  normalizedRelative(repositoryRoot, file),
);

const allDiscoveredTestFiles = new Set(
  Object.values(targets)
    .flatMap((targetDefinition) => discoverTarget(targetDefinition))
    .map((file) => normalizedRelative(repositoryRoot, file)),
);

const quarantine = loadQuarantine(allDiscoveredTestFiles);

if (discoveredAbsolute.length === 0) {
  console.error(
    `[run-tests] ${targetName}: discovered 0 test files — discovery is misconfigured or coverage is missing.`,
  );
  process.exit(1);
}

const quarantinedSet = new Set(quarantine.map((entry) => entry.file));
const runnable = [];
const quarantined = [];

for (let index = 0; index < discoveredAbsolute.length; index += 1) {
  if (quarantinedSet.has(discoveredRelative[index])) {
    quarantined.push(discoveredRelative[index]);
  } else {
    runnable.push(discoveredAbsolute[index]);
  }
}

console.log(
  `[run-tests] ${targetName}: discovered ${discoveredAbsolute.length}, quarantined ${quarantined.length}, executing ${runnable.length}`,
);
for (const file of quarantined) {
  console.log(`[run-tests]   quarantined: ${file}`);
}

if (runnable.length === 0) {
  console.error(
    `[run-tests] ${targetName}: refusing to pass with every discovered test quarantined.`,
  );
  process.exit(1);
}

if (listOnly) {
  const listing = runnable
    .map((file) => normalizedRelative(targetDirectory, file))
    .join("\n");
  if (listing) writeSync(1, `${listing}\n`);
  process.exit(0);
}

const nodeArguments = [
  "--test",
  ...(target.loader ? ["--import", "tsx"] : []),
  ...runnable.map((file) =>
    escapeGlobPath(normalizedRelative(targetDirectory, file)),
  ),
];
const result = spawnSync(process.execPath, nodeArguments, {
  cwd: targetDirectory,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
