import type { ApprovedPublicCatalogConfigurationV1 } from "@packscout/contracts";
import {
  fixtureConfiguration,
  fixtureIds,
  fixtureSnapshot,
} from "./catalog-release-fixture.test-support.ts";
import type { ProviderCatalogCheckpoint } from "./provider-catalog-settlement-service.ts";
import type {
  ProviderCatalogCanonicalRevisionSnapshot,
  ProviderCatalogReleaseSourceSnapshot,
  ProviderCatalogReleaseConfigurationSnapshot,
} from "./provider-catalog-release-types.ts";

export { fixtureIds };

const observed = new Date("2026-08-15T02:00:00.000Z");
const settled = new Date("2026-08-15T03:00:00.000Z");
const organizationId = "70000000-0000-4000-8000-000000000001";

export function providerFixtureApprovedConfiguration(
  options: Readonly<{
    platformKey?: "alpha" | "beta";
    configurationKey?: string;
    revision?: number;
    categories?: ApprovedPublicCatalogConfigurationV1["categories"];
    verifiedUsdStablecoins?: readonly string[];
  }> = {},
): ApprovedPublicCatalogConfigurationV1 {
  const platformKey = options.platformKey ?? "alpha";
  return {
    ...fixtureConfiguration,
    configurationKey: options.configurationKey ?? fixtureConfiguration.configurationKey,
    revision: options.revision ?? fixtureConfiguration.revision,
    categories: options.categories ?? fixtureConfiguration.categories,
    verifiedUsdStablecoins: [
      ...(options.verifiedUsdStablecoins ??
        fixtureConfiguration.verifiedUsdStablecoins),
    ],
    platforms: fixtureConfiguration.platforms.filter(
      (platform) => platform.platformKey === platformKey,
    ),
    repacks: fixtureConfiguration.repacks.filter(
      (repack) => repack.platformKey === platformKey,
    ),
    collectibles: fixtureConfiguration.collectibles.filter(
      (collectible) => collectible.platformKey === platformKey,
    ),
  };
}

export function providerFixtureCheckpoint(
  options: Readonly<{
    platformKey?: "alpha" | "beta";
    configurationKey?: string;
    revision?: number;
    configurationHash?: string;
    configurationSequence?: bigint;
    settledSequence?: bigint;
    sourceHeadSequence?: bigint;
    settledAt?: Date | null;
    sourceHeadAt?: Date;
    lastSuccessfulObservationAt?: Date;
    staleAt?: Date;
    freshness?: "fresh" | "delayed";
    blockedState?: ProviderCatalogCheckpoint["blockedState"];
  }> = {},
): ProviderCatalogCheckpoint {
  const settledSequence = options.settledSequence ?? 20n;
  const sourceHeadSequence = options.sourceHeadSequence ?? settledSequence;
  const sourceHeadAt = options.sourceHeadAt ?? settled;
  const lastSuccessfulObservationAt =
    options.lastSuccessfulObservationAt ?? settled;
  return {
    organizationId,
    platformKey: options.platformKey ?? "alpha",
    sharedConfigurationEpoch: {
      configurationKey: options.configurationKey ?? "catalog-v1",
      revision: options.revision ?? 1,
      publicChangeSequence: options.configurationSequence ?? 1n,
      configurationHash: options.configurationHash ?? "a".repeat(64),
    },
    settledSequence,
    sourceHeadSequence,
    settledAt: options.settledAt === undefined
      ? (settledSequence === 0n ? null : settled)
      : options.settledAt,
    sourceHeadAt,
    lastSuccessfulObservationAt,
    staleAt: options.staleAt ?? new Date(
      lastSuccessfulObservationAt.getTime() + 900_000,
    ),
    freshness: options.freshness ??
      (lastSuccessfulObservationAt >= sourceHeadAt ? "fresh" : "delayed"),
    blockedState: options.blockedState ?? { kind: "ready" },
  };
}

