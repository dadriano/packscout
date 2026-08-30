import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const {
  publicRepackDetailV3Schema,
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  normalizeDataforrestEventRecordForAdapter,
  providerIdentityNamespaceByLaunchProvider,
  providerPackEvEvidenceV1Schema,
} = await tsImport(
  "@packscout/contracts",
  import.meta.url,
);
const {
  DistributedClutchpacksPublicationError,
  assertDistributedClutchpacksStableSnapshot,
  buildDistributedClutchpacksPublicationArtifacts,
  decimalTextToScaledInteger,
} = await tsImport("./distributed-clutchpacks-publication-plan.mts", import.meta.url);

const HEAD_AT = new Date("2026-08-29T21:37:36.800Z");
const PROVIDER_ID = "10000000-0000-5000-8000-000000000001";
const ORGANIZATION_ID = "30000000-0000-5000-8000-000000000001";
const READ_AT = "2026-08-29T21:38:00.000Z";

function pack(overrides = {}) {
  return {
    id: "20000000-0000-5000-8000-000000000001",
    rowVersion: 1n,
    packKey: "pokemon-mystery-pack",
    displayName: "Pokemon Mystery Pack",
    description: "A real provider pack projected without unapproved actions.",
    packFormat: "repack",
    availability: "available",
    contentEvidence: "unknown",
    priceAmount: "39.99",
    priceCurrency: "USD",
    priceUsdAmount: "39.9900",
    buybackRate: "0.82505",
    buybackSourceKind: "provider_statement",
    vendorEvAmount: "51.235",
    vendorEvCurrency: "USD",
    vendorEvObservedAt: new Date("2026-08-29T21:30:00.000Z"),
    packscoutEvModelVersion: "packscout-buyback-adjusted-ev-v1",
    packscoutEvConfidencePolicyVersion:
      "packscout-buyback-adjusted-ev-confidence-v1",
    packscoutEvDataAsOf: null,
    packscoutEvCalculatedAt: null,
    primaryImageUrl: "https://cdn.example.test/packs/pokemon.png",
    primaryImageAlt: null,
    listingUrl: null,
    sourceUpdatedAt: new Date("2026-08-29T21:35:00.000Z"),
    ...overrides,
  };
}

function facts(overrides = {}) {
  const packs = overrides.packs ?? [pack()];
  return {
    organizationId: ORGANIZATION_ID,
    providerId: PROVIDER_ID,
    providerKey: "clutchpacks",
    providerDisplayName: "ClutchPacks",
    providerLifecycle: "active",
    activeConfigVersionId: "40000000-0000-5000-8000-000000000001",
    activeConfigVersionNumber: 4n,
    activeConfigCreatedAt: new Date("2026-08-29T18:00:00.000Z"),
    staleAfterSeconds: 3_600,
    providerIdentityId: PROVIDER_ID,
    providerIdentityKey: "clutchpacks",
    runtimeProviderId: PROVIDER_ID,
    runtimeProviderKey: "clutchpacks",
    runtimeState: "idle",
    runtimeConfigVersionId: "40000000-0000-5000-8000-000000000001",
    runtimeConfigVersionNumber: 4n,
    runningRunCount: 0,
    queuedRunCount: 2,
    activeImportLeaseCount: 0,
    latestSourceHeadRunId: "50000000-0000-5000-8000-000000000001",
    latestSourceHeadConfigVersionId:
      "40000000-0000-5000-8000-000000000001",
    latestSourceHeadConfigVersionNumber: 4n,
    latestSourceHeadFinishedAt: HEAD_AT,
    promotionSequence: 78_502n,
    promotionChangeCount: 78_502n,
    minimumPromotionSequence: 1n,
    maximumPromotionSequence: 78_502n,
    maximumPromotionChangedAt: new Date("2026-08-29T21:37:00.000Z"),
    activePackCount: packs.length,
    activeCollectibleCount: 6_655,
    activePackContentCount: 0,
    maximumPackSourceUpdatedAt: packs.reduce(
      (latest, candidate) =>
        candidate.sourceUpdatedAt > latest ? candidate.sourceUpdatedAt : latest,
      packs[0].sourceUpdatedAt,
    ),
    packs,
    ...overrides,
  };
}

