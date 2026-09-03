import { hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createPrismaClientLifecycle } from "@packscout/database";
import { createProductionWorkerRuntime } from "./production-worker-composition.ts";
import { JsonConsoleProviderWorkerObservability } from "./provider-worker-observability.ts";
import {
  JsonConsoleProviderWorkerLogger,
} from "./provider-worker-runtime.ts";
import {
  HeatPromotionWorkerConfigurationError,
  readHeatPromotionWorkerConfiguration,
} from "./heat-promotion-worker-config.ts";
import {
  JsonConsoleHeatPromotionWorkerLogger,
} from "./heat-promotion-worker-runtime.ts";
import {
  CatalogRetentionWorkerConfigurationError,
  assertCatalogRetentionCredentialRoleIsolation,
  readCatalogRetentionWorkerConfiguration,
} from "./catalog-retention-worker-config.ts";
import { JsonConsoleCatalogRetentionWorkerLogger } from
  "./catalog-retention-worker-runtime.ts";
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
  if (configuration.sourceSupervisor === undefined) {
    // None of the PACKSCOUT_SOURCE_* settings are set, so the supervisor lane
    // stays off; a partially set group fails configuration above instead.
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "provider_source_supervisor_disabled",
        workerId: configuration.workerId,
        reason: "source_supervisor_environment_unset",
      }),
    );
  }
  const heatConfiguration = readHeatPromotionWorkerConfiguration(process.env);
  const retentionConfiguration = readCatalogRetentionWorkerConfiguration(
    process.env,
    heatConfiguration,
  );
  assertCatalogRetentionCredentialRoleIsolation({
    heat: heatConfiguration,
    retention: retentionConfiguration,
  });
  const logger = new JsonConsoleProviderWorkerLogger();
  const heatLogger = new JsonConsoleHeatPromotionWorkerLogger();
  const retentionLogger = new JsonConsoleCatalogRetentionWorkerLogger();
  const databaseLifecycle = createPrismaClientLifecycle({
    databaseUrl: configuration.databaseUrl,
  });
  try {
    await databaseLifecycle.start();
    const observability = new JsonConsoleProviderWorkerObservability(
      configuration.workerId,
    );
    const runtime = createProductionWorkerRuntime({
      provider: configuration,
      heat: heatConfiguration,
      retention: retentionConfiguration,
      database: databaseLifecycle.client,
      providerLogger: logger,
      heatLogger,
      retentionLogger,
      observability,
    });
    const stop = () => runtime.stop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await runtime.start();
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } finally {
    await databaseLifecycle.close();
  }
}

runProviderWorker().catch((error: unknown) => {
  const failureCode =
    error instanceof ProviderWorkerConfigurationError
      ? error.code
      : error instanceof HeatPromotionWorkerConfigurationError
        ? error.code
      : error instanceof CatalogRetentionWorkerConfigurationError
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
