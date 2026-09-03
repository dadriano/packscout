import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  createCentralDatabaseLifecycle,
  PrismaManifestGateIntentRepository,
  type CentralDatabaseLifecycle,
} from "@packscout/database";
import {
  DistributedManifestGateOperationCommandError,
  readDistributedManifestGateOperationCommandConfiguration,
  runDistributedManifestGateOperationCommand,
} from "./manifest-gate-operation-command.ts";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
dotenv.config({ path: path.join(workspaceRoot, ".env") });

function databaseUrl(environment: NodeJS.ProcessEnv): string {
  const value = environment.PACKSCOUT_CENTRAL_DATABASE_URL;
  if (!value || value.length > 4_096 || /[\r\n\0]/u.test(value)) {
    throw new TypeError("Distributed manifest operation database is invalid.");
  }
  const parsed = new URL(value);
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname || parsed.pathname.length < 2 || parsed.hash
  ) throw new TypeError("Distributed manifest operation database is invalid.");
  return parsed.toString();
}

async function main(): Promise<void> {
  let database: CentralDatabaseLifecycle | undefined;
  try {
    const configuration =
      readDistributedManifestGateOperationCommandConfiguration(process.env);
    database = createCentralDatabaseLifecycle({
      databaseUrl: databaseUrl(process.env),
      connectionLimit: 1,
    });
    await database.start();
    const result = await runDistributedManifestGateOperationCommand(
      new PrismaManifestGateIntentRepository(database.client),
      configuration,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await database?.close().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  const failureCode = error instanceof DistributedManifestGateOperationCommandError
    ? error.code
    : "DISTRIBUTED_MANIFEST_OPERATION_UNAVAILABLE";
  process.stderr.write(`${JSON.stringify({
    status: "rejected",
    failureCode,
  })}\n`);
  process.exitCode = 1;
});