function packWithEvEvidence() {
  const manifest = dataforrestClutchpacksDistributedSourceAdapterManifest;
  const observation = normalizeDataforrestEventRecordForAdapter({
    stream: "catalog",
    platform: "clutchpacks",
    entity: "pack",
    record_id: "promotion-pack",
    occurred_at: "2026-08-29T21:35:00.000Z",
    collected_at: "2026-08-29T21:36:00.000Z",
    first_seen_at: "2026-08-29T20:00:00.000Z",
    available: true,
    data: {
      name: "Promotion Pack",
      price: { price_amount: "100.00", currency: { code: "USD", decimals: 2 } },
      average_value: "900.00",
      series: {
        description: "Instant buyback offer of 90%. One graded or authenticated card per pack.",
      },
      price_bucket_odds: [
        {
          bucket_id: "commons", name: "Commons", drawable_count: 3,
          min_price: "$20", max_price: "$60",
        },
        {
          bucket_id: "chasers", name: "Chasers", drawable_count: 1,
          min_price: "$100", max_price: "$220",
        },
      ],
      native_actor: "protected-promotion-source-marker",
    },
  }, "clutchpacks", "protected-source-reference", manifest.adapterVersion);
  const normalized = observation.providerFacts;
  assert.equal(normalized.kind, "pack");
  const evidence = providerPackEvEvidenceV1Schema.parse({
    schemaVersion: "provider_pack_ev_evidence_v1",
    organizationId: ORGANIZATION_ID,
    providerId: PROVIDER_ID,
    providerKey: "clutchpacks",
    providerRecordId: "promotion-pack",
    recordIdScopeKey: "catalog-pack-v1",
    sourceTypeKey: manifest.sourceTypeKey,
    sourceAdapterVersion: manifest.adapterVersion,
    normalizedContractVersion: manifest.normalizedContractVersion,
    mapperKey: "clutchpacks-provider-observation",
    mapperVersion: "1",
    identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.clutchpacks,
    effectiveAt: observation.effectiveAt,
    collectedAt: observation.collectedAt,
    price: normalized.price,
    buybackPercent: normalized.buybackPercent,
    drawCount: normalized.drawCount,
    evInput: normalized.evInput,
  });
  return pack({
    packKey: "pack:promotion-pack",
    rowVersion: 2n,
    priceAmount: "100.00",
    priceUsdAmount: "100.0000",
    buybackRate: "0.9",
    vendorEvAmount: "900.00",
    evInputEvidence: evidence,
  });
}

async function build(overrides = {}, readAt = READ_AT) {
  return await buildDistributedClutchpacksPublicationArtifacts(
    assertDistributedClutchpacksStableSnapshot(facts(overrides)),
    readAt,
  );
}

function v3RepackDetails(plan) {
  return plan.batches
    .filter(({ kind }) => kind === "repacks")
    .flatMap(({ records }) =>
      records.map((record) => publicRepackDetailV3Schema.parse(record)),
    );
}

test("scales canonical provider decimals exactly with half-up rounding", () => {
  assert.equal(decimalTextToScaledInteger("39.9900", 2), 3_999);
  assert.equal(decimalTextToScaledInteger("51.235", 2), 5_124);
  assert.equal(decimalTextToScaledInteger("0.82505", 4), 8_251);
  assert.throws(
    () => decimalTextToScaledInteger("-1.00", 2),
    (error) =>
      error instanceof DistributedClutchpacksPublicationError &&
      error.code === "PUBLIC_DECIMAL_INVALID",
  );
});

test("one settled snapshot builds matching manifest and frontend releases", async () => {
  const second = pack({
    id: "20000000-0000-5000-8000-000000000002",
    packKey: "sports-mystery-pack",
    displayName: "Sports Mystery Pack",
    availability: "sold_out",
    buybackRate: null,
    buybackSourceKind: null,
    vendorEvAmount: null,
    vendorEvCurrency: null,
    vendorEvObservedAt: null,
    primaryImageUrl: "https://assets.example.test/packs/sports.png",
  });
  const artifacts = await build({ packs: [second, pack()] });

  assert.deepEqual(artifacts.providerPlan.counts, {
    vendors: 1,
    categories: 0,
    collectibles: 0,
    repacks: 2,
    repackChases: 0,
    searchShards: 1,
  });
  assert.equal(artifacts.v3Plan.manifest.counts.repacks, 2);
  assert.equal(artifacts.v3Plan.manifest.counts.categories, 0);
  assert.equal(artifacts.v3Plan.manifest.counts.collectibles, 0);
  assert.equal(artifacts.v3Plan.manifest.counts.chases, 0);
  const manifestIds = artifacts.projection.repacks
    .map(({ publicRepackId }) => publicRepackId)
    .sort();
  const frontendDetails = v3RepackDetails(artifacts.v3Plan);
  assert.deepEqual(
    frontendDetails.map(({ publicRepackId }) => publicRepackId).sort(),
    manifestIds,
  );
  assert.ok(frontendDetails.every(({ evEstimates }) =>
    evEstimates.packScout.status === "unavailable"));
  assert.ok(artifacts.projection.repacks.every((detail) =>
    detail.actions.repackLink === undefined &&
    detail.actions.promo === undefined &&
    detail.actionAvailability.repackLink === false &&
    detail.actionAvailability.promo === false));
  assert.deepEqual(
    artifacts.approvedConfiguration.publicAssetOrigins,
    ["https://assets.example.test", "https://cdn.example.test"],
  );
});

