import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
  globalCategoryPublicId,
  packscoutPublicIdentityUuid,
  provisionalCollectiblePublicId,
  providerReleaseCatalogPinHash,
  providerReleaseCorrelationSnapshotHash,
  sha256CanonicalJson,
  type PublicCatalogCategory,
  type PublicCatalogCollectible,
} from "@packscout/contracts";
import {
  ProviderReleaseValidationError,
  buildProviderRelease,
  type ProviderReleaseSnapshot,
} from "./provider-release-contract.ts";
import type { PinnedProviderReleaseInputs } from "./provider-release-central-repository.ts";
import { currencyMinorUnits, publicPrice } from "./provider-release-money.ts";

const providerId = "13000000-0000-4000-8000-000000000001";
const local = {
  categoryCards: "13000000-0000-4000-8000-000000000101",
  categoryWatches: "13000000-0000-4000-8000-000000000102",
  categoryArt: "13000000-0000-4000-8000-000000000103",
  card: "13000000-0000-4000-8000-000000000201",
  watch: "13000000-0000-4000-8000-000000000202",
  art: "13000000-0000-4000-8000-000000000203",
  multiPack: "13000000-0000-4000-8000-000000000301",
  unavailablePack: "13000000-0000-4000-8000-000000000302",
  retiredPack: "13000000-0000-4000-8000-000000000303",
  alias: "13000000-0000-4000-8000-000000000401",
} as const;
const globalCategoryIds = {
  root: "23000000-0000-4000-8000-000000000001",
  cards: "23000000-0000-4000-8000-000000000002",
  watches: "23000000-0000-4000-8000-000000000003",
  art: "23000000-0000-4000-8000-000000000004",
} as const;
const publicCategoryIds = Object.fromEntries(
  Object.entries(globalCategoryIds).map(([key, value]) => [key, globalCategoryPublicId(value)]),
) as Record<keyof typeof globalCategoryIds, string>;
const cardId = packscoutPublicIdentityUuid("fixture:collectible:card");
const watchId = packscoutPublicIdentityUuid("fixture:collectible:watch");
const artId = provisionalCollectiblePublicId({ providerId, localCollectibleId: local.art });
const retiredAliasId = packscoutPublicIdentityUuid("fixture:collectible:retired-alias");
const observedAt = new Date("2026-08-29T12:00:00.000Z");

function category(input: {
  id: string;
  parentId: string | null;
  key: string;
  name: string;
  depth: number;
  path: readonly string[];
  order: number;
}): PublicCatalogCategory {
  return {
    publicCategoryId: input.id,
    parentPublicCategoryId: input.parentId,
    categoryKey: input.key,
    displayName: input.name,
    categoryKind: input.depth === 0 ? "vertical" : "other",
    displayOrder: input.order,
    depth: input.depth,
    pathPublicCategoryIds: input.path,
    lifecycle: "active",
  };
}

function collectible(input: {
  id: string;
  type: PublicCatalogCollectible["collectibleType"];
  name: string;
  categoryId: string;
  identityState?: "canonical" | "provisional";
  value?: string | null;
}): PublicCatalogCollectible {
  const value = input.value === undefined ? "1250" : input.value;
  return {
    publicCollectibleId: input.id,
    identityState: input.identityState ?? "canonical",
    collectibleType: input.type,
    displayName: input.name,
    normalizedName: input.name.toLowerCase(),
    nameAliases: [],
    normalizedNameAliases: [],
    publicCategoryIds: [publicCategoryIds.root, input.categoryId].sort(),
    year: null,
    brand: null,
    setOrSeries: null,
    cardNumber: null,
    referenceNumber: null,
    subject: null,
    grade: null,
    grader: null,
    primaryImageUrl: null,
    primaryImageAlt: null,
    valuationAmount: value,
    valuationCurrency: value === null ? null : "USD",
    valuationUsdAmount: value,
    valuationUnavailableReason: value === null ? "VALUATION_UNAVAILABLE" : null,
    valuationType: "market_estimate",
    valuationObservedAt: observedAt.toISOString(),
    dataAsOf: observedAt.toISOString(),
  };
}

