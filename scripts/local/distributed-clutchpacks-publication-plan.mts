import { createHash } from "node:crypto";
import {
  approvedPublicCatalogConfigurationV1Schema,
  canonicalJson,
  parsePackScoutBuybackEvTimestampMillisV1,
  packscoutPublicIdentityUuid,
  publicRepackDetailSchema,
  publicHttpsOriginSchema,
  publicVendorSchema,
  sha256CanonicalJson,
  type ApprovedPublicCatalogConfigurationV1,
  type PublicRepackDetail,
  type PublicVendor,
} from "@packscout/contracts";
import {
  DataReleaseV3ReleaseAssembler,
  buildProviderCatalogReleasePublishPlan,
  createPackScoutBuybackEvPromotionEligibilityV1,
  normalizeClutchpacksPromotionEvEvidenceV1,
  projectProvisionalProviderPackContentsV1,
  type DataReleaseV3CanonicalProduct,
  type DataReleaseV3PublishPlan,
  type ProviderCatalogPublicProjection,
  type ProviderCatalogReleaseConfigurationSnapshot,
  type ProviderCatalogReleaseSnapshotCheckpoint,
} from "@packscout/services";
import {
  stableClutchpacksContentCatalog,
  validateClutchpacksContentCatalog,
  type DistributedClutchpacksContentCatalog,
} from "./distributed-clutchpacks-content-snapshot.mts";

export const DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY = "clutchpacks" as const;
export const LOCAL_PUBLIC_CONFIGURATION_KEY =
  "local-clutchpacks-distributed-v1" as const;
export const LOCAL_PUBLIC_CONFIGURATION_REVISION = 3 as const;
export const LOCAL_PUBLIC_CONFIGURATION_SEQUENCE = 3n as const;
export const LOCAL_CONFIDENCE_POLICY = Object.freeze({
  version: "local-clutchpacks-promotion-ev-v2",
  completeScoreBasisPoints: 8_500,
  partialScoreBasisPoints: 6_000,
  unknownScoreBasisPoints: 2_500,
  limitationPenaltyBasisPoints: 500,
});

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SAFE_DECIMAL_PATTERN = /^(-?)(\d+)(?:\.(\d+))?$/u;

export class DistributedClutchpacksPublicationError extends Error {
  constructor(readonly code: string) {
    super("Distributed ClutchPacks publication was refused safely.");
    this.name = "DistributedClutchpacksPublicationError";
  }
}

function refuse(code: string): never {
  throw new DistributedClutchpacksPublicationError(code);
}

function iso(value: Date | null, code = "CLUTCHPACKS_SNAPSHOT_INVALID"): string {
  if (value === null || !Number.isFinite(value.getTime())) return refuse(code);
  return value.toISOString();
}

function nonBlank(value: string, code = "CLUTCHPACKS_SNAPSHOT_INVALID"): string {
  const normalized = value.trim();
  if (normalized.length === 0 || /[\r\n\0]/u.test(normalized)) return refuse(code);
  return normalized;
}

/** Exact half-up decimal scaling without converting canonical money through a float. */
export function decimalTextToScaledInteger(
  value: string,
  scale: number,
): number {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 18) {
    return refuse("PUBLIC_DECIMAL_INVALID");
  }
  const match = SAFE_DECIMAL_PATTERN.exec(value.trim());
  if (match === null || match[1] === "-") return refuse("PUBLIC_DECIMAL_INVALID");
  const integral = match[2]!;
  const fraction = match[3] ?? "";
  const kept = fraction.slice(0, scale).padEnd(scale, "0");
  const discarded = fraction.slice(scale);
  let result = BigInt(integral) * 10n ** BigInt(scale) + BigInt(kept || "0");
  if (discarded.length > 0 && discarded[0]! >= "5") result += 1n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) {
    return refuse("PUBLIC_DECIMAL_INVALID");
  }
  return Number(result);
}

function ratioBasisPoints(grossMinor: number, priceMinor: number): number {
  if (priceMinor <= 0) return refuse("PUBLIC_PRICE_INVALID");
  const value = (BigInt(grossMinor) * 10_000n + BigInt(priceMinor) / 2n) /
    BigInt(priceMinor);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return refuse("PUBLIC_EV_INVALID");
  return Number(value);
}

function httpsOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return refuse("PUBLIC_IMAGE_INVALID");
  }
  if (
    parsed.protocol !== "https:" || parsed.username !== "" ||
    parsed.password !== ""
  ) return refuse("PUBLIC_IMAGE_INVALID");
  return parsed.origin;
}

export interface DistributedClutchpacksPackRow {
  readonly id: string;
  readonly rowVersion: bigint;
  readonly packKey: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly packFormat: "repack" | "gacha";
  readonly availability: "available" | "sold_out" | "unavailable";
  readonly contentEvidence: "complete" | "partial" | "unknown";
  readonly priceAmount: string;
  readonly priceCurrency: string;
  readonly priceUsdAmount: string;
  readonly buybackRate: string | null;
  readonly buybackSourceKind: string | null;
  readonly vendorEvAmount: string | null;
  readonly vendorEvCurrency: string | null;
  readonly vendorEvObservedAt: Date | null;
  readonly packscoutEvModelVersion: string;
  readonly packscoutEvConfidencePolicyVersion: string;
  readonly packscoutEvDataAsOf: Date | null;
  readonly packscoutEvCalculatedAt: Date | null;
  readonly primaryImageUrl: string;
  readonly primaryImageAlt: string | null;
  readonly listingUrl: string | null;
  readonly sourceUpdatedAt: Date;
  /** Absent only when the importer has not retained normalized odds yet. */
  readonly evInputEvidence?: unknown;
}

export interface DistributedClutchpacksSnapshotFacts {
  readonly organizationId: string;
  readonly providerId: string;
  readonly providerKey: string;
  readonly providerDisplayName: string;
  readonly providerLifecycle: string;
  readonly activeConfigVersionId: string;
  readonly activeConfigVersionNumber: bigint;
  readonly activeConfigCreatedAt: Date;
  readonly staleAfterSeconds: number;
  readonly providerIdentityId: string;
  readonly providerIdentityKey: string;
  readonly runtimeProviderId: string;
  readonly runtimeProviderKey: string;
  readonly runtimeState: string;
  readonly runtimeConfigVersionId: string | null;
  readonly runtimeConfigVersionNumber: bigint | null;
  readonly runningRunCount: number;
  readonly queuedRunCount: number;
  readonly activeImportLeaseCount: number;
  readonly latestSourceHeadRunId: string;
  readonly latestSourceHeadConfigVersionId: string;
  readonly latestSourceHeadConfigVersionNumber: bigint;
  readonly latestSourceHeadFinishedAt: Date;
  /** Actual source head above remains unchanged by an audited catalog backfill. */
  readonly catalogSettledAt: Date;
  readonly catalogBackfillProofDigest: string | null;
  readonly approvedPublicAssetOrigins: readonly string[];
  readonly contentCatalog: DistributedClutchpacksContentCatalog;
  readonly promotionSequence: bigint;
  readonly promotionChangeCount: bigint;
  readonly minimumPromotionSequence: bigint | null;
  readonly maximumPromotionSequence: bigint | null;
  readonly maximumPromotionChangedAt: Date | null;
  readonly activePackCount: number;
  readonly activeCollectibleCount: number;
  readonly activePackContentCount: number;
  readonly maximumPackSourceUpdatedAt: Date;
  readonly packs: readonly DistributedClutchpacksPackRow[];
}

export interface DistributedClutchpacksStableSnapshot {
  readonly facts: DistributedClutchpacksSnapshotFacts;
  readonly checkpoint: ProviderCatalogReleaseSnapshotCheckpoint;
  readonly stabilityFingerprint: string;
}

