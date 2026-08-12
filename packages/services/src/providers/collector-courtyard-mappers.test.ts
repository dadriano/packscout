import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderFeedPageV1 } from "@packscout/contracts";
import type {
  ProviderAdapterCandidate,
  ProviderMappingAdapter,
} from "../provider-adapter.ts";
import { calculatePackScoutEstimatedEv } from "../estimated-ev-calculator.ts";
import { CatalogProjectionService } from "../catalog-projection-service.ts";
import {
  EventProjectionService,
  HmacProviderActorPseudonymizer,
} from "../event-projection-service.ts";
import { ProviderProjectionService } from "../provider-projection-service.ts";
import { CollectorCryptMappingAdapter } from "./collector-crypt/mapper.ts";
import { CourtyardMappingAdapter } from "./courtyard/mapper.ts";

const sampleRoot =
  process.env.PACKSCOUT_PROVIDER_SAMPLES ??
  "/Users/lains/Documents/packscout-data";

const expectedHashes = {
  collector_crypt: "2e3eddcccc5aa1dbe6c435bae7f17e6d08811eff418104b2d1ed26ed0eb84064",
  courtyard: "20021fca6c69d10f539788e11e8ed41aad835fd7e4de6d52ce7119c6d477ecd7",
} as const;

function sample(platform: keyof typeof expectedHashes): ProviderFeedPageV1 | null {
  const path = join(sampleRoot, `${platform}.json`);
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    expectedHashes[platform],
    `${platform} sample changed; review and version its mapper fixture contract`,
  );
  const value = JSON.parse(bytes.toString("utf8")) as Omit<
    ProviderFeedPageV1,
    "has_more" | "next_cursor"
  >;
  return { ...value, next_cursor: "sample-end", has_more: false };
}

function mapAll(mapper: ProviderMappingAdapter, page: ProviderFeedPageV1) {
  return mapper.mapPage({
    configuration: {
      providerId: "provider-fixture",
      configurationRevisionId: "revision-fixture",
      platform: mapper.platformKey,
      adapterKey: mapper.key,
    },
    page,
    recordIndexes: {
      catalog: page.catalog.map((_, index) => index),
      pulls: page.pulls.map((_, index) => index),
      sales: page.sales.map((_, index) => index),
    },
  });
}

function candidates(output: Awaited<ReturnType<typeof mapAll>>) {
  return output.outcomes.flatMap((outcome) =>
    outcome.status === "mapped" ? outcome.candidates : [],
  );
}

function byKind(
  values: readonly ProviderAdapterCandidate[],
  kind: ProviderAdapterCandidate["candidateKind"],
) {
  return values.filter(({ candidateKind }) => candidateKind === kind);
}

function calculateFirstComplete(values: readonly ProviderAdapterCandidate[]) {
  const evInput = values.find(
    (candidate) =>
      candidate.candidateKind === "ev_input" &&
      candidate.evidenceCompleteness === "complete",
  );
  assert.ok(evInput?.candidateKind === "ev_input");
  const pack = values.find(
    (candidate) =>
      candidate.candidateKind === "pack" &&
      candidate.externalId === evInput.packExternalId,
  );
  assert.ok(pack?.candidateKind === "pack" && pack.price);
  return calculatePackScoutEstimatedEv({
    packPrice: {
      valueMinor: Math.round(pack.price.amount * 100),
      currency: pack.price.currency,
      sourceRevisionId: "fixture-pack-revision",
    },
    distributionCurrency: evInput.currency,
    unitBasis: evInput.unitBasis,
    drawCount: evInput.drawCount,
    declaredCoverage: evInput.declaredCoverage,
    evidenceCompleteness: evInput.evidenceCompleteness,
    buckets: evInput.buckets.map((bucket) => ({
      probability: bucket.probability,
      lowerValueMinor:
        bucket.lowerValue === null ? null : Math.round(bucket.lowerValue * 100),
      upperValueMinor:
        bucket.upperValue === null ? null : Math.round(bucket.upperValue * 100),
      sourceRevisionId: "fixture-ev-revision",
    })),
    sourceAt: evInput.source.sourceTimestamp,
    calculatedAt: "2026-08-06T12:00:00.000Z",
    currencyPolicy: { verifiedUsdStablecoins: [] },
  });
}

async function assertEveryMappedRecordProjects(
  mapper: ProviderMappingAdapter,
  output: Awaited<ReturnType<typeof mapAll>>,
) {
  const projections = new ProviderProjectionService(
    new CatalogProjectionService(),
    new EventProjectionService(
      new HmacProviderActorPseudonymizer(new Uint8Array(32).fill(5)),
    ),
  );
  for (const outcome of output.outcomes) {
    assert.equal(outcome.status, "mapped");
    if (outcome.status !== "mapped") continue;
    const projected = await projections.project({
      configuration: {
        providerId: `${mapper.platformKey}-provider`,
        configurationRevisionId: `${mapper.platformKey}-revision`,
        platform: mapper.platformKey,
        adapterKey: mapper.key,
      },
      source: outcome.source,
      candidates: outcome.candidates,
    });
    assert.equal(
      projected.status,
      "accepted",
      projected.status === "invalid"
        ? `${outcome.source.recordKind}[${outcome.source.recordIndex}]: ${projected.reasonCode} ${projected.fieldPath ?? ""}`
        : undefined,
    );
  }
}

