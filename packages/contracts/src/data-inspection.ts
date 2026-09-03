import { z } from "zod";
import {
  publicCategorySchema,
  publicCollectibleSchema,
  publicRepackDetailSchema,
  publicVendorSchema,
} from "./data-release-v2-entities.ts";
import {
  publicCategoryIdSchema,
  publicCollectibleIdSchema,
  publicRepackIdSchema,
  publicSha256Schema,
  publicTimestampSchema,
  publicVendorIdSchema,
} from "./data-release-v2-values.ts";
import {
  MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT,
  providerCatalogPlatformKeyV1Schema,
  providerCatalogReleaseCountsV1Schema,
  providerCatalogReleaseEntityHashesV1Schema,
  publicProviderReleaseIdV1Schema,
} from "./provider-catalog-release-v1.ts";
import { providerReleaseOperationIdSchema } from "./provider-release-publication-v1.ts";

/**
 * Shared vocabulary for the admin's read-only data-inspection surfaces.
 *
 * PostgreSQL is authoritative for every canonical record. The product backend
 * receives only the subset that the public catalog serves, so a comparison
 * between the two stores is meaningful for some canonical kinds and meaningless
 * for the rest. That boundary is declared here, once, because the parity
 * verdict, the published browser, and the comparison surface all depend on
 * agreeing about it. Reporting a pipeline-only kind as missing downstream would
 * be false, not a finding.
 */

/** Every canonical record kind PostgreSQL stores. Mirrors the database enum. */
export const canonicalRecordKinds = [
  "platform",
  "pack",
  "catalog_asset",
  "ev_input",
  "pull",
  "market_event",
  "estimated_ev",
] as const;

export type CanonicalRecordKind = (typeof canonicalRecordKinds)[number];

/** Entity kinds the product backend stores inside a provider catalog release. */
export const publishedEntityKinds = [
  "vendors",
  "categories",
  "repacks",
  "collectibles",
  "repack_chases",
] as const;

export type PublishedEntityKind = (typeof publishedEntityKinds)[number];

/**
 * Canonical kinds that reach the product backend, with the published entity
 * kind each one becomes. A canonical kind absent from this map is pipeline-only
 * and has no published counterpart to compare against.
 */
export const canonicalKindPublishedCounterpart: Readonly<
  Partial<Record<CanonicalRecordKind, PublishedEntityKind>>
> = Object.freeze({
  platform: "vendors",
  pack: "repacks",
  catalog_asset: "collectibles",
});

/**
 * Canonical kinds with no published counterpart, and why. These are reported as
 * out of comparison scope wherever a parity result is shown.
 */
export const outOfComparisonScopeKinds: Readonly<
  Partial<Record<CanonicalRecordKind, string>>
> = Object.freeze({
  ev_input:
    "Estimated-EV inputs are proprietary calculation evidence and are never published.",
  pull: "Pull histories stay in the pipeline; the product serves aggregates, not raw pulls.",
  market_event:
    "Market-event histories stay in the pipeline; the product serves aggregates, not raw sales.",
  estimated_ev:
    "Estimated EV is published as a field on a repack, not as its own published record.",
});

/** True when a canonical kind can be compared against the product backend. */
export function isComparableCanonicalKind(
  kind: CanonicalRecordKind,
): boolean {
  return kind in canonicalKindPublishedCounterpart;
}

/**
 * The published entity kind a canonical kind becomes, or null when the kind is
 * pipeline-only. Callers must treat null as "out of scope", never as "missing".
 */
export function publishedCounterpartFor(
  kind: CanonicalRecordKind,
): PublishedEntityKind | null {
  return canonicalKindPublishedCounterpart[kind] ?? null;
}

export const comparisonScopeEntrySchema = z.object({
  canonicalKind: z.enum(canonicalRecordKinds),
  publishedKind: z.enum(publishedEntityKinds).nullable(),
  comparable: z.boolean(),
  /** Present only when the kind is out of scope. */
  reason: z.string().nullable(),
});

export type ComparisonScopeEntry = z.infer<typeof comparisonScopeEntrySchema>;

export const comparisonScopeSchema = z.object({
  entries: z.array(comparisonScopeEntrySchema),
});

export type ComparisonScope = z.infer<typeof comparisonScopeSchema>;

/** The comparison scope as a whole, ordered by the canonical kind vocabulary. */
export function comparisonScope(): ComparisonScope {
  return {
    entries: canonicalRecordKinds.map((canonicalKind) => {
      const publishedKind = publishedCounterpartFor(canonicalKind);
      return {
        canonicalKind,
        publishedKind,
        comparable: publishedKind !== null,
        reason: outOfComparisonScopeKinds[canonicalKind] ?? null,
      };
    }),
  };
}

