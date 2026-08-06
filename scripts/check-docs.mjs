#!/usr/bin/env node

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

const requiredDocuments = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "ARCHITECTURE.md",
  "docs/engineering-rules.md",
  "docs/framework-standards.md",
  "docs/framework-standards-adoption-audit.md",
  "docs/framework-technical-layout.md",
  "docs/frontend-feature-baseline.md",
  "docs/admin-feature-baseline.md",
  "docs/ui-layout-standard.md",
  "docs/testing/shift-left-bdd.md",
];
const documentationRoots = ["docs", "apps", "scripts", ".tasks"];
const rootDocuments = ["README.md", "AGENTS.md", "CLAUDE.md", "ARCHITECTURE.md"];
const skipDirectories = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  ".next-dev",
  ".next-build",
  ".turbo",
  ".git",
  "archive",
  "legacy",
  "_templates",
]);
const forbiddenTerms = [
  {
    pattern: /\blains\b/gi,
    message: "copied product name; living Packscout docs must describe this repository",
  },
  {
    pattern: /(?:^|[\s`(])web\//gm,
    message: "stale application path; the user-facing app is apps/frontend/",
  },
];

function relative(filePath) {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

function lineForIndex(content, index) {
  return content.slice(0, index).split(/\r?\n/).length;
}

function shouldSkipDirectory(name) {
  return skipDirectories.has(name) || name.startsWith(".next-");
}

async function walk(directory, files = []) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return files;
  }

  for (const entry of entries) {
    if (entry.isDirectory() && shouldSkipDirectory(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(entryPath, files);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(entryPath);
    }
  }
  return files;
}

async function collectDocuments() {
  const files = [];
  for (const document of rootDocuments) {
    const fullPath = path.join(repositoryRoot, document);
    try {
      if ((await stat(fullPath)).isFile()) files.push(fullPath);
    } catch {
      // Missing required documents are reported separately.
    }
  }
  for (const root of documentationRoots) {
    await walk(path.join(repositoryRoot, root), files);
  }
  return [...new Set(files)].sort();
}

function findMarkdownLinks(content) {
  const links = [];
  const pattern = /(?<!!)\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of content.matchAll(pattern)) {
    links.push({ target: match[1].trim(), index: match.index ?? 0 });
  }
  return links;
}

async function targetExists(documentPath, target) {
  let destination = target.replace(/\s+["'][^"']*["']$/, "");
  if (destination.startsWith("<") && destination.endsWith(">")) {
    destination = destination.slice(1, -1);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(destination) || destination.startsWith("//")) {
    return true;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(destination.split(/[?#]/)[0]);
  } catch {
    return false;
  }
  if (!decoded) return true;

  const resolved = decoded.startsWith("/")
    ? path.join(repositoryRoot, decoded.slice(1))
    : path.resolve(path.dirname(documentPath), decoded);
  try {
    await stat(resolved);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const violations = [];

  for (const required of requiredDocuments) {
    try {
      if (!(await stat(path.join(repositoryRoot, required))).isFile()) {
        throw new Error("not a file");
      }
    } catch {
      violations.push({
        file: required,
        line: 1,
        kind: "missing-document",
        message: "required canonical document is missing",
      });
    }
  }

  const files = await collectDocuments();
  for (const file of files) {
    const content = await readFile(file, "utf8");
    const fileRelative = relative(file);

    for (const { pattern, message } of forbiddenTerms) {
      pattern.lastIndex = 0;
      for (const match of content.matchAll(pattern)) {
        violations.push({
          file: fileRelative,
          line: lineForIndex(content, match.index ?? 0),
          kind: "forbidden-term",
          message: `${JSON.stringify(match[0].trim())} — ${message}`,
        });
      }
    }

    for (const match of content.matchAll(/>>>/g)) {
      violations.push({
        file: fileRelative,
        line: lineForIndex(content, match.index ?? 0),
        kind: "editorial-marker",
        message: "draft review marker left in a living document",
      });
    }

    for (const link of findMarkdownLinks(content)) {
      if (!(await targetExists(file, link.target))) {
        violations.push({
          file: fileRelative,
          line: lineForIndex(content, link.index),
          kind: "broken-link",
          message: `local target does not exist: ${link.target}`,
        });
      }
    }
  }

  if (violations.length === 0) {
    console.log(`check:docs ok — scanned ${files.length} markdown files`);
    return;
  }

  console.error(`Documentation check failed with ${violations.length} finding(s):`);
  for (const violation of violations) {
    console.error(
      `- ${violation.file}:L${violation.line} ${violation.kind} — ${violation.message}`,
    );
  }
  process.exitCode = 1;
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  main().catch((error) => {
    console.error("check:docs failed:", error);
    process.exit(2);
  });
}
