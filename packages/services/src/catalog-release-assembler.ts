import {
  DATA_RELEASE_SCHEMA_VERSION,
  approvedPublicCatalogConfigurationV1Schema,
} from "@packscout/contracts";
import { buildCatalogReleasePublishPlan } from "./catalog-release-artifacts.ts";
import {
  CatalogProjectionAssemblyError,
  projectCatalogRelease,
} from "./catalog-release-public-projection.ts";
import type {
  AssembleCatalogReleaseInput,
  CatalogReleaseBlockReason,
  CatalogReleaseBlockedPlan,
  CatalogReleasePlanV2,
  CatalogReleaseSourcePort,
  CatalogSettlementPort,
} from "./catalog-release-types.ts";

function blocked(
  input: AssembleCatalogReleaseInput,
  reason: CatalogReleaseBlockReason,
): CatalogReleaseBlockedPlan {
  const expected = input.baseline?.activePublicReleaseId ?? null;
  return {
    classification: "blocked",
    reason,
    requestedWatermark: input.requestedWatermark,
    expectedActivePublicReleaseId: expected,
    expectedPredecessorPublicReleaseId: expected,
  };
}

/**
 * Binds tenant-scoped settlement and canonical source ports at construction.
 * No caller-controlled organization identifier can enter an assembly request.
 */
export class CatalogReleaseAssembler {
  constructor(
    private readonly settlement: CatalogSettlementPort,
    private readonly source: CatalogReleaseSourcePort,
  ) {}

