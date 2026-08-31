import { z } from "zod";
import { publicCategorySchema, type ApprovedPublicCatalogConfigurationV1 } from "@packscout/contracts";
import { uuidV5 } from "../local/generate-clutchpacks-v3-public-catalog-candidate.mts";
import { productionPublicationSha256 } from "./clutchpacks-production-publication-policy.mts";
import { clutchpacksProductionIdentityInventorySchema } from "./clutchpacks-production-identity-inventory.mts";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const proofSchema = z.object({
  schemaVersion: z.literal("packscout.clutchpacks-production-identity-proof.v1"),
  readOnlySources: z.literal(true), namespaceUuid: z.uuid(),
  baseline: z.object({ rawSha256: hash, canonicalSha256: hash }).passthrough(),
  production: z.object({ deployment: z.literal("shiny-newt-310"), url: z.literal("https://shiny-newt-310.convex.cloud"),
    publicReleaseId: z.uuid(), releaseFingerprint: hash, generation: z.number().int().positive() }).passthrough(),
  packProof: z.array(z.object({ publicRepackId: z.uuid(), sourceExternalId: z.uuid(), listingUrl: z.url(),
    matchesNamespace: z.literal(true), matchesBaseline: z.literal(true) }).passthrough()).min(1).max(1000),
  categoryProof: z.array(z.object({ detail: publicCategorySchema, matchesNamespace: z.literal(true),
    matchesBaseline: z.literal(true) }).passthrough()).max(512),
  productionCollectibleInventory: z.object({ count: z.number().int().positive(),
    publicCollectibleIds: z.array(z.uuid()).min(1).max(20000), sortedIdsCanonicalSha256: hash }).passthrough(),
  neonContinuity: z.object({ missingProductionCount: z.literal(0) }).passthrough(),
}).passthrough();
function refuse(): never { throw new Error("CLUTCHPACKS_PRODUCTION_IDENTITY_CONTINUITY_FAILED"); }

/** The proof is hash-pinned outside this function; no matching by display fields. */
export function assertClutchpacksProductionIdentityContinuity(input: {
  readonly proof: unknown; readonly namespaceUuid: string; readonly baseline: unknown;
  readonly configuration: ApprovedPublicCatalogConfigurationV1;
}) {
  const parsed = proofSchema.safeParse(input.proof);
  if (!parsed.success) return refuse();
  const proof = parsed.data;
  if (proof.namespaceUuid !== input.namespaceUuid || productionPublicationSha256(input.baseline) !== proof.baseline.canonicalSha256) return refuse();
  const packs = new Map(input.configuration.repacks.map(row => [row.publicRepackId, row]));
  if (packs.size !== input.configuration.repacks.length) return refuse();
  for (const previous of proof.packProof) {
    const row = packs.get(previous.publicRepackId);
    if (row === undefined || row.packExternalId !== `pack:${previous.sourceExternalId}` || row.listingUrl !== previous.listingUrl ||
      row.publicRepackId !== uuidV5(input.namespaceUuid, `repack\0clutchpacks\0${previous.sourceExternalId}`)) return refuse();
  }
  const cards = new Set(input.configuration.collectibles.map(row => row.publicCollectibleId));
  const inventory = proof.productionCollectibleInventory;
  if (cards.size !== input.configuration.collectibles.length || inventory.count !== inventory.publicCollectibleIds.length ||
    new Set(inventory.publicCollectibleIds).size !== inventory.count ||
    productionPublicationSha256([...inventory.publicCollectibleIds].sort()) !== inventory.sortedIdsCanonicalSha256 ||
    inventory.publicCollectibleIds.some(id => !cards.has(id))) return refuse();
  const categories = new Map(input.configuration.categories.map(row => [row.publicCategoryId, row]));
  for (const previous of proof.categoryProof) {
    if (productionPublicationSha256(categories.get(previous.detail.publicCategoryId)) !== productionPublicationSha256(previous.detail)) return refuse();
  }
}

/** Each new bundle proves continuity against the then-current production head,
 * including cards added after the original namespace recovery audit. */
export function assertClutchpacksProductionInventoryContinuity(input: {
  readonly inventory: unknown; readonly configuration: ApprovedPublicCatalogConfigurationV1;
  readonly predecessor: { readonly generation: number; readonly publicReleaseId: string | null;
    readonly releaseFingerprint: string | null };
}) {
  const parsed = clutchpacksProductionIdentityInventorySchema.safeParse(input.inventory);
  if (!parsed.success) return refuse();
  const { digest, ...body } = parsed.data;
  if (productionPublicationSha256(body) !== digest || body.activeState.generation !== input.predecessor.generation ||
    body.activeState.activeRelease.publicReleaseId !== input.predecessor.publicReleaseId ||
    body.activeState.activeRelease.releaseFingerprint !== input.predecessor.releaseFingerprint) return refuse();
  const counts = body.activeState.activeRelease.counts;
  if (body.publicRepackIds.length !== counts.repacks || body.publicCollectibleIds.length !== counts.collectibles ||
    body.categories.length !== counts.categories) return refuse();
  const hasEveryUnique = (old: readonly string[], next: readonly string[]) => {
    const nextIds = new Set(next);
    return new Set(old).size === old.length && nextIds.size === next.length && old.every(id => nextIds.has(id));
  };
  if (!hasEveryUnique(body.publicRepackIds, input.configuration.repacks.map(row => row.publicRepackId)) ||
    !hasEveryUnique(body.publicCollectibleIds, input.configuration.collectibles.map(row => row.publicCollectibleId))) return refuse();
  const oldPackIds = new Set(body.publicRepackIds);
  const references = new Map(body.repacks.map(row => [row.publicRepackId, row]));
  const configuredPacks = new Map(input.configuration.repacks.map(row => [row.publicRepackId, row]));
  const platform = input.configuration.platforms.find(row => row.platformKey === "clutchpacks");
  if (platform === undefined || references.size !== body.repacks.length || references.size !== oldPackIds.size ||
    body.repacks.some(row => !oldPackIds.has(row.publicRepackId))) return refuse();
  for (const previous of references.values()) {
    const next = configuredPacks.get(previous.publicRepackId);
    if (next === undefined || next.platformKey !== "clutchpacks" ||
      previous.publicVendorId !== platform.vendor.publicVendorId || previous.vendorKey !== platform.vendor.vendorKey ||
      (previous.listingUrl !== null && previous.listingUrl !== next.listingUrl)) return refuse();
  }
  const categories = new Map(input.configuration.categories.map(row => [row.publicCategoryId, row]));
  if (categories.size !== input.configuration.categories.length ||
    new Set(body.categories.map(row => row.publicCategoryId)).size !== body.categories.length ||
    body.categories.some(row => productionPublicationSha256(categories.get(row.publicCategoryId)) !== productionPublicationSha256(row))) return refuse();
}
