import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  BoundedProviderDatabaseGateway,
  createCentralDatabaseLifecycle,
  PrismaManifestPromotionImmediateDeliveryRepository,
  ProviderDatabaseDestinationPolicy,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  CipherProviderDatabaseCredentialResolver,
} from "@packscout/services";
import { createProviderActivityRelayCoordinator } from
  "./provider-activity-relay.ts";
import { readProviderActivityRelayProcessConfiguration } from
  "./provider-activity-relay-process-config.ts";
import { runProviderActivityRelayProcess } from
  "./provider-activity-relay-process.ts";
import {
  JsonConsoleProviderActivityRelayRuntimeLogger,
  ProviderActivityRelayRuntime,
} from "./provider-activity-relay-runtime.ts";

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
  return "PROVIDER_ACTIVITY_RELAY_FATAL";
}

async function main(): Promise<void> {
  const configuration = readProviderActivityRelayProcessConfiguration(
    process.env,
  );
  const central = createCentralDatabaseLifecycle({
    databaseUrl: configuration.centralDatabaseUrl,
    connectionLimit: Math.min(
      8,
      Math.max(2, configuration.relay.maximumConcurrentProviders),
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
    idleLifetimeMs: configuration.gateway.idleLifetimeMs,
    connectionTimeoutMs: configuration.gateway.connectionTimeoutMs,
    operationTimeoutMs: configuration.gateway.operationTimeoutMs,
    closeTimeoutMs: configuration.gateway.closeTimeoutMs,
  });
  const logger = new JsonConsoleProviderActivityRelayRuntimeLogger();

  await runProviderActivityRelayProcess({
    mode: configuration.mode,
    database: central,
    gateway,
    createRuntime(centralClient) {
      return new ProviderActivityRelayRuntime({
        coordinator: createProviderActivityRelayCoordinator({
          central: centralClient,
          gateway,
          batchSize: configuration.relay.batchSize,
          maximumProviders: configuration.relay.maximumProvidersPerCycle,
          maximumConcurrentProviders:
            configuration.relay.maximumConcurrentProviders,
          baseBackoffMilliseconds:
            configuration.relay.baseBackoffMilliseconds,
          maximumBackoffMilliseconds:
            configuration.relay.maximumBackoffMilliseconds,
          immediateDelivery:
            new PrismaManifestPromotionImmediateDeliveryRepository(
              centralClient,
            ),
        }),
        pollMilliseconds: configuration.relay.pollMilliseconds,
        logger,
      });
    },
  });
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({
    level: "error",
    event: "provider_activity_relay_fatal",
    failureCode: safeFailureCode(error),
  }));
  process.exitCode = 1;
});
