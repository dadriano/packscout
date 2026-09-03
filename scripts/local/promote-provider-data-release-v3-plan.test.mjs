import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  APPROVED_PUBLISH_DEPLOYMENTS,
  PromoteProviderDataReleaseV3Error,
  assembleDataReleaseV3Plan,
  basisPointsFromRate,
  boundDataReleaseV3ActivationPort,
  canonicalTimestamp,
  carryForwardActiveRelease,
  minorUnitsFromDecimal,
  parsePromoteProviderArguments,
  projectProviderPacks,
  publicBuybackFromPack,
  publicCollectibleTypes,
  publicPriceFromPack,
  repackDetailFromPack,
  resolvePublicCategories,
  uuidFromSha256,
  vendorReportedEvFromPack,
} from "./promote-provider-data-release-v3-plan.mjs";

const READ_AT = "2026-09-03T20:00:00.000Z";
const VERSIONS = Object.freeze({
  methodVersion: "packscout-buyback-adjusted-ev-v1",
  confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1",
  publicEvPolicyVersion: "packscout-public-ev-nonpositive-v1",
  schemaVersion: "data_release_v3",
  searchAlgorithmVersion: "repack_ev_search_v3",
});

function identity(name) {
  const hex = createHash("sha256").update(name).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256CanonicalJson(domain, value) {
  return createHash("sha256")
    .update(canonicalJson({ domain, value }))
    .digest("hex");
}

const HASHING = Object.freeze({
  sha256CanonicalJson,
  canonicalJson,
  domains: {
    batch: "test.batch",
    batchChain: "test.batch-chain",
    entityChain: "test.entity-chain",
    content: "test.content",
    releaseId: "test.release-id",
    fingerprint: "test.fingerprint",
  },
  versions: VERSIONS,
  limits: {
    batchRecords: 100,
    repackBatchRecords: 32,
    repacks: 1_000,
    categories: 512,
    collectibles: 20_000,
    chases: 50_000,
  },
  emptyChainHash: "0".repeat(64),
});

const PLATFORM = Object.freeze({
  platformKey: "phygitals",
  providerId: "5034af05-8976-5da8-85bb-2d6eac02515c",
  organizationId: "3c9fa4d3-fe16-569c-8cfa-b4a44c63eb4a",
  publicVendorId: identity("vendor:phygitals"),
  displayName: "Phygitals",
  logoUrl: null,
});

function neonPack(overrides = {}) {
  return {
    id: "69742918-cfed-44de-8f8a-fdd1314ec295",
    pack_key: "pack:black-football-pack",
    display_name: "Black Pack",
    description: null,
    pack_format: "repack",
    availability: "available",
    content_evidence: "unknown",
    lifecycle: "active",
    category_id: "c346c4ac-b833-468d-a9e9-175fa652ef18",
    price_amount: "2500.000000000000000000",
    price_currency: "USD",
    price_usd_amount: "2500.000000000000000000",
    buyback_rate: "0.900000000000000000",
    vendor_ev_amount: "2587.470000000000000000",
    vendor_ev_currency: "USD",
    vendor_ev_observed_at: new Date("2026-09-03T06:36:09.000Z"),
    primary_image_url:
      "https://xexhjcyxgwxfopyobhmk.supabase.co/storage/v1/object/public/images/a.webp",
    primary_image_alt: null,
    listing_url: null,
    source_updated_at: new Date("2026-09-03T06:36:09.000Z"),
    ...overrides,
  };
}

function carriedCategory(key, name, { parent = null, kind = "vertical", order = 0 } = {}) {
  const publicCategoryId = identity(`carried:${key}`);
  return {
    publicCategoryId,
    parentPublicCategoryId: parent?.publicCategoryId ?? null,
    categoryKey: key,
    name,
    kind,
    depth: parent === null ? 0 : parent.depth + 1,
    pathPublicCategoryIds:
      parent === null
        ? [publicCategoryId]
        : [...parent.pathPublicCategoryIds, publicCategoryId],
    displayOrder: order,
  };
}

const SPORTS = carriedCategory("sports", "Sports", { order: 0 });
const TCG = carriedCategory("trading-card-games", "Trading card games", { order: 1 });
const FOOTBALL = carriedCategory("football", "Football", { parent: SPORTS, kind: "sport", order: 12 });
const POKEMON = carriedCategory("pokemon", "Pokémon", { parent: TCG, kind: "franchise", order: 22 });

function hasCode(code) {
  return (error) =>
    error instanceof PromoteProviderDataReleaseV3Error && error.code === code;
}

test("argument parsing requires a platform and a carry-forward source", () => {
  assert.throws(() => parsePromoteProviderArguments([]), hasCode("PLATFORM_REQUIRED"));
  assert.throws(
    () => parsePromoteProviderArguments(["--platform", "phygitals"]),
    hasCode("CONVEX_DEPLOYMENT_REQUIRED"),
  );
  assert.throws(
    () => parsePromoteProviderArguments(["--platform", "phygitals", "--replace-catalog", "--publish"]),
    hasCode("CONVEX_DEPLOYMENT_REQUIRED"),
  );
  assert.throws(
    () => parsePromoteProviderArguments(["--platform", "Phygitals!", "--replace-catalog"]),
    hasCode("PLATFORM_KEY_INVALID"),
  );
  assert.throws(
    () => parsePromoteProviderArguments(["--platform", "phygitals", "--bogus"]),
    hasCode("ARGUMENT_UNKNOWN"),
  );
  const options = parsePromoteProviderArguments([
    "--platform", "phygitals", "--platform", "phygitals", "--platform", "courtyard",
    "--convex-deployment", "shiny-newt-310", "--include-priceless",
  ]);
  assert.deepEqual(options.platformKeys, ["phygitals", "courtyard"]);
  assert.equal(options.convexDeployment, "shiny-newt-310");
  assert.equal(options.publish, false);
  assert.equal(options.includePriceless, true);
  assert.equal(
    parsePromoteProviderArguments(["--platform", "phygitals", "--export-dir", "/tmp/x"]).exportDir,
    "/tmp/x",
  );
});

test("--publish is pinned to the approved deployments; dry runs may read any", () => {
  assert.deepEqual([...APPROVED_PUBLISH_DEPLOYMENTS], ["shiny-newt-310"]);
  assert.throws(
    () => parsePromoteProviderArguments(["--platform", "phygitals", "--convex-deployment", "abundant-puffin-373", "--publish"]),
    hasCode("PUBLISH_TARGET_NOT_APPROVED"),
  );
  assert.throws(
    () => parsePromoteProviderArguments(["--platform", "phygitals", "--convex-deployment", "prod-like-name", "--publish", "--replace-catalog"]),
    hasCode("PUBLISH_TARGET_NOT_APPROVED"),
  );
  assert.equal(
    parsePromoteProviderArguments(["--platform", "phygitals", "--convex-deployment", "abundant-puffin-373"]).publish,
    false,
  );
  assert.equal(
    parsePromoteProviderArguments(["--platform", "phygitals", "--convex-deployment", "shiny-newt-310", "--publish"]).publish,
    true,
  );
  assert.equal(
    parsePromoteProviderArguments(
      ["--platform", "phygitals", "--convex-deployment", "lab-deployment", "--publish"],
      { approvedPublishDeployments: ["lab-deployment"] },
    ).convexDeployment,
    "lab-deployment",
  );
});

function fakePublication(states) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    port: {
      async activeState() {
        calls.push("activeState");
        return states[Math.min(reads++, states.length - 1)];
      },
      async status(id) { calls.push(`status:${id}`); return { publicReleaseId: id }; },
      async start(request) { calls.push("start"); return { operationId: request.operationId }; },
      async applyBatch(request) { calls.push(`batch:${request.batchIndex}`); return {}; },
      async finalize() { calls.push("finalize"); return {}; },
      async activate(request) { calls.push(`activate:${request.expectedActivePublicReleaseId}`); return { ok: true }; },
      async rollback() { calls.push("rollback"); return {}; },
      async refreshProviderObservation(request) { calls.push(`observe:${request.vendorKey}`); return {}; },
    },
  };
}

