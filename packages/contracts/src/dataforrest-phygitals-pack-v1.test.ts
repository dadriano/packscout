import assert from "node:assert/strict";
import { test } from "node:test";
import { phygitalsPackProviderFactsV1 } from
  "./dataforrest-phygitals-pack-v1.ts";
import {
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
} from "./dataforrest-events-v1.ts";
import { readDataforrestProviderFacts } from
  "./dataforrest-provider-facts-registry.ts";
import { emptyNormalizedProviderFacts } from "./provider-source-facts-v1.ts";

/**
 * Synthetic payload: real Phygitals key names, JSON types, nullability and
 * nesting with invented values. No captured provider value appears here.
 * `mint_price` is a STRING and `ev` is a NUMBER on every observed row, and both
 * are reproduced with those types so the two parse paths stay covered.
 */
function evidencedPackData(): Record<string, unknown> {
  return {
    id: "protected-native-id",
    slug: "protected-slug",
    // The envelope's provider-declared display-name field. No phygitals pack
    // payload carries it, and this reader must never fall back to it.
    provider_label: "Protected Provider Label",
    name: "  Sample Pack  ",
    description: "  One card per pack.  ",
    type: "PROTECTED-TYPE",
    platform: "protected-platform",
    category: "  Sample Category  ",
    categories: ["Sample Category", "Protected Second Category"],
    claw_image_url: " https://images.example.invalid/sample-pack.png ",
    mint_price: "100",
    ev: 120.5,
    min_ev: 99,
    max_ev: 105,
    buyback_percent: 0.846,
    in_stock: false,
    enable: true,
    repack: true,
    variant_of: null,
    last_pull: null,
    max_per_mint: 5,
    num_pulls_7d: 3,
    pulls_per_voucher: 0,
    chase: [],
    variants: [],
    rewards_symbols: [],
    rewards_amounts: [],
    rewards_decimals: [],
    rewards_mint_addresses: [],
    sellback_rewards_amounts: [],
    creator_profile: { profile_picture: "/images/pfps/protected-creator.webp" },
    pack_managers: [
      { profile_picture: "/images/pfps/protected-manager.webp" },
    ],
    rarity_distribution: [
      {
        id: 1,
        name: "Protected Common Tier",
        color: "#000000",
        lower: 1,
        upper: 50,
        weight: 62.5,
      },
      {
        id: 2,
        name: "Protected Rare Tier",
        color: "#ffffff",
        lower: 50,
        upper: 500,
        weight: 37.5,
      },
    ],
  };
}

test("Phygitals pack V1 maps only exact evidenced facts", () => {
  const facts = phygitalsPackProviderFactsV1(evidencedPackData());
  assert.deepEqual(facts, {
    ...emptyNormalizedProviderFacts("pack"),
    displayName: { state: "present", value: "Sample Pack" },
    description: { state: "present", value: "One card per pack." },
    category: { state: "present", value: "Sample Category" },
    imageReferences: {
      state: "present",
      value: ["https://images.example.invalid/sample-pack.png"],
    },
    price: { state: "present", value: { amount: 100, currency: "USD" } },
    providerReportedEv: {
      state: "present",
      value: { amount: 120.5, currency: "USD" },
    },
    // A 0..1 ratio surfaces as a percent: 0.846 is 84.6%, never 0.846%.
    buybackPercent: { state: "present", value: 84.6 },
    drawCount: { state: "present", value: 1 },
    // evInput is never populated by this reader; see the dedicated test.
    evInput: { state: "absent" },
    authoritativeAvailability: {
      state: "present",
      value: { state: "sold_out", authority: "provider_explicit_sold_out" },
    },
  });
  const serialized = JSON.stringify(facts);
  for (const protectedValue of [
    "protected-native-id",
    "protected-slug",
    "Protected Provider Label",
    "PROTECTED-TYPE",
    "protected-platform",
    "Protected Second Category",
    "protected-creator",
    "protected-manager",
    "Protected Common Tier",
    "Protected Rare Tier",
  ]) assert.equal(serialized.includes(protectedValue), false, protectedValue);
});

test("Phygitals pack V1 treats ev 0 as an unset sentinel, never a stored zero", () => {
  const data = evidencedPackData();
  data.ev = 0;
  const sentinel = phygitalsPackProviderFactsV1(data);
  assert.deepEqual(sentinel.providerReportedEv, { state: "absent" });
  // `min_ev` is above zero on every sentinel row, so a true zero EV is
  // impossible and the advertised band must not stand in for the point value.
  const serialized = JSON.stringify(sentinel);
  for (const band of ["99", "105"]) {
    assert.equal(serialized.includes(band), false, band);
  }
  // The sentinel is confined to `ev`: everything else still binds.
  assert.deepEqual(sentinel.price, {
    state: "present",
    value: { amount: 100, currency: "USD" },
  });

  for (const ev of [0.01, 1, 120.5, 10_000]) {
    data.ev = ev;
    assert.deepEqual(
      phygitalsPackProviderFactsV1(data).providerReportedEv,
      { state: "present", value: { amount: ev, currency: "USD" } },
      String(ev),
    );
  }
});

