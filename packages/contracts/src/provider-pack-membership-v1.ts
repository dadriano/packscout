import { z } from "zod";

/** Optional source capability, independent of provider transport and native shape. */
export const normalizedPackMembershipV1Schema = z.object({
  schemaVersion: z.literal("normalized_pack_membership_v1"),
  providerPackRecordId: z.string().trim().min(1).max(500).nullable(),
  sourceKey: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u),
  completeness: z.enum(["complete", "partial"]),
  items: z.array(z.object({
    providerRecordId: z.string().trim().min(1).max(500),
    displayOrder: z.number().int().min(0).max(999),
  }).strict()).max(1000),
}).strict().refine(value => new Set(value.items.map(item => item.providerRecordId)).size === value.items.length,
  "normalized_pack_membership.duplicate_identity")
  .refine(value => new Set(value.items.map(item => item.displayOrder)).size === value.items.length,
    "normalized_pack_membership.duplicate_order")
  .refine(value => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 100 * 1024,
    "normalized_pack_membership.byte_limit");

export type NormalizedPackMembershipV1 = z.infer<typeof normalizedPackMembershipV1Schema>;
