import {
  PROVIDER_RELEASE_BATCH_HASH_DOMAIN,
  PROVIDER_RELEASE_CONTENT_CHAIN_HASH_DOMAIN,
  PROVIDER_RELEASE_CONTENT_SEED_HASH_DOMAIN,
  PROVIDER_RELEASE_INDEX_HASH_DOMAIN,
  PROVIDER_RELEASE_MAX_BATCH_BYTES,
  PROVIDER_RELEASE_MAX_BATCHES,
  PROVIDER_RELEASE_MAX_BATCH_RECORDS,
  PROVIDER_RELEASE_PUBLIC_SCHEMA_VERSION,
  PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
  buildPublicCollectibleSearchText,
  canonicalJson,
  canonicalJsonBytes,
  containsProtectedProviderCatalogReleaseField,
  normalizePublicSearchText,
  packscoutPublicIdentityUuid,
  parsedHttpsUrl,
  providerReleaseCatalogPinHash,
  providerReleaseCorrelationSnapshotHash,
  publicCategorySchema,
  publicCollectibleSchema,
  publicRepackChaseSchema,
  publicRepackDetailSchema,
  publicVendorSchema,
  sha256CanonicalJson,
  type BuiltProviderRelease,
  type ProviderReleaseBatch,
  type ProviderReleaseBatchKind,
  type ProviderReleaseRecord,
  type ProviderReleaseRetiredRepack,
  type ProviderReleaseSearchRecord,
  type PublicCatalogCategory,
  type PublicCatalogCollectible,
  type PublicCategory,
  type PublicCollectible,
  type PublicRepackChase,
  type PublicRepackDetail,
} from "@packscout/contracts";
import type { PinnedProviderReleaseInputs } from "./provider-release-central-repository.ts";
import {
  ProviderReleaseValueError,
  decimalBasisPoints,
  publicBuyback,
  publicPackScoutEv,
  publicPrice,
  publicValuation,
  publicVendorEv,
} from "./provider-release-money.ts";
import { assertProviderReleaseIntegrity } from "./provider-release-integrity.ts";
import { CENTRAL_SCHEMA_VERSION, PROVIDER_SCHEMA_VERSION } from "./database-topology.ts";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const BATCH_KINDS: readonly ProviderReleaseBatchKind[] = [
  "provider", "category", "collectible", "repack", "chase", "retired-repack",
  "search-index",
];

export type ProviderReleaseValidationCode =
  | "PROVIDER_IDENTITY_MISMATCH"
  | "PROVIDER_CONFIG_MISMATCH"
  | "PROVIDER_SCHEMA_MISMATCH"
  | "PROVIDER_FRESHNESS_MISSING"
  | "PROVIDER_FRESHNESS_INVALID"
  | "CORRELATION_MISSING"
  | "CORRELATION_STALE"
  | "PUBLIC_REFERENCE_INVALID"
  | "PUBLIC_PROJECTION_INVALID"
  | "PUBLIC_BATCH_LIMIT_EXCEEDED";

export class ProviderReleaseValidationError extends Error {
  constructor(readonly code: ProviderReleaseValidationCode, message: string) {
    super(message);
    this.name = "ProviderReleaseValidationError";
  }
}

export interface ProviderReleaseCategorySnapshotRow {
  readonly id: string;
  readonly parentCategoryId: string | null;
  readonly categoryKey: string;
  readonly displayName: string;
  readonly lifecycle: "active" | "retired";
  readonly rowVersion: bigint;
}

export interface ProviderReleaseCollectibleSnapshotRow {
  readonly id: string;
  readonly collectibleType: PublicCollectible["collectibleType"];
  readonly lifecycle: "active" | "retired";
  readonly rowVersion: bigint;
}

export interface ProviderReleaseAliasSnapshotRow {
  readonly id: string;
  readonly collectibleId: string;
  readonly normalizedName: string;
  readonly lifecycle: "active" | "retired";
}

export interface ProviderReleasePackSnapshotRow {
  readonly id: string;
  readonly categoryId: string | null;
  readonly displayName: string;
  readonly description: string | null;
  readonly packFormat: "repack" | "gacha";
  readonly lifecycle: "active" | "retired";
  readonly availability: "available" | "sold_out" | "unavailable";
  readonly contentEvidence: "complete" | "partial" | "unknown";
  readonly priceAmount: string | null;
  readonly priceCurrency: string | null;
  readonly priceUsdAmount: string | null;
  readonly priceUnavailableReason: string | null;
  readonly buybackRate: string | null;
  readonly buybackSourceKind: string | null;
  readonly vendorEvAmount: string | null;
  readonly vendorEvCurrency: string | null;
  readonly vendorEvObservedAt: Date | null;
  readonly vendorEvUnavailableReason: string | null;
  readonly packscoutEvAmount: string | null;
  readonly packscoutEvCurrency: string | null;
  readonly packscoutEvModelVersion: string;
  readonly packscoutEvConfidencePolicyVersion: string;
  readonly packscoutEvConfidence: unknown;
  readonly packscoutEvDataAsOf: Date | null;
  readonly packscoutEvCalculatedAt: Date | null;
  readonly packscoutEvUnavailableReason: string | null;
  readonly primaryImageUrl: string | null;
  readonly primaryImageAlt: string | null;
  readonly listingUrl: string | null;
  readonly sourceUpdatedAt: Date;
  readonly retiredAt: Date | null;
  readonly updatedAt: Date;
}

