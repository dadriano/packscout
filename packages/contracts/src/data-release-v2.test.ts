import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSyntheticDataReleaseV2,
  SYNTHETIC_CARDS_CATEGORY_ID,
  SYNTHETIC_CHARIZARD_ID,
  SYNTHETIC_FOCUSED_REPACK_ID,
  SYNTHETIC_MIXED_REPACK_ID,
  SYNTHETIC_POKEMON_CATEGORY_ID,
  SYNTHETIC_WATCHES_CATEGORY_ID,
} from "./__fixtures__/data-release-v2.fixture.ts";
import {
  MAX_REPACK_CHASES_PER_COLLECTIBLE,
  buildPublicCollectibleSearchText,
  publicConfidenceSchema,
  publicMoneySchema,
  publicPriceSchema,
  publicRepackDetailSchema,
  publicRepackSummaryFromDetail,
  publicRepackSummarySchema,
  safeParseDataReleaseManifestV2,
  vendorReportedEvSchema,
} from "./data-release-v2.ts";

function rejectionMessages(input: unknown): readonly string[] {
  const result = safeParseDataReleaseManifestV2(input);
  assert.equal(result.success, false);
  return result.success ? [] : result.error.issues.map(({ message }) => message);
}

test("V2 publishes aggregate vendors, hierarchy, mixed repacks, EV sources, and chases", () => {
  const release = buildSyntheticDataReleaseV2();
  assert.equal(release.metadata.schemaVersion, "data_release_v2");
  assert.equal(release.vendors.length, 1);
  assert.equal(release.categories[1]?.parentPublicCategoryId, release.categories[0]?.publicCategoryId);
  assert.equal(release.repacks[0]?.contentMode, "focused");
  assert.equal(release.repacks[1]?.contentMode, "mixed");
  assert.equal(release.repacks[0]?.evEstimates.vendorReported.status, "available");
  assert.equal(release.repacks[0]?.evEstimates.packScout.status, "available");
  assert.equal(release.repacks[0]?.evEstimates.packScout.confidence.band, "medium");
  assert.equal(release.repacks[0]?.topChase?.publicCollectibleId, SYNTHETIC_CHARIZARD_ID);
  assert.equal(
    release.repackChases.filter(
      ({ publicCollectibleId }) => publicCollectibleId === SYNTHETIC_CHARIZARD_ID,
    ).length,
    2,
  );

  const summary = publicRepackSummaryFromDetail(release.repacks[0]!);
  assert.equal(publicRepackSummarySchema.safeParse(summary).success, true);
  assert.equal(summary.actionAvailability.repackLink, true);
  assert.equal("actions" in summary, false);
  assert.equal("description" in summary, false);
});

test("aggregate V2 records may be fresher than the oldest provider data-as-of", () => {
  const release = structuredClone(buildSyntheticDataReleaseV2());
  const fresherProviderTime = "2026-08-11T08:30:03.000Z";
  release.collectibles[0]!.dataAsOf = fresherProviderTime;
  release.repacks[0]!.sourceUpdatedAt = fresherProviderTime;
  release.repackChases[0]!.observedAt = fresherProviderTime;
  assert.ok(release.repacks[0]!.topChase);
  release.repacks[0]!.topChase.observedAt = fresherProviderTime;
  release.repacks[0]!.evEstimates.vendorReported.observedAt =
    fresherProviderTime;
  const packScout = release.repacks[0]!.evEstimates.packScout;
  assert.equal(packScout.status, "available");
  if (packScout.status === "available") {
    packScout.dataAsOf = fresherProviderTime;
    packScout.calculatedAt = "2026-08-11T08:31:01.000Z";
  }

  assert.ok(
    Date.parse(fresherProviderTime) > Date.parse(release.metadata.dataAsOf),
  );
  assert.equal(safeParseDataReleaseManifestV2(release).success, true);
});

