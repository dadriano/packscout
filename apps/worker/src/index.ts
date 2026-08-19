import { hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createPrismaClientLifecycle } from "@packscout/database";
import { createDataForrestProviderTransportRegistry } from "@packscout/services";
import { createProviderWorkerRuntime } from "./provider-worker-composition.ts";
import { JsonConsoleProviderWorkerObservability } from "./provider-worker-observability.ts";
import { JsonConsoleProviderWorkerLogger } from "./provider-worker-runtime.ts";
import {
  ProviderWorkerConfigurationError,
  readProviderWorkerConfiguration,
} from "./runtime-config.ts";

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workspaceRoot = path.resolve(workerRoot, "..", "..");

if (process.env.PACKSCOUT_WORKER_SKIP_DOTENV !== "1") {
  dotenv.config({ path: path.join(workspaceRoot, ".env") });
}

function fallbackWorkerId(): string {
  const host =
    hostname()
      .replaceAll(/[^A-Za-z0-9._-]/g, "-")
      .slice(0, 64) || "host";
  return `${host}:${process.pid}:${randomUUID()}`;
}

async function runProviderWorker(): Promise<void> {
  const configuration = readProviderWorkerConfiguration(
    process.env,
    fallbackWorkerId(),
  );
  const logger = new JsonConsoleProviderWorkerLogger();
  const databaseLifecycle = createPrismaClientLifecycle({
    databaseUrl: configuration.databaseUrl,
  });
  try {
    await databaseLifecycle.start();
    const observability = new JsonConsoleProviderWorkerObservability(
      configuration.workerId,
    );
    const runtime = createProviderWorkerRuntime({
      configuration,
      database: databaseLifecycle.client,
      logger,
      observability,
      transportAdapters: createDataForrestProviderTransportRegistry(),
    });
    const stop = () => runtime.stop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      if (configuration.executionMode === "one-shot") {
        const result = await runtime.runOneShot(configuration.oneShotTarget!);
        if (result.failures > 0) {
          throw new Error("One-shot provider worker failed.");
        }
      } else {
        await runtime.start();
      }
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