test("queued commands do not change an otherwise stable publication snapshot", () => {
  const first = assertDistributedClutchpacksStableSnapshot(
    facts({ queuedRunCount: 0 }),
  );
  const second = assertDistributedClutchpacksStableSnapshot(
    facts({ queuedRunCount: 7 }),
  );
  assert.equal(second.stabilityFingerprint, first.stabilityFingerprint);
});

for (const [name, override] of [
  ["running import", { runningRunCount: 1 }],
  ["active import lease", { activeImportLeaseCount: 1 }],
  ["non-contiguous promotion ledger", { promotionChangeCount: 78_501n }],
  ["pack contents requiring correlations", { activePackContentCount: 1 }],
  ["changing pack after source head", {
    maximumPackSourceUpdatedAt: new Date("2026-08-29T21:38:00.000Z"),
  }],
]) {
  test(`refuses ${name}`, () => {
    assert.throws(
      () => assertDistributedClutchpacksStableSnapshot(facts(override)),
      (error) =>
        error instanceof DistributedClutchpacksPublicationError &&
        error.code === "CLUTCHPACKS_SNAPSHOT_INELIGIBLE",
    );
  });
}

test("refuses an unapproved provider listing URL", async () => {
  await assert.rejects(
    build({ packs: [pack({ listingUrl: "https://clutchpacks.example/pack" })] }),
    (error) =>
      error instanceof DistributedClutchpacksPublicationError &&
      error.code === "PUBLIC_ACTION_UNAPPROVED",
  );
});

test("promotion calculates buyback EV from retained odds and publishes a rankable V3 pack", async () => {
  const input = packWithEvEvidence();
  const artifacts = await build({ packs: [input] });
  const [detail] = v3RepackDetails(artifacts.v3Plan);
  const ev = detail.evEstimates.packScout;
  assert.equal(ev.status, "current");
  assert.deepEqual(ev.metrics.grossEvMoney, { minorUnits: 6_300, currency: "USD" });
  assert.deepEqual(ev.metrics.evDollars, { minorUnits: -3_700, currency: "USD" });
  assert.equal(ev.metrics.grossReturnBasisPoints, 6_300);
  assert.equal(ev.metrics.evPercentBasisPoints, -3_700);
  assert.equal(ev.dataAsOf.observedAt, input.evInputEvidence.collectedAt);
  assert.equal(ev.calculatedAt, READ_AT);
  assert.equal(detail.evEstimates.vendorReported.sourceMoney.minorUnits, 90_000);
  assert.equal(artifacts.v3Plan.manifest.counts.repacks, 1);
  assert.equal(input.packscoutEvCalculatedAt, null);
  const publicPlan = JSON.stringify(artifacts.v3Plan);
  for (const privateValue of [
    ORGANIZATION_ID, PROVIDER_ID, input.id,
    "protected-promotion-source-marker", "protected-source-reference",
  ]) assert.equal(publicPlan.includes(privateValue), false);
});

test("a fixed promotion clock is repeatable and a later promotion cannot refresh source age", async () => {
  const input = { packs: [packWithEvEvidence()] };
  const first = await build(input);
  const replay = await build(input);
  assert.deepEqual(replay.v3Plan, first.v3Plan);
  const expired = await build(input, "2026-08-29T22:37:00.000Z");
  const [detail] = v3RepackDetails(expired.v3Plan);
  assert.equal(detail.evEstimates.packScout.status, "unavailable");
  assert.equal(detail.evEstimates.packScout.reason, "SOURCE_DATA_STALE");
  assert.equal(detail.evEstimates.packScout.dataAsOf.observedAt, "2026-08-29T21:36:00.000Z");
});

