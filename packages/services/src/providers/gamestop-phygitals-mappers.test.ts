import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderFeedPageV1 } from "@packscout/contracts";
import { CatalogProjectionService } from "../catalog-projection-service.ts";
import { calculatePackScoutEstimatedEv } from "../estimated-ev-calculator.ts";
import {
  EventProjectionService,
  HmacProviderActorPseudonymizer,
} from "../event-projection-service.ts";
import type {
  ProviderAdapterCandidate,
  ProviderMappingAdapter,
} from "../provider-adapter.ts";
import { ProviderProjectionService } from "../provider-projection-service.ts";
import {
  GAMESTOP_MAPPER_VERSION,
  GAMESTOP_PLATFORM_KEY,
  GameStopMappingAdapter,
} from "./gamestop/mapper.ts";
import { providerMapperManifest } from "./provider-mapper-manifest.ts";

const sampleRoot =
  process.env.PACKSCOUT_PROVIDER_SAMPLES ??
  "/Users/lains/Documents/packscout-data";
const expectedGameStopHash =
  "06ef8dda43b26095b11b430e814f4a3b7a1e727bdca0ecf47354cef1ee93bb4f";

function gameStopSample(): ProviderFeedPageV1 | null {
  const path = join(sampleRoot, "gamestop.json");
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    expectedGameStopHash,
    "GameStop sample changed; review and version its mapper fixture contract",
  );
  const value = JSON.parse(bytes.toString("utf8")) as {
    readonly catalog: ProviderFeedPageV1["catalog"];
    readonly pulls: ProviderFeedPageV1["pulls"];
    readonly sales: ProviderFeedPageV1["trades"];
  };
  return {
    catalog: value.catalog,
    pulls: value.pulls,
    trades: value.sales,
    next_cursor: "sample-end",
    has_more: false,
  };
}

async function mapAll(
  mapper: ProviderMappingAdapter,
  page: ProviderFeedPageV1,
) {
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
      trades: page.trades.map((_, index) => index),
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

function calculate(values: readonly ProviderAdapterCandidate[]) {
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
        bucket.lowerValue === null
          ? null
          : Math.round(bucket.lowerValue * 100),
      upperValueMinor:
        bucket.upperValue === null
          ? null
          : Math.round(bucket.upperValue * 100),
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
  }
}

test("GameStop sample maps and projects complete EV and resolved pulls while remaining dormant", async (context) => {
  const page = gameStopSample();
  if (!page) {
    context.skip(
      "Set PACKSCOUT_PROVIDER_SAMPLES to run the full supplied sample proof.",
    );
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
  assert.equal(byKind(projected, "market_event").length, 0);
  assert.ok(
    byKind(projected, "ev_input").every(
      (candidate) =>
        candidate.candidateKind === "ev_input" &&
        candidate.evidenceCompleteness === "complete",
    ),
  );
  assert.ok(
    byKind(projected, "pull").every(
      (candidate) =>
        candidate.candidateKind === "pull" &&
        candidate.packExternalId !== null,
    ),
  );
  assert.equal(calculate(projected).status, "estimated");
  assert.equal(mapper.key, GAMESTOP_MAPPER_VERSION);
  assert.equal(
    providerMapperManifest.some(
      ({ descriptor }) => descriptor.mapperKey === GAMESTOP_MAPPER_VERSION,
    ),
    false,
  );
});

test("GameStop remains deterministic without production registration", () => {
  const mapper = new GameStopMappingAdapter();
  const input = {
    configuration: { platform: GAMESTOP_PLATFORM_KEY },
    page: {
      catalog: [],
      pulls: [],
      trades: [],
      next_cursor: "dormant-end",
      has_more: false,
    },
    recordIndexes: { catalog: [], pulls: [], trades: [] },
  };
  assert.deepEqual(mapper.mapPage(input), { outcomes: [] });
  assert.deepEqual(mapper.mapPage(input), mapper.mapPage(input));
  assert.equal(
    providerMapperManifest.some(
      ({ descriptor }) => descriptor.mapperKey === GAMESTOP_MAPPER_VERSION,
    ),
    false,
  );
});

test("GameStop rejects a platform mismatch while dormant", () => {
  const mapper = new GameStopMappingAdapter();
  assert.throws(
    () =>
      mapper.mapPage({
        configuration: { platform: "courtyard" },
        page: {
          catalog: [],
          pulls: [],
          trades: [],
          next_cursor: "dormant-end",
          has_more: false,
        },
        recordIndexes: { catalog: [], pulls: [], trades: [] },
      }),
    /platform mismatch/u,
  );
});