export interface ProviderReleaseContentSnapshotRow {
  readonly id: string;
  readonly packId: string;
  readonly collectibleId: string;
  readonly collectibleInstanceId: string | null;
  readonly contentRole: "top_chase" | "featured_chase" | "possible_outcome" | "other";
  readonly probability: string | null;
  readonly evidenceKinds: readonly string[];
  readonly matchConfidenceBasisPoints: number;
  readonly matchConfidenceBand: "low" | "medium" | "high";
  readonly observedAt: Date;
  readonly displayOrder: number;
  readonly lifecycle: "active" | "retired";
}

export interface ProviderReleaseSnapshot {
  readonly providerId: string;
  readonly providerKey: string;
  readonly providerSchemaVersion: string;
  readonly throughChangeSequence: bigint;
  readonly categories: readonly ProviderReleaseCategorySnapshotRow[];
  readonly collectibles: readonly ProviderReleaseCollectibleSnapshotRow[];
  readonly aliases: readonly ProviderReleaseAliasSnapshotRow[];
  readonly packs: readonly ProviderReleasePackSnapshotRow[];
  readonly contents: readonly ProviderReleaseContentSnapshotRow[];
  readonly lastSuccessfulObservationAt: Date;
  readonly providerConfigVersionId: string | null;
  readonly providerConfigExpiresAt: Date | null;
  readonly scheduleSeconds: number | null;
  readonly freshnessState: string;
}

function invalid(code: ProviderReleaseValidationCode, message: string): never {
  throw new ProviderReleaseValidationError(code, message);
}

async function validatePinnedInputs(
  pin: PinnedProviderReleaseInputs,
  checkpoint?: () => void,
): Promise<void> {
  checkpoint?.();
  if (
    pin.centralSchemaVersion !== CENTRAL_SCHEMA_VERSION
    || pin.catalogSchemaVersion !== "catalog-v1"
  ) {
    invalid("PROVIDER_SCHEMA_MISMATCH", "A pinned central schema is incompatible.");
  }
  if (
    !UUID_PATTERN.test(pin.providerConfigVersionId)
    || (pin.providerConfigExpiresAt !== null
      && !Number.isFinite(pin.providerConfigExpiresAt.getTime()))
  ) {
    invalid("PROVIDER_CONFIG_MISMATCH", "The pinned provider configuration is invalid.");
  }
  const parsedProvider = publicVendorSchema.safeParse(pin.publicProvider);
  if (
    !parsedProvider.success
    || canonicalJson(parsedProvider.data) !== canonicalJson(pin.publicProvider)
    || parsedProvider.data.publicVendorId !== packscoutPublicIdentityUuid(
      `provider:${pin.providerId}`,
    )
    || parsedProvider.data.vendorKey !== pin.providerKey
    || await sha256CanonicalJson(
      PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
      parsedProvider.data,
    ) !== pin.publicProfileHash
  ) {
    invalid("PUBLIC_PROJECTION_INVALID", "The pinned public provider hash is invalid.");
  }
  const categoryIdentityCount = new Set(
    pin.categoryCorrelations.map(({ localCategoryId }) => {
      checkpoint?.();
      return localCategoryId;
    }),
  ).size;
  const collectibleIdentityCount = new Set(
    pin.collectibleCorrelations.map(({ localCollectibleId }) => {
      checkpoint?.();
      return localCollectibleId;
    }),
  ).size;
  if (
    categoryIdentityCount !== pin.categoryCorrelations.length
    || collectibleIdentityCount !== pin.collectibleCorrelations.length
  ) {
    invalid("PUBLIC_REFERENCE_INVALID", "Pinned correlations are not unique.");
  }
  const correlationHash = await providerReleaseCorrelationSnapshotHash({
    providerId: pin.providerId,
    correlationEventSequence: pin.correlationEventSequence.toString(),
    categories: pin.categoryCorrelations.map((row) => {
      checkpoint?.();
      return {
        ...row,
        localEntityVersion: row.localEntityVersion.toString(),
      };
    }),
    collectibles: pin.collectibleCorrelations.map((row) => {
      checkpoint?.();
      return {
        ...row,
        localEntityVersion: row.localEntityVersion.toString(),
      };
    }),
  });
  checkpoint?.();
  if (correlationHash !== pin.correlationSnapshotHash) {
    invalid("PUBLIC_REFERENCE_INVALID", "The pinned correlation hash is invalid.");
  }
  const catalogPinHash = await providerReleaseCatalogPinHash({
    catalogVersionId: pin.catalogVersionId,
    catalogSchemaVersion: pin.catalogSchemaVersion,
    catalogContentHash: pin.catalogContentHash,
    catalogThroughChangeSequence: pin.catalogThroughChangeSequence.toString(),
    categories: pin.catalogCategories,
    collectibles: pin.catalogCollectibles,
    aliases: pin.catalogAliases,
  });
  if (catalogPinHash !== pin.catalogArtifactVerificationHash) {
    invalid("PUBLIC_REFERENCE_INVALID", "The verified catalog pin hash is invalid.");
  }
  checkpoint?.();
  if (containsProtectedProviderCatalogReleaseField({
    provider: pin.publicProvider,
    categories: pin.catalogCategories,
    collectibles: pin.catalogCollectibles,
    aliases: pin.catalogAliases,
  })) {
    invalid("PUBLIC_PROJECTION_INVALID", "A pinned public artifact contains a protected field.");
  }
}

