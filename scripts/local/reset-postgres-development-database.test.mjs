import assert from "node:assert/strict";
import { test } from "node:test";
import { resetArguments } from "./reset-postgres-development-database.mjs";

test("the reset drops and re-applies migrations against the schema it is given", () => {
  const args = resetArguments("/repo/packages/database/prisma/schema.prisma");
  assert.deepEqual(args, [
    "migrate",
    "reset",
    "--force",
    "--skip-seed",
    "--skip-generate",
    "--schema",
    "/repo/packages/database/prisma/schema.prisma",
  ]);
});

/**
 * The seed is skipped in the migrate step on purpose: it runs immediately
 * afterwards as its own canonical workflow, so "seeded" means the same thing
 * whether an operator reset or seeded.
 */
test("the reset never relies on the tool's own seed hook", () => {
  assert.ok(resetArguments("/schema").includes("--skip-seed"));
});
