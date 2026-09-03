import assert from "node:assert/strict";
import { test } from "node:test";
import { tsImport } from "tsx/esm/api";
const { probeCollectorHandoff } = await tsImport("./collector-crypt-checkpoint-handoff-canary.mts", import.meta.url);

function page(count = 1000) {
  return { records: Array.from({ length: count }, (_, i) => ({ platform: "collector_crypt",
    stream: "pulls", record_id: `pull-${i}`, pack_id: "pack-fixture", card_id: "card-fixture",
    occurred_at: "2026-08-30T00:00:00.000Z", collected_at: "2026-08-30T00:00:00.000Z",
    data: {} })), next_cursor: "fixture-next", poll_after_seconds: 0 };
}
const input = { token: "fixture-only-token", opaqueCursor: "fixture-only-saved-cursor",
  previousConfigId: "11111111-1111-4111-8111-111111111111", nextConfigId: "22222222-2222-4222-8222-222222222222" };
function capture(body, status = 200, responseBytes = body.length) {
  return async (request) => {
    assert.equal(request.url.searchParams.get("limit"), "1000");
    assert.equal(request.url.searchParams.get("cursor"), input.opaqueCursor);
    assert.equal(request.url.searchParams.get("platform"), "collector_crypt");
    assert.equal(request.maximumResponseBytes, 8 * 1024 * 1024);
    return { status, protectedBody: body, responseBytes, durationMilliseconds: 10 };
  };
}
test("Collector canary validates saved-cursor 1000-record page without returning protected values", async () => {
  const bytes = Buffer.from(JSON.stringify(page()));
  const result = await probeCollectorHandoff({ ...input, captureResponse: capture(bytes) });
  assert.equal(result.recordCount, 1000);
  assert.equal(result.responseStatus, 200);
  assert.equal(JSON.stringify(result).includes(input.token), false);
  assert.equal(JSON.stringify(result).includes(input.opaqueCursor), false);
  assert.equal(bytes.every((byte) => byte === 0), true);
});
test("Collector canary refuses non-200 even when response looks valid", async () => {
  const bytes = Buffer.from(JSON.stringify(page()));
  await assert.rejects(probeCollectorHandoff({ ...input, captureResponse: capture(bytes, 503) }));
  assert.equal(bytes.every((byte) => byte === 0), true);
});
test("Collector canary rejects oversize, changed provider, wrong count, head and malformed JSON", async () => {
  const wrongProvider = page(); wrongProvider.records[0].platform = "courtyard";
  const head = page(); head.next_cursor = null; head.poll_after_seconds = 60;
  for (const [value, responseBytes] of [[page(1001)], [page(999)], [wrongProvider], [head],
    [page(), 8 * 1024 * 1024 + 1], ["not-json"]]) {
    const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
    await assert.rejects(probeCollectorHandoff({ ...input, captureResponse: capture(bytes, 200, responseBytes) }));
    assert.equal(bytes.every((byte) => byte === 0), true);
  }
});
