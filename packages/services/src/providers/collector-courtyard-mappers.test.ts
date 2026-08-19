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
} from "../provider-adapter.ts";
import { CatalogProjectionService } from "../catalog-projection-service.ts";
import {
  EventProjectionService,
  HmacProviderActorPseudonymizer,
} from "../event-projection-service.ts";
import { ProviderProjectionService } from "../provider-projection-service.ts";
import { CollectorCryptMappingAdapter } from "./collector-crypt/mapper.ts";
import { CourtyardMappingAdapter } from "./courtyard/mapper.ts";
import {
  createProviderMappingAdapterRegistryFromManifest,
  providerMapperManifest,
} from "./provider-mapper-manifest.ts";

const collectedAt = "2026-08-14T12:00:00Z";
const occurredAt = "2026-08-13T12:00:00Z";
const firstSeenAt = "2026-08-01T00:00:00Z";

function configuration(mapper: ProviderMappingAdapter) {
  return {
    providerId: `provider-${mapper.platformKey}`,
    configurationRevisionId: `revision-${mapper.platformKey}`,
    platform: mapper.platformKey,
    adapterKey: mapper.key,
  };
}

function mapRecord(
  mapper: ProviderMappingAdapter,
  record: CatalogRecordV2 | PullRecordV2 | TradeRecordV2,
  recordIndex = 0,
) {
  return mapper.mapRecord({
    configuration: configuration(mapper),
    record,
    recordIndex,
  });
}

function mappedCandidates(
  outcome: Awaited<ReturnType<typeof mapRecord>>,
): readonly ProviderAdapterCandidate[] {
  assert.equal(outcome.status, "mapped");
  return outcome.status === "mapped" ? outcome.candidates : [];
}

function collectorCard(): CatalogRecordV2 {
  return {
    stream: "catalog",
    platform: "collector_crypt",
    record_id: "sanitized-collector-card",
    entity: "card",
    occurred_at: occurredAt,
    collected_at: collectedAt,
    first_seen_at: firstSeenAt,
    data: {
      asset: {
        id: "sanitized-collector-card",
        itemName: "Sanitized graded card",
        type: "card",
        category: "Sports",
        status: "transferred",
        nftStatus: "valid",
        insuredValue: "125.50",
        frontImage: "https://cdn.example.test/front.png",
        backImage: null,
      },
    },
  };
}

function collectorPack(): CatalogRecordV2 {
  return {
    stream: "catalog",
    platform: "collector_crypt",
    record_id: "sanitized-collector-pack",
    entity: "pack",
    occurred_at: occurredAt,
    collected_at: collectedAt,
    first_seen_at: firstSeenAt,
    data: {
      code: "sanitized-collector-pack",
      name: "Sanitized Collector Pack",
      menuCategory: "sports",
      price: { amount: 100 },
      public: true,
      archived: false,
      contains: 1,
      targetEV: 105,
      maxEV: 999,
      instantBuyback: { percentageOfValue: 90 },
      tierRanges: {
        common: { start: 50, end: 100 },
        rare: { start: 100, end: 200 },
      },
      weightMultipliers: { common: 0.8, rare: 0.2 },
      topNfts: [
        {
          id: "sanitized-top-chase",
          name: "Sanitized Top Chase",
          insured_value: 500,
        },
      ],
      image: "",
      thumbnailUrl: "https://cdn.example.test/pack.png",
    },
  };
}

function collectorPull(
  overrides: Partial<PullRecordV2> = {},
): PullRecordV2 {
  return {
    stream: "pulls",
    platform: "collector_crypt",
    record_id: "sanitized-collector-pull",
    pack_id: "sanitized-collector-pack",
    card_id: null,
    occurred_at: occurredAt,
    collected_at: collectedAt,
    data: {
      spin_wallet: "sanitized-wallet",
      send_nft_insured_value: null,
      buyback_status: null,
      buyback_refund_amount: null,
    },
    ...overrides,
  };
}

function collectorTrade(
  overrides: Partial<TradeRecordV2> = {},
): TradeRecordV2 {
  return {
    stream: "trades",
    platform: "collector_crypt",
    record_id: "sanitized-collector-trade",
    card_id: "sanitized-collector-card",
    event_type: "burn",
    amount: null,
    currency: null,
    tx_hash: "sanitized-collector-transaction",
    occurred_at: occurredAt,
    collected_at: collectedAt,
    data: {
      from: { id: "sanitized-from" },
      to: { id: "sanitized-to" },
    },
    ...overrides,
  };
}

