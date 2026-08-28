import {
  approvedPublicCatalogConfigurationV1Schema,
  buildPublicCollectibleSearchText,
  containsProtectedPublicationField,
  normalizePublicSearchText,
  parsedHttpsUrl,
  publicPackAvailabilitySchema,
  type ApprovedPublicCatalogConfigurationV1,
  type PublicBuybackSummaryV3,
  type PublicCategory,
  type PublicCollectible,
  type PublicRepackChase,
  type VendorReportedEvV3,
} from "@packscout/contracts";
import type {
  CanonicalAvailability,
  CanonicalCatalogAssetProjectionContent,
  CanonicalEvInputProjectionContent,
  CanonicalPackProjectionContent,
} from "./catalog-projection-contracts.ts";
import { normalizeLegacyAvailability } from "./catalog-release-public-projection.ts";
import { configuredPublicRepackLink } from "./public-repack-link.ts";
import type {
  CatalogCanonicalRevisionSnapshot,
  CatalogProviderReadinessSnapshot,
  CatalogReleaseSourceSnapshot,
  GovernedPublicRepackIdentity,
} from "./catalog-release-types.ts";
import type {
  DataReleaseV3CanonicalCatalogPort,
  DataReleaseV3CanonicalProduct,
  DataReleaseV3CanonicalSnapshot,
} from "./buyback-adjusted-ev-release-types.ts";

/**
 * Canonical catalog adapter for the data_release_v3 publication
 * (task buyback-adjusted-ev/008).
 *
 * Implements `DataReleaseV3CanonicalCatalogPort` over one repeatable
 * readAt-keyed raw source snapshot (`PrismaDataReleaseV3CanonicalCatalogSource`
 * in `@packscout/database` satisfies `DataReleaseV3CanonicalSourcePort`
 * structurally). The projection mirrors the governed v2 catalog projection
 * for identity, categories, collectibles, chases, prices, images, actions,
 * and content summaries, and adds the v3-only fields: the structured buyback
 * summary, the independent vendor-reported EV, and the sold-out freeze
 * timestamp. PackScout EV is deliberately absent — the release assembler
 * composes it from the task-006 eligibility port at the same read clock.
 *
 * The projection is a pure function of the source snapshot, so a repeatable
 * source read makes `loadCatalogSnapshot` repeatable byte for byte. Every
 * incoherent input fails closed with a typed refusal instead of degrading.
 */

export type DataReleaseV3CanonicalCatalogRefusalCode =
  | "CANONICAL_CONFIGURATION_UNAPPROVED"
  | "CANONICAL_CONFIGURATION_INVALID"
  | "CANONICAL_PROVIDER_NOT_READY"
  | "CANONICAL_PROJECTION_INVALID"
  | "PUBLIC_IDENTITY_MAPPING_MISSING"
  | "PROTECTED_PUBLICATION_FIELD";

export class DataReleaseV3CanonicalCatalogError extends Error {
  constructor(
    readonly code: DataReleaseV3CanonicalCatalogRefusalCode,
    readonly productKey: string | null = null,
  ) {
    super("The data_release_v3 canonical catalog read was refused.");
    this.name = "DataReleaseV3CanonicalCatalogError";
  }
}

export interface DataReleaseV3SoldOutTransitionSnapshot {
  readonly platformKey: string;
  readonly packExternalId: string;
  readonly soldOutAt: Date;
}

export interface DataReleaseV3AssetPackAssociationSnapshot {
  readonly sourceEntityId: string;
  readonly platformKey: string;
  readonly assetExternalId: string;
  readonly packExternalId: string;
  readonly associatedAt: Date;
  readonly publicChangeSequence: bigint;
}

export interface DataReleaseV3CanonicalSourceSnapshot {
  readonly organizationId: string;
  readonly readAt: Date;
  readonly throughSequence: bigint;
  readonly configuration: CatalogReleaseSourceSnapshot["configuration"];
  readonly revisions: readonly CatalogCanonicalRevisionSnapshot[];
  readonly providers: readonly CatalogProviderReadinessSnapshot[];
  readonly repackIdentities: readonly GovernedPublicRepackIdentity[];
  readonly assetPackAssociations:
    readonly DataReleaseV3AssetPackAssociationSnapshot[];
  readonly soldOutTransitions: readonly DataReleaseV3SoldOutTransitionSnapshot[];
}

