#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TASK010_SAFETY_VERSION,
  Task010SafetyError,
  assertNoTask010Arguments,
  loadTask010EnvironmentFile,
  readTask010Environment,
  safeTask010Failure,
  task010MigrationInvocation,
} from "./provider-source-task010-safety.mjs";
import {
  assertTask010CapacityApproved,
  assertTask010TargetEmpty,
  createTask010CapacityReceipt,
  openTask010Database,
  verifyTask010DatabaseIdentity,
  verifyTask010MigratedSchema,
} from "./provider-source-task010-runtime.mts";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
function runMigration(input: ReturnType<typeof task010MigrationInvocation>) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(input.executable, input.arguments, {
      cwd: workspaceRoot,
      env: input.environment,
      shell: false,
      stdio: "inherit",
    });
    child.once("error", () =>
      reject(new Task010SafetyError("MIGRATION_PROCESS_FAILED")),
    );
    child.once("exit", (code, signal) => {
      if (code === 0 && signal === null) resolve();
      else reject(new Task010SafetyError("MIGRATION_PROCESS_FAILED"));
    });
  });
}

async function main(): Promise<void> {
  assertNoTask010Arguments(process.argv.slice(2));
  const task010Environment = await loadTask010EnvironmentFile(workspaceRoot);
  const environment = readTask010Environment(task010Environment);
  if (!environment.expectedDatabaseIdentity) {
    throw new Task010SafetyError("DATABASE_IDENTITY_FINGERPRINT_REQUIRED");
  }
  const before = await openTask010Database(environment);
  let target;
  try {
    target = await verifyTask010DatabaseIdentity(before, environment);
    await assertTask010TargetEmpty(before);
    const capacity = await createTask010CapacityReceipt({
      client: before,
      environment,
      databaseIdentity: target.fingerprint,
      databaseDataDirectory: target.identity.dataDirectory,
      schemaReady: false,
    });
    assertTask010CapacityApproved(capacity);
  } finally {
    await before.end().catch(() => undefined);
  }

  const invocation = task010MigrationInvocation({
    nodeExecPath: process.execPath,
    npmExecPath: process.env.npm_execpath,
    databaseUrl: environment.databaseUrl,
    environment: process.env,
  });
  await runMigration(invocation);

  const after = await openTask010Database(environment);
  try {
    const verified = await verifyTask010DatabaseIdentity(after, environment);
    if (verified.fingerprint !== target.fingerprint) {
      throw new Task010SafetyError(
        "DATABASE_IDENTITY_CHANGED_DURING_MIGRATION",
      );
    }
    await verifyTask010MigratedSchema(after);
  } finally {
    await after.end().catch(() => undefined);
  }
  process.stdout.write(
    `${JSON.stringify({
      version: TASK010_SAFETY_VERSION,
      ok: true,
      operation: "migrate_target",
      target: { ...target.identity, fingerprint: target.fingerprint },
    })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify(safeTask010Failure(error))}\n`);
  process.exitCode = 1;
});
