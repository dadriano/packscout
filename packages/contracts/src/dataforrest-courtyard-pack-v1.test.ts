import assert from "node:assert/strict";
import { test } from "node:test";
import { courtyardPackProviderFactsV1 } from
  "./dataforrest-courtyard-pack-v1.ts";
import { emptyNormalizedProviderFacts } from "./provider-source-facts-v1.ts";

/**
 * Synthetic Courtyard catalog-pack payload: the reviewed native key names,
 * JSON types, nullability and nesting are preserved, every value is invented.
 * Values that must never reach a normalized fact carry an `unreviewed-` prefix
 * so a single scan of the serialized output proves they stayed unread.
 */
function evidencedPackData(): Record<string, unknown> {
  return {
    id: "unreviewed-pack-id",
    title: "  Sample Pack  ",
    description: "  One card per pack.  ",
    category: {
      id: "unreviewed-category-id",
      title: "  Sample Category  ",
      color: "#101010",
      displayOrder: 1,
    },
    saleDetails: {
      salePriceUsd: 100,
      // Sub-cent noise from the provider's own ratio-times-price arithmetic.
      expectedValueUsd: 84.60000000000001,
      closed: false,
      maxPerTransaction: 4,
      enableEmbeddedWallets: true,
      enableExternalWallets: false,
      referralProgramEnabled: false,
    },
    buybackRatio: 0.846,
    odds: {
      minCardValueUsd: 10,
      buckets: [
        {
          tier: "unreviewed-bucket-tier-one",
          oddsPercent: 60,
          minValueUsd: 10,
          maxValueUsd: 24.99,
        },
        {
          tier: "unreviewed-bucket-tier-two",
          oddsPercent: 25,
          minValueUsd: 25,
          maxValueUsd: 99.99,
        },
        {
          tier: "unreviewed-bucket-tier-three",
          oddsPercent: 10,
          minValueUsd: 100,
          maxValueUsd: 499.99,
        },
        {
          tier: "unreviewed-bucket-tier-four",
          oddsPercent: 4,
          minValueUsd: 500,
          maxValueUsd: 999.99,
        },
        {
          tier: "unreviewed-bucket-tier-five",
          oddsPercent: 1,
          minValueUsd: 1_000,
          maxValueUsd: 5_000,
        },
      ],
    },
    outOfStock: true,
    status: "ACTIVE",
    featured: false,
    tier: { id: "unreviewed-tier-id", title: "unreviewed-tier-title" },
    sealedPackImage: " https://images.example.invalid/sealed-pack.png ",
    sealedPackThumbnail:
      "https://images.example.invalid/sealed-pack-thumbnail.png",
    vendingMachineImage:
      "https://images.example.invalid/unreviewed-vending-machine.png",
    vendingMachineThumbnail:
      "https://images.example.invalid/unreviewed-vending-thumbnail.png",
    heroBackgroundImage:
      "https://images.example.invalid/unreviewed-hero-background.png",
    heroForegroundImage:
      "https://images.example.invalid/unreviewed-hero-foreground.png",
    socialSharingImage:
      "https://images.example.invalid/unreviewed-social-sharing.png",
    sealedPackAnimation:
      "https://images.example.invalid/unreviewed-sealed-pack.mp4",
    revealAnimation: "https://images.example.invalid/unreviewed-reveal.mp4",
  };
}

function packData(mutate: (data: Record<string, unknown>) => void) {
  const data = evidencedPackData();
  mutate(data);
  return data;
}

function saleDetails(overrides: Record<string, unknown>) {
  return {
    ...(evidencedPackData().saleDetails as Record<string, unknown>),
    ...overrides,
  };
}

function oddsWithPercents(percents: readonly unknown[]) {
  return {
    minCardValueUsd: 10,
    buckets: percents.map((oddsPercent, index) => ({
      tier: `unreviewed-bucket-tier-${index}`,
      oddsPercent,
      minValueUsd: 10,
      maxValueUsd: 5_000,
    })),
  };
}