function stableSnapshotBody(input: DistributedClutchpacksSnapshotFacts) {
  return {
    organizationId: input.organizationId,
    providerId: input.providerId,
    providerKey: input.providerKey,
    providerDisplayName: input.providerDisplayName,
    providerLifecycle: input.providerLifecycle,
    activeConfigVersionId: input.activeConfigVersionId,
    activeConfigVersionNumber: input.activeConfigVersionNumber.toString(),
    activeConfigCreatedAt: input.activeConfigCreatedAt.toISOString(),
    staleAfterSeconds: input.staleAfterSeconds,
    runtimeState: input.runtimeState,
    runtimeConfigVersionId: input.runtimeConfigVersionId,
    runtimeConfigVersionNumber: input.runtimeConfigVersionNumber?.toString() ?? null,
    runningRunCount: input.runningRunCount,
    activeImportLeaseCount: input.activeImportLeaseCount,
    latestSourceHeadRunId: input.latestSourceHeadRunId,
    latestSourceHeadFinishedAt: input.latestSourceHeadFinishedAt.toISOString(),
    catalogSettledAt: input.catalogSettledAt.toISOString(),
    catalogBackfillProofDigest: input.catalogBackfillProofDigest,
    approvedPublicAssetOrigins: input.approvedPublicAssetOrigins,
    contentCatalog: stableClutchpacksContentCatalog(input.contentCatalog),
    promotionSequence: input.promotionSequence.toString(),
    promotionChangeCount: input.promotionChangeCount.toString(),
    maximumPromotionChangedAt: input.maximumPromotionChangedAt?.toISOString() ?? null,
    activePackCount: input.activePackCount,
    activeCollectibleCount: input.activeCollectibleCount,
    activePackContentCount: input.activePackContentCount,
    maximumPackSourceUpdatedAt: input.maximumPackSourceUpdatedAt.toISOString(),
    packs: input.packs.map((pack) => ({
      ...pack,
      rowVersion: pack.rowVersion.toString(),
      sourceUpdatedAt: pack.sourceUpdatedAt.toISOString(),
      vendorEvObservedAt: pack.vendorEvObservedAt?.toISOString() ?? null,
      packscoutEvDataAsOf: pack.packscoutEvDataAsOf?.toISOString() ?? null,
      packscoutEvCalculatedAt: pack.packscoutEvCalculatedAt?.toISOString() ?? null,
      evInputEvidence: pack.evInputEvidence === undefined
        ? { state: "not_retained" }
        : { state: "retained", value: pack.evInputEvidence },
    })),
  };
}

export function assertDistributedClutchpacksStableSnapshot(
  input: DistributedClutchpacksSnapshotFacts,
): DistributedClutchpacksStableSnapshot {
  const finishedAt = input.latestSourceHeadFinishedAt.getTime();
  const maximumChangedAt = input.maximumPromotionChangedAt?.getTime() ?? NaN;
  const maximumPackAt = input.maximumPackSourceUpdatedAt.getTime();
  const settledAt = input.catalogSettledAt.getTime();
  if (
    input.providerKey !== DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY ||
    input.providerIdentityKey !== DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY ||
    input.runtimeProviderKey !== DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY ||
    input.providerLifecycle !== "active" ||
    input.providerIdentityId !== input.providerId ||
    input.runtimeProviderId !== input.providerId ||
    input.runtimeState !== "idle" ||
    input.runtimeConfigVersionId !== input.activeConfigVersionId ||
    input.runtimeConfigVersionNumber !== input.activeConfigVersionNumber ||
    input.latestSourceHeadConfigVersionId !== input.activeConfigVersionId ||
    input.latestSourceHeadConfigVersionNumber !== input.activeConfigVersionNumber ||
    input.runningRunCount !== 0 || input.activeImportLeaseCount !== 0 ||
    input.promotionSequence <= 0n ||
    input.promotionChangeCount !== input.promotionSequence ||
    input.minimumPromotionSequence !== 1n ||
    input.maximumPromotionSequence !== input.promotionSequence ||
    !Number.isFinite(finishedAt) || !Number.isFinite(maximumChangedAt) ||
    !Number.isFinite(maximumPackAt) || !Number.isFinite(settledAt) || settledAt < finishedAt ||
    (settledAt > finishedAt && (input.catalogBackfillProofDigest === null || !SHA256_PATTERN.test(input.catalogBackfillProofDigest))) ||
    maximumChangedAt > settledAt ||
    maximumPackAt > finishedAt || input.activePackCount < 1 ||
    input.activePackCount !== input.packs.length ||
    input.activePackContentCount !== input.contentCatalog.memberships.length ||
    !Number.isSafeInteger(input.staleAfterSeconds) ||
    input.staleAfterSeconds < 60 ||
    input.packs.some((pack) => pack.sourceUpdatedAt.getTime() > finishedAt)
  ) return refuse("CLUTCHPACKS_SNAPSHOT_INELIGIBLE");
  validateClutchpacksContentCatalog({ providerId: input.providerId, settledAt: input.catalogSettledAt,
    packs: input.packs, catalog: input.contentCatalog });
  const checkpoint: ProviderCatalogReleaseSnapshotCheckpoint = {
    platformKey: DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
    sharedConfigurationEpoch: {
      configurationKey: LOCAL_PUBLIC_CONFIGURATION_KEY,
      revision: LOCAL_PUBLIC_CONFIGURATION_REVISION,
      publicChangeSequence: LOCAL_PUBLIC_CONFIGURATION_SEQUENCE,
      configurationHash: "0".repeat(64),
    },
    settledSequence: input.promotionSequence,
    sourceHeadSequence: input.promotionSequence,
    settledAt: new Date(settledAt),
    sourceHeadAt: new Date(settledAt),
  };
  return {
    facts: input,
    checkpoint,
    stabilityFingerprint: createHash("sha256")
      .update(canonicalJson(stableSnapshotBody(input)), "utf8")
      .digest("hex"),
  };
}