async function pin(): Promise<PinnedProviderReleaseInputs> {
  const publicProvider: PinnedProviderReleaseInputs["publicProvider"] = {
    publicVendorId: packscoutPublicIdentityUuid(`provider:${providerId}`),
    vendorKey: "fixture_provider",
    displayName: "Fixture Provider",
    logoUrl: null,
    websiteUrl: "https://fixture.example",
    listingHosts: ["fixture.example"],
    imageOrigins: ["https://assets.fixture.example"],
    referralParameters: [{ name: "utm_source", value: "packscout" }],
    publicPromo: { code: "SCOUT", label: "Use SCOUT" },
  };
  const categories = [
    category({
      id: publicCategoryIds.root,
      parentId: null,
      key: "collectibles",
      name: "Collectibles",
      depth: 0,
      path: [publicCategoryIds.root],
      order: 0,
    }),
    ...([
      [publicCategoryIds.cards, "cards", "Cards"],
      [publicCategoryIds.watches, "watches", "Watches"],
      [publicCategoryIds.art, "art", "Art"],
    ] as const).map(([id, key, name], index) => category({
      id,
      parentId: publicCategoryIds.root,
      key,
      name,
      depth: 1,
      path: [publicCategoryIds.root, id],
      order: index + 1,
    })),
  ];
  const categoryCorrelations = [
    [local.categoryCards, publicCategoryIds.cards],
    [local.categoryWatches, publicCategoryIds.watches],
    [local.categoryArt, publicCategoryIds.art],
  ].map(([localCategoryId, publicCategoryId]) => ({
    localCategoryId: localCategoryId!, localEntityVersion: 1n, publicCategoryId: publicCategoryId!,
  }));
  const collectibleCorrelations = [
    [local.card, cardId], [local.watch, watchId], [local.art, artId],
  ].map(([localCollectibleId, publicCollectibleId]) => ({
    localCollectibleId: localCollectibleId!, localEntityVersion: 1n,
    publicCollectibleId: publicCollectibleId!,
  }));
  const correlationEventSequence = 19n;
  const catalogCollectibles = [
    collectible({ id: cardId, type: "card", name: "Rookie Card", categoryId: publicCategoryIds.cards }),
    collectible({ id: watchId, type: "watch", name: "Dive Watch", categoryId: publicCategoryIds.watches }),
    collectible({ id: artId, type: "art", name: "Modern Art", categoryId: publicCategoryIds.art, identityState: "provisional", value: null }),
  ];
  const catalogAliases = [{
    aliasPublicCollectibleId: retiredAliasId,
    canonicalPublicCollectibleId: cardId,
  }];
  const catalogVersionId = "33000000-0000-4000-8000-000000000001";
  const catalogSchemaVersion = "catalog-v1";
  const catalogContentHash = "a".repeat(64);
  const catalogThroughChangeSequence = 17n;
  return {
    providerId,
    providerKey: "fixture_provider",
    providerConfigVersionId: "33000000-0000-4000-8000-000000000003",
    providerConfigExpiresAt: null,
    staleAfterSeconds: 3_600,
    centralSchemaVersion: "distributed-central-v1",
    catalogVersionId,
    catalogSchemaVersion,
    catalogContentHash,
    catalogThroughChangeSequence,
    catalogCategories: categories,
    catalogCollectibles,
    catalogAliases,
    catalogArtifactVerificationHash: await providerReleaseCatalogPinHash({
      catalogVersionId,
      catalogSchemaVersion,
      catalogContentHash,
      catalogThroughChangeSequence: catalogThroughChangeSequence.toString(),
      categories,
      collectibles: catalogCollectibles,
      aliases: catalogAliases,
    }),
    correlationEventSequence,
    correlationSnapshotHash: await providerReleaseCorrelationSnapshotHash({
      providerId,
      categories: categoryCorrelations.map((row) => ({
        ...row,
        localEntityVersion: row.localEntityVersion.toString(),
      })),
      collectibles: collectibleCorrelations.map((row) => ({
        ...row,
        localEntityVersion: row.localEntityVersion.toString(),
      })),
      correlationEventSequence: "19",
    }),
    categoryCorrelations,
    collectibleCorrelations,
    publicProfileVersionId: "33000000-0000-4000-8000-000000000002",
    publicProfileHash: await sha256CanonicalJson(PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN, publicProvider),
    publicProvider,
  };
}