test("Courtyard pack v1 maps only exact evidenced facts", () => {
  const facts = courtyardPackProviderFactsV1(evidencedPackData());
  assert.deepEqual(facts, {
    ...emptyNormalizedProviderFacts("pack"),
    displayName: { state: "present", value: "Sample Pack" },
    description: { state: "present", value: "One card per pack." },
    category: { state: "present", value: "Sample Category" },
    imageReferences: {
      state: "present",
      value: [
        "https://images.example.invalid/sealed-pack.png",
        "https://images.example.invalid/sealed-pack-thumbnail.png",
      ],
    },
    price: { state: "present", value: { amount: 100, currency: "USD" } },
    providerReportedEv: {
      state: "present",
      value: { amount: 84.6, currency: "USD" },
    },
    buybackPercent: { state: "present", value: 84.6 },
    drawCount: { state: "present", value: 1 },
    evInput: { state: "absent" },
    authoritativeAvailability: {
      state: "present",
      value: { state: "sold_out", authority: "provider_explicit_sold_out" },
    },
  });
  const serialized = JSON.stringify(facts);
  assert.equal(serialized.includes("unreviewed-"), false, serialized);
  for (const unread of ["ACTIVE", "#101010", "minCardValueUsd", "oddsPercent"]) {
    assert.equal(serialized.includes(unread), false, unread);
  }
});

test("Courtyard pack v1 scales the 0..1 buyback ratio into a 0..100 percent", () => {
  // Every observed row publishes a ratio; binding it raw would understate the
  // buyback by 100x and still pass the mapper's 0..100 validation silently.
  const scaled: ReadonlyArray<readonly [number, number]> = [
    [0.846, 84.6],
    [0.896, 89.6],
    [0.9, 90],
    [0.5, 50],
    [1, 100],
    [0, 0],
  ];
  for (const [ratio, percent] of scaled) {
    assert.deepEqual(
      courtyardPackProviderFactsV1(
        packData((data) => {
          data.buybackRatio = ratio;
        }),
      ).buybackPercent,
      { state: "present", value: percent },
      String(ratio),
    );
  }

  const buybackPercent =
    courtyardPackProviderFactsV1(evidencedPackData()).buybackPercent;
  if (buybackPercent.state !== "present") assert.fail("expected a percent");
  assert.equal(buybackPercent.value, 84.6);
  assert.notEqual(buybackPercent.value, 0.846);

  // Above 1 a bare number cannot be told apart from an already-scaled percent,
  // so it is refused rather than multiplied by 100 a second time.
  for (const ambiguous of [1.05, 84.6, 90, 100, -0.001]) {
    assert.deepEqual(
      courtyardPackProviderFactsV1(
        packData((data) => {
          data.buybackRatio = ambiguous;
        }),
      ).buybackPercent,
      { state: "malformed" },
      String(ambiguous),
    );
  }
});

test("Courtyard pack v1 reads the display name from title, never provider_label", () => {
  // Production rejected all captured Courtyard packs because the envelope
  // fallback reads `provider_label`, which no Courtyard pack payload carries.
  const labelOnly = courtyardPackProviderFactsV1(
    packData((data) => {
      delete data.title;
      data.provider_label = "unreviewed-provider-label";
      data.name = "unreviewed-name";
    }),
  );
  assert.deepEqual(labelOnly.displayName, { state: "absent" });
  assert.equal(JSON.stringify(labelOnly).includes("unreviewed-"), false);

  const titleWins = courtyardPackProviderFactsV1(
    packData((data) => {
      data.provider_label = "unreviewed-provider-label";
      data.name = "unreviewed-name";
    }),
  );
  assert.deepEqual(titleWins.displayName, {
    state: "present",
    value: "Sample Pack",
  });
  assert.equal(JSON.stringify(titleWins).includes("unreviewed-"), false);
});

test("Courtyard pack v1 leaves evInput absent whatever the odds publish", () => {
  // The mapper requires an integer quantity per bucket plus a matching
  // totalQuantity; Courtyard publishes odds percentages and value ranges and
  // no quantity anywhere, so binding the odds would mark every pack malformed.
  const oddsShapes: unknown[] = [
    evidencedPackData().odds,
    null,
    undefined,
    {},
    oddsWithPercents([10, 20]),
    oddsWithPercents(["60", 40]),
    { minCardValueUsd: 10, buckets: [] },
  ];
  for (const odds of oddsShapes) {
    const facts = courtyardPackProviderFactsV1(
      packData((data) => {
        data.odds = odds;
      }),
    );
    assert.deepEqual(facts.evInput, { state: "absent" }, JSON.stringify(odds));
  }
});

