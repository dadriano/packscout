import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CatalogRecordV2,
  PullRecordV2,
  TradeRecordV2,
} from "@packscout/contracts";
import type {
  ProviderAdapterCandidate,
  ProviderMappingAdapter,
  ProviderRecordMappingOutcome,
} from "../../provider-adapter.ts";
import { CatalogProjectionService } from "../../catalog-projection-service.ts";
import {
  EventProjectionService,
  HmacProviderActorPseudonymizer,
} from "../../event-projection-service.ts";
import { ProviderProjectionService } from "../../provider-projection-service.ts";
import {
  CLUTCHPACKS_MAPPER_VERSION,
  ClutchpacksMappingAdapter,
} from "./mapper.ts";
import {
  createProviderMappingAdapterRegistryFromManifest,
  providerMapperManifest,
} from "../provider-mapper-manifest.ts";

const collectedAt = "2026-08-19T12:00:05Z";
const occurredAt = "2026-08-19T12:00:00Z";
const firstSeenAt = "2026-08-18T12:00:00Z";

function configuration(mapper: ProviderMappingAdapter) {
  return {
    providerId: "sanitized-clutchpacks-provider",
    configurationRevisionId: "sanitized-clutchpacks-revision",
    platform: mapper.platformKey,
    adapterKey: mapper.key,
  };
}

function mapRecord(
  mapper: ProviderMappingAdapter,
  record: CatalogRecordV2 | PullRecordV2 | TradeRecordV2,
) {
  return mapper.mapRecord({
    configuration: configuration(mapper),
    record,
    recordIndex: 4,
  });
}

function mappedCandidates(
  outcome: ProviderRecordMappingOutcome,
): readonly ProviderAdapterCandidate[] {
  assert.equal(outcome.status, "mapped");
  return outcome.status === "mapped" ? outcome.candidates : [];
}

function projectionService() {
  return new ProviderProjectionService(
    new CatalogProjectionService(),
    new EventProjectionService(
      new HmacProviderActorPseudonymizer(new Uint8Array(32).fill(11)),
    ),
  );
}

function cardRecord(): CatalogRecordV2 {
  return {
    stream: "catalog",
    platform: "clutchpacks",
    record_id: "sanitized-outer-card",
    entity: "card",
    available: null,
    occurred_at: occurredAt,
    collected_at: collectedAt,
    first_seen_at: firstSeenAt,
    data: {
      asset: {
        card_id: "sanitized-nested-card",
        name: "Fallback card name",
        title: "Sanitized ClutchPacks Card",
        type: "card",
        subtype: "graded",
        formatted_current_price: "$1,250.50",
        front_image_url: "https://cdn.example.test/front.png",
        front_image_medium_url: "https://cdn.example.test/front-medium.png",
        back_image_url: "https://cdn.example.test/back.png",
        owner: {
          user_id: "sanitized-catalog-owner",
          username: "sanitized-catalog-username",
        },
      },
      pool: {
        id: "sanitized-pool",
        packs: [{ collection_id: "sanitized-nested-pack" }],
      },
    },
  };
}

function packRecord(
  overrides: Partial<CatalogRecordV2> = {},
): CatalogRecordV2 {
  return {
    stream: "catalog",
    platform: "clutchpacks",
    record_id: "sanitized-outer-pack",
    entity: "pack",
    available: false,
    occurred_at: occurredAt,
    collected_at: collectedAt,
    first_seen_at: firstSeenAt,
    data: {
      collection_id: "sanitized-nested-pack",
      name: "Sanitized ClutchPacks Collection",
      description: "One collectible per pack.",
      category: { slug: "sports", name: "Sports" },
      price: {
        price_amount: "$100.00",
        currency: { code: "USD" },
      },
      average_value: "$105.00",
      floor: "$20.00",
      chaser_ceiling: "$1,000.00",
      sold_out: false,
      image_url: "https://cdn.example.test/pack.png",
      price_bucket_odds: [
        {
          bucket_id: "common",
          name: "Common",
          live_pool_percentage: 80,
          min_price: "$20.00",
          max_price: "$100.00",
          has_more: true,
        },
        {
          bucket_id: "chase",
          name: "Chase",
          live_pool_percentage: 20,
          min_price: "$100.00",
          max_price: "$500.00",
          has_more: false,
        },
      ],
      series_hits: [
        {
          id: "sanitized-series-hit",
          title: "Sanitized Top Chase",
          current_price: "$500.00",
        },
      ],
    },
    ...overrides,
  };
}

