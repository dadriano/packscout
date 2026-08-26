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
import { sourceSupervisorFatalEvent } from
  "./source-supervisor-fatal-event.ts";

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
  console.error(JSON.stringify(sourceSupervisorFatalEvent(error)));
  process.exitCode = 1;
});
