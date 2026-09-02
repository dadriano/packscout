import type {
  PublicCategory,
  PublicCollectible,
  PublicRepackChase,
  PublicRepackDetail,
  PublicVendor,
} from "./data-release-v2-entities.ts";
import { z } from "zod";
import { canonicalJson, sha256CanonicalJson } from "./data-release-v2-canonical.ts";
import {
  nonBlankTextSchema,
  nonNegativeIntegerSchema,
  normalizePublicSearchText,
  publicCategoryIdSchema,
  publicCategoryKeySchema,
  publicCategoryKindSchema,
  publicCollectibleIdSchema,
  publicCollectibleTypeSchema,
  publicCurrencyKeySchema,
  publicHttpsUrlSchema,
  timestampSchema,
} from "./data-release-v2-values.ts";

const NORMALIZED_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/u;

export const CATALOG_BATCH_HASH_DOMAIN = "packscout.catalog.batch.v1" as const;
export const CATALOG_CONTENT_SEED_HASH_DOMAIN =
  "packscout.catalog.content-seed.v1" as const;
export const CATALOG_CONTENT_CHAIN_HASH_DOMAIN =
  "packscout.catalog.content-chain.v1" as const;

export interface PublicCatalogCategory {
  readonly publicCategoryId: string;
  readonly parentPublicCategoryId: string | null;
  readonly categoryKey: string;
  readonly displayName: string;
  readonly categoryKind:
    | "vertical"
    | "sport"
    | "league"
    | "franchise"
    | "brand"
    | "set"
    | "other";
  readonly displayOrder: number;
  readonly depth: number;
  readonly pathPublicCategoryIds: readonly string[];
  readonly lifecycle: "active";
}

export interface PublicCatalogCollectible {
  readonly publicCollectibleId: string;
  readonly identityState: "provisional" | "canonical";
  readonly collectibleType: PublicCollectible["collectibleType"];
  readonly displayName: string;
  readonly normalizedName: string;
  readonly nameAliases: readonly string[];
  readonly normalizedNameAliases: readonly string[];
  readonly publicCategoryIds: readonly string[];
  readonly year: number | null;
  readonly brand: string | null;
  readonly setOrSeries: string | null;
  readonly cardNumber: string | null;
  readonly referenceNumber: string | null;
  readonly subject: string | null;
  readonly grade: string | null;
  readonly grader: string | null;
  readonly primaryImageUrl: string | null;
  readonly primaryImageAlt: string | null;
  readonly valuationAmount: string | null;
  readonly valuationCurrency: string | null;
  readonly valuationUsdAmount: string | null;
  readonly valuationUnavailableReason:
    | "VALUATION_UNAVAILABLE"
    | "CURRENCY_UNSUPPORTED"
    | null;
  readonly valuationType:
    | "market_estimate"
    | "vendor_reported"
    | "last_sale"
    | "appraisal"
    | null;
  readonly valuationObservedAt: string | null;
  readonly dataAsOf: string;
}

export interface PublicCatalogAlias {
  readonly aliasPublicCollectibleId: string;
  readonly canonicalPublicCollectibleId: string;
}

export const publicCatalogCategorySchema = z
  .object({
    publicCategoryId: publicCategoryIdSchema,
    parentPublicCategoryId: publicCategoryIdSchema.nullable(),
    categoryKey: publicCategoryKeySchema,
    displayName: nonBlankTextSchema(100),
    categoryKind: publicCategoryKindSchema,
    displayOrder: nonNegativeIntegerSchema,
    depth: z.number().int().min(0).max(12),
    pathPublicCategoryIds: z.array(publicCategoryIdSchema).min(1).max(12),
    lifecycle: z.literal("active"),
  })
  .strict()
  .superRefine((category, context) => {
    const path = category.pathPublicCategoryIds;
    if (
      path.at(-1) !== category.publicCategoryId ||
      new Set(path).size !== path.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["pathPublicCategoryIds"],
        message: "public_catalog_category.path_invalid",
      });
    }
    if (category.depth !== path.length - 1) {
      context.addIssue({
        code: "custom",
        path: ["depth"],
        message: "public_catalog_category.depth_mismatch",
      });
    }
    if (category.parentPublicCategoryId !== (path.at(-2) ?? null)) {
      context.addIssue({
        code: "custom",
        path: ["parentPublicCategoryId"],
        message: "public_catalog_category.parent_mismatch",
      });
    }
  });