test("the bound activation port refuses a moved pointer and admits the expected one", async () => {
  const plan = { publicReleaseId: "11111111-1111-8111-8111-111111111111", releaseFingerprint: "a".repeat(64) };
  const predecessor = "76777a70-73db-86ec-873c-5eef784d0d83";
  const state = (active, previous = null) => ({
    activeRelease: active === null ? null : { publicReleaseId: active },
    previousRelease: previous === null ? null : { publicReleaseId: previous },
  });

  // Happy path: predecessor still active before start, plan active with the
  // predecessor retained after activation.
  const happy = fakePublication([state(predecessor), state(plan.publicReleaseId, predecessor)]);
  const bound = boundDataReleaseV3ActivationPort(happy.port, plan, predecessor);
  assert.equal((await bound.activeState()).activeRelease.publicReleaseId, predecessor);
  await bound.start({ operationId: "s" });
  await bound.applyBatch({ batchIndex: 0 });
  await bound.finalize({});
  await bound.status(plan.publicReleaseId);
  await bound.activate({ ...plan, expectedActivePublicReleaseId: predecessor });
  assert.equal((await bound.activeState()).activeRelease.publicReleaseId, plan.publicReleaseId);
  await bound.refreshProviderObservation({ vendorKey: "phygitals" });
  assert.deepEqual(happy.calls, [
    "activeState", "start", "batch:0", "finalize", `status:${plan.publicReleaseId}`,
    `activate:${predecessor}`, "activeState", "observe:phygitals",
  ]);

  // Someone activated another release before the publisher's first read.
  const moved = fakePublication([state("22222222-2222-8222-8222-222222222222", predecessor)]);
  await assert.rejects(
    boundDataReleaseV3ActivationPort(moved.port, plan, predecessor).activeState(),
    hasCode("ACTIVE_POINTER_MOVED"),
  );

  // The publisher discovered a newer pointer and built its activate request
  // against it: refused before any request is sent.
  const drifted = fakePublication([state(predecessor)]);
  const driftedPort = boundDataReleaseV3ActivationPort(drifted.port, plan, predecessor);
  await assert.rejects(
    driftedPort.activate({ ...plan, expectedActivePublicReleaseId: "22222222-2222-8222-8222-222222222222" }),
    hasCode("ACTIVE_POINTER_MOVED"),
  );
  await assert.rejects(
    driftedPort.activate({ publicReleaseId: plan.publicReleaseId, releaseFingerprint: "b".repeat(64), expectedActivePublicReleaseId: predecessor }),
    hasCode("ACTIVE_POINTER_MOVED"),
  );
  assert.deepEqual(drifted.calls, []);

  // A genesis catalog binds to "no release" the same way.
  const genesis = fakePublication([state(null), state(plan.publicReleaseId, null)]);
  const genesisPort = boundDataReleaseV3ActivationPort(genesis.port, plan, null);
  assert.equal((await genesisPort.activeState()).activeRelease, null);
  await genesisPort.activate({ ...plan, expectedActivePublicReleaseId: null });
  assert.equal((await genesisPort.activeState()).activeRelease.publicReleaseId, plan.publicReleaseId);

  // Read-back after activation must show the plan over the bound predecessor.
  const readBack = fakePublication([state(predecessor), state(plan.publicReleaseId, "33333333-3333-8333-8333-333333333333")]);
  const readBackPort = boundDataReleaseV3ActivationPort(readBack.port, plan, predecessor);
  await readBackPort.activeState();
  await readBackPort.activate({ ...plan, expectedActivePublicReleaseId: predecessor });
  await assert.rejects(readBackPort.activeState(), hasCode("ACTIVE_POINTER_MOVED"));
  await assert.rejects(readBackPort.rollback(), hasCode("ACTIVE_POINTER_MOVED"));
});

