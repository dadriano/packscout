import { z } from "zod";
import { normalizedPackMembershipV1Schema } from "./provider-pack-membership-v1.ts";

export const COLLECTOR_CRYPT_FEATURED_CHASE_SOURCE_V1 = "collector_crypt:featured_nfts:v1";
export const COLLECTOR_CRYPT_CHASE_IMAGE_ORIGIN_V1 = "https://d1xpxki1g4htqu.cloudfront.net";

const mint = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/u);
const image = z.url().max(2_048).refine(value => {
  const url = new URL(value);
  return url.origin === COLLECTOR_CRYPT_CHASE_IMAGE_ORIGIN_V1 &&
    url.username === "" && url.password === "" && url.hash === "";
});
const card = z.object({
  id: mint, nft_address: mint, name: z.string().trim().min(1).max(240), image,
  insured_value: z.number().finite().nonnegative().refine(value =>
    Number.isSafeInteger(Math.round(value * 100)) && Math.abs(value * 100 - Math.round(value * 100)) < 0.00001),
}).refine(value => value.id === value.nft_address, "collector_crypt_chase.identity_mismatch");
const inputSchema = z.object({
  machineCode: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/u),
  observedAt: z.iso.datetime().refine(value => new Date(value).toISOString() === value),
  response: z.object({ nfts: z.array(card).max(50), hasMore: z.boolean() }),
});

/**
 * The caller binds the response hash to the exact official /api/getNfts?code
 * request. This is a partial advertised selection, never complete inventory or
 * evidence from Recent Winners. Insured values remain unconverted: the caller
 * must explicitly admit their currency before writing a canonical valuation.
 */
export function parseCollectorCryptFeaturedChasesV1(input: {
  machineCode: string; response: unknown; observedAt: string;
}) {
  const value = inputSchema.parse(input);
  if (new Set(value.response.nfts.map(item => item.id)).size !== value.response.nfts.length) {
    throw new TypeError("collector_crypt_chase.duplicate_identity");
  }
  const cards = value.response.nfts.map(item => ({
    providerRecordId: item.id, collectibleKey: `card:${item.id}`,
    displayName: item.name, imageUrl: item.image,
    insuredValueAmount: (Math.round(item.insured_value * 100) / 100).toFixed(2),
  }));
  return {
    machineCode: value.machineCode, packKey: `pack:${value.machineCode}`,
    sourceKey: COLLECTOR_CRYPT_FEATURED_CHASE_SOURCE_V1,
    observedAt: value.observedAt, hasMore: value.response.hasMore, cards,
    membership: normalizedPackMembershipV1Schema.parse({
      schemaVersion: "normalized_pack_membership_v1",
      providerPackRecordId: value.machineCode,
      sourceKey: COLLECTOR_CRYPT_FEATURED_CHASE_SOURCE_V1,
      completeness: "partial",
      items: cards.map((item, displayOrder) => ({ providerRecordId: item.providerRecordId, displayOrder })),
    }),
  };
}