function requireUuid(value: string): string {
  if (!UUID_PATTERN.test(value)) invalid("PUBLIC_REFERENCE_INVALID", "A provider release ID is invalid.");
  return value.toLowerCase();
}

function mapCatalogCategory(row: PublicCatalogCategory): PublicCategory {
  if (row.lifecycle !== "active") {
    invalid("PUBLIC_REFERENCE_INVALID", "A pinned catalog category is not active.");
  }
  return publicCategorySchema.parse({
    publicCategoryId: row.publicCategoryId,
    parentPublicCategoryId: row.parentPublicCategoryId,
    categoryKey: row.categoryKey,
    name: row.displayName,
    kind: row.categoryKind,
    depth: row.depth,
    pathPublicCategoryIds: row.pathPublicCategoryIds,
    displayOrder: row.displayOrder,
  });
}

function mapCatalogCollectible(row: PublicCatalogCollectible): PublicCollectible {
  if (row.identityState !== "canonical" && row.identityState !== "provisional") {
    invalid("PUBLIC_REFERENCE_INVALID", "A pinned collectible identity is not public.");
  }
  if ((row.primaryImageUrl === null) !== (row.primaryImageAlt === null)) {
    invalid("PUBLIC_PROJECTION_INVALID", "A collectible image URL and alt text must be paired.");
  }
  const dataAsOf = new Date(row.dataAsOf);
  const valuationObservedAt = row.valuationObservedAt === null
    ? null
    : new Date(row.valuationObservedAt);
  if (
    !Number.isFinite(dataAsOf.getTime())
    || (valuationObservedAt !== null
      && (!Number.isFinite(valuationObservedAt.getTime())
        || valuationObservedAt.getTime() > dataAsOf.getTime()))
  ) {
    invalid("PUBLIC_PROJECTION_INVALID", "A collectible valuation has invalid public timing.");
  }
  const aliases = [...row.nameAliases].sort();
  const normalizedAliases = aliases.map(normalizePublicSearchText).sort();
  if (canonicalJson(normalizedAliases) !== canonicalJson([...row.normalizedNameAliases].sort())) {
    invalid("PUBLIC_PROJECTION_INVALID", "A collectible alias projection is inconsistent.");
  }
  const primaryImage = row.primaryImageUrl === null
    ? null
    : { url: row.primaryImageUrl, alt: row.primaryImageAlt };
  const value = {
    publicCollectibleId: row.publicCollectibleId,
    name: row.displayName,
    normalizedName: row.normalizedName,
    aliases,
    normalizedAliases,
    collectibleType: row.collectibleType,
    publicCategoryIds: [...row.publicCategoryIds].sort(),
    year: row.year,
    brand: row.brand,
    setOrSeries: row.setOrSeries,
    cardNumber: row.cardNumber,
    referenceNumber: row.referenceNumber,
    subject: row.subject,
    grade: row.grade,
    grader: row.grader,
    primaryImage,
    valuation: publicValuation(row),
    searchText: "",
    dataAsOf: dataAsOf.toISOString(),
  };
  value.searchText = buildPublicCollectibleSearchText(value);
  return publicCollectibleSchema.parse(value);
}

function includeCategoryPath(
  selected: Set<string>,
  category: PublicCategory,
): void {
  category.pathPublicCategoryIds.forEach((id) => selected.add(id));
}

function independentBranchCount(
  ids: readonly string[],
  categoryById: ReadonlyMap<string, PublicCategory>,
): number {
  return ids.filter((candidateId) => !ids.some((otherId) => (
    otherId !== candidateId
    && categoryById.get(otherId)?.pathPublicCategoryIds.includes(candidateId)
  ))).length;
}

function publicCollectibleDisplay(row: PublicCollectible) {
  return {
    publicCollectibleId: row.publicCollectibleId,
    name: row.name,
    collectibleType: row.collectibleType,
    publicCategoryIds: row.publicCategoryIds,
    primaryImage: row.primaryImage,
    valuation: row.valuation,
  };
}

function validateLocalAliases(
  snapshot: ProviderReleaseSnapshot,
  checkpoint?: () => void,
): void {
  const activeCollectibles = new Set(snapshot.collectibles
    .filter(({ lifecycle }) => {
      checkpoint?.();
      return lifecycle === "active";
    })
    .map(({ id }) => id));
  const identities = new Set<string>();
  for (const alias of snapshot.aliases.filter(({ lifecycle }) => {
    checkpoint?.();
    return lifecycle === "active";
  })) {
    checkpoint?.();
    if (!activeCollectibles.has(alias.collectibleId)) {
      invalid("PUBLIC_REFERENCE_INVALID", "An active local alias belongs to a retired collectible.");
    }
    const identity = `${alias.collectibleId}:${alias.normalizedName}`;
    if (identities.has(identity)) {
      invalid("PUBLIC_REFERENCE_INVALID", "Active local aliases are not unique.");
    }
    identities.add(identity);
  }
}