function bothPullRecord(): PullRecordV2 {
  return {
    stream: "pulls",
    platform: "clutchpacks",
    record_id: "sanitized-outer-pull",
    pack_id: "sanitized-outer-pack",
    card_id: "sanitized-outer-card",
    occurred_at: occurredAt,
    collected_at: collectedAt,
    data: {
      activity: {
        transaction_type: "Minted",
        formatted_amount: "$999.00",
        card: { card_id: "sanitized-activity-card" },
        from: "sanitized-activity-from",
        to: "sanitized-activity-to",
      },
      feed: {
        card: {
          id: "sanitized-feed-card",
          title: "Sanitized feed card",
          formatted_price: "$125.50",
        },
        user: {
          id: "sanitized-feed-owner",
          username: "sanitized-feed-username",
          is_anonymous: false,
        },
      },
    },
  };
}

function tradeRecord(
  overrides: Partial<TradeRecordV2> = {},
): TradeRecordV2 {
  return {
    stream: "trades",
    platform: "clutchpacks",
    record_id: "sanitized-outer-trade",
    card_id: "sanitized-outer-card",
    event_type: "sale",
    amount: 40,
    currency: "USD",
    payment_method: null,
    tx_hash: "sanitized-outer-transaction",
    occurred_at: occurredAt,
    collected_at: collectedAt,
    data: {
      transaction_type: "Shipped",
      formatted_amount: "$999.00",
      card: { card_id: "sanitized-nested-card" },
      from: "sanitized-trade-from",
      to: "sanitized-trade-to",
    },
    ...overrides,
  };
}

test("ClutchPacks V2 maps catalog cards and packs from authoritative envelopes", async () => {
  const mapper = new ClutchpacksMappingAdapter();
  const cardOutcome = await mapRecord(mapper, cardRecord());
  const card = mappedCandidates(cardOutcome)[0];
  assert.ok(card?.candidateKind === "catalog_asset");
  assert.equal(card.externalId, "sanitized-outer-card");
  assert.equal(card.name, "Sanitized ClutchPacks Card");
  assert.equal(card.category, "graded");
  assert.equal(card.availability, "unknown");
  assert.deepEqual(card.estimatedValue, { amount: 1_250.5, currency: "USD" });
  assert.equal(JSON.stringify(card).includes("sanitized-catalog-owner"), false);
  assert.equal(JSON.stringify(card).includes("sanitized-nested-pack"), false);

  const packOutcome = await mapRecord(mapper, packRecord());
  const candidates = mappedCandidates(packOutcome);
  const pack = candidates.find(({ candidateKind }) => candidateKind === "pack");
  const evInput = candidates.find(
    ({ candidateKind }) => candidateKind === "ev_input",
  );
  assert.ok(pack?.candidateKind === "pack");
  assert.equal(pack.externalId, "sanitized-outer-pack");
  assert.equal(pack.availability, "disabled");
  assert.deepEqual(pack.price, { amount: 100, currency: "USD" });
  assert.deepEqual(pack.providerReportedEv, { amount: 105, currency: "USD" });
  assert.ok(evInput?.candidateKind === "ev_input");
  assert.equal(evInput.packExternalId, "sanitized-outer-pack");
  assert.equal(evInput.declaredCoverage, 1);
  assert.equal(evInput.evidenceCompleteness, "complete");

  const available = mappedCandidates(
    await mapRecord(mapper, packRecord({ available: true })),
  ).find(({ candidateKind }) => candidateKind === "pack");
  assert.ok(available?.candidateKind === "pack");
  assert.equal(available.availability, "active");

  for (const outcome of [cardOutcome, packOutcome]) {
    assert.equal(outcome.status, "mapped");
    if (outcome.status !== "mapped") continue;
    const projection = await projectionService().project({
      configuration: configuration(mapper),
      source: outcome.source,
      candidates: outcome.candidates,
    });
    assert.equal(projection.status, "accepted");
  }
});

