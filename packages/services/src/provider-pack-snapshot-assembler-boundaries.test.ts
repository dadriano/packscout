import assert from "node:assert/strict";
import { test } from "node:test";
import { PACK_SNAPSHOT_HASH_DOMAIN, hashPackCatalogValue, packCatalogCanonicalByteCount,
  type ProviderPackBuildInputs } from "@packscout/contracts";
import { ProviderPackSnapshotAssembler, PackSnapshotAssemblyError, packSnapshotAssemblyLimits,
  type AssembleProviderPackSnapshotInput } from "./provider-pack-snapshot-assembler.ts";
import { assemblyFixture, requestFor, refreshEvInputs } from "./provider-pack-snapshot-assembler.test-support.ts";

const assembler = new ProviderPackSnapshotAssembler();
const reject = (input: unknown) => assert.rejects(assembler.assemble(input as AssembleProviderPackSnapshotInput), error => {
  assert.ok(error instanceof PackSnapshotAssemblyError);
  assert.equal(error.message, "PACK_SNAPSHOT_INPUT_INVALID");
  assert.equal(error.code, "PACK_SNAPSHOT_INPUT_INVALID");
  return true;
});

test("partial, inconsistent, stale and unpinned domain inputs fail closed", async suite => {
  const cases: Record<string, (input: ProviderPackBuildInputs) => void> = {
    "partial contents": input => { input.contentsComplete = false; },
    "invalid odds": input => { input.contents[0]!.probabilityMicros = 1; },
    "duplicate native identities": input => { input.contents[1]!.publicCollectibleId = input.contents[0]!.publicCollectibleId; },
    "missing provider profile": input => { input.providerProfileSnapshotId = null; },
    "missing collectible profile": input => { input.contents[0]!.collectibleProfileSnapshotId = null; },
    "duplicate profile identities": input => { input.contents[1]!.collectibleProfileSnapshotId = input.contents[0]!.collectibleProfileSnapshotId; },
    "missing EV": input => { input.ev = null; },
    "technical EV failure": input => { input.evFailure = "technical"; },
    "domain EV failure": input => { input.evFailure = "invalid_domain"; },
    "mismatched EV inputs": input => { input.evInputsSha256 = "f".repeat(64); },
    "expired EV": input => { input.ev!.validUntil = "2026-09-03T18:04:00.000Z"; },
    "future EV": input => { input.ev!.evaluatedAt = "2026-09-03T18:06:00.000Z"; },
    "future source": input => { input.dataAsOf = "2026-09-03T18:06:00.000Z"; },
    "future valuation": input => { if (input.contents[0]!.valuation.status === "available") input.contents[0]!.valuation.observedAt = "2026-09-03T18:06:00.000Z"; },
    "stale dependency": input => { input.expectedDependencies = [{ kind: "category", identity: input.category.publicCategoryId, contentSha256: "a".repeat(64) }]; },
    "action eligibility": input => { input.actions[0]!.enabled = false; input.actions[0]!.disabledReason = "PACK_UNAVAILABLE"; },
  };
  for (const [name, mutate] of Object.entries(cases)) await suite.test(name, async () => {
    const { input } = await assemblyFixture();
    mutate(input.inputs);
    await reject(await requestFor(input.inputs, true));
  });
});

test("request correlations, scope, lifecycle baseline and supplied projections cannot be forged", async suite => {
  for (const field of ["providerId", "publicRepackId", "desiredStateSha256", "contentsSha256", "probabilityInputsSha256", "valuationInputsSha256", "evInputsSha256"] as const) {
    await suite.test(field, async () => {
      const { input } = await assemblyFixture();
      input.request[field] = field.endsWith("Id") ? "00000000-0000-4000-8000-000000000001" : "f".repeat(64);
      await reject(input);
    });
  }
  const { input } = await assemblyFixture();
  for (const field of ["summaryProjection", "searchProjection", "topChase", "providerProfile", "detailProjection", "desiredCollectibleProjection"]) {
    await reject({ ...input, inputs: { ...input.inputs, [field]: { title: "forged" } } });
  }
  const { input: lifecycle } = await assemblyFixture("packAUpdate");
  await reject({ ...lifecycle, inputs: { ...lifecycle.inputs, lifecycleBaseline: null } });
  lifecycle.inputs.title = "Altered frozen display";
  await reject(await requestFor(lifecycle.inputs, true));
  const { input: forged } = await assemblyFixture("packAUpdate");
  forged.inputs.lifecycleBaseline!.identity.contentSha256 = "f".repeat(64);
  forged.inputs.lifecycleBaseline!.identity.publicPackSnapshotId = `pps_${"f".repeat(64)}`;
  await reject(await requestFor(forged.inputs));
  const { golden: other } = await assemblyFixture("packB");
  await reject({ ...input, existingSnapshot: other.snapshot });
  const { golden } = await assemblyFixture();
  golden.snapshot.payload.actions[0]!.url = "https://example.com/altered";
  await reject({ ...input, existingSnapshot: golden.snapshot });
  input.request.evidence.sourceRevisionIdentity = "wrong:revision";
  await reject(input);
});

