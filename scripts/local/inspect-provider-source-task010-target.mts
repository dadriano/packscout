#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TASK010_SAFETY_VERSION,
  assertNoTask010Arguments,
  loadTask010EnvironmentFile,
  readTask010Environment,
  safeTask010Failure,
} from "./provider-source-task010-safety.mjs";
import {
  assertTask010TargetEmpty,
  createTask010CapacityReceipt,
  openTask010Database,
  verifyTask010DatabaseIdentity,
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
  const client = await openTask010Database(environment);
  try {
    const target = await verifyTask010DatabaseIdentity(client, environment);
    await assertTask010TargetEmpty(client);
    const capacity = await createTask010CapacityReceipt({
      client,
      environment,
      databaseIdentity: target.fingerprint,
      databaseDataDirectory: target.identity.dataDirectory,
      schemaReady: false,
    });
    process.stdout.write(
      `${JSON.stringify({
        version: TASK010_SAFETY_VERSION,
        ok: capacity.decision.decision === "approved",
        operation: "inspect_empty_target",
        target: { ...target.identity, fingerprint: target.fingerprint },
        empty: true,
        capacity,
      })}\n`,
    );
    if (capacity.decision.decision !== "approved") process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(safeTask010Failure(error))}\n`);
  process.exitCode = 1;
});
