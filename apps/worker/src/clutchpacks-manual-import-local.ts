import { hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  BoundedProviderDatabaseGateway,
  PrismaProviderSourceRequestAuditRepository,
  ProviderDatabaseDestinationPolicy,
  createCentralDatabaseLifecycle,
  createProviderDatabaseLifecycle,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  CipherProviderDatabaseCredentialResolver,
} from "@packscout/services";
import { createProviderManualImportExecutor } from
  "./provider-manual-import-executor.ts";
import {
  ClutchpacksManualImportLocalError,
  runClutchpacksManualImportOnce,
} from "./clutchpacks-manual-import-local-runtime.ts";
import { createProviderActivityRelayCoordinator } from
  "./provider-activity-relay.ts";
import { CentralDataforrestSourceAuthorityResolver } from
  "./dataforrest-source-authority-resolver.ts";
import { ProviderDataforrestMixedPageSource } from
  "./provider-dataforrest-mixed-page-source.ts";
import { providerDataforrestLiveIntegrationRegistry } from
  "./provider-dataforrest-live-integration.ts";
import { createProviderDataforrestRequestTerminalizer } from
  "./provider-dataforrest-request-terminalizer.ts";

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workspaceRoot = path.resolve(workerRoot, "..", "..");
dotenv.config({ path: path.join(workspaceRoot, ".env") });

const fallbackWorkerId = `${
  hostname().replaceAll(/[^A-Za-z0-9._-]/gu, "-").slice(0, 64) || "host"
}:${process.pid}:${randomUUID()}`;

function requiredCredentialKey(environment: NodeJS.ProcessEnv): Readonly<{
  key: Uint8Array;
  version: number;
}> {
  const encoded = environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64?.trim()
    ?? "";
  const key = Buffer.from(encoded, "base64");
  const version = Number(
    environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION?.trim() ?? "1",
  );
  if (
    key.byteLength !== 32
    || key.toString("base64").replace(/=+$/u, "")
      !== encoded.replace(/=+$/u, "")
    || !Number.isInteger(version)
    || version < 1
  ) {
    throw new Error("Provider activity relay configuration is invalid.");
  }
  return { key: new Uint8Array(key), version };
}

async function runWithoutCentralAuthority(): Promise<Awaited<ReturnType<
  typeof runClutchpacksManualImportOnce
>>> {
  return runClutchpacksManualImportOnce({
    environment: process.env,
    fallbackWorkerId,
    dependencies: {
      createDatabaseLifecycle: createProviderDatabaseLifecycle,
      createExecutor: createProviderManualImportExecutor,
    },
  });
}

async function runWithCentralAuthority(): Promise<Awaited<ReturnType<
  typeof runClutchpacksManualImportOnce
>>> {
  const centralDatabaseUrl =
    process.env.PACKSCOUT_CENTRAL_DATABASE_URL?.trim() ?? "";
  if (centralDatabaseUrl.length === 0) return runWithoutCentralAuthority();
  const providerDatabaseUrl = new URL(
    process.env.PACKSCOUT_PROVIDER_DATABASE_URL ?? "",
  );
  const { key, version } = requiredCredentialKey(process.env);
  const cipher = new AesGcmProviderCredentialCipher({
    primaryVersion: version,
    keys: new Map([[version, key]]),
  });
  const central = createCentralDatabaseLifecycle({
    databaseUrl: centralDatabaseUrl,
    connectionLimit: 2,
  });
  const gateway = new BoundedProviderDatabaseGateway({
    central,
    credentialResolver: new CipherProviderDatabaseCredentialResolver(
      cipher,
    ),
    destinationPolicy: new ProviderDatabaseDestinationPolicy({
      allowedHosts: [providerDatabaseUrl.hostname],
      allowedPorts: [
        providerDatabaseUrl.port.length === 0
          ? 5432
          : Number(providerDatabaseUrl.port),
      ],
      allowedSslModes: ["disable", "require", "verify-ca", "verify-full"],
    }),
    connectionLimitPerProvider: 2,
    maximumCachedProviders: 2,
  });
  try {
    await central.start();
    const authorityResolver = new CentralDataforrestSourceAuthorityResolver({
      central: central.client,
      credentialCipher: cipher,
    });
    return await runClutchpacksManualImportOnce({
      environment: process.env,
      fallbackWorkerId,
      sourceMode: "live",
      dependencies: {
        createDatabaseLifecycle: createProviderDatabaseLifecycle,
        createExecutor(input) {
          const audit = new PrismaProviderSourceRequestAuditRepository(
            input.database,
          );
          const liveSource = new ProviderDataforrestMixedPageSource({
            authorityResolver,
            integration:
              providerDataforrestLiveIntegrationRegistry.resolveProvider(
                "clutchpacks",
              ) ?? (() => {
                throw new Error("ClutchPacks live integration is unavailable.");
              })(),
            workerId: input.workerId,
            translationRecorder: audit,
            terminalizeRequest:
              createProviderDataforrestRequestTerminalizer({
                audit,
                workerId: input.workerId,
              }),
          });
          return createProviderManualImportExecutor({
            ...input,
            liveSource,
          });
        },
        async relayProviderActivity() {
          const result = await createProviderActivityRelayCoordinator({
            central: central.client,
            gateway,
            batchSize: 100,
            maximumProviders: 100,
            maximumConcurrentProviders: 2,
            providerId: process.env.PACKSCOUT_PROVIDER_ID,
          }).runCycle();
          if (result.failures > 0 || result.unreachable > 0) {
            throw new Error("Provider activity relay did not complete.");
          }
        },
        observeRelayFailure(failureCode) {
          console.warn(JSON.stringify({
            level: "warning",
            event: "clutchpacks_provider_activity_relay_failed",
            failureCode,
          }));
        },
      },
    });
  } finally {
    await gateway.close();
    await central.close();
  }
}

runWithCentralAuthority().then(
  (result) => {
    console.log(JSON.stringify({
      level: "info",
      event: "clutchpacks_manual_import_once_finished",
      result,
    }));
  },
  (error: unknown) => {
    console.error(JSON.stringify({
      level: "error",
      event: "clutchpacks_manual_import_once_failed",
      failureCode: error instanceof ClutchpacksManualImportLocalError
        ? error.code
        : "CLUTCHPACKS_IMPORT_FAILED",
    }));
    process.exitCode = 1;
  },
);
