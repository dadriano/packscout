import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TASK010_PROVIDER_IDENTITIES } from "./provider-source-task010-safety.mjs";
import { seedArguments } from "./seed-postgres-development-data.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const seedSql = readFileSync(path.join(here, "postgres-development-seed.sql"), "utf8");

test("the seed executes a checked-in file, never an assembled statement", () => {
  const args = seedArguments("/repo/packages/database/prisma/schema.prisma", "/repo/seed.sql");
  assert.deepEqual(args, [
    "db",
    "execute",
    "--schema",
    "/repo/packages/database/prisma/schema.prisma",
    "--file",
    "/repo/seed.sql",
  ]);
});

test("the seed is idempotent and never deletes", () => {
  const statements = seedSql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0 && !statement.startsWith("--"));
  assert.ok(statements.length > 0);
  for (const statement of statements) {
    assert.match(statement, /on conflict[\s\S]*do nothing/i);
  }
  assert.doesNotMatch(seedSql, /\bdelete\b/i);
  assert.doesNotMatch(seedSql, /\btruncate\b/i);
  assert.doesNotMatch(seedSql, /\bdrop\b/i);
});

test("the seed includes the four active provider-source roots with stable identities", () => {
  assert.equal(TASK010_PROVIDER_IDENTITIES.length, 4);
  for (const provider of TASK010_PROVIDER_IDENTITIES) {
    const row = `('${provider.id}', '${provider.platformKey}', '${provider.displayName}', 'active')`;
    assert.equal(seedSql.split(row).length - 1, 1);
  }
  assert.doesNotMatch(seedSql, /collector_crypt[^;]*'draft'/i);
  assert.doesNotMatch(seedSql, /phygitals[^;]*'draft'/i);
  assert.doesNotMatch(seedSql, /clutchpacks[^;]*'draft'/i);
});