function publicVendor(input: DistributedClutchpacksSnapshotFacts): PublicVendor {
  const imageOrigins = input.approvedPublicAssetOrigins.map((origin) => publicHttpsOriginSchema.parse(origin));
  if (imageOrigins.length === 0 || imageOrigins.some((origin, index) => index > 0 && imageOrigins[index - 1]! >= origin) ||
      input.packs.some(({ primaryImageUrl }) => !imageOrigins.includes(httpsOrigin(primaryImageUrl)))) return refuse("PUBLIC_IMAGE_UNAPPROVED");
  return publicVendorSchema.parse({
    publicVendorId: packscoutPublicIdentityUuid(`provider:${input.providerId}`),
    vendorKey: DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
    displayName: nonBlank(input.providerDisplayName),
    logoUrl: null,
    websiteUrl: null,
    listingHosts: [],
    imageOrigins,
    referralParameters: [],
    publicPromo: null,
  });
}

function money(pack: DistributedClutchpacksPackRow) {
  const currency = nonBlank(pack.priceCurrency, "PUBLIC_PRICE_INVALID");
  if (currency !== "USD") return refuse("PUBLIC_PRICE_INVALID");
  const displayMinor = decimalTextToScaledInteger(pack.priceAmount, 2);
  const usdMinor = decimalTextToScaledInteger(pack.priceUsdAmount, 2);
  if (displayMinor !== usdMinor || displayMinor <= 0) {
    return refuse("PUBLIC_PRICE_INVALID");
  }
  return {
    displayMoney: { minorUnits: displayMinor, currency },
    usdComparison: {
      status: "available" as const,
      value: { minorUnits: usdMinor, currency: "USD" as const },
    },
  };
}

function buybackV2(pack: DistributedClutchpacksPackRow) {
  if (pack.buybackRate === null) {
    if (pack.buybackSourceKind !== null) return refuse("PUBLIC_BUYBACK_INVALID");
    return {
      status: "unavailable" as const,
      value: null,
      reason: "BUYBACK_UNAVAILABLE" as const,
    };
  }
  if (pack.buybackSourceKind !== "provider_statement") {
    return refuse("PUBLIC_BUYBACK_INVALID");
  }
  return {
    status: "available" as const,
    value: {
      basisPoints: decimalTextToScaledInteger(pack.buybackRate, 4),
      sourceKind: "vendor_reported" as const,
    },
  };
}

function vendorEvV2(pack: DistributedClutchpacksPackRow) {
  if (pack.vendorEvAmount === null) {
    if (pack.vendorEvCurrency !== null) return refuse("PUBLIC_EV_INVALID");
    return {
      status: "unavailable" as const,
      displayMoney: null,
      metrics: null,
      observedAt: null,
      reason: "NOT_REPORTED" as const,
    };
  }
  if (pack.vendorEvCurrency !== "USD" || pack.vendorEvObservedAt === null) {
    return refuse("PUBLIC_EV_INVALID");
  }
  const grossMinor = decimalTextToScaledInteger(pack.vendorEvAmount, 2);
  const priceMinor = money(pack).usdComparison.value.minorUnits;
  const grossReturnBasisPoints = ratioBasisPoints(grossMinor, priceMinor);
  return {
    status: "available" as const,
    displayMoney: { minorUnits: grossMinor, currency: "USD" as const },
    metrics: {
      grossEv: { minorUnits: grossMinor, currency: "USD" as const },
      grossReturnBasisPoints,
      evDollars: {
        minorUnits: grossMinor - priceMinor,
        currency: "USD" as const,
      },
      evPercentBasisPoints: grossReturnBasisPoints - 10_000,
    },
    observedAt: iso(pack.vendorEvObservedAt, "PUBLIC_EV_INVALID"),
  };
}