async function withCatalogCollectibles(
  source: PinnedProviderReleaseInputs,
  catalogCollectibles: PinnedProviderReleaseInputs["catalogCollectibles"],
): Promise<PinnedProviderReleaseInputs> {
  return {
    ...source,
    catalogCollectibles,
    catalogArtifactVerificationHash: await providerReleaseCatalogPinHash({
      catalogVersionId: source.catalogVersionId,
      catalogSchemaVersion: source.catalogSchemaVersion,
      catalogContentHash: source.catalogContentHash,
      catalogThroughChangeSequence: source.catalogThroughChangeSequence.toString(),
      categories: source.catalogCategories,
      collectibles: catalogCollectibles,
      aliases: source.catalogAliases,
    }),
  };
}

function pack(input: Partial<ProviderReleaseSnapshot["packs"][number]> & { id: string; name: string }) {
  return {
    id: input.id,
    categoryId: input.categoryId ?? null,
    displayName: input.name,
    description: input.description ?? null,
    packFormat: input.packFormat ?? "repack" as const,
    lifecycle: input.lifecycle ?? "active" as const,
    availability: input.availability ?? "available" as const,
    contentEvidence: input.contentEvidence ?? "complete" as const,
    priceAmount: input.priceAmount ?? null,
    priceCurrency: input.priceCurrency ?? null,
    priceUsdAmount: input.priceUsdAmount ?? null,
    priceUnavailableReason: input.priceUnavailableReason
      ?? (input.priceAmount === undefined ? "source_unavailable" : null),
    buybackRate: input.buybackRate ?? null,
    buybackSourceKind: input.buybackSourceKind ?? null,
    vendorEvAmount: input.vendorEvAmount ?? null,
    vendorEvCurrency: input.vendorEvCurrency ?? null,
    vendorEvObservedAt: input.vendorEvObservedAt ?? null,
    vendorEvUnavailableReason: input.vendorEvUnavailableReason
      ?? (input.vendorEvAmount === undefined ? "source_unavailable" : null),
    packscoutEvAmount: input.packscoutEvAmount ?? null,
    packscoutEvCurrency: input.packscoutEvCurrency ?? null,
    packscoutEvModelVersion: input.packscoutEvModelVersion ?? "model-v1",
    packscoutEvConfidencePolicyVersion: input.packscoutEvConfidencePolicyVersion ?? "policy-v1",
    packscoutEvConfidence: input.packscoutEvConfidence ?? null,
    packscoutEvDataAsOf: input.packscoutEvDataAsOf ?? null,
    packscoutEvCalculatedAt: input.packscoutEvCalculatedAt ?? null,
    packscoutEvUnavailableReason: input.packscoutEvUnavailableReason ?? "not_calculated",
    primaryImageUrl: input.primaryImageUrl ?? null,
    primaryImageAlt: input.primaryImageAlt ?? null,
    listingUrl: input.listingUrl ?? null,
    sourceUpdatedAt: input.sourceUpdatedAt ?? observedAt,
    retiredAt: input.retiredAt ?? null,
    updatedAt: input.updatedAt ?? observedAt,
  } satisfies ProviderReleaseSnapshot["packs"][number];
}

