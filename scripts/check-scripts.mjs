#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isIgnoredDirectoryName } from "./ignored-directories.mjs";

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const defaultRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(readOption("--root") ?? defaultRoot);

const destructiveCommandRules = [
  {
    pattern: /prisma migrate reset\b/,
    reason: "database reset commands must be explicitly environment-scoped",
  },
  {
    pattern: /\bDROP\s+DATABASE\b/i,
    reason: "database deletion must not be exposed as a universal package script",
  },
  {
    pattern: /\bTRUNCATE\s+(?:TABLE\s+)?/i,
    reason: "bulk data deletion must be explicitly environment-scoped",
  },
  {
    pattern: /scripts\/(?:preproduction|live)\//,
    reason: "environment-specific utilities need an environment qualifier in the script name",
  },
];
const destructiveNameKeywords = [
  "reset",
  "wipe",
  "truncate",
  "purge",
  "nuke",
  "flush",
  "clean-db",
  "cleandb",
  "drop-db",
  "dropdb",
];
const environmentQualifiers = new Set([
  "local",
  "dev",
  "staging",
  "preproduction",
  "preprod",
  "live",
  "prod",
  "ci",
]);
function isEnvironmentScoped(name) {
  return name
    .split(":")
    .some((segment) => environmentQualifiers.has(segment));
}

async function* findPackageFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || isIgnoredDirectoryName(entry.name))
      continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      yield* findPackageFiles(entryPath);
    } else if (entry.name === "package.json") {
      yield entryPath;
    }
  }
}

async function checkPackageFile(filePath) {
  const relativePath = path
    .relative(repositoryRoot, filePath)
    .split(path.sep)
    .join("/");
  const packageDocument = JSON.parse(await readFile(filePath, "utf8"));
  const violations = [];

  for (const [name, command] of Object.entries(packageDocument.scripts ?? {})) {
    if (typeof command !== "string") continue;
    if (isEnvironmentScoped(name)) continue;

    const commandRule = destructiveCommandRules.find(({ pattern }) =>
      pattern.test(command),
    );
    if (commandRule) {
      violations.push({
        file: relativePath,
        name,
        command,
        reason: commandRule.reason,
      });
      continue;
    }

    const keyword = destructiveNameKeywords.find((item) => name.includes(item));
    if (keyword) {
      violations.push({
        file: relativePath,
        name,
        command,
        reason: `script name contains "${keyword}" without an environment qualifier`,
      });
    }
  }

  return violations;
}

async function main() {
  const violations = [];
  let packageCount = 0;

  for await (const packageFile of findPackageFiles(repositoryRoot)) {
    packageCount += 1;
    violations.push(...(await checkPackageFile(packageFile)));
  }

  if (violations.length === 0) {
    console.log(`check:scripts ok — scanned ${packageCount} package.json files`);
    return;
  }

  console.error(
    `Environment-specific script isolation failed with ${violations.length} violation(s):`,
  );
  for (const violation of violations) {
    console.error(`- ${violation.file} script "${violation.name}"`);
    console.error(`  command: ${violation.command}`);
    console.error(`  reason: ${violation.reason}`);
  }
  console.error("See docs/engineering-rules.md.");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error("check:scripts failed:", error);
  process.exit(2);
});