test("decimal text becomes exact minor units and basis points", () => {
  assert.equal(minorUnitsFromDecimal("2500.000000000000000000"), 250_000);
  assert.equal(minorUnitsFromDecimal("25.76"), 2_576);
  assert.equal(minorUnitsFromDecimal("0.005"), 1);
  assert.equal(minorUnitsFromDecimal("0.285"), 29); // exact half-up, no float drift
  assert.equal(minorUnitsFromDecimal("1.004999"), 100);
  assert.equal(minorUnitsFromDecimal("7"), 700);
  assert.equal(minorUnitsFromDecimal(19.99), 1_999);
  assert.equal(minorUnitsFromDecimal(null), null);
  assert.equal(minorUnitsFromDecimal("-1"), null);
  assert.equal(minorUnitsFromDecimal("abc"), null);
  assert.equal(minorUnitsFromDecimal("1e3"), null);
  assert.equal(basisPointsFromRate("0.900000000000000000"), 9_000);
  assert.equal(basisPointsFromRate("0.846"), 8_460);
  assert.equal(basisPointsFromRate("0.12345"), 1_235);
  assert.equal(basisPointsFromRate("1"), 10_000);
  assert.equal(basisPointsFromRate("1.5"), null);
  assert.equal(basisPointsFromRate(null), null);
  assert.equal(canonicalTimestamp(new Date("2026-09-03T06:36:09.000Z")), "2026-09-03T06:36:09.000Z");
  assert.equal(canonicalTimestamp("not a date"), null);
});

