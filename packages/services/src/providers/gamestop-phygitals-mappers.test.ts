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
import { CatalogProjectionService } from "../catalog-projection-service.ts";
import { calculatePackScoutEstimatedEv } from "../estimated-ev-calculator.ts";
import {
  EventProjectionService,
  HmacProviderActorPseudonymizer,
} from "../event-projection-service.ts";
import { ProviderProjectionService } from "../provider-projection-service.ts";
import { GameStopMappingAdapter } from "./gamestop/mapper.ts";
import { PhygitalsMappingAdapter } from "./phygitals/mapper.ts";

const sampleRoot =
  process.env.PACKSCOUT_PROVIDER_SAMPLES ??
  "/Users/lains/Documents/packscout-data";

const expectedHashes = {
  gamestop: "06ef8dda43b26095b11b430e814f4a3b7a1e727bdca0ecf47354cef1ee93bb4f",
  phygitals: "3620d97462090454c8cc1867a408255445a3219fe0917ac2a4b8cc5973bb8c23",
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

async function mapAll(mapper: ProviderMappingAdapter, page: ProviderFeedPageV1) {
  return await mapper.mapPage({
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

function calculate(
  values: readonly ProviderAdapterCandidate[],
  expectedCompleteness: "complete" | "partial",
) {
  const evInput = values.find(
    (candidate) =>
      candidate.candidateKind === "ev_input" &&
      candidate.evidenceCompleteness === expectedCompleteness,
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
  const accepted: unknown[] = [];
  const projections = new ProviderProjectionService(
    new CatalogProjectionService(),
    new EventProjectionService(
      new HmacProviderActorPseudonymizer(new Uint8Array(32).fill(7)),
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
    accepted.push(projected);
  }
  return accepted;
}

test("GameStop sample maps every category level, chase, resolved pull, complete EV input, and empty sales", async (context) => {
  const page = sample("gamestop");
  if (!page) {
    context.skip("Set PACKSCOUT_PROVIDER_SAMPLES to run the full supplied sample proof.");
    return;
  }
  const mapper = new GameStopMappingAdapter();
  const first = await mapAll(mapper, page);
  assert.deepEqual(await mapAll(mapper, page), first);
  assert.equal(first.outcomes.length, 23);
  assert.ok(first.outcomes.every(({ status }) => status === "mapped"));
  await assertEveryMappedRecordProjects(mapper, first);

  const projected = candidates(first);
  assert.equal(byKind(projected, "pack").length, 45);
  assert.equal(byKind(projected, "ev_input").length, 45);
  assert.equal(byKind(projected, "catalog_asset").length, 1_108);
  assert.equal(byKind(projected, "pull").length, 15);
  assert.equal(byKind(projected, "sale").length, 0);
  assert.ok(
    byKind(projected, "ev_input").every(
      (candidate) =>
        candidate.candidateKind === "ev_input" &&
        candidate.evidenceCompleteness === "complete",
    ),
  );
  assert.ok(
    byKind(projected, "pull").every(
      (candidate) => candidate.candidateKind === "pull" && candidate.packExternalId !== null,
    ),
  );
  assert.equal(calculate(projected, "complete").status, "estimated");
});

test("Phygitals sample maps stable variants, source-only identities, USDC buybacks, and unavailable draw semantics", async (context) => {
  const page = sample("phygitals");
  if (!page) {
    context.skip("Set PACKSCOUT_PROVIDER_SAMPLES to run the full supplied sample proof.");
    return;
  }
  const mapper = new PhygitalsMappingAdapter();
  const first = await mapAll(mapper, page);
  assert.deepEqual(await mapAll(mapper, page), first);
  assert.equal(first.outcomes.length, 45);
  assert.ok(first.outcomes.every(({ status }) => status === "mapped"));
  const canonical = await assertEveryMappedRecordProjects(mapper, first);

  const projected = candidates(first);
  assert.equal(byKind(projected, "pack").length, 18);
  assert.equal(byKind(projected, "ev_input").length, 18);
  assert.equal(byKind(projected, "catalog_asset").length, 460);
  assert.equal(byKind(projected, "pull").length, 15);
  assert.equal(byKind(projected, "sale").length, 15);
  const duplicateVariant = byKind(projected, "pack").filter(
    (candidate) => candidate.candidateKind === "pack" && candidate.externalId === "mythic-pack-1",
  );
  assert.equal(duplicateVariant.length, 2);
  assert.ok(duplicateVariant.every(
    (candidate) => candidate.candidateKind === "pack" && candidate.parentExternalId === "29",
  ));
  assert.ok(
    byKind(projected, "ev_input").every(
      (candidate) =>
        candidate.candidateKind === "ev_input" &&
        candidate.evidenceCompleteness === "partial" &&
        candidate.drawCount === null &&
        candidate.unitBasis === null,
    ),
  );
  const unavailable = calculate(projected, "partial");
  assert.equal(unavailable.status, "unavailable");
  if (unavailable.status === "unavailable") {
    assert.ok(unavailable.reasonCodes.includes("ambiguous_unit_basis"));
    assert.ok(unavailable.reasonCodes.includes("invalid_draw_count"));
  }
  assert.ok(
    byKind(projected, "sale").every(
      (candidate) =>
        candidate.candidateKind === "sale" && candidate.amount?.currency === "USDC",
    ),
  );
  const serialized = JSON.stringify(canonical);
  assert.doesNotMatch(serialized, /"username"|"wallet"|"owner":"62Q9ee/i);
  assert.doesNotMatch(serialized, /2i6EHwDs8jykiroMhR1CQH2chq9gZY2wEmWwx856Ti3u/);
});

test("GameStop and Phygitals mapping drift produces stable per-record failures", async () => {
  const gamestop: ProviderFeedPageV1 = {
    catalog: [{
      platform: "gamestop",
      external_id: "category-drift",
      updated_at: "2026-08-06T12:00:00.000Z",
      collected_at: "2026-08-06T12:00:01.000Z",
      data: { displayName: "Empty category", levels: [] },
    }],
    pulls: [],
    sales: [],
    next_cursor: "end",
    has_more: false,
  };
  const phygitals: ProviderFeedPageV1 = {
    catalog: [{
      platform: "phygitals",
      external_id: "pack-drift",
      updated_at: "2026-08-06T12:00:00.000Z",
      collected_at: "2026-08-06T12:00:01.000Z",
      data: { id: "pack-drift", name: "Missing price" },
    }],
    pulls: [],
    sales: [],
    next_cursor: "end",
    has_more: false,
  };
  const [gamestopOutcome] = (await mapAll(new GameStopMappingAdapter(), gamestop)).outcomes;
  const [phygitalsOutcome] = (await mapAll(new PhygitalsMappingAdapter(), phygitals)).outcomes;
  assert.equal(gamestopOutcome?.status, "invalid");
  assert.equal(
    gamestopOutcome?.status === "invalid" ? gamestopOutcome.failure.reasonCode : null,
    "GAMESTOP_LEVELS_MISSING",
  );
  assert.equal(phygitalsOutcome?.status, "invalid");
  assert.equal(
    phygitalsOutcome?.status === "invalid" ? phygitalsOutcome.failure.reasonCode : null,
    "PHYGITALS_PACK_INVALID",
  );
});