test("ClutchPacks V2 emits one pull, uses feed value, and pseudonymizes all actors", async () => {
  const mapper = new ClutchpacksMappingAdapter();
  const outcome = await mapRecord(mapper, bothPullRecord());
  const [pull] = mappedCandidates(outcome);
  assert.ok(pull?.candidateKind === "pull");
  assert.equal(pull.packExternalId, "sanitized-outer-pack");
  assert.equal(pull.assetExternalId, "sanitized-outer-card");
  assert.deepEqual(pull.value, { amount: 125.5, currency: "USD" });
  assert.equal(
    pull.valueSource,
    "clutchpacks_formatted_collectible_price",
  );
  assert.deepEqual(
    pull.pseudonymizationInputs.map(({ role }) => role),
    ["owner", "from", "to"],
  );

  assert.equal(outcome.status, "mapped");
  if (outcome.status !== "mapped") return;
  const projection = await projectionService().project({
    configuration: configuration(mapper),
    source: outcome.source,
    candidates: outcome.candidates,
  });
  assert.equal(projection.status, "accepted");
  const serialized = JSON.stringify(projection);
  for (const rawActor of [
    "sanitized-feed-owner",
    "sanitized-activity-from",
    "sanitized-activity-to",
  ]) {
    assert.equal(serialized.includes(rawActor), false);
  }
});

test("ClutchPacks V2 does not misclassify activity mint money as pull value", async () => {
  const mapper = new ClutchpacksMappingAdapter();
  const source = bothPullRecord();
  const activityOnly: PullRecordV2 = {
    ...source,
    record_id: "sanitized-activity-only-pull",
    data: { activity: source.data.activity },
  };
  const [pull] = mappedCandidates(await mapRecord(mapper, activityOnly));
  assert.ok(pull?.candidateKind === "pull");
  assert.equal(pull.value, null);
  assert.equal(pull.valueSource, null);
  assert.deepEqual(
    pull.dataQualityEvidence.map(({ code }) => code),
    ["CLUTCHPACKS_PULL_VALUE_UNAVAILABLE"],
  );

  const malformedFeed: PullRecordV2 = {
    ...source,
    record_id: "sanitized-malformed-feed-pull",
    data: {
      feed: {
        card: { formatted_price: "$1,00" },
        user: null,
      },
    },
  };
  const [malformed] = mappedCandidates(
    await mapRecord(mapper, malformedFeed),
  );
  assert.ok(malformed?.candidateKind === "pull");
  assert.equal(malformed.value, null);
});

test("ClutchPacks V2 trades use normalized outer fields and never nested money", async () => {
  const mapper = new ClutchpacksMappingAdapter();
  const outcome = await mapRecord(mapper, tradeRecord());
  const [trade] = mappedCandidates(outcome);
  assert.ok(trade?.candidateKind === "trade");
  assert.equal(trade.eventType, "sale");
  assert.equal(trade.transactionKey, "sanitized-outer-transaction");
  assert.equal(trade.assetExternalId, "sanitized-outer-card");
  assert.deepEqual(trade.amount, { amount: 40, currency: "USD" });

  assert.equal(outcome.status, "mapped");
  if (outcome.status !== "mapped") return;
  const projection = await projectionService().project({
    configuration: configuration(mapper),
    source: outcome.source,
    candidates: outcome.candidates,
  });
  assert.equal(projection.status, "accepted");
  const serialized = JSON.stringify(projection);
  assert.equal(serialized.includes("sanitized-trade-from"), false);
  assert.equal(serialized.includes("sanitized-trade-to"), false);

  const unavailable = mappedCandidates(
    await mapRecord(
      mapper,
      tradeRecord({
        record_id: "sanitized-ship-trade",
        event_type: "ship",
        amount: null,
        currency: null,
      }),
    ),
  )[0];
  assert.ok(unavailable?.candidateKind === "trade");
  assert.equal(unavailable.amount, null);
  assert.deepEqual(
    unavailable.dataQualityEvidence.map(({ code }) => code),
    ["CLUTCHPACKS_TRADE_MONEY_UNAVAILABLE"],
  );
});

test("ClutchPacks V2 is exported through the provider mapper manifest", () => {
  const entry = providerMapperManifest.find(
    ({ platformKey }) => platformKey === "clutchpacks",
  );
  assert.equal(entry?.adapterKey, CLUTCHPACKS_MAPPER_VERSION);
  assert.equal(entry?.mappingVersion, "v2");
  assert.deepEqual(entry?.supportedRecordKinds, ["catalog", "pull", "trade"]);
  const registry = createProviderMappingAdapterRegistryFromManifest();
  assert.equal(
    registry.resolveForPlatform("clutchpacks").key,
    CLUTCHPACKS_MAPPER_VERSION,
  );
});
