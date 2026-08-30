import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DATABASE_OPERATIONS,
  DATABASE_OPERATION_IDS,
  findDatabaseOperation,
} from "./database-operations.ts";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
);

function rootScripts(): Record<string, string> {
  const document = JSON.parse(
    readFileSync(path.join(workspaceRoot, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  return document.scripts ?? {};
}

test("the panel offers exactly three database operations", () => {
  assert.deepEqual(
    DATABASE_OPERATIONS.map((operation) => operation.id),
    ["migrate", "seed", "reset"],
  );
  assert.deepEqual([...DATABASE_OPERATION_IDS], ["migrate", "seed", "reset"]);
});

test("only registered identifiers resolve to an operation", () => {
  for (const id of DATABASE_OPERATION_IDS) {
    assert.equal(findDatabaseOperation(id)?.id, id);
  }
  for (const impostor of [
    "drop",
    "MIGRATE",
    "migrate ",
    "../migrate",
    "npm run db:reset:local",
    "select 1",
    "",
    null,
    undefined,
    42,
    { id: "migrate" },
    ["migrate"],
  ]) {
    assert.equal(
      findDatabaseOperation(impostor),
      null,
      `${JSON.stringify(impostor)} must not resolve to an operation`,
    );
  }
});

test("every available operation runs a workspace script that actually exists", () => {
  const scripts = rootScripts();
  for (const operation of DATABASE_OPERATIONS) {
    if (operation.unavailableReason !== undefined) continue;
    assert.ok(
      typeof scripts[operation.workspaceScript] === "string",
      `the root workspace defines no ${operation.workspaceScript} script for ${operation.id}`,
    );
  }
});

test("migrate retains its historical identifier but cannot execute it", () => {
  const migrate = findDatabaseOperation("migrate");
  assert.equal(migrate?.workspaceScript, "db:prisma:migrate:deploy");
  assert.equal(migrate?.destructive, false);
  assert.match(migrate?.unavailableReason ?? "", /central or one provider/u);
});

/**
 * The repository's script-safety check skips a script whose name states its
 * environment. The two workflows this surface defines are exactly the ones that
 * have to satisfy it, so the requirement is asserted here rather than left to
 * the checker to discover.
 */
test("the newly defined seed and reset workflows are environment-qualified", () => {
  for (const id of ["seed", "reset"] as const) {
    const operation = findDatabaseOperation(id);
    assert.ok(operation);
    assert.ok(
      operation.workspaceScript.split(":").includes("local"),
      `${operation.workspaceScript} must carry an environment qualifier`,
    );
  }
});

test("reset is the only operation that demands a typed acknowledgement", () => {
  const byAcknowledgement = DATABASE_OPERATIONS.filter(
    (operation) => operation.acknowledgement === "database_name",
  );
  assert.deepEqual(
    byAcknowledgement.map((operation) => operation.id),
    ["reset"],
  );
  assert.equal(findDatabaseOperation("reset")?.destructive, true);
});

test("every operation states a consequence before it can be confirmed", () => {
  for (const operation of DATABASE_OPERATIONS) {
    assert.ok(operation.consequence.length > 20, `${operation.id} states no consequence`);
    assert.ok(operation.summary.length > 20, `${operation.id} states no summary`);
  }
});

test("only explicit central and single-provider deploy scripts remain", () => {
  const scripts = rootScripts();
  const database = JSON.parse(readFileSync(
    path.join(workspaceRoot, "packages/database/package.json"), "utf8",
  )) as { scripts: Record<string, string> };
  assert.equal(scripts["db:prisma:migrate:deploy"], undefined);
  assert.equal(scripts["db:prisma:migrate:deploy:central"],
    "npm run prisma:migrate:deploy:central --workspace=@packscout/database");
  assert.equal(scripts["db:prisma:migrate:deploy:provider"],
    "npm run prisma:migrate:deploy:provider --workspace=@packscout/database");
  assert.equal(database.scripts["prisma:migrate:deploy"], undefined);
  assert.match(database.scripts["prisma:migrate:deploy:central"] ?? "",
    /prisma migrate deploy --schema prisma\/central\/schema\.prisma$/u);
  assert.match(database.scripts["prisma:migrate:deploy:provider"] ?? "",
    /prisma migrate deploy --schema prisma\/provider\/schema\.prisma$/u);
});
