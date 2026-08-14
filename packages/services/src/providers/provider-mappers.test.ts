import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import type { ProviderFeedPageV1 } from "@packscout/contracts";
import { CatalogProjectionService } from "../catalog-projection-service.ts";
import {
  calculatePackScoutEstimatedEv,
  type PackScoutEstimatedEvResult,
} from "../estimated-ev-calculator.ts";
import {
  EventProjectionService,
  HmacProviderActorPseudonymizer,
} from "../event-projection-service.ts";
import type {
  CanonicalPackCandidate,
  EvInputCandidate,
  ProviderMappingAdapter,
  ProviderMappingOutput,
  ProviderRecordMappingOutcome,
} from "../provider-adapter.ts";
import {
  beezieProviderMappingAdapter,
  BEEZIE_MAPPING_KEY,
  BEEZIE_SOURCE_SHA256,
} from "./beezie/mapper.ts";
import {
  clutchpacksProviderMappingAdapter,
  CLUTCHPACKS_MAPPING_KEY,
  CLUTCHPACKS_SOURCE_SHA256,
} from "./clutchpacks/mapper.ts";
import {
  beezieSanitizedPage,
  clutchpacksSanitizedPage,
} from "./fixtures/task-014-sanitized.ts";
import {
  createProviderMappingAdapterRegistryFromManifest,
  providerMapperManifest,
} from "./provider-mapper-manifest.ts";

const eventProjection = new EventProjectionService(
  new HmacProviderActorPseudonymizer("task-014-test-key-material-32-bytes"),
);
const catalogProjection = new CatalogProjectionService();

function configuration(adapter: ProviderMappingAdapter) {
  return {
    providerId: `provider-${adapter.platformKey}`,
    configurationRevisionId: `revision-${adapter.platformKey}`,
    platform: adapter.platformKey,
    adapterKey: adapter.key,
  };
}

function indexes(page: ProviderFeedPageV1, offset = 0) {
  return {
    catalog: page.catalog.map((_, index) => offset + index),
    pulls: page.pulls.map((_, index) => offset + page.catalog.length + index),
    sales: page.sales.map(
      (_, index) =>
        offset + page.catalog.length + page.pulls.length + index,
    ),
  };
}

function map(
  adapter: ProviderMappingAdapter,
  page: ProviderFeedPageV1,
  offset = 0,
): ProviderMappingOutput {
  return adapter.mapPage({
    configuration: configuration(adapter),
    page,
    recordIndexes: indexes(page, offset),
  }) as ProviderMappingOutput;
}

function mapped(
  outcome: ProviderRecordMappingOutcome | undefined,
): Extract<ProviderRecordMappingOutcome, { status: "mapped" }> {
  assert.ok(outcome);
  assert.equal(outcome.status, "mapped");
  return outcome;
}

function canonicalProjection(
  adapter: ProviderMappingAdapter,
  outcome: Extract<ProviderRecordMappingOutcome, { status: "mapped" }>,
) {
  const service =
    outcome.source.recordKind === "catalog"
      ? catalogProjection
      : eventProjection;
  const result = service.project({
    configuration: configuration(adapter),
    source: outcome.source,
    candidates: outcome.candidates,
  });
  assert.equal(result.status, "accepted");
  return result;
}

function evResult(
  pack: CanonicalPackCandidate,
  evInput: EvInputCandidate,
  verifiedUsdStablecoins: readonly string[],
): PackScoutEstimatedEvResult {
  return calculatePackScoutEstimatedEv({
    packPrice:
      pack.price === null || pack.price === undefined
        ? null
        : {
            valueMinor: Math.round(pack.price.amount * 100),
            currency: pack.price.currency,
            sourceRevisionId: "pack-revision",
          },
    distributionCurrency: evInput.currency,
    unitBasis: evInput.unitBasis,
    drawCount: evInput.drawCount,
    declaredCoverage: evInput.declaredCoverage,
    evidenceCompleteness: evInput.evidenceCompleteness,
    buckets: evInput.buckets
      .filter((bucket) => bucket.evidenceKind === "probability_bucket")
      .map((bucket) => ({
        probability: bucket.probability,
        lowerValueMinor:
          bucket.lowerValue === null
            ? null
            : Math.round(bucket.lowerValue * 100),
        upperValueMinor:
          bucket.upperValue === null
            ? null
            : Math.round(bucket.upperValue * 100),
        sourceRevisionId: "ev-input-revision",
      })),
    sourceAt: evInput.source.sourceTimestamp,
    calculatedAt: "2026-08-06T12:00:00Z",
    currencyPolicy: { verifiedUsdStablecoins },
  });
}

