import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
const { probeCourtyardHandoff, isReviewedCourtyardMissingNameRejection, ProviderCaptureSourceError } =
  await tsImport("./courtyard-checkpoint-handoff-canary.mts", import.meta.url);
const { emptyNormalizedProviderFacts } = await tsImport("@packscout/contracts", import.meta.url);
const { validateCourtyardCanaryBinding } = await tsImport("./courtyard-checkpoint-handoff-central.mts", import.meta.url);
const { courtyardHandoff: pins } = await tsImport("./courtyard-checkpoint-handoff-plan.mts", import.meta.url);
const providerId = "1ec7bb50-a263-4b17-82b5-c56fdfb93d1c";
const nextConfigId = "1a20a665-5c89-471e-bc17-315fb70698c3";
const token = "private-token-fixture"; const cursor = "private-saved-cursor-fixture";
const card = (index) => ({ stream: "catalog", entity: "card", platform: "courtyard", record_id: `native-card-${index}`,
  occurred_at: "2026-08-30T00:00:00Z", collected_at: "2026-08-30T00:00:01Z", first_seen_at: "2026-08-30T00:00:00Z", available: true,
  data: { [index % 2 ? "reveal" : "asset"]: { title: "Reviewed native card", owner: "private-native-owner" },
    prices: { priceHistory: [{ sales: Array(index === 22 ? 5886 : index === 58 ? 5019 : 0).fill(null) }] } } });
