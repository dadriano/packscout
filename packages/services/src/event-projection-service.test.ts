import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ProviderConfigurationIdentity,
  ProviderSourceIdentity,
  PullCandidate,
  TradeCandidate,
} from "./provider-adapter.ts";
import {
  EventProjectionService,
  HmacProviderActorPseudonymizer,
} from "./event-projection-service.ts";

const configuration: ProviderConfigurationIdentity = {
  providerId: "provider-a",
  configurationRevisionId: "revision-a",
  platform: "fixture",
  adapterKey: "fixture-mapper-v2",
};
const pullSource: ProviderSourceIdentity = {
  platform: "fixture",
  recordKind: "pull",
  recordIndex: 2,
  externalId: "pull-1",
  sourceTimestamp: "2026-08-06T10:00:00.000Z",
  collectedAt: "2026-08-06T10:01:00.000Z",
};
const tradeSource: ProviderSourceIdentity = {
  ...pullSource,
  recordKind: "trade",
  recordIndex: 4,
  externalId: "trade-1",
};

function pull(overrides: Partial<PullCandidate> = {}): PullCandidate {
  return {
    candidateKind: "pull",
    source: pullSource,
    relationships: [],
    dataQualityEvidence: [],
    packExternalId: "pack-1",
    assetExternalId: "asset-1",
    occurredAt: pullSource.sourceTimestamp,
    value: { amount: 12.345, currency: "USD" },
    valueSource: "provider_event",
    buybackStatus: null,
    buybackRefund: null,
    pseudonymizationInputs: [
      {
        role: "owner",
        namespace: "fixture-user",
        sourceIdentifier: "public-user-name",
      },
    ],
    ...overrides,
  };
}

function trade(overrides: Partial<TradeCandidate> = {}): TradeCandidate {
  return {
    candidateKind: "trade",
    source: tradeSource,
    relationships: [],
    dataQualityEvidence: [],
    eventType: "sale",
    transactionKey: "tx-1",
    packExternalId: "pack-1",
    assetExternalId: "asset-1",
    occurredAt: tradeSource.sourceTimestamp,
    amount: { amount: 40, currency: "USD" },
    paymentMethod: null,
    pseudonymizationInputs: [
      {
        role: "from",
        namespace: "wallet",
        sourceIdentifier: "0xraw-wallet-address",
      },
      {
        role: "to",
        namespace: "wallet",
        sourceIdentifier: "0xother-wallet-address",
      },
    ],
    ...overrides,
  };
}

function service(providerKey = new Uint8Array(32).fill(9)) {
  return new EventProjectionService(
    new HmacProviderActorPseudonymizer(providerKey),
  );
}

test("pull projection preserves nullable links, value and buyback evidence, and resolvable relationships", () => {
  const result = service().project({
    configuration,
    source: pullSource,
    candidates: [
      pull({
        buybackStatus: "confirmed",
        buybackRefund: { amount: 10.5, currency: "USDC" },
      }),
    ],
  });
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") return;
  const projection = result.projections[0]!;
  assert.equal(projection.recordKind, "pull");
  assert.deepEqual(projection.relationships, [
    {
      relationshipKind: "subject",
      targetPlatformKey: "fixture",
      targetRecordKind: "pack",
      targetExternalId: "pack-1",
    },
    {
      relationshipKind: "asset",
      targetPlatformKey: "fixture",
      targetRecordKind: "catalog_asset",
      targetExternalId: "asset-1",
    },
  ]);
  assert.deepEqual(projection.content.value, {
    amountMinor: 1235,
    currency: "USD",
    minorUnitExponent: 2,
  });
  assert.equal(projection.content.valueSource, "provider_event");
  assert.equal(projection.content.buybackStatus, "confirmed");
  assert.deepEqual(projection.content.buybackRefund, {
    amountMinor: 10_500_000,
    currency: "USDC",
    minorUnitExponent: 6,
  });
  assert.equal(
    JSON.stringify(projection).includes("public-user-name"),
    false,
  );

  const nullLink = service().project({
    configuration,
    source: pullSource,
    candidates: [
      pull({ packExternalId: null, assetExternalId: null, value: null }),
    ],
  });
  assert.equal(nullLink.status, "accepted");
  if (nullLink.status === "accepted") {
    assert.deepEqual(nullLink.projections[0]?.relationships, []);
    assert.equal(nullLink.projections[0]?.content.packExternalId, null);
  }
});

