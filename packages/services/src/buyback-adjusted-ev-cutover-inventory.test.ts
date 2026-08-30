import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  PACKSCOUT_BUYBACK_EV_CUTOVER_INVENTORY_V1,
  PACKSCOUT_BUYBACK_EV_INVENTORY_SCAN_ROOTS_V1,
  PACKSCOUT_BUYBACK_EV_PRE_BUYBACK_TOKENS_V1,
  PACKSCOUT_BUYBACK_EV_V3_SURFACE_PREFIXES_V1,
  packScoutBuybackEvCutoverDispositionCountsV1,
  packScoutBuybackEvCutoverInventoryPathsV1,
} from "./buyback-adjusted-ev-cutover-inventory.ts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

/**
 * Package entry points re-export both method generations until cutover; they
 * are barrels, not affected surfaces, and each re-exported module is
 * inventoried individually.
 */
const SCAN_EXEMPT_BARRELS = new Set([
  "packages/services/src/index.ts",
  "packages/database/src/index.ts",
]);

/** The manifest of pre-buyback tokens is allowed to spell them. */
const PURITY_EXEMPT_FILES = new Set([
  "packages/services/src/buyback-adjusted-ev-cutover-inventory.ts",
]);

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "_generated",
  ".git",
  ".turbo",
]);

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mjs",
  ".cjs",
  ".js",
  ".prisma",
]);

function isTestFile(relativePath: string): boolean {
  return (
    /\.test\.(?:ts|tsx|mjs|cjs|js)$/.test(relativePath) ||
    relativePath.includes(".test-support.") ||
    relativePath.includes("test-support.ts")
  );
}

function shouldSkipDirectory(directory: string): boolean {
  const name = path.basename(directory);
  return SKIPPED_DIRECTORIES.has(name)
    || name.startsWith(".next")
    || relative(directory) === "packages/database/prisma/generated";
}