function chaseFor(input: {
  readonly content: ProviderReleaseContentSnapshotRow;
  readonly publicRepackId: string;
  readonly collectible: PublicCollectible;
}): PublicRepackChase | null {
  if (input.content.contentRole === "other") return null;
  return publicRepackChaseSchema.parse({
    publicRepackId: input.publicRepackId,
    publicCollectibleId: input.collectible.publicCollectibleId,
    role: input.content.contentRole,
    evidenceKinds: [...input.content.evidenceKinds].sort(),
    probabilityBasisPoints: input.content.probability === null
      ? null
      : decimalBasisPoints(input.content.probability),
    collectible: publicCollectibleDisplay(input.collectible),
    matchConfidence: {
      scoreBasisPoints: input.content.matchConfidenceBasisPoints,
      band: input.content.matchConfidenceBand,
    },
    observedAt: input.content.observedAt.toISOString(),
    displayOrder: input.content.displayOrder,
  });
}

function listingAction(
  pack: ProviderReleasePackSnapshotRow,
  pin: PinnedProviderReleaseInputs,
): PublicRepackDetail["actions"]["repackLink"] {
  if (pack.listingUrl === null || pack.availability !== "available") return undefined;
  const parsed = parsedHttpsUrl(pack.listingUrl);
  if (!parsed || !pin.publicProvider.listingHosts.includes(parsed.host)) {
    invalid("PUBLIC_PROJECTION_INVALID", "A repack listing URL is not approved by its profile.");
  }
  return {
    listingUrl: pack.listingUrl,
    listingHost: parsed.host,
    referralParameters: pin.publicProvider.referralParameters,
  };
}

function ensurePublicTiming(pack: ProviderReleasePackSnapshotRow, boundary: Date): void {
  for (const instant of [
    pack.sourceUpdatedAt,
    pack.vendorEvObservedAt,
    pack.packscoutEvDataAsOf,
    pack.packscoutEvCalculatedAt,
  ]) {
    if (
      instant !== null
      && (!Number.isFinite(instant.getTime()) || instant.getTime() > boundary.getTime())
    ) {
      invalid("PUBLIC_PROJECTION_INVALID", "A public observation is newer than the pinned provider boundary.");
    }
  }
  if ((pack.primaryImageUrl === null) !== (pack.primaryImageAlt === null)) {
    invalid("PUBLIC_PROJECTION_INVALID", "A repack image URL and alt text must be paired.");
  }
  if (pack.lifecycle === "retired") {
    if (
      pack.retiredAt === null
      || !Number.isFinite(pack.retiredAt.getTime())
      || pack.retiredAt.getTime() > boundary.getTime()
      || !Number.isFinite(pack.updatedAt.getTime())
      || pack.updatedAt.getTime() > boundary.getTime()
    ) {
      invalid("PUBLIC_PROJECTION_INVALID", "A retired repack has invalid retirement timing.");
    }
  } else if (pack.retiredAt !== null) {
    invalid("PUBLIC_PROJECTION_INVALID", "An active repack cannot have a retirement time.");
  }
  if (
    pack.availability === "unavailable"
    && (!Number.isFinite(pack.updatedAt.getTime()) || pack.updatedAt.getTime() > boundary.getTime())
  ) {
    invalid("PUBLIC_PROJECTION_INVALID", "An unavailable repack has invalid update timing.");
  }
}

interface ProjectedProviderContent {
  readonly categories: readonly PublicCategory[];
  readonly collectibles: readonly PublicCollectible[];
  readonly repacks: readonly PublicRepackDetail[];
  readonly chases: readonly PublicRepackChase[];
  readonly retiredRepacks: readonly ProviderReleaseRetiredRepack[];
  readonly searchIndex: readonly ProviderReleaseSearchRecord[];
  readonly collectibleReferenceCount: number;
}

