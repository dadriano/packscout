import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizedProviderStreamV2Records } from "./__fixtures__/provider-stream-v2/records.ts";
import {
  parseProviderStreamRecordV2,
  providerStreamOrderingTimestampV2,
  safeValidateProviderStreamPageV2,
} from "./provider-stream-contract-v2.ts";

test("archive-backed record fixtures preserve V2 envelopes without inventing a page wrapper", () => {
  const records = Object.values(sanitizedProviderStreamV2Records).map((record) =>
    parseProviderStreamRecordV2(record),
  );

  assert.deepEqual(
    records.map(({ stream }) => stream),
    ["pulls", "pulls", "trades", "catalog", "catalog"],
  );
  assert.equal(sanitizedProviderStreamV2Records.collectorCryptCardlessPull.card_id, null);
  assert.equal(
    "payment_method" in sanitizedProviderStreamV2Records.collectorCryptTrade,
    false,
  );
  assert.equal("next_cursor" in sanitizedProviderStreamV2Records, false);
});

test("live catalog availability is retained while the digest-pinned archive remains readable", () => {
  const archiveRecord = parseProviderStreamRecordV2(
    sanitizedProviderStreamV2Records.courtyardCatalogPack,
  );
  assert.equal(
    archiveRecord.stream === "catalog" ? archiveRecord.available : undefined,
    undefined,
  );

  const liveRecord = parseProviderStreamRecordV2({
    ...sanitizedProviderStreamV2Records.courtyardCatalogPack,
    available: false,
  });
  assert.equal(
    liveRecord.stream === "catalog" ? liveRecord.available : undefined,
    false,
  );
});

test("missing pull outcomes remain explicit while absent relationship fields fail", () => {
  const invalidPull = structuredClone(
    sanitizedProviderStreamV2Records.collectorCryptCardlessPull,
  ) as {
    card_id?: string | null;
  };
  delete invalidPull.card_id;

  const result = safeValidateProviderStreamPageV2({
    rawPage: { providerWrapper: "observed-only-by-adapter" },
    normalizedPage: {
      requestedCursor: null,
      nextCursor: "head-collector-crypt-001",
      hasMore: false,
      records: [
        sanitizedProviderStreamV2Records.collectorCryptCardlessPull,
        invalidPull,
      ],
    },
    context: {
      requestedPlatform: "collector_crypt",
      requestedCursor: null,
    },
  });

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.page.records.length, 1);
  assert.equal(result.data.page.records[0]?.stream, "pulls");
  if (result.data.page.records[0]?.stream === "pulls") {
    assert.equal(result.data.page.records[0].card_id, null);
  }
  assert.deepEqual(result.data.invalidRecords[0]?.issues, [
    { code: "invalid_type", path: "records[1].card_id" },
  ]);
  assert.deepEqual(result.data.rawPage, {
    providerWrapper: "observed-only-by-adapter",
  });
});

test("one provider cursor accepts mixed streams while binding every record to its platform", () => {
  const recordMismatch = safeValidateProviderStreamPageV2({
    rawPage: {},
    normalizedPage: {
      requestedCursor: null,
      nextCursor: "head-collector-crypt-001",
      hasMore: false,
      records: [
        sanitizedProviderStreamV2Records.collectorCryptTrade,
        sanitizedProviderStreamV2Records.collectorCryptCardlessPull,
        {
          ...sanitizedProviderStreamV2Records.collectorCryptTrade,
          platform: "courtyard",
        },
      ],
    },
    context: {
      requestedPlatform: "collector_crypt",
      requestedCursor: null,
    },
  });
  assert.equal(recordMismatch.success, true);
  if (!recordMismatch.success) return;
  assert.deepEqual(
    recordMismatch.data.invalidRecords.map(({ issues }) => issues),
    [[{ code: "platform_mismatch", path: "records[2].platform" }]],
  );
  assert.deepEqual(
    recordMismatch.data.page.records.map(({ stream }) => stream),
    ["trades", "pulls"],
  );
});