test("missing buyback or incomplete odds remain unavailable through promotion", async () => {
  const missingBuyback = packWithEvEvidence();
  missingBuyback.buybackRate = null;
  missingBuyback.buybackSourceKind = null;
  missingBuyback.evInputEvidence.buybackPercent = { state: "absent" };
  missingBuyback.evInputEvidence.evInput.value.buybackPercent = null;
  const incompleteOdds = packWithEvEvidence();
  incompleteOdds.evInputEvidence.evInput.value.buckets[0].probability = null;
  const [withoutBuyback] = v3RepackDetails((await build({ packs: [missingBuyback] })).v3Plan);
  const [withoutOdds] = v3RepackDetails((await build({ packs: [incompleteOdds] })).v3Plan);
  assert.equal(withoutBuyback.evEstimates.packScout.status, "unavailable");
  assert.equal(withoutBuyback.evEstimates.packScout.reason, "BUYBACK_UNAVAILABLE");
  assert.equal(withoutOdds.evEstimates.packScout.status, "unavailable");
  assert.equal(withoutOdds.evEstimates.packScout.metrics, null);
});

test("present malformed evidence and mismatched canonical economics stop publication", async () => {
  for (const evInputEvidence of [null, {}, { raw: "protected-promotion-source-marker" }]) {
    await assert.rejects(
      build({ packs: [pack({ evInputEvidence })] }),
      (error) => error.code === "EVIDENCE_INVALID",
    );
  }
  const input = packWithEvEvidence();
  input.priceAmount = "101";
  input.priceUsdAmount = "101";
  await assert.rejects(
    build({ packs: [input] }),
    (error) => error.code === "EVIDENCE_SNAPSHOT_MISMATCH",
  );
});

test("public positive-EV policy still applies to promotion calculations", async () => {
  const input = packWithEvEvidence();
  for (const bucket of input.evInputEvidence.evInput.value.buckets) {
    bucket.lowerValue = 200;
    bucket.upperValue = 400;
  }
  const [detail] = v3RepackDetails((await build({ packs: [input] })).v3Plan);
  assert.equal(detail.evEstimates.packScout.status, "unavailable");
  assert.equal(detail.evEstimates.packScout.reason, "CALCULATION_UNAVAILABLE");
  assert.equal(detail.evEstimates.packScout.metrics, null);
});

test("snapshot confirmation binds retained odds, canonical economics, and row version", () => {
  const initial = packWithEvEvidence();
  const before = assertDistributedClutchpacksStableSnapshot(facts({ packs: [initial] }));
  const oddsChanged = structuredClone(initial);
  oddsChanged.evInputEvidence.evInput.value.buckets[0].upperValue += 1;
  for (const changed of [
    oddsChanged,
    { ...initial, priceAmount: "101", priceUsdAmount: "101" },
    { ...initial, rowVersion: initial.rowVersion + 1n },
    { ...initial, buybackRate: null, buybackSourceKind: null },
  ]) {
    const after = assertDistributedClutchpacksStableSnapshot(facts({ packs: [changed] }));
    assert.notEqual(after.stabilityFingerprint, before.stabilityFingerprint);
  }
});

test("promotion refuses a clock before its settled snapshot", async () => {
  await assert.rejects(
    build({}, "2026-08-29T21:37:00.000Z"),
    (error) => error.code === "CLUTCHPACKS_PROMOTION_CLOCK_INVALID",
  );
});

test("a sold-out pack without proven EV history does not block available packs", async () => {
  const available = packWithEvEvidence();
  const soldOut = packWithEvEvidence();
  soldOut.id = "20000000-0000-5000-8000-000000000002";
  soldOut.packKey = "pack:sold-out-pack";
  soldOut.availability = "sold_out";
  soldOut.evInputEvidence.providerRecordId = "sold-out-pack";
  const details = v3RepackDetails((await build({ packs: [available, soldOut] })).v3Plan);
  assert.equal(details.find(({ availability }) => availability === "available")
    .evEstimates.packScout.status, "current");
  const historical = details.find(({ availability }) => availability === "sold_out");
  assert.equal(historical.evEstimates.packScout.status, "unavailable");
  assert.equal(historical.evEstimates.packScout.reason, "SOURCE_EVIDENCE_UNAVAILABLE");
});

test("snapshot confirmation detects a central public-provider rename", () => {
  const before = assertDistributedClutchpacksStableSnapshot(facts());
  const after = assertDistributedClutchpacksStableSnapshot(facts({ providerDisplayName: "Renamed ClutchPacks" }));
  assert.notEqual(after.stabilityFingerprint, before.stabilityFingerprint);
});