test("V2 enforces comparable EV arithmetic and confidence bands", () => {
  const badMath = structuredClone(buildSyntheticDataReleaseV2());
  const packScout = badMath.repacks[0]!.evEstimates.packScout;
  assert.equal(packScout.status, "available");
  if (packScout.status === "available") packScout.metrics.evDollars.minorUnits += 1;
  assert.ok(rejectionMessages(badMath).includes("public_ev.price_inconsistent"));

  const badBand = structuredClone(buildSyntheticDataReleaseV2());
  const estimate = badBand.repacks[0]!.evEstimates.packScout;
  assert.equal(estimate.status, "available");
  if (estimate.status === "available") estimate.confidence.band = "high";
  assert.ok(rejectionMessages(badBand).includes("public_confidence.band_mismatch"));

  assert.equal(
    publicConfidenceSchema.safeParse({
      scoreBasisPoints: 9_000,
      band: "high",
      limitationCodes: [
        "currency_normalization_applied",
        "estimated_value_ranges",
        "vendor_probability_inputs",
      ],
    }).success,
    true,
  );
  assert.equal(
    publicConfidenceSchema.safeParse({
      scoreBasisPoints: 9_000,
      band: "high",
      limitationCodes: ["model_feature_weights"],
    }).success,
    false,
  );

  const exactBoundary = structuredClone(buildSyntheticDataReleaseV2());
  const repack = exactBoundary.repacks[0]!;
  const grossMinor = Number.MAX_SAFE_INTEGER;
  const priceMinor = 10_000;
  const grossReturnBasisPoints = Number.MAX_SAFE_INTEGER;
  repack.price = {
    displayMoney: { minorUnits: priceMinor, currency: "USD" },
    usdComparison: {
      status: "available",
      value: { minorUnits: priceMinor, currency: "USD" },
    },
  };
  const exactEstimate = repack.evEstimates.vendorReported;
  assert.equal(exactEstimate.status, "available");
  if (exactEstimate.status === "available") {
    exactEstimate.displayMoney.minorUnits = grossMinor;
    exactEstimate.metrics = {
      grossEv: { minorUnits: grossMinor, currency: "USD" },
      grossReturnBasisPoints,
      evDollars: {
        minorUnits: grossMinor - priceMinor,
        currency: "USD",
      },
      evPercentBasisPoints: grossReturnBasisPoints - 10_000,
    };
  }
  assert.equal(
    publicRepackDetailSchema.safeParse(repack).success,
    true,
    "safe-integer EV arithmetic must not lose precision during validation",
  );
});

test("public display money accepts only ISO 4217-style currency codes", () => {
  assert.equal(
    publicMoneySchema.safeParse({ minorUnits: 100, currency: "USD" }).success,
    true,
  );
  assert.equal(
    publicMoneySchema.safeParse({ minorUnits: 100, currency: "USDC" }).success,
    false,
  );
  const unavailableUsdComparison = publicPriceSchema.safeParse({
    displayMoney: { minorUnits: 100, currency: "USD" },
    usdComparison: {
      status: "unavailable",
      value: null,
      reason: "CURRENCY_UNSUPPORTED",
    },
  });
  assert.equal(unavailableUsdComparison.success, false);
  assert.ok(
    !unavailableUsdComparison.success &&
      unavailableUsdComparison.error.issues.some(
        ({ message }) => message === "public_price.usd_evidence_mismatch",
      ),
  );
});

test("vendor EV preserves reported money when comparison metrics are unavailable", () => {
  assert.equal(
    vendorReportedEvSchema.safeParse({
      status: "unavailable",
      displayMoney: { minorUnits: 1_850, currency: "USDC" },
      metrics: null,
      observedAt: "2026-08-11T08:30:02Z",
      reason: "CURRENCY_UNSUPPORTED",
    }).success,
    true,
  );
  assert.equal(
    vendorReportedEvSchema.safeParse({
      status: "unavailable",
      displayMoney: { minorUnits: 1_850, currency: "USDC" },
      metrics: null,
      observedAt: "2026-08-11T08:30:02Z",
      reason: "NOT_REPORTED",
    }).success,
    false,
  );
  assert.equal(
    vendorReportedEvSchema.safeParse({
      status: "available",
      displayMoney: { minorUnits: 8_499, currency: "USD" },
      metrics: {
        grossEv: { minorUnits: 8_500, currency: "USD" },
        grossReturnBasisPoints: 8_500,
        evDollars: { minorUnits: -1_500, currency: "USD" },
        evPercentBasisPoints: -1_500,
      },
      observedAt: "2026-08-11T08:30:02Z",
    }).success,
    false,
  );
});

