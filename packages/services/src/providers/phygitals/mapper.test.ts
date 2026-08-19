import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CatalogRecordV2,
  PullRecordV2,
  TradeRecordV2,
} from "@packscout/contracts";
import type {
  ProviderAdapterCandidate,
  ProviderRecordMappingOutcome,
} from "../../provider-adapter.ts";
import { CatalogProjectionService } from "../../catalog-projection-service.ts";
import {
  EventProjectionService,
  HmacProviderActorPseudonymizer,
} from "../../event-projection-service.ts";
import { ProviderProjectionService } from "../../provider-projection-service.ts";
import { providerMapperManifest } from "../provider-mapper-manifest.ts";
import { PhygitalsMappingAdapter } from "./mapper.ts";

const mapper = new PhygitalsMappingAdapter();
const collectedAt = "2026-08-19T12:00:00Z";
const occurredAt = "2026-08-19T11:00:00Z";
const firstSeenAt = "2026-08-18T00:00:00Z";

const configuration = {
  providerId: "sanitized-phygitals-provider",
  configurationRevisionId: "sanitized-phygitals-revision",
  platform: mapper.platformKey,
  adapterKey: mapper.key,
};

function mapRecord(
  record: CatalogRecordV2 | PullRecordV2 | TradeRecordV2,
): ProviderRecordMappingOutcome {
  return mapper.mapRecord({ configuration, record, recordIndex: 3 });
}

function mappedCandidates(
  outcome: ProviderRecordMappingOutcome,
): readonly ProviderAdapterCandidate[] {
  assert.equal(outcome.status, "mapped");
  return outcome.status === "mapped" ? outcome.candidates : [];
}

function phygitalsPack(
  overrides: Partial<CatalogRecordV2> = {},
): CatalogRecordV2 {
  return {
    stream: "catalog",
    platform: "phygitals",
    record_id: "sanitized-phygitals-pack",
    entity: "pack",
    occurred_at: occurredAt,
    collected_at: collectedAt,
    first_seen_at: firstSeenAt,
    available: true,
    data: {
      id: "ignored-nested-pack-id",
      name: "Sanitized Phygitals Pack",
      description: "Two pulls\nwith provider odds.",
      category: "Sports",
      mint_price: "25.00",
      ev: 27.5,
      buyback_percent: 0.85,
      pulls_per_voucher: 0,
      enable: false,
      in_stock: false,
      claw_image_url: "https://cdn.example.test/phygitals-pack.png",
      rarity_distribution: [
        { id: 1, name: "Base", weight: 80, lower: 5, upper: 30 },
        { id: 2, name: "Rare", weight: 20, lower: 30, upper: 100 },
      ],
      variants: [{ id: "ignored-nested-variant" }],
      chase: [{ id: "ignored-nested-chase" }],
    },
    ...overrides,
  };
}

function phygitalsCard(
  recordId: string,
  data: CatalogRecordV2["data"],
): CatalogRecordV2 {
  return {
    stream: "catalog",
    platform: "phygitals",
    record_id: recordId,
    entity: "card",
    occurred_at: occurredAt,
    collected_at: collectedAt,
    first_seen_at: firstSeenAt,
    available: null,
    data,
  };
}

function phygitalsPull(): PullRecordV2 {
  return {
    stream: "pulls",
    platform: "phygitals",
    record_id: "sanitized-phygitals-pull",
    pack_id: "sanitized-outer-pack",
    card_id: "sanitized-outer-card",
    occurred_at: occurredAt,
    collected_at: collectedAt,
    data: {
      id: "ignored-nested-card-id",
      claw_id: "ignored-nested-pack-id",
      value: 42.5,
      transaction: {
        from: "sanitized-from-account",
        to: "sanitized-to-account",
      },
    },
  };
}

function phygitalsTrade(
  overrides: Partial<TradeRecordV2> = {},
): TradeRecordV2 {
  return {
    stream: "trades",
    platform: "phygitals",
    record_id: "sanitized-phygitals-trade",
    card_id: "sanitized-outer-card",
    event_type: "buyback",
    amount: 38.25,
    currency: "USDC",
    payment_method: "wallet",
    tx_hash: "sanitized-outer-transaction",
    occurred_at: occurredAt,
    collected_at: collectedAt,
    data: {
      amount: "999.00",
      currency: "EUR",
      txid: "ignored-nested-transaction",
      clawId: "ignored-nested-pack-id",
      from: "sanitized-seller",
      to: "sanitized-buyer",
      nft: {
        address: "ignored-nested-card-id",
        owner: "sanitized-owner",
      },
    },
    ...overrides,
  };
}

