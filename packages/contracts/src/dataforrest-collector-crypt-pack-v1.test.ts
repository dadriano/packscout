import assert from "node:assert/strict";
import { test } from "node:test";
import { collectorCryptPackProviderFactsV1 } from
  "./dataforrest-collector-crypt-pack-v1.ts";
import { emptyNormalizedProviderFacts } from "./provider-source-facts-v1.ts";
import { readDataforrestProviderFacts } from
  "./dataforrest-provider-facts-registry.ts";
import {
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
} from "./index.ts";

/**
 * Synthetic Collector Crypt catalog-pack ("machine") payload. Field names,
 * JSON types, nullability and nesting mirror the reviewed native shape; every
 * value is invented. Fields the reader must not read carry `unreviewed-` /
 * `protected-` aliases or 9_99x sentinels so a leak is visible.
 */
function evidencedPackData(): Record<string, unknown> {
  return {
    code: "unreviewed-pack-code",
    name: "  Sample Pack  ",
    shortName: "Unreviewed short name",
    image: "",
    imageNobgUrl: null,
    thumbnailUrl: " https://images.example.invalid/sample-pack.png ",
    videoUrl: null,
    videoHevcUrl: null,
    videoNobgUrl: null,
    menuCategory: "  Sample Category  ",
    menuOrder: 1,
    price: { amount: 100 },
    targetEV: 102.5,
    maxEV: 9_999,
    targetEvMin: 9_998,
    targetEvMax: 9_997,
    weightedInsuredValue: 9_996,
    instantBuyback: { percentageOfValue: 90 },
    contains: 1,
    archived: true,
    public: false,
    adoptable: false,
    autobuildEnabled: false,
    fixedEv: true,
    freeSpins: false,
    isPartner: false,
    turboMode: false,
    owner: null,
    parentCode: null,
    partnerFee: 0,
    pointsMultiplier: 1,
    bigWinChance: 0.01,
    lowThreshold: 2,
    topNfts: [{ id: "protected-top-nft-id" }],
    weightMultipliers: {
      common: 0.7,
      uncommon: 0.2,
      rare: 0.08,
      epic: 0.02,
    },
    tierRanges: {
      common: { start: 0, end: 50 },
      uncommon: { start: 50, end: 150 },
      rare: { start: 150, end: 500 },
      epic: { start: 500, end: 2_000 },
    },
  };
}

function expectedEvidencedFacts() {
  return {
    ...emptyNormalizedProviderFacts("pack"),
    displayName: { state: "present", value: "Sample Pack" },
    description: { state: "absent" },
    category: { state: "present", value: "Sample Category" },
    imageReferences: {
      state: "present",
      value: ["https://images.example.invalid/sample-pack.png"],
    },
    price: { state: "present", value: { amount: 100, currency: "USD" } },
    providerReportedEv: {
      state: "present",
      value: { amount: 102.5, currency: "USD" },
    },
    buybackPercent: { state: "present", value: 90 },
    drawCount: { state: "present", value: 1 },
    evInput: { state: "absent" },
    authoritativeAvailability: {
      state: "present",
      value: { state: "sold_out", authority: "provider_explicit_sold_out" },
    },
  };
}

test("Collector Crypt pack v1 maps only exact evidenced facts", () => {
  const facts = collectorCryptPackProviderFactsV1(evidencedPackData());
  assert.deepEqual(facts, expectedEvidencedFacts());

  const serialized = JSON.stringify(facts);
  for (const unread of [
    "unreviewed-pack-code",
    "Unreviewed short name",
    "protected-top-nft-id",
    "9999",
    "9998",
    "9997",
    "9996",
  ]) {
    assert.equal(serialized.includes(unread), false, unread);
  }
});

test("Collector Crypt pack v1 binds price and reported EV as USD major units", () => {
  const data = evidencedPackData();
  data.price = { amount: 2_500 };
  data.targetEV = 2_612.75;
  const facts = collectorCryptPackProviderFactsV1(data);
  assert.deepEqual(facts.price, {
    state: "present",
    value: { amount: 2_500, currency: "USD" },
  });
  assert.deepEqual(facts.providerReportedEv, {
    state: "present",
    value: { amount: 2_612.75, currency: "USD" },
  });

  // No native payload names a currency: USD is asserted by reviewed decision,
  // never inferred, and never carried over from a native currency field.
  data.price = { amount: 100, currency: "EUR" };
  assert.deepEqual(collectorCryptPackProviderFactsV1(data).price, {
    state: "present",
    value: { amount: 100, currency: "USD" },
  });

  // Zero is a real amount, not an absent one.
  data.price = { amount: 0 };
  data.targetEV = 0;
  const zeroed = collectorCryptPackProviderFactsV1(data);
  assert.deepEqual(zeroed.price, {
    state: "present",
    value: { amount: 0, currency: "USD" },
  });
  assert.deepEqual(zeroed.providerReportedEv, {
    state: "present",
    value: { amount: 0, currency: "USD" },
  });
});

