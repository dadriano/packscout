import {
  projectProvisionalProviderPackContentsV3,
  type DistributedProviderCollectibleInstanceRow,
  type DistributedProviderCollectibleRow,
  type DistributedProviderContentPackV3,
  type DistributedProviderPackContentRow,
} from "@packscout/services";
import type { PublicRepackDetailV3 } from "@packscout/contracts";
import { PromoteProviderDataReleaseV3Error } from "./promote-provider-data-release-v3-plan.mjs";

export interface ProviderPromotionContentSnapshot {
  readonly packId: string;
  readonly completeness: "complete" | "partial";
  readonly effectiveAt: Date;
}

/** The caller reads receipts and active membership in one repeatable-read transaction. */
export function projectProviderPromotionContents(input: {
  readonly providerId: string;
  readonly platformKey: string;
  readonly snapshotAt: Date;
  readonly publicAssetOrigins: readonly string[];
  readonly packs: readonly Omit<DistributedProviderContentPackV3, "evidenceCompleteness">[];
  readonly latestSnapshots: readonly ProviderPromotionContentSnapshot[];
  readonly collectibles: readonly DistributedProviderCollectibleRow[];
  readonly instances: readonly DistributedProviderCollectibleInstanceRow[];
  readonly memberships: readonly DistributedProviderPackContentRow[];
}) {
  const packIds = new Set(input.packs.map(({ id }) => id));
  const completeness = new Map<string, "complete" | "partial">();
  for (const snapshot of input.latestSnapshots) {
    if (!packIds.has(snapshot.packId)) continue; // Packs excluded by price policy are not promoted.
    if (completeness.has(snapshot.packId) ||
        !["complete", "partial"].includes(snapshot.completeness) ||
        !Number.isFinite(snapshot.effectiveAt.getTime()) ||
        snapshot.effectiveAt > input.snapshotAt) {
      throw new PromoteProviderDataReleaseV3Error("PROVIDER_CONTENT_SNAPSHOT_INVALID");
    }
    completeness.set(snapshot.packId, snapshot.completeness);
  }
  const memberships = input.memberships.filter(({ packId }) => packIds.has(packId));
  // A pack's descriptive content_evidence field is not a membership receipt.
  if (memberships.some(({ packId }) => !completeness.has(packId))) {
    throw new PromoteProviderDataReleaseV3Error("PROVIDER_CONTENT_SNAPSHOT_REQUIRED");
  }
  const packs = input.packs.filter(({ id }) => completeness.has(id)).map((pack) => ({
    ...pack, evidenceCompleteness: completeness.get(pack.id)!,
  }));
  if (packs.length === 0) return {
    repacks: input.packs.map(({ detail }) => detail), collectibles: [], repackChases: [],
  };
  const collectibleIds = new Set(memberships.map(({ collectibleId }) => collectibleId));
  const instanceIds = new Set(memberships.flatMap(({ collectibleInstanceId }) =>
    collectibleInstanceId === null ? [] : [collectibleInstanceId]));
  const projected = projectProvisionalProviderPackContentsV3({
    identityPolicy: "provider_provisional_v1", providerId: input.providerId,
    platformKey: input.platformKey, snapshotAt: input.snapshotAt,
    publicAssetOrigins: input.publicAssetOrigins, packs, memberships,
    collectibles: input.collectibles.filter(({ id }) => collectibleIds.has(id)),
    instances: input.instances.filter(({ id }) => instanceIds.has(id)),
  });
  const byId = new Map<string, PublicRepackDetailV3>(
    projected.repacks.map((detail) => [detail.publicRepackId, detail]),
  );
  return {
    ...projected,
    repacks: input.packs.map(({ detail }) => byId.get(detail.publicRepackId) ?? detail),
  };
}