test("provider mapper manifest registers all eight providers without branches", () => {
  assert.deepEqual(
    providerMapperManifest.map((entry) => [
      entry.platformKey,
      entry.adapterKey,
      entry.mappingVersion,
      entry.sourceContract.observedRecordCounts,
    ]),
    [
      [
        "beezie",
        BEEZIE_MAPPING_KEY,
        "v1",
        { catalog: 4, pull: 15, sale: 15 },
      ],
      [
        "clutchpacks",
        CLUTCHPACKS_MAPPING_KEY,
        "v1",
        { catalog: 14, pull: 15, sale: 15 },
      ],
      [
        "collector_crypt",
        "collector-crypt-v1",
        "v1",
        { catalog: 14, pull: 15, sale: 15 },
      ],
      [
        "courtyard",
        "courtyard-v1",
        "v1",
        { catalog: 11, pull: 15, sale: 15 },
      ],
      [
        "gamestop",
        "gamestop-v1",
        "v1",
        { catalog: 8, pull: 15, sale: 0 },
      ],
      [
        "phygitals",
        "phygitals-v1",
        "v1",
        { catalog: 15, pull: 15, sale: 15 },
      ],
      [
        "stadium_vault",
        "stadium-vault-v1",
        "v1",
        { catalog: 14, pull: 15, sale: 0 },
      ],
      [
        "trove",
        "trove-v1",
        "v1",
        { catalog: 15, pull: 15, sale: 0 },
      ],
    ],
  );
  const registry = createProviderMappingAdapterRegistryFromManifest();
  for (const entry of providerMapperManifest) {
    assert.equal(registry.resolveForPlatform(entry.platformKey), entry.adapter);
  }
});