test("price, buyback and vendor EV follow the public availability shapes", () => {
  assert.deepEqual(publicPriceFromPack(neonPack()), {
    displayMoney: { minorUnits: 250_000, currency: "USD" },
    usdComparison: { status: "available", value: { minorUnits: 250_000, currency: "USD" } },
  });
  // A USD price without a stored USD normalization is its own comparison.
  assert.deepEqual(publicPriceFromPack(neonPack({ price_usd_amount: null })), {
    displayMoney: { minorUnits: 250_000, currency: "USD" },
    usdComparison: { status: "available", value: { minorUnits: 250_000, currency: "USD" } },
  });
  // No price at all.
  assert.deepEqual(
    publicPriceFromPack(neonPack({ price_usd_amount: null, price_amount: null, price_currency: null })),
    {
      displayMoney: null,
      usdComparison: { status: "unavailable", value: null, reason: "PRICE_UNAVAILABLE" },
    },
  );
  // A non-ISO display currency keeps the USD comparison but drops display money.
  assert.deepEqual(
    publicPriceFromPack(neonPack({ price_currency: "USDC", price_amount: "2500" })).displayMoney,
    null,
  );
  // A foreign display currency keeps its own minor units beside the USD value.
  assert.deepEqual(
    publicPriceFromPack(neonPack({ price_currency: "EUR", price_amount: "2300", price_usd_amount: "2500" })),
    {
      displayMoney: { minorUnits: 230_000, currency: "EUR" },
      usdComparison: { status: "available", value: { minorUnits: 250_000, currency: "USD" } },
    },
  );
  // A known foreign price with no USD normalization is still displayed.
  assert.deepEqual(
    publicPriceFromPack(neonPack({ price_currency: "EUR", price_amount: "2300", price_usd_amount: null })),
    {
      displayMoney: { minorUnits: 230_000, currency: "EUR" },
      usdComparison: { status: "unavailable", value: null, reason: "CURRENCY_UNSUPPORTED" },
    },
  );
  assert.deepEqual(publicBuybackFromPack(neonPack()), { kind: "uniform_rate", rateBasisPoints: 9_000 });
  assert.deepEqual(publicBuybackFromPack(neonPack({ buyback_rate: null })), { kind: "not_documented" });
  assert.deepEqual(publicBuybackFromPack(neonPack({ buyback_rate: "1.5" })), { kind: "unavailable" });
  assert.deepEqual(vendorReportedEvFromPack(neonPack()), {
    status: "available",
    sourceMoney: { minorUnits: 258_747, currency: "USD" },
    usdComparison: { status: "available", value: { minorUnits: 258_747, currency: "USD" } },
    observedAt: "2026-09-03T06:36:09.000Z",
  });
  assert.deepEqual(vendorReportedEvFromPack(neonPack({ vendor_ev_amount: null })), {
    status: "unavailable",
    sourceMoney: null,
    usdComparison: null,
    observedAt: null,
    reason: "NOT_REPORTED",
  });
  assert.equal(
    vendorReportedEvFromPack(neonPack({ vendor_ev_currency: "SOL" })).usdComparison.reason,
    "CURRENCY_UNSUPPORTED",
  );
});

test("a rich Neon pack projects to a complete public repack detail", () => {
  const detail = repackDetailFromPack({
    pack: neonPack(),
    platform: PLATFORM,
    readAt: READ_AT,
    versions: VERSIONS,
    identity,
    categoryChain: [SPORTS, FOOTBALL],
    collectibleTypes: ["card"],
  });
  assert.equal(detail.publicRepackId, identity("repack:phygitals:pack:black-football-pack"));
  assert.equal(detail.publicVendorId, PLATFORM.publicVendorId);
  assert.equal(detail.vendorKey, "phygitals");
  assert.equal(detail.name, "Black Pack");
  assert.equal(detail.format, "repack");
  assert.equal(detail.contentMode, "unknown");
  assert.equal(detail.availability, "available");
  assert.deepEqual(
    detail.categories.map(({ label }) => label).sort(),
    ["Football", "Sports"],
  );
  assert.deepEqual(
    detail.categories,
    [...detail.categories].sort((left, right) =>
      left.publicCategoryId < right.publicCategoryId ? -1 : 1,
    ),
  );
  assert.deepEqual(detail.buyback, { kind: "uniform_rate", rateBasisPoints: 9_000 });
  assert.deepEqual(detail.evEstimates.packScout, {
    status: "unavailable",
    methodVersion: VERSIONS.methodVersion,
    confidencePolicyVersion: VERSIONS.confidencePolicyVersion,
    metrics: null,
    confidence: null,
    calculatedAt: READ_AT,
    dataAsOf: { state: "unknown_source_time", observedAt: null },
    reason: "SOURCE_EVIDENCE_UNAVAILABLE",
  });
  assert.deepEqual(detail.primaryImage, {
    url: "https://xexhjcyxgwxfopyobhmk.supabase.co/storage/v1/object/public/images/a.webp",
    alt: "Black Pack",
  });
  assert.equal(detail.topChase, null);
  assert.deepEqual(detail.contentSummary, {
    knownCollectibleCount: 0,
    chaseCount: 0,
    categoryCount: 2,
    collectibleTypeCount: 1,
    evidenceCompleteness: "unknown",
    probabilityCoverageBasisPoints: null,
  });
  assert.deepEqual(detail.actions, {});
  assert.deepEqual(detail.actionAvailability, { promo: false, repackLink: false });
  assert.equal(detail.sourceUpdatedAt, "2026-09-03T06:36:09.000Z");
  assert.equal(detail.description, null);
});

