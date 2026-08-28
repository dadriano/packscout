#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import { createNodeAuthSecurity } from "../../apps/admin/server/auth/crypto.ts";
import {
  TASK010_PROVIDER_IDENTITIES,
  TASK010_SAFETY_VERSION,
  Task010SafetyError,
  assertNoTask010Arguments,
  loadTask010EnvironmentFile,
  readTask010Environment,
  safeTask010Failure,
} from "./provider-source-task010-safety.mjs";
import {
  assertTask010CapacityApproved,
  bootstrapTask010Target,
  createTask010CapacityReceipt,
  openTask010Database,
  readTask010BootstrapSnapshot,
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
    const bootstrapSnapshot = await readTask010BootstrapSnapshot(
      client,
      environment,
    );
    let passwordHash: string | undefined;
    if (bootstrapSnapshot.markerCount === 0) {
      const firstRunEnvironment = readTask010Environment(task010Environment, {
        requireAdministratorPassword: true,
      });
      passwordHash = await createNodeAuthSecurity(
        firstRunEnvironment.sessionSecret,
      ).passwordHasher.hash(firstRunEnvironment.administratorPassword);
    }
    const outcome = await bootstrapTask010Target({
      client,
      environment,
      passwordHash,
      databaseIdentity: target.fingerprint,
      capacityReceipt: capacity,
    });
    await verifyTask010SourceTopology(client, environment);
    process.stdout.write(
      `${JSON.stringify({
        version: TASK010_SAFETY_VERSION,
        ok: true,
        operation: "bootstrap_target",
        outcome,
        target: { ...target.identity, fingerprint: target.fingerprint },
        organizationId: environment.organizationId,
        administratorId: environment.administratorId,
        providerIdentities: TASK010_PROVIDER_IDENTITIES,
        legacyProviderRuntimeRows: 0,
        capacity,
      })}\n`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(safeTask010Failure(error))}\n`);
  process.exitCode = 1;
});