test("Beezie maps micro-USDC, complete tier evidence, null pack links, token sales, and provenance", () => {
  const before = structuredClone(beezieSanitizedPage);
  const first = map(beezieProviderMappingAdapter, beezieSanitizedPage, 7);
  const second = map(beezieProviderMappingAdapter, beezieSanitizedPage, 7);
  assert.deepEqual(first, second);
  assert.deepEqual(beezieSanitizedPage, before);
  assert.equal(first.outcomes.length, 3);

  const catalog = mapped(first.outcomes[0]);
  assert.equal(catalog.source.recordIndex, 7);
  const pack = catalog.candidates.find(
    (candidate): candidate is CanonicalPackCandidate =>
      candidate.candidateKind === "pack",
  );
  const evInput = catalog.candidates.find(
    (candidate): candidate is EvInputCandidate =>
      candidate.candidateKind === "ev_input",
  );
  assert.ok(pack);
  assert.ok(evInput);
  assert.equal(catalog.source.sourceTimestamp, "2026-08-04T15:11:24Z");
  assert.equal(catalog.source.collectedAt, "2026-08-04T15:11:24Z");
  assert.equal(pack.availability, "active");
  assert.equal(pack.sourceStatus, "active");
  assert.deepEqual(pack.price, { amount: 50, currency: "USDC" });
  assert.deepEqual(pack.providerReportedEv, {
    amount: 55,
    currency: "USDC",
  });
  assert.equal(pack.buybackPercent, 94);
  assert.ok(
    pack.dataQualityEvidence.some(
      (item) => item.code === "BEEZIE_BUYBACK_DERIVED_FROM_SWAP_FEES",
    ),
  );
  assert.equal(evInput.evidenceCompleteness, "complete");
  assert.ok(Math.abs((evInput.declaredCoverage ?? 0) - 1) < 1e-12);
  assert.equal(
    evInput.buckets.filter((bucket) => bucket.evidenceKind === "probability_bucket")
      .length,
    5,
  );
  assert.equal(
    evInput.buckets.filter((bucket) => bucket.evidenceKind === "top_chase")
      .length,
    1,
  );
  const estimated = evResult(pack, evInput, ["USDC"]);
  assert.equal(estimated.status, "estimated");

  const pull = mapped(first.outcomes[1]);
  const pullCandidate = pull.candidates[0];
  assert.equal(pullCandidate?.candidateKind, "pull");
  if (pullCandidate?.candidateKind !== "pull") assert.fail("Expected pull.");
  assert.equal(pullCandidate.packExternalId, null);
  assert.deepEqual(pullCandidate.value, { amount: 31, currency: "USDC" });
  assert.deepEqual(pullCandidate.pseudonymizationInputs, [
    {
      role: "owner",
      namespace: "beezie:wallet",
      sourceIdentifier: "fixture-wallet-a",
    },
  ]);

  const sale = mapped(first.outcomes[2]);
  const saleCandidate = sale.candidates[0];
  assert.equal(saleCandidate?.candidateKind, "sale");
  if (saleCandidate?.candidateKind !== "sale") assert.fail("Expected sale.");
  assert.deepEqual(saleCandidate.amount, {
    amount: 35,
    currency: "0xBB5eC6fD4B61723BD45C399840F1d868840ca16F",
  });
  assert.equal(saleCandidate.transactionKey, beezieSanitizedPage.sales[0]?.tx_hash);

  for (const outcome of [catalog, pull, sale]) {
    const projection = canonicalProjection(beezieProviderMappingAdapter, outcome);
    const serialized = JSON.stringify(projection);
    assert.equal(serialized.includes("fixture-wallet-a"), false);
    assert.equal(serialized.includes("fixture-wallet-b"), false);
    assert.equal(serialized.includes('"fromUsername"'), false);
  }
  const projectedCatalog = canonicalProjection(
    beezieProviderMappingAdapter,
    catalog,
  );
  assert.equal(projectedCatalog.status, "accepted");
  if (projectedCatalog.status === "accepted") {
    const packProjection = projectedCatalog.projections.find(
      (projection) => projection.recordKind === "pack",
    );
    assert.equal(
      packProjection?.sourceUpdatedAt.toISOString(),
      new Date(catalog.source.sourceTimestamp).toISOString(),
    );
    assert.equal(
      (packProjection?.provenance as Record<string, unknown>).sourceExternalId,
      "99",
    );
  }
  const projectedSale = canonicalProjection(beezieProviderMappingAdapter, sale);
  assert.equal(projectedSale.status, "accepted");
  if (projectedSale.status !== "accepted") return;
  const saleContent = projectedSale.projections[0]?.content;
  assert.equal(saleContent?.eventCategory, "sale");
  assert.deepEqual(saleContent?.amount, {
    amountMinor: 3_500,
    currency: "0xBB5eC6fD4B61723BD45C399840F1d868840ca16F",
  });
  assert.equal(
    (projectedSale.projections[0]?.provenance as Record<string, unknown>)
      .sourceRecordIndex,
    9,
  );
});

