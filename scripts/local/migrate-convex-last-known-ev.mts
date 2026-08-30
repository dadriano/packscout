#!/usr/bin/env node
import { readLocalConvexConfiguration } from "./seed-convex-mock-data-release.mjs";
import { migrateLocalConvexEv } from "./local-convex-ev-migration.mts";
import { createLocalConvexEvMigrationClient } from "./local-convex-ev-migration-client.mts";

try {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--check-only")) throw new Error("INVALID_ARGUMENTS");
  const client = await createLocalConvexEvMigrationClient(await readLocalConvexConfiguration());
  const result = await migrateLocalConvexEv(client, { checkOnly: args[0] === "--check-only" });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.status !== "ready") process.exitCode = 2;
} catch {
  process.stderr.write("LOCAL_CONVEX_EV_MIGRATION_FAILED: verify local configuration and migration readiness.\n");
  process.exitCode = 1;
}