test("trade projection keeps provider type separate from exact category and accepts nullable money", () => {
  const known = service().project({
    configuration,
    source: tradeSource,
    candidates: [
      trade({
        eventType: "buyback",
        amount: { amount: 12.345678, currency: "USDC" },
        paymentMethod: "partial_payment",
      }),
    ],
  });
  assert.equal(known.status, "accepted");
  if (known.status === "accepted") {
    assert.equal(known.projections[0]?.content.providerEventType, "buyback");
    assert.equal(known.projections[0]?.content.eventCategory, "buyback");
    assert.equal(known.projections[0]?.content.paymentMethod, "partial_payment");
    assert.deepEqual(known.projections[0]?.content.amount, {
      amountMinor: 12_345_678,
      currency: "USDC",
      minorUnitExponent: 6,
    });
    assert.equal(known.projections[0]?.recordKind, "trade");
    assert.equal(
      JSON.stringify(known).includes("0xraw-wallet-address"),
      false,
    );
  }
  const unknown = service().project({
    configuration,
    source: tradeSource,
    candidates: [trade({ eventType: "raffle_settlement", amount: null })],
  });
  assert.equal(unknown.status, "accepted");
  if (unknown.status === "accepted") {
    assert.equal(unknown.projections[0]?.content.providerEventType, "raffle_settlement");
    assert.equal(unknown.projections[0]?.content.eventCategory, "other");
    assert.equal(unknown.projections[0]?.content.amount, null);
  }
});

test("actor pseudonyms are stable within provider scope and unlinkable across providers", () => {
  const pseudonymizer = new HmacProviderActorPseudonymizer(
    new Uint8Array(32).fill(5),
  );
  const input = {
    providerId: "provider-a",
    platformKey: "fixture",
    role: "owner" as const,
    namespace: "user",
    sourceIdentifier: "same-source-user",
  };
  const first = pseudonymizer.pseudonymize(input);
  assert.equal(first, pseudonymizer.pseudonymize(input));
  assert.notEqual(
    first,
    pseudonymizer.pseudonymize({ ...input, providerId: "provider-b" }),
  );
  assert.match(first, /^actor:v1:[a-f0-9]{64}$/);
});

test("invalid candidate sets, identities, timestamps, amounts, and duplicate actor roles quarantine independently", () => {
  const projection = service();
  const cases = [
    {
      candidates: [],
      expected: "EVENT_CANDIDATE_SET_INVALID",
    },
    {
      candidates: [pull({ source: { ...pullSource, externalId: "other" } })],
      expected: "EVENT_SOURCE_MISMATCH",
    },
    {
      candidates: [pull({ occurredAt: "not-a-time" })],
      expected: "EVENT_INVALID_TIMESTAMP",
    },
    {
      candidates: [pull({ value: { amount: Number.NaN, currency: "USD" } })],
      expected: "EVENT_INVALID_MONEY",
    },
    {
      candidates: [
        pull({
          pseudonymizationInputs: [
            { role: "owner", namespace: "user", sourceIdentifier: "one" },
            { role: "owner", namespace: "user", sourceIdentifier: "two" },
          ],
        }),
      ],
      expected: "EVENT_INVALID_IDENTITY",
    },
  ];
  for (const scenario of cases) {
    const result = projection.project({
      configuration,
      source: pullSource,
      candidates: scenario.candidates,
    });
    assert.equal(result.status, "invalid");
    if (result.status === "invalid") assert.equal(result.reasonCode, scenario.expected);
  }
});
