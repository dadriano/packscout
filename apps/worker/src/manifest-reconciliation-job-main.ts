import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createCentralDatabaseLifecycle } from "@packscout/database";
import { createDirectCentralManifestGateProofSource } from
  "./direct-central-manifest-gate-proof-source.ts";
import { Ed25519DistributedPromotionManualCommandVerifier } from
  "./distributed-promotion-manual-command-attestation.ts";
import { readManifestReconciliationJobProcessConfiguration } from
  "./distributed-promotion-job-process-config.ts";
import { runDistributedPromotionJobProcess } from
  "./distributed-promotion-job-process.ts";
import { JsonConsoleDistributedPromotionJobRuntimeLogger } from
  "./distributed-promotion-job-runtime.ts";
import { createManifestReconciliationJobRuntime } from
  "./manifest-reconciliation-job-runtime-composition.ts";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
dotenv.config({ path: path.join(workspaceRoot, ".env") });

function fallbackWorkerId(): string {
  const host = hostname().replaceAll(/[^A-Za-z0-9._-]/gu, "-")
    .slice(0, 40) || "host";
  return `manifest-reconciliation:${host}:${process.pid}:${randomUUID()}`;
}

function safeFailureCode(error: unknown): string {
  if (
    error !== null && typeof error === "object" && "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
  ) return error.code;
  return "MANIFEST_RECONCILIATION_JOB_FATAL";
}

async function main(): Promise<void> {
  const configuration = readManifestReconciliationJobProcessConfiguration(
    process.env,
    fallbackWorkerId(),
  );
  const manualCommands = new Ed25519DistributedPromotionManualCommandVerifier({
    publicKeyPem: configuration.manualCommandPublicKeyPem,
  });
  const database = createCentralDatabaseLifecycle({
    databaseUrl: configuration.databaseUrl,
    connectionLimit: 2,
  });
  const logger = new JsonConsoleDistributedPromotionJobRuntimeLogger();
  await runDistributedPromotionJobProcess({
    configuration,
    database,
    createRuntime(central) {
      const proofs = createDirectCentralManifestGateProofSource({ central });
      return createManifestReconciliationJobRuntime({
        authority: configuration.authority,
        central,
        proofs,
        workerId: configuration.workerId,
        logger,
        manualCommands,
        pollMilliseconds: configuration.pollMilliseconds,
      }).runtime;
    },
  });
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: "error",
    event: "manifest_reconciliation_job_fatal",
    failureCode: safeFailureCode(error),
  }));
  process.exitCode = 1;
});