test("nullable event time and money remain null while ordering uses collection time", () => {
  const transfer = parseProviderStreamRecordV2({
    ...sanitizedProviderStreamV2Records.collectorCryptTrade,
    occurred_at: null,
    event_type: "transfer",
    amount: null,
    currency: null,
  });

  assert.equal(transfer.occurred_at, null);
  assert.equal(transfer.stream === "trades" ? transfer.amount : undefined, null);
  assert.equal(transfer.stream === "trades" ? transfer.currency : undefined, null);
  assert.equal(
    providerStreamOrderingTimestampV2(transfer),
    transfer.collected_at,
  );
});

test("provider-agreed payment method metadata stays optional and distinct from currency", () => {
  const withPaymentMethod = parseProviderStreamRecordV2({
    ...sanitizedProviderStreamV2Records.collectorCryptTrade,
    payment_method: "card",
  });
  assert.equal(
    withPaymentMethod.stream === "trades"
      ? withPaymentMethod.payment_method
      : undefined,
    "card",
  );
  assert.equal(
    sanitizedProviderStreamV2Records.collectorCryptTrade.currency,
    "USDC",
  );
});

test("normalized continuation pages reject empty, missing, repeated, and cycled cursors", () => {
  const base = {
    requestedCursor: "cursor-a",
    hasMore: true,
    records: [sanitizedProviderStreamV2Records.courtyardPull],
  } as const;
  const context = {
    requestedPlatform: "courtyard",
    requestedCursor: "cursor-a",
    seenCursors: new Set(["cursor-a", "cursor-before"]),
  } as const;

  for (const [nextCursor, expectedCode] of [
    ["cursor-a", "cursor_not_advanced"],
    ["cursor-before", "cursor_cycle"],
  ] as const) {
    const result = safeValidateProviderStreamPageV2({
      rawPage: {},
      normalizedPage: { ...base, nextCursor },
      context,
    });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.issues[0]?.code, expectedCode);
  }

  const empty = safeValidateProviderStreamPageV2({
    rawPage: {},
    normalizedPage: { ...base, records: [], nextCursor: "cursor-b" },
    context,
  });
  assert.equal(empty.success, false);
  if (!empty.success) {
    assert.equal(empty.error.issues[0]?.code, "empty_continuing_page");
  }

  for (const nextCursor of [undefined, null, "", "x".repeat(2_049)]) {
    const result = safeValidateProviderStreamPageV2({
      rawPage: {},
      normalizedPage: { ...base, nextCursor },
      context,
    });
    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.error.issues[0]?.path, "nextCursor");
    }
  }
});

test("terminal pages advance after records but may retain an unchanged head cursor when empty", () => {
  const context = {
    requestedPlatform: "courtyard",
    requestedCursor: "cursor-current",
    seenCursors: new Set(["cursor-before", "cursor-current"]),
  } as const;

  for (const [nextCursor, expectedCode] of [
    ["cursor-current", "cursor_not_advanced"],
    ["cursor-before", "cursor_cycle"],
  ] as const) {
    const result = safeValidateProviderStreamPageV2({
      rawPage: {},
      normalizedPage: {
        requestedCursor: "cursor-current",
        nextCursor,
        hasMore: false,
        records: [sanitizedProviderStreamV2Records.courtyardPull],
      },
      context,
    });
    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.issues[0]?.code, expectedCode);
  }

  const noChanges = safeValidateProviderStreamPageV2({
    rawPage: {},
    normalizedPage: {
      requestedCursor: "cursor-current",
      nextCursor: "cursor-current",
      hasMore: false,
      records: [],
    },
    context,
  });
  assert.equal(noChanges.success, true);
});