/**
 * One repeatable raw canonical read keyed only by the release read clock.
 * `PrismaDataReleaseV3CanonicalCatalogSource` in `@packscout/database`
 * implements this port.
 */
export interface DataReleaseV3CanonicalSourcePort {
  loadSourceSnapshot(input: {
    readonly readAt: string;
  }): Promise<DataReleaseV3CanonicalSourceSnapshot>;
}

function refuse(
  code: DataReleaseV3CanonicalCatalogRefusalCode,
  productKey: string | null = null,
): never {
  throw new DataReleaseV3CanonicalCatalogError(code, productKey);
}

const key = (platformKey: string, externalId: string) =>
  `${platformKey}\u0000${externalId}`;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Canonical revisions persisted before the pack-availability rename still hold
 * the retired `active`/`disabled` vocabulary, so every read translates them
 * onto the four-state union before any branch inspects the value.
 *
 * Both halves of the translation are shared rather than restated here: the
 * legacy rename is `normalizeLegacyAvailability` from the governed v2 catalog
 * projection in this package (itself the mirror of
 * `normalizeLegacyPackAvailability` in `convex/publicRepackValidation.ts`), and
 * the accepted vocabulary is the published `publicPackAvailabilitySchema` enum.
 * A value outside both vocabularies stays `undefined` and fails closed at the
 * call site.
 */
function storedAvailability(value: unknown): CanonicalAvailability | undefined {
  const parsed = publicPackAvailabilitySchema.safeParse(
    normalizeLegacyAvailability(value),
  );
  return parsed.success ? parsed.data : undefined;
}

type DataReleaseV3CanonicalPackProjectionContent =
  CanonicalPackProjectionContent & Readonly<{
    evInputStatus: "ready" | "unavailable";
  }>;

function packContent(
  value: unknown,
): DataReleaseV3CanonicalPackProjectionContent {
  if (!isObject(value) || value.schemaVersion !== "catalog-projection-v1" ||
      value.entityType !== "pack" || typeof value.name !== "string" ||
      (value.evInputStatus !== "ready" &&
        value.evInputStatus !== "unavailable")) {
    refuse("CANONICAL_PROJECTION_INVALID");
  }
  const availability = storedAvailability(value.availability);
  if (availability === undefined) {
    refuse("CANONICAL_PROJECTION_INVALID");
  }
  return {
    ...(value as unknown as DataReleaseV3CanonicalPackProjectionContent),
    availability,
  };
}

function assetContent(value: unknown): CanonicalCatalogAssetProjectionContent {
  if (!isObject(value) || value.schemaVersion !== "catalog-projection-v1" ||
      value.entityType !== "catalog_asset") {
    refuse("CANONICAL_PROJECTION_INVALID");
  }
  return {
    ...(value as unknown as CanonicalCatalogAssetProjectionContent),
    // Assets have never been availability-validated here; an absent or
    // unrecognized value stays `unknown` rather than being assumed available.
    availability: storedAvailability(value.availability) ?? "unknown",
  };
}

function publicCollectibleName(
  content: CanonicalCatalogAssetProjectionContent,
): string | null {
  if (typeof content.name !== "string") return null;
  const name = content.name.trim();
  return name.length > 0 && name.length <= 240 ? name : null;
}

function evInputContent(value: unknown): CanonicalEvInputProjectionContent {
  if (!isObject(value) || value.schemaVersion !== "catalog-projection-v1" ||
      value.entityType !== "ev_input") {
    refuse("CANONICAL_PROJECTION_INVALID");
  }
  return value as unknown as CanonicalEvInputProjectionContent;
}