test("Courtyard pack v1 derives one draw only from a closed odds distribution", () => {
  const present: unknown[] = [
    evidencedPackData().odds,
    oddsWithPercents([100]),
    oddsWithPercents([60, 25, 10, 4, 1.005]),
    oddsWithPercents([60, 25, 10, 4, 0.995]),
  ];
  for (const odds of present) {
    assert.deepEqual(
      courtyardPackProviderFactsV1(
        packData((data) => {
          data.odds = odds;
        }),
      ).drawCount,
      { state: "present", value: 1 },
      JSON.stringify(odds),
    );
  }

  const malformed: unknown[] = [
    {},
    { minCardValueUsd: 10, buckets: [] },
    { minCardValueUsd: 10, buckets: {} },
    { minCardValueUsd: 10, buckets: "60" },
    oddsWithPercents([60, 25, 10]),
    oddsWithPercents([60, 25, 10, 4, 1.02]),
    oddsWithPercents([60, 60]),
    oddsWithPercents([150, -50]),
    oddsWithPercents(["60", "40"]),
    oddsWithPercents([60, null]),
    { minCardValueUsd: 10, buckets: [null] },
    { minCardValueUsd: 10, buckets: [100] },
    [],
    "one draw",
  ];
  for (const odds of malformed) {
    assert.deepEqual(
      courtyardPackProviderFactsV1(
        packData((data) => {
          data.odds = odds;
        }),
      ).drawCount,
      { state: "malformed" },
      JSON.stringify(odds),
    );
  }
});

test("Courtyard pack v1 normalizes both money facts to cent precision in USD", () => {
  const rounded = courtyardPackProviderFactsV1(
    packData((data) => {
      data.saleDetails = saleDetails({
        salePriceUsd: 100.005,
        expectedValueUsd: 2_374.0499999999997,
      });
    }),
  );
  assert.deepEqual(rounded.price, {
    state: "present",
    value: { amount: 100.01, currency: "USD" },
  });
  assert.deepEqual(rounded.providerReportedEv, {
    state: "present",
    value: { amount: 2_374.05, currency: "USD" },
  });
});

test("Courtyard pack v1 leaves an unpublished optional fact absent", () => {
  const absentCases: ReadonlyArray<{
    readonly field: "displayName" | "description" | "category" | "price" |
      "providerReportedEv" | "buybackPercent" | "drawCount" |
      "imageReferences" | "authoritativeAvailability";
    readonly mutate: (data: Record<string, unknown>) => void;
  }> = [
    { field: "displayName", mutate: (data) => void delete data.title },
    { field: "displayName", mutate: (data) => void (data.title = null) },
    { field: "description", mutate: (data) => void delete data.description },
    { field: "description", mutate: (data) => void (data.description = null) },
    { field: "category", mutate: (data) => void delete data.category },
    { field: "category", mutate: (data) => void (data.category = null) },
    { field: "price", mutate: (data) => void delete data.saleDetails },
    { field: "price", mutate: (data) => void (data.saleDetails = null) },
    {
      field: "providerReportedEv",
      mutate: (data) => void delete data.saleDetails,
    },
    { field: "buybackPercent", mutate: (data) => void delete data.buybackRatio },
    {
      field: "buybackPercent",
      mutate: (data) => void (data.buybackRatio = null),
    },
    { field: "drawCount", mutate: (data) => void delete data.odds },
    // 19/109 captured rows publish `odds: null`.
    { field: "drawCount", mutate: (data) => void (data.odds = null) },
    {
      field: "imageReferences",
      mutate: (data) => {
        delete data.sealedPackImage;
        delete data.sealedPackThumbnail;
      },
    },
    {
      field: "imageReferences",
      mutate: (data) => {
        data.sealedPackImage = null;
        data.sealedPackThumbnail = null;
      },
    },
    {
      field: "authoritativeAvailability",
      mutate: (data) => void delete data.outOfStock,
    },
    {
      field: "authoritativeAvailability",
      mutate: (data) => void (data.outOfStock = false),
    },
  ];
  for (const scenario of absentCases) {
    assert.deepEqual(
      courtyardPackProviderFactsV1(packData(scenario.mutate))[scenario.field],
      { state: "absent" },
      scenario.field,
    );
  }
});

