import { z } from "zod";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_HASH_VERSION,
  launchProviderKeySchema,
  launchRecordIdScopeKeySchema,
  normalizedContinuationSchema,
  opaqueCheckpointEnvelopeSchema,
  sourceAdapterMeasurementsSchema,
  sourceAdapterSafeDiagnosticSchema,
} from "./provider-source-contract-v1.ts";
import {
  normalizedCurrencyTickerSchema,
  normalizedProviderFactsSchema,
  normalizedPullProviderFactsSchema,
  normalizedTradeProviderFactsSchema,
} from "./provider-source-facts-v1.ts";

const nonBlankStringSchema = z.string().trim().min(1).max(4_096);
const safeReferenceSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9:._-]{0,254}[a-z0-9])?$/u);
const timestampSchema = z
  .iso.datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const finiteNumberSchema = z.custom<number>(
  (value) => typeof value === "number" && Number.isFinite(value),
);
export const normalizedProviderEventCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(128);

export const providerRecordIdentitySchema = z
  .object({
    recordIdScopeKey: launchRecordIdScopeKeySchema,
    providerRecordId: nonBlankStringSchema,
  })
  .strict();

export const normalizedRelationshipIdentitySchema = z
  .object({
    relationship: z.enum(["pack", "card"]),
    target: providerRecordIdentitySchema,
  })
  .strict()
  .superRefine((value, context) => {
    const expected =
      value.relationship === "pack" ? "catalog-pack-v1" : "catalog-card-v1";
    if (value.target.recordIdScopeKey !== expected) {
      context.addIssue({
        code: "custom",
        message: "provider_source.relationship_scope_mismatch",
        path: ["target", "recordIdScopeKey"],
      });
    }
  });

const pullRelationshipsSchema = z
  .array(normalizedRelationshipIdentitySchema)
  .length(2)
  .transform((relationships) =>
    [...relationships].sort((left, right) =>
      left.relationship === right.relationship
        ? 0
        : left.relationship === "pack"
          ? -1
          : 1,
    ),
  );

const normalizedObservationBase = {
  providerRecordIdentity: providerRecordIdentitySchema,
  effectiveAt: timestampSchema,
  collectedAt: timestampSchema,
  protectedNativeEvidenceRef: safeReferenceSchema,
} as const;

const catalogObservationSchema = z
  .object({
    ...normalizedObservationBase,
    kind: z.literal("catalog"),
    entity: z.enum(["pack", "card"]),
    firstSeenAt: timestampSchema,
    availability: z.enum(["available", "unavailable", "unknown"]),
    providerFacts: normalizedProviderFactsSchema,
    relationships: z.array(normalizedRelationshipIdentitySchema).length(0),
  })
  .strict()
  .superRefine((value, context) => {
    const expected =
      value.entity === "pack" ? "catalog-pack-v1" : "catalog-card-v1";
    if (value.providerRecordIdentity.recordIdScopeKey !== expected) {
      context.addIssue({
        code: "custom",
        message: "provider_source.catalog_scope_mismatch",
        path: ["providerRecordIdentity", "recordIdScopeKey"],
      });
    }
    if (value.providerFacts.kind !== value.entity) {
      context.addIssue({
        code: "custom",
        message: "provider_source.catalog_facts_mismatch",
        path: ["providerFacts", "kind"],
      });
    }
  });

const pullObservationSchema = z
  .object({
    ...normalizedObservationBase,
    kind: z.literal("pull"),
    providerFacts: normalizedPullProviderFactsSchema,
    relationships: pullRelationshipsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.providerRecordIdentity.recordIdScopeKey !== "pull-v1") {
      context.addIssue({
        code: "custom",
        message: "provider_source.pull_scope_mismatch",
        path: ["providerRecordIdentity", "recordIdScopeKey"],
      });
    }
    const relationships = value.relationships.map(
      ({ relationship }) => relationship,
    );
    if (new Set(relationships).size !== 2) {
      context.addIssue({
        code: "custom",
        message: "provider_source.pull_relationships_invalid",
        path: ["relationships"],
      });
    }
  });

const tradeObservationSchema = z
  .object({
    ...normalizedObservationBase,
    kind: z.literal("trade"),
    relationships: z.array(normalizedRelationshipIdentitySchema).length(1),
    eventType: normalizedProviderEventCodeSchema,
    amount: finiteNumberSchema.nullable(),
    currency: normalizedCurrencyTickerSchema.nullable(),
    paymentMethod: nonBlankStringSchema.nullable(),
    protectedTransactionEvidenceRef: safeReferenceSchema.nullable(),
    providerFacts: normalizedTradeProviderFactsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.providerRecordIdentity.recordIdScopeKey !== "trade-v1") {
      context.addIssue({
        code: "custom",
        message: "provider_source.trade_scope_mismatch",
        path: ["providerRecordIdentity", "recordIdScopeKey"],
      });
    }
    if (value.relationships[0]?.relationship !== "card") {
      context.addIssue({
        code: "custom",
        message: "provider_source.trade_relationship_invalid",
        path: ["relationships"],
      });
    }
  });

