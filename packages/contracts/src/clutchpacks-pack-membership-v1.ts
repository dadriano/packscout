import { z } from "zod";
import { normalizedPackMembershipV1Schema, type NormalizedPackMembershipV1 } from "./provider-pack-membership-v1.ts";

export const MAX_CLUTCHPACKS_PACK_MEMBERSHIP_ITEMS_V1 = 1_000;
export const CLUTCHPACKS_PACK_MEMBERSHIP_SOURCE_KEY_V1 = "clutchpacks:price_bucket_odds:v1" as const;

const imageUrl = z.url().max(2_048).refine((value) => {
  try {
    const url = new URL(value);
    return url.origin === "https://d18ez2bunk7yz0.cloudfront.net" &&
      url.username === "" && url.password === "" && url.pathname.startsWith("/cards/");
  } catch { return false; }
});
const cardSchema = z.object({
  id: z.uuid(), title: z.string().trim().min(1).max(1_000), front_image_url: imageUrl,
});
const bucketSchema = z.object({
  bucket_id: z.uuid(), drawable_count: z.number().int().min(0).max(MAX_CLUTCHPACKS_PACK_MEMBERSHIP_ITEMS_V1),
  preview_cards: z.array(cardSchema).max(MAX_CLUTCHPACKS_PACK_MEMBERSHIP_ITEMS_V1), has_more: z.boolean(),
});
const nativeMembershipSchema = z.object({
  collection_id: z.uuid().optional(), price_bucket_odds: z.array(bucketSchema).max(64),
});
const availabilitySchema = z.object({
  status: z.enum(["active", "restocking", "sold_out"]),
  sold_out: z.boolean(), directly_purchasable: z.boolean(),
});

export interface ClutchpacksPackMembershipV1 {
  readonly providerRecordId: string | null;
  readonly membership: NormalizedPackMembershipV1;
  readonly cards: readonly { readonly providerRecordId: string; readonly title: string; readonly imageUrl: string }[];
  readonly availability: {
    readonly status: "active" | "restocking" | "sold_out";
    readonly soldOut: boolean;
    readonly directlyPurchasable: boolean;
  } | null;
}

function invalidEvidence(): never {
  throw new Error("clutchpacks_pack_membership.invalid_evidence");
}

/**
 * One native collection response, shared by authenticated capture normalization
 * and the official public reader. Series hits and historical pulls cannot enter
 * this pack-specific preview stream. Missing arrays are unknown, not empty stock.
 */
export function parseClutchpacksPackMembershipV1(nativeData: unknown): ClutchpacksPackMembershipV1 | null {
  if (typeof nativeData !== "object" || nativeData === null || Array.isArray(nativeData)) return invalidEvidence();
  const value = nativeData as Record<string, unknown>;
  if (value.price_bucket_odds === undefined || value.price_bucket_odds === null) return null;
  const parsed = nativeMembershipSchema.safeParse(value);
  if (!parsed.success) return invalidEvidence();
  const buckets = parsed.data.price_bucket_odds;
  const bucketIds = new Set(buckets.map((bucket) => bucket.bucket_id));
  const cards = buckets.flatMap((bucket) => bucket.preview_cards);
  if (bucketIds.size !== buckets.length || cards.length > MAX_CLUTCHPACKS_PACK_MEMBERSHIP_ITEMS_V1 ||
      new Set(cards.map((card) => card.id)).size !== cards.length ||
      buckets.some((bucket) => bucket.preview_cards.length > bucket.drawable_count ||
        (bucket.has_more && bucket.preview_cards.length >= bucket.drawable_count))) return invalidEvidence();
  let availability: ClutchpacksPackMembershipV1["availability"] = null;
  if (value.status !== undefined || value.directly_purchasable !== undefined) {
    const available = availabilitySchema.safeParse(value);
    if (!available.success) return invalidEvidence();
    availability = { status: available.data.status, soldOut: available.data.sold_out,
      directlyPurchasable: available.data.directly_purchasable };
  }
  const complete = buckets.length > 0 && buckets.every((bucket) =>
    !bucket.has_more && bucket.preview_cards.length === bucket.drawable_count);
  const membership = normalizedPackMembershipV1Schema.safeParse({
    schemaVersion: "normalized_pack_membership_v1", sourceKey: CLUTCHPACKS_PACK_MEMBERSHIP_SOURCE_KEY_V1,
    providerPackRecordId: parsed.data.collection_id ?? null,
    completeness: complete ? "complete" : "partial",
    items: cards.map((card, displayOrder) => ({ providerRecordId: card.id, displayOrder })),
  });
  if (!membership.success) return invalidEvidence();
  return { providerRecordId: parsed.data.collection_id ?? null, membership: membership.data, availability,
    cards: cards.map((card) => ({ providerRecordId: card.id, title: card.title, imageUrl: card.front_image_url })) };
}