test("protected data, mutable handles, oversized fields and unknown controls are rejected before output", async () => {
  const { input } = await assemblyFixture();
  for (const key of ["credential", "account", "connectionString", "databaseTarget", "rawSourceEvidence", "quarantineDetails", "exactInstance", "userData", "stackTrace"]) {
    for (const depth of [0, 1, 5, 15]) {
      let value: unknown = { [key]: "private-marker-do-not-echo" };
      for (let i = 0; i < depth; i += 1) value = { nested: value };
      await reject({ ...input, inputs: { ...input.inputs, privateValue: value } });
    }
  }
  for (const value of [new Date(), () => null, Symbol("handle"), BigInt(1), new Map(), Number.NaN, -0]) {
    await reject({ ...input, handle: value });
  }
  let calls = 0;
  const getter = Object.defineProperty({}, "inputs", { enumerable: true, get() { calls += 1; return input.inputs; } });
  await reject(getter); assert.equal(calls, 0);
  await reject(new Proxy(input, { getPrototypeOf() { calls += 1; return Object.prototype; } }));
  assert.equal(calls, 0);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  await reject({ ...input, cyclic });
  await reject({ ...input, batchSize: 1 });
  await reject({ ...input, inputs: { ...input.inputs, title: "x".repeat(201) } });
  await reject({ ...input, inputs: { ...input.inputs, title: "x".repeat(packSnapshotAssemblyLimits.maximumSnapshotBytes + 1) } });
  await reject({ ...input, inputs: { ...input.inputs, imageUrl: "https://example.com/?X-Amz-Signature=private-marker" } });
  await reject({ ...input, inputs: { ...input.inputs, title: "postgres://private-marker" } });
  await reject({ ...input, inputs: { ...input.inputs, contents: Array.from({ length: 8_001 }, () => input.inputs.contents[0]) } });
  input.inputs.aliases = Array.from({ length: 100 }, (_, index) => `${index}-${"a".repeat(100)}`);
  // P02 now blocks this capture; forge the request only to retain P03's independent refusal.
  await reject(await requestFor(input.inputs, true));
});

test("pure assembly uses neither live time nor network on success or rejection", async () => {
  const { input, golden } = await assemblyFixture();
  const originalFetch = globalThis.fetch, originalNow = Date.now;
  let calls = 0;
  globalThis.fetch = () => { calls += 1; throw new Error("network forbidden"); };
  Date.now = () => { calls += 1; throw new Error("clock forbidden"); };
  try {
    assert.deepEqual((await assembler.assemble(input)).snapshot, golden.snapshot);
    await reject({ ...input, inputs: { ...input.inputs, contentsComplete: false } });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; Date.now = originalNow; }
});

test("fixed greedy partition seals ordered count/UTF-8 byte proofs and the aggregate", async () => {
  const { input } = await assemblyFixture();
  input.inputs.title = "p"; input.inputs.aliases = [];
  input.inputs.contents = Array.from({ length: 400 }, (_, index) => ({
    ...structuredClone(input.inputs.contents[0]!), publicCollectibleId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    collectibleProfileSnapshotId: `ppfs_${index.toString(16).padStart(64, "0")}`, displayName: "é",
    imageUrl: `https://example.com/${"a".repeat(1950)}`, probabilityMicros: 2_500,
    valuation: { ...structuredClone(input.inputs.contents[0]!.valuation), valuationIdentity: index.toString(16).padStart(64, "0") },
  }));
  await refreshEvInputs(input.inputs);
  const pinned = await requestFor(input.inputs);
  const built = await assembler.assemble(pinned);
  assert.equal(built.batches.length, 3); assert.equal(built.snapshot.payload.contentCount, 400);
  const hash = (value: unknown) => hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, value);
  for (const [index, batch] of built.batches.entries()) {
    const body = { kind: "contents_batch", providerId: input.inputs.providerId, publicRepackId: input.inputs.publicRepackId, batchIndex: index, records: batch.records };
    assert.equal(batch.batchIndex, index); assert.equal(batch.recordCount, batch.records.length);
    assert.ok(batch.recordCount <= 250 && batch.byteCount <= 480_000);
    assert.equal(batch.byteCount, packCatalogCanonicalByteCount(body));
    assert.equal(batch.batchSha256, await hash(body));
  }
  const { contents, ...header } = built.snapshot.payload;
  assert.deepEqual(built.batches.flatMap(batch => batch.records), contents);
  assert.ok(packCatalogCanonicalByteCount(header) + built.batches.reduce((sum, batch) => sum + batch.byteCount, 0) <= 16_000_000);
  assert.equal(built.snapshot.identity.contentSha256, await hash({ kind: "complete_pack", header,
    batches: built.batches.map(({ batchIndex, recordCount, byteCount, batchSha256 }) => ({ batchIndex, recordCount, byteCount, batchSha256 })) }));
  pinned.inputs.contents.reverse(); pinned.request.requiredProfileSnapshotIds.reverse();
  assert.deepEqual(await assembler.assemble(pinned), built);
  for (const row of input.inputs.contents) row.imageUrl = "https://example.com/card";
  const countBounded = await assembler.assemble(await requestFor(input.inputs));
  assert.deepEqual(countBounded.batches.map(batch => batch.recordCount), [250, 150]);
});
