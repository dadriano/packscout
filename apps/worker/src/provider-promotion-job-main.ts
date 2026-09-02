import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createProviderDatabaseLifecycle } from "@packscout/database";
import {
  ProviderPromotionBootstrapGatewayClient,
} from "./distributed-promotion-gateway-clients.ts";
import { Ed25519DistributedPromotionManualCommandVerifier } from
  "./distributed-promotion-manual-command-attestation.ts";
import { readProviderPromotionJobProcessConfiguration } from
  "./distributed-promotion-job-process-config.ts";
import { runDistributedPromotionJobProcess } from
  "./distributed-promotion-job-process.ts";
import { JsonConsoleDistributedPromotionJobRuntimeLogger } from
  "./distributed-promotion-job-runtime.ts";
import { createProviderPromotionJobRuntime } from
  "./provider-promotion-job-runtime-composition.ts";

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
  return `provider-promotion:${host}:${process.pid}:${randomUUID()}`;
}

function safeFailureCode(error: unknown): string {
  if (
    error !== null && typeof error === "object" && "code" in error &&
    typeof error.code === "string" &&
    /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
  ) return error.code;
  return "PROVIDER_PROMOTION_JOB_FATAL";
}

async function main(): Promise<void> {
  const configuration = readProviderPromotionJobProcessConfiguration(
    process.env,
    fallbackWorkerId(),
  );
  const bootstrap = new ProviderPromotionBootstrapGatewayClient(
    configuration.bootstrapGateway,
  );
  const manualCommands = new Ed25519DistributedPromotionManualCommandVerifier({
    publicKeyPem: configuration.manualCommandPublicKeyPem,
  });
  const initialPin = await bootstrap.load(configuration.authority.providerId);
  const database = createProviderDatabaseLifecycle({
    databaseUrl: configuration.databaseUrl,
    providerId: configuration.authority.providerId,
    providerKey: initialPin.providerKey,
    connectionLimit: 2,
  });
  const logger = new JsonConsoleDistributedPromotionJobRuntimeLogger();
  await runDistributedPromotionJobProcess({
    configuration,
    database,
    createRuntime(provider) {
      return createProviderPromotionJobRuntime({
        authority: configuration.authority,
        provider,
        pin: initialPin,
        loadPin: () => bootstrap.load(configuration.authority.providerId),
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
    event: "provider_promotion_job_fatal",
    failureCode: safeFailureCode(error),
  }));
  process.exitCode = 1;
});