function projectionService() {
  return new ProviderProjectionService(
    new CatalogProjectionService(),
    new EventProjectionService(
      new HmacProviderActorPseudonymizer(new Uint8Array(32).fill(9)),
    ),
  );
}

test("Phygitals maps one V2 pack from the authoritative outer identity", async () => {
  const outcome = mapRecord(phygitalsPack());
  const candidates = mappedCandidates(outcome);
  assert.equal(candidates.length, 2);

  const pack = candidates.find(({ candidateKind }) => candidateKind === "pack");
  assert.ok(pack?.candidateKind === "pack");
  assert.equal(pack.externalId, "sanitized-phygitals-pack");
  assert.equal(pack.availability, "active");
  assert.equal(pack.description, "Two pulls with provider odds.");
  assert.deepEqual(pack.price, { amount: 25, currency: "USD" });
  assert.deepEqual(pack.providerReportedEv, {
    amount: 27.5,
    currency: "USD",
  });
  assert.equal(pack.buybackPercent, 85);
  assert.equal(pack.drawCount, null);
  assert.deepEqual(
    pack.dataQualityEvidence.map(({ code }) => code),
    ["PHYGITALS_DRAW_SEMANTICS_UNAVAILABLE"],
  );

  const evInput = candidates.find(
    ({ candidateKind }) => candidateKind === "ev_input",
  );
  assert.ok(evInput?.candidateKind === "ev_input");
  assert.equal(evInput.packExternalId, "sanitized-phygitals-pack");
  assert.equal(evInput.evidenceCompleteness, "partial");
  assert.equal(evInput.unitBasis, null);
  assert.equal(evInput.declaredCoverage, 1);

  assert.equal(outcome.status, "mapped");
  if (outcome.status === "mapped") {
    assert.equal(
      (
        await projectionService().project({
          configuration,
          source: outcome.source,
          candidates: outcome.candidates,
        })
      ).status,
      "accepted",
    );
  }
});

test("Phygitals outer availability overrides conflicting nested pack flags", () => {
  const disabled = mappedCandidates(
    mapRecord(phygitalsPack({ available: false })),
  );
  const disabledPack = disabled.find(
    ({ candidateKind }) => candidateKind === "pack",
  );
  assert.ok(disabledPack?.candidateKind === "pack");
  assert.equal(disabledPack.availability, "disabled");

  const invalid = mapRecord(phygitalsPack({
    data: { name: "Missing price" },
  }));
  assert.equal(invalid.status, "invalid");
  assert.equal(
    invalid.status === "invalid" ? invalid.failure.reasonCode : null,
    "PHYGITALS_PACK_PRICE_INVALID",
  );
});

test("Phygitals maps the observed asset and chase card branches", () => {
  const assetCandidates = mappedCandidates(mapRecord(phygitalsCard(
    "sanitized-phygitals-asset",
    {
      asset: {
        id: "ignored-nested-asset-id",
        title: "Sanitized Catalog Asset",
        type: "graded_card",
        properties: { category: "Sports" },
        altFmv: "125.50",
        altFmvSource: "provider_market_value",
        lastSale: "100.00",
        price: "999.00",
        burned: false,
        listed: true,
        image: { imageUrl: "https://cdn.example.test/asset.png" },
      },
    },
  )));
  const asset = assetCandidates[0];
  assert.ok(asset?.candidateKind === "catalog_asset");
  assert.equal(asset.externalId, "sanitized-phygitals-asset");
  assert.equal(asset.availability, "unknown");
  assert.equal(asset.category, "Sports");
  assert.deepEqual(asset.estimatedValue, {
    amount: 125.5,
    currency: "USD",
  });
  assert.equal(asset.valueSource, "provider_market_value");

  const lastSaleCandidates = mappedCandidates(mapRecord(phygitalsCard(
    "sanitized-phygitals-last-sale-asset",
    {
      asset: {
        name: "Sanitized Last Sale Asset",
        lastSale: "75.25",
        price: "999.00",
        burned: false,
      },
    },
  )));
  const lastSale = lastSaleCandidates[0];
  assert.ok(lastSale?.candidateKind === "catalog_asset");
  assert.deepEqual(lastSale.estimatedValue, {
    amount: 75.25,
    currency: "USD",
  });
  assert.equal(lastSale.valueSource, "provider_last_sale");

  const chaseCandidates = mappedCandidates(mapRecord(phygitalsCard(
    "sanitized-phygitals-chase",
    {
      chase: {
        id: "ignored-nested-chase-id",
        name: "Sanitized Chase",
        fmv: 500,
        image: "https://cdn.example.test/chase.png",
      },
    },
  )));
  const chase = chaseCandidates[0];
  assert.ok(chase?.candidateKind === "catalog_asset");
  assert.equal(chase.externalId, "sanitized-phygitals-chase");
  assert.equal(chase.assetType, "chase_collectible");
  assert.equal(chase.availability, "unknown");
  assert.deepEqual(
    chase.dataQualityEvidence.map(({ code }) => code),
    ["PHYGITALS_CHASE_NOT_COMPLETE_INVENTORY"],
  );

  const ambiguous = mapRecord(phygitalsCard(
    "sanitized-ambiguous-card",
    { asset: {}, chase: {} },
  ));
  assert.equal(ambiguous.status, "invalid");
  assert.equal(
    ambiguous.status === "invalid" ? ambiguous.failure.reasonCode : null,
    "PHYGITALS_CARD_BRANCH_INVALID",
  );
});

