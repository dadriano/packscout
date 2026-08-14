import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CatalogRecordV2,
  PullRecordV2,
  TradeRecordV2,
} from "@packscout/contracts";
import {
  assertStreamLocalPageCommitV2,
  decideProviderStreamWriteV2,
} from "./provider-stream-write-policy.ts";

const catalog: CatalogRecordV2 = {
  stream: "catalog",
  platform: "courtyard",
  entity: "pack",
  record_id: "pack-001",
  first_seen_at: "2026-08-09T18:02:11Z",
  occurred_at: null,
  collected_at: "2026-08-11T08:30:02Z",
  data: { title: "Pack", status: "ACTIVE" },
};

const pull: PullRecordV2 = {
  stream: "pulls",
  platform: "courtyard",
  record_id: "pull-001",
  pack_id: "pack-001",
  card_id: "card-001",
  occurred_at: "2026-08-10T01:25:48Z",
  collected_at: "2026-08-10T12:52:48Z",
  data: { title: "Card" },
};

const trade: TradeRecordV2 = {
  stream: "trades",
  platform: "collector_crypt",
  record_id: "trade-001",
  card_id: "card-001",
  occurred_at: "2026-08-10T11:49:52Z",
  collected_at: "2026-08-10T11:50:14Z",
  event_type: "list",
  amount: 150,
  currency: "USDC",
  tx_hash: "transaction-001",
  data: { action: "List" },
};

test("catalog observations deduplicate unchanged content and revise mutable content", () => {
  const initial = decideProviderStreamWriteV2({
    existing: null,
    incoming: catalog,
  });
  assert.equal(initial.kind, "accept_initial");

  const duplicate = decideProviderStreamWriteV2({
    existing: catalog,
    incoming: {
      ...catalog,
      collected_at: "2026-08-11T08:35:02Z",
    },
  });
  assert.equal(duplicate.kind, "duplicate");

  const revision = decideProviderStreamWriteV2({
    existing: catalog,
    incoming: {
      ...catalog,
      collected_at: "2026-08-11T08:40:02Z",
      data: { ...catalog.data, status: "SOLD_OUT" },
    },
  });
  assert.equal(revision.kind, "catalog_revision");
});

test("catalog identity changes quarantine instead of rewriting stable identity", () => {
  for (const incoming of [
    { ...catalog, entity: "card" as const },
    { ...catalog, first_seen_at: "2026-08-10T18:02:11Z" },
    { ...catalog, platform: "collector_crypt" },
    { ...catalog, record_id: "pack-conflict" },
  ]) {
    assert.deepEqual(decideProviderStreamWriteV2({ existing: catalog, incoming }), {
      kind: "quarantine",
      reasonCode: "CATALOG_IDENTITY_CONFLICT",
    });
  }
});

test("pulls and trades are immutable, idempotent events", () => {
  for (const event of [pull, trade]) {
    assert.equal(
      decideProviderStreamWriteV2({
        existing: event,
        incoming: {
          ...event,
          collected_at: "2026-08-11T13:00:00Z",
        },
      }).kind,
      "duplicate",
    );
  }

  assert.deepEqual(
    decideProviderStreamWriteV2({
      existing: trade,
      incoming: { ...trade, amount: 151 },
    }),
    { kind: "quarantine", reasonCode: "IMMUTABLE_EVENT_CONFLICT" },
  );
  assert.deepEqual(
    decideProviderStreamWriteV2({
      existing: pull,
      incoming: { ...pull, card_id: "card-conflict" },
    }),
    { kind: "quarantine", reasonCode: "IMMUTABLE_EVENT_CONFLICT" },
  );
});

test("page commits cannot mix catalog, pulls, and trades checkpoints", () => {
  assert.doesNotThrow(() =>
    assertStreamLocalPageCommitV2({
      runStream: "catalog",
      pageStream: "catalog",
      records: [catalog],
    }),
  );
  assert.throws(
    () =>
      assertStreamLocalPageCommitV2({
        runStream: "catalog",
        pageStream: "catalog",
        records: [catalog, pull],
      }),
    /cannot cross stream checkpoints/,
  );
  assert.throws(
    () =>
      assertStreamLocalPageCommitV2({
        runStream: "pulls",
        pageStream: "trades",
        records: [trade],
      }),
    /cannot cross stream checkpoints/,
  );
});