test("Phygitals pack V1 asserts USD on amounts no payload names a currency for", () => {
  const data = evidencedPackData();
  // The assertion is deliberate, not incidental: nothing in the payload names a
  // currency, so USD can only come from the reviewed decision in the reader.
  const payload = JSON.stringify(data);
  for (const token of ["currency", "USD", "USDC", "SOL", "$"]) {
    assert.equal(payload.includes(token), false, token);
  }
  assert.equal(typeof data.mint_price, "string");
  assert.equal(typeof data.ev, "number");
  const facts = phygitalsPackProviderFactsV1(data);
  assert.deepEqual(facts.price, {
    state: "present",
    value: { amount: 100, currency: "USD" },
  });
  assert.deepEqual(facts.providerReportedEv, {
    state: "present",
    value: { amount: 120.5, currency: "USD" },
  });
  // The string amount parses to a number, not to the raw string.
  if (facts.price.state !== "present") assert.fail("expected a price");
  assert.equal(typeof facts.price.value.amount, "number");
});

test("Phygitals pack V1 scales the 0..1 buyback ratio and rejects whole percents", () => {
  const data = evidencedPackData();
  for (const [ratio, percent] of [[0, 0], [0.85, 85], [0.925, 92.5], [1, 100]] as const) {
    data.buyback_percent = ratio;
    assert.deepEqual(
      phygitalsPackProviderFactsV1(data).buybackPercent,
      { state: "present", value: percent },
      String(ratio),
    );
  }
  // A future switch to whole percents must surface loudly, not publish 8500%.
  for (const value of [85, 100.5, -0.1, "0.85", true]) {
    data.buyback_percent = value;
    assert.deepEqual(
      phygitalsPackProviderFactsV1(data).buybackPercent,
      { state: "malformed" },
      String(value),
    );
  }
});

test("Phygitals pack V1 never populates evInput from published odds", () => {
  const data = evidencedPackData();
  assert.deepEqual(phygitalsPackProviderFactsV1(data).evInput, {
    state: "absent",
  });
  // Odds are not quantities, and no pool size appears anywhere in the payload,
  // so no distribution shape may promote evInput to present or malformed.
  const distributions: unknown[] = [
    [{ id: 1, name: "Only", color: "#000000", lower: 1, upper: 9, weight: 100 }],
    [
      { id: 1, name: "A", color: "#000000", lower: 1, upper: 9, weight: 50 },
      { id: 2, name: "B", color: "#ffffff", lower: 9, upper: 99, weight: 50 },
    ],
    [],
    null,
    "not-an-array",
  ];
  for (const rarity_distribution of distributions) {
    data.rarity_distribution = rarity_distribution;
    assert.deepEqual(
      phygitalsPackProviderFactsV1(data).evInput,
      { state: "absent" },
      JSON.stringify(rarity_distribution),
    );
  }
});

test("Phygitals pack V1 infers one draw only from a distribution totalling 100", () => {
  const data = evidencedPackData();
  assert.deepEqual(phygitalsPackProviderFactsV1(data).drawCount, {
    state: "present",
    value: 1,
  });
  // An unproven inference stays absent: the defect, if any, is in
  // `rarity_distribution`, not in a draw count phygitals never publishes.
  const unproven: unknown[] = [
    undefined,
    null,
    [],
    "not-an-array",
    [{ id: 1, name: "Short", color: "#000000", lower: 1, upper: 9, weight: 90 }],
    [{ id: 1, name: "Typed", color: "#000000", lower: 1, upper: 9, weight: "100" }],
    [{ id: 1, name: "Weightless", color: "#000000", lower: 1, upper: 9 }],
  ];
  for (const rarity_distribution of unproven) {
    data.rarity_distribution = rarity_distribution;
    assert.deepEqual(
      phygitalsPackProviderFactsV1(data).drawCount,
      { state: "absent" },
      JSON.stringify(rarity_distribution ?? null),
    );
  }
});

