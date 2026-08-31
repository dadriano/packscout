import {
  approvedPublicCollectibleMappingSchema,
  buildPublicCollectibleSearchText,
  normalizePublicSearchText,
  providerPackContentSnapshotItemV1Schema,
  provisionalCollectiblePublicId,
  publicCollectibleSchema,
  publicHttpsOriginSchema,
  publicRepackChaseSchema,
  publicRepackDetailSchema,
  type PublicCollectible,
  type PublicRepackChase,
} from "@packscout/contracts";
import {
  DistributedProviderPackContentsError,
  type DistributedProviderCollectibleInstanceRow,
  type DistributedProviderCollectibleRow,
  type DistributedProviderContentPack,
  type DistributedProviderPackContentRow,
  type DistributedProviderPackContentsProjection,
} from "./distributed-provider-pack-contents-types.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

function refuse(code: DistributedProviderPackContentsError["code"]): never {
  throw new DistributedProviderPackContentsError(code);
}

function observed(value: Date, ceiling: number): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()) || value.getTime() > ceiling) {
    return refuse("DISTRIBUTED_CONTENT_SNAPSHOT_INVALID");
  }
  return value.toISOString();
}

/** Bounded exact decimal scaling; never sends canonical money through a float. */
function scaled(value: string, places: number): number {
  const match = /^(0|[1-9][0-9]{0,19})(?:\.([0-9]{1,18}))?$/u.exec(value);
  if (match === null) return refuse("DISTRIBUTED_CONTENT_VALUE_INVALID");
  const fraction = match[2] ?? "";
  let result = BigInt(match[1]!) * 10n ** BigInt(places) +
    BigInt(fraction.slice(0, places).padEnd(places, "0") || "0");
  if ((fraction[places] ?? "0") >= "5") result += 1n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) return refuse("DISTRIBUTED_CONTENT_VALUE_INVALID");
  return Number(result);
}

function rowsById<T extends { readonly id: string; readonly rowVersion: bigint }>(rows: readonly T[]): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    if (!UUID.test(row.id) || typeof row.rowVersion !== "bigint" || row.rowVersion < 1n || result.has(row.id)) {
      return refuse("DISTRIBUTED_CONTENT_IDENTITY_INVALID");
    }
    result.set(row.id, row);
  }
  return result;
}

function valuation(row: DistributedProviderCollectibleRow, ceiling: number): PublicCollectible["valuation"] {
  if (row.valuationAmount === null && row.valuationCurrency === null &&
      row.valuationUsdAmount === null && row.valuationType === null && row.valuationObservedAt === null) {
    if (row.valuationUnavailableReason !== null && row.valuationUnavailableReason !== "VALUATION_UNAVAILABLE") {
      return refuse("DISTRIBUTED_CONTENT_VALUE_INVALID");
    }
    return null;
  }
  if ((row.valuationAmount === null) !== (row.valuationCurrency === null) ||
      row.valuationType === null || row.valuationObservedAt === null) {
    return refuse("DISTRIBUTED_CONTENT_VALUE_INVALID");
  }
  const displayMoney = row.valuationAmount !== null && /^[A-Z]{3}$/u.test(row.valuationCurrency!)
    ? { minorUnits: scaled(row.valuationAmount, 2), currency: row.valuationCurrency! } : null;
  const usdComparison = row.valuationUsdAmount === null
    ? {
        status: "unavailable" as const,
        value: null,
        reason: row.valuationUnavailableReason ?? (displayMoney === null ? "VALUATION_UNAVAILABLE" : "CURRENCY_UNSUPPORTED"),
      }
    : { status: "available" as const, value: { minorUnits: scaled(row.valuationUsdAmount, 2), currency: "USD" as const } };
  if (row.valuationUsdAmount !== null && row.valuationUnavailableReason !== null) {
    return refuse("DISTRIBUTED_CONTENT_VALUE_INVALID");
  }
  return publicCollectibleSchema.shape.valuation.parse({
    displayMoney, usdComparison, valuationType: row.valuationType,
    observedAt: observed(row.valuationObservedAt, ceiling),
  });
}

