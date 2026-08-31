/// <reference types="vite/client" />
import { canonicalJson, DATA_RELEASE_V3_RETAINED_EV_WITNESS_HASH_DOMAIN,
  dataReleaseV3RetainedEvWitnessSchema, packScoutPublicEvV3Schema,
  PRODUCTION_DATA_RELEASE_V3_PATHS, sha256CanonicalJson } from "@packscout/contracts";
import { convexTest } from "convex-test";
import { afterEach, expect, test, vi } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { buildV3CurrentEv, buildV3Detail, v3Body, V3_OBSERVED_AT, V3_REPACK_ID_B } from "./dataReleaseV3Fixture.test-support";
import { activateRetentionRelease, stageRetentionRelease, unavailableRetentionDetail } from "./dataReleaseV3Retention.test-support";
import { signedProviderInit, verifyProviderResponseSignature } from "./providerReleaseSecurity.test-support";

const modules = import.meta.glob("./**/*.ts");
const keyId = "witness-publisher.v1";
const secret = "witness-publisher-auth-secret-0000000000000001";
const otherKey = "witness-other.v1";
const otherSecret = "witness-other-auth-secret-0000000000000000001";
const path = PRODUCTION_DATA_RELEASE_V3_PATHS.retainedEvWitness;
let nonceSequence = 0;
const nonce = () => `witnessnonce${String(++nonceSequence).padStart(16, "0")}`;
afterEach(() => vi.unstubAllEnvs());

async function fixture() {
  const t = convexTest({ schema, modules, transactionLimits: true });
  const original = buildV3Detail();
  const first = await stageRetentionRelease(t, 1, [original]);
  await activateRetentionRelease(t, first, null);
  const failed = unavailableRetentionDetail({ price: {
    displayMoney: { minorUnits: 20_000, currency: "USD" },
    usdComparison: { status: "available", value: { minorUnits: 20_000, currency: "USD" } },
  } });
  failed.evEstimates.packScout = packScoutPublicEvV3Schema.parse({ ...failed.evEstimates.packScout,
    calculatedAt: new Date(Date.parse(V3_OBSERVED_AT) + 120_000).toISOString() });
  const second = await stageRetentionRelease(t, 2, [failed]);
  await activateRetentionRelease(t, second, 1);
  const scope = { vendorKey: original.vendorKey, publicVendorId: original.publicVendorId,
    publicRepackId: original.publicRepackId };
  const request = { schemaVersion: "data_release_v3", operationId: "witness-read",
    expectedActivePublicReleaseId: second.publicReleaseId,
    expectedActiveReleaseFingerprint: second.releaseFingerprint, expectedGeneration: 2, scopes: [scope] };
  const read = async (body: unknown = request) => t.mutation(internal.dataReleaseV3Read.retainedEvWitness, await v3Body(body));
  return { t, read, request, first, second, original, failed };
}

function configure() {
  vi.stubEnv("PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS", canonicalJson({ [keyId]: btoa(secret), [otherKey]: btoa(otherSecret) }));
  vi.stubEnv("PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_IDS", canonicalJson([keyId]));
}

test("signed witness proves original source economics and latest failure independently, without changing stored release bytes", async () => {
  configure();
  const { t, request, first, original, failed } = await fixture();
  const before = await t.run(async (ctx) => ({ repacks: await ctx.db.query("dataReleaseV3Repacks").collect(),
    retained: await ctx.db.query("dataReleaseV3RetainedEv").collect(),
    operations: await ctx.db.query("dataReleaseV3Operations").collect() }));
  const response = await t.fetch(path, await signedProviderInit(path, request, { keyId, secret, nonce: nonce() }));
  expect(response.status).toBe(200);
  const envelope = await response.json();
  expect(await verifyProviderResponseSignature(envelope, secret)).toBe(true);
  const witness = dataReleaseV3RetainedEvWitnessSchema.parse(envelope.receipt.details);
  expect(witness.entries[0]).toMatchObject({ activeFacts: { estimate: failed.evEstimates.packScout, calculationPriceUsdMinor: 20_000 },
    retained: { estimate: original.evEstimates.packScout, calculationPriceUsdMinor: 10_000,
      sourcePublicReleaseId: first.publicReleaseId, latestUnavailableAttempt: {
        calculatedAt: failed.evEstimates.packScout.calculatedAt, reason: "SOURCE_EVIDENCE_UNAVAILABLE" } } });
  const { witnessSha256, ...facts } = witness;
  expect(witnessSha256).toBe(await sha256CanonicalJson(DATA_RELEASE_V3_RETAINED_EV_WITNESS_HASH_DOMAIN, facts));
  const replay = await t.fetch(path, await signedProviderInit(path, request, { keyId, secret, nonce: nonce() }));
  expect((await replay.json()).receipt.details.witnessSha256).toBe(witnessSha256);
  const after = await t.run(async (ctx) => ({ repacks: await ctx.db.query("dataReleaseV3Repacks").collect(),
    retained: await ctx.db.query("dataReleaseV3RetainedEv").collect(),
    operations: await ctx.db.query("dataReleaseV3Operations").collect() }));
  expect(after).toEqual(before);
});