test("Phygitals pack V1 keeps missing optional fields absent", () => {
  const absentCases = [
    { field: "description" as const, key: "description", values: [undefined, null, "", "   "] },
    { field: "imageReferences" as const, key: "claw_image_url", values: [undefined, null] },
    { field: "price" as const, key: "mint_price", values: [undefined, null] },
    { field: "providerReportedEv" as const, key: "ev", values: [undefined, null] },
    { field: "buybackPercent" as const, key: "buyback_percent", values: [undefined, null] },
    // A pack whose `name` is gone stays absent rather than borrowing the
    // envelope's `provider_label`, which no phygitals pack payload carries.
    { field: "displayName" as const, key: "name", values: [undefined, null] },
    // `in_stock: true` stays absent so the envelope decides availability and no
    // observation contradicts it.
    {
      field: "authoritativeAvailability" as const,
      key: "in_stock",
      values: [undefined, null, true],
    },
  ];
  for (const scenario of absentCases) {
    for (const value of scenario.values) {
      const data = evidencedPackData();
      if (value === undefined) delete data[scenario.key];
      else data[scenario.key] = value;
      assert.deepEqual(
        phygitalsPackProviderFactsV1(data)[scenario.field],
        { state: "absent" },
        `${scenario.field}=${String(value)}`,
      );
    }
  }
});

test("Phygitals pack V1 falls back to categories only when it names one category", () => {
  const data = evidencedPackData();
  data.category = null;
  data.categories = ["  Sole Category  "];
  assert.deepEqual(phygitalsPackProviderFactsV1(data).category, {
    state: "present",
    value: "Sole Category",
  });
  // `categories` is not ordered by primacy, so several entries name no primary.
  for (const categories of [
    ["First Category", "Second Category"],
    [],
    undefined,
    null,
  ]) {
    if (categories === undefined) delete data.categories;
    else data.categories = categories;
    assert.deepEqual(
      phygitalsPackProviderFactsV1(data).category,
      { state: "absent" },
      JSON.stringify(categories ?? null),
    );
  }
});

test("Phygitals pack V1 fails present-but-wrong-typed facts closed", () => {
  const cases = [
    { field: "displayName" as const, key: "name", values: [42, "   ", [], {}, "x".repeat(10_001)] },
    { field: "description" as const, key: "description", values: [42, [], { text: "no" }] },
    { field: "category" as const, key: "category", values: [42, [], {}] },
    {
      field: "imageReferences" as const,
      key: "claw_image_url",
      values: [
        42,
        "http://images.example.invalid/sample-pack.png",
        "javascript:unsafe",
        "https://user:secret@images.example.invalid/a.png",
        "not-a-url",
        `https://images.example.invalid/${"a".repeat(2_049)}`,
      ],
    },
    {
      field: "price" as const,
      key: "mint_price",
      values: ["$100", "1,000", "100 USD", "", true, [], {}, -1],
    },
    {
      field: "providerReportedEv" as const,
      key: "ev",
      values: ["not-a-number", "", true, [], {}, -1],
    },
    { field: "authoritativeAvailability" as const, key: "in_stock", values: ["false", 0, []] },
  ];
  for (const scenario of cases) {
    for (const value of scenario.values) {
      const data = evidencedPackData();
      data[scenario.key] = value;
      assert.deepEqual(
        phygitalsPackProviderFactsV1(data)[scenario.field],
        { state: "malformed" },
        `${scenario.field}=${JSON.stringify(value)}`,
      );
    }
  }
  // A malformed `category` never silently borrows the `categories` fallback.
  const borrowed = evidencedPackData();
  borrowed.category = 42;
  borrowed.categories = ["Fallback prohibited"];
  assert.deepEqual(phygitalsPackProviderFactsV1(borrowed).category, {
    state: "malformed",
  });
  const malformedCategories = evidencedPackData();
  malformedCategories.category = null;
  malformedCategories.categories = "Sample Category";
  assert.deepEqual(phygitalsPackProviderFactsV1(malformedCategories).category, {
    state: "malformed",
  });
});

test("catalog-v2 is the only phygitals admission carrying the native pack reader", () => {
  const data = evidencedPackData();
  assert.deepEqual(
    readDataforrestProviderFacts(
      DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
      "phygitals",
      "pack",
      data,
    ),
    phygitalsPackProviderFactsV1(data),
  );
  // Adapter versions are immutable admissions: the pack reader must not appear
  // on the older phygitals versions that shipped without it.
  for (
    const version of [
      DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
      DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION,
      DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
    ]
  ) {
    assert.equal(
      readDataforrestProviderFacts(version, "phygitals", "pack", data),
      null,
      version,
    );
  }
  // The reader is phygitals-only and pack-only.
  for (const provider of ["clutchpacks", "collector_crypt", "courtyard"] as const) {
    assert.equal(
      readDataforrestProviderFacts(
        DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
        provider,
        "pack",
        data,
      ),
      null,
      provider,
    );
  }
  assert.notDeepEqual(
    readDataforrestProviderFacts(
      DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
      "phygitals",
      "card",
      data,
    ),
    phygitalsPackProviderFactsV1(data),
  );
});