const nullableCatalogTextSchema = (maximum: number) =>
  nonBlankTextSchema(maximum).nullable();
const catalogCurrencySchema = z.union([
  publicCurrencyKeySchema,
  z.string().regex(/^0x[0-9A-Fa-f]{40}$/u),
]);
const catalogDecimalSchema = z.string().refine((value) => {
  try {
    return normalizeExactDecimal(value) === value;
  } catch {
    return false;
  }
}, { message: "public_catalog_collectible.decimal_invalid" });

export const publicCatalogCollectibleSchema = z
  .object({
    publicCollectibleId: publicCollectibleIdSchema,
    identityState: z.enum(["provisional", "canonical"]),
    collectibleType: publicCollectibleTypeSchema,
    displayName: nonBlankTextSchema(240),
    normalizedName: nonBlankTextSchema(240),
    nameAliases: z.array(nonBlankTextSchema(240)).max(32),
    normalizedNameAliases: z.array(nonBlankTextSchema(240)).max(32),
    publicCategoryIds: z.array(publicCategoryIdSchema).max(32),
    year: z.number().int().min(1000).max(9999).nullable(),
    brand: nullableCatalogTextSchema(120),
    setOrSeries: nullableCatalogTextSchema(200),
    cardNumber: nullableCatalogTextSchema(100),
    referenceNumber: nullableCatalogTextSchema(100),
    subject: nullableCatalogTextSchema(200),
    grade: nullableCatalogTextSchema(100),
    grader: nullableCatalogTextSchema(100),
    primaryImageUrl: publicHttpsUrlSchema.nullable(),
    primaryImageAlt: nullableCatalogTextSchema(200),
    valuationAmount: catalogDecimalSchema.nullable(),
    valuationCurrency: catalogCurrencySchema.nullable(),
    valuationUsdAmount: catalogDecimalSchema.nullable(),
    valuationUnavailableReason: z.enum([
      "VALUATION_UNAVAILABLE",
      "CURRENCY_UNSUPPORTED",
    ]).nullable(),
    valuationType: z.enum([
      "market_estimate",
      "vendor_reported",
      "last_sale",
      "appraisal",
    ]).nullable(),
    valuationObservedAt: timestampSchema.nullable(),
    dataAsOf: timestampSchema,
  })
  .strict()
  .superRefine((collectible, context) => {
    if (
      collectible.normalizedName !==
        normalizePublicSearchText(collectible.displayName)
    ) {
      context.addIssue({
        code: "custom",
        path: ["normalizedName"],
        message: "public_catalog_collectible.normalized_name_mismatch",
      });
    }
    const expectedAliases = collectible.nameAliases
      .map(normalizePublicSearchText)
      .sort();
    const actualAliases = [...collectible.normalizedNameAliases].sort();
    if (
      new Set(collectible.nameAliases).size !== collectible.nameAliases.length ||
      new Set(collectible.publicCategoryIds).size !==
        collectible.publicCategoryIds.length ||
      expectedAliases.length !== actualAliases.length ||
      expectedAliases.some((alias, index) => alias !== actualAliases[index])
    ) {
      context.addIssue({
        code: "custom",
        path: ["nameAliases"],
        message: "public_catalog_collectible.aliases_invalid",
      });
    }
    if (
      (collectible.primaryImageUrl === null) !==
        (collectible.primaryImageAlt === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["primaryImageUrl"],
        message: "public_catalog_collectible.image_incomplete",
      });
    }
    if (
      (collectible.valuationAmount === null) !==
        (collectible.valuationCurrency === null) ||
      (collectible.valuationType === null) !==
        (collectible.valuationObservedAt === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["valuationType"],
        message: "public_catalog_collectible.valuation_incomplete",
      });
    }
    const hasValuationDescriptor = collectible.valuationType !== null;
    if (
      (!hasValuationDescriptor && (
        collectible.valuationAmount !== null ||
        collectible.valuationCurrency !== null ||
        collectible.valuationUsdAmount !== null ||
        collectible.valuationUnavailableReason !== null
      )) ||
      (hasValuationDescriptor &&
        collectible.valuationAmount === null &&
        collectible.valuationUsdAmount === null &&
        collectible.valuationUnavailableReason === null) ||
      (collectible.valuationUsdAmount !== null &&
        collectible.valuationUnavailableReason !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["valuationUnavailableReason"],
        message: "public_catalog_collectible.valuation_evidence_invalid",
      });
    }
    if (
      collectible.valuationObservedAt !== null &&
      new Date(collectible.valuationObservedAt).getTime() >
        new Date(collectible.dataAsOf).getTime()
    ) {
      context.addIssue({
        code: "custom",
        path: ["valuationObservedAt"],
        message: "public_catalog_collectible.valuation_newer_than_data",
      });
    }
  });