function capture({ status = 200, count = 100, mutate = () => {}, next = "private-returned-cursor", bytes } = {}) {
  const page = { records: Array.from({ length: count }, (_, i) => card(i)), next_cursor: next, poll_after_seconds: next ? 0 : 60 };
  mutate(page); const body = bytes ?? new TextEncoder().encode(JSON.stringify(page));
  return { body, request: async (request) => {
    assert.equal(request.url.searchParams.get("cursor"), cursor); assert.equal(request.url.searchParams.get("limit"), "100");
    assert.equal(request.url.searchParams.get("platform"), "courtyard"); assert.equal(request.timeoutMilliseconds, 10000);
    assert.equal(request.maximumResponseBytes, 8388608); assert.equal(request.headers.Authorization, `Bearer ${token}`);
    return { status, protectedBody: body, responseBytes: body.length, durationMilliseconds: 12 };
  } };
}
const run = (c) => probeCourtyardHandoff({ token, opaqueCursor: cursor, providerId, nextConfigId, captureResponse: c.request });
test("Courtyard saved-cursor canary uses actual native parser+mapper+collectible validator and erases response", async () => {
  const c = capture(); const proof = await run(c);
  assert.equal(proof.recordCount, 100); assert.equal(proof.collectibleValidated, 100);
  assert.equal(proof.adapterInvalid, 0); assert.equal(proof.mapperQuarantined, 0);
  assert.equal(proof.savedCursorHash, pins.cursorHash); assert.equal(proof.adapterKey, pins.nextAdapter);
  for (const secret of [token, cursor, "private-native-owner", "private-returned-cursor", "Reviewed native card"]) assert.equal(JSON.stringify(proof).includes(secret), false);
  assert.equal(c.body.every((byte) => byte === 0), true);
});
test("Courtyard admits only the reviewed80valid+20wrapper-absent canonical missing-name class", async () => {
  const c = capture({ mutate: (p) => { for (let i = 80; i < 100; i++) p.records[i].data = { ignored_owner: "private-native-owner" }; } });
  const proof = await run(c);
  assert.equal(proof.collectibleValidated, 80);
  assert.equal(proof.canonicalMissingDisplayNameRejected, 20);
  assert.equal(proof.canonicalQuarantineClass, "missing_display_name");
  assert.equal(proof.mapperQuarantined, 0); assert.equal(proof.adapterInvalid, 0);
  assert.equal(c.body.every((byte) => byte === 0), true);
  assert.equal(JSON.stringify(proof).includes("private-native-owner"), false);
});
test("Courtyard missing-name allowance rejects21, all100, empty/null/malformed selected wrappers or titles", async () => {
  for (const options of [
    ...[21, 100].map((count) => ({ mutate: (p) => { for (let i = 100 - count; i < 100; i++) p.records[i].data = {}; } })),
    ...[{ asset: {} }, { asset: null }, { asset: { title: null } }, { reveal: { title: null } },
      { asset: { title: "" } }, { reveal: { title: 123 } }].map((data) => ({ mutate: (p) => { p.records[0].data = data; } })),
  ]) { const c = capture(options); await assert.rejects(run(c)); assert.equal(c.body.every((byte) => byte === 0), true); }
});
test("Courtyard canonical exception cannot absorb name-present malformed drafts or unrelated errors/facts", () => {
  const facts = emptyNormalizedProviderFacts("card");
  const input = { error: new ProviderCaptureSourceError("PROVIDER_CAPTURE_RECORD_INVALID"), nativeData: {},
    normalizedFacts: facts, candidateDisplayName: null };
  assert.equal(isReviewedCourtyardMissingNameRejection(input), true);
  for (const change of [{ error: new Error("PROVIDER_CAPTURE_RECORD_INVALID") },
    { error: new ProviderCaptureSourceError("PROVIDER_CAPTURE_CONFIGURATION_INVALID") },
    { error: { code: "PROVIDER_CAPTURE_RECORD_INVALID" } }, { candidateDisplayName: "Valid name; different draft error" },
    { candidateDisplayName: "" }, { candidateDisplayName: undefined }, { nativeData: { asset: undefined } },
    { nativeData: { reveal: null } }, { normalizedFacts: { ...facts, displayName: { state: "malformed" } } },
    { normalizedFacts: { ...facts, displayName: { state: "present", value: "" } } },
    { normalizedFacts: { ...facts, imageReferences: { state: "malformed" } } },
    { normalizedFacts: { ...facts, estimatedValue: { state: "present", value: { amount: -1, currency: "USD" } } } }]) {
    assert.equal(isReviewedCourtyardMissingNameRejection({ ...input, ...change }), false);
  }
});
test("Courtyard parser/mapping/status/size/head failures never attest admission and erase captured bytes", async () => {
  for (const options of [{ status: 503 }, { count: 101 }, { count: 99 }, { next: null },
    { mutate: (p) => { p.records[0].platform = "phygitals"; } },
    { mutate: (p) => { p.records[0].data = { asset: { owner: "private-owner" } }; } },
    { mutate: (p) => { p.records[0].data.native = Array(480001).fill(null); } }, { bytes: new Uint8Array(8388609) }]) {
    const c = capture(options); await assert.rejects(run(c), /COURTYARD_CANARY_ADMISSION_FAILED/u);
    assert.equal(c.body.every((byte) => byte === 0), true);
  }
  await assert.rejects(probeCourtyardHandoff({ token, opaqueCursor: cursor, providerId, nextConfigId,
    captureResponse: async () => { throw new Error(`${token}/${cursor}`); } }), /COURTYARD_CANARY_TRANSPORT_FAILED/u);
});
test("Courtyard activation proof binds exact adapter/provider/config/cursor and finite fresh bounded measurements", async () => {
  const proof = await run(capture()); const input = { proof, providerId, nextConfigId, opaqueValueHash: proof.opaqueValueHash,
    fresh: true, now: Date.parse(proof.checkedAt) + 1 };
  assert.deepEqual(validateCourtyardCanaryBinding(input), proof);
  for (const change of [{ providerId: nextConfigId }, { nextConfigId: providerId }, { opaqueValueHash: "b".repeat(64) },
    { adapterKey: pins.previousAdapter }, { savedCursorHash: "a".repeat(64) }, { status: 503 }, { recordCount: 99 },
    { adapterInvalid: 1 }, { mapperQuarantined: 1 }, { collectibleValidated: 0 }, { canonicalMissingDisplayNameRejected: 1 },
    { canonicalMissingDisplayNameRejected: 21 }, { canonicalQuarantineClass: "mapper_error" }, { responseBytes: 0 }, { responseBytes: 8388609 },
    { responseBytes: 1.5 }, { durationMilliseconds: -1 }, { durationMilliseconds: NaN }, { checkedAt: "invalid" },
    { checkedAt: "2020-01-01T00:00:00.000Z" }, { checkedAt: "2100-01-01T00:00:00.000Z" }]) {
    assert.throws(() => validateCourtyardCanaryBinding({ ...input, proof: { ...proof, ...change } }));
  }
  assert.doesNotThrow(() => validateCourtyardCanaryBinding({ ...input, fresh: false, now: Date.parse(proof.checkedAt) + 999999 }));
});
