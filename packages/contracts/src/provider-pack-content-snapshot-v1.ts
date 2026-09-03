import { z } from "zod";

export const PROVIDER_PACK_CONTENT_SNAPSHOT_SCHEMA_VERSION = "provider_pack_content_snapshot_v1" as const;
export const MAX_PROVIDER_PACK_CONTENT_SNAPSHOT_ITEMS = 1_000;
export const MAX_PROVIDER_PACK_CONTENT_SNAPSHOT_BYTES = 200 * 1_024;

const token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/u);
const key = z.string().min(1).max(512).refine((value) => value === value.trim() && !/[\r\n\0]/u.test(value));
const timestamp = z.iso.datetime({ offset: true }).refine((value) => new Date(value).toISOString() === value);
const quantity = z.string().regex(/^(?:0|[1-9][0-9]*)$/u)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
const money = z.string().regex(/^(?:0|[1-9][0-9]{0,19})(?:\.[0-9]{1,18})?$/u);
const probability = z.string().regex(/^(?:0(?:\.[0-9]{1,18})?|1(?:\.0{1,18})?)$/u);
const currency = z.string().regex(/^(?:[A-Z0-9]{2,12}|0x[0-9A-Fa-f]{40})$/u);

export const providerPackContentSnapshotItemV1Schema = z.object({
  collectibleKey: key,
  collectibleInstanceKey: key.nullable(),
  status: z.enum(["present", "removed"]),
  totalQuantity: quantity.nullable(),
  availableQuantity: quantity.nullable(),
  contentRole: z.enum(["top_chase", "featured_chase", "possible_outcome", "other"]),
  probability: probability.nullable(),
  statedValueAmount: money.nullable(),
  statedValueCurrency: currency.nullable(),
  evidenceKinds: z.array(z.enum([
    "vendor_inventory", "vendor_featured_chase", "vendor_odds", "packscout_resolved",
  ])).min(1).max(4),
  matchConfidenceBasisPoints: z.number().int().min(0).max(10_000),
  displayOrder: z.number().int().min(0).max(MAX_PROVIDER_PACK_CONTENT_SNAPSHOT_ITEMS - 1),
}).strict().superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if ((value.statedValueAmount === null) !== (value.statedValueCurrency === null)) issue("pack_content_snapshot.value_pair_invalid");
  if (value.totalQuantity !== null && value.availableQuantity !== null && BigInt(value.availableQuantity) > BigInt(value.totalQuantity)) issue("pack_content_snapshot.quantity_invalid");
  if (new Set(value.evidenceKinds).size !== value.evidenceKinds.length) issue("pack_content_snapshot.duplicate_evidence");
  if (!value.evidenceKinds.some((kind) => kind === "vendor_inventory" || kind === "vendor_featured_chase")) issue("pack_content_snapshot.membership_evidence_missing");
  if ((value.probability !== null) !== value.evidenceKinds.includes("vendor_odds")) issue("pack_content_snapshot.item_odds_evidence_mismatch");
});

export const providerPackContentSnapshotV1Schema = z.object({
  schemaVersion: z.literal(PROVIDER_PACK_CONTENT_SNAPSHOT_SCHEMA_VERSION),
  providerId: z.uuid(),
  packKey: key,
  sourceKey: token,
  sourceAdapterVersion: token,
  mapperVersion: token,
  effectiveAt: timestamp,
  effectiveAtBasis: z.enum(["provider_updated_at", "response_observed_at"]),
  collectedAt: timestamp,
  completeness: z.enum(["complete", "partial"]),
  items: z.array(providerPackContentSnapshotItemV1Schema).max(MAX_PROVIDER_PACK_CONTENT_SNAPSHOT_ITEMS),
}).strict().superRefine((value, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  if (Date.parse(value.collectedAt) < Date.parse(value.effectiveAt)) issue("pack_content_snapshot.collection_precedes_source");
  const identities = value.items.map((item) => JSON.stringify([item.collectibleKey, item.collectibleInstanceKey]));
  if (new Set(identities).size !== identities.length) issue("pack_content_snapshot.duplicate_identity");
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_PROVIDER_PACK_CONTENT_SNAPSHOT_BYTES) issue("pack_content_snapshot.byte_limit");
});

export type ProviderPackContentSnapshotV1 = z.infer<typeof providerPackContentSnapshotV1Schema>;
export type ProviderPackContentSnapshotItemV1 = z.infer<typeof providerPackContentSnapshotItemV1Schema>;
