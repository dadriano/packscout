import assert from "node:assert/strict";
import { test } from "node:test";
import { dataforestEventsV1EvidenceFixture } from "./dataforest-events-v1.fixture.ts";

const platforms = [
  "courtyard",
  "collector_crypt",
  "phygitals",
  "clutchpacks",
] as const;

test("DataForrest evidence fixture preserves the reviewed wrapper and relationships", () => {
  for (const platform of platforms) {
    const pages = dataforestEventsV1EvidenceFixture[platform];
    assert.deepEqual(Object.keys(pages.initial).sort(), [
      "next_cursor",
      "poll_after_seconds",
      "records",
    ]);
    assert.equal(pages.initial.poll_after_seconds, 0);
    assert.equal(pages.reachedHead.poll_after_seconds, 60);

    const [pack, card, pull, trade] = pages.initial.records;
    assert.equal(pack.stream, "catalog");
    assert.equal(pack.entity, "pack");
    assert.equal(pack.available, true);
    assert.equal(card.stream, "catalog");
    assert.equal(card.entity, "card");
    assert.equal(card.available, null);
    assert.equal(pull.stream, "pulls");
    assert.equal(pull.pack_id, pack.record_id);
    assert.equal(pull.card_id, card.record_id);
    assert.equal(trade.stream, "trades");
    assert.equal(trade.card_id, card.record_id);

    const [packRevision, nullableTrade] = pages.continuation.records;
    assert.equal(packRevision.record_id, pack.record_id);
    assert.equal(packRevision.available, false);
    assert.equal(nullableTrade.amount, null);
    assert.equal(nullableTrade.currency, null);
    assert.equal(nullableTrade.payment_method, null);
  }
});

test("DataForrest evidence fixture contains aliases rather than live identities", () => {
  const serialized = JSON.stringify(dataforestEventsV1EvidenceFixture);
  assert.doesNotMatch(serialized, /Bearer\s/u);
  assert.doesNotMatch(serialized, /0x[a-f\d]{16,}/iu);
  assert.doesNotMatch(
    serialized,
    /\b[a-f\d]{8}-[a-f\d]{4}-[1-5][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}\b/iu,
  );
  for (const platform of platforms) {
    assert.match(serialized, new RegExp(`fixture-${platform}-cursor`, "u"));
    assert.match(serialized, new RegExp(`${platform}-(?:pack|card|pull|trade)`, "u"));
  }
});