test("purchase links appear only for available packs with an https listing", () => {
  const withLink = repackDetailFromPack({
    pack: neonPack({ listing_url: "https://Phygitals.example/packs/black" }),
    platform: PLATFORM, readAt: READ_AT, versions: VERSIONS, identity,
    categoryChain: [], collectibleTypes: ["card"],
  });
  assert.deepEqual(withLink.actions, {
    repackLink: {
      listingUrl: "https://Phygitals.example/packs/black",
      listingHost: "phygitals.example",
      referralParameters: [],
    },
  });
  assert.equal(withLink.actionAvailability.repackLink, true);
  const soldOut = repackDetailFromPack({
    pack: neonPack({ listing_url: "https://phygitals.example/packs/black", availability: "sold_out" }),
    platform: PLATFORM, readAt: READ_AT, versions: VERSIONS, identity,
    categoryChain: [], collectibleTypes: ["card"],
  });
  assert.equal(soldOut.availability, "sold_out");
  assert.deepEqual(soldOut.actions, {});
  const insecure = repackDetailFromPack({
    pack: neonPack({ listing_url: "http://phygitals.example/packs/black", primary_image_url: "http://x/y.png" }),
    platform: PLATFORM, readAt: READ_AT, versions: VERSIONS, identity,
    categoryChain: [], collectibleTypes: ["card"],
  });
  assert.deepEqual(insecure.actions, {});
  assert.equal(insecure.primaryImage, null);
});

test("packs without a USD price are skipped unless asked for", () => {
  const packs = [
    neonPack(),
    neonPack({ pack_key: "pack:thin", display_name: "Thin", category_id: null, price_usd_amount: null, price_amount: null, price_currency: null }),
    neonPack({ pack_key: "pack:retired", lifecycle: "retired" }),
    // A native USD price with no stored USD normalization is still a USD price.
    neonPack({ pack_key: "pack:usd-native", display_name: "USD native", price_usd_amount: null, price_amount: "40", price_currency: "USD" }),
    // A foreign price without a USD normalization is not comparable.
    neonPack({ pack_key: "pack:eur-only", display_name: "EUR only", price_usd_amount: null, price_amount: "40", price_currency: "EUR" }),
  ];
  const chains = new Map([[packs[0].category_id, [SPORTS, FOOTBALL]]]);
  const strict = projectProviderPacks({
    platform: PLATFORM, packs, chainByProviderCategoryId: chains, collectibleTypes: ["card"],
    readAt: READ_AT, versions: VERSIONS, identity, includePriceless: false,
  });
  assert.deepEqual(strict.repacks.map(({ name }) => name), ["Black Pack", "USD native"]);
  assert.deepEqual(strict.repacks[1].price.usdComparison, {
    status: "available", value: { minorUnits: 4_000, currency: "USD" },
  });
  assert.deepEqual(strict.skipped, [
    { packKey: "pack:thin", reason: "no_usd_price" },
    { packKey: "pack:retired", reason: "not_active" },
    { packKey: "pack:eur-only", reason: "no_usd_price" },
  ]);
  const lenient = projectProviderPacks({
    platform: PLATFORM, packs, chainByProviderCategoryId: chains, collectibleTypes: ["card"],
    readAt: READ_AT, versions: VERSIONS, identity, includePriceless: true,
  });
  assert.equal(lenient.repacks.length, 4);
  assert.equal(lenient.repacks[1].price.usdComparison.status, "unavailable");
  assert.deepEqual(lenient.repacks[1].categories, []);
  assert.equal(lenient.repacks[3].price.usdComparison.reason, "CURRENCY_UNSUPPORTED");
  assert.throws(
    () => projectProviderPacks({
      platform: PLATFORM, packs: [neonPack(), neonPack()], chainByProviderCategoryId: chains,
      collectibleTypes: ["card"], readAt: READ_AT, versions: VERSIONS, identity, includePriceless: false,
    }),
    hasCode("REPACK_IDENTITY_COLLISION"),
  );
  // Only a provider-wide single type is asserted on every pack; a mixed
  // provider publishes an unknown (empty) list rather than over-claiming.
  assert.deepEqual(publicCollectibleTypes(["card", "card"]), ["card"]);
  assert.deepEqual(publicCollectibleTypes(["art"]), ["other"]);
  assert.deepEqual(publicCollectibleTypes(["card", "art", "card"]), []);
  assert.deepEqual(publicCollectibleTypes([]), []);
});