function collectible(row: DistributedProviderCollectibleRow, input: {
  readonly providerId: string;
  readonly origins: ReadonlySet<string>;
  readonly ceiling: number;
}): PublicCollectible {
  if (row.primaryImageUrl !== null) {
    let url: URL;
    try { url = new URL(row.primaryImageUrl); } catch { return refuse("DISTRIBUTED_CONTENT_IMAGE_UNAPPROVED"); }
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || !input.origins.has(url.origin)) {
      return refuse("DISTRIBUTED_CONTENT_IMAGE_UNAPPROVED");
    }
  } else if (row.primaryImageAlt !== null) return refuse("DISTRIBUTED_CONTENT_IMAGE_UNAPPROVED");
  const identity = {
    publicCollectibleId: provisionalCollectiblePublicId({ providerId: input.providerId, localCollectibleId: row.id }),
    name: row.displayName,
    normalizedName: normalizePublicSearchText(row.displayName),
    aliases: [...row.aliases].sort(compare),
    normalizedAliases: row.aliases.map(normalizePublicSearchText).sort(compare),
    collectibleType: row.collectibleType,
    publicCategoryIds: [],
    year: row.year,
    brand: row.brand,
    setOrSeries: row.setOrSeries,
    cardNumber: row.cardNumber,
    referenceNumber: row.referenceNumber,
    subject: row.subject,
    grade: row.grade,
    grader: row.grader,
    primaryImage: row.primaryImageUrl === null ? null : {
      url: row.primaryImageUrl, alt: row.primaryImageAlt ?? row.displayName,
    },
    valuation: valuation(row, input.ceiling),
    dataAsOf: observed(row.dataAsOf, input.ceiling),
  };
  return publicCollectibleSchema.parse({ ...identity, searchText: buildPublicCollectibleSearchText(identity) });
}

/**
 * Governed bootstrap projection for provider-local identities before central
 * correlation exists. The caller must prove that bootstrap policy is active;
 * switching to central correlations requires replacing this explicit policy,
 * never a fallback selected after a failed correlation lookup. Membership is
 * current inventory evidence, not a pull history or a series-wide highlight.
 * Pack economics and EV are supplied unchanged by their existing projectors.
 */
export function projectProvisionalProviderPackContentsV1(input: {
  readonly identityPolicy: "provider_provisional_v1";
  readonly providerId: string;
  readonly platformKey: string;
  readonly snapshotAt: Date;
  readonly publicAssetOrigins: readonly string[];
  readonly packs: readonly DistributedProviderContentPack[];
  readonly collectibles: readonly DistributedProviderCollectibleRow[];
  readonly instances: readonly DistributedProviderCollectibleInstanceRow[];
  readonly memberships: readonly DistributedProviderPackContentRow[];
}): DistributedProviderPackContentsProjection {
  try {
    return project(input);
  } catch (error) {
    if (error instanceof DistributedProviderPackContentsError) throw error;
    return refuse("DISTRIBUTED_CONTENT_SNAPSHOT_INVALID");
  }
}

