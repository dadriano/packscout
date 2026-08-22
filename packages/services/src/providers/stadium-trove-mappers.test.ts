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
import { StadiumVaultMappingAdapter } from "./stadium-vault/mapper.ts";
import { TroveMappingAdapter } from "./trove/mapper.ts";

const sampleRoot =
  process.env.PACKSCOUT_PROVIDER_SAMPLES ??
  "/Users/lains/Documents/packscout-data";

const expectedHashes = {
  stadium_vault: "fe5c90c64f48b18ecfc5d6863c8f3b2e11d1fae5764dfa773531c59d8efc026a",
  trove: "cadc01c597744075ca8f0be891672d288df013dd8e61f182647614ce20b50a3b",
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
  const rawEvidence = JSON.parse(bytes.toString("utf8")) as {
    readonly catalog: ProviderFeedPageV1["catalog"];
    readonly pulls: ProviderFeedPageV1["pulls"];
    readonly sales: ProviderFeedPageV1["trades"];
  };
  return {
    catalog: rawEvidence.catalog,
    pulls: rawEvidence.pulls,
    trades: rawEvidence.sales,
    next_cursor: "sample-end",
    has_more: false,
  };
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
      new HmacProviderActorPseudonymizer(new Uint8Array(32).fill(9)),
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

test("Stadium Vault sample maps complete effective odds, top-pull evidence, and pulls", async (context) => {
  const page = sample("stadium_vault");
  if (!page) {
    context.skip("Set PACKSCOUT_PROVIDER_SAMPLES to run the full supplied sample proof.");
    return;
  }
  const mapper = new StadiumVaultMappingAdapter();
  const first = await mapAll(mapper, page);
  assert.deepEqual(await mapAll(mapper, page), first);
  assert.equal(first.outcomes.length, 29);
  assert.ok(first.outcomes.every(({ status }) => status === "mapped"));
  await assertEveryMappedRecordProjects(mapper, first);

  const projected = candidates(first);
  assert.equal(byKind(projected, "pack").length, 14);
  assert.equal(byKind(projected, "pull").length, 15);
  assert.equal(byKind(projected, "market_event").length, 0);
  assert.equal(byKind(projected, "ev_input").length, 14);
  assert.equal(byKind(projected, "catalog_asset").length, 168);
  assert.ok(
    byKind(projected, "ev_input").every(
      (candidate) =>
        candidate.candidateKind === "ev_input" &&
        candidate.evidenceCompleteness === "complete",
    ),
  );
  assert.equal(calculateFirstComplete(projected).status, "estimated");
});

test("Trove sample maps active tier distributions, grail evidence, and pseudonymous pulls", async (context) => {
  const page = sample("trove");
  if (!page) {
    context.skip("Set PACKSCOUT_PROVIDER_SAMPLES to run the full supplied sample proof.");
    return;
  }
  const mapper = new TroveMappingAdapter();
  const first = await mapAll(mapper, page);
  assert.deepEqual(await mapAll(mapper, page), first);
  assert.equal(first.outcomes.length, 30);
  assert.ok(first.outcomes.every(({ status }) => status === "mapped"));
  await assertEveryMappedRecordProjects(mapper, first);

  const projected = candidates(first);
  assert.equal(byKind(projected, "pack").length, 15);
  assert.equal(byKind(projected, "pull").length, 15);
  assert.equal(byKind(projected, "market_event").length, 0);
  assert.equal(byKind(projected, "ev_input").length, 15);
  assert.equal(byKind(projected, "catalog_asset").length, 180);
  assert.ok(
    byKind(projected, "ev_input").every(
      (candidate) =>
        candidate.candidateKind === "ev_input" &&
        candidate.evidenceCompleteness === "complete",
    ),
  );
  assert.equal(calculateFirstComplete(projected).status, "estimated");
  assert.doesNotMatch(JSON.stringify(projected), /"username"|"name":"Andrew Cardenas"/i);
});

test("Stadium Vault and Trove mapper drift is isolated to the affected record", async () => {
  const stadiumPage: ProviderFeedPageV1 = {
    catalog: [{
      platform: "stadium_vault",
      external_id: "stadium-drift",
      updated_at: "2026-08-06T12:00:00.000Z",
      collected_at: "2026-08-06T12:00:01.000Z",
      data: { title: "Missing price" },
    }],
    pulls: [],
    trades: [],
    next_cursor: "end",
    has_more: false,
  };
  const trovePage: ProviderFeedPageV1 = {
    catalog: [{
      platform: "trove",
      external_id: "trove-drift",
      updated_at: "2026-08-06T12:00:00.000Z",
      collected_at: "2026-08-06T12:00:01.000Z",
      data: { name: "Missing price and draw count" },
    }],
    pulls: [],
    trades: [],
    next_cursor: "end",
    has_more: false,
  };
  const [stadium] = (await mapAll(new StadiumVaultMappingAdapter(), stadiumPage)).outcomes;
  const [trove] = (await mapAll(new TroveMappingAdapter(), trovePage)).outcomes;
  assert.equal(stadium?.status, "invalid");
  assert.equal(
    stadium?.status === "invalid" ? stadium.failure.reasonCode : null,
    "STADIUM_VAULT_PACK_PRICE_INVALID",
  );
  assert.equal(trove?.status, "invalid");
  assert.equal(
    trove?.status === "invalid" ? trove.failure.reasonCode : null,
    "TROVE_PACK_PRICE_INVALID",
  );
});