test("collectible search projections derive from display identity", () => {
  const release = buildSyntheticDataReleaseV2();
  const collectible = release.collectibles[0]!;
  assert.equal(
    collectible.searchText,
    "charizard ex 199 sv151 2023 pokemon 151 165 10 psa",
  );
  assert.equal(
    collectible.searchText,
    buildPublicCollectibleSearchText(collectible),
  );

  const badName = structuredClone(buildSyntheticDataReleaseV2());
  badName.collectibles[0]!.normalizedName = "unrelated collectible";
  assert.ok(
    rejectionMessages(badName).includes(
      "public_collectible.normalized_name_mismatch",
    ),
  );

  const badAlias = structuredClone(buildSyntheticDataReleaseV2());
  badAlias.collectibles[0]!.normalizedAliases[0] = "unrelated alias";
  assert.ok(
    rejectionMessages(badAlias).includes(
      "public_collectible.normalized_alias_mismatch",
    ),
  );

  const extraSearchTerm = structuredClone(buildSyntheticDataReleaseV2());
  extraSearchTerm.collectibles[0]!.searchText += " provider-internal-signal";
  assert.ok(
    rejectionMessages(extraSearchTerm).includes(
      "public_collectible.search_text_mismatch",
    ),
  );

  const staleSearchProjection = structuredClone(buildSyntheticDataReleaseV2());
  staleSearchProjection.collectibles[0]!.grader = "BGS";
  assert.ok(
    rejectionMessages(staleSearchProjection).includes(
      "public_collectible.search_text_mismatch",
    ),
  );
});

test("V2 enforces release references, content mode, and top-chase projection", () => {
  const badMode = structuredClone(buildSyntheticDataReleaseV2());
  badMode.repacks[1]!.contentMode = "focused";
  assert.ok(rejectionMessages(badMode).includes("data_release.content_mode_mismatch"));

  const missingChase = structuredClone(buildSyntheticDataReleaseV2());
  missingChase.repackChases = missingChase.repackChases.filter(
    ({ publicRepackId, role }) =>
      publicRepackId !== SYNTHETIC_FOCUSED_REPACK_ID || role !== "top_chase",
  );
  missingChase.metadata.repackChaseCount -= 1;
  assert.ok(
    rejectionMessages(missingChase).includes(
      "data_release.top_chase_projection_mismatch",
    ),
  );

  const lowerDeclaredTopValue = structuredClone(buildSyntheticDataReleaseV2());
  const canonicalRolex = lowerDeclaredTopValue.collectibles.find(
    ({ publicCollectibleId }) =>
      publicCollectibleId === lowerDeclaredTopValue.repackChases[1]!
        .publicCollectibleId,
  )!;
  const declaredTopRelation = lowerDeclaredTopValue.repackChases[1]!;
  const projectedTop = lowerDeclaredTopValue.repacks[1]!.topChase!;
  for (const collectible of [
    canonicalRolex,
    declaredTopRelation.collectible,
    projectedTop.collectible,
  ]) {
    assert.notEqual(collectible.valuation, null);
    if (collectible.valuation !== null) {
      collectible.valuation.displayMoney = {
        minorUnits: 50_000,
        currency: "USD",
      };
      collectible.valuation.usdComparison = {
        status: "available",
        value: { minorUnits: 50_000, currency: "USD" },
      };
    }
  }
  assert.ok(
    rejectionMessages(lowerDeclaredTopValue).includes(
      "data_release.top_chase_projection_mismatch",
    ),
  );
});

test("V2 bounds exact desired-chase relations per collectible", () => {
  assert.equal(MAX_REPACK_CHASES_PER_COLLECTIBLE, 500);
  const overLimit = structuredClone(buildSyntheticDataReleaseV2());
  const templateRepack = overLimit.repacks[0]!;
  const templateChase = overLimit.repackChases[0]!;
  const relationCount = MAX_REPACK_CHASES_PER_COLLECTIBLE + 1;
  const publicRepackIds = Array.from({ length: relationCount }, (_, index) =>
    `50000000-0000-5000-8000-${String(index + 1).padStart(12, "0")}`
  );
  overLimit.repacks = publicRepackIds.map((publicRepackId) => {
    const topChase = {
      ...structuredClone(templateChase),
      publicRepackId,
    };
    return {
      ...structuredClone(templateRepack),
      publicRepackId,
      topChase,
    };
  });
  overLimit.repackChases = publicRepackIds.map((publicRepackId) => ({
    ...structuredClone(templateChase),
    publicRepackId,
  }));
  overLimit.metadata.repackCount = relationCount;
  overLimit.metadata.repackChaseCount = relationCount;
  assert.ok(
    rejectionMessages(overLimit).includes(
      "data_release.collectible_chase_limit_exceeded",
    ),
  );
});

