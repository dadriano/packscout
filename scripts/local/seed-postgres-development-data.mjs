#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  prismaExecutable,
  prismaSchemaPath,
  repositoryRoot,
  requireLocalDatabaseTarget,
} from "./local-database-target.mjs";

/**
 * `db:seed:local` — the workspace's canonical relational seed.
 *
 * The only seed this repository had targeted the document backend, which is a
 * different datastore entirely, so the relational one is defined here. It runs
 * a checked-in, idempotent SQL file through the ORM's executor: the file is a
 * fixed artifact of this repository, never a path or a statement supplied by a
 * caller, which is what lets the operations panel offer "run the seed" as a
 * button without offering SQL execution.
 *
 * The environment check is enforced here rather than trusted to the caller, so
 * the guarantee holds whether the workflow is started from the panel or from a
 * terminal.
 */

const WORKFLOW = "db:seed:local";
const seedFile = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres-development-seed.sql",
);

export function seedArguments(schemaFile, file) {
  return ["db", "execute", "--schema", schemaFile, "--file", file];
}

function main() {
  const target = requireLocalDatabaseTarget(process.env, WORKFLOW);
  console.log(`${WORKFLOW}: seeding "${target.database}" on this machine.`);

  const result = spawnSync(
    prismaExecutable(),
    seedArguments(prismaSchemaPath(), seedFile),
    { cwd: repositoryRoot(), stdio: "inherit" },
  );

  if (result.error) {
    console.error(`${WORKFLOW} could not run: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`${WORKFLOW} failed with exit code ${result.status ?? "unknown"}.`);
    process.exit(result.status ?? 1);
  }
  console.log(`${WORKFLOW}: development rows are in place.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