export const publicCatalogAliasSchema = z
  .object({
    aliasPublicCollectibleId: publicCollectibleIdSchema,
    canonicalPublicCollectibleId: publicCollectibleIdSchema,
  })
  .strict()
  .refine(
    (alias) =>
      alias.aliasPublicCollectibleId !== alias.canonicalPublicCollectibleId,
    {
      path: ["canonicalPublicCollectibleId"],
      message: "public_catalog_alias.self_reference",
    },
  );

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value));
}

export function normalizeExactDecimal(value: string): string {
  if (typeof value !== "string" || !/^[0-9]+(?:\.[0-9]+)?$/u.test(value)) {
    throw new TypeError("Exact decimal must be a non-negative base-10 string.");
  }
  const [integerPart = "0", fractionPart = ""] = value.split(".");
  const integer = integerPart.replace(/^0+(?=[0-9])/u, "");
  const fraction = fractionPart.replace(/0+$/u, "");
  const normalized = fraction.length === 0 ? integer : `${integer}.${fraction}`;
  if (!NORMALIZED_DECIMAL_PATTERN.test(normalized)) {
    throw new TypeError("Exact decimal could not be normalized.");
  }
  return normalized;
}

export function catalogContentSeedHash(input: {
  readonly schemaVersion: string;
  readonly categoryCount: number;
  readonly collectibleCount: number;
  readonly aliasCount: number;
  readonly batchCount: number;
}): Promise<string> {
  return sha256CanonicalJson(CATALOG_CONTENT_SEED_HASH_DOMAIN, input);
}

export function extendCatalogContentHash(input: {
  readonly previousHash: string;
  readonly batchOrdinal: number;
  readonly batchKind: "categories" | "collectibles" | "aliases";
  readonly batchIndex: number;
  readonly recordCount: number;
  readonly byteCount: number;
  readonly bodyHash: string;
}): Promise<string> {
  return sha256CanonicalJson(CATALOG_CONTENT_CHAIN_HASH_DOMAIN, input);
}

export const PROVIDER_RELEASE_PUBLIC_SCHEMA_VERSION = "provider-release-v1" as const;
export const PROVIDER_RELEASE_MAX_BATCH_BYTES = 480 * 1024;
export const PROVIDER_RELEASE_MAX_BATCH_RECORDS = 250;
export const PROVIDER_RELEASE_MAX_BATCHES = 4_096;

export const PROVIDER_RELEASE_BATCH_HASH_DOMAIN =
  "packscout.provider-release.batch.v1" as const;
export const PROVIDER_RELEASE_CONTENT_SEED_HASH_DOMAIN =
  "packscout.provider-release.content-seed.v1" as const;
export const PROVIDER_RELEASE_CONTENT_CHAIN_HASH_DOMAIN =
  "packscout.provider-release.content-chain.v1" as const;
export const PROVIDER_RELEASE_INDEX_HASH_DOMAIN =
  "packscout.provider-release.index.v1" as const;
export const PROVIDER_RELEASE_PUBLIC_EQUIVALENCE_HASH_DOMAIN =
  "packscout.provider-release.public-equivalence.v1" as const;
export const PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN =
  "packscout.provider-public-profile.v1" as const;
export const PROVIDER_CORRELATION_SNAPSHOT_HASH_DOMAIN =
  "packscout.provider-correlation-snapshot.v1" as const;
export const PROVIDER_RELEASE_CATALOG_PIN_HASH_DOMAIN =
  "packscout.provider-release.catalog-pin.v1" as const;

export function providerReleaseCatalogPinHash(input: {
  readonly catalogVersionId: string;
  readonly catalogSchemaVersion: string;
  readonly catalogContentHash: string;
  readonly catalogThroughChangeSequence: string;
  readonly categories: readonly PublicCatalogCategory[];
  readonly collectibles: readonly PublicCatalogCollectible[];
  readonly aliases: readonly PublicCatalogAlias[];
}): Promise<string> {
  return sha256CanonicalJson(PROVIDER_RELEASE_CATALOG_PIN_HASH_DOMAIN, input);
}