test("provider categories reuse the carried taxonomy and mint the rest under it", () => {
  const resolved = resolvePublicCategories({
    providerCategories: [
      { id: "cat-football", display_name: "football" },
      { id: "cat-pokemon", display_name: "pokemon" },
      { id: "cat-yugioh", display_name: "yugioh" },
      { id: "cat-odd", display_name: "Vintage & Rare" },
    ],
    carriedCategories: [SPORTS, TCG, FOOTBALL, POKEMON],
    identity,
  });
  assert.deepEqual(
    resolved.chainByProviderCategoryId.get("cat-football").map(({ categoryKey }) => categoryKey),
    ["sports", "football"],
  );
  assert.deepEqual(
    resolved.chainByProviderCategoryId.get("cat-pokemon").map(({ publicCategoryId }) => publicCategoryId),
    [TCG.publicCategoryId, POKEMON.publicCategoryId],
  );
  const yugioh = resolved.chainByProviderCategoryId.get("cat-yugioh").at(-1);
  assert.equal(yugioh.categoryKey, "yu-gi-oh");
  assert.equal(yugioh.name, "Yu-Gi-Oh!");
  assert.equal(yugioh.kind, "franchise");
  assert.equal(yugioh.parentPublicCategoryId, TCG.publicCategoryId);
  assert.equal(yugioh.depth, 1);
  assert.equal(yugioh.publicCategoryId, identity("category:yu-gi-oh"));
  assert.deepEqual(yugioh.pathPublicCategoryIds, [TCG.publicCategoryId, yugioh.publicCategoryId]);
  assert.equal(yugioh.displayOrder, 23);
  const odd = resolved.chainByProviderCategoryId.get("cat-odd").at(-1);
  assert.equal(odd.categoryKey, "vintage-rare");
  assert.equal(odd.name, "Vintage & Rare");
  assert.equal(odd.kind, "other");
  assert.equal(odd.depth, 0);
  assert.deepEqual(resolved.minted.map(({ categoryKey }) => categoryKey), ["yu-gi-oh", "vintage-rare"]);
  assert.equal(resolved.categories.length, 6);

  // With nothing carried, alias parents are minted too, in the right order.
  const fresh = resolvePublicCategories({
    providerCategories: [{ id: "cat-football", display_name: "Football" }],
    carriedCategories: [],
    identity,
  });
  assert.deepEqual(fresh.categories.map(({ categoryKey, depth }) => [categoryKey, depth]), [
    ["sports", 0],
    ["football", 1],
  ]);
  assert.equal(fresh.categories[0].displayOrder, 0);
  assert.equal(fresh.categories[1].displayOrder, 1);
});

function exportDocument(releaseId, detail) {
  return { _id: `doc-${Math.abs(hashCode(JSON.stringify(detail)))}`, releaseId, detail };
}

function hashCode(value) {
  let hash = 0;
  for (const character of value) hash = (hash * 31 + character.charCodeAt(0)) | 0;
  return hash;
}

function carriedRepack(vendorKey, publicRepackId, topChase = null) {
  return {
    publicRepackId,
    publicVendorId: identity(`vendor:${vendorKey}`),
    vendorKey,
    vendorDisplayName: vendorKey,
    vendorLogoUrl: null,
    name: publicRepackId,
    format: "repack",
    contentMode: "focused",
    categories: [{ publicCategoryId: SPORTS.publicCategoryId, label: "Sports" }],
    collectibleTypes: ["card"],
    availability: "available",
    price: { displayMoney: { minorUnits: 100, currency: "USD" }, usdComparison: { status: "available", value: { minorUnits: 100, currency: "USD" } } },
    buyback: { kind: "uniform_rate", rateBasisPoints: 9000 },
    primaryImage: null,
    evEstimates: { packScout: { status: "unavailable" }, vendorReported: { status: "unavailable" } },
    topChase,
    contentSummary: { knownCollectibleCount: 0, chaseCount: 0, categoryCount: 1, collectibleTypeCount: 1, evidenceCompleteness: "unknown", probabilityCoverageBasisPoints: null },
    actionAvailability: { promo: false, repackLink: false },
    sourceUpdatedAt: READ_AT,
    description: null,
    actions: {},
  };
}