function snapshot(): ProviderReleaseSnapshot {
  return {
    providerId,
    providerKey: "fixture_provider",
    providerSchemaVersion: "distributed-provider-v1",
    throughChangeSequence: 24n,
    categories: [
      { id: local.categoryCards, parentCategoryId: null, categoryKey: "cards", displayName: "Cards", lifecycle: "active", rowVersion: 1n },
      { id: local.categoryWatches, parentCategoryId: null, categoryKey: "watches", displayName: "Watches", lifecycle: "active", rowVersion: 1n },
      { id: local.categoryArt, parentCategoryId: null, categoryKey: "art", displayName: "Art", lifecycle: "active", rowVersion: 1n },
    ],
    collectibles: [
      { id: local.card, collectibleType: "card", lifecycle: "active", rowVersion: 1n },
      { id: local.watch, collectibleType: "watch", lifecycle: "active", rowVersion: 1n },
      { id: local.art, collectibleType: "art", lifecycle: "active", rowVersion: 1n },
    ],
    aliases: [{ id: local.alias, collectibleId: local.card, normalizedName: "rookie", lifecycle: "active" }],
    packs: [
      pack({
        id: local.multiPack,
        name: "Cards Watches and Art",
        categoryId: local.categoryCards,
        priceAmount: "100.005",
        priceCurrency: "USD",
        priceUsdAmount: "100.005",
        buybackRate: "0.82505",
        buybackSourceKind: "provider",
        vendorEvAmount: "120",
        vendorEvCurrency: "USD",
        vendorEvObservedAt: observedAt,
        listingUrl: "https://fixture.example/repack/mixed",
      }),
      pack({ id: local.unavailablePack, name: "Economics Pending", contentEvidence: "unknown" }),
      pack({
        id: local.retiredPack,
        name: "Retired Pack",
        lifecycle: "retired",
        availability: "unavailable",
        retiredAt: observedAt,
      }),
    ],
    contents: [
      ["501", local.card, "top_chase", "0.1", 0],
      ["502", local.watch, "featured_chase", "0.2", 1],
      ["503", local.art, "other", null, 2],
    ].map(([suffix, collectibleId, contentRole, probability, displayOrder]) => ({
      id: `13000000-0000-4000-8000-000000000${suffix}`,
      packId: local.multiPack,
      collectibleId: collectibleId as string,
      collectibleInstanceId: `13000000-0000-4000-8000-0000000006${String(displayOrder).padStart(2, "0")}`,
      contentRole: contentRole as "top_chase" | "featured_chase" | "possible_outcome" | "other",
      probability: probability as string | null,
      evidenceKinds: ["vendor_inventory"],
      matchConfidenceBasisPoints: 9_000,
      matchConfidenceBand: "high",
      observedAt,
      displayOrder: displayOrder as number,
      lifecycle: "active",
    })),
    lastSuccessfulObservationAt: observedAt,
    providerConfigVersionId: "33000000-0000-4000-8000-000000000003",
    providerConfigExpiresAt: null,
    scheduleSeconds: 300,
    freshnessState: "fresh",
  };
}

test("mixed cards, watches, art, provisional identities, unavailable values, aliases, and retirements form one deterministic safe release", async () => {
  const central = await pin();
  const first = await buildProviderRelease({ snapshot: snapshot(), pin: central, predecessorCompleteReleaseId: null });
  const source = snapshot();
  const shuffled: ProviderReleaseSnapshot = {
    ...source,
    packs: [...source.packs].reverse(),
    contents: [...source.contents].reverse(),
    categories: [...source.categories].reverse(),
  };
  const second = await buildProviderRelease({ snapshot: shuffled, pin: central, predecessorCompleteReleaseId: null });
  assert.equal(second.descriptor.contentHash, first.descriptor.contentHash);
  assert.equal(second.descriptor.providerReleaseId, first.descriptor.providerReleaseId);
  assert.equal(first.repacks.length, 2);
  assert.equal(first.retiredRepacks.length, 1);
  assert.deepEqual(first.repacks.find(({ name }) => name === "Economics Pending")?.price, {
    displayMoney: null,
    usdComparison: { status: "unavailable", value: null, reason: "PRICE_UNAVAILABLE" },
  });
  const mixed = first.repacks.find(({ name }) => name === "Cards Watches and Art");
  assert.equal(mixed?.contentMode, "mixed");
  assert.deepEqual(mixed?.collectibleTypes, ["art", "card", "watch"]);
  assert.equal(mixed?.price.usdComparison.status === "available" && mixed.price.usdComparison.value.minorUnits, 10_001);
  assert.equal(mixed?.buyback.status === "available" && mixed.buyback.value.basisPoints, 8_251);
  assert.ok(first.collectibles.some(({ collectibleType }) => collectibleType === "art"));
  assert.equal(first.descriptor.collectibleReferenceCount, 3);
  assert.equal(first.batches.filter(({ batchKind }) => batchKind === "provider").length, 1);
  assert.deepEqual(
    first.batches
      .filter(({ batchKind }) => batchKind === "collectible")
      .flatMap(({ records }) => records)
      .map((record) => (record as { publicCollectibleId: string }).publicCollectibleId)
      .sort(),
    [artId, cardId, watchId].sort(),
  );
  const serialized = JSON.stringify(first.batches);
  for (const forbidden of [
    "collectibleInstanceId", "provider_account", "pull", "market_event", "credential",
    "runtime", "quarantine", "audit", "raw", "evidenceExpiresAt",
  ]) assert.equal(serialized.toLowerCase().includes(forbidden.toLowerCase()), false, forbidden);
});