test("witness signed HTTP rejects missing, wrong-authority, cross-path and scope-tampered requests", async () => {
  configure();
  const { t, request } = await fixture();
  const absent = await t.fetch(path, { method: "POST", body: canonicalJson(request) });
  expect(absent.status).toBe(401);
  const wrong = await t.fetch(path, await signedProviderInit(path, request,
    { keyId: otherKey, secret: otherSecret, nonce: nonce() }));
  expect(wrong.status).toBe(401);
  const cross = await t.fetch(path, await signedProviderInit(PRODUCTION_DATA_RELEASE_V3_PATHS.status,
    request, { keyId, secret, nonce: nonce() }));
  expect(cross.status).toBe(401);
  const tampered = await signedProviderInit(path, request, { keyId, secret, nonce: nonce() });
  tampered.body = canonicalJson({ ...request, scopes: [{ ...request.scopes[0], publicRepackId: V3_REPACK_ID_B }] });
  const changed = await t.fetch(path, tampered);
  expect(changed.status).toBe(401);
  expect(await t.run(async (ctx) => (await ctx.db.query("dataReleaseAuthNonces").collect()).length)).toBe(0);
});

test("witness refuses unknown/cross-vendor scopes, generation/fingerprint races and duplicate or oversized scope requests", async () => {
  const { read, request } = await fixture();
  for (const patch of [{ expectedGeneration: 3 }, { expectedActiveReleaseFingerprint: "f".repeat(64) },
    { scopes: [{ ...request.scopes[0], publicRepackId: V3_REPACK_ID_B }] },
    { scopes: [{ ...request.scopes[0], vendorKey: "other_provider" }] }]) {
    await expect(read({ ...request, ...patch })).rejects.toThrow("PUBLICATION_STATE_CONFLICT");
  }
  for (const scopes of [[], [request.scopes[0], request.scopes[0]], Array.from({ length: 101 }, (_, index) =>
    ({ ...request.scopes[0], publicRepackId: `00000000-0000-5000-8000-${String(index).padStart(12, "0")}` }))]) {
    await expect(read({ ...request, scopes })).rejects.toThrow("PUBLICATION_REQUEST_INVALID");
  }
});

test("witness refuses a retained value whose original source fact was removed or changed", async () => {
  for (const change of ["delete", "price", "estimate"] as const) {
    const { t, read, first } = await fixture();
    await t.run(async (ctx) => {
      const source = await ctx.db.query("dataReleaseV3Releases").withIndex("by_public_release_id",
        (index) => index.eq("publicReleaseId", first.publicReleaseId)).unique();
      if (source === null) throw new Error("missing fixture source");
      const fact = await ctx.db.query("dataReleaseV3EvFacts").withIndex("by_release_id_and_public_repack_id",
        (index) => index.eq("releaseId", source._id)).unique();
      if (fact === null) throw new Error("missing fixture fact");
      if (change === "delete") await ctx.db.delete("dataReleaseV3EvFacts", fact._id);
      else await ctx.db.patch("dataReleaseV3EvFacts", fact._id, change === "price"
        ? { calculationPriceUsdMinor: 20_000 } : { estimate: buildV3CurrentEv(8_501) });
    });
    await expect(read()).rejects.toThrow("PUBLICATION_STATE_CONFLICT");
  }
});

test("retained witness can authenticate a source older than both active and previous releases", async () => {
  const { t, read, request, first, failed } = await fixture();
  const third = await stageRetentionRelease(t, 3, [failed]);
  await activateRetentionRelease(t, third, 2);
  const receipt = await read({ ...request, expectedGeneration: 3,
    expectedActivePublicReleaseId: third.publicReleaseId, expectedActiveReleaseFingerprint: third.releaseFingerprint });
  const witness = dataReleaseV3RetainedEvWitnessSchema.parse(receipt.details);
  expect(witness.entries[0]?.retained?.sourcePublicReleaseId).toBe(first.publicReleaseId);
});

