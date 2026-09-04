import assert from "node:assert/strict";
import { test } from "node:test";
import { phygitalsPackProviderFactsV1 } from
  "./dataforrest-phygitals-pack-v1.ts";
import { phygitalsPackProviderFactsV2 } from
  "./dataforrest-phygitals-pack-v2.ts";
import {
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION,
} from "./dataforrest-events-v1.ts";
import { readDataforrestProviderFacts } from
  "./dataforrest-provider-facts-registry.ts";
import { normalizedEvInputFactSchema } from "./provider-source-facts-v1.ts";

/**
 * Synthetic payload: real Phygitals key names, JSON types, nullability and
 * nesting with invented values. No captured provider value appears here.
 */
function evidencedPackData(): Record<string, unknown> {
  return {
    id: "protected-native-id",
    slug: "protected-slug",
    name: "  Sample Pack  ",
    description: "  One card per pack.  ",
    category: "  Sample Category  ",
    categories: ["Sample Category"],
    claw_image_url: " https://images.example.invalid/sample-pack.png ",
    mint_price: "100",
    ev: 120.5,
    min_ev: 99,
    max_ev: 105,
    buyback_percent: 0.846,
    in_stock: true,
    enable: true,
    repack: true,
    pulls_per_voucher: 0,
    chase: [],
    variants: [],
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

const expectedEvInput = {
  state: "present" as const,
  value: {
    approved: true,
    currency: "USD",
    unitBasis: "per_pack",
    drawCount: 1,
    buybackPercent: 84.6,
    totalQuantity: null,
    buckets: [
      {
        bucketId: "1",
        label: "Protected Common Tier",
        probability: 0.625,
        quantity: null,
        lowerValue: 1,
        upperValue: 50,
      },
      {
        bucketId: "2",
        label: "Protected Rare Tier",
        probability: 0.375,
        quantity: null,
        lowerValue: 50,
        upperValue: 500,
      },
    ],
  },
};

test("Phygitals pack V2 reads every V1 fact identically and binds evInput", () => {
  const data = evidencedPackData();
  const v2 = phygitalsPackProviderFactsV2(data);
  const { evInput, ...rest } = v2;
  assert.deepEqual(
    { ...rest, evInput: { state: "absent" } },
    phygitalsPackProviderFactsV1(data),
  );
  assert.deepEqual(evInput, expectedEvInput);
  // The bound value is exactly what the normalized facts contract admits.
  assert.equal(normalizedEvInputFactSchema.safeParse(evInput).success, true);
  // Probabilities cover the distribution exactly.
  assert.equal(
    evInput.state === "present"
      ? evInput.value.buckets.reduce((sum, bucket) => sum + (bucket.probability ?? 0), 0)
      : null,
    1,
  );
});

test("Phygitals pack V2 keeps the pool size unknown and follows V1's buyback", () => {
  const data = evidencedPackData();
  data.buyback_percent = null;
  const evInput = phygitalsPackProviderFactsV2(data).evInput;
  assert.equal(evInput.state, "present");
  if (evInput.state !== "present") return;
  assert.equal(evInput.value.buybackPercent, null);
  assert.equal(evInput.value.totalQuantity, null);
  assert.ok(evInput.value.buckets.every((bucket) => bucket.quantity === null));
  // A malformed buyback ratio stays V1's problem; the EV input still binds
  // without a rate rather than inventing one.
  data.buyback_percent = 85;
  const malformedBuyback = phygitalsPackProviderFactsV2(data);
  assert.deepEqual(malformedBuyback.buybackPercent, { state: "malformed" });
  assert.equal(malformedBuyback.evInput.state, "present");
  if (malformedBuyback.evInput.state === "present") {
    assert.equal(malformedBuyback.evInput.value.buybackPercent, null);
  }
});

test("Phygitals pack V2 accepts fractional weights, string ids and blank labels", () => {
  const data = evidencedPackData();
  data.rarity_distribution = [
    { id: "common", name: "", lower: 0, upper: 9.99, weight: 33.333 },
    { id: 7, name: null, lower: 10, upper: 10, weight: 66.667 },
  ];
  const evInput = phygitalsPackProviderFactsV2(data).evInput;
  assert.equal(evInput.state, "present");
  if (evInput.state !== "present") return;
  assert.deepEqual(
    evInput.value.buckets.map(({ bucketId, label, probability, lowerValue, upperValue }) => ({
      bucketId, label, probability, lowerValue, upperValue,
    })),
    [
      // Probabilities are the published percentages scaled by 100, carried as
      // the plain division result rather than a rounded decimal.
      { bucketId: "common", label: null, probability: 33.333 / 100, lowerValue: 0, upperValue: 9.99 },
      { bucketId: "7", label: null, probability: 66.667 / 100, lowerValue: 10, upperValue: 10 },
    ],
  );
});

test("Phygitals pack V2 drops zero-weight tiers but counts them toward the total", () => {
  const data = evidencedPackData();
  data.rarity_distribution = [
    { id: 1, name: "Empty", lower: 1, upper: 2, weight: 0 },
    { id: 2, name: "Everything", lower: 3, upper: 4, weight: 100 },
  ];
  const evInput = phygitalsPackProviderFactsV2(data).evInput;
  assert.equal(evInput.state, "present");
  if (evInput.state !== "present") return;
  assert.deepEqual(
    evInput.value.buckets.map(({ bucketId, probability }) => ({ bucketId, probability })),
    [{ bucketId: "2", probability: 1 }],
  );
});

test("Phygitals pack V2 reports a missing distribution absent and a broken one malformed", () => {
  const absent = evidencedPackData();
  delete absent.rarity_distribution;
  assert.deepEqual(phygitalsPackProviderFactsV2(absent).evInput, { state: "absent" });
  const nulled = evidencedPackData();
  nulled.rarity_distribution = null;
  assert.deepEqual(phygitalsPackProviderFactsV2(nulled).evInput, { state: "absent" });

  const tier = (overrides: Record<string, unknown>) => ({
    id: 1, name: "Tier", color: "#000000", lower: 1, upper: 9, weight: 100, ...overrides,
  });
  const malformed: [string, unknown][] = [
    ["not an array", "not-an-array"],
    ["empty array", []],
    ["non-object entry", [tier({}), "tier"]],
    ["weights not totalling 100", [tier({ weight: 99 })]],
    ["weights over 100", [tier({ weight: 60 }), tier({ id: 2, weight: 60 })]],
    ["all weights zero", [tier({ weight: 0 })]],
    ["negative weight", [tier({ weight: 110 }), tier({ id: 2, weight: -10 })]],
    ["non-numeric weight", [tier({ weight: "100" })]],
    ["missing id", [tier({ id: undefined })]],
    ["blank id", [tier({ id: "  " })]],
    ["duplicate ids", [tier({ weight: 50 }), tier({ weight: 50 })]],
    ["missing lower", [tier({ lower: undefined })]],
    ["non-numeric upper", [tier({ upper: "9" })]],
    ["negative lower", [tier({ lower: -1 })]],
    ["inverted range", [tier({ lower: 9, upper: 1 })]],
    ["non-text label", [tier({ name: 7 })]],
  ];
  for (const [label, rarity_distribution] of malformed) {
    const data = evidencedPackData();
    data.rarity_distribution = rarity_distribution;
    assert.deepEqual(
      phygitalsPackProviderFactsV2(data).evInput,
      { state: "malformed" },
      label,
    );
  }
});

test("distributed-v4 resolves the V2 pack reader; the frozen versions keep V1", () => {
  const data = evidencedPackData();
  assert.deepEqual(
    readDataforrestProviderFacts(
      DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION,
      "phygitals",
      "pack",
      data,
    ),
    phygitalsPackProviderFactsV2(data),
  );
  for (
    const version of [
      DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
      DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION,
    ]
  ) {
    const facts = readDataforrestProviderFacts(version, "phygitals", "pack", data);
    assert.deepEqual(facts, phygitalsPackProviderFactsV1(data), version);
    assert.deepEqual(facts?.evInput, { state: "absent" }, version);
  }
  // The reader is phygitals-only and pack-only on the new version too.
  for (const provider of ["clutchpacks", "collector_crypt", "courtyard"] as const) {
    assert.equal(
      readDataforrestProviderFacts(
        DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION,
        provider,
        "pack",
        data,
      ),
      null,
      provider,
    );
  }
});