export function providerReleaseCorrelationSnapshotHash(input: {
  readonly providerId: string;
  readonly correlationEventSequence: string;
  readonly categories: readonly {
    readonly localCategoryId: string;
    readonly localEntityVersion: string;
    readonly publicCategoryId: string;
  }[];
  readonly collectibles: readonly {
    readonly localCollectibleId: string;
    readonly localEntityVersion: string;
    readonly publicCollectibleId: string;
  }[];
}): Promise<string> {
  return sha256CanonicalJson(PROVIDER_CORRELATION_SNAPSHOT_HASH_DOMAIN, input);
}

export type ProviderReleaseBatchKind =
  | "provider"
  | "category"
  | "collectible"
  | "repack"
  | "chase"
  | "retired-repack"
  | "search-index";

export interface ProviderReleaseRetiredRepack {
  readonly publicRepackId: string;
  readonly lifecycle: "retired";
  readonly unavailableReason: "PROVIDER_UNAVAILABLE" | "REPACK_RETIRED";
  readonly retiredAt: string;
}

export interface ProviderReleaseSearchRecord {
  readonly publicRepackId: string;
  readonly publicVendorId: string;
  readonly vendorKey: string;
  readonly normalizedName: string;
  readonly publicCategoryIds: readonly string[];
  readonly collectibleTypes: readonly PublicCollectible["collectibleType"][];
  readonly availability: PublicRepackDetail["availability"];
  readonly priceUsdMinor: number | null;
  readonly packScoutEvPercentBasisPoints: number | null;
  readonly topChaseUsdMinor: number | null;
}

export type ProviderReleaseRecord =
  | PublicVendor
  | PublicCategory
  | PublicCollectible
  | PublicRepackDetail
  | PublicRepackChase
  | ProviderReleaseRetiredRepack
  | ProviderReleaseSearchRecord;

export interface ProviderReleaseBatch {
  readonly batchOrdinal: number;
  readonly batchKind: ProviderReleaseBatchKind;
  readonly batchIndex: number;
  readonly records: readonly ProviderReleaseRecord[];
  readonly recordCount: number;
  readonly byteCount: number;
  readonly bodyHash: string;
}

export interface ProviderReleaseDescriptor {
  readonly providerReleaseId: string;
  readonly predecessorCompleteReleaseId: string | null;
  readonly providerId: string;
  readonly providerKey: string;
  readonly publicProviderId: string;
  readonly throughChangeSequence: string;
  readonly catalogVersionId: string;
  readonly catalogContentHash: string;
  readonly centralSchemaVersion: string;
  readonly correlationEventSequence: string;
  readonly correlationSnapshotHash: string;
  readonly publicProfileVersionId: string;
  readonly publicProfileHash: string;
  readonly providerSchemaVersion: string;
  readonly publicSchemaVersion: typeof PROVIDER_RELEASE_PUBLIC_SCHEMA_VERSION;
  readonly categoryCount: number;
  readonly repackCount: number;
  readonly collectibleReferenceCount: number;
  readonly chaseCount: number;
  readonly retiredRepackCount: number;
  readonly batchCount: number;
  readonly contentHash: string;
  readonly indexHash: string;
  readonly dataAsOf: string;
  readonly lastSuccessfulObservationAt: string;
  readonly staleAt: string;
  readonly freshness: "fresh" | "delayed";
}

export interface BuiltProviderRelease {
  readonly descriptor: ProviderReleaseDescriptor;
  /**
   * Public-output fingerprint used only to select an equivalent complete artifact.
   * It deliberately does not replace the immutable descriptor content hash.
   */
  readonly publicEquivalenceHash: string;
  readonly provider: PublicVendor;
  readonly categories: readonly PublicCategory[];
  readonly collectibles: readonly PublicCollectible[];
  readonly repacks: readonly PublicRepackDetail[];
  readonly chases: readonly PublicRepackChase[];
  readonly retiredRepacks: readonly ProviderReleaseRetiredRepack[];
  readonly searchIndex: readonly ProviderReleaseSearchRecord[];
  readonly batches: readonly ProviderReleaseBatch[];
}