test("Collector Crypt pack v1 binds the buyback percent unscaled", () => {
  // `instantBuyback.percentageOfValue` is already on a 0..100 percent scale.
  // Scaling it again (x100) or treating it as a 0..1 ratio (x100 the other
  // way, or /100) must not survive: the bound value is byte-identical to the
  // native number on every evidenced percent.
  for (const percentageOfValue of [85, 90, 93, 94]) {
    const data = evidencedPackData();
    data.instantBuyback = { percentageOfValue };
    assert.deepEqual(
      collectorCryptPackProviderFactsV1(data).buybackPercent,
      { state: "present", value: percentageOfValue },
      String(percentageOfValue),
    );
  }

  // A x100 rescale of an evidenced percent leaves the 0..100 band and must
  // fail closed rather than storing a 100x-wrong buyback.
  const rescaled = evidencedPackData();
  rescaled.instantBuyback = { percentageOfValue: 9_000 };
  assert.deepEqual(
    collectorCryptPackProviderFactsV1(rescaled).buybackPercent,
    { state: "malformed" },
  );

  // A ratio-shaped number is bound as the percent it literally is, not
  // promoted to 90. Only the band edges are accepted.
  for (const [percentageOfValue, expected] of [
    [0.9, { state: "present", value: 0.9 }],
    [0, { state: "present", value: 0 }],
    [100, { state: "present", value: 100 }],
    [100.01, { state: "malformed" }],
    [-0.01, { state: "malformed" }],
  ] as const) {
    const data = evidencedPackData();
    data.instantBuyback = { percentageOfValue };
    assert.deepEqual(
      collectorCryptPackProviderFactsV1(data).buybackPercent,
      expected,
      String(percentageOfValue),
    );
  }
});

test("Collector Crypt pack v1 never derives an EV input from odds-only evidence", () => {
  // `weightMultipliers` sums to exactly 1 and `tierRanges` gives a value band
  // per tier, but neither carries the per-bucket quantity evInputFromFacts
  // requires. Binding odds without quantities would yield a malformed EV input
  // on every pack, so the fact is deliberately absent.
  const complete = collectorCryptPackProviderFactsV1(evidencedPackData());
  assert.deepEqual(complete.evInput, { state: "absent" });
  const serialized = JSON.stringify(complete);
  for (const odds of ["0.7", "0.08", "0.02", "2000", "common", "epic"]) {
    assert.equal(serialized.includes(odds), false, odds);
  }

  // Absent, partial and malformed odds are all equally uninteresting: the
  // fact never moves off absent, so it can never quarantine a pack.
  const variants: Array<(data: Record<string, unknown>) => void> = [
    (data) => {
      delete data.weightMultipliers;
      delete data.tierRanges;
    },
    (data) => {
      delete data.weightMultipliers;
    },
    (data) => {
      data.tierRanges = { common: { start: 0 } };
    },
    (data) => {
      data.weightMultipliers = "unreviewed";
      data.tierRanges = null;
    },
    (data) => {
      data.contains = 4;
      data.weightMultipliers = { common: 0.5, rare: 0.5 };
    },
  ];
  for (const mutate of variants) {
    const data = evidencedPackData();
    mutate(data);
    assert.deepEqual(collectorCryptPackProviderFactsV1(data).evInput, {
      state: "absent",
    });
  }
});