/** Published kinds with standalone public identities and document reads. */
export const publishedInspectableEntityKinds = [
  "vendors",
  "categories",
  "repacks",
  "collectibles",
] as const;

export const publishedInspectableEntityKindSchema = z.enum(
  publishedInspectableEntityKinds,
);

export type PublishedInspectableEntityKind = z.infer<
  typeof publishedInspectableEntityKindSchema
>;

const publishedVendorRowSchema = z
  .object({
    publicEntityId: publicVendorIdSchema,
    detail: publicVendorSchema,
  })
  .strict()
  .refine(
    ({ publicEntityId, detail }) =>
      publicEntityId === detail.publicVendorId,
    {
      path: ["publicEntityId"],
      message: "published_inspection.entity_identity_mismatch",
    },
  );

const publishedCategoryRowSchema = z
  .object({
    publicEntityId: publicCategoryIdSchema,
    detail: publicCategorySchema,
  })
  .strict()
  .refine(
    ({ publicEntityId, detail }) =>
      publicEntityId === detail.publicCategoryId,
    {
      path: ["publicEntityId"],
      message: "published_inspection.entity_identity_mismatch",
    },
  );

const publishedRepackRowSchema = z
  .object({
    publicEntityId: publicRepackIdSchema,
    detail: publicRepackDetailSchema,
  })
  .strict()
  .refine(
    ({ publicEntityId, detail }) =>
      publicEntityId === detail.publicRepackId,
    {
      path: ["publicEntityId"],
      message: "published_inspection.entity_identity_mismatch",
    },
  );

const publishedCollectibleRowSchema = z
  .object({
    publicEntityId: publicCollectibleIdSchema,
    detail: publicCollectibleSchema,
  })
  .strict()
  .refine(
    ({ publicEntityId, detail }) =>
      publicEntityId === detail.publicCollectibleId,
    {
      path: ["publicEntityId"],
      message: "published_inspection.entity_identity_mismatch",
    },
  );

export const publishedEntityRowSchema = z.union([
  publishedVendorRowSchema,
  publishedCategoryRowSchema,
  publishedRepackRowSchema,
  publishedCollectibleRowSchema,
]);

export type PublishedEntityRow = z.infer<typeof publishedEntityRowSchema>;

const publishedEntityRowSchemas = Object.freeze({
  vendors: publishedVendorRowSchema,
  categories: publishedCategoryRowSchema,
  repacks: publishedRepackRowSchema,
  collectibles: publishedCollectibleRowSchema,
});

const publishedPublicEntityIdSchemas = Object.freeze({
  vendors: publicVendorIdSchema,
  categories: publicCategoryIdSchema,
  repacks: publicRepackIdSchema,
  collectibles: publicCollectibleIdSchema,
});

export function publishedEntityRowSchemaForKind(
  entityKind: PublishedInspectableEntityKind,
): z.ZodType<PublishedEntityRow> {
  return publishedEntityRowSchemas[entityKind] as z.ZodType<PublishedEntityRow>;
}

export function publishedPublicEntityIdSchemaForKind(
  entityKind: PublishedInspectableEntityKind,
): z.ZodType<string> {
  return publishedPublicEntityIdSchemas[entityKind];
}

export const publishedReleaseFactsSchema = z
  .object({
    publicProviderReleaseId: publicProviderReleaseIdV1Schema,
    platformKey: providerCatalogPlatformKeyV1Schema,
    lifecycle: z.enum(["staging", "complete", "failed", "retired"]),
    dataAsOf: publicTimestampSchema,
    providerReleaseFingerprint: publicSha256Schema,
    contentHash: publicSha256Schema,
    entityHashes: providerCatalogReleaseEntityHashesV1Schema,
    counts: providerCatalogReleaseCountsV1Schema,
    batchCount: z
      .number()
      .int()
      .safe()
      .min(0)
      .max(MAX_PROVIDER_CATALOG_RELEASE_BATCH_COUNT),
    batchChainHash: publicSha256Schema,
    createdAt: publicTimestampSchema,
    completedAt: publicTimestampSchema.nullable(),
    completionOperationId: providerReleaseOperationIdSchema.nullable(),
  })
  .strict();

export type PublishedReleaseFacts = z.infer<
  typeof publishedReleaseFactsSchema
>;

export const publishedActiveReleaseSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("no_active_manifest") }).strict(),
  z
    .object({
      status: z.literal("platform_not_referenced"),
      manifestPublicReleaseId: publicProviderReleaseIdV1Schema,
    })
    .strict(),
  z
    .object({
      status: z.literal("release_missing"),
      manifestPublicReleaseId: publicProviderReleaseIdV1Schema,
      publicProviderReleaseId: publicProviderReleaseIdV1Schema,
    })
    .strict(),
  z
    .object({
      status: z.literal("active"),
      manifestPublicReleaseId: publicProviderReleaseIdV1Schema,
      referenceFingerprint: publicSha256Schema,
      release: publishedReleaseFactsSchema,
    })
    .strict(),
]);