function courtyardCard(): CatalogRecordV2 {
  return {
    stream: "catalog",
    platform: "courtyard",
    record_id: "sanitized-courtyard-card",
    entity: "card",
    occurred_at: occurredAt,
    collected_at: collectedAt,
    first_seen_at: firstSeenAt,
    data: {
      prices: {
        assetId: "sanitized-courtyard-card",
        priceHistory: [
          {
            title: "Older title",
            sales: [{ date: "2026-08-01T00:00:00Z", price: "75" }],
          },
          {
            title: "Sanitized Courtyard Card",
            sales: [{ date: "2026-08-12T00:00:00Z", price: "95.25" }],
          },
        ],
      },
      reveal: {
        title: "Sanitized reveal title",
        collection: "Graded Cards",
        burned: false,
        fmv_estimate_usd: 100,
        proof_of_integrity: "sanitized-courtyard-card",
        cropped_image: "https://cdn.example.test/cropped.png",
      },
    },
  };
}

function courtyardPack(completeOdds = true): CatalogRecordV2 {
  return {
    stream: "catalog",
    platform: "courtyard",
    record_id: completeOdds
      ? "sanitized-courtyard-pack"
      : "sanitized-sold-out-pack",
    entity: "pack",
    occurred_at: occurredAt,
    collected_at: collectedAt,
    first_seen_at: firstSeenAt,
    data: {
      id: completeOdds
        ? "sanitized-courtyard-pack"
        : "sanitized-sold-out-pack",
      title: completeOdds ? "Sanitized Pack" : "Sanitized Sold Out Pack",
      status: "ACTIVE",
      outOfStock: !completeOdds,
      category: { id: "sports", title: "Sports" },
      description: "One card per pack.",
      saleDetails: {
        closed: false,
        salePriceUsd: 100,
        expectedValueUsd: 96,
      },
      buybackRatio: 0.9,
      ...(completeOdds
        ? {
            odds: {
              buckets: [
                {
                  tier: "common",
                  oddsPercent: 75,
                  minValueUsd: 50,
                  maxValueUsd: 100,
                },
                {
                  tier: "rare",
                  oddsPercent: 25,
                  minValueUsd: 100,
                  maxValueUsd: 250,
                },
              ],
            },
          }
        : {}),
    },
  };
}

function courtyardPull(): PullRecordV2 {
  return {
    stream: "pulls",
    platform: "courtyard",
    record_id: "sanitized-courtyard-pull",
    pack_id: "sanitized-courtyard-pack",
    card_id: "sanitized-courtyard-card",
    occurred_at: occurredAt,
    collected_at: collectedAt,
    data: {
      pulled_by: { user_id: "sanitized-user" },
      fmv_estimate_usd: 112.5,
      proof_of_integrity: "sanitized-courtyard-card",
    },
  };
}

function courtyardTrade(
  currency: string | null,
  amount: number | null,
  eventType = "sale",
): TradeRecordV2 {
  return {
    stream: "trades",
    platform: "courtyard",
    record_id: `sanitized-courtyard-${eventType}-${currency ?? "none"}`,
    card_id: "sanitized-courtyard-card",
    event_type: eventType,
    amount,
    currency,
    tx_hash: `sanitized-courtyard-transaction-${eventType}`,
    occurred_at: occurredAt,
    collected_at: collectedAt,
    data: {
      from: "sanitized-from",
      to: "sanitized-to",
      paymentToken: currency ?? "",
      paymentAmount: amount === null ? "" : String(amount * 1_000_000),
    },
  };
}

function projectionService() {
  return new ProviderProjectionService(
    new CatalogProjectionService(),
    new EventProjectionService(
      new HmacProviderActorPseudonymizer(new Uint8Array(32).fill(7)),
    ),
  );
}

test("V2 manifest registers the audited live platforms", () => {
  assert.deepEqual(
    providerMapperManifest
      .map((entry) => ({
        platform: entry.platformKey,
        version: entry.mappingVersion,
        kinds: entry.supportedRecordKinds,
      }))
      .sort((left, right) => left.platform.localeCompare(right.platform)),
    [
      {
        platform: "clutchpacks",
        version: "v2",
        kinds: ["catalog", "pull", "trade"],
      },
      {
        platform: "collector_crypt",
        version: "v2",
        kinds: ["catalog", "pull", "trade"],
      },
      {
        platform: "courtyard",
        version: "v2",
        kinds: ["catalog", "pull", "trade"],
      },
      {
        platform: "phygitals",
        version: "v2",
        kinds: ["catalog", "pull", "trade"],
      },
    ],
  );
  const registry = createProviderMappingAdapterRegistryFromManifest();
  assert.deepEqual([...registry.keys()].sort(), [
    "clutchpacks-v2",
    "collector-crypt-v2",
    "courtyard-v2",
    "phygitals-v2",
  ]);
});