function walk(directory: string, files: string[] = []): string[] {
  if (!existsSync(directory)) return files;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (shouldSkipDirectory(path.join(directory, entry.name))) {
        continue;
      }
      walk(path.join(directory, entry.name), files);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

function relative(filePath: string): string {
  return path.relative(repositoryRoot, filePath).split(path.sep).join("/");
}

function tokensIn(content: string): readonly string[] {
  return PACKSCOUT_BUYBACK_EV_PRE_BUYBACK_TOKENS_V1.filter((token) =>
    content.includes(token),
  );
}

test("only the exact Prisma output path exempts a generated directory", () => {
  assert.equal(shouldSkipDirectory(path.join(
    repositoryRoot, "packages/database/prisma/generated",
  )), true);
  for (const directory of ["apps/frontend/generated", "packages/database/src/generated"]) {
    assert.equal(shouldSkipDirectory(path.join(repositoryRoot, directory)), false);
  }
});

test("the cutover inventory is well formed and every referenced surface exists", () => {
  assert.ok(PACKSCOUT_BUYBACK_EV_CUTOVER_INVENTORY_V1.length > 0);
  const keys = new Set<string>();
  for (const item of PACKSCOUT_BUYBACK_EV_CUTOVER_INVENTORY_V1) {
    assert.equal(keys.has(item.itemKey), false, `duplicate key ${item.itemKey}`);
    keys.add(item.itemKey);
    assert.ok(
      ["replaced_by_v3", "historical_only", "retired"].includes(
        item.disposition,
      ),
      `${item.itemKey} carries an unknown disposition`,
    );
    if (item.disposition === "replaced_by_v3") {
      assert.notEqual(
        item.replacementPath,
        null,
        `${item.itemKey} must name its V3 replacement`,
      );
    } else {
      assert.equal(
        item.replacementPath,
        null,
        `${item.itemKey} must not name a replacement`,
      );
    }
    assert.ok(item.elements.length > 0, `${item.itemKey} names no elements`);
  }
  for (const inventoryPath of packScoutBuybackEvCutoverInventoryPathsV1()) {
    assert.ok(
      existsSync(path.join(repositoryRoot, inventoryPath)),
      `inventory references a missing file: ${inventoryPath}`,
    );
  }
  const counts = packScoutBuybackEvCutoverDispositionCountsV1();
  assert.equal(
    counts.replaced_by_v3 + counts.historical_only + counts.retired,
    PACKSCOUT_BUYBACK_EV_CUTOVER_INVENTORY_V1.length,
  );
  // Every required inventory category is represented.
  const kinds = new Set(
    PACKSCOUT_BUYBACK_EV_CUTOVER_INVENTORY_V1.map(({ kind }) => kind),
  );
  for (const requiredKind of [
    "calculator",
    "projection",
    "public_field",
    "sort",
    "kpi",
    "fixture",
    "glossary_term",
    "example",
    "telemetry_label",
  ] as const) {
    assert.ok(kinds.has(requiredKind), `no inventory item of kind ${requiredKind}`);
  }
});

test("every non-test source file spelling a pre-buyback token is inventoried", () => {
  const inventoried = new Set(
    PACKSCOUT_BUYBACK_EV_CUTOVER_INVENTORY_V1.map(({ path: itemPath }) => itemPath),
  );
  const missing: string[] = [];
  for (const root of PACKSCOUT_BUYBACK_EV_INVENTORY_SCAN_ROOTS_V1) {
    for (const filePath of walk(path.join(repositoryRoot, root))) {
      const relativePath = relative(filePath);
      if (isTestFile(relativePath) || SCAN_EXEMPT_BARRELS.has(relativePath)) {
        continue;
      }
      if (PURITY_EXEMPT_FILES.has(relativePath)) continue;
      const hits = tokensIn(readFileSync(filePath, "utf8"));
      if (hits.length > 0 && !inventoried.has(relativePath)) {
        missing.push(`${relativePath} (${hits.join(", ")})`);
      }
    }
  }
  assert.deepEqual(
    missing,
    [],
    `pre-buyback surfaces missing from the cutover inventory:\n${missing.join("\n")}`,
  );
});

test("no active V3 surface consumes or spells the pre-buyback interpretation", () => {
  const violations: string[] = [];
  for (const root of PACKSCOUT_BUYBACK_EV_INVENTORY_SCAN_ROOTS_V1) {
    for (const filePath of walk(path.join(repositoryRoot, root))) {
      const relativePath = relative(filePath);
      if (isTestFile(relativePath) || PURITY_EXEMPT_FILES.has(relativePath)) {
        continue;
      }
      const governed = PACKSCOUT_BUYBACK_EV_V3_SURFACE_PREFIXES_V1.some(
        (prefix) => relativePath.startsWith(prefix),
      );
      if (!governed) continue;
      const hits = tokensIn(readFileSync(filePath, "utf8"));
      if (hits.length > 0) {
        violations.push(`${relativePath} (${hits.join(", ")})`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    `V3 surfaces must never carry pre-buyback spellings:\n${violations.join("\n")}`,
  );
});

test("V3 surface prefixes actually govern the replacement modules", () => {
  // The purity assertion above is only meaningful while the prefixes match
  // real files; a rename that emptied the governed set must fail here.
  const governedFiles: string[] = [];
  for (const root of PACKSCOUT_BUYBACK_EV_INVENTORY_SCAN_ROOTS_V1) {
    for (const filePath of walk(path.join(repositoryRoot, root))) {
      const relativePath = relative(filePath);
      if (
        PACKSCOUT_BUYBACK_EV_V3_SURFACE_PREFIXES_V1.some((prefix) =>
          relativePath.startsWith(prefix),
        )
      ) {
        governedFiles.push(relativePath);
      }
    }
  }
  assert.ok(
    governedFiles.length >= 12,
    `expected the V3 prefixes to govern the replacement modules, found ${governedFiles.length}`,
  );
});
