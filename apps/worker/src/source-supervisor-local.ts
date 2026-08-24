import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createPrismaClientLifecycle } from "@packscout/database";
import { createProviderSourceSupervisorRuntime } from
  "./provider-source-supervisor-composition.ts";
import { runProviderSourceSupervisorOnly } from
  "./source-supervisor-bootstrap.ts";
import { ProviderSourceSupervisorConfigurationError } from
  "./source-supervisor-runtime-config.ts";

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workspaceRoot = path.resolve(workerRoot, "..", "..");

dotenv.config({ path: path.join(workspaceRoot, ".env") });

function fallbackWorkerId(): string {
  const host =
    hostname().replaceAll(/[^A-Za-z0-9._-]/gu, "-").slice(0, 64) || "host";
  return `${host}:${process.pid}:${randomUUID()}`;
}

runProviderSourceSupervisorOnly({
  environment: process.env,
  fallbackWorkerId: fallbackWorkerId(),
  dependencies: {
    createDatabaseLifecycle: createPrismaClientLifecycle,
    createRuntime: createProviderSourceSupervisorRuntime,
  },
}).catch((error: unknown) => {
  console.error(JSON.stringify({
    level: "error",
    event: "provider_source_supervisor_fatal",
    failureCode: error instanceof ProviderSourceSupervisorConfigurationError
      ? error.code
      : "PROVIDER_SOURCE_SUPERVISOR_FATAL",
  }));
  process.exitCode = 1;
});