test("carry-forward keeps every other vendor of the active release byte for byte", () => {
  const activeReleaseId = "release-active";
  const clutchA = carriedRepack("clutchpacks", identity("repack:clutchpacks:a"));
  const clutchB = carriedRepack("clutchpacks", identity("repack:clutchpacks:b"));
  const oldPhygitals = carriedRepack("phygitals", identity("repack:phygitals:old"));
  const collectible = { publicCollectibleId: identity("collectible:1"), publicCategoryIds: [SPORTS.publicCategoryId] };
  const chaseA = { publicRepackId: clutchA.publicRepackId, publicCollectibleId: collectible.publicCollectibleId, role: "top_chase" };
  const chaseOld = { publicRepackId: oldPhygitals.publicRepackId, publicCollectibleId: collectible.publicCollectibleId, role: "top_chase" };
  const carried = carryForwardActiveRelease({
    activeStateDocuments: [{
      key: "singleton",
      activeReleaseId,
      activeRelease: { publicReleaseId: "76777a70-73db-86ec-873c-5eef784d0d83", releaseFingerprint: "f".repeat(64), dataAsOf: READ_AT },
    }],
    categoryDocuments: [exportDocument(activeReleaseId, SPORTS), exportDocument("release-stale", TCG)],
    collectibleDocuments: [exportDocument(activeReleaseId, collectible)],
    repackDocuments: [
      exportDocument(activeReleaseId, clutchA),
      exportDocument("release-stale", clutchB),
      exportDocument(activeReleaseId, oldPhygitals),
    ],
    chaseDocuments: [exportDocument(activeReleaseId, chaseA), exportDocument(activeReleaseId, chaseOld)],
    promotedVendorKeys: ["phygitals"],
  });
  assert.equal(carried.activePublicReleaseId, "76777a70-73db-86ec-873c-5eef784d0d83");
  assert.deepEqual(carried.categories, [SPORTS]);
  assert.deepEqual(carried.collectibles, [collectible]);
  assert.deepEqual(carried.repacks, [clutchA]);
  assert.deepEqual(carried.chases, [chaseA]);
  assert.equal(carried.droppedRepackCount, 1);
  assert.deepEqual([...carried.vendors.entries()], [
    ["clutchpacks", identity("vendor:clutchpacks")],
    ["phygitals", identity("vendor:phygitals")],
  ]);
  assert.throws(
    () => carryForwardActiveRelease({
      activeStateDocuments: [{ key: "singleton", activeReleaseId: null, activeRelease: null }],
      categoryDocuments: [], collectibleDocuments: [], repackDocuments: [], chaseDocuments: [],
      promotedVendorKeys: ["phygitals"],
    }),
    hasCode("ACTIVE_RELEASE_MISSING"),
  );
});