function project(input: Parameters<typeof projectProvisionalProviderPackContentsV1>[0]): DistributedProviderPackContentsProjection {
  if (input.identityPolicy !== "provider_provisional_v1" || !UUID.test(input.providerId) || input.packs.length === 0) {
    return refuse("DISTRIBUTED_CONTENT_IDENTITY_INVALID");
  }
  const ceiling = input.snapshotAt.getTime();
  observed(input.snapshotAt, ceiling);
  const origins = new Set(input.publicAssetOrigins.map((origin) => publicHttpsOriginSchema.parse(origin)));
  if (origins.size !== input.publicAssetOrigins.length) return refuse("DISTRIBUTED_CONTENT_IMAGE_UNAPPROVED");
  const packs = rowsById(input.packs);
  const sourceCollectibles = rowsById(input.collectibles);
  const instances = rowsById(input.instances);
  rowsById(input.memberships);
  if (new Set(input.packs.map(({ packKey }) => packKey)).size !== packs.size ||
      new Set(input.packs.map(({ detail }) => detail.publicRepackId)).size !== packs.size ||
      new Set(input.collectibles.map(({ collectibleKey }) => collectibleKey)).size !== sourceCollectibles.size) {
    return refuse("DISTRIBUTED_CONTENT_IDENTITY_INVALID");
  }
  const collectibles = input.collectibles.map((row) => collectible(row, { providerId: input.providerId, origins, ceiling }));
  const byLocalId = new Map(input.collectibles.map((row, index) => [row.id, collectibles[index]!]));
  const referenced = new Set<string>();
  const referencedInstances = new Set<string>();
  const membershipKeys = new Set<string>();
  const contentsByPack = new Map<string, typeof input.memberships[number][]>();
  for (const membership of input.memberships) {
    const pack = packs.get(membership.packId);
    const row = sourceCollectibles.get(membership.collectibleId);
    const instance = membership.collectibleInstanceId === null ? null : instances.get(membership.collectibleInstanceId);
    if (pack === undefined || row === undefined || instance === undefined ||
        (instance !== null && instance.collectibleId !== row.id)) {
      return refuse("DISTRIBUTED_CONTENT_REFERENCE_INVALID");
    }
    // The public schema represents one card identity per pack, not instance
    // quantities. Refuse collisions instead of inventing an aggregation rule.
    const key = `${membership.packId}:${membership.collectibleId}`;
    if (membershipKeys.has(key)) return refuse("DISTRIBUTED_CONTENT_IDENTITY_INVALID");
    membershipKeys.add(key);
    observed(membership.observedAt, ceiling);
    providerPackContentSnapshotItemV1Schema.parse({
      collectibleKey: row.collectibleKey,
      collectibleInstanceKey: instance?.instanceKey ?? null,
      status: "present", totalQuantity: membership.totalQuantity?.toString() ?? null,
      availableQuantity: membership.availableQuantity?.toString() ?? null,
      contentRole: membership.contentRole, probability: membership.probability,
      statedValueAmount: membership.statedValueAmount, statedValueCurrency: membership.statedValueCurrency,
      evidenceKinds: membership.evidenceKinds, matchConfidenceBasisPoints: membership.matchConfidenceBasisPoints,
      displayOrder: membership.displayOrder,
    });
    const band = membership.matchConfidenceBasisPoints < 5_000 ? "low" : membership.matchConfidenceBasisPoints < 8_000 ? "medium" : "high";
    if (membership.matchConfidenceBand !== band || pack.evidenceCompleteness === "unknown") {
      return refuse("DISTRIBUTED_CONTENT_SNAPSHOT_INVALID");
    }
    referenced.add(row.id);
    if (instance !== null) referencedInstances.add(instance.id);
    contentsByPack.set(pack.id, [...(contentsByPack.get(pack.id) ?? []), membership]);
  }
  if (referenced.size !== sourceCollectibles.size || referencedInstances.size !== instances.size) {
    return refuse("DISTRIBUTED_CONTENT_REFERENCE_INVALID");
  }
  const repackChases: PublicRepackChase[] = [];
  const repacks = input.packs.map((pack) => {
    observed(new Date(pack.detail.sourceUpdatedAt), ceiling);
    const contents = contentsByPack.get(pack.id) ?? [];
    const candidates = contents.filter((row) => row.contentRole !== "other" && row.availableQuantity !== 0n);
    const value = (row: typeof candidates[number]) => {
      const comparison = byLocalId.get(row.collectibleId)!.valuation?.usdComparison;
      return comparison?.status === "available" ? comparison.value.minorUnits : -1;
    };
    candidates.sort((left, right) => value(right) - value(left) || compare(
      byLocalId.get(left.collectibleId)!.publicCollectibleId, byLocalId.get(right.collectibleId)!.publicCollectibleId,
    ));
    const chases = candidates.map((row, displayOrder) => {
      const card = byLocalId.get(row.collectibleId)!;
      return publicRepackChaseSchema.parse({
        publicRepackId: pack.detail.publicRepackId, publicCollectibleId: card.publicCollectibleId,
        role: displayOrder === 0 ? "top_chase" : row.contentRole === "featured_chase" ? "featured_chase" : "possible_outcome",
        evidenceKinds: [...row.evidenceKinds].sort(compare),
        probabilityBasisPoints: row.probability === null ? null : scaled(row.probability, 4),
        collectible: {
          publicCollectibleId: card.publicCollectibleId, name: card.name, collectibleType: card.collectibleType,
          publicCategoryIds: card.publicCategoryIds, primaryImage: card.primaryImage, valuation: card.valuation,
        },
        matchConfidence: { scoreBasisPoints: row.matchConfidenceBasisPoints, band: row.matchConfidenceBand },
        observedAt: row.observedAt.toISOString(), displayOrder,
      });
    });
    repackChases.push(...chases);
    const collectibleTypes = [...new Set(contents.map(({ collectibleId }) => byLocalId.get(collectibleId)!.collectibleType))].sort(compare);
    return publicRepackDetailSchema.parse({
      ...pack.detail,
      contentMode: collectibleTypes.length > 1 ? "mixed" : collectibleTypes.length === 1 ? "focused" : "unknown",
      collectibleTypes,
      topChase: chases[0] ?? null,
      contentSummary: {
        knownCollectibleCount: contents.length, chaseCount: chases.length, categoryCount: pack.detail.categories.length,
        collectibleTypeCount: collectibleTypes.length, evidenceCompleteness: pack.evidenceCompleteness,
        // Nullable per-item evidence is not an inventory coverage estimate.
        probabilityCoverageBasisPoints: null,
      },
    });
  });
  const collectibleMappings = input.collectibles.map((row) => {
    const card = byLocalId.get(row.id)!;
    const contents = input.memberships.filter(({ collectibleId }) => collectibleId === row.id);
    return approvedPublicCollectibleMappingSchema.parse({
      platformKey: input.platformKey, externalId: row.collectibleKey, publicCollectibleId: card.publicCollectibleId,
      aliases: card.aliases, collectibleType: card.collectibleType, publicCategoryIds: card.publicCategoryIds,
      year: card.year, brand: card.brand, setOrSeries: card.setOrSeries, cardNumber: card.cardNumber,
      referenceNumber: card.referenceNumber, subject: card.subject, grade: card.grade, grader: card.grader,
      probabilityBucketId: null,
      matchConfidenceBasisPoints: Math.min(...contents.map(({ matchConfidenceBasisPoints }) => matchConfidenceBasisPoints)),
      chaseEvidenceKinds: [...new Set(contents.flatMap(({ evidenceKinds }) => [...evidenceKinds]))].sort(compare),
    });
  }).sort((left, right) => compare(left.externalId, right.externalId));
  return {
    collectibles: collectibles.sort((left, right) => compare(left.publicCollectibleId, right.publicCollectibleId)),
    repacks,
    repackChases: repackChases.sort((left, right) => compare(
      `${left.publicRepackId}:${left.publicCollectibleId}`, `${right.publicRepackId}:${right.publicCollectibleId}`,
    )),
    collectibleMappings,
    dataAsOf: new Date(Math.max(...repacks.map(({ sourceUpdatedAt }) => Date.parse(sourceUpdatedAt)),
      ...collectibles.map(({ dataAsOf }) => Date.parse(dataAsOf)), ...input.memberships.map(({ observedAt }) => observedAt.getTime()))),
  };
}