test("Collector Crypt sample classifies every card, gacha, pull, and event deterministically", async (context) => {
  const page = sample("collector_crypt");
  if (!page) {
    context.skip("Set PACKSCOUT_PROVIDER_SAMPLES to run the full supplied sample proof.");
    return;
  }
  const mapper = new CollectorCryptMappingAdapter();
  const first = await mapAll(mapper, page);
  const repeated = await mapAll(mapper, page);
  assert.deepEqual(repeated, first);
  assert.equal(first.outcomes.length, 44);
  assert.ok(first.outcomes.every(({ status }) => status === "mapped"));
  await assertEveryMappedRecordProjects(mapper, first);

  const projected = candidates(first);
  assert.equal(byKind(projected, "pack").length, 7);
  assert.equal(byKind(projected, "pull").length, 15);
  assert.equal(byKind(projected, "sale").length, 15);
  assert.equal(byKind(projected, "ev_input").length, 7);
  assert.ok(byKind(projected, "catalog_asset").length >= 7);
  const complete = byKind(projected, "ev_input").filter(
    (candidate) => candidate.candidateKind === "ev_input" && candidate.evidenceCompleteness === "complete",
  );
  assert.equal(complete.length, 7);
  assert.equal(calculateFirstComplete(projected).status, "estimated");
  assert.doesNotMatch(JSON.stringify(projected), /"username"|"owner"|"wallet"/i);
});

test("Courtyard sample keeps price assets, packs, complete odds, missing odds, and token sales explicit", async (context) => {
  const page = sample("courtyard");
  if (!page) {
    context.skip("Set PACKSCOUT_PROVIDER_SAMPLES to run the full supplied sample proof.");
    return;
  }
  const mapper = new CourtyardMappingAdapter();
  const first = await mapAll(mapper, page);
  assert.deepEqual(await mapAll(mapper, page), first);
  assert.equal(first.outcomes.length, 41);
  assert.ok(first.outcomes.every(({ status }) => status === "mapped"));
  await assertEveryMappedRecordProjects(mapper, first);

  const projected = candidates(first);
  assert.equal(byKind(projected, "pack").length, 8);
  assert.equal(byKind(projected, "pull").length, 15);
  assert.equal(byKind(projected, "sale").length, 15);
  assert.equal(byKind(projected, "ev_input").length, 8);
  const evInputs = byKind(projected, "ev_input").filter(
    (candidate) => candidate.candidateKind === "ev_input",
  );
  assert.ok(evInputs.some(({ evidenceCompleteness }) => evidenceCompleteness === "complete"));
  assert.ok(evInputs.some(({ evidenceCompleteness }) => evidenceCompleteness === "partial"));
  assert.equal(calculateFirstComplete(projected).status, "estimated");
  const sales = byKind(projected, "sale").filter(
    (candidate) => candidate.candidateKind === "sale",
  );
  assert.ok(sales.some(({ amount }) => amount === null));
  assert.ok(
    sales.some(({ dataQualityEvidence }) =>
      dataQualityEvidence.some(({ code }) => code === "COURTYARD_SALE_CURRENCY_UNVERIFIED"),
    ),
  );
  assert.doesNotMatch(JSON.stringify(projected), /"username"|"wallet"/i);
});

test("mapping drift is isolated to the affected provider record", async () => {
  const page: ProviderFeedPageV1 = {
    catalog: [
      {
        platform: "collector_crypt",
        external_id: "unexpected:record",
        updated_at: "2026-08-06T12:00:00.000Z",
        collected_at: "2026-08-06T12:00:01.000Z",
        data: { name: "Unknown record" },
      },
    ],
    pulls: [],
    sales: [],
    next_cursor: "end",
    has_more: false,
  };
  const [outcome] = (await mapAll(new CollectorCryptMappingAdapter(), page)).outcomes;
  assert.deepEqual(outcome, {
    status: "invalid",
    source: {
      platform: "collector_crypt",
      recordKind: "catalog",
      recordIndex: 0,
      externalId: "unexpected:record",
      collectedAt: "2026-08-06T12:00:01.000Z",
      sourceTimestamp: "2026-08-06T12:00:00.000Z",
    },
    failure: {
      reasonCode: "COLLECTOR_CRYPT_CATALOG_KIND_UNKNOWN",
      fieldPath: "external_id",
    },
  });
});
