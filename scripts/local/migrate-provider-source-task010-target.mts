#!/usr/bin/env node

import {
  safeTask010Failure,
  task010MigrationInvocation,
} from "./provider-source-task010-safety.mjs";

// Retired before environment-file loading, database access, or provisioning.
// Distributed deployment requires an explicit central or single-provider target.
try {
  task010MigrationInvocation();
} catch (error: unknown) {
  process.stderr.write(`${JSON.stringify({
    ...safeTask010Failure(error),
    error: "Task010 migration is retired. Use db:prisma:migrate:deploy:central or db:prisma:migrate:deploy:provider with an explicit target.",
  })}\n`);
  process.exitCode = 1;
}
