import assert from "node:assert/strict";
import { test } from "node:test";
import { clutchpacksPackProviderFacts } from
  "./dataforrest-clutchpacks-pack-v3.ts";
import { emptyNormalizedProviderFacts } from "./provider-source-facts-v1.ts";

const buybackStatement =
  "Instant buyback offer of 90%. One graded or authenticated card per pack.";

function evidencedPackData(): Record<string, unknown> {
  return {
    collection_id: "protected-collection-id",
    name: "  Ascent  ",
    description: "  One card per pack.  ",
    category: { id: "protected-category-id", name: "  Sports  ", slug: "sports" },
    collection_type: {
      id: "protected-collection-type-id",
      type: "  Basketball  ",
    },
    price: {
      currency: {
        code: "USD",
        name: "American Dollar",
        type: "fiat",
        decimals: 2,
      },
      price_amount: "100.00",
    },
    series: { id: "protected-series-id", description: buybackStatement },
    average_value: "123.45",
    floor: "20",
    chaser_ceiling: "1,000",
    sold_out: true,
    status: "active",
    image_url: " https://images.example.invalid/ascent.jpg ",
    price_bucket_odds: [
      {
        bucket_id: "bucket-zero",
        name: "Empty",
        min_price: "$0",
        max_price: "$19.99",
        live_pool_percentage: "0.00",
        drawable_count: 0,
        preview_cards: [{ id: "protected-preview-card" }],
      },
      {
        bucket_id: "bucket-high",
        name: " Chasers ",
        min_price: "$100",
        max_price: "$1,000",
        live_pool_percentage: "wrong-and-ignored",
        drawable_count: 1,
      },
      {
        bucket_id: "bucket-base",
        name: "Commons",
        min_price: "$20",
        max_price: "$99.99",
        live_pool_percentage: "wrong-and-ignored",
        drawable_count: 3,
      },
    ],
  };
}

test("ClutchPacks pack v3 maps only exact evidenced facts", () => {
  const facts = clutchpacksPackProviderFacts(evidencedPackData());
  assert.deepEqual(facts, {
    ...emptyNormalizedProviderFacts("pack"),
    displayName: { state: "present", value: "Ascent" },
    description: { state: "present", value: "One card per pack." },
    category: { state: "present", value: "Basketball" },
    imageReferences: {
      state: "present",
      value: ["https://images.example.invalid/ascent.jpg"],
    },
    price: {
      state: "present",
      value: { amount: 100, currency: "USD" },
    },
    providerReportedEv: {
      state: "present",
      value: { amount: 123.45, currency: "USD" },
    },
    buybackPercent: { state: "present", value: 90 },
    drawCount: { state: "present", value: 1 },
    packMembership: { state: "malformed" },
    evInput: {
      state: "present",
      value: {
        approved: true,
        currency: "USD",
        unitBasis: "per_pack",
        drawCount: 1,
        buybackPercent: 90,
        totalQuantity: 4,
        buckets: [
          {
            bucketId: "bucket-high",
            label: "Chasers",
            probability: 0.25,
            quantity: 1,
            lowerValue: 100,
            upperValue: 1_000,
          },
          {
            bucketId: "bucket-base",
            label: "Commons",
            probability: 0.75,
            quantity: 3,
            lowerValue: 20,
            upperValue: 99.99,
          },
        ],
      },
    },
    authoritativeAvailability: {
      state: "present",
      value: {
        state: "sold_out",
        authority: "provider_explicit_sold_out",
      },
    },
  });
  const serialized = JSON.stringify(facts);
  for (const protectedValue of [
    "protected-collection-id",
    "protected-category-id",
    "protected-collection-type-id",
    "protected-series-id",
    "protected-preview-card",
    "wrong-and-ignored",
    "active",
  ]) {
    assert.equal(serialized.includes(protectedValue), false, protectedValue);
  }
});

test("ClutchPacks pack v3 falls back to category name only when collection type is absent", () => {
  const data = evidencedPackData();
  delete data.collection_type;
  assert.deepEqual(clutchpacksPackProviderFacts(data).category, {
    state: "present",
    value: "Sports",
  });

  data.collection_type = "Basketball";
  assert.deepEqual(clutchpacksPackProviderFacts(data).category, {
    state: "malformed",
  });

  data.collection_type = {};
  assert.deepEqual(clutchpacksPackProviderFacts(data).category, {
    state: "malformed",
  });
});

