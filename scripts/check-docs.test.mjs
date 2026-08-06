import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const checkerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "check-docs.mjs",
);
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

function createFixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "packscout-docs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const document of requiredDocuments) {
    const filePath = path.join(root, document);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "# Fixture\n");
  }
  return root;
}

function runChecker(root) {
  return spawnSync(process.execPath, [checkerPath, "--root", root], {
    encoding: "utf8",
  });
}

test("accepts angle-bracket local links with spaces", (t) => {
  const root = createFixture(t);
  writeFileSync(path.join(root, "docs", "My File.md"), "# Linked file\n");
  writeFileSync(
    path.join(root, "README.md"),
    "[Linked file](<docs/My File.md>)\n",
  );

  const result = runChecker(root);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("reports malformed percent escapes as a broken link instead of crashing", (t) => {
  const root = createFixture(t);
  writeFileSync(path.join(root, "README.md"), "[Broken](docs/%ZZ.md)\n");

  const result = runChecker(root);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /broken-link/);
  assert.doesNotMatch(result.stderr, /URIError/);
});

test("rejects copied product names case-insensitively", (t) => {
  const root = createFixture(t);
  writeFileSync(path.join(root, "README.md"), "# LAINS copy\n");

  const result = runChecker(root);
  assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /forbidden-term/);
});
