import assert from "node:assert/strict";
import { test } from "node:test";
import type { PullRecordV2, TradeRecordV2 } from "@packscout/contracts";
import {
  normalizeTradeEvidence,
  normalizeTradeLifecycleEvidence,
  outerRelationshipEvidence,
  resolveCanonicalCurrencyEvidence,
} from "./provider-stream-normalization.ts";

test("provider lifecycle synonyms retain raw evidence and map to one category", () => {
  const cases = [
    [" List ", "list"],
    ["listing", "list"],
    ["unlist", "unlist"],
    ["UNLISTING", "unlist"],
    ["buyback", "buyback"],
    ["Sold", "sale"],
    ["minted", "mint"],
    ["burned", "burn"],
    ["transferred", "transfer"],
    ["swapped", "swap"],
    ["Shipped", "ship"],
    ["provider-new-vocabulary", "other"],
  ] as const;

  for (const [rawEventType, canonicalCategory] of cases) {
    assert.deepEqual(normalizeTradeLifecycleEvidence(rawEventType), {
      rawEventType,
      canonicalCategory,
    });
  }
  assert.throws(
    () => normalizeTradeLifecycleEvidence("  "),
    /cannot be blank/,
  );
});

test("approved symbols and addresses resolve while exact raw references remain evidence", () => {
  const polygonUsdc = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
  const approvals = [
    { reference: "USDC", canonicalSymbol: "usdc" },
    { reference: polygonUsdc.toLowerCase(), canonicalSymbol: "USDC" },
  ];

  assert.deepEqual(resolveCanonicalCurrencyEvidence("usdc", approvals), {
    status: "resolved",
    rawReference: "usdc",
    canonicalSymbol: "USDC",
  });
  assert.deepEqual(
    resolveCanonicalCurrencyEvidence(polygonUsdc, approvals),
    {
      status: "resolved",
      rawReference: polygonUsdc,
      canonicalSymbol: "USDC",
    },
  );
  assert.deepEqual(resolveCanonicalCurrencyEvidence("ETH", approvals), {
    status: "unsupported",
    rawReference: "ETH",
    canonicalSymbol: null,
  });
  assert.deepEqual(resolveCanonicalCurrencyEvidence(null, approvals), {
    status: "unavailable",
    rawReference: null,
    canonicalSymbol: null,
  });
});

test("outer pull relationships override nested provider lookalikes", () => {
  const pull: PullRecordV2 = {
    stream: "pulls",
    platform: "courtyard",
    record_id: "pull-outer",
    pack_id: "pack-outer",
    card_id: "card-outer",
    occurred_at: null,
    collected_at: "2026-08-11T00:00:00Z",
    data: {
      record_id: "pull-nested",
      pack_id: "pack-nested",
      card_id: "card-nested",
    },
  };

  assert.deepEqual(outerRelationshipEvidence(pull), {
    stream: "pulls",
    recordId: "pull-outer",
    packId: "pack-outer",
    cardId: "card-outer",
  });
});

test("trade normalization never converts missing money to zero", () => {
  const trade: TradeRecordV2 = {
    stream: "trades",
    platform: "courtyard",
    record_id: "trade-001",
    card_id: "card-001",
    occurred_at: null,
    collected_at: "2026-08-11T00:00:00Z",
    event_type: "transfer",
    amount: null,
    currency: null,
    tx_hash: "transaction-001",
    data: {},
  };

  assert.deepEqual(normalizeTradeEvidence(trade, []), {
    relationship: {
      stream: "trades",
      recordId: "trade-001",
      cardId: "card-001",
      transactionHash: "transaction-001",
    },
    lifecycle: {
      rawEventType: "transfer",
      canonicalCategory: "transfer",
    },
    amount: null,
    currency: {
      status: "unavailable",
      rawReference: null,
      canonicalSymbol: null,
    },
  });
});
