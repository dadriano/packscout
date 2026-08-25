import { z } from "zod";
import { canonicalJson } from "./data-release-v2-canonical.ts";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
  PROVIDER_OBSERVATION_HASH_VERSION_V2,
  launchProviderKeySchema,
  normalizedContinuationSchema,
  opaqueCursorEnvelopeSchema,
  sourceAdapterMeasurementsSchema,
  sourceAdapterSafeDiagnosticSchema,
} from "./provider-source-contract-v1.ts";
import { normalizedPullProviderFactsSchema } from "./provider-source-facts-v1.ts";
import {
  normalizedObservationSemanticContent,
  normalizedObservationSemanticContentSchema,
  normalizedProviderObservationSchema,
  normalizedRelationshipIdentitySchema,
  providerRecordIdentitySchema,
  stableSourceRecordIdentitySchema,
  type NormalizedObservationOutcome,
  type NormalizedObservationSemanticContent,
  type NormalizedProviderObservation,
  type NormalizedProviderObservationPage,
} from "./provider-source-observation-v1.ts";

const safeReferenceSchema = z
  .string()
  .regex(/^[a-z0-9](?:[a-z0-9:._-]{0,254}[a-z0-9])?$/u);
const timestampSchema = z
  .iso.datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

/**
 * Observation v2 keeps the normalized relationship vocabulary but permits a
 * pull with only the relationship the provider actually supplies. Every pull
 * owns at least one relationship, may own at most one pack and one card, and
 * places pack before card when both are present.
 */
export const normalizedPullRelationshipsV2Schema = z
  .array(normalizedRelationshipIdentitySchema)
  .min(1)
  .max(2)
  .superRefine((relationships, context) => {
    const cardCount = relationships.filter(
      ({ relationship }) => relationship === "card",
    ).length;
    const packCount = relationships.filter(
      ({ relationship }) => relationship === "pack",
    ).length;
    if (cardCount > 1 || packCount > 1) {
      context.addIssue({
        code: "custom",
        message: "provider_source.pull_relationships_invalid",
      });
    }
  })
  .transform((relationships) =>
    [...relationships].sort((left, right) =>
      left.relationship === right.relationship
        ? 0
        : left.relationship === "pack"
          ? -1
          : 1,
    ),
  );

const normalizedObservationBaseV2 = {
  providerRecordIdentity: providerRecordIdentitySchema,
  effectiveAt: timestampSchema,
  collectedAt: timestampSchema,
  protectedNativeEvidenceRef: safeReferenceSchema,
} as const;

const pullObservationV2Schema = z
  .object({
    ...normalizedObservationBaseV2,
    kind: z.literal("pull"),
    providerFacts: normalizedPullProviderFactsSchema,
    relationships: normalizedPullRelationshipsV2Schema,
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
  });

/**
 * Catalog and trade observations retain their v1 shapes. Only the v2 pull
 * branch is additive, so the v1 schema remains an exact, independently usable
 * contract.
 */
export const normalizedProviderObservationV2Schema = z.union([
  normalizedProviderObservationSchema,
  pullObservationV2Schema,
]);

const pullSemanticContentV2Schema = z
  .object({
    providerRecordIdentity: providerRecordIdentitySchema,
    effectiveAt: timestampSchema,
    kind: z.literal("pull"),
    providerFacts: normalizedPullProviderFactsSchema,
    relationships: normalizedPullRelationshipsV2Schema,
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
  });

/** Strict semantic form stored and hashed for observation identity v2. */
export const normalizedObservationSemanticContentV2Schema = z.union([
  normalizedObservationSemanticContentSchema,
  pullSemanticContentV2Schema,
]);

export const normalizedObservationOutcomeV2Schema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("valid"),
        recordIndex: z.number().int().min(0),
        observation: normalizedProviderObservationV2Schema,
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

export const normalizedProviderObservationPageV2Schema = z
  .object({
    normalizedContractVersion: z.literal(
      PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
    ),
    provider: launchProviderKeySchema,
    outcomes: z.array(normalizedObservationOutcomeV2Schema),
    nextCursor: opaqueCursorEnvelopeSchema,
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

export const semanticObservationIdentityV2Schema = z
  .object({
    sourceRecord: stableSourceRecordIdentitySchema,
    effectiveAt: timestampSchema,
    normalizedContractVersion: z.literal(
      PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
    ),
    hashVersion: z.literal(PROVIDER_OBSERVATION_HASH_VERSION_V2),
    normalizedContentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export type NormalizedProviderObservationV2 = z.infer<
  typeof normalizedProviderObservationV2Schema
>;
export type NormalizedObservationSemanticContentV2 = z.infer<
  typeof normalizedObservationSemanticContentV2Schema
>;
export type NormalizedObservationOutcomeV2 = z.infer<
  typeof normalizedObservationOutcomeV2Schema
>;
export type NormalizedProviderObservationPageV2 = z.infer<
  typeof normalizedProviderObservationPageV2Schema
>;
export type SemanticObservationIdentityV2 = z.infer<
  typeof semanticObservationIdentityV2Schema
>;

export type VersionedNormalizedProviderObservation =
  | NormalizedProviderObservation
  | NormalizedProviderObservationV2;
export type VersionedNormalizedObservationSemanticContent =
  | NormalizedObservationSemanticContent
  | NormalizedObservationSemanticContentV2;
export type VersionedNormalizedObservationOutcome =
  | NormalizedObservationOutcome
  | NormalizedObservationOutcomeV2;
export type VersionedNormalizedProviderObservationPage =
  | NormalizedProviderObservationPage
  | NormalizedProviderObservationPageV2;

/**
 * Returns only semantic provider meaning under the observation v2 contract.
 * Collection time and protected evidence locators remain delivery-only.
 */
export function normalizedObservationSemanticContentV2(
  observation: NormalizedProviderObservationV2,
): NormalizedObservationSemanticContentV2 {
  const parsed = normalizedProviderObservationV2Schema.parse(observation);
  if (parsed.kind === "pull") {
    return normalizedObservationSemanticContentV2Schema.parse({
      kind: parsed.kind,
      providerRecordIdentity: parsed.providerRecordIdentity,
      effectiveAt: parsed.effectiveAt,
      providerFacts: parsed.providerFacts,
      relationships: parsed.relationships,
    });
  }
  return normalizedObservationSemanticContentV2Schema.parse(
    normalizedObservationSemanticContent(parsed),
  );
}

/** Canonical bytestring authority for PROVIDER_OBSERVATION_HASH_VERSION_V2. */
export function normalizedObservationSemanticCanonicalJsonV2(
  content: unknown,
): string {
  return canonicalJson(
    normalizedObservationSemanticContentV2Schema.parse(content),
  );
}