test("top chase and display order follow governed value priority instead of source labels", async () => {
  const central = await pin();
  const repriced = await withCatalogCollectibles(
    central,
    central.catalogCollectibles.map((row) => row.publicCollectibleId === watchId
      ? {
          ...row,
          valuationAmount: "2500",
          valuationUsdAmount: "2500",
        }
      : row),
  );
  const built = await buildProviderRelease({
    snapshot: snapshot(),
    pin: repriced,
    predecessorCompleteReleaseId: null,
  });
  const repack = built.repacks.find(({ name }) =>
    name === "Cards Watches and Art"
  );
  const chases = built.chases.filter(({ publicRepackId }) =>
    publicRepackId === repack?.publicRepackId
  );
  assert.equal(repack?.topChase?.publicCollectibleId, watchId);
  assert.deepEqual(
    chases.map(({ publicCollectibleId, role, displayOrder }) => ({
      publicCollectibleId,
      role,
      displayOrder,
    })),
    [
      { publicCollectibleId: watchId, role: "top_chase", displayOrder: 0 },
      {
        publicCollectibleId: cardId,
        role: "possible_outcome",
        displayOrder: 1,
      },
    ],
  );
});

test("the cooperative build checkpoint stops large CPU loops at the caller deadline", async () => {
  const central = await pin();
  const current = snapshot();
  const aliases = Array.from({ length: 1_000 }, (_, index) => ({
    id: packscoutPublicIdentityUuid(`release-deadline-alias:${index}`),
    collectibleId: local.card,
    normalizedName: `retired-alias-${index}`,
    lifecycle: "retired" as const,
  }));
  const deadline = Object.assign(new Error("release build deadline"), {
    code: "PROVIDER_RELEASE_DEADLINE",
  });
  let checks = 0;

  await assert.rejects(
    buildProviderRelease({
      snapshot: { ...current, aliases },
      pin: central,
      predecessorCompleteReleaseId: null,
      checkpoint() {
        checks += 1;
        if (checks === 100) throw deadline;
      },
    }),
    (error: unknown) => error === deadline,
  );
  assert.equal(checks, 100);
  assert.ok(checks < aliases.length);
});

test("configured stale threshold controls public freshness independently from schedule cadence", async () => {
  const central = await pin();
  const current = snapshot();
  assert.equal(current.scheduleSeconds, 300);
  assert.equal(central.staleAfterSeconds, 3_600);
  const built = await buildProviderRelease({
    snapshot: current,
    pin: central,
    predecessorCompleteReleaseId: null,
  });
  assert.equal(built.descriptor.lastSuccessfulObservationAt, "2026-08-29T12:00:00.000Z");
  assert.equal(built.descriptor.staleAt, "2026-08-29T13:00:00.000Z");

  const laterThreshold = await buildProviderRelease({
    snapshot: current,
    pin: { ...central, staleAfterSeconds: 7_200 },
    predecessorCompleteReleaseId: built.descriptor.providerReleaseId,
  });
  assert.equal(laterThreshold.descriptor.staleAt, "2026-08-29T14:00:00.000Z");
  assert.notEqual(laterThreshold.descriptor.contentHash, built.descriptor.contentHash);
  assert.notEqual(laterThreshold.descriptor.providerReleaseId, built.descriptor.providerReleaseId);
  assert.notEqual(laterThreshold.publicEquivalenceHash, built.publicEquivalenceHash);

  await assert.rejects(
    buildProviderRelease({
      snapshot: current,
      pin: { ...central, staleAfterSeconds: 0 },
      predecessorCompleteReleaseId: null,
    }),
    (error: unknown) => error instanceof ProviderReleaseValidationError
      && error.code === "PROVIDER_FRESHNESS_INVALID",
  );
});

