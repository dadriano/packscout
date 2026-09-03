#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPrismaClientLifecycle } from "@packscout/database";
import { createProviderSourceSupervisorRuntime } from "../../apps/worker/src/provider-source-supervisor-composition.ts";
import { runProviderSourceSupervisorOnly } from "../../apps/worker/src/source-supervisor-bootstrap.ts";
import {
  TASK010_SAFETY_VERSION,
  Task010SafetyError,
  assertEvidenceTokenAbsent,
  assertBootstrapPasswordAbsent,
  assertNoTask010Arguments,
  loadTask010EnvironmentFile,
  readTask010Environment,
  safeTask010Failure,
  sanitizedTask010WorkerEnvironment,
  task010ConfigurationCapacityDecision,
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
function fallbackWorkerId(): string {
  const host =
    hostname()
      .replaceAll(/[^A-Za-z0-9._-]/gu, "-")
      .slice(0, 64) || "host";
  return `${host}:${process.pid}:${randomUUID()}`;
}

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
  const phase = process.env.PACKSCOUT_TASK010_SUPERVISOR_PHASE;
  if (phase !== "configuration" && phase !== "backfill") {
    throw new Task010SafetyError("SUPERVISOR_PHASE_INVALID");
  }
  const client = await openTask010Database(environment);
  let target;
  let capacity;
  try {
    target = await verifyTask010DatabaseIdentity(client, environment);
    await verifyTask010MigratedSchema(client);
    capacity = await createTask010CapacityReceipt({
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
    await verifyTask010SourceTopology(client, environment, {
      requireBackfillReady: phase === "backfill",
    });
  } finally {
    await client.end().catch(() => undefined);
  }

  process.stdout.write(
    `${JSON.stringify({
      version: TASK010_SAFETY_VERSION,
      ok: true,
      operation: "start_source_supervisor",
      phase,
      target: { ...target.identity, fingerprint: target.fingerprint },
      capacity,
    })}\n`,
  );

  // Do not import the dotenv-owning local entry point: a later dotenv load
  // could reintroduce the evidence token. The owned worker receives a copied,
  // explicitly stripped environment instead.
  const workerEnvironment =
    sanitizedTask010WorkerEnvironment(task010Environment);
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("PACKSCOUT_")) delete process.env[name];
  }
  Object.assign(process.env, workerEnvironment);
  await runProviderSourceSupervisorOnly({
    environment: workerEnvironment,
    fallbackWorkerId: fallbackWorkerId(),
    dependencies: {
      createDatabaseLifecycle: createPrismaClientLifecycle,
      createRuntime: (input) =>
        createProviderSourceSupervisorRuntime({
          ...input,
          ...(phase === "configuration"
            ? {
                capacity: {
                  async probe() {
                    return task010ConfigurationCapacityDecision();
                  },
                },
              }
            : {}),
        }),
    },
  });
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(safeTask010Failure(error))}\n`);
  process.exitCode = 1;
});