  async assemble(input: AssembleCatalogReleaseInput): Promise<CatalogReleasePlanV2> {
    const checkpoint = await this.settlement.getCheckpoint();
    if (checkpoint.settledSequence <= 0n || checkpoint.settledAt === null) {
      return blocked(input, "NO_SETTLED_PUBLIC_STATE");
    }
    if (input.requestedWatermark !== checkpoint.settledSequence) {
      return blocked(input, input.requestedWatermark > checkpoint.settledSequence
        ? "WATERMARK_UNSETTLED" : "WATERMARK_REGRESSED");
    }
    if (input.requestedWatermark > BigInt(Number.MAX_SAFE_INTEGER)) {
      return blocked(input, "OBSERVATION_SEQUENCE_UNSAFE");
    }
    const observationSequence = Number(input.requestedWatermark);
    if (input.baseline !== null &&
        observationSequence <= input.baseline.observationSequence) {
      return blocked(input, "WATERMARK_REGRESSED");
    }

    let snapshot;
    try {
      snapshot = await this.source.loadSnapshot({
        throughSequence: input.requestedWatermark,
        throughOccurredAt: checkpoint.settledAt,
      });
    } catch (error) {
      if (typeof error === "object" && error !== null &&
          "code" in error && error.code === "PUBLIC_CONFIGURATION_INVALID") {
        return blocked(input, "PUBLIC_CONFIGURATION_INVALID");
      }
      throw error;
    }
    if (snapshot.configuration === null) {
      return blocked(input, "PUBLIC_CONFIGURATION_UNAPPROVED");
    }
    const parsedConfiguration = approvedPublicCatalogConfigurationV1Schema.safeParse(
      snapshot.configuration.configuration,
    );
    if (!parsedConfiguration.success ||
        snapshot.configuration.publicChangeSequence > input.requestedWatermark) {
      return blocked(input, "PUBLIC_CONFIGURATION_INVALID");
    }
    const configuration = parsedConfiguration.data;
    const providerByPlatform = new Map(
      snapshot.providers.map((provider) => [provider.platformKey, provider]),
    );
    const activePlatformKeys = new Set<string>();
    let delayedVendorCount = 0;
    for (const platform of configuration.platforms) {
      const provider = providerByPlatform.get(platform.platformKey);
      if (provider?.state === "disabled" || provider?.state === "archived") continue;
      if (
        provider?.state !== "active" ||
        provider.providerId === null ||
        provider.sourceInstanceId === null ||
        provider.sourceRevisionId === null
      ) {
        return blocked(input, "INITIAL_BACKFILL_INCOMPLETE");
      }
      if (provider.completedBackfillAt === null) {
        return blocked(input, "INITIAL_BACKFILL_INCOMPLETE");
      }
      activePlatformKeys.add(platform.platformKey);
      const head = checkpoint.sourceHeads.find(
        ({ sourceKey }) => sourceKey === platform.platformKey,
      );
      if (head?.settled === false ||
          (head !== undefined && head.sequence > checkpoint.settledSequence)) {
        if (input.baseline !== null &&
            !input.baseline.publicVendorKeys.includes(platform.vendor.vendorKey)) {
          return blocked(input, "INITIAL_PROVIDER_DELAYED");
        }
        delayedVendorCount += 1;
      }
    }
    if (input.baseline === null && delayedVendorCount > 0) {
      return blocked(input, "INITIAL_PROVIDER_DELAYED");
    }

    let projection;
    try {
      projection = projectCatalogRelease({
        configuration,
        activePlatformKeys,
        revisions: snapshot.revisions,
        repackIdentities: snapshot.repackIdentities,
      });
    } catch (error) {
      if (error instanceof CatalogProjectionAssemblyError) {
        return blocked(input, error.reason);
      }
      return blocked(input, "CANONICAL_PROJECTION_INVALID");
    }
    if (projection.dataAsOf.getTime() > checkpoint.settledAt.getTime()) {
      return blocked(input, "CANONICAL_PROJECTION_INVALID");
    }

    let publishPlan;
    try {
      publishPlan = await buildCatalogReleasePublishPlan({
        requestedWatermark: input.requestedWatermark,
        observationSequence,
        expectedPredecessorPublicReleaseId:
          input.baseline?.activePublicReleaseId ?? null,
        configuration,
        configurationHash: snapshot.configuration.configurationHash,
        ...projection,
        settledAt: checkpoint.settledAt,
        delayedVendorCount,
      });
    } catch (error) {
      if (error instanceof RangeError) {
        return blocked(input, "PUBLICATION_BATCH_TOO_LARGE");
      }
      if (error instanceof TypeError && error.message === "PROTECTED_PUBLICATION_FIELD") {
        return blocked(input, "PROTECTED_PUBLICATION_FIELD");
      }
      return blocked(input, "PUBLIC_CONTRACT_INVALID");
    }
    if (input.baseline !== null &&
        input.baseline.contentHash === publishPlan.contentHash) {
      const metadata = publishPlan.manifest.metadata;
      return {
        classification: "refresh_unchanged",
        requestedWatermark: input.requestedWatermark,
        expectedActivePublicReleaseId: input.baseline.activePublicReleaseId,
        expectedPredecessorPublicReleaseId: input.baseline.activePublicReleaseId,
        publicReleaseId: input.baseline.activePublicReleaseId,
        observationSequence,
        contentHash: publishPlan.contentHash,
        publicVendorKeys: publishPlan.publicVendorKeys,
        refreshRequest: {
          schemaVersion: DATA_RELEASE_SCHEMA_VERSION,
          operationId: `refresh:${input.baseline.activePublicReleaseId}:${observationSequence}`,
          idempotencyKey: `refresh:${input.baseline.activePublicReleaseId}:${observationSequence}`,
          publicReleaseId: input.baseline.activePublicReleaseId,
          contentHash: publishPlan.contentHash,
          observationSequence,
          dataAsOf: metadata.dataAsOf,
          lastSuccessfulObservationAt: metadata.lastSuccessfulObservationAt,
          staleAt: metadata.staleAt,
          freshness: metadata.freshness,
          delayedVendorCount: metadata.delayedVendorCount,
        },
      };
    }
    return publishPlan;
  }
}
