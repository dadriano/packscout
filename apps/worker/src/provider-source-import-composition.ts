import { createHmac, randomUUID } from "node:crypto";
import {
  ProviderSourceImportRunRepository,
  ProviderSourcePageRepository,
  type PackscoutPrismaClient,
} from "@packscout/database";
import {
  OpaqueCheckpointGuard,
  ProviderSourceImportRequestService,
  ProviderSourcePageImportService,
  ProviderSourcePagePlanner,
  createProductionSourceAdapterRegistry,
  createProviderObservationMapperRegistryFromManifest,
  type ProductionProviderObservationMapperRegistry,
  type ProviderActorKeyer,
  type SourceAdapterRegistry,
} from "@packscout/services";

export interface ProviderSourceImportComposition {
  readonly sourceAdapters: SourceAdapterRegistry;
  readonly mappers: ProductionProviderObservationMapperRegistry;
  readonly pageImports: ProviderSourcePageImportService;
  readonly runRequests: ProviderSourceImportRequestService;
}

function createActorKeyer(key: Uint8Array): ProviderActorKeyer {
  const secret = Buffer.from(key);
  if (secret.byteLength < 32) {
    throw new Error("Provider actor key must be at least 32 bytes.");
  }
  return {
    keyFor({ organizationId, operatorId }) {
      return `actor:v1:${createHmac("sha256", secret)
        .update(
          `packscout-provider-request:v1\u0000${organizationId}\u0000${operatorId}`,
        )
        .digest("hex")}`;
    },
  };
}

function checkpointFingerprintKey(key: Uint8Array): Uint8Array {
  return new Uint8Array(
    createHmac("sha256", key)
      .update("packscout-provider-source-checkpoint:v1")
      .digest(),
  );
}

/** Minimal import composition shared by combined and source-only workers. */
export function createProviderSourceImportComposition(input: Readonly<{
  database: PackscoutPrismaClient;
  actorPseudonymKey: Uint8Array;
}>): ProviderSourceImportComposition {
  const clock = { now: () => new Date() };
  const mappers = createProviderObservationMapperRegistryFromManifest();
  return Object.freeze({
    sourceAdapters: createProductionSourceAdapterRegistry(),
    mappers,
    pageImports: new ProviderSourcePageImportService(
      new ProviderSourcePagePlanner(mappers),
      new OpaqueCheckpointGuard(
        checkpointFingerprintKey(input.actorPseudonymKey),
      ),
      new ProviderSourcePageRepository(input.database, {
        actorPseudonymKey: input.actorPseudonymKey,
      }),
    ),
    runRequests: new ProviderSourceImportRequestService({
      runs: new ProviderSourceImportRunRepository(input.database),
      actorKeyer: createActorKeyer(input.actorPseudonymKey),
      clock,
      ids: { id: randomUUID },
    }),
  });
}