test("unknown streams quarantine one mixed-page record without blocking valid records", () => {
  const result = safeValidateProviderStreamPageV2({
    rawPage: {},
    normalizedPage: {
      requestedCursor: null,
      nextCursor: "head-courtyard-002",
      hasMore: false,
      records: [
        sanitizedProviderStreamV2Records.courtyardPull,
        {
          ...sanitizedProviderStreamV2Records.courtyardPull,
          stream: "provider-new-stream",
        },
      ],
    },
    context: {
      requestedPlatform: "courtyard",
      requestedCursor: null,
    },
  });
  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.page.records.length, 1);
  assert.equal(result.data.invalidRecords.length, 1);
  assert.equal(result.data.invalidRecords[0]?.issues[0]?.path, "records[1].stream");
});

test("database-unsafe or oversized provider strings quarantine only their records", () => {
  const result = safeValidateProviderStreamPageV2({
    rawPage: {},
    normalizedPage: {
      requestedCursor: null,
      nextCursor: "head-courtyard-unsafe-strings",
      hasMore: false,
      records: [
        sanitizedProviderStreamV2Records.courtyardPull,
        {
          ...sanitizedProviderStreamV2Records.courtyardPull,
          record_id: "x".repeat(513),
        },
        {
          ...sanitizedProviderStreamV2Records.courtyardPull,
          record_id: "sanitized-null-payload",
          data: { note: "unsafe\u0000provider-value" },
        },
        {
          ...sanitizedProviderStreamV2Records.courtyardPull,
          record_id: "sanitized-surrogate-payload",
          data: { note: "unsafe\ud800provider-value" },
        },
        {
          ...sanitizedProviderStreamV2Records.courtyardPull,
          record_id: "invalid\udfffidentifier",
        },
        {
          ...sanitizedProviderStreamV2Records.courtyardPull,
          record_id: "valid-supplementary-character-😀",
          data: { note: "valid 😀 pair" },
        },
      ],
    },
    context: {
      requestedPlatform: "courtyard",
      requestedCursor: null,
    },
  });

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.page.records.length, 2);
  assert.equal(result.data.invalidRecords.length, 4);
  assert.deepEqual(
    result.data.invalidRecords.map(({ issues }) => issues[0]),
    [
      { code: "invalid_string", path: "records[1].record_id" },
      { code: "invalid_string", path: "records[2].data" },
      { code: "invalid_string", path: "records[3].data" },
      { code: "invalid_string", path: "records[4].record_id" },
    ],
  );
});

test("excessively deep opaque data quarantines one record without overflowing the page", () => {
  let nested: Record<string, unknown> = { value: "leaf" };
  for (let depth = 0; depth < 2_000; depth += 1) nested = { child: nested };

  const result = safeValidateProviderStreamPageV2({
    rawPage: {},
    normalizedPage: {
      requestedCursor: null,
      nextCursor: "head-courtyard-deep-record",
      hasMore: false,
      records: [
        sanitizedProviderStreamV2Records.courtyardPull,
        {
          ...sanitizedProviderStreamV2Records.courtyardPull,
          record_id: "sanitized-deep-payload",
          data: nested,
        },
      ],
    },
    context: {
      requestedPlatform: "courtyard",
      requestedCursor: null,
    },
  });

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.page.records.length, 1);
  assert.deepEqual(result.data.invalidRecords[0]?.issues, [
    { code: "invalid_json", path: "records[1].data" },
  ]);
});

test("sanitized fixtures preserve sensitive field structure without real identity values", () => {
  const valuesForSensitiveKeys: string[] = [];
  const visit = (value: unknown, key = ""): void => {
    if (typeof value === "string") {
      if (/user|owner|wallet|transaction|tx_hash/i.test(key)) {
        valuesForSensitiveKeys.push(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, key));
      return;
    }
    if (typeof value === "object" && value !== null) {
      Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
    }
  };
  visit(sanitizedProviderStreamV2Records);

  assert.ok(valuesForSensitiveKeys.length > 0);
  assert.ok(
    valuesForSensitiveKeys.every(
      (value) => value.includes("sanitized") || value.startsWith("https://"),
    ),
  );
  assert.doesNotMatch(
    JSON.stringify(sanitizedProviderStreamV2Records),
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
  );
});