test("ClutchPacks pack v3 accepts canonically comma-grouped raw USD values", () => {
  const data = evidencedPackData();
  data.price = {
    currency: { code: "USD", decimals: 2 },
    price_amount: "2,500",
  };
  data.average_value = "1,000";
  const facts = clutchpacksPackProviderFacts(data);
  assert.deepEqual(facts.price, {
    state: "present",
    value: { amount: 2_500, currency: "USD" },
  });
  assert.deepEqual(facts.providerReportedEv, {
    state: "present",
    value: { amount: 1_000, currency: "USD" },
  });

  data.average_value = "10,00";
  assert.deepEqual(clutchpacksPackProviderFacts(data).providerReportedEv, {
    state: "malformed",
  });
});

test("ClutchPacks pack v3 keeps unknown buyback prose absent and odds ready", () => {
  const data = evidencedPackData();
  data.series = { description: "Champions Only" };
  data.sold_out = false;
  const facts = clutchpacksPackProviderFacts(data);
  assert.deepEqual(facts.buybackPercent, { state: "absent" });
  assert.equal(facts.evInput.state, "present");
  if (facts.evInput.state !== "present") assert.fail("expected EV input");
  assert.equal(facts.evInput.value.buybackPercent, null);
  assert.deepEqual(facts.authoritativeAvailability, { state: "absent" });
  assert.deepEqual(facts.providerReportedEv, {
    state: "present",
    value: { amount: 123.45, currency: "USD" },
  });
});

test("ClutchPacks pack v3 fails malformed facts closed", () => {
  const cases = [
    {
      field: "imageReferences" as const,
      mutate: (data: Record<string, unknown>) => {
        data.image_url = "http://images.example.invalid/pack.jpg";
      },
    },
    {
      field: "price" as const,
      mutate: (data: Record<string, unknown>) => {
        data.price = {
          currency: { code: "USD", decimals: 2 },
          price_amount: "100.001",
        };
      },
    },
    {
      field: "providerReportedEv" as const,
      mutate: (data: Record<string, unknown>) => {
        data.average_value = "USD 123.45";
      },
    },
    {
      field: "price" as const,
      mutate: (data: Record<string, unknown>) => {
        data.price = {
          currency: { code: "EUR", decimals: 2 },
          price_amount: "100",
        };
      },
    },
    {
      field: "category" as const,
      mutate: (data: Record<string, unknown>) => {
        data.collection_type = { type: 42 };
      },
    },
    {
      field: "authoritativeAvailability" as const,
      mutate: (data: Record<string, unknown>) => {
        data.sold_out = "false";
      },
    },
    {
      field: "buybackPercent" as const,
      mutate: (data: Record<string, unknown>) => {
        data.series = { description: 90 };
      },
    },
  ];
  for (const scenario of cases) {
    const data = evidencedPackData();
    scenario.mutate(data);
    assert.deepEqual(
      clutchpacksPackProviderFacts(data)[scenario.field],
      { state: "malformed" },
      scenario.field,
    );
  }
});

test("ClutchPacks pack v3 rejects malformed odds without partial evidence", () => {
  const mutations: Array<(odds: Array<Record<string, unknown>>) => void> = [
    (odds) => {
      odds[1]!.bucket_id = "bucket-base";
    },
    (odds) => {
      odds[1]!.drawable_count = -1;
    },
    (odds) => {
      odds[1]!.drawable_count = 1.5;
    },
    (odds) => {
      odds[1]!.min_price = "$1,000.001";
    },
    (odds) => {
      odds[1]!.min_price = "$1,001";
      odds[1]!.max_price = "$1,000";
    },
    (odds) => {
      for (const bucket of odds) bucket.drawable_count = 0;
    },
  ];
  for (const mutate of mutations) {
    const data = evidencedPackData();
    const odds = data.price_bucket_odds as Array<Record<string, unknown>>;
    mutate(odds);
    assert.deepEqual(clutchpacksPackProviderFacts(data).evInput, {
      state: "malformed",
    });
  }
});
