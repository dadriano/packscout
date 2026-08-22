import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
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