export type PublishedActiveRelease = z.infer<
  typeof publishedActiveReleaseSchema
>;

const publishedReleaseUnknownSchema = z
  .object({ status: z.literal("release_unknown") })
  .strict();
const publishedNotPresentSchema = z
  .object({ status: z.literal("not_present") })
  .strict();
const publishedCursorSchema = z.string().max(4_096);

function publishedEntityPageSchema(
  rowSchema: z.ZodType<PublishedEntityRow>,
) {
  return z.discriminatedUnion("status", [
    publishedReleaseUnknownSchema,
    z
      .object({
        status: z.literal("ok"),
        items: z.array(rowSchema).max(200),
        isDone: z.boolean(),
        continueCursor: publishedCursorSchema,
      })
      .strict(),
  ]);
}

export const publishedProviderEntityPageSchema = publishedEntityPageSchema(
  publishedEntityRowSchema,
);

export function publishedProviderEntityPageSchemaForKind(
  entityKind: PublishedInspectableEntityKind,
) {
  return publishedEntityPageSchema(
    publishedEntityRowSchemaForKind(entityKind),
  );
}

export type PublishedProviderEntityPage = z.infer<
  typeof publishedProviderEntityPageSchema
>;

function publishedIdPageSchema(publicEntityIdSchema: z.ZodType<string>) {
  return z.discriminatedUnion("status", [
    publishedReleaseUnknownSchema,
    z
      .object({
        status: z.literal("ok"),
        publicEntityIds: z.array(publicEntityIdSchema).max(1_000),
        isDone: z.boolean(),
        continueCursor: publishedCursorSchema,
      })
      .strict(),
  ]);
}

export const publishedProviderIdPageSchema = publishedIdPageSchema(
  z.union([
    publicVendorIdSchema,
    publicCategoryIdSchema,
    publicRepackIdSchema,
    publicCollectibleIdSchema,
  ]),
);

export function publishedProviderIdPageSchemaForKind(
  entityKind: PublishedInspectableEntityKind,
) {
  return publishedIdPageSchema(
    publishedPublicEntityIdSchemaForKind(entityKind),
  );
}

export type PublishedProviderIdPage = z.infer<
  typeof publishedProviderIdPageSchema
>;

function publishedDocumentSchema(
  rowSchema: z.ZodType<PublishedEntityRow>,
) {
  const okSchema = z
    .object({
      status: z.literal("ok"),
      publicEntityId: z.string(),
      detail: z.json(),
    })
    .strict()
    .superRefine((value, context) => {
      const row = rowSchema.safeParse({
        publicEntityId: value.publicEntityId,
        detail: value.detail,
      });
      if (!row.success) {
        context.addIssue({
          code: "custom",
          path: ["detail"],
          message: "published_inspection.document_invalid",
        });
      }
    });
  return z.union([
    publishedReleaseUnknownSchema,
    publishedNotPresentSchema,
    okSchema,
  ]);
}

export const publishedProviderDocumentSchema = publishedDocumentSchema(
  publishedEntityRowSchema,
);

export function publishedProviderDocumentSchemaForKind(
  entityKind: PublishedInspectableEntityKind,
) {
  return publishedDocumentSchema(
    publishedEntityRowSchemaForKind(entityKind),
  );
}

export type PublishedProviderDocument = z.infer<
  typeof publishedProviderDocumentSchema
>;

export const publishedProviderChaseReconciliationSchema =
  z.discriminatedUnion("status", [
    publishedReleaseUnknownSchema,
    publishedNotPresentSchema,
    z
      .object({
        status: z.literal("ok"),
        publicRepackId: publicRepackIdSchema,
        expectedChaseCount: z.number().int().safe().min(0).max(250_000),
        acceptedChaseCount: z.number().int().safe().min(0).max(250_000),
        complete: z.boolean(),
      })
      .strict()
      .superRefine((value, context) => {
        if (value.acceptedChaseCount > value.expectedChaseCount) {
          context.addIssue({
            code: "custom",
            path: ["acceptedChaseCount"],
            message: "published_inspection.chase_count_invalid",
          });
        }
        if (
          value.complete !==
          (value.acceptedChaseCount === value.expectedChaseCount)
        ) {
          context.addIssue({
            code: "custom",
            path: ["complete"],
            message: "published_inspection.chase_completion_mismatch",
          });
        }
      }),
  ]);

export type PublishedProviderChaseReconciliation = z.infer<
  typeof publishedProviderChaseReconciliationSchema
>;
