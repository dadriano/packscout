import {
  BoundedProviderDatabaseGateway,
  ProviderDatabaseDestinationPolicy,
  type CentralDatabaseLifecycle,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  CipherProviderDatabaseCredentialResolver,
  createClutchpacksSourceIntegrationCapabilities,
} from "@packscout/services";
import { createDistributedImportOperationsRuntime } from
  "./distributed-import-operations-runtime.ts";
import {
  createCentralObservedOperationalHealthRepository,
  createDistributedMachineryAlertFactsSource,
  createDistributedWorkerFleetEvidence,
} from "./distributed-provider-observer-runtime.ts";
import { createDistributedProviderSourceOperationsRuntime } from
  "./distributed-provider-source-operations-runtime.ts";
import { createAdminManualImportAdmissionRuntime } from
  "./import-operations-runtime.ts";
import { createRoutedProviderManualImportDelegate } from
  "./routed-provider-manual-import.ts";
import {
  readBase64Key,
  readPositiveInteger,
} from "./runtime-config.ts";
import type {
  AdminProviderRuntimeFactory,
  AdminProviderRuntimeFactoryContext,
} from "./runtime.ts";

const PRODUCTION_HOST_VARIABLE =
  "PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS" as const;

function productionHosts(value: string | undefined): readonly string[] {
  const hosts = value?.split(",").map((host) => host.trim()).filter(Boolean) ?? [];
  if (hosts.length === 0 || hosts.length > 64 || new Set(hosts).size !== hosts.length) {
    throw new Error(
      `${PRODUCTION_HOST_VARIABLE} must contain 1 to 64 unique provider database hosts.`,
    );
  }
  return hosts;
}

/** Server-owned destination policy; provider rows can only narrow this set. */
export function readAdminProviderDestinationPolicy(
  environment: NodeJS.ProcessEnv,
): ProviderDatabaseDestinationPolicy {
  const development = environment.NODE_ENV !== "production";
  return development
    ? new ProviderDatabaseDestinationPolicy({
        allowedHosts: ["127.0.0.1"],
        allowedPorts: [55_432],
        allowedSslModes: ["disable"],
      })
    : new ProviderDatabaseDestinationPolicy({
        allowedHosts: productionHosts(environment[PRODUCTION_HOST_VARIABLE]),
        allowedPorts: [5_432],
        allowedSslModes: ["verify-full"],
      });
}

function alreadyStartedCentral(
  context: AdminProviderRuntimeFactoryContext,
): CentralDatabaseLifecycle {
  // createAdminRuntime starts and owns this client immediately before invoking
  // the provider factory. The gateway only needs a readiness gate and client;
  // shutdown remains with the owning central lifecycle.
  return {
    client: context.central,
    async start() {},
  } as CentralDatabaseLifecycle;
}

/** Concrete distributed provider composition for the authoritative admin. */
export const createAdminProviderRuntimeFactory: AdminProviderRuntimeFactory =
  async (context) => {
    const credentialKey = readBase64Key(
      context.environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64,
      "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64",
    );
    const credentialKeyVersion = context.environment
      .PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION === undefined
      ? 1
      : readPositiveInteger(
          context.environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION,
          "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION",
        );
    const gateway = new BoundedProviderDatabaseGateway({
      central: alreadyStartedCentral(context),
      credentialResolver: new CipherProviderDatabaseCredentialResolver(
        new AesGcmProviderCredentialCipher({
          primaryVersion: credentialKeyVersion,
          keys: new Map([[credentialKeyVersion, credentialKey]]),
        }),
      ),
      destinationPolicy: readAdminProviderDestinationPolicy(context.environment),
      connectionLimitPerProvider: 3,
      maximumCachedProviders: 16,
      operationTimeoutMs: 15_000,
    });
    const sourceIntegrations = createClutchpacksSourceIntegrationCapabilities();
    const manualImports = createAdminManualImportAdmissionRuntime({
      central: context.central,
      sourceIntegrations,
      delegate: createRoutedProviderManualImportDelegate({ gateway }),
    });
    const workerFleetEvidence = createDistributedWorkerFleetEvidence({
      central: context.central,
      gateway,
    });
    return {
      app: {
        importOperations: createDistributedImportOperationsRuntime({
          central: context.central,
          gateway,
          manualImports,
        }),
        providerSourceOperations:
          createDistributedProviderSourceOperationsRuntime({
            central: context.central,
            gateway,
            sourceIntegrations,
            diagnosticCursorKey: context.actorPseudonymKey,
          }),
      },
      workerFleetEvidence,
      operationalHealthRepository:
        createCentralObservedOperationalHealthRepository(context.central),
      machineryAlertFacts: createDistributedMachineryAlertFactsSource({
        central: context.central,
        evidence: workerFleetEvidence,
      }),
      close: () => gateway.close(),
    };
  };