function projectProviderContent(
  snapshot: ProviderReleaseSnapshot,
  pin: PinnedProviderReleaseInputs,
  checkpoint?: () => void,
): ProjectedProviderContent {
  validateLocalAliases(snapshot, checkpoint);
  const localCategories = new Map(snapshot.categories.map((row) => {
    checkpoint?.();
    return [requireUuid(row.id), row] as const;
  }));
  const localCollectibles = new Map(snapshot.collectibles.map((row) => {
    checkpoint?.();
    return [requireUuid(row.id), row] as const;
  }));
  const categoryCorrelations = new Map(pin.categoryCorrelations.map((row) => {
    checkpoint?.();
    return [row.localCategoryId, row] as const;
  }));
  const collectibleCorrelations = new Map(
    pin.collectibleCorrelations.map((row) => {
      checkpoint?.();
      return [row.localCollectibleId, row] as const;
    }),
  );
  const allCategories = pin.catalogCategories.map((row) => {
    checkpoint?.();
    return mapCatalogCategory(row);
  });
  const categoryById = new Map(allCategories.map((row) => {
    checkpoint?.();
    return [row.publicCategoryId, row] as const;
  }));
  const catalogCollectibles = pin.catalogCollectibles.map((row) => {
    checkpoint?.();
    return mapCatalogCollectible(row);
  });
  const collectibleById = new Map(catalogCollectibles.map((row) => {
    checkpoint?.();
    return [row.publicCollectibleId, row] as const;
  }));
  const contentsByPack = new Map<string, ProviderReleaseContentSnapshotRow[]>();
  const packIds = new Set(snapshot.packs.map(({ id }) => {
    checkpoint?.();
    return id;
  }));
  for (const content of snapshot.contents) {
    checkpoint?.();
    if (
      !Number.isFinite(content.observedAt.getTime())
      || content.observedAt.getTime() > snapshot.lastSuccessfulObservationAt.getTime()
    ) {
      invalid("PUBLIC_PROJECTION_INVALID", "A pack-content observation is newer than the pinned provider boundary.");
    }
    if (!packIds.has(content.packId)) {
      invalid("PUBLIC_REFERENCE_INVALID", "Pack content references an unknown repack.");
    }
    if (content.lifecycle !== "active") continue;
    const values = contentsByPack.get(content.packId) ?? [];
    values.push(content);
    contentsByPack.set(content.packId, values);
  }
  const selectedCategoryIds = new Set<string>();
  const referencedCollectibleIds = new Set<string>();
  const repacks: PublicRepackDetail[] = [];
  const chases: PublicRepackChase[] = [];
  const retiredRepacks: ProviderReleaseRetiredRepack[] = [];
  for (const pack of [...snapshot.packs].sort((left, right) => left.id.localeCompare(right.id))) {
    checkpoint?.();
    ensurePublicTiming(pack, snapshot.lastSuccessfulObservationAt);
    const publicRepackId = packscoutPublicIdentityUuid(
      `provider:${pin.providerId}:pack:${requireUuid(pack.id)}`,
    );
    if (pack.lifecycle === "retired" || pack.availability === "unavailable") {
      retiredRepacks.push({
        publicRepackId,
        lifecycle: "retired",
        unavailableReason: pack.lifecycle === "retired" ? "REPACK_RETIRED" : "PROVIDER_UNAVAILABLE",
        retiredAt: (pack.lifecycle === "retired" ? pack.retiredAt! : pack.updatedAt).toISOString(),
      });
      continue;
    }
    const selectedForPack = new Set<string>();
    if (pack.categoryId !== null) {
      const category = localCategories.get(pack.categoryId);
      const correlation = categoryCorrelations.get(pack.categoryId);
      if (!category || category.lifecycle !== "active" || !correlation) {
        invalid("CORRELATION_MISSING", "A public repack category is unresolved.");
      }
      if (category.rowVersion !== correlation.localEntityVersion) {
        invalid("CORRELATION_STALE", "A public repack category correlation is stale.");
      }
      const publicCategory = categoryById.get(correlation.publicCategoryId);
      if (!publicCategory) invalid("PUBLIC_REFERENCE_INVALID", "A correlated category is absent from the catalog version.");
      includeCategoryPath(selectedForPack, publicCategory);
    }
    const packContents = [...(contentsByPack.get(pack.id) ?? [])].sort((left, right) => (
      left.displayOrder - right.displayOrder || left.id.localeCompare(right.id)
    ));
    const publicContents: Array<{
      content: ProviderReleaseContentSnapshotRow;
      collectible: PublicCollectible;
    }> = [];
    const publicContentIds = new Set<string>();
    for (const content of packContents) {
      checkpoint?.();
      const local = localCollectibles.get(content.collectibleId);
      const correlation = collectibleCorrelations.get(content.collectibleId);
      if (!local || local.lifecycle !== "active" || !correlation) {
        invalid("CORRELATION_MISSING", "A public pack content collectible is unresolved.");
      }
      if (local.rowVersion !== correlation.localEntityVersion) {
        invalid("CORRELATION_STALE", "A public collectible correlation is stale.");
      }
      const collectible = collectibleById.get(correlation.publicCollectibleId);
      if (!collectible || collectible.collectibleType !== local.collectibleType) {
        invalid("PUBLIC_REFERENCE_INVALID", "A correlated collectible is incompatible with the catalog version.");
      }
      if (publicContentIds.has(collectible.publicCollectibleId)) {
        invalid("PUBLIC_REFERENCE_INVALID", "Exact instances collapse to a duplicate public collectible relation.");
      }
      publicContentIds.add(collectible.publicCollectibleId);
      referencedCollectibleIds.add(collectible.publicCollectibleId);
      collectible.publicCategoryIds.forEach((categoryId) => {
        const category = categoryById.get(categoryId);
        if (!category) invalid("PUBLIC_REFERENCE_INVALID", "A collectible category is absent from the catalog version.");
        includeCategoryPath(selectedForPack, category);
      });
      publicContents.push({ content, collectible });
    }
    const packChases = publicContents
      .map(({ content, collectible }) => chaseFor({ content, publicRepackId, collectible }))
      .filter((value): value is PublicRepackChase => value !== null);
    const publicCategoryIds = [...selectedForPack].sort();
    const categories = publicCategoryIds.map((id) => {
      const category = categoryById.get(id)!;
      selectedCategoryIds.add(id);
      return { publicCategoryId: id, label: category.name };
    });
    const collectibleTypes = [...new Set(publicContents.map(({ collectible }) => collectible.collectibleType))].sort();
    const probabilityValues = publicContents
      .map(({ content }) => content.probability)
      .filter((value): value is string => value !== null)
      .map(decimalBasisPoints);
    const probabilityCoverageBasisPoints = probabilityValues.length === 0
      ? null
      : probabilityValues.reduce((sum, value) => sum + value, 0);
    if (probabilityCoverageBasisPoints !== null && probabilityCoverageBasisPoints > 10_000) {
      invalid("PUBLIC_PROJECTION_INVALID", "Pack content probability coverage exceeds 100 percent.");
    }
    const price = publicPrice({
      amount: pack.priceAmount,
      currency: pack.priceCurrency,
      usdAmount: pack.priceUsdAmount,
      unavailableReason: pack.priceUnavailableReason,
    });
    const priceUsdMinor = price.usdComparison.status === "available"
      ? price.usdComparison.value.minorUnits
      : null;
    const repackLink = listingAction(pack, pin);
    if (pack.primaryImageUrl !== null) {
      const origin = parsedHttpsUrl(pack.primaryImageUrl)?.origin;
      if (!origin || !pin.publicProvider.imageOrigins.includes(origin)) {
        invalid("PUBLIC_PROJECTION_INVALID", "A repack image origin is not approved by its profile.");
      }
    }
    const detail = publicRepackDetailSchema.parse({
      publicRepackId,
      publicVendorId: pin.publicProvider.publicVendorId,
      vendorKey: pin.publicProvider.vendorKey,
      vendorDisplayName: pin.publicProvider.displayName,
      vendorLogoUrl: pin.publicProvider.logoUrl,
      name: pack.displayName,
      format: pack.packFormat,
      contentMode: independentBranchCount(publicCategoryIds, categoryById) > 1 || collectibleTypes.length > 1
        ? "mixed"
        : publicCategoryIds.length > 0 || collectibleTypes.length > 0 ? "focused" : "unknown",
      categories,
      collectibleTypes,
      availability: pack.availability,
      price,
      buyback: publicBuyback({ rate: pack.buybackRate, sourceKind: pack.buybackSourceKind }),
      primaryImage: pack.primaryImageUrl === null
        ? null
        : { url: pack.primaryImageUrl, alt: pack.primaryImageAlt },
      evEstimates: {
        vendorReported: publicVendorEv({
          amount: pack.vendorEvAmount,
          currency: pack.vendorEvCurrency,
          observedAt: pack.vendorEvObservedAt,
          unavailableReason: pack.vendorEvUnavailableReason,
          priceUsdMinor,
        }),
        packScout: publicPackScoutEv({
          amount: pack.packscoutEvAmount,
          currency: pack.packscoutEvCurrency,
          modelVersion: pack.packscoutEvModelVersion,
          confidencePolicyVersion: pack.packscoutEvConfidencePolicyVersion,
          confidence: pack.packscoutEvConfidence,
          dataAsOf: pack.packscoutEvDataAsOf,
          calculatedAt: pack.packscoutEvCalculatedAt,
          unavailableReason: pack.packscoutEvUnavailableReason,
          priceUsdMinor,
        }),
      },
      topChase: packChases.find(({ role }) => role === "top_chase") ?? null,
      contentSummary: {
        knownCollectibleCount: publicContentIds.size,
        chaseCount: packChases.length,
        categoryCount: categories.length,
        collectibleTypeCount: collectibleTypes.length,
        evidenceCompleteness: pack.contentEvidence,
        probabilityCoverageBasisPoints,
      },
      actionAvailability: {
        promo: pin.publicProvider.publicPromo !== null,
        repackLink: repackLink !== undefined,
      },
      sourceUpdatedAt: pack.sourceUpdatedAt.toISOString(),
      description: pack.description,
      actions: {
        ...(pin.publicProvider.publicPromo === null ? {} : { promo: pin.publicProvider.publicPromo }),
        ...(repackLink === undefined ? {} : { repackLink }),
      },
    });
    repacks.push(detail);
    chases.push(...packChases);
  }
  repacks.sort((left, right) => left.publicRepackId.localeCompare(right.publicRepackId));
  chases.sort((left, right) => (
    left.publicRepackId.localeCompare(right.publicRepackId)
    || left.displayOrder - right.displayOrder
    || left.publicCollectibleId.localeCompare(right.publicCollectibleId)
  ));
  retiredRepacks.sort((left, right) => left.publicRepackId.localeCompare(right.publicRepackId));
  const categories = allCategories.filter(({ publicCategoryId }) => {
    checkpoint?.();
    return selectedCategoryIds.has(publicCategoryId);
  });
  const collectibles = catalogCollectibles
    .filter(({ publicCollectibleId }) => {
      checkpoint?.();
      return referencedCollectibleIds.has(publicCollectibleId);
    })
    .sort((left, right) => left.publicCollectibleId.localeCompare(right.publicCollectibleId));
  const searchIndex = repacks.map((repack): ProviderReleaseSearchRecord => {
    checkpoint?.();
    return {
      publicRepackId: repack.publicRepackId,
      publicVendorId: repack.publicVendorId,
      vendorKey: repack.vendorKey,
      normalizedName: normalizePublicSearchText(repack.name),
      publicCategoryIds: repack.categories.map(
        ({ publicCategoryId }) => publicCategoryId,
      ),
      collectibleTypes: repack.collectibleTypes,
      availability: repack.availability,
      priceUsdMinor: repack.price.usdComparison.status === "available"
        ? repack.price.usdComparison.value.minorUnits
        : null,
      packScoutEvPercentBasisPoints:
        repack.evEstimates.packScout.status === "available"
          ? repack.evEstimates.packScout.metrics.evPercentBasisPoints
          : null,
      topChaseUsdMinor:
        repack.topChase?.collectible.valuation?.usdComparison.status ===
            "available"
          ? repack.topChase.collectible.valuation.usdComparison.value.minorUnits
          : null,
    };
  });
  return {
    categories,
    collectibles,
    repacks,
    chases,
    retiredRepacks,
    searchIndex,
    collectibleReferenceCount: collectibles.length,
  };
}

