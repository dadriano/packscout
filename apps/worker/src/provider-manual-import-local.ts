import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  BoundedProviderDatabaseGateway,
  PrismaProviderSourceRequestAuditRepository,
  createCentralDatabaseLifecycle,
  locateProviderDatabase,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  CipherProviderDatabaseCredentialResolver,
} from "@packscout/services";
import {
  CentralDataforrestSourceAuthorityResolver,
} from
  "./dataforrest-source-authority-resolver.ts";
import { createProviderActivityRelayCoordinator } from
  "./provider-activity-relay.ts";
import {
  providerDataforrestLiveIntegrationRegistry,
} from "./provider-dataforrest-live-integration.ts";
import { ProviderDataforrestMixedPageSource } from
  "./provider-dataforrest-mixed-page-source.ts";
import { createProviderDataforrestRequestTerminalizer } from
  "./provider-dataforrest-request-terminalizer.ts";
import { createProviderManualImportExecutor } from
  "./provider-manual-import-executor.ts";
import {
  readProviderManualImportLaneSupervisorConfiguration,
  runProviderManualImportLanesOnce,
  type ProviderManualImportLane,
  type ProviderManualImportLaneOutcome,
} from "./provider-manual-import-lane-supervisor.ts";
import {
  ProviderManualImportLocalError,
  readProviderManualImportLocalConfiguration,
  runProviderManualImportOnce,
} from "./provider-manual-import-local-runtime.ts";
import { readProviderManualImportDatabaseConfiguration } from
  "./provider-manual-import-database-configuration.ts";
import {
  providerManualImportProcessExitCode,
  type ProviderManualImportProcessResult,
} from "./provider-manual-import-process-result.ts";

const workerRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workspaceRoot = path.resolve(workerRoot, "..", "..");
dotenv.config({ path: path.join(workspaceRoot, ".env") });

const fallbackWorkerId = `${
  hostname().replaceAll(/[^A-Za-z0-9._-]/gu, "-").slice(0, 64) || "host"
}:${process.pid}:${randomUUID()}`;

function required(value: string | undefined): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0 || /[\r\n\0]/u.test(normalized)) {
    throw new ProviderManualImportLocalError(
      "PROVIDER_IMPORT_CONFIGURATION_INVALID",
    );
  }
  return normalized;
}

function credentialKey(environment: NodeJS.ProcessEnv): Readonly<{
  key: Uint8Array;
  version: number;
}> {
  const encoded = required(
    environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64,
  );
  const key = Buffer.from(encoded, "base64");
  const version = Number(
    environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION?.trim() ?? "1",
  );
  if (
    key.byteLength !== 32
    || key.toString("base64").replace(/=+$/u, "") !==
      encoded.replace(/=+$/u, "")
    || !Number.isInteger(version)
    || version < 1
  ) {
    throw new ProviderManualImportLocalError(
      "PROVIDER_IMPORT_CONFIGURATION_INVALID",
    );
  }
  return Object.freeze({ key: new Uint8Array(key), version });
}

