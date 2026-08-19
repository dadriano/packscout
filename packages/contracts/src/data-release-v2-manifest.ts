import { z } from "zod";
import {
  DATA_RELEASE_SCHEMA_VERSION,
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  REPACK_SEARCH_VERSION,
  canonicalArraySchema,
  nonBlankTextSchema,
  nonNegativeIntegerSchema,
  publicHttpsOriginSchema,
  sha256Schema,
  timestampSchema,
} from "./data-release-v2-values.ts";
import {
  publicCategorySchema,
  publicCollectibleSchema,
  publicRepackChaseSchema,
  publicRepackDetailSchema,
  publicVendorSchema,
} from "./data-release-v2-entities.ts";
import { validateDataReleaseV2EntityGraph } from "./data-release-v2-graph.ts";

export const dataReleaseMetadataSchema = z
  .object({
    schemaVersion: z.literal(DATA_RELEASE_SCHEMA_VERSION),
    dataSource: z.enum(["canonical", "mock"]),
    publicReleaseId: z.uuid(),
    sourceWatermark: z
      .string()
      .regex(/^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/),
    manifestFingerprint: sha256Schema,
    contentHash: sha256Schema,
    publicConfigRevision: z.number().int().positive(),
    publicConfigHash: sha256Schema,
    originSetHash: sha256Schema,
    searchAlgorithmVersion: z.literal(REPACK_SEARCH_VERSION),
    repackSearchIndexHash: sha256Schema,
    confidencePolicyVersion: nonBlankTextSchema(128),
    createdAt: timestampSchema,
    completedAt: timestampSchema,
    dataAsOf: timestampSchema,
    lastSuccessfulObservationAt: timestampSchema,
    staleAt: timestampSchema,
    freshness: z.enum(["fresh", "delayed"]),
    delayedVendorCount: nonNegativeIntegerSchema,
    vendorCount: z.number().int().min(0).max(128),
    categoryCount: z.number().int().min(0).max(4_096),
    repackCount: z
      .number()
      .int()
      .min(0)
      .max(MAX_PUBLIC_REPACKS_PER_RELEASE),
    collectibleCount: z.number().int().min(0).max(100_000),
    repackChaseCount: z.number().int().min(0).max(250_000),
  })
  .strict()
  .superRefine((metadata, context) => {
    if (Date.parse(metadata.completedAt) < Date.parse(metadata.createdAt)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "data_release.completed_before_created",
      });
    }
    if (
      Date.parse(metadata.staleAt) <=
      Date.parse(metadata.lastSuccessfulObservationAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["staleAt"],
        message: "data_release.stale_deadline_invalid",
      });
    }
    if (
      Date.parse(metadata.dataAsOf) >
      Date.parse(metadata.lastSuccessfulObservationAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["dataAsOf"],
        message: "data_release.data_after_observation",
      });
    }
    if (metadata.freshness === "fresh" && metadata.delayedVendorCount !== 0) {
      context.addIssue({
        code: "custom",
        path: ["delayedVendorCount"],
        message: "data_release.fresh_has_delayed_vendors",
      });
    }
  });

export const dataReleaseManifestV2Schema = z
  .object({
    metadata: dataReleaseMetadataSchema,
    publicAssetOrigins: canonicalArraySchema(publicHttpsOriginSchema, 64),
    vendors: z.array(publicVendorSchema).max(128),
    categories: z.array(publicCategorySchema).max(4_096),
    repacks: z
      .array(publicRepackDetailSchema)
      .max(MAX_PUBLIC_REPACKS_PER_RELEASE),
    collectibles: z.array(publicCollectibleSchema).max(100_000),
    repackChases: z.array(publicRepackChaseSchema).max(250_000),
  })
  .strict()
  .superRefine((release, context) => {
    const countPairs = [
      ["vendorCount", release.vendors.length],
      ["categoryCount", release.categories.length],
      ["repackCount", release.repacks.length],
      ["collectibleCount", release.collectibles.length],
      ["repackChaseCount", release.repackChases.length],
    ] as const;
    for (const [field, actual] of countPairs) {
      if (release.metadata[field] !== actual) {
        context.addIssue({
          code: "custom",
          path: ["metadata", field],
          message: "data_release.count_mismatch",
        });
      }
    }
    validateDataReleaseV2EntityGraph(release, context, {
      timing: {
        dataAsOf: release.metadata.dataAsOf,
        lastSuccessfulObservationAt:
          release.metadata.lastSuccessfulObservationAt,
        completedAt: release.metadata.completedAt,
        confidencePolicyVersion: release.metadata.confidencePolicyVersion,
      },
    });
  });

export type DataReleaseMetadata = z.infer<typeof dataReleaseMetadataSchema>;
export type DataReleaseManifestV2 = z.infer<
  typeof dataReleaseManifestV2Schema
>;

export function parseDataReleaseManifestV2(input: unknown): DataReleaseManifestV2 {
  return dataReleaseManifestV2Schema.parse(input);
}

export function safeParseDataReleaseManifestV2(input: unknown) {
  return dataReleaseManifestV2Schema.safeParse(input);
}
