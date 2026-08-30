import assert from "node:assert/strict";
import { test } from "node:test";
import { dataforrestCourtyardDistributedSourceAdapterManifest as manifest,
  dataforrestLaunchDistributedSourceAdapterManifest } from "@packscout/contracts";
import { DataforrestEventsSourceAdapter } from "./dataforrest-events-source-adapter.ts";
import { isCompletedNormalizedProviderObservationPage } from "./source-adapter-completed-page-capability.ts";
import { isTrustedProtectedNativeEvidence } from "./trusted-protected-native-evidence.ts";

const rawMarker = "protected-native-owner-must-not-escape";
const cursorMarker = "protected-returned-cursor-must-not-escape";
const card = (index: number) => ({
  stream: "catalog", entity: "card", platform: "courtyard", record_id: `card-${index}`,
  occurred_at: "2026-08-30T00:00:00Z", collected_at: "2026-08-30T00:00:01Z",
  first_seen_at: "2026-08-30T00:00:00Z", available: true,
  data: { asset: { title: "Reviewed card", owner: rawMarker },
    prices: { priceHistory: [{ sales: Array.from({ length: index === 22 ? 5886 : index === 58 ? 5019 : 0 }, () => null) }] } },
});
const bytes = (count: number) => new TextEncoder().encode(JSON.stringify({
  records: Array.from({ length: count }, (_, index) => card(index)),
  next_cursor: cursorMarker, poll_after_seconds: 0,
}));
const input = (body: Uint8Array) => ({ provider: "courtyard" as const,
  sourceTypeKey: manifest.sourceTypeKey, adapterVersion: manifest.adapterVersion,
  pageLimit: 100, protectedRawResponse: body });

test("raw inspection shares native parsing without transport, durable capabilities, raw evidence or cursor output", () => {
  let transportCalls = 0;
  const adapter = new DataforrestEventsSourceAdapter({
    resolveHost: async () => { transportCalls += 1; throw new Error("transport forbidden"); },
    httpClient: async () => { transportCalls += 1; throw new Error("transport forbidden"); },
  }, manifest);
  const body = bytes(100); const before = body.slice();
  const inspected = adapter.inspectRawResponse(input(body));
  assert.equal(inspected.kind, "untrusted_inspection");
  assert.equal(inspected.ok, true);
  if (!inspected.ok) assert.fail("expected inspection");
  assert.equal(inspected.recordCount, 100);
  assert.equal(inspected.outcomes.every((outcome) => outcome.status === "valid"), true);
  assert.deepEqual(inspected.continuation, { kind: "continue" });
  assert.equal(isCompletedNormalizedProviderObservationPage(inspected), false);
  assert.equal(isTrustedProtectedNativeEvidence(inspected), false);
  for (const key of ["protectedNativeEvidence", "normalizedPage", "nextCursor", "captureVersion", "requestLease"]) {
    assert.equal(Object.hasOwn(inspected, key), false);
  }
  assert.equal(JSON.stringify(inspected).includes(rawMarker), false);
  assert.equal(JSON.stringify(inspected).includes(cursorMarker), false);
  assert.equal(transportCalls, 0);
  assert.deepEqual(body, before);
});

test("raw inspection rejects crossed adapter/provider pins and unsafe page limits before parsing", () => {
  const adapter = new DataforrestEventsSourceAdapter({}, manifest);
  for (const change of [
    { adapterVersion: dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion },
    { adapterVersion: "unknown-adapter" }, { sourceTypeKey: "unknown-source" },
    { provider: "phygitals" as const }, { pageLimit: 101 }, { pageLimit: 0 },
    { pageLimit: 1.5 }, { pageLimit: Number.NaN },
  ]) {
    const inspected = adapter.inspectRawResponse({ ...input(bytes(1)), ...change });
    assert.equal(inspected.ok, false);
    assert.equal(inspected.kind, "untrusted_inspection");
    assert.equal(Object.hasOwn(inspected, "outcomes"), false);
  }
});

test("raw inspection keeps exact page, byte and native-array bounds with sanitized failures", () => {
  const adapter = new DataforrestEventsSourceAdapter({}, manifest);
  const nativeArray = (count: number) => new TextEncoder().encode(JSON.stringify({
    records: [{ ...card(0), data: { asset: { title: "Card" }, native: Array(count).fill(null) } }],
    next_cursor: cursorMarker, poll_after_seconds: 0,
  }));
  const valid = nativeArray(24005);
  const invalid = [bytes(101), nativeArray(480001), new Uint8Array(8_388_609),
    new TextEncoder().encode(`{"${rawMarker}":`), new Uint8Array([0xc3, 0x28])];
  assert.equal(adapter.inspectRawResponse(input(valid)).ok, true);
  for (const body of invalid) {
    const inspected = adapter.inspectRawResponse(input(body));
    assert.equal(inspected.ok, false);
    assert.equal(Object.hasOwn(inspected, "outcomes"), false);
    assert.equal(JSON.stringify(inspected).includes(rawMarker), false);
    assert.equal(JSON.stringify(inspected).includes(cursorMarker), false);
  }
});

test("raw inspection accepts exactly 8 MiB but never increases the immutable manifest cap", () => {
  const adapter = new DataforrestEventsSourceAdapter({}, manifest);
  const page = { records: [{ ...card(0), data: { asset: { title: "Card" }, padding: "" } }],
    next_cursor: cursorMarker, poll_after_seconds: 0 };
  page.records[0]!.data.padding = "x".repeat(8_388_608 - Buffer.byteLength(JSON.stringify(page)));
  const body = new TextEncoder().encode(JSON.stringify(page));
  assert.equal(body.byteLength, 8_388_608);
  assert.equal(adapter.inspectRawResponse(input(body)).ok, true);
  const oversized = new Uint8Array(body.byteLength + 1);
  oversized.set(body); oversized[body.byteLength] = 0x20;
  assert.equal(adapter.inspectRawResponse(input(oversized)).ok, false);
});
