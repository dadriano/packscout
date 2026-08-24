import { createHmac } from "node:crypto";
import {
  ProviderSourceAdminCatalogRepository,
  ProviderSourceAdminFailureAuditRepository,
  ProviderSourceAdminLifecycleRepository,
  ProviderSourceDiagnosticRepository,
  ProviderSourceLifecycleRepository,
  ProviderSourceOperationsRepository,
  ProviderSourceSupervisorSnapshotRepository,
  SourceConnectionAdminRepository,
} from "@packscout/database";
import {
  AesGcmSourceConnectionConfigurationCipher,
  createProductionSourceAdminConfigurationCodecRegistry,
  createProductionSourceAdapterRegistry,
  launchSourceMapperDescriptors,
  ProviderSourceActivationService,
  ProviderSourceAdminCatalogService,
  ProviderSourceLifecycleService,
  ProviderSourceOperationsService,
  SourceConnectionConfigurationService,
  SourceMapperDescriptorRegistry,
  productionSourceAdapterManifests,
} from "@packscout/services";
import type { ProviderSourcesRouterDependencies } from "./routes/provider-sources.ts";
import type { ProviderSourceOperationsRouterDependencies } from
  "./routes/provider-source-operations.ts";

type ProviderSourceDatabase = ConstructorParameters<
  typeof ProviderSourceLifecycleRepository
>[0];

export interface AdminProviderSourceRuntimeInput {
  readonly database: ProviderSourceDatabase;
  readonly connectionConfigurationKey: Uint8Array;
  readonly connectionConfigurationKeyVersion: number;
  readonly actorPseudonymKey: Uint8Array;
  readonly environment?: "local" | "production" | "test";
}

type AdminProviderSourceRuntime = Omit<
  ProviderSourcesRouterDependencies,
  "auth" | "cookiePolicy" | "sameOrigin"
> & Omit<
  ProviderSourceOperationsRouterDependencies,
  "auth" | "cookiePolicy"
>;

function actorKeyer(secretBytes: Uint8Array) {
  const secret = Buffer.from(secretBytes);
  if (secret.byteLength < 32) {
    throw new Error("Provider source actor key must be at least 32 bytes.");
  }
  return {
    keyFor(input: Readonly<{ organizationId: string; operatorId: string }>) {
      return `actor:v1:${createHmac("sha256", secret)
        .update(
          `packscout-provider-source-admin:v1\u0000${input.organizationId}\u0000${input.operatorId}`,
        )
        .digest("hex")}`;
    },
  };
}

export function createAdminProviderSourceRuntime(
  input: AdminProviderSourceRuntimeInput,
): AdminProviderSourceRuntime {
  const keyVersion = input.connectionConfigurationKeyVersion;
  const sourceAdapters = createProductionSourceAdapterRegistry();
  const adminConfigurationCodecs =
    createProductionSourceAdminConfigurationCodecRegistry(sourceAdapters);
  const mapperDescriptors = new SourceMapperDescriptorRegistry(
    launchSourceMapperDescriptors,
  );
  const connectionRepository = new SourceConnectionAdminRepository(
    input.database,
  );
  const connectionConfigurations = new SourceConnectionConfigurationService({
    repository: connectionRepository,
    cipher: new AesGcmSourceConnectionConfigurationCipher({
      primaryVersion: keyVersion,
      keys: new Map([[keyVersion, input.connectionConfigurationKey]]),
    }),
    sourceAdapters,
    adminConfigurationCodecs,
  });
  const activation = new ProviderSourceActivationService({
    repository: new ProviderSourceLifecycleRepository(input.database),
    connectionConfigurations,
    sourceAdapters,
    mapperDescriptors,
  });
  const sources = new ProviderSourceLifecycleService({
    repository: new ProviderSourceAdminLifecycleRepository(input.database),
    activation,
    sourceAdapters,
    mapperDescriptors,
    adminConfigurationCodecs,
  });
  const catalog = new ProviderSourceAdminCatalogService({
    repository: new ProviderSourceAdminCatalogRepository(input.database),
    connectionConfigurations,
    availableSourceTypes: [{
      sourceTypeKey: "dataforrest-events-v1",
      label: "DataForrest events",
    }],
    adminConfigurationCodecs,
    sourceAdapters,
    mapperDescriptors,
  });
  const operations = new ProviderSourceOperationsService({
    environmentKey: input.environment ?? "local",
    catalog: {
      read(organizationId) {
        return catalog.getCatalog({
          organizationId,
          actorKey: "system:provider-source-operations",
        });
      },
    },
    snapshot: new ProviderSourceSupervisorSnapshotRepository(input.database),
    repository: new ProviderSourceOperationsRepository(input.database),
    diagnostics: new ProviderSourceDiagnosticRepository(input.database),
    sourceTypes: productionSourceAdapterManifests.map((manifest) => ({
      label: manifest.operatorLabel,
      manifest,
    })),
  });

  return {
    actorKeyer: actorKeyer(input.actorPseudonymKey),
    failureAudit: new ProviderSourceAdminFailureAuditRepository(input.database),
    catalog,
    connections: connectionConfigurations,
    sources,
    operations,
    diagnosticCursorKey: input.actorPseudonymKey,
  };
}
