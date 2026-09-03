import { z } from "zod";
import { normalizedPackMembershipV1Schema } from "./provider-pack-membership-v1.ts";

const boundedTextSchema = z.string().trim().min(1).max(10_000);
const finiteNumberSchema = z.custom<number>(
  (value) => typeof value === "number" && Number.isFinite(value),
);

/** Closed normalized ticker shape shared by fiat and crypto-valued facts. */
export const normalizedCurrencyTickerSchema = z
  .string()
  .regex(/^[A-Z0-9]{2,12}$/u);

function normalizedFactSchema<TSchema extends z.ZodType>(value: TSchema) {
  return z.discriminatedUnion("state", [
    z.object({ state: z.literal("absent") }).strict(),
    z.object({ state: z.literal("malformed") }).strict(),
    z.object({ state: z.literal("present"), value }).strict(),
  ]);
}

export const normalizedTextFactSchema = normalizedFactSchema(boundedTextSchema);
export const normalizedImageReferencesFactSchema = normalizedFactSchema(
  z.array(z.string().trim().min(1).max(2_048)).max(64),
);

export const normalizedProviderMoneySchema = z
  .object({
    amount: finiteNumberSchema,
    currency: normalizedCurrencyTickerSchema,
  })
  .strict();
export const normalizedMoneyFactSchema = normalizedFactSchema(
  normalizedProviderMoneySchema,
);
export const normalizedNumberFactSchema =
  normalizedFactSchema(finiteNumberSchema);

export const normalizedAuthoritativeAvailabilityFactSchema =
  z.discriminatedUnion("state", [
    z.object({ state: z.literal("absent") }).strict(),
    z.object({ state: z.literal("malformed") }).strict(),
    z
      .object({
        state: z.literal("present"),
        value: z
          .object({
            state: z.literal("sold_out"),
            authority: z.literal("provider_explicit_sold_out"),
          })
          .strict(),
      })
      .strict(),
  ]);

export const normalizedEvBucketSchema = z
  .object({
    bucketId: z.string().trim().min(1).max(256),
    label: z.string().trim().min(1).max(500).nullable(),
    probability: finiteNumberSchema.nullable(),
    quantity: z.number().int().nullable(),
    lowerValue: finiteNumberSchema.nullable(),
    upperValue: finiteNumberSchema.nullable(),
  })
  .strict();

export const normalizedEvInputEvidenceSchema = z
  .object({
    approved: z.boolean(),
    currency: normalizedCurrencyTickerSchema.nullable(),
    unitBasis: z.enum(["per_draw", "per_pack"]).nullable(),
    drawCount: z.number().int().nullable(),
    buybackPercent: finiteNumberSchema.nullable(),
    totalQuantity: z.number().int().nullable(),
    buckets: z.array(normalizedEvBucketSchema).max(10_000),
  })
  .strict();

export const normalizedEvInputFactSchema = normalizedFactSchema(
  normalizedEvInputEvidenceSchema,
);

const normalizedDisplayFacts = {
  displayName: normalizedTextFactSchema,
  description: normalizedTextFactSchema,
  category: normalizedTextFactSchema,
  imageReferences: normalizedImageReferencesFactSchema,
} as const;

export const normalizedPackProviderFactsSchema = z
  .object({
    kind: z.literal("pack"),
    ...normalizedDisplayFacts,
    price: normalizedMoneyFactSchema,
    providerReportedEv: normalizedMoneyFactSchema,
    buybackPercent: normalizedNumberFactSchema,
    drawCount: normalizedNumberFactSchema,
    evInput: normalizedEvInputFactSchema,
    // Versioned optional capability. Absent historical observations carry no
    // membership instruction and cannot clear a previously accepted snapshot.
    packMembership: normalizedFactSchema(normalizedPackMembershipV1Schema).optional(),
    authoritativeAvailability: normalizedAuthoritativeAvailabilityFactSchema,
  })
  .strict();

export const normalizedCardProviderFactsSchema = z
  .object({
    kind: z.literal("card"),
    ...normalizedDisplayFacts,
    estimatedValue: normalizedMoneyFactSchema,
    valueSource: normalizedTextFactSchema,
  })
  .strict();

export const normalizedPullProviderFactsSchema = z
  .object({
    kind: z.literal("pull"),
    displayName: normalizedTextFactSchema,
    imageReferences: normalizedImageReferencesFactSchema,
    value: normalizedMoneyFactSchema,
    valueSource: normalizedTextFactSchema,
  })
  .strict();

export const normalizedTradeProviderFactsSchema = z
  .object({
    kind: z.literal("trade"),
    displayName: normalizedTextFactSchema,
    imageReferences: normalizedImageReferencesFactSchema,
  })
  .strict();

export const normalizedProviderFactsSchema = z.discriminatedUnion("kind", [
  normalizedPackProviderFactsSchema,
  normalizedCardProviderFactsSchema,
  normalizedPullProviderFactsSchema,
  normalizedTradeProviderFactsSchema,
]);

export type NormalizedProviderMoney = z.infer<
  typeof normalizedProviderMoneySchema
>;
export type NormalizedEvBucket = z.infer<typeof normalizedEvBucketSchema>;
export type NormalizedEvInputEvidence = z.infer<
  typeof normalizedEvInputEvidenceSchema
>;
export type NormalizedPackProviderFacts = z.infer<
  typeof normalizedPackProviderFactsSchema
>;
export type NormalizedCardProviderFacts = z.infer<
  typeof normalizedCardProviderFactsSchema
>;
export type NormalizedPullProviderFacts = z.infer<
  typeof normalizedPullProviderFactsSchema
>;
export type NormalizedTradeProviderFacts = z.infer<
  typeof normalizedTradeProviderFactsSchema
>;
export type NormalizedProviderFacts = z.infer<
  typeof normalizedProviderFactsSchema
>;

export const absentNormalizedFact = Object.freeze({ state: "absent" } as const);

export function emptyNormalizedProviderFacts(
  kind: NormalizedProviderFacts["kind"],
): NormalizedProviderFacts {
  const commonDisplay = {
    displayName: absentNormalizedFact,
    imageReferences: absentNormalizedFact,
  } as const;
  if (kind === "pack") {
    return {
      kind,
      ...commonDisplay,
      description: absentNormalizedFact,
      category: absentNormalizedFact,
      price: absentNormalizedFact,
      providerReportedEv: absentNormalizedFact,
      buybackPercent: absentNormalizedFact,
      drawCount: absentNormalizedFact,
      evInput: absentNormalizedFact,
      authoritativeAvailability: absentNormalizedFact,
    };
  }
  if (kind === "card") {
    return {
      kind,
      ...commonDisplay,
      description: absentNormalizedFact,
      category: absentNormalizedFact,
      estimatedValue: absentNormalizedFact,
      valueSource: absentNormalizedFact,
    };
  }
  if (kind === "pull") {
    return {
      kind,
      ...commonDisplay,
      value: absentNormalizedFact,
      valueSource: absentNormalizedFact,
    };
  }
  return { kind, ...commonDisplay };
}
