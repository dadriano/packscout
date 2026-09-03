import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  BoundedProviderDatabaseGateway,
  createCentralDatabaseLifecycle,
  ProviderDatabaseDestinationPolicy,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  CipherProviderDatabaseCredentialResolver,
} from "@packscout/services";
import { createPromotionJobLivenessOneShot } from
  "./promotion-job-liveness-composition.ts";
import { readPromotionJobLivenessProcessConfiguration } from
  "./promotion-job-liveness-process-config.ts";
import { runPromotionJobLivenessProcess } from
  "./promotion-job-liveness-process.ts";
import {
  JsonConsolePromotionJobLivenessRuntimeLogger,
  PromotionJobLivenessRuntime,
} from "./promotion-job-liveness-runtime.ts";
import { PromotionJobSystemConditionWebhook } from
  "./promotion-job-system-condition-webhook.ts";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
dotenv.config({ path: path.join(workspaceRoot, ".env") });

function safeFailureCode(error: unknown): string {
  if (
    error !== null && typeof error === "object" && "code" in error
    && typeof error.code === "string"
    && /^[A-Z][A-Z0-9_]{0,127}$/u.test(error.code)
  ) return error.code;
  return "PROMOTION_JOB_LIVENESS_EVALUATOR_FATAL";
}

async function main(): Promise<void> {
  const configuration = readPromotionJobLivenessProcessConfiguration(
    process.env,
  );
  const central = createCentralDatabaseLifecycle({
    databaseUrl: configuration.centralDatabaseUrl,
    connectionLimit: Math.min(
      8,
      Math.max(2, configuration.evaluator.providerConcurrency),
    ),
  });
  const credentialCipher = new AesGcmProviderCredentialCipher({
    primaryVersion: configuration.providerCredentialKey.version,
    keys: new Map([[
      configuration.providerCredentialKey.version,
      configuration.providerCredentialKey.bytes,
    ]]),
  });
  const gateway = new BoundedProviderDatabaseGateway({
    central,
    credentialResolver: new CipherProviderDatabaseCredentialResolver(
      credentialCipher,
    ),
    destinationPolicy: new ProviderDatabaseDestinationPolicy(
      configuration.providerDestinations,
    ),
    connectionLimitPerProvider:
      configuration.gateway.connectionLimitPerProvider,
    maximumCachedProviders: configuration.gateway.maximumCachedProviders,
    operationTimeoutMs: configuration.gateway.operationTimeoutMs,
    closeTimeoutMs: configuration.gateway.closeTimeoutMs,
  });
  const systemConditionSink = new PromotionJobSystemConditionWebhook({
    baseUrl: configuration.systemSink.url,
    bearerToken: configuration.systemSink.bearerToken,
    timeoutMilliseconds: configuration.systemSink.timeoutMs,
  });
  const logger = new JsonConsolePromotionJobLivenessRuntimeLogger();

  await runPromotionJobLivenessProcess({
    mode: configuration.mode,
    database: central,
    gateway,
    createRuntime(centralClient) {
      return new PromotionJobLivenessRuntime({
        oneShot: createPromotionJobLivenessOneShot({
          central: centralClient,
          gateway,
          systemConditionSink,
          providerConcurrency: configuration.evaluator.providerConcurrency,
          rosterPageSize: configuration.evaluator.rosterPageSize,
          maximumProviders: configuration.evaluator.maximumProviders,
          deliveryLimit: configuration.evaluator.deliveryLimit,
        }),
        logger,
      });
    },
  });
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: "error",
    event: "promotion_job_liveness_evaluator_fatal",
    failureCode: safeFailureCode(error),
  }));
  process.exitCode = 1;
});