test("Phygitals events map only authoritative outer-envelope evidence", async () => {
  const pullOutcome = mapRecord(phygitalsPull());
  const pull = mappedCandidates(pullOutcome)[0];
  assert.ok(pull?.candidateKind === "pull");
  assert.equal(pull.packExternalId, "sanitized-outer-pack");
  assert.equal(pull.assetExternalId, "sanitized-outer-card");
  assert.equal(pull.value, null);
  assert.deepEqual(pull.pseudonymizationInputs, []);
  assert.deepEqual(
    pull.dataQualityEvidence.map(({ code }) => code),
    [
      "PHYGITALS_PULL_PAYLOAD_UNCONFIRMED",
      "PHYGITALS_PULL_OUTCOME_VALUE_UNAVAILABLE",
    ],
  );
  assert.equal(pullOutcome.source.externalId, "sanitized-phygitals-pull");

  const tradeOutcome = mapRecord(phygitalsTrade());
  const trade = mappedCandidates(tradeOutcome)[0];
  assert.ok(trade?.candidateKind === "trade");
  assert.equal(trade.assetExternalId, "sanitized-outer-card");
  assert.equal(trade.transactionKey, "sanitized-outer-transaction");
  assert.equal(trade.packExternalId, null);
  assert.deepEqual(trade.amount, { amount: 38.25, currency: "USDC" });
  assert.equal(trade.paymentMethod, "wallet");
  assert.deepEqual(trade.pseudonymizationInputs, []);
  assert.deepEqual(
    trade.dataQualityEvidence.map(({ code }) => code),
    ["PHYGITALS_TRADE_PAYLOAD_UNCONFIRMED"],
  );
  assert.equal(tradeOutcome.source.externalId, "sanitized-phygitals-trade");

  for (const outcome of [pullOutcome, tradeOutcome]) {
    assert.equal(outcome.status, "mapped");
    if (outcome.status !== "mapped") continue;
    assert.equal(
      (
        await projectionService().project({
          configuration,
          source: outcome.source,
          candidates: outcome.candidates,
        })
      ).status,
      "accepted",
    );
  }
});

test("Phygitals unknown trade lifecycle and absent money remain explicit", async () => {
  const outcome = mapRecord(phygitalsTrade({
    record_id: "sanitized-phygitals-future-trade",
    event_type: "future_provider_event",
    amount: null,
    currency: null,
    payment_method: null,
  }));
  const trade = mappedCandidates(outcome)[0];
  assert.ok(trade?.candidateKind === "trade");
  assert.equal(trade.eventType, "future_provider_event");
  assert.equal(trade.amount, null);

  assert.equal(outcome.status, "mapped");
  if (outcome.status !== "mapped") return;
  const projected = await projectionService().project({
    configuration,
    source: outcome.source,
    candidates: outcome.candidates,
  });
  assert.equal(projected.status, "accepted");
  if (projected.status !== "accepted") return;
  assert.equal(projected.projections[0]?.content.eventCategory, "other");
});

test("V2 mapper manifest registers Phygitals for every record kind", () => {
  const entry = providerMapperManifest.find(
    ({ platformKey }) => platformKey === "phygitals",
  );
  assert.ok(entry);
  assert.equal(entry.adapterKey, "phygitals-v2");
  assert.equal(entry.mappingVersion, "v2");
  assert.deepEqual(entry.supportedRecordKinds, ["catalog", "pull", "trade"]);
});
