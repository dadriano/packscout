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

function safeLocalFailure(error: unknown): Readonly<{
  failureCode: string;
  errorName: string;
  message: string;
}> {
  const candidate = typeof error === "object" && error !== null
    ? error as Readonly<{ code?: unknown }>
    : null;
  const code = typeof candidate?.code === "string" &&
      /^[A-Za-z0-9_]{1,128}$/u.test(candidate.code)
    ? candidate.code
    : null;
  const message = error instanceof Error
    ? error.message
      .replace(/postgres(?:ql)?:\/\/[^@\s]+@/giu, "postgresql://[redacted]@")
      .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
      .replace(/[A-Za-z0-9+/=]{40,}/gu, "[redacted]")
      .slice(0, 1_024)
    : "Unknown local supervisor failure.";
  return {
    failureCode: code ?? "PROVIDER_SOURCE_SUPERVISOR_FATAL",
    errorName: error instanceof Error ? error.name : "UnknownError",
    message,
  };
}

runProviderSourceSupervisorOnly({
  environment: process.env,
  fallbackWorkerId: fallbackWorkerId(),
  dependencies: {
    createDatabaseLifecycle: createPrismaClientLifecycle,
    createRuntime: createProviderSourceSupervisorRuntime,
  },
}).catch((error: unknown) => {
  const failure = safeLocalFailure(error);
  console.error(JSON.stringify({
    level: "error",
    event: "provider_source_supervisor_fatal",
    failureCode: error instanceof ProviderSourceSupervisorConfigurationError
      ? error.code
      : failure.failureCode,
    errorName: failure.errorName,
    message: failure.message,
  }));
  process.exitCode = 1;
});
