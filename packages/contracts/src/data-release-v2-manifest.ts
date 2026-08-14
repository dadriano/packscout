import { z } from "zod";
import {
  DATA_RELEASE_SCHEMA_VERSION,
  MAX_REPACK_CHASES_PER_COLLECTIBLE,
  MAX_PUBLIC_REPACKS_PER_RELEASE,
  REPACK_SEARCH_VERSION,
  canonicalArraySchema,
  isStrictlySortedUnique,
  nonBlankTextSchema,
  nonNegativeIntegerSchema,
  parsedHttpsUrl,
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
  type PublicCategory,
  type PublicCollectible,
  type PublicCollectibleDisplay,
  type PublicRepackChase,
  type PublicRepackDetail,
  type PublicVendor,
} from "./data-release-v2-entities.ts";

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

function independentCategoryBranchCount(
  categoryIds: readonly string[],
  categoryById: ReadonlyMap<string, PublicCategory>,
): number {
  const deepest = categoryIds.filter((candidateId) =>
    !categoryIds.some(
      (otherId) =>
        otherId !== candidateId &&
        categoryById.get(otherId)?.pathPublicCategoryIds.includes(candidateId),
    )
  );
  return deepest.length;
}

function collectibleDisplayFromCanonical(
  collectible: PublicCollectible,
): PublicCollectibleDisplay {
  return {
    publicCollectibleId: collectible.publicCollectibleId,
    name: collectible.name,
    collectibleType: collectible.collectibleType,
    publicCategoryIds: collectible.publicCategoryIds,
    primaryImage: collectible.primaryImage,
    valuation: collectible.valuation,
  };
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sameNullableValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function comparableChaseValue(chase: PublicRepackChase): number | null {
  const comparison = chase.collectible.valuation?.usdComparison;
  return comparison?.status === "available"
    ? comparison.value.minorUnits
    : null;
}

function compareChasePriority(
  left: PublicRepackChase,
  right: PublicRepackChase,
): number {
  const leftValue = comparableChaseValue(left);
  const rightValue = comparableChaseValue(right);
  if (leftValue !== null && rightValue === null) return -1;
  if (leftValue === null && rightValue !== null) return 1;
  if (leftValue !== null && rightValue !== null && leftValue !== rightValue) {
    return leftValue > rightValue ? -1 : 1;
  }
  return (
    left.publicCollectibleId.localeCompare(right.publicCollectibleId) ||
    (left.displayOrder < right.displayOrder
      ? -1
      : left.displayOrder > right.displayOrder
        ? 1
        : 0)
  );
}

function categorySetsShareBranch(
  leftIds: readonly string[],
  rightIds: readonly string[],
  categoryById: ReadonlyMap<string, PublicCategory>,
): boolean {
  return leftIds.some((leftId) =>
    rightIds.some((rightId) =>
      leftId === rightId ||
      categoryById.get(leftId)?.pathPublicCategoryIds.includes(rightId) === true ||
      categoryById.get(rightId)?.pathPublicCategoryIds.includes(leftId) === true
    )
  );
}

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
    const canonicalSets = [
      [
        "vendors",
        isStrictlySortedUnique(
          release.vendors,
          (value: PublicVendor) => value.publicVendorId,
        ),
      ],
      [
        "categories",
        isStrictlySortedUnique(
          release.categories,
          (value: PublicCategory) => value.publicCategoryId,
        ),
      ],
      [
        "repacks",
        isStrictlySortedUnique(
          release.repacks,
          (value: PublicRepackDetail) => value.publicRepackId,
        ),
      ],
      [
        "collectibles",
        isStrictlySortedUnique(
          release.collectibles,
          (value: PublicCollectible) => value.publicCollectibleId,
        ),
      ],
      [
        "repackChases",
        isStrictlySortedUnique(
          release.repackChases,
          (value: PublicRepackChase) =>
            `${value.publicRepackId}:${String(value.displayOrder).padStart(10, "0")}:${value.publicCollectibleId}`,
        ),
      ],
    ] as const;
    for (const [path, canonical] of canonicalSets) {
      if (!canonical) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: "data_release.entities_not_canonical",
        });
      }
    }

    const vendorById = new Map(
      release.vendors.map((vendor) => [vendor.publicVendorId, vendor]),
    );
    const categoryById = new Map(
      release.categories.map((category) => [category.publicCategoryId, category]),
    );
    const collectibleById = new Map(
      release.collectibles.map((collectible) => [
        collectible.publicCollectibleId,
        collectible,
      ]),
    );
    const repackById = new Map(
      release.repacks.map((repack) => [repack.publicRepackId, repack]),
    );

    const governedAssetOrigins = new Set(release.publicAssetOrigins);
    release.vendors.forEach((vendor, index) => {
      if (
        vendor.imageOrigins.some((origin) => !governedAssetOrigins.has(origin))
      ) {
        context.addIssue({
          code: "custom",
          path: ["vendors", index, "imageOrigins"],
          message: "data_release.vendor_image_origin_not_governed",
        });
      }
    });

    if (
      new Set(release.vendors.map(({ vendorKey }) => vendorKey)).size !==
      release.vendors.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["vendors"],
        message: "data_release.vendor_key_not_unique",
      });
    }
    if (
      new Set(release.categories.map(({ categoryKey }) => categoryKey)).size !==
      release.categories.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["categories"],
        message: "data_release.category_key_not_unique",
      });
    }

    release.categories.forEach((category, index) => {
      const parent = category.parentPublicCategoryId === null
        ? null
        : categoryById.get(category.parentPublicCategoryId) ?? null;
      const expectedPath = parent === null
        ? [category.publicCategoryId]
        : [...parent.pathPublicCategoryIds, category.publicCategoryId];
      if (
        category.pathPublicCategoryIds.some((id) => !categoryById.has(id)) ||
        (category.parentPublicCategoryId !== null &&
          parent === null) ||
        !sameStringArray(category.pathPublicCategoryIds, expectedPath)
      ) {
        context.addIssue({
          code: "custom",
          path: ["categories", index],
          message: "data_release.category_hierarchy_invalid",
        });
      }
    });
    release.collectibles.forEach((collectible, index) => {
      if (
        collectible.publicCategoryIds.some((id) => !categoryById.has(id)) ||
        (collectible.primaryImage !== null &&
          !release.publicAssetOrigins.includes(
            parsedHttpsUrl(collectible.primaryImage.url)?.origin ?? "",
          ))
      ) {
        context.addIssue({
          code: "custom",
          path: ["collectibles", index],
          message: "data_release.collectible_reference_invalid",
        });
      }
    });
    release.repacks.forEach((repack, index) => {
      const vendor = vendorById.get(repack.publicVendorId);
      const categoryIds = repack.categories.map(
        ({ publicCategoryId }) => publicCategoryId,
      );
      if (
        vendor === undefined ||
        vendor.vendorKey !== repack.vendorKey ||
        vendor.displayName !== repack.vendorDisplayName ||
        vendor.logoUrl !== repack.vendorLogoUrl ||
        repack.categories.some(({ publicCategoryId, label }) => {
          const category = categoryById.get(publicCategoryId);
          return category === undefined || category.name !== label;
        })
      ) {
        context.addIssue({
          code: "custom",
          path: ["repacks", index],
          message: "data_release.repack_reference_invalid",
        });
      }
      const branchCount = independentCategoryBranchCount(
        categoryIds,
        categoryById,
      );
      if (
        categoryIds.some((categoryId) =>
          !categoryById
            .get(categoryId)
            ?.pathPublicCategoryIds.every((ancestorId) =>
              categoryIds.includes(ancestorId)
            )
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["repacks", index, "categories"],
          message: "data_release.repack_category_path_incomplete",
        });
      }
      const categoryKnowledge = branchCount;
      const typeKnowledge = repack.collectibleTypes.length;
      const expectedMode = categoryKnowledge > 1 || typeKnowledge > 1
        ? "mixed"
        : categoryKnowledge === 1 || typeKnowledge === 1
          ? "focused"
          : "unknown";
      if (repack.contentMode !== expectedMode) {
        context.addIssue({
          code: "custom",
          path: ["repacks", index, "contentMode"],
          message: "data_release.content_mode_mismatch",
        });
      }
      if (
        repack.primaryImage !== null &&
        vendor !== undefined &&
        !vendor.imageOrigins.includes(
          parsedHttpsUrl(repack.primaryImage.url)?.origin ?? "",
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["repacks", index, "primaryImage"],
          message: "data_release.repack_image_origin_not_approved",
        });
      }
      const link = repack.actions.repackLink;
      if (
        link !== undefined &&
        vendor !== undefined &&
        (!vendor.listingHosts.includes(link.listingHost) ||
          JSON.stringify(link.referralParameters) !==
            JSON.stringify(vendor.referralParameters))
      ) {
        context.addIssue({
          code: "custom",
          path: ["repacks", index, "actions", "repackLink"],
          message: "data_release.repack_link_not_approved",
        });
      }
      if (
        vendor !== undefined &&
        !sameNullableValue(repack.actions.promo ?? null, vendor.publicPromo)
      ) {
        context.addIssue({
          code: "custom",
          path: ["repacks", index, "actions", "promo"],
          message: "data_release.repack_promo_not_approved",
        });
      }

      const vendorReported = repack.evEstimates.vendorReported;
      if (vendorReported.observedAt !== null) {
        const observedAt = Date.parse(vendorReported.observedAt);
        if (
          observedAt > Date.parse(release.metadata.lastSuccessfulObservationAt) ||
          observedAt > Date.parse(release.metadata.completedAt)
        ) {
          context.addIssue({
            code: "custom",
            path: [
              "repacks",
              index,
              "evEstimates",
              "vendorReported",
              "observedAt",
            ],
            message: "data_release.vendor_ev_timing_invalid",
          });
        }
      }

      const packScout = repack.evEstimates.packScout;
      if (
        packScout.confidencePolicyVersion !==
        release.metadata.confidencePolicyVersion
      ) {
        context.addIssue({
          code: "custom",
          path: ["repacks", index, "evEstimates", "packScout", "confidencePolicyVersion"],
          message: "data_release.confidence_policy_mismatch",
        });
      }
      if (packScout.status === "available" && packScout.calculatedAt === null) {
        context.addIssue({
          code: "custom",
          path: ["repacks", index, "evEstimates", "packScout"],
          message: "data_release.packscout_timing_incomplete",
        });
      }
      if (packScout.calculatedAt !== null) {
        const calculatedAt = Date.parse(packScout.calculatedAt);
        if (
          (packScout.dataAsOf !== null &&
            calculatedAt < Date.parse(packScout.dataAsOf)) ||
          (packScout.dataAsOf !== null &&
            Date.parse(packScout.dataAsOf) >
              Date.parse(release.metadata.dataAsOf)) ||
          calculatedAt > Date.parse(release.metadata.completedAt)
        ) {
          context.addIssue({
            code: "custom",
            path: ["repacks", index, "evEstimates", "packScout", "calculatedAt"],
            message: "data_release.packscout_timing_invalid",
          });
        }
      }
    });

    const seenChases = new Set<string>();
    const chaseCountByCollectible = new Map<string, number>();
    const topChaseByRepack = new Map<string, PublicRepackChase>();
    const chasesByRepack = new Map<string, PublicRepackChase[]>();
    release.repackChases.forEach((chase, index) => {
      const key = `${chase.publicRepackId}:${chase.publicCollectibleId}`;
      const collectibleChaseCount =
        (chaseCountByCollectible.get(chase.publicCollectibleId) ?? 0) + 1;
      chaseCountByCollectible.set(
        chase.publicCollectibleId,
        collectibleChaseCount,
      );
      if (collectibleChaseCount === MAX_REPACK_CHASES_PER_COLLECTIBLE + 1) {
        context.addIssue({
          code: "custom",
          path: ["repackChases", index, "publicCollectibleId"],
          message: "data_release.collectible_chase_limit_exceeded",
        });
      }
      const repack = repackById.get(chase.publicRepackId);
      const collectible = collectibleById.get(chase.publicCollectibleId);
      if (
        seenChases.has(key) ||
        repack === undefined ||
        collectible === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["repackChases", index],
          message: "data_release.chase_reference_invalid",
        });
      }
      seenChases.add(key);
      if (collectible !== undefined) {
        if (
          JSON.stringify(chase.collectible) !==
          JSON.stringify(collectibleDisplayFromCanonical(collectible)) ||
          (chase.collectible.primaryImage !== null &&
            !release.publicAssetOrigins.includes(
              parsedHttpsUrl(chase.collectible.primaryImage.url)?.origin ?? "",
            ))
        ) {
          context.addIssue({
            code: "custom",
            path: ["repackChases", index, "collectible"],
            message: "data_release.chase_collectible_projection_invalid",
          });
        }
        if (
          repack !== undefined &&
          (!repack.collectibleTypes.includes(collectible.collectibleType) ||
            (repack.categories.length > 0 &&
              collectible.publicCategoryIds.length > 0 &&
              !categorySetsShareBranch(
                repack.categories.map(({ publicCategoryId }) => publicCategoryId),
                collectible.publicCategoryIds,
                categoryById,
              )))
        ) {
          context.addIssue({
            code: "custom",
            path: ["repackChases", index],
            message: "data_release.chase_classification_mismatch",
          });
        }
      }
      if (repack !== undefined) {
        const repackChases = chasesByRepack.get(repack.publicRepackId) ?? [];
        repackChases.push(chase);
        chasesByRepack.set(repack.publicRepackId, repackChases);
      }
      if (chase.role === "top_chase") {
        if (topChaseByRepack.has(chase.publicRepackId)) {
          context.addIssue({
            code: "custom",
            path: ["repackChases", index, "role"],
            message: "data_release.top_chase_not_unique",
          });
        }
        topChaseByRepack.set(chase.publicRepackId, chase);
      }
    });
    release.repacks.forEach((repack, index) => {
      const repackChases = chasesByRepack.get(repack.publicRepackId) ?? [];
      const governedTopChase = [...repackChases].sort(compareChasePriority)[0] ??
        null;
      if (
        repackChases.some(
          (chase, chaseIndex) => chase.displayOrder !== chaseIndex,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["repackChases"],
          message: "data_release.chase_display_order_invalid",
        });
      }
      if (
        JSON.stringify(repack.topChase) !==
          JSON.stringify(governedTopChase) ||
        (governedTopChase !== null && governedTopChase.role !== "top_chase") ||
        JSON.stringify(governedTopChase) !==
          JSON.stringify(topChaseByRepack.get(repack.publicRepackId) ?? null)
      ) {
        context.addIssue({
          code: "custom",
          path: ["repacks", index, "topChase"],
          message: "data_release.top_chase_projection_mismatch",
        });
      }
      if (
        repack.contentSummary.chaseCount !== repackChases.length ||
        repack.contentSummary.knownCollectibleCount <
          new Set(repackChases.map(({ publicCollectibleId }) => publicCollectibleId))
            .size
      ) {
        context.addIssue({
          code: "custom",
          path: ["repacks", index, "contentSummary"],
          message: "data_release.chase_count_mismatch",
        });
      }
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