test("V2 requires complete category paths and canonical chase ordering", () => {
  const missingAncestor = structuredClone(buildSyntheticDataReleaseV2());
  missingAncestor.repacks[0]!.categories = missingAncestor.repacks[0]!.categories
    .filter(
      ({ publicCategoryId }) =>
        publicCategoryId !== SYNTHETIC_CARDS_CATEGORY_ID,
    );
  missingAncestor.repacks[0]!.contentSummary.categoryCount -= 1;
  assert.ok(
    rejectionMessages(missingAncestor).includes(
      "data_release.repack_category_path_incomplete",
    ),
  );

  const swappedChases = structuredClone(buildSyntheticDataReleaseV2());
  [swappedChases.repackChases[1], swappedChases.repackChases[2]] = [
    swappedChases.repackChases[2]!,
    swappedChases.repackChases[1]!,
  ];
  assert.ok(
    rejectionMessages(swappedChases).includes(
      "data_release.entities_not_canonical",
    ),
  );
});

test("V2 rejects raw, tenant, and proprietary calculation fields", () => {
  const release = buildSyntheticDataReleaseV2();
  const raw = { ...release, data: { providerPayload: true } };
  assert.equal(safeParseDataReleaseManifestV2(raw).success, false);

  const proprietary = structuredClone(release) as unknown as {
    repacks: Array<{ evEstimates: { packScout: Record<string, unknown> } }>;
  };
  proprietary.repacks[0]!.evEstimates.packScout.inputManifest = {
    sourceRevisionIds: ["protected"],
  };
  assert.equal(safeParseDataReleaseManifestV2(proprietary).success, false);
});

test("category hierarchy rejects cycles and duplicate public keys", () => {
  const cycle = structuredClone(buildSyntheticDataReleaseV2());
  const cards = cycle.categories[0]!;
  const pokemon = cycle.categories[1]!;
  cards.parentPublicCategoryId = SYNTHETIC_POKEMON_CATEGORY_ID;
  cards.depth = 1;
  cards.pathPublicCategoryIds = [
    SYNTHETIC_POKEMON_CATEGORY_ID,
    SYNTHETIC_CARDS_CATEGORY_ID,
  ];
  pokemon.parentPublicCategoryId = SYNTHETIC_CARDS_CATEGORY_ID;
  pokemon.depth = 1;
  pokemon.pathPublicCategoryIds = [
    SYNTHETIC_CARDS_CATEGORY_ID,
    SYNTHETIC_POKEMON_CATEGORY_ID,
  ];
  assert.ok(
    rejectionMessages(cycle).includes("data_release.category_hierarchy_invalid"),
  );

  const duplicateVendorKey = structuredClone(buildSyntheticDataReleaseV2());
  duplicateVendorKey.vendors.push({
    ...structuredClone(duplicateVendorKey.vendors[0]!),
    publicVendorId: "00000000-0000-5000-8000-000000000002",
  });
  duplicateVendorKey.metadata.vendorCount += 1;
  assert.ok(
    rejectionMessages(duplicateVendorKey).includes(
      "data_release.vendor_key_not_unique",
    ),
  );

  const duplicateCategoryKey = structuredClone(buildSyntheticDataReleaseV2());
  duplicateCategoryKey.categories.push({
    ...structuredClone(duplicateCategoryKey.categories[2]!),
    publicCategoryId: "00000000-0000-5000-8000-000000000104",
    pathPublicCategoryIds: ["00000000-0000-5000-8000-000000000104"],
  });
  duplicateCategoryKey.metadata.categoryCount += 1;
  assert.ok(
    rejectionMessages(duplicateCategoryKey).includes(
      "data_release.category_key_not_unique",
    ),
  );
});

