import assert from "node:assert/strict";
import { test } from "node:test";
import { sanitizedProviderStreamV2Records } from "./__fixtures__/provider-stream-v2/records.ts";
import {
  parseProviderStreamRecordV2,
  providerStreamOrderingTimestampV2,
  safeValidateProviderStreamPageV2,
} from "./provider-stream-contract-v2.ts";

test("real-example record fixtures preserve V2 envelopes without inventing a page wrapper", () => {
  const records = Object.values(sanitizedProviderStreamV2Records).map((record) =>
    parseProviderStreamRecordV2(record),
  );

  assert.deepEqual(
    records.map(({ stream }) => stream),
    ["pulls", "trades", "catalog", "catalog"],
  );
  assert.equal(records[2]?.occurred_at, null);
  assert.equal(records[3]?.occurred_at, null);
  assert.equal("next_cursor" in sanitizedProviderStreamV2Records, false);
});

test("required outer relationship identities fail at stable record paths", () => {
  const invalidPull = structuredClone(sanitizedProviderStreamV2Records.pull) as {
    card_id?: string;
  };
  delete invalidPull.card_id;

  const result = safeValidateProviderStreamPageV2({
    rawPage: { providerWrapper: "observed-only-by-adapter" },
    normalizedPage: {
      stream: "pulls",
      requestedCursor: null,
      nextCursor: null,
      hasMore: false,
      records: [sanitizedProviderStreamV2Records.pull, invalidPull],
    },
    context: {
      requestedStream: "pulls",
      requestedPlatform: "courtyard",
      requestedCursor: null,
    },
  });

  assert.equal(result.success, true);
  if (!result.success) return;
  assert.equal(result.data.page.records.length, 1);
  assert.deepEqual(result.data.invalidRecords[0]?.issues, [
    { code: "invalid_type", path: "records[1].card_id" },
  ]);
  assert.deepEqual(result.data.rawPage, {
    providerWrapper: "observed-only-by-adapter",
  });
});

test("requested stream and platform bind every normalized page and record", () => {
  const pageMismatch = safeValidateProviderStreamPageV2({
    rawPage: {},
    normalizedPage: {
      stream: "catalog",
      requestedCursor: null,
      nextCursor: null,
      hasMore: false,
      records: [],
    },
    context: {
      requestedStream: "trades",
      requestedPlatform: "collector_crypt",
      requestedCursor: null,
    },
  });
  assert.equal(pageMismatch.success, false);
  if (!pageMismatch.success) {
    assert.deepEqual(pageMismatch.error.issues, [
      { code: "stream_mismatch", path: "stream" },
    ]);
  }

  const recordMismatch = safeValidateProviderStreamPageV2({
    rawPage: {},
    normalizedPage: {
      stream: "trades",
      requestedCursor: null,
      nextCursor: null,
      hasMore: false,
      records: [
        sanitizedProviderStreamV2Records.trade,
        sanitizedProviderStreamV2Records.pull,
        {
          ...sanitizedProviderStreamV2Records.trade,
          platform: "courtyard",
        },
      ],
    },
    context: {
      requestedStream: "trades",
      requestedPlatform: "collector_crypt",
      requestedCursor: null,
    },
  });
  assert.equal(recordMismatch.success, true);
  if (!recordMismatch.success) return;
  assert.deepEqual(
    recordMismatch.data.invalidRecords.map(({ issues }) => issues),
    [
      [
        { code: "stream_mismatch", path: "records[1].stream" },
        { code: "platform_mismatch", path: "records[1].platform" },
      ],
      [{ code: "platform_mismatch", path: "records[2].platform" }],
    ],
  );
});

test("nullable event time and money remain null while ordering uses collection time", () => {
  const transfer = parseProviderStreamRecordV2({
    ...sanitizedProviderStreamV2Records.trade,
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

test("normalized continuation pages reject empty, missing, repeated, and cycled cursors", () => {
  const base = {
    stream: "pulls",
    requestedCursor: "cursor-a",
    hasMore: true,
    records: [sanitizedProviderStreamV2Records.pull],
  } as const;
  const context = {
    requestedStream: "pulls",
    requestedPlatform: "courtyard",
    requestedCursor: "cursor-a",
    seenCursors: new Set(["cursor-a", "cursor-before"]),
  } as const;

  for (const [nextCursor, expectedCode] of [
    [null, "missing_continuation_cursor"],
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
