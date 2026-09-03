/**
 * Synthetic, evidence-backed DataForrest Events V1 pages.
 *
 * All identities, cursors, transaction references, and nested values are local
 * aliases. The fixture preserves only the reviewed wrapper, field names, JSON
 * types, nullability, relationships, and same-record revision behavior.
 */

const fixtureNativeData = Object.freeze({
  provider_label: "fixture",
  optional_value: null,
});

const collectorCryptPackNativeData = Object.freeze({
  name: "  Collector Crypt Fixture Pack  ",
  ignored_native_field: null,
});

function packNativeData(platform: string) {
  return platform === "collector_crypt"
    ? collectorCryptPackNativeData
    : fixtureNativeData;
}

function initialRecords(platform: string) {
  return [
    {
      stream: "catalog",
      platform,
      record_id: `${platform}-pack-001`,
      occurred_at: "2026-01-01T00:00:00.000Z",
      collected_at: "2026-01-01T00:00:01.000Z",
      data: packNativeData(platform),
      entity: "pack",
      first_seen_at: "2026-01-01T00:00:00.000Z",
      available: true,
    },
    {
      stream: "catalog",
      platform,
      record_id: `${platform}-card-001`,
      occurred_at: "2026-01-01T00:00:00.000Z",
      collected_at: "2026-01-01T00:00:01.000Z",
      data: fixtureNativeData,
      entity: "card",
      first_seen_at: "2026-01-01T00:00:00.000Z",
      available: null,
    },
    {
      stream: "pulls",
      platform,
      record_id: `${platform}-pull-001`,
      occurred_at: "2026-01-02T00:00:00.000Z",
      collected_at: "2026-01-02T00:00:01.000Z",
      data: fixtureNativeData,
      pack_id: `${platform}-pack-001`,
      card_id: `${platform}-card-001`,
    },
    {
      stream: "trades",
      platform,
      record_id: `${platform}-trade-001`,
      occurred_at: "2026-01-03T00:00:00.000Z",
      collected_at: "2026-01-03T00:00:01.000Z",
      data: fixtureNativeData,
      card_id: `${platform}-card-001`,
      event_type: "sale",
      amount: 12.5,
      currency: "USD",
      payment_method: "stripe",
      tx_hash: `${platform}-transaction-001`,
    },
  ] as const;
}

function continuationRecords(platform: string) {
  return [
    {
      stream: "catalog",
      platform,
      record_id: `${platform}-pack-001`,
      occurred_at: "2026-01-04T00:00:00.000Z",
      collected_at: "2026-01-04T00:00:01.000Z",
      data: packNativeData(platform),
      entity: "pack",
      first_seen_at: "2026-01-01T00:00:00.000Z",
      available: false,
    },
    {
      stream: "trades",
      platform,
      record_id: `${platform}-trade-002`,
      occurred_at: "2026-01-05T00:00:00.000Z",
      collected_at: "2026-01-05T00:00:01.000Z",
      data: fixtureNativeData,
      card_id: `${platform}-card-001`,
      event_type: "buyback",
      amount: null,
      currency: null,
      payment_method: null,
      tx_hash: `${platform}-transaction-002`,
    },
  ] as const;
}

function pagesFor(platform: string) {
  return {
    initial: {
      records: initialRecords(platform),
      next_cursor: `fixture-${platform}-cursor-001`,
      poll_after_seconds: 0,
    },
    continuation: {
      records: continuationRecords(platform),
      next_cursor: `fixture-${platform}-cursor-002`,
      poll_after_seconds: 0,
    },
    reachedHead: {
      records: [],
      next_cursor: `fixture-${platform}-cursor-002`,
      poll_after_seconds: 60,
    },
  } as const;
}

export const dataforestEventsV1EvidenceFixture = Object.freeze({
  courtyard: pagesFor("courtyard"),
  collector_crypt: pagesFor("collector_crypt"),
  phygitals: pagesFor("phygitals"),
  clutchpacks: pagesFor("clutchpacks"),
});