test("repack category labels and chase projections must match canonical entities", () => {
  const wrongCategoryLabel = structuredClone(buildSyntheticDataReleaseV2());
  wrongCategoryLabel.repacks[0]!.categories[1]!.label = "Not Pokémon";
  assert.ok(
    rejectionMessages(wrongCategoryLabel).includes(
      "data_release.repack_reference_invalid",
    ),
  );

  const wrongHydratedCollectible = structuredClone(buildSyntheticDataReleaseV2());
  wrongHydratedCollectible.repackChases[0]!.collectible.name = "Wrong chase";
  assert.ok(
    rejectionMessages(wrongHydratedCollectible).includes(
      "data_release.chase_collectible_projection_invalid",
    ),
  );

  const wrongClassification = structuredClone(buildSyntheticDataReleaseV2());
  wrongClassification.repacks[0]!.collectibleTypes = ["watch"];
  assert.ok(
    rejectionMessages(wrongClassification).includes(
      "data_release.chase_classification_mismatch",
    ),
  );

  const wrongCount = structuredClone(buildSyntheticDataReleaseV2());
  wrongCount.repacks[0]!.contentSummary.chaseCount = 0;
  assert.ok(
    rejectionMessages(wrongCount).includes("data_release.chase_count_mismatch"),
  );

  const unapprovedImage = structuredClone(buildSyntheticDataReleaseV2());
  const image = {
    url: "https://unapproved.example/chase.webp",
    alt: "Unapproved chase image",
  };
  unapprovedImage.collectibles[0]!.primaryImage = image;
  unapprovedImage.repackChases[0]!.collectible.primaryImage = image;
  unapprovedImage.repackChases[1]!.collectible.primaryImage = image;
  unapprovedImage.repacks[0]!.topChase!.collectible.primaryImage = image;
  assert.ok(
    rejectionMessages(unapprovedImage).includes(
      "data_release.collectible_reference_invalid",
    ),
  );
  assert.ok(
    rejectionMessages(unapprovedImage).includes(
      "data_release.chase_collectible_projection_invalid",
    ),
  );

  const ungovernedVendorOrigin = structuredClone(buildSyntheticDataReleaseV2());
  ungovernedVendorOrigin.vendors[0]!.imageOrigins.push(
    "https://ungoverned.example",
  );
  assert.ok(
    rejectionMessages(ungovernedVendorOrigin).includes(
      "data_release.vendor_image_origin_not_governed",
    ),
  );

  const mismatchedPromo = structuredClone(buildSyntheticDataReleaseV2());
  mismatchedPromo.repacks[0]!.actions.promo = {
    code: "SCOUT",
    label: "Unapproved copy",
  };
  assert.ok(
    rejectionMessages(mismatchedPromo).includes(
      "data_release.repack_promo_not_approved",
    ),
  );
});

test("PackScout EV policy and calculation times are bound to their release", () => {
  const wrongPolicy = structuredClone(buildSyntheticDataReleaseV2());
  const estimate = wrongPolicy.repacks[0]!.evEstimates.packScout;
  assert.equal(estimate.status, "available");
  if (estimate.status === "available") {
    estimate.confidencePolicyVersion = "different-policy";
  }
  assert.ok(
    rejectionMessages(wrongPolicy).includes(
      "data_release.confidence_policy_mismatch",
    ),
  );

  const beforeData = structuredClone(buildSyntheticDataReleaseV2());
  const beforeEstimate = beforeData.repacks[0]!.evEstimates.packScout;
  assert.equal(beforeEstimate.status, "available");
  if (beforeEstimate.status === "available") {
    beforeEstimate.calculatedAt = "2026-08-11T08:29:00Z";
  }
  assert.ok(
    rejectionMessages(beforeData).includes(
      "data_release.packscout_timing_invalid",
    ),
  );

  const afterRelease = structuredClone(buildSyntheticDataReleaseV2());
  const afterEstimate = afterRelease.repacks[0]!.evEstimates.packScout;
  assert.equal(afterEstimate.status, "available");
  if (afterEstimate.status === "available") {
    afterEstimate.calculatedAt = "2026-08-11T08:33:00Z";
  }
  assert.ok(
    rejectionMessages(afterRelease).includes(
      "data_release.packscout_timing_invalid",
    ),
  );

  const calculatedBeforeExport = structuredClone(buildSyntheticDataReleaseV2());
  const preExportEstimate = calculatedBeforeExport.repacks[0]!.evEstimates
    .packScout;
  assert.equal(preExportEstimate.status, "available");
  if (preExportEstimate.status === "available") {
    preExportEstimate.dataAsOf = "2026-08-11T08:28:00Z";
    preExportEstimate.calculatedAt = "2026-08-11T08:29:00Z";
  }
  assert.equal(
    safeParseDataReleaseManifestV2(calculatedBeforeExport).success,
    true,
  );

  const unavailableWithCalculation = structuredClone(
    buildSyntheticDataReleaseV2(),
  );
  const unavailableEstimate = unavailableWithCalculation.repacks[1]!.evEstimates
    .packScout;
  assert.equal(unavailableEstimate.status, "unavailable");
  if (unavailableEstimate.status === "unavailable") {
    unavailableEstimate.dataAsOf = null;
    unavailableEstimate.calculatedAt = "2026-08-11T08:31:30Z";
  }
  assert.equal(
    safeParseDataReleaseManifestV2(unavailableWithCalculation).success,
    true,
  );
});