function publicRepack(
  input: DistributedClutchpacksSnapshotFacts,
  vendor: PublicVendor,
  pack: DistributedClutchpacksPackRow,
): PublicRepackDetail {
  if (pack.listingUrl !== null) {
    // ClutchPacks has no centrally approved public profile/listing host yet.
    // Refuse instead of silently exposing a provider-local URL.
    return refuse("PUBLIC_ACTION_UNAPPROVED");
  }
  const name = nonBlank(pack.displayName, "PUBLIC_REPACK_INVALID");
  return publicRepackDetailSchema.parse({
    publicRepackId: packscoutPublicIdentityUuid(
      `provider:${input.providerId}:pack:${pack.id}`,
    ),
    publicVendorId: vendor.publicVendorId,
    vendorKey: vendor.vendorKey,
    vendorDisplayName: vendor.displayName,
    vendorLogoUrl: null,
    name,
    format: pack.packFormat,
    contentMode: "unknown",
    categories: [],
    collectibleTypes: [],
    availability: pack.availability,
    price: money(pack),
    buyback: buybackV2(pack),
    primaryImage: {
      url: pack.primaryImageUrl,
      alt: pack.primaryImageAlt?.trim() || name,
    },
    evEstimates: {
      vendorReported: vendorEvV2(pack),
      packScout: {
        status: "unavailable",
        metrics: null,
        confidence: null,
        modelVersion: nonBlank(pack.packscoutEvModelVersion),
        confidencePolicyVersion: nonBlank(
          pack.packscoutEvConfidencePolicyVersion,
        ),
        dataAsOf: pack.packscoutEvDataAsOf?.toISOString() ?? null,
        calculatedAt: pack.packscoutEvCalculatedAt?.toISOString() ?? null,
        reason: "ESTIMATE_INPUT_INCOMPLETE",
      },
    },
    topChase: null,
    contentSummary: {
      knownCollectibleCount: 0,
      chaseCount: 0,
      categoryCount: 0,
      collectibleTypeCount: 0,
      evidenceCompleteness: "unknown",
      probabilityCoverageBasisPoints: null,
    },
    actionAvailability: { promo: false, repackLink: false },
    sourceUpdatedAt: iso(pack.sourceUpdatedAt),
    description: pack.description?.trim() || null,
    actions: {},
  });
}

function vendorEvV3(pack: DistributedClutchpacksPackRow) {
  if (pack.vendorEvAmount === null) {
    return {
      status: "unavailable" as const,
      sourceMoney: null,
      usdComparison: null,
      observedAt: null,
      reason: "NOT_REPORTED" as const,
    };
  }
  if (pack.vendorEvCurrency !== "USD" || pack.vendorEvObservedAt === null) {
    return refuse("PUBLIC_EV_INVALID");
  }
  const minorUnits = decimalTextToScaledInteger(pack.vendorEvAmount, 2);
  return {
    status: "available" as const,
    sourceMoney: { minorUnits, currency: "USD" },
    usdComparison: {
      status: "available" as const,
      value: { minorUnits, currency: "USD" as const },
    },
    observedAt: pack.vendorEvObservedAt.toISOString(),
  };
}

