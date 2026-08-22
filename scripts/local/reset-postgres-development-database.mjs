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
 * `db:reset:local` — the workspace's canonical relational reset: drop, re-apply
 * every migration, re-seed.
 *
 * The name carries `:local` because the repository's script-safety check
 * requires a destructive script to state its environment, and this one is
 * destructive by definition. The check is not a formality: the workflow
 * re-verifies for itself that the configured database is on this machine and
 * exits before touching anything if it cannot prove that.
 *
 * The seed step delegates to `db:seed:local` rather than repeating it, so a
 * reset and a seed can never diverge in what "seeded" means.
 */

const WORKFLOW = "db:reset:local";

export function resetArguments(schemaFile) {
  return [
    "migrate",
    "reset",
    "--force",
    // The ORM's own seed hook is not configured; the seed runs as its own
    // canonical workflow immediately afterwards.
    "--skip-seed",
    "--skip-generate",
    "--schema",
    schemaFile,
  ];
}

function run(label, command, args) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot(),
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`${WORKFLOW} could not ${label}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(
      `${WORKFLOW} failed to ${label} (exit code ${result.status ?? "unknown"}).`,
    );
    process.exit(result.status ?? 1);
  }
}

function main() {
  const target = requireLocalDatabaseTarget(process.env, WORKFLOW);
  console.log(
    `${WORKFLOW}: destroying and rebuilding "${target.database}" on this machine.`,
  );

  run("drop and re-apply migrations", prismaExecutable(), resetArguments(prismaSchemaPath()));
  run("seed", process.execPath, [
    path.join(path.dirname(fileURLToPath(import.meta.url)), "seed-postgres-development-data.mjs"),
  ]);

  console.log(`${WORKFLOW}: "${target.database}" was rebuilt and seeded.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