test("Courtyard pack v1 fails a published but wrong-typed fact closed", () => {
  const malformedCases: ReadonlyArray<{
    readonly field: "displayName" | "description" | "category" | "price" |
      "providerReportedEv" | "buybackPercent" | "imageReferences" |
      "authoritativeAvailability";
    readonly mutate: (data: Record<string, unknown>) => void;
  }> = [
    { field: "displayName", mutate: (data) => void (data.title = 42) },
    { field: "displayName", mutate: (data) => void (data.title = "   ") },
    { field: "displayName", mutate: (data) => void (data.title = ["Sample"]) },
    {
      field: "displayName",
      mutate: (data) => void (data.title = "x".repeat(10_001)),
    },
    { field: "description", mutate: (data) => void (data.description = 42) },
    // `category` is an object on every observed row; a bare string is not it.
    {
      field: "category",
      mutate: (data) => void (data.category = "Sample Category"),
    },
    { field: "category", mutate: (data) => void (data.category = []) },
    { field: "category", mutate: (data) => void (data.category = {}) },
    {
      field: "category",
      mutate: (data) => void (data.category = { title: 42 }),
    },
    {
      field: "category",
      mutate: (data) => void (data.category = { title: null }),
    },
    { field: "price", mutate: (data) => void (data.saleDetails = []) },
    { field: "price", mutate: (data) => void (data.saleDetails = "100") },
    {
      field: "price",
      mutate: (data) => void (data.saleDetails = saleDetails({
        salePriceUsd: "100",
      })),
    },
    {
      field: "price",
      mutate: (data) => void (data.saleDetails = saleDetails({
        salePriceUsd: -1,
      })),
    },
    {
      field: "price",
      mutate: (data) => void (data.saleDetails = saleDetails({
        salePriceUsd: 1e15,
      })),
    },
    {
      field: "price",
      mutate: (data) => {
        const details = saleDetails({});
        delete details.salePriceUsd;
        data.saleDetails = details;
      },
    },
    {
      field: "providerReportedEv",
      mutate: (data) => void (data.saleDetails = saleDetails({
        expectedValueUsd: null,
      })),
    },
    {
      field: "providerReportedEv",
      mutate: (data) => void (data.saleDetails = saleDetails({
        expectedValueUsd: "84.60",
      })),
    },
    {
      field: "buybackPercent",
      mutate: (data) => void (data.buybackRatio = "0.846"),
    },
    {
      field: "buybackPercent",
      mutate: (data) => void (data.buybackRatio = { ratio: 0.846 }),
    },
    {
      field: "imageReferences",
      mutate: (data) => void (data.sealedPackImage =
        "http://images.example.invalid/sealed-pack.png"),
    },
    {
      field: "imageReferences",
      mutate: (data) => void (data.sealedPackImage = "javascript:unsafe"),
    },
    {
      field: "imageReferences",
      mutate: (data) => void (data.sealedPackImage =
        "https://user:secret@images.example.invalid/sealed-pack.png"),
    },
    {
      field: "imageReferences",
      mutate: (data) => void (data.sealedPackThumbnail = "   "),
    },
    {
      field: "imageReferences",
      mutate: (data) => void (data.sealedPackThumbnail = 42),
    },
    {
      field: "imageReferences",
      mutate: (data) => void (data.sealedPackThumbnail =
        `https://images.example.invalid/${"x".repeat(2_048)}.png`),
    },
    {
      field: "authoritativeAvailability",
      mutate: (data) => void (data.outOfStock = "true"),
    },
    {
      field: "authoritativeAvailability",
      mutate: (data) => void (data.outOfStock = 1),
    },
  ];
  for (const scenario of malformedCases) {
    assert.deepEqual(
      courtyardPackProviderFactsV1(packData(scenario.mutate))[scenario.field],
      { state: "malformed" },
      scenario.field,
    );
  }
});

test("Courtyard pack v1 binds only the two pack-product images, deduplicated", () => {
  const thumbnailOnly = courtyardPackProviderFactsV1(
    packData((data) => {
      delete data.sealedPackImage;
    }),
  );
  assert.deepEqual(thumbnailOnly.imageReferences, {
    state: "present",
    value: ["https://images.example.invalid/sealed-pack-thumbnail.png"],
  });

  const duplicated = courtyardPackProviderFactsV1(
    packData((data) => {
      data.sealedPackThumbnail = "https://images.example.invalid/sealed-pack.png";
    }),
  );
  assert.deepEqual(duplicated.imageReferences, {
    state: "present",
    value: ["https://images.example.invalid/sealed-pack.png"],
  });

  // Scene, marketing and animation art is never promoted into the fact.
  const artOnly = courtyardPackProviderFactsV1(
    packData((data) => {
      delete data.sealedPackImage;
      delete data.sealedPackThumbnail;
    }),
  );
  assert.deepEqual(artOnly.imageReferences, { state: "absent" });
});