function v3Product(
  input: DistributedClutchpacksSnapshotFacts,
  vendor: PublicVendor,
  pack: DistributedClutchpacksPackRow,
  detail: PublicRepackDetail,
): DataReleaseV3CanonicalProduct {
  return {
    platformKey: DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
    productKey: pack.packKey,
    publicRepackId: detail.publicRepackId,
    publicVendorId: vendor.publicVendorId,
    vendorKey: vendor.vendorKey,
    vendorDisplayName: vendor.displayName,
    vendorLogoUrl: vendor.logoUrl,
    name: detail.name,
    format: detail.format,
    contentMode: detail.contentMode,
    categories: detail.categories,
    collectibleTypes: detail.collectibleTypes,
    availability: detail.availability,
    soldOutAt: null,
    price: detail.price,
    buyback: detail.buyback.status === "available"
      ? {
          kind: "uniform_rate",
          rateBasisPoints: detail.buyback.value.basisPoints,
        }
      : { kind: "not_documented" },
    vendorReportedEv: vendorEvV3(pack),
    primaryImage: detail.primaryImage,
    topChase: detail.topChase,
    contentSummary: detail.contentSummary,
    actionAvailability: detail.actionAvailability,
    sourceUpdatedAt: detail.sourceUpdatedAt,
    description: detail.description,
    actions: detail.actions,
  };
}

export interface DistributedClutchpacksPublicationArtifacts {
  readonly configuration: ProviderCatalogReleaseConfigurationSnapshot;
  readonly approvedConfiguration: ApprovedPublicCatalogConfigurationV1;
  readonly projection: ProviderCatalogPublicProjection;
  readonly providerPlan: Awaited<ReturnType<typeof buildProviderCatalogReleasePublishPlan>>;
  readonly v3Plan: DataReleaseV3PublishPlan;
  readonly stabilityFingerprint: string;
}