test("ISO source money keeps its public display exponent", () => {
  assert.deepEqual(
    publicPrice({
      amount: "100.005",
      currency: "USD",
      usdAmount: "100.005",
      unavailableReason: null,
    }),
    {
      displayMoney: { minorUnits: 10_001, currency: "USD" },
      usdComparison: {
        status: "available",
        value: { minorUnits: 10_001, currency: "USD" },
      },
    },
  );
  assert.equal(currencyMinorUnits("100.5", "JPY"), 101);
  assert.deepEqual(
    publicPrice({
      amount: "100.5",
      currency: "JPY",
      usdAmount: "0.67",
      unavailableReason: null,
    }),
    {
      displayMoney: { minorUnits: 101, currency: "JPY" },
      usdComparison: {
        status: "available",
        value: { minorUnits: 67, currency: "USD" },
      },
    },
  );
});

test("token source money stays out of public display while USD evidence remains", async () => {
  const central = await pin();
  const tokenCollectibles = central.catalogCollectibles.map((row) => (
    row.publicCollectibleId === watchId
      ? {
          ...row,
          valuationAmount: "1.25",
          valuationCurrency: "USDT",
          valuationUsdAmount: "1.25",
        }
      : row
  ));
  const tokenPin: PinnedProviderReleaseInputs = {
    ...central,
    catalogCollectibles: tokenCollectibles,
    catalogArtifactVerificationHash: await providerReleaseCatalogPinHash({
      catalogVersionId: central.catalogVersionId,
      catalogSchemaVersion: central.catalogSchemaVersion,
      catalogContentHash: central.catalogContentHash,
      catalogThroughChangeSequence: central.catalogThroughChangeSequence.toString(),
      categories: central.catalogCategories,
      collectibles: tokenCollectibles,
      aliases: central.catalogAliases,
    }),
  };
  const current = snapshot();
  const tokenSnapshot: ProviderReleaseSnapshot = {
    ...current,
    packs: current.packs.map((row) => (
      row.id === local.multiPack
        ? {
            ...row,
            priceAmount: "100.005",
            priceCurrency: "USDC",
            priceUsdAmount: "100.005",
            vendorEvAmount: "90.125",
            vendorEvCurrency: "USDT",
          }
        : row
    )),
  };
  const built = await buildProviderRelease({
    snapshot: tokenSnapshot,
    pin: tokenPin,
    predecessorCompleteReleaseId: null,
  });
  const repack = built.repacks.find(({ name }) => name === "Cards Watches and Art");
  const watch = built.chases.find(({ collectible }) => collectible.publicCollectibleId === watchId);
  assert.deepEqual(repack?.price, {
    displayMoney: null,
    usdComparison: {
      status: "available",
      value: { minorUnits: 10_001, currency: "USD" },
    },
  });
  assert.deepEqual(repack?.evEstimates.vendorReported, {
    status: "unavailable",
    displayMoney: null,
    metrics: null,
    observedAt: observedAt.toISOString(),
    reason: "CURRENCY_UNSUPPORTED",
  });
  assert.equal(watch?.collectible.valuation?.displayMoney, null);
  assert.deepEqual(watch?.collectible.valuation?.usdComparison, {
    status: "available",
    value: { minorUnits: 125, currency: "USD" },
  });
});

test("provider identity and stale soft correlations fail closed", async () => {
  const central = await pin();
  await assert.rejects(
    buildProviderRelease({
      snapshot: { ...snapshot(), providerId: "13000000-0000-4000-8000-000000000999" },
      pin: central,
      predecessorCompleteReleaseId: null,
    }),
    (error: unknown) => error instanceof ProviderReleaseValidationError
      && error.code === "PROVIDER_IDENTITY_MISMATCH",
  );
  const current = snapshot();
  const stale: ProviderReleaseSnapshot = {
    ...current,
    collectibles: current.collectibles.map((row, index) => (
      index === 0 ? { ...row, rowVersion: 2n } : row
    )),
  };
  await assert.rejects(
    buildProviderRelease({ snapshot: stale, pin: central, predecessorCompleteReleaseId: null }),
    (error: unknown) => error instanceof ProviderReleaseValidationError
      && error.code === "CORRELATION_STALE",
  );
});