async function buildBatches(
  valuesByKind: ReadonlyMap<ProviderReleaseBatchKind, readonly ProviderReleaseRecord[]>,
  checkpoint?: () => void,
): Promise<readonly ProviderReleaseBatch[]> {
  const batches: Omit<ProviderReleaseBatch, "batchOrdinal">[] = [];
  for (const batchKind of BATCH_KINDS) {
    checkpoint?.();
    const values = valuesByKind.get(batchKind) ?? [];
    let current: ProviderReleaseRecord[] = [];
    const flush = async () => {
      checkpoint?.();
      const batchIndex = batches.filter((batch) => batch.batchKind === batchKind).length;
      const body = { batchKind, batchIndex, records: current };
      const byteCount = canonicalJsonBytes(body).byteLength;
      if (byteCount > PROVIDER_RELEASE_MAX_BATCH_BYTES) {
        invalid("PUBLIC_BATCH_LIMIT_EXCEEDED", "A provider release record exceeds its batch byte bound.");
      }
      batches.push({
        batchKind,
        batchIndex,
        records: current,
        recordCount: current.length,
        byteCount,
        bodyHash: await sha256CanonicalJson(PROVIDER_RELEASE_BATCH_HASH_DOMAIN, body),
      });
      checkpoint?.();
      current = [];
    };
    for (const record of values) {
      checkpoint?.();
      const candidate = [...current, record];
      const byteCount = canonicalJsonBytes({
        batchKind,
        batchIndex: batches.filter((batch) => batch.batchKind === batchKind).length,
        records: candidate,
      }).byteLength;
      if (current.length > 0 && (
        candidate.length > PROVIDER_RELEASE_MAX_BATCH_RECORDS
        || byteCount > PROVIDER_RELEASE_MAX_BATCH_BYTES
      )) await flush();
      current.push(record);
      if (current.length > PROVIDER_RELEASE_MAX_BATCH_RECORDS) {
        invalid("PUBLIC_BATCH_LIMIT_EXCEEDED", "A provider release record exceeds its batch count bound.");
      }
    }
    await flush();
  }
  if (batches.length > PROVIDER_RELEASE_MAX_BATCHES) {
    invalid("PUBLIC_BATCH_LIMIT_EXCEEDED", "A provider release has too many batches.");
  }
  return batches.map((batch, batchOrdinal) => ({ ...batch, batchOrdinal }));
}