test("Collector Crypt pack v1 leaves missing optional facts absent", () => {
  const cases = [
    {
      field: "displayName" as const,
      mutate: (data: Record<string, unknown>) => {
        delete data.name;
      },
    },
    {
      field: "displayName" as const,
      // `shortName` is never a display-name fallback.
      mutate: (data: Record<string, unknown>) => {
        data.name = null;
        data.shortName = "Fallback prohibited";
      },
    },
    {
      field: "category" as const,
      mutate: (data: Record<string, unknown>) => {
        data.menuCategory = null;
      },
    },
    {
      field: "category" as const,
      mutate: (data: Record<string, unknown>) => {
        delete data.menuCategory;
      },
    },
    {
      field: "imageReferences" as const,
      // The evidenced "unset" encodings: empty-string `image` plus nulls.
      mutate: (data: Record<string, unknown>) => {
        data.thumbnailUrl = null;
      },
    },
    {
      field: "imageReferences" as const,
      mutate: (data: Record<string, unknown>) => {
        delete data.thumbnailUrl;
        delete data.imageNobgUrl;
        delete data.image;
      },
    },
    {
      field: "price" as const,
      mutate: (data: Record<string, unknown>) => {
        data.price = null;
      },
    },
    {
      field: "providerReportedEv" as const,
      mutate: (data: Record<string, unknown>) => {
        delete data.targetEV;
      },
    },
    {
      field: "buybackPercent" as const,
      mutate: (data: Record<string, unknown>) => {
        data.instantBuyback = null;
      },
    },
    {
      field: "buybackPercent" as const,
      mutate: (data: Record<string, unknown>) => {
        data.instantBuyback = { percentageOfValue: null };
      },
    },
    {
      field: "drawCount" as const,
      mutate: (data: Record<string, unknown>) => {
        delete data.contains;
      },
    },
    {
      field: "authoritativeAvailability" as const,
      mutate: (data: Record<string, unknown>) => {
        data.archived = false;
      },
    },
    {
      field: "authoritativeAvailability" as const,
      mutate: (data: Record<string, unknown>) => {
        delete data.archived;
      },
    },
  ];
  for (const [index, scenario] of cases.entries()) {
    const data = evidencedPackData();
    scenario.mutate(data);
    assert.deepEqual(
      collectorCryptPackProviderFactsV1(data)[scenario.field],
      { state: "absent" },
      `${scenario.field} #${index}`,
    );
  }

  // `public: false` means unlisted, not sold out, and is never bound.
  const unlisted = evidencedPackData();
  unlisted.archived = false;
  unlisted.public = false;
  assert.deepEqual(
    collectorCryptPackProviderFactsV1(unlisted).authoritativeAvailability,
    { state: "absent" },
  );

  // No observed payload carries a description key, so the fact is
  // unconditionally absent even when one appears.
  const described = evidencedPackData();
  described.description = "Unreviewed description";
  const describedFacts = collectorCryptPackProviderFactsV1(described);
  assert.deepEqual(describedFacts.description, { state: "absent" });
  assert.equal(
    JSON.stringify(describedFacts).includes("Unreviewed description"),
    false,
  );
});

test("Collector Crypt pack v1 fails malformed facts closed", () => {
  const cases = [
    {
      field: "displayName" as const,
      mutate: (data: Record<string, unknown>) => {
        data.name = 42;
      },
    },
    {
      field: "displayName" as const,
      mutate: (data: Record<string, unknown>) => {
        data.name = "   ";
      },
    },
    {
      field: "displayName" as const,
      mutate: (data: Record<string, unknown>) => {
        data.name = "x".repeat(10_001);
      },
    },
    {
      field: "category" as const,
      mutate: (data: Record<string, unknown>) => {
        data.menuCategory = 42;
      },
    },
    {
      field: "category" as const,
      mutate: (data: Record<string, unknown>) => {
        data.menuCategory = "   ";
      },
    },
    {
      field: "imageReferences" as const,
      mutate: (data: Record<string, unknown>) => {
        data.thumbnailUrl = "http://images.example.invalid/sample-pack.png";
      },
    },
    {
      field: "imageReferences" as const,
      mutate: (data: Record<string, unknown>) => {
        data.image = "javascript:unsafe";
      },
    },
    {
      field: "imageReferences" as const,
      mutate: (data: Record<string, unknown>) => {
        data.imageNobgUrl = 42;
      },
    },
    {
      field: "imageReferences" as const,
      mutate: (data: Record<string, unknown>) => {
        data.thumbnailUrl = "https://user:secret@images.example.invalid/a.png";
      },
    },
    {
      field: "imageReferences" as const,
      mutate: (data: Record<string, unknown>) => {
        data.thumbnailUrl = "https://images.example.invalid/a.png#fragment";
      },
    },
    {
      field: "imageReferences" as const,
      mutate: (data: Record<string, unknown>) => {
        data.thumbnailUrl =
          `https://images.example.invalid/${"x".repeat(2_049)}`;
      },
    },
    {
      field: "price" as const,
      // A scalar price, not the evidenced `{ amount }` wrapper.
      mutate: (data: Record<string, unknown>) => {
        data.price = 100;
      },
    },
    {
      field: "price" as const,
      mutate: (data: Record<string, unknown>) => {
        data.price = [];
      },
    },
    {
      field: "price" as const,
      mutate: (data: Record<string, unknown>) => {
        data.price = { currency: "USD" };
      },
    },
    {
      field: "price" as const,
      mutate: (data: Record<string, unknown>) => {
        data.price = { amount: null };
      },
    },
    {
      field: "price" as const,
      mutate: (data: Record<string, unknown>) => {
        data.price = { amount: "100" };
      },
    },
    {
      field: "price" as const,
      mutate: (data: Record<string, unknown>) => {
        data.price = { amount: -1 };
      },
    },
    {
      field: "providerReportedEv" as const,
      mutate: (data: Record<string, unknown>) => {
        data.targetEV = "102.50";
      },
    },
    {
      field: "providerReportedEv" as const,
      mutate: (data: Record<string, unknown>) => {
        data.targetEV = -1;
      },
    },
    {
      field: "providerReportedEv" as const,
      mutate: (data: Record<string, unknown>) => {
        data.targetEV = Number.NaN;
      },
    },
    {
      field: "providerReportedEv" as const,
      mutate: (data: Record<string, unknown>) => {
        data.targetEV = Number.POSITIVE_INFINITY;
      },
    },
    {
      field: "buybackPercent" as const,
      // A scalar buyback, not the evidenced `{ percentageOfValue }` wrapper.
      mutate: (data: Record<string, unknown>) => {
        data.instantBuyback = 90;
      },
    },
    {
      field: "buybackPercent" as const,
      mutate: (data: Record<string, unknown>) => {
        data.instantBuyback = { percentageOfValue: "90" };
      },
    },
    {
      field: "buybackPercent" as const,
      mutate: (data: Record<string, unknown>) => {
        data.instantBuyback = { percentageOfValue: 101 };
      },
    },
    {
      field: "buybackPercent" as const,
      mutate: (data: Record<string, unknown>) => {
        data.instantBuyback = { percentageOfValue: -1 };
      },
    },
    {
      field: "drawCount" as const,
      mutate: (data: Record<string, unknown>) => {
        data.contains = 0;
      },
    },
    {
      field: "drawCount" as const,
      mutate: (data: Record<string, unknown>) => {
        data.contains = 1.5;
      },
    },
    {
      field: "drawCount" as const,
      mutate: (data: Record<string, unknown>) => {
        data.contains = "1";
      },
    },
    {
      field: "authoritativeAvailability" as const,
      mutate: (data: Record<string, unknown>) => {
        data.archived = "true";
      },
    },
    {
      field: "authoritativeAvailability" as const,
      mutate: (data: Record<string, unknown>) => {
        data.archived = 1;
      },
    },
  ];
  for (const [index, scenario] of cases.entries()) {
    const data = evidencedPackData();
    scenario.mutate(data);
    assert.deepEqual(
      collectorCryptPackProviderFactsV1(data)[scenario.field],
      { state: "malformed" },
      `${scenario.field} #${index}`,
    );
  }
});