test("later source mutations cannot mutate an already assembled in-memory artifact", async () => {
  const source = snapshot();
  const built = await buildProviderRelease({ snapshot: source, pin: await pin(), predecessorCompleteReleaseId: null });
  const before = JSON.stringify(built);
  const later: ProviderReleaseSnapshot = {
    ...source,
    packs: source.packs.map((row, index) => (
      index === 0 ? { ...row, displayName: "Later mutation" } : row
    )),
    contents: [],
  };
  const changed = await buildProviderRelease({
    snapshot: later,
    pin: await pin(),
    predecessorCompleteReleaseId: null,
  });
  assert.equal(JSON.stringify(built), before);
  assert.notEqual(changed.publicEquivalenceHash, built.publicEquivalenceHash);
});

test("public equivalence ignores only a private ledger advance and includes freshness", async () => {
  const central = await pin();
  const current = snapshot();
  const first = await buildProviderRelease({
    snapshot: current,
    pin: central,
    predecessorCompleteReleaseId: null,
  });
  const privateOnly = await buildProviderRelease({
    snapshot: { ...current, throughChangeSequence: current.throughChangeSequence + 1n },
    pin: central,
    predecessorCompleteReleaseId: first.descriptor.providerReleaseId,
  });
  assert.notEqual(privateOnly.descriptor.contentHash, first.descriptor.contentHash);
  assert.notEqual(privateOnly.descriptor.providerReleaseId, first.descriptor.providerReleaseId);
  assert.equal(privateOnly.publicEquivalenceHash, first.publicEquivalenceHash);

  const laterObservation = new Date(current.lastSuccessfulObservationAt.getTime() + 1_000);
  const fresher = await buildProviderRelease({
    snapshot: { ...current, lastSuccessfulObservationAt: laterObservation },
    pin: central,
    predecessorCompleteReleaseId: first.descriptor.providerReleaseId,
  });
  assert.notEqual(fresher.publicEquivalenceHash, first.publicEquivalenceHash);
});

test("predecessor lineage changes immutable identity without changing public equivalence", async () => {
  const central = await pin();
  const current = snapshot();
  const first = await buildProviderRelease({
    snapshot: current,
    pin: central,
    predecessorCompleteReleaseId: null,
  });
  const successor = await buildProviderRelease({
    snapshot: current,
    pin: central,
    predecessorCompleteReleaseId: "13000000-0000-4000-8000-000000000999",
  });
  assert.notEqual(successor.descriptor.contentHash, first.descriptor.contentHash);
  assert.notEqual(successor.descriptor.providerReleaseId, first.descriptor.providerReleaseId);
  assert.equal(successor.publicEquivalenceHash, first.publicEquivalenceHash);
});

test("configuration pins and freshness state must match the provider snapshot exactly", async () => {
  const central = await pin();
  await assert.rejects(
    buildProviderRelease({
      snapshot: {
        ...snapshot(),
        providerConfigVersionId: "33000000-0000-4000-8000-000000000999",
      },
      pin: central,
      predecessorCompleteReleaseId: null,
    }),
    (error: unknown) => error instanceof ProviderReleaseValidationError
      && error.code === "PROVIDER_CONFIG_MISMATCH",
  );
  await assert.rejects(
    buildProviderRelease({
      snapshot: { ...snapshot(), freshnessState: "unknown" },
      pin: central,
      predecessorCompleteReleaseId: null,
    }),
    (error: unknown) => error instanceof ProviderReleaseValidationError
      && error.code === "PROVIDER_FRESHNESS_INVALID",
  );
});

test("tampered public profile, catalog, and correlation pins fail closed", async () => {
  const central = await pin();
  for (const invalidPin of [
    { ...central, publicProfileHash: "b".repeat(64) },
    { ...central, catalogArtifactVerificationHash: "b".repeat(64) },
    { ...central, correlationSnapshotHash: "b".repeat(64) },
  ]) {
    await assert.rejects(
      buildProviderRelease({
        snapshot: snapshot(),
        pin: invalidPin,
        predecessorCompleteReleaseId: null,
      }),
      (error: unknown) => error instanceof ProviderReleaseValidationError
        && ["PUBLIC_PROJECTION_INVALID", "PUBLIC_REFERENCE_INVALID"].includes(error.code),
    );
  }
});