test("vendor-reported EV observations are bound to provider and completion windows", () => {
  const afterCompletion = structuredClone(buildSyntheticDataReleaseV2());
  const lateEstimate = afterCompletion.repacks[0]!.evEstimates
    .vendorReported;
  assert.equal(lateEstimate.status, "available");
  lateEstimate.observedAt = "2026-08-11T08:33:00Z";
  assert.ok(
    rejectionMessages(afterCompletion).includes(
      "data_release.vendor_ev_timing_invalid",
    ),
  );

  const observedBeforeExport = structuredClone(buildSyntheticDataReleaseV2());
  const preExportEstimate = observedBeforeExport.repacks[0]!.evEstimates
    .vendorReported;
  assert.equal(preExportEstimate.status, "available");
  preExportEstimate.observedAt = "2026-08-11T08:29:00Z";
  assert.equal(safeParseDataReleaseManifestV2(observedBeforeExport).success, true);
});

test("USD valuation evidence must reconcile across canonical and hydrated views", () => {
  const mismatch = structuredClone(buildSyntheticDataReleaseV2());
  const valuation = mismatch.collectibles[0]!.valuation;
  assert.notEqual(valuation, null);
  if (valuation !== null && valuation.displayMoney !== null) {
    valuation.displayMoney.minorUnits += 1;
  }
  assert.ok(
    rejectionMessages(mismatch).includes("public_valuation.usd_evidence_mismatch"),
  );
});

test("either classification dimension can prove mixed while neither yields unknown", () => {
  const categoryOnly = structuredClone(buildSyntheticDataReleaseV2());
  const focused = categoryOnly.repacks[0]!;
  focused.categories.push({
    publicCategoryId: SYNTHETIC_WATCHES_CATEGORY_ID,
    label: "Watches",
  });
  focused.contentSummary.categoryCount += 1;
  focused.contentMode = "mixed";
  assert.equal(safeParseDataReleaseManifestV2(categoryOnly).success, true);

  const typeOnly = structuredClone(buildSyntheticDataReleaseV2());
  const typeFocused = typeOnly.repacks[0]!;
  typeFocused.collectibleTypes.push("watch");
  typeFocused.contentSummary.collectibleTypeCount += 1;
  typeFocused.contentMode = "mixed";
  assert.equal(safeParseDataReleaseManifestV2(typeOnly).success, true);

  const unknown = structuredClone(buildSyntheticDataReleaseV2());
  const mixed = unknown.repacks.find(
    ({ publicRepackId }) => publicRepackId === SYNTHETIC_MIXED_REPACK_ID,
  )!;
  mixed.categories = [];
  mixed.collectibleTypes = [];
  mixed.topChase = null;
  mixed.contentMode = "unknown";
  mixed.contentSummary = {
    ...mixed.contentSummary,
    knownCollectibleCount: 0,
    chaseCount: 0,
    categoryCount: 0,
    collectibleTypeCount: 0,
  };
  unknown.repackChases = unknown.repackChases.filter(
    ({ publicRepackId }) => publicRepackId !== SYNTHETIC_MIXED_REPACK_ID,
  );
  unknown.metadata.repackChaseCount = unknown.repackChases.length;
  assert.equal(safeParseDataReleaseManifestV2(unknown).success, true);
});
