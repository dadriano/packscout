#!/usr/bin/env node

import { builtinModules } from "node:module";
import { readdir, readFile, stat } from "node:fs/promises";
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

const zones = new Map([
  ["frontend", path.join(repositoryRoot, "apps", "frontend")],
  ["admin-client", path.join(repositoryRoot, "apps", "admin", "src")],
  ["admin-server", path.join(repositoryRoot, "apps", "admin", "server")],
]);

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const skipDirectories = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".next-dev",
  ".next-build",
  ".turbo",
  ".git",
  "coverage",
]);
const builtinNames = new Set(
  builtinModules.flatMap((name) => [name, name.replace(/^node:/, "")]),
);

const importPattern =
  /(import\s+type\s+(?:[^"'`]*?\s+from\s+)?|export\s+type\s+(?:[^"'`]*?\s+from\s+)?|import\s+(?:[^"'`]*?\s+from\s+)?|export\s+(?:[^"'`]*?\s+from\s+)?|import\s*\()\s*["']([^"']+)["']/gms;

function relative(filePath) {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

function zoneOf(filePath) {
  for (const [zone, rootPath] of zones) {
    if (filePath === rootPath || filePath.startsWith(`${rootPath}${path.sep}`)) {
      return zone;
    }
  }
  return null;
}

function isTestFile(filePath) {
  return /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filePath);
}

function isClientComponent(content) {
  return /^\s*["']use client["'];?/m.test(content);
}

function isNodeBuiltin(specifier) {
  const normalized = specifier.replace(/^node:/, "").split("/")[0];
  return specifier.startsWith("node:") || builtinNames.has(normalized);
}

function isGeneratedDirectory(name) {
  return skipDirectories.has(name) || name.startsWith(".next-");
}

async function collectFiles(directory, files = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && isGeneratedDirectory(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(entryPath, files);
    } else if (
      entry.isFile() &&
      sourceExtensions.has(path.extname(entry.name))
    ) {
      files.push(entryPath);
    }
  }
  return files;
}

function addViolation(violations, filePath, rule, specifier, message) {
  violations.push({
    file: relative(filePath),
    rule,
    specifier,
    message,
  });
}

function isPackageSpecifier(specifier, packageName) {
  return specifier === packageName || specifier.startsWith(`${packageName}/`);
}

function crossAppAlias(sourceZone, specifier) {
  if (
    sourceZone === "frontend" &&
    isPackageSpecifier(specifier, "@packscout/admin")
  ) {
    return true;
  }
  if (
    sourceZone?.startsWith("admin-") &&
    isPackageSpecifier(specifier, "@packscout/frontend")
  ) {
    return true;
  }
  return false;
}

function checkImport({
  filePath,
  content,
  sourceZone,
  specifier,
  isTypeOnly,
  violations,
}) {
  const testFile = isTestFile(filePath);

  if (/^@packscout\/[^/]+\/src(?:\/|$)/.test(specifier)) {
    addViolation(
      violations,
      filePath,
      "no-internal-package-imports",
      specifier,
      "Cross-package consumers must use a public package entry point.",
    );
  }

  if (crossAppAlias(sourceZone, specifier)) {
    addViolation(
      violations,
      filePath,
      "no-cross-app-imports",
      specifier,
      "Frontend and admin are independent applications and must not import one another.",
    );
  }

  if (
    sourceZone === "admin-client" &&
    isPackageSpecifier(specifier, "@packscout/admin/server")
  ) {
    addViolation(
      violations,
      filePath,
      "no-cross-zone-package-imports",
      specifier,
      "Admin browser code must not bypass the client/server boundary through a package alias.",
    );
  }

  if (specifier.startsWith(".")) {
    const resolved = path.resolve(path.dirname(filePath), specifier);
    const targetZone = zoneOf(resolved);
    if (sourceZone && targetZone && sourceZone !== targetZone) {
      const allowedAdminServerImport =
        sourceZone === "admin-server" && targetZone === "admin-server";
      if (!allowedAdminServerImport) {
        addViolation(
          violations,
          filePath,
          "no-cross-zone-relative-imports",
          specifier,
          `Relative import crosses from ${sourceZone} into ${targetZone}.`,
        );
      }
    }
  }

  if (isTypeOnly || testFile) return;

  const serverOnlySpecifier =
    isNodeBuiltin(specifier) ||
    [
      "express",
      "dotenv",
      "server-only",
      "next/server",
      "next/headers",
    ].includes(specifier);

  if (sourceZone === "admin-client" && serverOnlySpecifier) {
    addViolation(
      violations,
      filePath,
      "admin-client-no-server-imports",
      specifier,
      "Admin browser code must call an API helper instead of importing server-only code.",
    );
  }

  if (
    sourceZone === "frontend" &&
    isClientComponent(content) &&
    serverOnlySpecifier
  ) {
    addViolation(
      violations,
      filePath,
      "frontend-client-no-server-imports",
      specifier,
      "Frontend client components cannot import server-only modules.",
    );
  }

  if (
    sourceZone === "frontend" &&
    ["express", "dotenv"].includes(specifier)
  ) {
    addViolation(
      violations,
      filePath,
      "frontend-no-admin-server-runtime",
      specifier,
      "Frontend code must not depend on the admin server runtime.",
    );
  }
}

export async function scanBoundaries() {
  const files = [];
  for (const rootPath of zones.values()) {
    try {
      if ((await stat(rootPath)).isDirectory()) {
        await collectFiles(rootPath, files);
      }
    } catch {
      // A surface may be absent in a focused fixture.
    }
  }

  const uniqueFiles = [...new Set(files)].sort();
  const violations = [];
  for (const filePath of uniqueFiles) {
    const content = await readFile(filePath, "utf8");
    const sourceZone = zoneOf(filePath);
    for (const match of content.matchAll(importPattern)) {
      checkImport({
        filePath,
        content,
        sourceZone,
        specifier: match[2],
        isTypeOnly: /^\s*(?:import|export)\s+type\b/.test(match[1]),
        violations,
      });
    }
  }

  return { files: uniqueFiles, violations };
}

async function main() {
  const { files, violations } = await scanBoundaries();
  if (violations.length > 0) {
    console.error(`Boundary check failed with ${violations.length} violation(s):`);
    for (const violation of violations) {
      console.error(
        `- ${violation.file}: ${violation.rule} (${violation.specifier}) - ${violation.message}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  console.log(`Boundary check passed. Scanned ${files.length} source files.`);
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  main().catch((error) => {
    console.error("Boundary check failed:", error);
    process.exit(2);
  });
}
