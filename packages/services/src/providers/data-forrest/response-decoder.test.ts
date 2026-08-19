import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderHttpResponseDecoderInputV2 } from "../../provider-adapter.ts";
import {
  DATA_FORREST_PLATFORM_KEYS,
  DataForrestHttpCursorAdapter,
  DataForrestResponseDecoderV2,
  createDataForrestProviderTransportRegistry,
} from "./response-decoder.ts";

const endpoint = "https://provider.example.test/v1/events";
const occurredAt = "2026-08-19T12:00:00Z";

const catalogRecord = Object.freeze({
  stream: "catalog",
  platform: "courtyard",
  record_id: "sanitized-pack",
  entity: "pack",
  first_seen_at: occurredAt,
  occurred_at: occurredAt,
  collected_at: occurredAt,
  available: true,
  data: {},
});

const tradeRecord = Object.freeze({
  stream: "trades",
  platform: "courtyard",
  record_id: "sanitized-trade",
  card_id: "sanitized-card",
  event_type: "sale",
  amount: 12.5,
  currency: "USDC",
  payment_method: null,
  tx_hash: "sanitized-transaction",
  occurred_at: occurredAt,
  collected_at: occurredAt,
  data: {},
});

function decoderInput(
  body: unknown,
  contentType = "application/json; charset=utf-8",
): ProviderHttpResponseDecoderInputV2 {
  return {
    bodyText: typeof body === "string" ? body : JSON.stringify(body),
    contentType,
    headers: {},
    requestedPlatform: "courtyard",
    requestedCursor: null,
  };
}

function wrapper(overrides: Record<string, unknown> = {}) {
  return {
    records: [catalogRecord, tradeRecord],
    next_cursor: "sanitized-cursor",
    poll_after_seconds: 0,
    ...overrides,
  };
}

test("the documented wrapper maps polling hints onto the normalized cursor page", () => {
  const decoder = new DataForrestResponseDecoderV2();
  const continuing = decoder.decode(decoderInput(wrapper()));
  assert.equal(continuing.ok, true);
  if (!continuing.ok) return;
  assert.equal(continuing.page.hasMore, true);
  assert.equal(continuing.page.nextCursor, "sanitized-cursor");
  assert.deepEqual(continuing.page.records, [catalogRecord, tradeRecord]);
  assert.deepEqual(continuing.page.rawPage, {
    encoding: "data-forrest-page-manifest-v1",
    bodySha256:
      "4b517019746e313a3eb10faf4cbcdac2eb825bb6aa15b268a945bcff4dc4e630",
    recordCount: 2,
    nextCursor: "sanitized-cursor",
    pollAfterSeconds: 0,
  });
  assert.equal(JSON.stringify(continuing.page.rawPage).includes("records"), false);

  const caughtUp = decoder.decode(
    decoderInput(wrapper({ records: [], poll_after_seconds: 60 })),
  );
  assert.equal(caughtUp.ok, true);
  if (caughtUp.ok) assert.equal(caughtUp.page.hasMore, false);
});

test("the live boundary rejects wrapper drift and missing normalized extensions", () => {
  const decoder = new DataForrestResponseDecoderV2();
  const cases = [
    {
      input: decoderInput("not-json"),
      expected: { ok: false, code: "invalid_json" },
    },
    {
      input: decoderInput(wrapper(), "text/plain"),
      expectedCode: "unexpected_content_type",
    },
    {
      input: decoderInput(wrapper({ unexpected: true })),
      expectedCode: "invalid_wrapper_shape",
    },
    {
      input: decoderInput(wrapper({ poll_after_seconds: -1 })),
      expectedCode: "poll_after_seconds_invalid",
    },
    {
      input: decoderInput(wrapper({ records: Array(5_001).fill(null) })),
      expectedCode: "record_count_exceeded",
    },
    {
      input: decoderInput(
        wrapper({ records: [{ ...catalogRecord, available: "yes" }] }),
      ),
      expectedCode: "invalid_pack_availability",
    },
    {
      input: decoderInput(
        wrapper({ records: [{ ...catalogRecord, available: null }] }),
      ),
      expectedCode: "invalid_pack_availability",
    },
    {
      input: decoderInput(
        wrapper({
          records: [{
            ...catalogRecord,
            entity: "card",
            available: false,
          }],
        }),
      ),
      expectedCode: "invalid_card_availability",
    },
    {
      input: decoderInput(
        wrapper({
          records: [
            Object.fromEntries(
              Object.entries(tradeRecord).filter(
                ([key]) => key !== "payment_method",
              ),
            ),
          ],
        }),
      ),
      expectedCode: "missing_trade_payment_method",
    },
  ] as const;

  for (const fixture of cases) {
    const result = decoder.decode(fixture.input);
    assert.equal(result.ok, false);
    if (!result.ok && "expectedCode" in fixture) {
      assert.deepEqual(result.issueCodes, [fixture.expectedCode]);
    }
  }
});

test("the registered adapter is limited to mapped live platforms and sends bearer cursor requests", async () => {
  const requests: URL[] = [];
  const adapter = new DataForrestHttpCursorAdapter({
    resolveHost: async () => ["8.8.8.8"],
    httpClient: async (input, init) => {
      const requestUrl = new URL(String(input));
      requests.push(requestUrl);
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer sanitized-secret",
      );
      return new Response(JSON.stringify(wrapper()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  for (const platform of DATA_FORREST_PLATFORM_KEYS) {
    assert.equal(adapter.supportsPlatform(platform), true);
  }
  assert.equal(adapter.supportsPlatform("gamestop"), false);

  const page = await adapter.fetchPage({
    endpoint,
    allowedHosts: ["provider.example.test"],
    platform: "courtyard",
    cursor: "opaque-cursor",
    auth: { mode: "bearer", token: "sanitized-secret" },
  });
  assert.equal(page.page.records.length, 2);
  assert.equal(requests[0]?.searchParams.get("platform"), "courtyard");
  assert.equal(requests[0]?.searchParams.get("cursor"), "opaque-cursor");
  assert.deepEqual(
    createDataForrestProviderTransportRegistry({
      resolveHost: async () => ["8.8.8.8"],
    }).keys(),
    ["http-cursor-v2"],
  );
});
