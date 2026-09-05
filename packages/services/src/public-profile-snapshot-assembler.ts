import {
  PROFILE_SNAPSHOT_HASH_DOMAIN, assertPublicCatalogText, assertPublicCatalogUrl, assertPublicPackCatalogBytes,
  compareCanonicalStrings, derivePublicProfileSnapshotId, hashPackCatalogValue, normalizePackCatalogSearchText,
  packCatalogCanonicalByteCount, publicProviderProfileSchema, publicCollectibleProfileSchema,
  publicProfileSnapshotBatchSchema, publicProfileSnapshotDescriptorSchema,
  type PublicProviderProfile, type PublicCollectibleProfile,
} from "@packscout/contracts";
import { captureSharedInput } from "@packscout/database/publication-input";

type ProfileInput<T extends PublicProviderProfile | PublicCollectibleProfile> = Omit<T, "identity"> & {
  identity: Omit<T["identity"], "contentSha256" | "publicProfileSnapshotId">;
};
export type PublicProfileAssemblyInput = ProfileInput<PublicProviderProfile> | ProfileInput<PublicCollectibleProfile>;
const hash = (value: unknown) => hashPackCatalogValue(PROFILE_SNAPSHOT_HASH_DOMAIN, value);
const normalized = (value: string) => value.trim().normalize("NFC");
function protect(value: unknown): void {
  assertPublicPackCatalogBytes(value);
  const visit = (item: unknown): void => {
    if (typeof item === "string") {
      assertPublicCatalogText(item);
      for (const match of item.matchAll(/https?:\/\/[^\s<>"']+/giu)) assertPublicCatalogUrl(match[0]);
    } else if (item !== null && typeof item === "object") Object.values(item).forEach(visit);
  };
  visit(value);
}

/** Pure bounded P01 profile assembly. No clocks, repository reads, heads, or activation. */
export async function assemblePublicProfileSnapshot(raw: PublicProfileAssemblyInput) {
  raw = captureSharedInput(raw, 1_500_000);
  protect(raw);
  const input = structuredClone(raw), placeholder = "0".repeat(64);
  const identity = { ...input.identity, contentSha256: placeholder, publicProfileSnapshotId: derivePublicProfileSnapshotId(placeholder) };
  const ordered = "brandAssets" in input ? { ...input,
    brandAssets: input.brandAssets.map(asset => ({ ...asset, url: normalized(asset.url), alt: normalized(asset.alt) }))
      .sort((a, b) => compareCanonicalStrings(`${a.kind}:${a.url}`, `${b.kind}:${b.url}`)),
    promotions: input.promotions.map(promotion => ({ ...promotion, promotionId: normalized(promotion.promotionId) }))
      .sort((a, b) => compareCanonicalStrings(a.promotionId, b.promotionId)),
  } : { ...input, aliases: input.aliases.map(normalized).sort(compareCanonicalStrings),
    searchText: normalizePackCatalogSearchText([normalized(input.displayName), ...input.aliases.map(normalized).sort(compareCanonicalStrings)].join(" ")) };
  const parsed = input.identity.profileKind === "provider"
    ? publicProviderProfileSchema.parse({ ...ordered, identity }) : publicCollectibleProfileSchema.parse({ ...ordered, identity });
  const { identity: temporary, ...fields } = parsed;
  const { contentSha256: _hash, publicProfileSnapshotId: _id, ...source } = temporary; void _hash; void _id;
  const contentSha256 = await hash({ ...source, ...fields });
  const profile = { ...parsed, identity: { ...source, contentSha256, publicProfileSnapshotId: derivePublicProfileSnapshotId(contentSha256) } };
  protect(profile);
  const body = { kind: "profile_batch", profile };
  const batch = publicProfileSnapshotBatchSchema.parse({ profile, publicProfileSnapshotId: profile.identity.publicProfileSnapshotId,
    batchIndex: 0, recordCount: 1, byteCount: packCatalogCanonicalByteCount(body), batchSha256: await hash(body) });
  const { profile: _profile, ...batchDescriptor } = batch; void _profile;
  const descriptor = publicProfileSnapshotDescriptorSchema.parse({ identity: profile.identity, batch: batchDescriptor, completionState: "complete" });
  return { profile: batch.profile, descriptor, batch, payloadSha256: await hash(batch.profile) };
}