test("signed readiness proves empty genesis before publication and never accepts empty real-witness scopes", async () => {
  configure();
  const t = convexTest({ schema, modules, transactionLimits: true });
  const request = { schemaVersion: "data_release_v3", operationId: "witness-ready", mode: "readiness",
    expectedGeneration: 0, expectedActivePublicReleaseId: null, expectedActiveReleaseFingerprint: null };
  const response = await t.fetch(path, await signedProviderInit(path, request, { keyId, secret, nonce: nonce() }));
  expect(response.status).toBe(200);
  const envelope = await response.json();
  expect(await verifyProviderResponseSignature(envelope, secret)).toBe(true);
  expect(envelope.receipt).toMatchObject({ operationKind: "retainedEvWitnessReadiness", result: "retained_ev_witness_ready",
    details: { generation: 0, activePublicReleaseId: null, activeReleaseFingerprint: null, retention: null } });
  for (const patch of [{ expectedGeneration: 1 }, { expectedActivePublicReleaseId: "10000000-0000-4000-8000-000000000001" },
    { scopes: [] }, { mode: "anything" }]) {
    await expect(t.mutation(internal.dataReleaseV3Read.retainedEvWitness, await v3Body({ ...request, ...patch }))).rejects.toThrow();
  }
  expect(await t.run(async (ctx) => ({ releases: await ctx.db.query("dataReleaseV3Releases").collect(),
    active: await ctx.db.query("activeDataReleaseV3State").collect(), operations: await ctx.db.query("dataReleaseV3Operations").collect() })))
    .toEqual({ releases: [], active: [], operations: [] });
});

test("readiness requires current generation, sealed active facts and coherent retained transition", async () => {
  const { t, read, request } = await fixture();
  const { scopes: _scopes, ...pins } = request;
  const readiness = { ...pins, mode: "readiness" };
  expect(await read(readiness)).toMatchObject({ result: "retained_ev_witness_ready", details: { generation: 2 } });
  await expect(read({ ...readiness, expectedGeneration: 1 })).rejects.toThrow("PUBLICATION_STATE_CONFLICT");
  await t.run(async (ctx) => {
    const pointer = await ctx.db.query("activeDataReleaseV3State").unique();
    if (pointer === null) throw new Error("missing fixture state");
    await ctx.db.patch("activeDataReleaseV3State", pointer._id, { retainedEvTransitionDirection: undefined });
  });
  await expect(read(readiness)).rejects.toThrow("PUBLICATION_STATE_CONFLICT");
});

test("witness refuses modified journal values or an unsealed active fact set", async () => {
  for (const target of ["journal", "active_facts"] as const) {
    const { t, read } = await fixture();
    await t.run(async (ctx) => {
      const pointer = await ctx.db.query("activeDataReleaseV3State").unique();
      if (pointer?.activeReleaseId === null || pointer?.activeReleaseId === undefined) throw new Error("missing fixture pointer");
      if (target === "active_facts") {
        const set = await ctx.db.query("dataReleaseV3EvFactSets").withIndex("by_release_id",
          (index) => index.eq("releaseId", pointer.activeReleaseId!)).unique();
        if (set === null) throw new Error("missing fixture set");
        await ctx.db.patch("dataReleaseV3EvFactSets", set._id, { factsSha256: "f".repeat(64) });
      } else {
        const change = await ctx.db.query("dataReleaseV3EvRetentionChanges").withIndex("by_transition_id",
          (index) => index.eq("transitionId", pointer.retainedEvTransitionId!)).unique();
        if (change === null || change.after === null) throw new Error("missing fixture change");
        await ctx.db.patch("dataReleaseV3EvRetentionChanges", change._id,
          { after: { ...change.after, latestUnavailableAttempt: null } });
      }
    });
    await expect(read()).rejects.toThrow("PUBLICATION_STATE_CONFLICT");
  }
});

test("witness rejects changed retained failure provenance and detects an intervening activation", async () => {
  const { t, read, request } = await fixture();
  const before = await read();
  await t.run(async (ctx) => {
    const value = await ctx.db.query("dataReleaseV3RetainedEv").unique();
    if (value === null) throw new Error("missing fixture retention");
    await ctx.db.patch("dataReleaseV3RetainedEv", value._id, { value: { ...value.value, latestUnavailableAttempt: null } });
  });
  await expect(read()).rejects.toThrow("PUBLICATION_STATE_CONFLICT");
  expect(before.details).toMatchObject({ generation: request.expectedGeneration });
  const next = await stageRetentionRelease(t, 3, [buildV3Detail()]);
  await activateRetentionRelease(t, next, 2);
  await expect(read()).rejects.toThrow("PUBLICATION_STATE_CONFLICT");
});