export const normalizedProviderObservationSchema = z.discriminatedUnion(
  "kind",
  [catalogObservationSchema, pullObservationSchema, tradeObservationSchema],
);

const normalizedSemanticObservationBase = {
  providerRecordIdentity: providerRecordIdentitySchema,
  effectiveAt: timestampSchema,
} as const;

const catalogSemanticContentSchema = z
  .object({
    ...normalizedSemanticObservationBase,
    kind: z.literal("catalog"),
    entity: z.enum(["pack", "card"]),
    firstSeenAt: timestampSchema,
    availability: z.enum(["available", "unavailable", "unknown"]),
    providerFacts: normalizedProviderFactsSchema,
    relationships: z.array(normalizedRelationshipIdentitySchema).length(0),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedScope =
      value.entity === "pack" ? "catalog-pack-v1" : "catalog-card-v1";
    if (value.providerRecordIdentity.recordIdScopeKey !== expectedScope) {
      context.addIssue({
        code: "custom",
        message: "provider_source.catalog_scope_mismatch",
        path: ["providerRecordIdentity", "recordIdScopeKey"],
      });
    }
    if (value.providerFacts.kind !== value.entity) {
      context.addIssue({
        code: "custom",
        message: "provider_source.catalog_facts_mismatch",
        path: ["providerFacts", "kind"],
      });
    }
  });

const pullSemanticContentSchema = z
  .object({
    ...normalizedSemanticObservationBase,
    kind: z.literal("pull"),
    providerFacts: normalizedPullProviderFactsSchema,
    relationships: pullRelationshipsSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.providerRecordIdentity.recordIdScopeKey !== "pull-v1") {
      context.addIssue({
        code: "custom",
        message: "provider_source.pull_scope_mismatch",
        path: ["providerRecordIdentity", "recordIdScopeKey"],
      });
    }
    const relationships = value.relationships.map(
      ({ relationship }) => relationship,
    );
    if (new Set(relationships).size !== 2) {
      context.addIssue({
        code: "custom",
        message: "provider_source.pull_relationships_invalid",
        path: ["relationships"],
      });
    }
  });

const tradeSemanticContentSchema = z
  .object({
    ...normalizedSemanticObservationBase,
    kind: z.literal("trade"),
    providerFacts: normalizedTradeProviderFactsSchema,
    relationships: z.array(normalizedRelationshipIdentitySchema).length(1),
    eventType: normalizedProviderEventCodeSchema,
    amount: finiteNumberSchema.nullable(),
    currency: normalizedCurrencyTickerSchema.nullable(),
    paymentMethod: nonBlankStringSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.providerRecordIdentity.recordIdScopeKey !== "trade-v1") {
      context.addIssue({
        code: "custom",
        message: "provider_source.trade_scope_mismatch",
        path: ["providerRecordIdentity", "recordIdScopeKey"],
      });
    }
    if (value.relationships[0]?.relationship !== "card") {
      context.addIssue({
        code: "custom",
        message: "provider_source.trade_relationship_invalid",
        path: ["relationships"],
      });
    }
  });

/** Strict semantic form stored and hashed for observation identity. */
export const normalizedObservationSemanticContentSchema = z.discriminatedUnion(
  "kind",
  [
    catalogSemanticContentSchema,
    pullSemanticContentSchema,
    tradeSemanticContentSchema,
  ],
);

export const normalizedObservationOutcomeSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("valid"),
        recordIndex: z.number().int().min(0),
        observation: normalizedProviderObservationSchema,
      })
      .strict(),
    z
      .object({
        status: z.literal("invalid"),
        recordIndex: z.number().int().min(0),
        reasonCode: safeReferenceSchema,
        fieldPaths: z.array(safeReferenceSchema).max(32),
        protectedNativeEvidenceRef: safeReferenceSchema,
      })
      .strict(),
  ],
);

export const normalizedProviderObservationPageSchema = z
  .object({
    normalizedContractVersion: z.literal(PROVIDER_OBSERVATION_CONTRACT_VERSION),
    provider: launchProviderKeySchema,
    outcomes: z.array(normalizedObservationOutcomeSchema),
    nextCheckpoint: opaqueCheckpointEnvelopeSchema,
    continuation: normalizedContinuationSchema,
    measurements: sourceAdapterMeasurementsSchema,
    diagnostics: z.array(sourceAdapterSafeDiagnosticSchema).max(32),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.measurements.recordCount !== value.outcomes.length) {
      context.addIssue({
        code: "custom",
        message: "provider_source.measurement_record_count_mismatch",
        path: ["measurements", "recordCount"],
      });
    }
    value.outcomes.forEach((outcome, index) => {
      if (outcome.recordIndex !== index) {
        context.addIssue({
          code: "custom",
          message: "provider_source.outcomes_not_ordered",
          path: ["outcomes", index, "recordIndex"],
        });
      }
    });
  });