test("Collector Crypt pack v1 keeps the evidenced text and image boundaries usable", () => {
  const data = evidencedPackData();
  data.name = "x".repeat(10_000);
  assert.equal(
    collectorCryptPackProviderFactsV1(data).displayName.state,
    "present",
  );

  // Distinct references are collected in thumbnail, no-background, image
  // order; a repeated reference is bound once.
  const images = evidencedPackData();
  images.thumbnailUrl = "https://images.example.invalid/thumb.png";
  images.imageNobgUrl = "https://images.example.invalid/nobg.png";
  images.image = "https://images.example.invalid/thumb.png";
  assert.deepEqual(collectorCryptPackProviderFactsV1(images).imageReferences, {
    state: "present",
    value: [
      "https://images.example.invalid/thumb.png",
      "https://images.example.invalid/nobg.png",
    ],
  });
});

test("Collector Crypt catalog v3 is the only identity carrying the pack reader", () => {
  const data = evidencedPackData();
  const packVersion = DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION;
  assert.deepEqual(
    readDataforrestProviderFacts(packVersion, "collector_crypt", "pack", data),
    expectedEvidencedFacts(),
  );

  // Adapter versions are immutable admissions: the pack reader must not
  // appear on any previously admitted Collector Crypt identity.
  for (const olderVersion of [
    DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_VERSION,
    DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
    DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
    DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
  ]) {
    assert.equal(
      readDataforrestProviderFacts(
        olderVersion,
        "collector_crypt",
        "pack",
        data,
      ),
      null,
      olderVersion,
    );
  }

  // Catalog-v3 carries the catalog-v2 card interpretation forward unchanged.
  assert.equal(
    readDataforrestProviderFacts(packVersion, "collector_crypt", "card", data)
      ?.kind,
    "card",
  );

  // The identity is Collector Crypt-only and pull/trade stay unmapped.
  for (const provider of ["clutchpacks", "courtyard", "phygitals"] as const) {
    assert.equal(
      readDataforrestProviderFacts(packVersion, provider, "pack", data),
      null,
      provider,
    );
  }
  for (const kind of ["pull", "trade"] as const) {
    assert.equal(
      readDataforrestProviderFacts(packVersion, "collector_crypt", kind, data),
      null,
      kind,
    );
  }
});