export async function buildDistributedClutchpacksPublicationArtifacts(
  snapshot: DistributedClutchpacksStableSnapshot,
  promotionReadAt: string,
): Promise<DistributedClutchpacksPublicationArtifacts> {
  const facts = snapshot.facts;
  const readAtMillis = parsePackScoutBuybackEvTimestampMillisV1(promotionReadAt);
  if (
    readAtMillis === null ||
    readAtMillis < facts.catalogSettledAt.getTime()
  ) return refuse("CLUTCHPACKS_PROMOTION_CLOCK_INVALID");
  const vendor = publicVendor(facts);
  const packs = [...facts.packs].sort((left, right) =>
    left.packKey < right.packKey ? -1 : left.packKey > right.packKey ? 1 : 0);
  if (new Set(packs.map(({ packKey }) => packKey)).size !== packs.length) {
    return refuse("PUBLIC_REPACK_INVALID");
  }
  const evidence = validateClutchpacksContentCatalog({ providerId: facts.providerId, settledAt: facts.catalogSettledAt,
    packs, catalog: facts.contentCatalog });
  const contents = projectProvisionalProviderPackContentsV1({
    identityPolicy: "provider_provisional_v1", providerId: facts.providerId,
    platformKey: DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY, snapshotAt: facts.catalogSettledAt,
    publicAssetOrigins: facts.approvedPublicAssetOrigins,
    packs: packs.map((pack) => ({ id: pack.id, rowVersion: pack.rowVersion, packKey: pack.packKey,
      detail: publicRepack(facts, vendor, pack), evidenceCompleteness: evidence.get(pack.id) ?? "unknown" })),
    collectibles: facts.contentCatalog.collectibles, instances: facts.contentCatalog.instances,
    memberships: facts.contentCatalog.memberships,
  });
  const repacks = contents.repacks;
  const publicAssetOrigins = [...vendor.imageOrigins];
  const baseConfiguration = approvedPublicCatalogConfigurationV1Schema.parse({
    schemaVersion: "approved_public_catalog_v1",
    configurationKey: LOCAL_PUBLIC_CONFIGURATION_KEY,
    revision: LOCAL_PUBLIC_CONFIGURATION_REVISION,
    approvedAt: iso(facts.activeConfigCreatedAt),
    staleAfterSeconds: facts.staleAfterSeconds,
    confidencePolicy: LOCAL_CONFIDENCE_POLICY,
    publicAssetOrigins,
    verifiedUsdStablecoins: [],
    categories: [],
    platforms: [{
      platformKey: DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
      vendor,
      format: "repack",
      defaultPublicCategoryIds: [],
      categoryMappings: [],
      collectibleTypeMappings: [],
    }],
    repacks: packs.map((pack, index) => ({
      platformKey: DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
      packExternalId: pack.packKey,
      publicRepackId: repacks[index]!.publicRepackId,
    })),
    collectibles: contents.collectibleMappings,
  });
  const configurationHash = await sha256CanonicalJson(
    "packscout.local-distributed-public-configuration.v1",
    baseConfiguration,
  );
  if (!SHA256_PATTERN.test(configurationHash)) {
    return refuse("PUBLIC_CONFIGURATION_INVALID");
  }
  const configuration: ProviderCatalogReleaseConfigurationSnapshot = {
    schemaVersion: baseConfiguration.schemaVersion,
    configurationKey: baseConfiguration.configurationKey,
    revision: baseConfiguration.revision,
    approvedAt: baseConfiguration.approvedAt,
    staleAfterSeconds: baseConfiguration.staleAfterSeconds,
    confidencePolicy: baseConfiguration.confidencePolicy,
    publicAssetOrigins: baseConfiguration.publicAssetOrigins,
    verifiedUsdStablecoins: baseConfiguration.verifiedUsdStablecoins,
    categories: baseConfiguration.categories,
    platform: baseConfiguration.platforms[0]!,
    repacks: baseConfiguration.repacks,
    collectibles: baseConfiguration.collectibles,
    configurationHash,
    publicChangeSequence: LOCAL_PUBLIC_CONFIGURATION_SEQUENCE,
  };
  const checkpoint: ProviderCatalogReleaseSnapshotCheckpoint = {
    ...snapshot.checkpoint,
    sharedConfigurationEpoch: {
      ...snapshot.checkpoint.sharedConfigurationEpoch,
      configurationHash,
    },
  };
  const projection: ProviderCatalogPublicProjection = {
    vendors: [vendor],
    categories: [],
    collectibles: contents.collectibles,
    repacks,
    repackChases: contents.repackChases,
    dataAsOf: contents.dataAsOf,
  };
  const providerPlan = await buildProviderCatalogReleasePublishPlan({
    checkpoint,
    configuration,
    projection,
    lastSuccessfulObservationAt: new Date(facts.catalogSettledAt),
  });
  const v3Products = packs.map((pack, index) =>
    v3Product(facts, vendor, pack, repacks[index]!));
  const normalizedProducts = await Promise.all(packs
      .filter((pack) => pack.evInputEvidence !== undefined)
      .map(async (pack) => ({
        availability: pack.availability,
        platformKey: DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
        productKey: pack.packKey,
        evidence: await normalizeClutchpacksPromotionEvEvidenceV1({
          organizationId: facts.organizationId,
          providerId: facts.providerId,
          packId: pack.id,
          packKey: pack.packKey,
          rowVersion: pack.rowVersion.toString(),
          priceUsdMinor: money(pack).usdComparison.value.minorUnits,
          buybackRateBasisPoints: pack.buybackRate === null
            ? null
            : decimalTextToScaledInteger(pack.buybackRate, 4),
          sourceUpdatedAt: pack.sourceUpdatedAt.toISOString(),
          snapshotAt: facts.latestSourceHeadFinishedAt.toISOString(),
          readAt: promotionReadAt,
          evidence: pack.evInputEvidence,
        }),
      })));
  const eligibility = createPackScoutBuybackEvPromotionEligibilityV1({
    organizationId: facts.organizationId,
    readAt: promotionReadAt,
    // This provider database has no historical sellout clock or frozen
    // estimate. Validate retained facts above, but never invent that history
    // by presenting a new promotion calculation as a sold-out estimate.
    products: normalizedProducts.filter(({ availability }) => availability !== "sold_out"),
  });
  const v3 = await new DataReleaseV3ReleaseAssembler(
    {
      async loadCatalogSnapshot({ readAt }) {
        if (readAt !== promotionReadAt) {
          return refuse("CLUTCHPACKS_SNAPSHOT_CHANGED");
        }
        return {
          organizationId: facts.organizationId,
          products: v3Products,
          categories: [],
          collectibles: contents.collectibles,
          chases: contents.repackChases,
        };
      },
    },
    eligibility,
  ).assemble({ readAt: promotionReadAt });
  if (v3.classification !== "publish") {
    return refuse(`DATA_RELEASE_V3_${v3.reason}`);
  }
  return {
    configuration,
    approvedConfiguration: baseConfiguration,
    projection,
    providerPlan,
    v3Plan: v3,
    stabilityFingerprint: snapshot.stabilityFingerprint,
  };
}
