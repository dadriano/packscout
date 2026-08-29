import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type {
  MarketEventWriteInput,
  PullWriteInput,
} from "./provider-canonical-contract.ts";
import type { ProviderCanonicalTransaction } from "./provider-canonical-repository.ts";
import type { ProviderTransactionClient } from "./provider-database.ts";
import {
  applyProviderMixedPageRecord,
  ProviderMixedCandidateError,
} from "./provider-mixed-page-candidates.ts";
import type { ProviderMixedPageRecord } from "./provider-mixed-page-contract.ts";

const providerId = randomUUID();

function missingCatalogTransaction(): ProviderTransactionClient {
  return {
    packs: { findUnique: async () => null },
    collectibles: { findUnique: async () => null },
  } as unknown as ProviderTransactionClient;
}

test("mixed fact candidates preserve unresolved source keys instead of rejecting them", async () => {
  let pullInput: PullWriteInput | undefined;
  let marketEventInput: MarketEventWriteInput | undefined;
  const canonical = {
    async insertPull(input: PullWriteInput) {
      pullInput = input;
      return {
        id: randomUUID(),
        itemIds: [randomUUID()],
        replayed: false,
        promotionRange: { first: 1n, last: 2n },
      };
    },
    async insertMarketEvent(input: MarketEventWriteInput) {
      marketEventInput = input;
      return {
        id: randomUUID(),
        replayed: false,
        promotionRange: { first: 3n, last: 3n },
      };
    },
  } as unknown as ProviderCanonicalTransaction;
  const transaction = missingCatalogTransaction();

  const pullRecord = {
    position: 0,
    providerId,
    kind: "pull",
    candidate: {
      pullKey: "pull-before-catalog",
      factDigest: "a".repeat(64),
      packKey: "pack-before-catalog",
      providerAccountKey: null,
      occurredAt: "2026-08-29T12:34:56.000Z",
      paidAmount: null,
      paidCurrency: null,
      items: [{
        collectibleKey: "collectible-before-catalog",
        collectibleInstanceKey: null,
        quantity: "1",
        statedValueAmount: null,
        statedValueCurrency: null,
      }],
    },
  } satisfies ProviderMixedPageRecord;
  const pullOutcome = await applyProviderMixedPageRecord(transaction, canonical, pullRecord);
  assert.deepEqual(pullOutcome, { duplicate: false, materialChange: true });
  assert.equal(pullInput?.packKey, "pack-before-catalog");
  assert.equal(pullInput?.packId, null);
  assert.equal(pullInput?.items[0]?.collectibleKey, "collectible-before-catalog");
  assert.equal(pullInput?.items[0]?.collectibleId, null);

  const marketEventRecord = {
    position: 1,
    providerId,
    kind: "market_event",
    candidate: {
      eventKey: "event-before-catalog",
      factDigest: "b".repeat(64),
      eventGroupId: null,
      eventType: "sale",
      packKey: "pack-before-catalog",
      collectibleKey: "collectible-before-catalog",
      collectibleInstanceKey: null,
      fromProviderAccountKey: null,
      toProviderAccountKey: null,
      quantity: "1",
      occurredAt: "2026-08-29T12:34:56.000Z",
      amount: "10",
      currency: "USD",
      details: {},
    },
  } satisfies ProviderMixedPageRecord;
  const eventOutcome = await applyProviderMixedPageRecord(
    transaction,
    canonical,
    marketEventRecord,
  );
  assert.deepEqual(eventOutcome, { duplicate: false, materialChange: true });
  assert.equal(marketEventInput?.packKey, "pack-before-catalog");
  assert.equal(marketEventInput?.packId, null);
  assert.equal(marketEventInput?.collectibleKey, "collectible-before-catalog");
  assert.equal(marketEventInput?.collectibleId, null);
});

test("a pull item cannot silently drop an unresolved collectible instance key", async () => {
  const record = {
    position: 0,
    providerId,
    kind: "pull",
    candidate: {
      pullKey: "pull-with-unresolved-instance",
      factDigest: "c".repeat(64),
      packKey: null,
      providerAccountKey: null,
      occurredAt: "2026-08-29T12:34:56.000Z",
      paidAmount: null,
      paidCurrency: null,
      items: [{
        collectibleKey: "collectible-before-catalog",
        collectibleInstanceKey: "instance-before-catalog",
        quantity: "1",
        statedValueAmount: null,
        statedValueCurrency: null,
      }],
    },
  } satisfies ProviderMixedPageRecord;

  await assert.rejects(
    applyProviderMixedPageRecord(
      missingCatalogTransaction(),
      {} as ProviderCanonicalTransaction,
      record,
    ),
    (error: unknown) => error instanceof ProviderMixedCandidateError
      && error.fieldPath === "items[0].collectibleInstanceKey",
  );
});

test("a market event cannot silently drop an unresolved collectible instance key", async () => {
  const record = {
    position: 0,
    providerId,
    kind: "market_event",
    candidate: {
      eventKey: "event-with-unresolved-instance",
      factDigest: "d".repeat(64),
      eventGroupId: null,
      eventType: "sale",
      packKey: null,
      collectibleKey: "collectible-before-catalog",
      collectibleInstanceKey: "instance-before-catalog",
      fromProviderAccountKey: null,
      toProviderAccountKey: null,
      quantity: "1",
      occurredAt: "2026-08-29T12:34:56.000Z",
      amount: "10",
      currency: "USD",
      details: {},
    },
  } satisfies ProviderMixedPageRecord;

  await assert.rejects(
    applyProviderMixedPageRecord(
      missingCatalogTransaction(),
      {} as ProviderCanonicalTransaction,
      record,
    ),
    (error: unknown) => error instanceof ProviderMixedCandidateError
      && error.fieldPath === "collectibleInstanceKey",
  );
});
