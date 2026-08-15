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
  CatalogPromotionWorkerConfigurationError,
  readCatalogPromotionWorkerConfiguration,
} from "./catalog-promotion-worker-config.ts";
import {
  JsonConsoleCatalogPromotionWorkerLogger,
} from "./catalog-promotion-worker-runtime.ts";
import {
  HeatPromotionWorkerConfigurationError,
  readHeatPromotionWorkerConfiguration,
} from "./heat-promotion-worker-config.ts";
import {
  JsonConsoleHeatPromotionWorkerLogger,
} from "./heat-promotion-worker-runtime.ts";
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
  const catalogConfiguration = readCatalogPromotionWorkerConfiguration(
    process.env,
  );
  const heatConfiguration = readHeatPromotionWorkerConfiguration(
    process.env,
    catalogConfiguration,
  );
  const logger = new JsonConsoleProviderWorkerLogger();
  const catalogLogger = new JsonConsoleCatalogPromotionWorkerLogger();
  const heatLogger = new JsonConsoleHeatPromotionWorkerLogger();
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
      catalog: catalogConfiguration,
      heat: heatConfiguration,
      database: databaseLifecycle.client,
      providerLogger: logger,
      catalogLogger,
      heatLogger,
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
      : error instanceof CatalogPromotionWorkerConfigurationError
        ? error.code
      : error instanceof HeatPromotionWorkerConfigurationError
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