function configurationSnapshot(
  configuration: ApprovedPublicCatalogConfigurationV1,
  checkpoint: ProviderCatalogCheckpoint,
): ProviderCatalogReleaseConfigurationSnapshot {
  return {
    schemaVersion: configuration.schemaVersion,
    configurationKey: configuration.configurationKey,
    revision: configuration.revision,
    approvedAt: configuration.approvedAt,
    staleAfterSeconds: configuration.staleAfterSeconds,
    confidencePolicy: configuration.confidencePolicy,
    publicAssetOrigins: configuration.publicAssetOrigins,
    verifiedUsdStablecoins: configuration.verifiedUsdStablecoins,
    categories: configuration.categories,
    platform: configuration.platforms[0]!,
    repacks: configuration.repacks,
    collectibles: configuration.collectibles,
    configurationHash: checkpoint.sharedConfigurationEpoch.configurationHash,
    publicChangeSequence:
      checkpoint.sharedConfigurationEpoch.publicChangeSequence,
  };
}

export function providerFixtureSnapshot(
  options: Readonly<{
    checkpoint?: ProviderCatalogCheckpoint;
    configuration?: ApprovedPublicCatalogConfigurationV1;
    alphaName?: string;
    includeForeignRows?: boolean;
    reverseRows?: boolean;
    completedBackfillAt?: Date;
    lifecycleState?: string;
    lastSuccessfulObservationAt?: Date;
  }> = {},
): ProviderCatalogReleaseSourceSnapshot {
  const checkpoint = options.checkpoint ?? providerFixtureCheckpoint();
  if (checkpoint.settledAt === null) {
    throw new RangeError("A provider release snapshot requires a settled checkpoint.");
  }
  const configuration = options.configuration ?? providerFixtureApprovedConfiguration({
    platformKey: checkpoint.platformKey as "alpha" | "beta",
    configurationKey: checkpoint.sharedConfigurationEpoch.configurationKey,
    revision: checkpoint.sharedConfigurationEpoch.revision,
  });
  const source = fixtureSnapshot({ alphaName: options.alphaName });
  let revisions: ProviderCatalogCanonicalRevisionSnapshot[] = source.revisions
    .filter(({ platformKey }) =>
      platformKey === checkpoint.platformKey || options.includeForeignRows === true)
    .map((revision) => ({
      ...revision,
      revisionId: revision.recordKind === "pack"
        ? `${revision.platformKey}-pack-revision`
        : revision.recordKind === "ev_input"
          ? `${revision.platformKey}-ev-input-revision`
          : `${revision.platformKey}-${revision.recordKind}-revision`,
    }));
  revisions = revisions.map((revision) =>
    revision.platformKey === checkpoint.platformKey && revision.recordKind === "pack"
      ? {
          ...revision,
          content: {
            ...(revision.content as Record<string, unknown>),
            imageUrls: [`https://${checkpoint.platformKey}.example/pack.png`],
          },
        }
      : revision);
  let repackIdentities = source.repackIdentities.filter(({ platformKey }) =>
    platformKey === checkpoint.platformKey || options.includeForeignRows === true);
  if (options.reverseRows === true) {
    revisions = [...revisions].reverse();
    repackIdentities = [...repackIdentities].reverse();
  }
  return {
    checkpoint: {
      platformKey: checkpoint.platformKey,
      sharedConfigurationEpoch: checkpoint.sharedConfigurationEpoch,
      settledSequence: checkpoint.settledSequence,
      sourceHeadSequence: checkpoint.sourceHeadSequence,
      settledAt: checkpoint.settledAt,
      sourceHeadAt: checkpoint.sourceHeadAt,
    },
    configuration: configurationSnapshot(configuration, checkpoint),
    readiness: {
      lifecycleState: options.lifecycleState ?? "active",
      lifecycleSequence: 2n,
      configurationRevisionId: "60000000-0000-4000-8000-000000000001",
      completedBackfillAt: options.completedBackfillAt ?? observed,
    },
    revisions,
    repackIdentities,
    observation: {
      lastSuccessfulObservationAt:
        options.lastSuccessfulObservationAt ?? settled,
    },
  };
}