test("assembly packs deterministic batches and chains every hash", async () => {
  const collectible = { publicCollectibleId: identity("collectible:1"), publicCategoryIds: [SPORTS.publicCategoryId], dataAsOf: "2026-08-16T15:17:10.000Z" };
  const repacks = Array.from({ length: 40 }, (_, index) =>
    carriedRepack("clutchpacks", identity(`repack:clutchpacks:${index}`)),
  );
  const topChase = { publicRepackId: repacks[0].publicRepackId, publicCollectibleId: collectible.publicCollectibleId, role: "top_chase", observedAt: READ_AT };
  repacks[0] = { ...repacks[0], topChase };
  const plan = await assembleDataReleaseV3Plan(
    { readAt: READ_AT, categories: [SPORTS], collectibles: [collectible], repacks, chases: [topChase] },
    HASHING,
  );
  assert.equal(plan.classification, "publish");
  assert.deepEqual(plan.batches.map(({ kind, records }) => [kind, records.length]), [
    ["categories", 1],
    ["collectibles", 1],
    ["repacks", 32],
    ["repacks", 8],
    ["chases", 1],
  ]);
  assert.deepEqual(plan.manifest.counts, { categories: 1, collectibles: 1, repacks: 40, chases: 1, searchShards: 2 });
  assert.equal(plan.manifest.topChaseCount, 1);
  assert.equal(plan.manifest.batchCount, 5);
  assert.equal(plan.manifest.dataAsOf, READ_AT);
  const sortedIds = plan.batches.filter(({ kind }) => kind === "repacks").flatMap(({ records }) => records.map(({ publicRepackId }) => publicRepackId));
  assert.deepEqual(sortedIds, [...sortedIds].sort());
  assert.match(plan.publicReleaseId, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.match(plan.releaseFingerprint, /^[0-9a-f]{64}$/u);
  assert.match(plan.manifest.contentHash, /^[0-9a-f]{64}$/u);
  assert.match(plan.manifest.batchChainHash, /^[0-9a-f]{64}$/u);
  assert.notEqual(plan.manifest.entityChainHashes.repacks, HASHING.emptyChainHash);

  // Recompute the batch chain by hand: every link depends on the previous one.
  let chain = HASHING.emptyChainHash;
  for (const batch of plan.batches) {
    assert.equal(batch.batchHash, await sha256CanonicalJson("test.batch", { kind: batch.kind, records: batch.records }));
    chain = await sha256CanonicalJson("test.batch-chain", {
      previousHash: chain, batchIndex: batch.batchIndex, kind: batch.kind, batchHash: batch.batchHash, recordCount: batch.records.length,
    });
  }
  assert.equal(chain, plan.manifest.batchChainHash);

  // Identical input replays to the identical identity; a different clock does not.
  const replay = await assembleDataReleaseV3Plan(
    { readAt: READ_AT, categories: [SPORTS], collectibles: [collectible], repacks, chases: [topChase] },
    HASHING,
  );
  assert.equal(replay.publicReleaseId, plan.publicReleaseId);
  assert.equal(replay.releaseFingerprint, plan.releaseFingerprint);
  const later = await assembleDataReleaseV3Plan(
    { readAt: "2026-09-03T21:00:00.000Z", categories: [SPORTS], collectibles: [collectible], repacks, chases: [topChase] },
    HASHING,
  );
  assert.notEqual(later.publicReleaseId, plan.publicReleaseId);
  assert.equal(uuidFromSha256("a".repeat(64)), "aaaaaaaa-aaaa-8aaa-8aaa-aaaaaaaaaaaa");
});

test("assembly refuses incoherent entity sets instead of degrading them", async () => {
  const base = { readAt: READ_AT, categories: [SPORTS], collectibles: [], chases: [] };
  const repack = carriedRepack("clutchpacks", identity("repack:clutchpacks:a"));
  await assert.rejects(
    assembleDataReleaseV3Plan({ ...base, repacks: [repack, repack] }, HASHING),
    hasCode("DUPLICATE_REPACK"),
  );
  await assert.rejects(
    assembleDataReleaseV3Plan({ ...base, categories: [], repacks: [repack] }, HASHING),
    hasCode("REPACK_CATEGORY_UNKNOWN"),
  );
  const topChase = { publicRepackId: repack.publicRepackId, publicCollectibleId: identity("collectible:missing"), role: "top_chase" };
  await assert.rejects(
    assembleDataReleaseV3Plan({ ...base, repacks: [{ ...repack, topChase }] }, HASHING),
    hasCode("TOP_CHASE_NOT_STAGED"),
  );
  await assert.rejects(
    assembleDataReleaseV3Plan({ ...base, repacks: [repack], chases: [topChase] }, HASHING),
    hasCode("CHASE_REFERENCE_UNKNOWN"),
  );
  await assert.rejects(
    assembleDataReleaseV3Plan({ ...base, readAt: "2026-09-03T20:00:00Z", repacks: [repack] }, HASHING),
    hasCode("READ_AT_INVALID"),
  );
  // A record observed after the release clock would be refused by Convex at
  // finalize; the assembler refuses it up front.
  await assert.rejects(
    assembleDataReleaseV3Plan(
      { ...base, repacks: [{ ...repack, sourceUpdatedAt: "2026-09-03T20:00:00.001Z" }] },
      HASHING,
    ),
    hasCode("RECORD_TIME_AFTER_READ"),
  );
  const collectible = { publicCollectibleId: identity("collectible:late"), publicCategoryIds: [], dataAsOf: "2026-09-04T00:00:00.000Z" };
  await assert.rejects(
    assembleDataReleaseV3Plan({ ...base, collectibles: [collectible], repacks: [repack] }, HASHING),
    hasCode("RECORD_TIME_AFTER_READ"),
  );
});