test("Collector Crypt maps V2 cards and packs without legacy identity prefixes", async () => {
  const mapper = new CollectorCryptMappingAdapter();
  const card = mappedCandidates(await mapRecord(mapper, collectorCard()));
  assert.equal(card.length, 1);
  const [cardCandidate] = card;
  assert.ok(cardCandidate?.candidateKind === "catalog_asset");
  assert.equal(cardCandidate.externalId, "sanitized-collector-card");
  assert.equal(cardCandidate.name, "Sanitized graded card");
  assert.equal(cardCandidate.availability, "active");
  assert.deepEqual(cardCandidate.estimatedValue, {
    amount: 125.5,
    currency: "USD",
  });

  const pack = mappedCandidates(await mapRecord(mapper, collectorPack()));
  const packCandidate = pack.find(({ candidateKind }) => candidateKind === "pack");
  const evInput = pack.find(({ candidateKind }) => candidateKind === "ev_input");
  assert.ok(packCandidate?.candidateKind === "pack");
  assert.deepEqual(packCandidate.providerReportedEv, {
    amount: 105,
    currency: "USD",
  });
  assert.ok(evInput?.candidateKind === "ev_input");
  assert.equal(evInput.evidenceCompleteness, "complete");
  assert.equal(
    evInput.buckets.filter(({ evidenceKind }) => evidenceKind === "top_chase")
      .length,
    1,
  );

  for (const outcome of [
    await mapRecord(mapper, collectorCard()),
    await mapRecord(mapper, collectorPack()),
  ]) {
    assert.equal(outcome.status, "mapped");
    if (outcome.status !== "mapped") continue;
    assert.equal(
      (
        await projectionService().project({
          configuration: configuration(mapper),
          source: outcome.source,
          candidates: outcome.candidates,
        })
      ).status,
      "accepted",
    );
  }
});

test("live outer availability is authoritative for provider packs", async () => {
  const collector = mappedCandidates(
    await mapRecord(new CollectorCryptMappingAdapter(), {
      ...collectorPack(),
      available: false,
    }),
  );
  const collectorPackCandidate = collector.find(
    ({ candidateKind }) => candidateKind === "pack",
  );
  assert.ok(collectorPackCandidate?.candidateKind === "pack");
  assert.equal(collectorPackCandidate.availability, "disabled");

  const courtyard = mappedCandidates(
    await mapRecord(new CourtyardMappingAdapter(), {
      ...courtyardPack(false),
      available: true,
    }),
  );
  const courtyardPackCandidate = courtyard.find(
    ({ candidateKind }) => candidateKind === "pack",
  );
  assert.ok(courtyardPackCandidate?.candidateKind === "pack");
  assert.equal(courtyardPackCandidate.availability, "active");
});

test("Collector Crypt keeps null pull evidence and converts buyback micro-USDC", async () => {
  const mapper = new CollectorCryptMappingAdapter();
  const unavailable = mappedCandidates(await mapRecord(mapper, collectorPull()));
  const pull = unavailable[0];
  assert.ok(pull?.candidateKind === "pull");
  assert.equal(pull.assetExternalId, null);
  assert.equal(pull.value, null);
  assert.deepEqual(
    pull.dataQualityEvidence.map(({ code }) => code),
    [
      "COLLECTOR_CRYPT_PULL_CARD_UNAVAILABLE",
      "COLLECTOR_CRYPT_PULL_VALUE_UNAVAILABLE",
    ],
  );

  const confirmed = mappedCandidates(
    await mapRecord(
      mapper,
      collectorPull({
        record_id: "sanitized-confirmed-buyback",
        card_id: "sanitized-collector-card",
        data: {
          spin_wallet: "sanitized-wallet",
          send_nft_insured_value: 125,
          buyback_status: "confirmed",
          buyback_refund_amount: "112500000",
        },
      }),
    ),
  );
  const confirmedPull = confirmed[0];
  assert.ok(confirmedPull?.candidateKind === "pull");
  assert.deepEqual(confirmedPull.buybackRefund, {
    amount: 112.5,
    currency: "USDC",
  });
  assert.equal(confirmedPull.buybackStatus, "confirmed");
});

test("Collector Crypt trades preserve exact lifecycle and incomplete money", async () => {
  const mapper = new CollectorCryptMappingAdapter();
  const outcome = await mapRecord(mapper, collectorTrade());
  const [trade] = mappedCandidates(outcome);
  assert.ok(trade?.candidateKind === "trade");
  assert.equal(trade.amount, null);
  const projected = await projectionService().project({
    configuration: configuration(mapper),
    source: outcome.source,
    candidates: [trade],
  });
  assert.equal(projected.status, "accepted");
  if (projected.status === "accepted") {
    assert.equal(projected.projections[0]?.content.eventCategory, "burn");
    assert.doesNotMatch(JSON.stringify(projected), /sanitized-from|sanitized-to/);
  }
});

