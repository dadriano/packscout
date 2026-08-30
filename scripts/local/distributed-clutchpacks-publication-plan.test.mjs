import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { publicRepackDetailV3Schema } = await tsImport(
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

function pack(overrides = {}) {
  return {
    id: "20000000-0000-5000-8000-000000000001",
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
    organizationId: "30000000-0000-5000-8000-000000000001",
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

async function build(overrides = {}) {
  return await buildDistributedClutchpacksPublicationArtifacts(
    assertDistributedClutchpacksStableSnapshot(facts(overrides)),
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