export async function buildProviderRelease(input: {
  readonly snapshot: ProviderReleaseSnapshot;
  readonly pin: PinnedProviderReleaseInputs;
  readonly predecessorCompleteReleaseId: string | null;
  /** Cooperative absolute-deadline/cancellation check owned by the caller. */
  readonly checkpoint?: () => void;
}): Promise<BuiltProviderRelease> {
  const { snapshot, pin } = input;
  input.checkpoint?.();
  const predecessorCompleteReleaseId = input.predecessorCompleteReleaseId === null
    ? null
    : requireUuid(input.predecessorCompleteReleaseId);
  await validatePinnedInputs(pin, input.checkpoint);
  input.checkpoint?.();
  if (snapshot.providerId !== pin.providerId || snapshot.providerKey !== pin.providerKey) {
    invalid("PROVIDER_IDENTITY_MISMATCH", "The provider snapshot does not match its central pin.");
  }
  if (snapshot.providerSchemaVersion !== PROVIDER_SCHEMA_VERSION) {
    invalid("PROVIDER_SCHEMA_MISMATCH", "The provider snapshot schema is incompatible.");
  }
  if (!Number.isFinite(snapshot.lastSuccessfulObservationAt.getTime())) {
    invalid("PROVIDER_FRESHNESS_MISSING", "The provider has no successful observation boundary.");
  }
  if (
    snapshot.providerConfigVersionId !== pin.providerConfigVersionId
    || snapshot.providerConfigExpiresAt?.getTime() !== pin.providerConfigExpiresAt?.getTime()
    || (pin.providerConfigExpiresAt !== null
      && pin.providerConfigExpiresAt.getTime() <= snapshot.lastSuccessfulObservationAt.getTime())
  ) {
    invalid("PROVIDER_CONFIG_MISMATCH", "The provider runtime configuration does not match its central pin.");
  }
  if (snapshot.freshnessState !== "fresh" && snapshot.freshnessState !== "stale") {
    invalid("PROVIDER_FRESHNESS_INVALID", "The provider freshness state is invalid.");
  }
  let projection: ProjectedProviderContent;
  try {
    projection = projectProviderContent(snapshot, pin, input.checkpoint);
  } catch (error) {
    if (error instanceof ProviderReleaseValidationError) throw error;
    if (error instanceof ProviderReleaseValueError) {
      invalid("PUBLIC_PROJECTION_INVALID", error.message);
    }
    throw error;
  }
  if (
    !Number.isInteger(pin.staleAfterSeconds)
    || pin.staleAfterSeconds < 1
    || pin.staleAfterSeconds > 604_800
  ) {
    invalid("PROVIDER_FRESHNESS_INVALID", "The provider stale threshold is invalid.");
  }
  const staleAt = new Date(
    snapshot.lastSuccessfulObservationAt.getTime() + pin.staleAfterSeconds * 1_000,
  );
  if (!Number.isFinite(staleAt.getTime())) {
    invalid("PROVIDER_FRESHNESS_INVALID", "The provider stale deadline is invalid.");
  }
  const indexHash = await sha256CanonicalJson(
    PROVIDER_RELEASE_INDEX_HASH_DOMAIN,
    projection.searchIndex,
  );
  input.checkpoint?.();
  const valuesByKind = new Map<ProviderReleaseBatchKind, readonly ProviderReleaseRecord[]>([
    ["provider", [pin.publicProvider]],
    ["category", projection.categories],
    ["collectible", projection.collectibles],
    ["repack", projection.repacks],
    ["chase", projection.chases],
    ["retired-repack", projection.retiredRepacks],
    ["search-index", projection.searchIndex],
  ]);
  const batches = await buildBatches(valuesByKind, input.checkpoint);
  input.checkpoint?.();
  const freshness = snapshot.freshnessState === "fresh" ? "fresh" as const : "delayed" as const;
  const descriptorSeed = {
    predecessorCompleteReleaseId,
    providerId: pin.providerId,
    providerKey: pin.providerKey,
    publicProviderId: pin.publicProvider.publicVendorId,
    throughChangeSequence: snapshot.throughChangeSequence.toString(),
    catalogVersionId: pin.catalogVersionId,
    catalogContentHash: pin.catalogContentHash,
    centralSchemaVersion: pin.centralSchemaVersion,
    correlationEventSequence: pin.correlationEventSequence.toString(),
    correlationSnapshotHash: pin.correlationSnapshotHash,
    publicProfileVersionId: pin.publicProfileVersionId,
    publicProfileHash: pin.publicProfileHash,
    providerSchemaVersion: snapshot.providerSchemaVersion,
    publicSchemaVersion: PROVIDER_RELEASE_PUBLIC_SCHEMA_VERSION,
    categoryCount: projection.categories.length,
    repackCount: projection.repacks.length,
    collectibleReferenceCount: projection.collectibleReferenceCount,
    chaseCount: projection.chases.length,
    retiredRepackCount: projection.retiredRepacks.length,
    batchCount: batches.length,
    indexHash,
    dataAsOf: snapshot.lastSuccessfulObservationAt.toISOString(),
    lastSuccessfulObservationAt: snapshot.lastSuccessfulObservationAt.toISOString(),
    staleAt: staleAt.toISOString(),
    freshness,
  };
  let contentHash = await sha256CanonicalJson(
    PROVIDER_RELEASE_CONTENT_SEED_HASH_DOMAIN,
    descriptorSeed,
  );
  for (const batch of batches) {
    input.checkpoint?.();
    contentHash = await sha256CanonicalJson(
      PROVIDER_RELEASE_CONTENT_CHAIN_HASH_DOMAIN,
      {
        previousHash: contentHash,
        batchOrdinal: batch.batchOrdinal,
        batchKind: batch.batchKind,
        batchIndex: batch.batchIndex,
        recordCount: batch.recordCount,
        byteCount: batch.byteCount,
        bodyHash: batch.bodyHash,
      },
    );
  }
  const providerReleaseId = packscoutPublicIdentityUuid(
    `provider-release:${pin.providerId}:${contentHash}:${indexHash}`,
  );
  const descriptor = {
    providerReleaseId,
    ...descriptorSeed,
    contentHash,
  };
  if (containsProtectedProviderCatalogReleaseField(batches)) {
    invalid("PUBLIC_PROJECTION_INVALID", "A protected provider field reached the public release plan.");
  }
  input.checkpoint?.();
  const publicEquivalenceHash = await assertProviderReleaseIntegrity({
    descriptor,
    batches,
    checkpoint: input.checkpoint,
  });
  input.checkpoint?.();
  return {
    descriptor,
    publicEquivalenceHash,
    provider: pin.publicProvider,
    categories: projection.categories,
    collectibles: projection.collectibles,
    repacks: projection.repacks,
    chases: projection.chases,
    retiredRepacks: projection.retiredRepacks,
    searchIndex: projection.searchIndex,
    batches,
  };
}
