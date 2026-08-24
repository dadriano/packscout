#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TASK010_SAFETY_VERSION,
  Task010SafetyError,
  assertBootstrapPasswordAbsent,
  assertEvidenceTokenAbsent,
  assertNoTask010Arguments,
  loadTask010EnvironmentFile,
  readTask010Environment,
  safeTask010Failure,
} from "./provider-source-task010-safety.mjs";
import {
  assertTask010CapacityApproved,
  createTask010CapacityReceipt,
  openTask010Database,
  verifyTask010Bootstrap,
  verifyTask010DatabaseIdentity,
  verifyTask010MigratedSchema,
  verifyTask010SourceTopology,
} from "./provider-source-task010-runtime.mts";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
async function main(): Promise<void> {
  assertNoTask010Arguments(process.argv.slice(2));
  const task010Environment = await loadTask010EnvironmentFile(workspaceRoot);
  assertEvidenceTokenAbsent(process.env);
  assertBootstrapPasswordAbsent(process.env);
  assertEvidenceTokenAbsent(task010Environment);
  assertBootstrapPasswordAbsent(task010Environment);
  const environment = readTask010Environment(task010Environment);
  if (!environment.expectedDatabaseIdentity) {
    throw new Task010SafetyError("DATABASE_IDENTITY_FINGERPRINT_REQUIRED");
  }
  const client = await openTask010Database(environment);
  try {
    const target = await verifyTask010DatabaseIdentity(client, environment);
    await verifyTask010MigratedSchema(client);
    const capacity = await createTask010CapacityReceipt({
      client,
      environment,
      databaseIdentity: target.fingerprint,
      databaseDataDirectory: target.identity.dataDirectory,
      schemaReady: true,
    });
    assertTask010CapacityApproved(capacity);
    await verifyTask010Bootstrap(
      client,
      environment,
      target.fingerprint,
      capacity,
    );
    await verifyTask010SourceTopology(client, environment);
    process.stdout.write(
      `${JSON.stringify({
        version: TASK010_SAFETY_VERSION,
        ok: true,
        operation: "start_admin",
        target: { ...target.identity, fingerprint: target.fingerprint },
        capacity,
        origin: `http://${task010Environment.PACKSCOUT_ADMIN_HOST ?? "127.0.0.1"}:${task010Environment.PACKSCOUT_ADMIN_PORT ?? "5101"}`,
      })}\n`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }

  for (const name of Object.keys(process.env)) {
    if (name.startsWith("PACKSCOUT_")) delete process.env[name];
  }
  Object.assign(process.env, task010Environment);
  // Prevent the admin entry point's legacy root-.env load from reintroducing
  // either one-time secret if an unrelated local file still contains it.
  process.env.PACKSCOUT_DATA_API_TOKEN = "";
  process.env.PACKSCOUT_TASK010_ADMIN_PASSWORD = "";
  await import("../../apps/admin/server/index.ts");
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(safeTask010Failure(error))}\n`);
  process.exitCode = 1;
});