async function run(): Promise<ProviderManualImportProcessResult> {
  const databaseConfiguration = readProviderManualImportDatabaseConfiguration(process.env);
  const laneSupervisor =
    process.env.PACKSCOUT_PROVIDER_LANES_JSON === undefined
      ? null
      : readProviderManualImportLaneSupervisorConfiguration(
          process.env,
          fallbackWorkerId,
        );
  const selected = laneSupervisor === null
    ? readProviderManualImportLocalConfiguration(
        process.env,
        fallbackWorkerId,
      )
    : null;
  const maximumConcurrentLanes =
    laneSupervisor?.maximumConcurrency ?? 2;
  const key = credentialKey(process.env);
  const cipher = new AesGcmProviderCredentialCipher({
    primaryVersion: key.version,
    keys: new Map([[key.version, key.key]]),
  });
  const central = createCentralDatabaseLifecycle({
    databaseUrl: databaseConfiguration.centralDatabaseUrl,
    connectionLimit: maximumConcurrentLanes,
  });
  const gateway = new BoundedProviderDatabaseGateway({
    central,
    credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
    destinationPolicy: databaseConfiguration.runtimePolicy.destinationPolicy,
    connectionLimitPerProvider: 2,
    maximumCachedProviders: maximumConcurrentLanes,
    operationTimeoutMs: 60_000,
  });
  try {
    await central.start();
    const centralAuthorityResolver = new CentralDataforrestSourceAuthorityResolver({
      central: central.client,
      credentialCipher: cipher,
    });
    const runLane = async (
      lane: ProviderManualImportLane,
    ): Promise<Awaited<ReturnType<typeof runProviderManualImportOnce>>> => {
      const integration = providerDataforrestLiveIntegrationRegistry
        .resolveProvider(lane.providerKey);
      if (integration === null) {
        throw new ProviderManualImportLocalError(
          "PROVIDER_IMPORT_CONFIGURATION_INVALID",
        );
      }
      return runProviderManualImportOnce({
        environment: {
          PACKSCOUT_PROVIDER_ID: lane.providerId,
          PACKSCOUT_PROVIDER_KEY: lane.providerKey,
          PACKSCOUT_PROVIDER_WORKER_ID: lane.workerId,
        },
        fallbackWorkerId: lane.workerId,
        dependencies: {
          async bootstrapProvider(input) {
            if (
              input.providerId !== lane.providerId
              || input.providerKey !== lane.providerKey
            ) return null;
            const provider = await central.client.providers.findUnique({
              where: { id: input.providerId },
              select: {
                id: true,
                organization_id: true,
                provider_key: true,
                lifecycle: true,
                active_config_version_id: true,
                active_config_version: {
                  select: {
                    id: true,
                    version_number: true,
                    adapter_key: true,
                  },
                },
              },
            });
            if (
              provider === null
              || provider.lifecycle !== "active"
              || provider.provider_key !== input.providerKey
              || provider.active_config_version_id === null
              || provider.active_config_version === null
              || provider.active_config_version.id !==
                provider.active_config_version_id
              || provider.active_config_version.adapter_key !==
                integration.manifest.adapterVersion
            ) return null;
            const located = await locateProviderDatabase(central.client, {
              organizationId: provider.organization_id,
              providerId: provider.id,
            });
            if (
              located.state !== "ready"
              || located.route.configVersionId !==
                provider.active_config_version.id
              || located.route.organizationId !== provider.organization_id
              || located.route.target.providerId !== provider.id
              || located.route.target.providerKey !== input.providerKey
            ) return null;
            const sourceAuthority = await centralAuthorityResolver.resolve({
              providerId: provider.id,
              providerKey: input.providerKey,
              configVersionId: provider.active_config_version.id,
              configVersionNumber:
                provider.active_config_version.version_number,
              adapterKey: provider.active_config_version.adapter_key,
            });
            return Object.freeze({
              organizationId: provider.organization_id,
              providerId: provider.id,
              providerKey: input.providerKey,
              databaseRoute: located.route,
              sourceAuthority,
              integration,
            });
          },
          runWithCachedProviderDatabase:
            gateway.runWithCachedProviderDatabase.bind(gateway),
          createExecutor(input) {
            const audit = new PrismaProviderSourceRequestAuditRepository(
              input.database,
            );
            const source = new ProviderDataforrestMixedPageSource({
              authorityResolver: input.sourceAuthorityResolver,
              integration: input.integration,
              workerId: input.workerId,
              translationRecorder: audit,
              terminalizeRequest: createProviderDataforrestRequestTerminalizer({
                audit,
                workerId: input.workerId,
              }),
            });
            return createProviderManualImportExecutor({
              database: input.database,
              captureRoot: null,
              actorHmacKey: null,
              workerId: input.workerId,
              liveSource: source,
            });
          },
          async relayProviderActivity() {
            const result = await createProviderActivityRelayCoordinator({
              central: central.client,
              gateway,
              batchSize: 100,
              maximumProviders: 1,
              maximumConcurrentProviders: 1,
              providerId: lane.providerId,
            }).runCycle();
            if (result.failures > 0 || result.unreachable > 0) {
              throw new Error("Provider activity relay did not complete.");
            }
          },
          observeRelayFailure(failureCode) {
            console.warn(JSON.stringify({
              level: "warning",
              event: "provider_activity_relay_failed",
              providerKey: lane.providerKey,
              failureCode,
            }));
          },
        },
      });
    };

    if (selected !== null) {
      return await runLane(Object.freeze({
        providerId: selected.providerId,
        providerKey: selected.providerKey,
        workerId: selected.workerId,
      }));
    }
    if (laneSupervisor === null) {
      throw new ProviderManualImportLocalError(
        "PROVIDER_IMPORT_CONFIGURATION_INVALID",
      );
    }
    return await runProviderManualImportLanesOnce({
      lanes: laneSupervisor.lanes,
      maximumConcurrency: laneSupervisor.maximumConcurrency,
      runLane,
    });
  } finally {
    await gateway.close();
    await central.close();
  }
}

run().then(
  (result) => {
    const laneOutcomes = Array.isArray(result)
      ? result as readonly ProviderManualImportLaneOutcome[]
      : null;
    console.log(JSON.stringify({
      level: "info",
      event: laneOutcomes === null
        ? "provider_manual_import_once_finished"
        : "provider_manual_import_lanes_once_finished",
      result,
    }));
    process.exitCode = providerManualImportProcessExitCode(result);
  },
  (error: unknown) => {
    console.error(JSON.stringify({
      level: "error",
      event: "provider_manual_import_once_failed",
      failureCode: error instanceof ProviderManualImportLocalError
        ? error.code
        : "PROVIDER_IMPORT_FAILED",
    }));
    process.exitCode = 1;
  },
);