function safeMinor(value: number | null): number | null {
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function iso(date: Date, productKey: string | null = null): string {
  if (!Number.isFinite(date.getTime())) {
    refuse("CANONICAL_PROJECTION_INVALID", productKey);
  }
  return date.toISOString();
}

function approvedImage(
  urls: readonly string[],
  origins: ReadonlySet<string>,
  alt: string,
) {
  const url = urls.find((candidate) => {
    const parsed = parsedHttpsUrl(candidate);
    return parsed !== null && origins.has(parsed.origin);
  });
  return url === undefined ? null : { url, alt };
}

function publicPrice(
  content: CanonicalPackProjectionContent,
): DataReleaseV3CanonicalProduct["price"] {
  const minor = safeMinor(content.priceValueMinor);
  const currency = typeof content.priceCurrency === "string" &&
      /^[A-Z]{3}$/.test(content.priceCurrency)
    ? content.priceCurrency
    : null;
  const displayMoney = minor === null || currency === null
    ? null : { minorUnits: minor, currency };
  return {
    displayMoney,
    usdComparison: minor !== null && currency === "USD"
      ? { status: "available" as const, value: { minorUnits: minor, currency: "USD" as const } }
      : {
          status: "unavailable" as const,
          value: null,
          reason: minor === null ? "PRICE_UNAVAILABLE" as const : "CURRENCY_UNSUPPORTED" as const,
        },
  };
}

/**
 * The canonical pack projection documents at most one uniform vendor buyback
 * rate. A valid rate publishes as `uniform_rate`, an undocumented rate as
 * `not_documented`, and a documented-but-unusable rate fails safe to
 * `unavailable` rather than inventing a number.
 */
function buybackSummary(
  content: CanonicalPackProjectionContent,
): PublicBuybackSummaryV3 {
  if (content.buybackPercent === null) return { kind: "not_documented" };
  const rateBasisPoints = Math.round(content.buybackPercent * 100);
  if (
    !Number.isSafeInteger(rateBasisPoints) ||
    rateBasisPoints < 0 ||
    rateBasisPoints > 10_000
  ) {
    return { kind: "unavailable" };
  }
  return { kind: "uniform_rate", rateBasisPoints };
}

function vendorReportedEv(
  content: CanonicalPackProjectionContent,
  sourceUpdatedAt: Date,
  productKey: string,
): VendorReportedEvV3 {
  const gross = safeMinor(content.providerReportedEvValueMinor);
  const currency = typeof content.providerReportedEvCurrency === "string" &&
      /^[A-Z0-9]{2,12}$/.test(content.providerReportedEvCurrency)
    ? content.providerReportedEvCurrency
    : null;
  if (gross === null || currency === null) {
    return {
      status: "unavailable",
      sourceMoney: null,
      usdComparison: null,
      observedAt: gross === null ? null : iso(sourceUpdatedAt, productKey),
      reason: "NOT_REPORTED",
    };
  }
  return {
    status: "available",
    sourceMoney: { minorUnits: gross, currency },
    usdComparison: currency === "USD"
      ? {
          status: "available",
          value: { minorUnits: gross, currency: "USD" },
        }
      : { status: "unavailable", value: null, reason: "CURRENCY_UNSUPPORTED" },
    observedAt: iso(sourceUpdatedAt, productKey),
  };
}

function collectibleDisplay(value: PublicCollectible) {
  return {
    publicCollectibleId: value.publicCollectibleId,
    name: value.name,
    collectibleType: value.collectibleType,
    publicCategoryIds: value.publicCategoryIds,
    primaryImage: value.primaryImage,
    valuation: value.valuation,
  };
}

export class DataReleaseV3CanonicalCatalogAdapter
  implements DataReleaseV3CanonicalCatalogPort
{
  constructor(private readonly source: DataReleaseV3CanonicalSourcePort) {}

  async loadCatalogSnapshot(input: {
    readonly readAt: string;
  }): Promise<DataReleaseV3CanonicalSnapshot> {
    const source = await this.source.loadSourceSnapshot({ readAt: input.readAt });
    if (source.configuration === null) {
      refuse("CANONICAL_CONFIGURATION_UNAPPROVED");
    }
    const parsedConfiguration = approvedPublicCatalogConfigurationV1Schema
      .safeParse(source.configuration.configuration);
    if (!parsedConfiguration.success) {
      refuse("CANONICAL_CONFIGURATION_INVALID");
    }
    const snapshot = this.project(parsedConfiguration.data, source);
    // The snapshot root carries the tenant scope key the port contract
    // requires; the sweep covers every projected member that can reach a
    // publication batch.
    if (
      containsProtectedPublicationField({
        products: snapshot.products,
        categories: snapshot.categories,
        collectibles: snapshot.collectibles,
        chases: snapshot.chases,
      })
    ) {
      refuse("PROTECTED_PUBLICATION_FIELD");
    }
    return snapshot;
  }

  /**
   * Every configured platform must be active with a completed governed
   * backfill; disabled or archived platforms are excluded entirely. Anything
   * in between is an incomplete canonical state and is refused, mirroring
   * the v2 release readiness rules.
   */
  private activePlatformKeys(
    configuration: ApprovedPublicCatalogConfigurationV1,
    providers: readonly CatalogProviderReadinessSnapshot[],
  ): ReadonlySet<string> {
    const providerByPlatform = new Map(
      providers.map((provider) => [provider.platformKey, provider]),
    );
    const active = new Set<string>();
    for (const platform of configuration.platforms) {
      const provider = providerByPlatform.get(platform.platformKey);
      if (provider?.state === "disabled" || provider?.state === "archived") {
        continue;
      }
      if (
        provider?.state !== "active" ||
        provider.providerId === null ||
        provider.sourceInstanceId === null ||
        provider.sourceRevisionId === null ||
        provider.completedBackfillAt === null
      ) {
        refuse("CANONICAL_PROVIDER_NOT_READY");
      }
      active.add(platform.platformKey);
    }
    return active;
  }

  private project(
    configuration: ApprovedPublicCatalogConfigurationV1,
    source: DataReleaseV3CanonicalSourceSnapshot,
  ): DataReleaseV3CanonicalSnapshot {
    const origins = new Set(configuration.publicAssetOrigins);
    const activePlatforms = this.activePlatformKeys(
      configuration,
      source.providers,
    );
    const platformByKey = new Map(
      configuration.platforms
        .filter(({ platformKey }) => activePlatforms.has(platformKey))
        .map((platform) => [platform.platformKey, platform]),
    );
    const identities = new Map(source.repackIdentities.map((identity) => [
      key(identity.platformKey, identity.packExternalId), identity,
    ]));
    const configuredRepackIdentities = new Map(configuration.repacks.map(
      (identity) => [key(identity.platformKey, identity.packExternalId), identity],
    ));
    const collectibleMappings = new Map(configuration.collectibles.map(
      (mapping) => [key(mapping.platformKey, mapping.externalId), mapping],
    ));
    const soldOutAtByPack = new Map(source.soldOutTransitions.map(
      (transition) => [
        key(transition.platformKey, transition.packExternalId),
        transition.soldOutAt,
      ],
    ));
    const categories: PublicCategory[] = [...configuration.categories]
      .sort((left, right) =>
        left.publicCategoryId < right.publicCategoryId ? -1 : 1,
      );
    const categoryById = new Map(
      categories.map((category) => [category.publicCategoryId, category]),
    );
    const relevant = source.revisions.filter(({ platformKey }) =>
      platformByKey.has(platformKey),
    );
    const packs = relevant.filter(({ recordKind }) => recordKind === "pack");
    const assets = relevant.filter(
      ({ recordKind }) => recordKind === "catalog_asset",
    );
    const assetByKey = new Map(assets.map((asset) => [
      key(asset.platformKey, asset.externalId),
      asset,
    ]));
    const packKeys = new Set(packs.map((pack) =>
      key(pack.platformKey, pack.externalId)));
    const associatedAssetKeys = new Set<string>();
    const assetKeysByPack = new Map<string, string[]>();
    const associationSourceIds = new Set<string>();
    const associationPairs = new Set<string>();
    for (const association of source.assetPackAssociations) {
      if (!activePlatforms.has(association.platformKey)) continue;
      const assetKey = key(
        association.platformKey,
        association.assetExternalId,
      );
      const packKey = key(
        association.platformKey,
        association.packExternalId,
      );
      const pairKey = `${assetKey}\0${association.packExternalId}`;
      if (
        association.sourceEntityId.length === 0 ||
        association.publicChangeSequence <= 0n ||
        association.publicChangeSequence > source.throughSequence ||
        !Number.isFinite(association.associatedAt.getTime()) ||
        association.associatedAt.getTime() > source.readAt.getTime() ||
        !assetByKey.has(assetKey) ||
        !packKeys.has(packKey) ||
        associationSourceIds.has(association.sourceEntityId) ||
        associationPairs.has(pairKey)
      ) {
        refuse("CANONICAL_PROJECTION_INVALID");
      }
      associationSourceIds.add(association.sourceEntityId);
      associationPairs.add(pairKey);
      associatedAssetKeys.add(assetKey);
      const packAssetKeys = assetKeysByPack.get(packKey) ?? [];
      packAssetKeys.push(assetKey);
      assetKeysByPack.set(packKey, packAssetKeys);
    }
    const evInputByPack = new Map<
      string,
      CanonicalEvInputProjectionContent
    >();
    for (const revision of relevant) {
      if (revision.recordKind !== "ev_input") continue;
      const content = evInputContent(revision.content);
      const inputKey = key(revision.platformKey, content.packExternalId);
      if (evInputByPack.has(inputKey)) {
        refuse("CANONICAL_PROJECTION_INVALID", content.packExternalId);
      }
      evInputByPack.set(inputKey, content);
    }

    const collectibles: PublicCollectible[] = [];
    const collectibleByAsset = new Map<string, PublicCollectible>();
    for (const revision of assets) {
      const content = assetContent(revision.content);
      // A configured catalog asset is independently publishable as a
      // collectible. Its optional pack relationship controls only whether the
      // collectible becomes a chase below; it is not an existence gate for
      // collectible search, saved items, or inspection.
      if (content.availability === "unavailable") {
        continue;
      }
      const mapping = collectibleMappings.get(
        key(revision.platformKey, revision.externalId),
      );
      const assetKey = key(revision.platformKey, revision.externalId);
      const name = publicCollectibleName(content);
      const associated = associatedAssetKeys.has(assetKey);
      // An unassociated, unconfigured source shell that cannot satisfy the
      // public name contract has no public identity to project. This is the
      // only non-unavailable asset shape omitted here. Named-but-unconfigured,
      // associated unnamed, and configured unnamed assets remain hard errors.
      if (!mapping && !associated && name === null) continue;
      if (!mapping || name === null) {
        refuse("PUBLIC_IDENTITY_MAPPING_MISSING");
      }
      const valuationMinor = safeMinor(content.providerValueMinor);
      const currency = content.providerValueCurrency;
      const valuation = valuationMinor === null || currency === null ? null : {
        displayMoney: /^[A-Z]{3}$/.test(currency)
          ? { minorUnits: valuationMinor, currency } : null,
        usdComparison: currency === "USD"
          ? {
              status: "available" as const,
              value: { minorUnits: valuationMinor, currency: "USD" as const },
            }
          : {
              status: "unavailable" as const,
              value: null,
              reason: "CURRENCY_UNSUPPORTED" as const,
            },
        valuationType: content.valueSource === "last_sale"
          ? "last_sale" as const : "vendor_reported" as const,
        observedAt: iso(revision.sourceUpdatedAt),
      };
      const normalizedAliases = mapping.aliases.map(normalizePublicSearchText).sort();
      const collectible: PublicCollectible = {
        publicCollectibleId: mapping.publicCollectibleId,
        name,
        normalizedName: normalizePublicSearchText(name),
        aliases: mapping.aliases,
        normalizedAliases,
        collectibleType: mapping.collectibleType,
        publicCategoryIds: mapping.publicCategoryIds,
        year: mapping.year,
        brand: mapping.brand,
        setOrSeries: mapping.setOrSeries,
        cardNumber: mapping.cardNumber,
        referenceNumber: mapping.referenceNumber,
        subject: mapping.subject,
        grade: mapping.grade,
        grader: mapping.grader,
        primaryImage: approvedImage(content.imageUrls, origins, name),
        valuation,
        searchText: "",
        dataAsOf: iso(revision.sourceUpdatedAt),
      };
      collectible.searchText = buildPublicCollectibleSearchText(collectible);
      collectibles.push(collectible);
      collectibleByAsset.set(
        key(revision.platformKey, revision.externalId),
        collectible,
      );
    }
    collectibles.sort((left, right) =>
      left.publicCollectibleId < right.publicCollectibleId ? -1 : 1,
    );
    if (
      new Set(collectibles.map(({ publicCollectibleId }) => publicCollectibleId))
        .size !== collectibles.length
    ) {
      refuse("PUBLIC_IDENTITY_MAPPING_MISSING");
    }

    const products: DataReleaseV3CanonicalProduct[] = [];
    const chases: PublicRepackChase[] = [];
    for (const revision of packs) {
      const content = packContent(revision.content);
      // Every availability state publishes, matching the governed v2 catalog
      // projection. `unavailable` and `unknown` exist precisely because the
      // retired two-state vocabulary had no way to represent a pack the vendor
      // no longer presents as buyable; dropping them here would keep them out
      // of every release and make "stays discoverable in the catalog" false end
      // to end.
      //
      // Discoverable is not purchasable. `available` remains the only state
      // that may rank, count toward positive-EV summaries, or expose an
      // outbound purchase link, and that is enforced on the read side by
      // `packAvailabilityIsPurchasableV3`: opportunity eligibility
      // (`publicDashboardBundleV3Schema`), sort-row materialization
      // (`repackEvSortRowV3FromDetail`), the KPI rows in
      // `convex/publicRepacksV3.ts`, and the outbound-link rule in
      // `publicRepackDetailV3Schema` all fail closed for the other states.
      const productKey = revision.externalId;
      const platform = platformByKey.get(revision.platformKey)!;
      const identity = identities.get(key(revision.platformKey, productKey));
      const configuredIdentity = configuredRepackIdentities.get(
        key(revision.platformKey, productKey),
      );
      if (!identity || !configuredIdentity ||
          identity.publicRepackId !== configuredIdentity.publicRepackId) {
        refuse("PUBLIC_IDENTITY_MAPPING_MISSING", productKey);
      }
      const relatedAssets = (assetKeysByPack.get(
        key(revision.platformKey, productKey),
      ) ?? []).map((assetKey) => assetByKey.get(assetKey)!).filter((asset) =>
        assetContent(asset.content).availability !== "unavailable"
      );
      const evInputClaim =
        evInputByPack.get(key(revision.platformKey, productKey)) ?? null;
      if (content.evInputStatus === "ready" && evInputClaim === null) {
        refuse("CANONICAL_PROJECTION_INVALID", productKey);
      }
      // The current pack revision is authoritative. A retained canonical
      // ev_input entity can outlive the provider evidence that produced it;
      // once the pack says that EV inputs are unavailable, no historical
      // probabilities or vendor-odds evidence may reach the public release.
      const evInput = content.evInputStatus === "ready" ? evInputClaim : null;
      const probabilityByBucket = new Map(
        evInput?.probabilityBuckets.map(
          (bucket) => [bucket.bucketId, bucket.probability],
        ) ?? [],
      );
      const chaseCandidates = relatedAssets.map((asset) => {
        const collectible = collectibleByAsset.get(
          key(asset.platformKey, asset.externalId),
        );
        if (!collectible) refuse("PUBLIC_IDENTITY_MAPPING_MISSING", productKey);
        const comparison = collectible.valuation?.usdComparison;
        return {
          asset,
          collectible,
          value: comparison?.status === "available"
            ? comparison.value.minorUnits : null,
        };
      }).sort((left, right) =>
        (left.value === null ? 1 : 0) - (right.value === null ? 1 : 0) ||
        (right.value ?? 0) - (left.value ?? 0) ||
        (left.collectible.publicCollectibleId <
          right.collectible.publicCollectibleId ? -1 : 1));
      const packChases = chaseCandidates.map(
        ({ asset, collectible }, displayOrder): PublicRepackChase => {
          const mapping = collectibleMappings.get(
            key(asset.platformKey, asset.externalId),
          );
          if (!mapping) refuse("PUBLIC_IDENTITY_MAPPING_MISSING", productKey);
          const probability = mapping.probabilityBucketId === null
            ? null
            : probabilityByBucket.get(mapping.probabilityBucketId) ?? null;
          const probabilityBasisPoints =
            probability !== null && Number.isFinite(probability)
              ? Math.round(probability * 10_000) : null;
          const evidenceKinds = [...new Set([
            ...mapping.chaseEvidenceKinds,
            ...(probabilityBasisPoints === null ? [] : ["vendor_odds" as const]),
          ])].sort();
          const scoreBasisPoints = mapping.matchConfidenceBasisPoints;
          return {
            publicRepackId: identity.publicRepackId,
            publicCollectibleId: collectible.publicCollectibleId,
            role: displayOrder === 0 ? "top_chase" : "possible_outcome",
            evidenceKinds,
            probabilityBasisPoints,
            collectible: collectibleDisplay(collectible),
            matchConfidence: {
              scoreBasisPoints,
              band: scoreBasisPoints < 5_000 ? "low"
                : scoreBasisPoints < 8_000 ? "medium" : "high",
            },
            observedAt: iso(asset.sourceUpdatedAt, productKey),
            displayOrder,
          };
        },
      );
      chases.push(...packChases);
      const categoryIds = [...new Set([
        ...(platform.categoryMappings.find(
          ({ sourceValue }) => sourceValue === content.category,
        )?.publicCategoryIds ?? platform.defaultPublicCategoryIds),
        ...packChases.flatMap(
          ({ collectible }) => collectible.publicCategoryIds,
        ),
      ])].sort();
      if (categoryIds.some((categoryId) => !categoryById.has(categoryId))) {
        refuse("CANONICAL_PROJECTION_INVALID", productKey);
      }
      const collectibleTypes = [...new Set(
        packChases.map(({ collectible }) => collectible.collectibleType),
      )].sort();
      const categoryBranches = categoryIds.filter((candidate) =>
        !categoryIds.some((other) =>
          other !== candidate &&
          categoryById.get(other)?.pathPublicCategoryIds.includes(candidate),
        )).length;
      const contentMode = categoryBranches > 1 || collectibleTypes.length > 1
        ? "mixed" as const : categoryBranches === 1 || collectibleTypes.length === 1
          ? "focused" as const : "unknown" as const;
      const soldOutTransition =
        soldOutAtByPack.get(key(revision.platformKey, productKey)) ?? null;
      if (content.availability === "sold_out" && soldOutTransition === null) {
        refuse("CANONICAL_PROJECTION_INVALID", productKey);
      }
      const promo = platform.vendor.publicPromo ?? undefined;
      const repackLink = configuredPublicRepackLink({
        identity: configuredIdentity,
        platform,
        available: content.availability === "available",
      }) ?? undefined;
      products.push({
        platformKey: revision.platformKey,
        productKey,
        publicRepackId: identity.publicRepackId,
        publicVendorId: platform.vendor.publicVendorId,
        vendorKey: platform.vendor.vendorKey,
        vendorDisplayName: platform.vendor.displayName,
        vendorLogoUrl: platform.vendor.logoUrl,
        name: content.name.trim(),
        format: platform.format,
        contentMode,
        categories: categoryIds.map((publicCategoryId) => ({
          publicCategoryId,
          label: categoryById.get(publicCategoryId)?.name ??
            refuse("CANONICAL_PROJECTION_INVALID", productKey),
        })),
        collectibleTypes,
        availability: content.availability,
        soldOutAt: content.availability === "sold_out"
          ? iso(soldOutTransition!, productKey)
          : null,
        price: publicPrice(content),
        buyback: buybackSummary(content),
        vendorReportedEv: vendorReportedEv(
          content,
          revision.sourceUpdatedAt,
          productKey,
        ),
        primaryImage: approvedImage(
          content.imageUrls,
          new Set(platform.vendor.imageOrigins),
          content.name,
        ),
        topChase: packChases[0] ?? null,
        contentSummary: {
          knownCollectibleCount: packChases.length,
          chaseCount: packChases.length,
          categoryCount: categoryIds.length,
          collectibleTypeCount: collectibleTypes.length,
          evidenceCompleteness: evInput?.evidenceCompleteness ?? "unknown",
          probabilityCoverageBasisPoints: evInput === null
            ? null
            : Math.round(evInput.coverage.calculatedCoverage * 10_000),
        },
        actionAvailability: {
          promo: promo !== undefined,
          repackLink: repackLink !== undefined,
        },
        sourceUpdatedAt: iso(revision.sourceUpdatedAt, productKey),
        description: content.description?.trim() || null,
        actions: {
          ...(promo === undefined ? {} : { promo }),
          ...(repackLink === undefined ? {} : { repackLink }),
        },
      });
    }
    products.sort((left, right) =>
      left.publicRepackId < right.publicRepackId ? -1 : 1,
    );
    if (
      new Set(products.map(({ publicRepackId }) => publicRepackId)).size !==
      products.length
    ) {
      refuse("PUBLIC_IDENTITY_MAPPING_MISSING");
    }
    const chaseKey = (chase: PublicRepackChase) =>
      `${chase.publicRepackId}:${chase.publicCollectibleId}`;
    chases.sort((left, right) => (chaseKey(left) < chaseKey(right) ? -1 : 1));
    if (
      chases.some((chase, index) =>
        index > 0 && chaseKey(chases[index - 1]!) >= chaseKey(chase))
    ) {
      refuse("CANONICAL_PROJECTION_INVALID");
    }
    return {
      organizationId: source.organizationId,
      products,
      categories,
      collectibles,
      chases,
    };
  }
}