test("Courtyard merges V2 fragments and normalizes provider-authored pack text", async () => {
  const mapper = new CourtyardMappingAdapter();
  const [card] = mappedCandidates(await mapRecord(mapper, courtyardCard()));
  assert.ok(card?.candidateKind === "catalog_asset");
  assert.equal(card.externalId, "sanitized-courtyard-card");
  assert.equal(card.name, "Sanitized reveal title");
  assert.deepEqual(card.estimatedValue, { amount: 100, currency: "USD" });
  assert.equal(card.valueSource, "provider_fmv_estimate");

  const activeRecord = courtyardPack();
  const active = mappedCandidates(
    await mapRecord(mapper, {
      ...activeRecord,
      data: {
        ...activeRecord.data,
        description: "One card\nper\tpack.",
      },
    }),
  );
  const activePack = active.find(({ candidateKind }) => candidateKind === "pack");
  const activeEv = active.find(({ candidateKind }) => candidateKind === "ev_input");
  assert.ok(activePack?.candidateKind === "pack");
  assert.equal(activePack.description, "One card per pack.");
  assert.ok(activeEv?.candidateKind === "ev_input");
  assert.equal(activeEv.evidenceCompleteness, "complete");

  const soldOut = mappedCandidates(
    await mapRecord(mapper, courtyardPack(false)),
  );
  const soldOutPack = soldOut.find(({ candidateKind }) => candidateKind === "pack");
  const soldOutEv = soldOut.find(({ candidateKind }) => candidateKind === "ev_input");
  assert.ok(soldOutPack?.candidateKind === "pack");
  assert.equal(soldOutPack.availability, "sold_out");
  assert.ok(soldOutEv?.candidateKind === "ev_input");
  assert.equal(soldOutEv.evidenceCompleteness, "partial");
  assert.equal(soldOutEv.buckets.length, 0);
});

test("Courtyard pulls use outer relationships and provider FMV", async () => {
  const mapper = new CourtyardMappingAdapter();
  const outcome = await mapRecord(mapper, courtyardPull());
  const [pull] = mappedCandidates(outcome);
  assert.ok(pull?.candidateKind === "pull");
  assert.equal(pull.packExternalId, "sanitized-courtyard-pack");
  assert.equal(pull.assetExternalId, "sanitized-courtyard-card");
  assert.deepEqual(pull.value, { amount: 112.5, currency: "USD" });
});

test("Courtyard resolves confirmed currency and payment-method semantics", async () => {
  const mapper = new CourtyardMappingAdapter();
  const cases = [
    {
      record: courtyardTrade(
        "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
        100,
      ),
      money: { amount: 100, currency: "USDC" },
      method: null,
    },
    {
      record: courtyardTrade("stripe", 100, "mint"),
      money: { amount: 100, currency: "USDC" },
      method: "stripe",
    },
    {
      record: courtyardTrade("partial_payment", 75, "mint"),
      money: { amount: 75, currency: "USDC" },
      method: "partial_payment",
    },
    {
      record: courtyardTrade(null, null, "transfer"),
      money: null,
      method: null,
    },
  ] as const;
  for (const scenario of cases) {
    const outcome = await mapRecord(mapper, scenario.record);
    const [trade] = mappedCandidates(outcome);
    assert.ok(trade?.candidateKind === "trade");
    assert.deepEqual(trade.amount, scenario.money);
    assert.equal(trade.paymentMethod, scenario.method);
    const projection = await projectionService().project({
      configuration: configuration(mapper),
      source: outcome.source,
      candidates: [trade],
    });
    assert.equal(projection.status, "accepted");
  }

  const unknown = await mapRecord(
    mapper,
    courtyardTrade("provider_new_currency", 50, "provider_new_event"),
  );
  const [unknownTrade] = mappedCandidates(unknown);
  assert.ok(unknownTrade?.candidateKind === "trade");
  assert.equal(unknownTrade.amount, null);
  assert.equal(
    unknownTrade.dataQualityEvidence[0]?.code,
    "COURTYARD_TRADE_CURRENCY_UNSUPPORTED",
  );
  const projection = await projectionService().project({
    configuration: configuration(mapper),
    source: unknown.source,
    candidates: [unknownTrade],
  });
  assert.equal(projection.status, "accepted");
  if (projection.status === "accepted") {
    assert.equal(projection.projections[0]?.content.eventCategory, "other");
  }
});
