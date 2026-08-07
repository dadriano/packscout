import { hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Pool } from "pg";
import { createNodePostgresDatabase } from "@packscout/database";
import { createProviderWorkerRuntime } from "./provider-worker-composition.ts";
import { JsonConsoleProviderWorkerObservability } from "./provider-worker-observability.ts";
import {
  JsonConsoleProviderWorkerLogger,
  type ProviderWorkerLogEvent,
} from "./provider-worker-runtime.ts";
import {
  ProviderWorkerConfigurationError,
  readProviderWorkerConfiguration,
} from "./runtime-config.ts";

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workspaceRoot = path.resolve(workerRoot, "..", "..");

dotenv.config({ path: path.join(workspaceRoot, ".env") });

function fallbackWorkerId(): string {
  const host =
    hostname().replaceAll(/[^A-Za-z0-9._-]/g, "-").slice(0, 64) || "host";
  return `${host}:${process.pid}:${randomUUID()}`;
}

async function runProviderWorker(): Promise<void> {
  const configuration = readProviderWorkerConfiguration(
    process.env,
    fallbackWorkerId(),
  );
  const logger = new JsonConsoleProviderWorkerLogger();
  const pool = new Pool({
    connectionString: configuration.databaseUrl,
    max: configuration.databasePoolMaximum,
  });
  const database = createNodePostgresDatabase(pool);
  const observability = new JsonConsoleProviderWorkerObservability(
    configuration.workerId,
  );
  const runtime = createProviderWorkerRuntime({
    configuration,
    database,
    logger,
    observability,
  });
  const stop = () => runtime.stop();
  const poolFailure = () => {
    const event: ProviderWorkerLogEvent = {
      level: "error",
      event: "provider_database_pool_failed",
      workerId: configuration.workerId,
      failureCode: "DATABASE_POOL_ERROR",
    };
    logger.write(event);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  pool.on("error", poolFailure);
  try {
    await runtime.start();
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    pool.removeListener("error", poolFailure);
    await pool.end();
  }
}

runProviderWorker().catch((error: unknown) => {
  const failureCode =
    error instanceof ProviderWorkerConfigurationError
      ? error.code
      : "PROVIDER_WORKER_FATAL";
  console.error(
    JSON.stringify({
      level: "error",
      event: "provider_worker_fatal",
      failureCode,
    }),
  );
  process.exitCode = 1;
});