test("Clutchpacks maps formatted values, bucket evidence, supporting cards, nullable events, and categories", () => {
  const before = structuredClone(clutchpacksSanitizedPage);
  const output = map(clutchpacksProviderMappingAdapter, clutchpacksSanitizedPage);
  assert.deepEqual(
    output,
    map(clutchpacksProviderMappingAdapter, clutchpacksSanitizedPage),
  );
  assert.deepEqual(clutchpacksSanitizedPage, before);
  assert.equal(output.outcomes.length, 6);

  const catalog = mapped(output.outcomes[0]);
  const pack = catalog.candidates.find(
    (candidate): candidate is CanonicalPackCandidate =>
      candidate.candidateKind === "pack",
  );
  const evInput = catalog.candidates.find(
    (candidate): candidate is EvInputCandidate =>
      candidate.candidateKind === "ev_input",
  );
  assert.ok(pack);
  assert.ok(evInput);
  assert.equal(catalog.source.sourceTimestamp, "2026-08-04T15:09:12Z");
  assert.equal(catalog.source.collectedAt, "2026-08-04T15:09:12Z");
  assert.equal(pack.availability, "active");
  assert.equal(pack.sourceStatus, "available");
  assert.deepEqual(pack.price, { amount: 100, currency: "USD" });
  assert.deepEqual(pack.providerReportedEv, { amount: 100, currency: "USD" });
  assert.equal(pack.description, "Instant buyback offer. One card per pack.");
  assert.equal(evInput.evidenceCompleteness, "complete");
  assert.equal(evInput.declaredCoverage, 1);
  assert.equal(
    evInput.buckets.filter((bucket) => bucket.evidenceKind === "probability_bucket")
      .length,
    2,
  );
  assert.equal(
    Math.min(
      ...evInput.buckets
        .filter((bucket) => bucket.evidenceKind === "probability_bucket")
        .map((bucket) => bucket.lowerValue ?? Number.POSITIVE_INFINITY),
    ),
    20,
  );
  assert.ok(
    evInput.buckets.some(
      (bucket) =>
        bucket.bucketId === "top-chase:provider-chaser-ceiling" &&
        bucket.lowerValue === 1_000 &&
        bucket.upperValue === 1_000,
    ),
  );
  assert.equal(
    catalog.candidates.filter(
      (candidate) => candidate.candidateKind === "catalog_asset",
    ).length,
    2,
  );
  assert.ok(
    evInput.dataQualityEvidence.some(
      (item) => item.code === "CLUTCHPACKS_POOL_PREVIEW_PARTIAL",
    ),
  );
  const estimated = evResult(pack, evInput, []);
  assert.equal(estimated.status, "estimated");
  if (estimated.status === "estimated") {
    assert.equal(estimated.grossValueMinor, 18_250);
    assert.notEqual(estimated.grossValueMinor, 10_000);
  }

  const valuedPull = mapped(output.outcomes[1]);
  const nullValuePull = mapped(output.outcomes[2]);
  for (const outcome of [valuedPull, nullValuePull]) {
    const candidate = outcome.candidates[0];
    assert.equal(candidate?.candidateKind, "pull");
    if (candidate?.candidateKind !== "pull") continue;
    assert.equal(candidate.packExternalId, null);
  }
  assert.deepEqual(
    valuedPull.candidates[0]?.candidateKind === "pull"
      ? valuedPull.candidates[0].value
      : undefined,
    { amount: 2_263, currency: "USD" },
  );
  assert.equal(
    nullValuePull.candidates[0]?.candidateKind === "pull"
      ? nullValuePull.candidates[0].value
      : undefined,
    null,
  );

  const expectedCategories = ["sale", "transfer", "mint"];
  output.outcomes.slice(3).forEach((rawOutcome, index) => {
    const outcome = mapped(rawOutcome);
    const projection = canonicalProjection(
      clutchpacksProviderMappingAdapter,
      outcome,
    );
    assert.equal(projection.status, "accepted");
    if (projection.status !== "accepted") return;
    assert.equal(
      projection.projections[0]?.content.eventCategory,
      expectedCategories[index],
    );
    assert.equal(
      projection.projections[0]?.content.providerEventType,
      clutchpacksSanitizedPage.sales[index]?.event_type,
    );
    const serialized = JSON.stringify(projection);
    assert.equal(serialized.includes("fixture-account-a"), false);
    assert.equal(serialized.includes("fixture-account-b"), false);
  });
  const shipmentProjection = canonicalProjection(
    clutchpacksProviderMappingAdapter,
    mapped(output.outcomes[4]),
  );
  assert.equal(shipmentProjection.status, "accepted");
  if (shipmentProjection.status === "accepted") {
    assert.equal(shipmentProjection.projections[0]?.content.amount, null);
  }
});

