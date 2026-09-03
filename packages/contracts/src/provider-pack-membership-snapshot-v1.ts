import type { NormalizedPackMembershipV1 } from "./provider-pack-membership-v1.ts";
import { providerPackContentSnapshotV1Schema, type ProviderPackContentSnapshotV1 } from "./provider-pack-content-snapshot-v1.ts";

/** Preview evidence establishes membership, never item quantity or item odds. */
export function packMembershipSnapshotV1(input: Readonly<{
  providerId: string; providerRecordId: string; sourceAdapterVersion: string; mapperVersion: string;
  effectiveAt: string; effectiveAtBasis: "provider_updated_at" | "response_observed_at";
  collectedAt: string; membership: NormalizedPackMembershipV1;
}>): ProviderPackContentSnapshotV1 {
  if (input.membership.providerPackRecordId !== null && input.membership.providerPackRecordId !== input.providerRecordId) {
    throw new TypeError("pack_membership_snapshot.pack_identity_mismatch");
  }
  return providerPackContentSnapshotV1Schema.parse({
    schemaVersion: "provider_pack_content_snapshot_v1",
    providerId: input.providerId, packKey: `pack:${input.providerRecordId}`,
    sourceKey: input.membership.sourceKey, sourceAdapterVersion: input.sourceAdapterVersion,
    mapperVersion: input.mapperVersion, effectiveAt: new Date(input.effectiveAt).toISOString(),
    effectiveAtBasis: input.effectiveAtBasis, collectedAt: new Date(input.collectedAt).toISOString(),
    completeness: input.membership.completeness,
    items: input.membership.items.map(item => ({
      collectibleKey: `card:${item.providerRecordId}`, collectibleInstanceKey: null,
      status: "present", totalQuantity: null, availableQuantity: null,
      contentRole: "featured_chase", probability: null,
      statedValueAmount: null, statedValueCurrency: null,
      evidenceKinds: ["vendor_featured_chase"], matchConfidenceBasisPoints: 10000,
      displayOrder: item.displayOrder,
    })),
  });
}