export const stableSourceRecordIdentitySchema = z
  .object({
    organizationId: nonBlankStringSchema,
    sourceInstanceId: nonBlankStringSchema,
    recordIdScopeKey: launchRecordIdScopeKeySchema,
    providerRecordId: nonBlankStringSchema,
  })
  .strict();

export const semanticObservationIdentitySchema = z
  .object({
    sourceRecord: stableSourceRecordIdentitySchema,
    effectiveAt: timestampSchema,
    normalizedContractVersion: z.literal(PROVIDER_OBSERVATION_CONTRACT_VERSION),
    hashVersion: z.literal(PROVIDER_OBSERVATION_HASH_VERSION),
    normalizedContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const deliveryOccurrenceIdentitySchema = z
  .object({
    pageAttemptId: nonBlankStringSchema,
    recordIndex: z.number().int().min(0),
  })
  .strict();

export type ProviderRecordIdentity = z.infer<
  typeof providerRecordIdentitySchema
>;
export type NormalizedRelationshipIdentity = z.infer<
  typeof normalizedRelationshipIdentitySchema
>;
export type NormalizedProviderObservation = z.infer<
  typeof normalizedProviderObservationSchema
>;
export type NormalizedObservationSemanticContent = z.infer<
  typeof normalizedObservationSemanticContentSchema
>;
export type NormalizedObservationOutcome = z.infer<
  typeof normalizedObservationOutcomeSchema
>;
export type NormalizedProviderObservationPage = z.infer<
  typeof normalizedProviderObservationPageSchema
>;
export type StableSourceRecordIdentity = z.infer<
  typeof stableSourceRecordIdentitySchema
>;
export type SemanticObservationIdentity = z.infer<
  typeof semanticObservationIdentitySchema
>;
export type DeliveryOccurrenceIdentity = z.infer<
  typeof deliveryOccurrenceIdentitySchema
>;

/**
 * Returns only semantic provider meaning. Collection time and protected
 * evidence locators belong to delivery occurrences and must never make an
 * at-least-once replay look like a new semantic observation.
 */
export function normalizedObservationSemanticContent(
  observation: NormalizedProviderObservation,
): NormalizedObservationSemanticContent {
  const parsed = normalizedProviderObservationSchema.parse(observation);
  if (parsed.kind === "catalog") {
    return normalizedObservationSemanticContentSchema.parse({
      kind: parsed.kind,
      entity: parsed.entity,
      providerRecordIdentity: parsed.providerRecordIdentity,
      effectiveAt: parsed.effectiveAt,
      firstSeenAt: parsed.firstSeenAt,
      availability: parsed.availability,
      providerFacts: parsed.providerFacts,
      relationships: parsed.relationships,
    });
  }
  if (parsed.kind === "pull") {
    return normalizedObservationSemanticContentSchema.parse({
      kind: parsed.kind,
      providerRecordIdentity: parsed.providerRecordIdentity,
      effectiveAt: parsed.effectiveAt,
      providerFacts: parsed.providerFacts,
      relationships: parsed.relationships,
    });
  }
  return normalizedObservationSemanticContentSchema.parse({
    kind: parsed.kind,
    providerRecordIdentity: parsed.providerRecordIdentity,
    effectiveAt: parsed.effectiveAt,
    providerFacts: parsed.providerFacts,
    relationships: parsed.relationships,
    eventType: parsed.eventType,
    amount: parsed.amount,
    currency: parsed.currency,
    paymentMethod: parsed.paymentMethod,
  });
}

type CanonicalSemanticJson =
  | boolean
  | number
  | string
  | null
  | readonly CanonicalSemanticJson[]
  | Readonly<{ [key: string]: CanonicalSemanticJson }>;

function canonicalSemanticJsonValue(value: unknown): CanonicalSemanticJson {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return value as boolean | number | string | null;
  }
  if (Array.isArray(value)) return value.map(canonicalSemanticJsonValue);
  if (typeof value !== "object") {
    throw new TypeError("Normalized semantic content is not JSON serializable.");
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => {
        const nested = (value as Readonly<Record<string, unknown>>)[key];
        if (nested === undefined) {
          throw new TypeError("Normalized semantic content contains undefined.");
        }
        return [key, canonicalSemanticJsonValue(nested)];
      }),
  );
}

/** Canonical bytestring authority for PROVIDER_OBSERVATION_HASH_VERSION. */
export function normalizedObservationSemanticCanonicalJson(
  content: unknown,
): string {
  const parsed = normalizedObservationSemanticContentSchema.parse(content);
  return JSON.stringify(canonicalSemanticJsonValue(parsed));
}