test("future observations and incoherent retirement timestamps fail closed", async () => {
  const central = await pin();
  const current = snapshot();
  const future = new Date(observedAt.getTime() + 1);
  const variants: ProviderReleaseSnapshot[] = [
    {
      ...current,
      contents: current.contents.map((row, index) => (
        index === 0 ? { ...row, observedAt: future } : row
      )),
    },
    {
      ...current,
      packs: current.packs.map((row) => (
        row.id === local.retiredPack ? { ...row, retiredAt: null } : row
      )),
    },
    {
      ...current,
      packs: current.packs.map((row) => (
        row.id === local.unavailablePack
          ? { ...row, availability: "unavailable", updatedAt: future }
          : row
      )),
    },
  ];
  for (const invalidSnapshot of variants) {
    await assert.rejects(
      buildProviderRelease({
        snapshot: invalidSnapshot,
        pin: central,
        predecessorCompleteReleaseId: null,
      }),
      (error: unknown) => error instanceof ProviderReleaseValidationError
        && error.code === "PUBLIC_PROJECTION_INVALID",
    );
  }
});

test("money pairs, explicit reasons, buyback provenance, and token currencies are fail closed", async () => {
  const central = await pin();
  const current = snapshot();
  const economics = (overrides: Partial<ProviderReleaseSnapshot["packs"][number]>) => ({
    ...current,
    packs: current.packs.map((row) => (
      row.id === local.unavailablePack ? { ...row, ...overrides } : row
    )),
  });
  for (const invalidSnapshot of [
    economics({ priceUsdAmount: "10" }),
    economics({ buybackRate: "0.5", buybackSourceKind: "mystery" }),
    economics({ priceAmount: "10", priceCurrency: "0xnot-an-address" }),
  ]) {
    await assert.rejects(
      buildProviderRelease({
        snapshot: invalidSnapshot,
        pin: central,
        predecessorCompleteReleaseId: null,
      }),
      (error: unknown) => error instanceof ProviderReleaseValidationError
        && error.code === "PUBLIC_PROJECTION_INVALID",
    );
  }

  const tokenAddress = `0x${"1".repeat(40)}`;
  const tokenRelease = await buildProviderRelease({
    snapshot: economics({
      priceAmount: "10",
      priceCurrency: tokenAddress,
      priceUnavailableReason: "currency_unsupported",
    }),
    pin: central,
    predecessorCompleteReleaseId: null,
  });
  const tokenRepack = tokenRelease.repacks.find(({ name }) => name === "Economics Pending");
  assert.deepEqual(tokenRepack?.price, {
    displayMoney: null,
    usdComparison: {
      status: "unavailable",
      value: null,
      reason: "CURRENCY_UNSUPPORTED",
    },
  });
  const vendorEstimate = tokenRepack?.evEstimates.vendorReported;
  assert.equal(
    vendorEstimate?.status === "unavailable" ? vendorEstimate.reason : null,
    "NOT_REPORTED",
  );

  const partialCollectibles = central.catalogCollectibles.map((row) => (
    row.publicCollectibleId === cardId ? { ...row, valuationType: null } : row
  ));
  await assert.rejects(
    buildProviderRelease({
      snapshot: current,
      pin: await withCatalogCollectibles(central, partialCollectibles),
      predecessorCompleteReleaseId: null,
    }),
    (error: unknown) => error instanceof ProviderReleaseValidationError
      && error.code === "PUBLIC_PROJECTION_INVALID",
  );
});

test("protected fields in a verified catalog pin cannot be silently projected away", async () => {
  const central = await pin();
  const contaminated = central.catalogCollectibles.map((row, index) => (
    index === 0 ? { ...row, providerId } : row
  ));
  await assert.rejects(
    buildProviderRelease({
      snapshot: snapshot(),
      pin: await withCatalogCollectibles(central, contaminated),
      predecessorCompleteReleaseId: null,
    }),
    (error: unknown) => error instanceof ProviderReleaseValidationError
      && error.code === "PUBLIC_PROJECTION_INVALID",
  );
});
