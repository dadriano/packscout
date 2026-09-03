import {
  BoundedProviderDatabaseGateway,
  readDatabaseRuntimePolicy,
  type ProviderDatabaseDestinationPolicy,
  type CentralDatabaseLifecycle,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  CipherProviderDatabaseCredentialResolver,
  createLaunchSourceIntegrationCapabilities,
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
import { createDistributedCanonicalInspectionRuntime } from
  "./distributed-canonical-inspection-runtime.ts";
import { createPromotionJobMonitoringRuntime } from
  "./promotion-job-monitoring-runtime.ts";
import type {
  AdminProviderRuntimeFactory,
  AdminProviderRuntimeFactoryContext,
} from "./runtime.ts";

/** Server-owned destination policy; provider rows can only narrow this set. */
export function readAdminProviderDestinationPolicy(
  environment: NodeJS.ProcessEnv,
): ProviderDatabaseDestinationPolicy {
  return readDatabaseRuntimePolicy(environment).destinationPolicy;
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
    const sourceIntegrations = createLaunchSourceIntegrationCapabilities();
    const manualImports = createAdminManualImportAdmissionRuntime({
      central: context.central,
      sourceIntegrations,
      delegate: createRoutedProviderManualImportDelegate({ gateway }),
    });
    const workerFleetEvidence = createDistributedWorkerFleetEvidence({
      central: context.central,
      gateway,
    });
    const promotionJobs = createPromotionJobMonitoringRuntime({
      central: context.central,
      gateway,
      deployment: context.catalogDeploymentKey
        ?? (context.environment.NODE_ENV === "production"
          ? "production"
          : "development"),
      secret: context.actorPseudonymKey,
    });
    return {
      app: {
        canonical: createDistributedCanonicalInspectionRuntime({
          central: context.central,
          gateway,
        }),
        importOperations: createDistributedImportOperationsRuntime({
          central: context.central,
          gateway,
          manualImports,
        }),
        promotionJobs: { reads: promotionJobs },
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