test("empty pages and incomplete or malformed provider fields have deterministic outcomes", () => {
  for (const adapter of [
    beezieProviderMappingAdapter,
    clutchpacksProviderMappingAdapter,
  ]) {
    const empty: ProviderFeedPageV1 = {
      catalog: [],
      pulls: [],
      sales: [],
      next_cursor: "empty-end",
      has_more: false,
    };
    assert.deepEqual(map(adapter, empty), { outcomes: [] });
  }

  const incomplete = structuredClone(clutchpacksSanitizedPage);
  const bucket = incomplete.catalog[0]?.data.price_bucket_odds;
  assert.ok(Array.isArray(bucket));
  if (!Array.isArray(bucket)) return;
  const bucketRecord = bucket[1];
  assert.ok(
    bucketRecord &&
      typeof bucketRecord === "object" &&
      !Array.isArray(bucketRecord),
  );
  if (
    !bucketRecord ||
    typeof bucketRecord !== "object" ||
    Array.isArray(bucketRecord)
  ) {
    return;
  }
  bucketRecord.max_price = null;
  const incompleteCatalog = mapped(
    map(clutchpacksProviderMappingAdapter, incomplete).outcomes[0],
  );
  const pack = incompleteCatalog.candidates.find(
    (candidate): candidate is CanonicalPackCandidate =>
      candidate.candidateKind === "pack",
  );
  const evInput = incompleteCatalog.candidates.find(
    (candidate): candidate is EvInputCandidate =>
      candidate.candidateKind === "ev_input",
  );
  assert.ok(pack);
  assert.ok(evInput);
  assert.equal(evInput.evidenceCompleteness, "partial");
  const unavailable = evResult(pack, evInput, []);
  assert.equal(unavailable.status, "unavailable");
  if (unavailable.status === "unavailable") {
    assert.ok(unavailable.reasonCodes.includes("incomplete_probability_coverage"));
    assert.ok(unavailable.reasonCodes.includes("incomplete_inventory"));
  }

  const malformedClutch = structuredClone(clutchpacksSanitizedPage);
  const price = malformedClutch.catalog[0]?.data.price;
  assert.ok(price && typeof price === "object" && !Array.isArray(price));
  if (!price || typeof price !== "object" || Array.isArray(price)) return;
  price.price_amount = "$100 USD";
  const clutchFailure = map(
    clutchpacksProviderMappingAdapter,
    malformedClutch,
  ).outcomes[0];
  assert.equal(clutchFailure?.status, "invalid");
  if (clutchFailure?.status === "invalid") {
    assert.deepEqual(clutchFailure.failure, {
      reasonCode: "INVALID_MONEY_FORMAT",
      fieldPath: "data.price.price_amount",
    });
  }

  const ambiguousClutch = structuredClone(clutchpacksSanitizedPage);
  const ambiguousPrice = ambiguousClutch.catalog[0]?.data.price;
  assert.ok(
    ambiguousPrice &&
      typeof ambiguousPrice === "object" &&
      !Array.isArray(ambiguousPrice),
  );
  if (
    !ambiguousPrice ||
    typeof ambiguousPrice !== "object" ||
    Array.isArray(ambiguousPrice)
  ) {
    return;
  }
  ambiguousPrice.price_amount = "$1,00";
  const ambiguousFailure = map(
    clutchpacksProviderMappingAdapter,
    ambiguousClutch,
  ).outcomes[0];
  assert.equal(ambiguousFailure?.status, "invalid");
  if (ambiguousFailure?.status === "invalid") {
    assert.equal(ambiguousFailure.failure.reasonCode, "INVALID_MONEY_FORMAT");
  }

  const malformedBeezie = structuredClone(beezieSanitizedPage);
  if (malformedBeezie.catalog[0]) {
    malformedBeezie.catalog[0].data.priceUsdc = 1.5;
  }
  const beezieFailure = map(
    beezieProviderMappingAdapter,
    malformedBeezie,
  ).outcomes[0];
  assert.equal(beezieFailure?.status, "invalid");
  if (beezieFailure?.status === "invalid") {
    assert.deepEqual(beezieFailure.failure, {
      reasonCode: "INVALID_MICRO_USDC",
      fieldPath: "data.priceUsdc",
    });
  }
});

const externalSourceCases = [
  {
    name: "Beezie",
    path: resolve(homedir(), "Documents/packscout-data/beezie.json"),
    sha256: BEEZIE_SOURCE_SHA256,
    adapter: beezieProviderMappingAdapter,
    recordCount: 34,
  },
  {
    name: "Clutchpacks",
    path: resolve(homedir(), "Documents/packscout-data/clutchpacks.json"),
    sha256: CLUTCHPACKS_SOURCE_SHA256,
    adapter: clutchpacksProviderMappingAdapter,
    recordCount: 44,
  },
] as const;

for (const sourceCase of externalSourceCases) {
  test(
    `${sourceCase.name} source contract hash maps and projects every valid envelope`,
    { skip: !existsSync(sourceCase.path) },
    () => {
      const bytes = readFileSync(sourceCase.path);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), sourceCase.sha256);
      const source = JSON.parse(bytes.toString("utf8")) as Omit<
        ProviderFeedPageV1,
        "has_more" | "next_cursor"
      >;
      const page: ProviderFeedPageV1 = {
        ...source,
        next_cursor: "source-contract-end",
        has_more: false,
      };
      const output = map(sourceCase.adapter, page);
      assert.equal(output.outcomes.length, sourceCase.recordCount);
      output.outcomes.forEach((rawOutcome, recordIndex) => {
        const outcome = mapped(rawOutcome);
        assert.equal(outcome.source.recordIndex, recordIndex);
        canonicalProjection(sourceCase.adapter, outcome);
      });
    },
  );
}
