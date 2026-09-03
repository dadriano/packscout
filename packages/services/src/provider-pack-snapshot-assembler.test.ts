import assert from "node:assert/strict";
import { test } from "node:test";
import { PACK_SNAPSHOT_HASH_DOMAIN, hashPackCatalogValue, packCatalogCanonicalJson, publicPackSummaryCore } from "@packscout/contracts";
import { ProviderPackSnapshotAssembler } from "./provider-pack-snapshot-assembler.ts";
import { assemblyFixture, requestFor, refreshEvInputs } from "./provider-pack-snapshot-assembler.test-support.ts";

const assembler = new ProviderPackSnapshotAssembler();

test("Complete deterministic pack snapshot suite: exact P01 fixtures and projection identity", async context => {
  for (const kind of ["packA", "packB", "packAUpdate"] as const) await context.test(kind, async () => {
    const { golden, input } = await assemblyFixture(kind);
    const built = await assembler.assemble(input);
    assert.equal(built.disposition, "created");
    assert.deepEqual(built.snapshot, golden.snapshot);
    assert.deepEqual(built.descriptor, golden.descriptor);
    assert.deepEqual(built.batches, golden.batches);
    assert.equal(built.canonicalBytes, golden.canonicalBytes);
    assert.equal(built.payloadSha256, await hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, golden.snapshot.payload));
    assert.deepEqual(built.evidence, input.request.evidence);
    assert.deepEqual(built.snapshot.payload.summaryProjection, publicPackSummaryCore(built.snapshot.payload));
    assert.deepEqual(built.batches.flatMap(batch => batch.records), built.snapshot.payload.contents);
  });
});

test("input permutations cannot change canonical bytes, ordered proofs or projections", async () => {
  const { input } = await assemblyFixture();
  input.inputs.expectedDependencies = [
    { kind: "category", identity: input.inputs.category.publicCategoryId, contentSha256: "a".repeat(64) },
    { kind: "valuation", identity: input.inputs.contents[0]!.publicCollectibleId, contentSha256: "b".repeat(64) },
  ];
  input.inputs.observedDependencies = structuredClone(input.inputs.expectedDependencies);
  const pinned = await requestFor(input.inputs);
  const expected = await assembler.assemble(pinned);
  for (let mask = 0; mask < 32; mask += 1) {
    const reordered = structuredClone(pinned);
    if (mask & 1) reordered.inputs.contents.reverse();
    if (mask & 2) reordered.inputs.aliases.reverse();
    if (mask & 4) reordered.inputs.actions.reverse();
    if (mask & 8) {
      reordered.inputs.expectedDependencies.reverse(); reordered.inputs.observedDependencies.reverse();
      reordered.request.evidence.sharedDependencies.reverse();
    }
    if (mask & 16) reordered.request.requiredProfileSnapshotIds.reverse();
    assert.deepEqual(await assembler.assemble(reordered), expected);
  }
  const objectOrder = Object.fromEntries(Object.entries(pinned).reverse()) as typeof pinned;
  assert.deepEqual(await assembler.assemble(objectOrder), expected);
});

test("contract normalization precedes hashing without changing native identities", async () => {
  const { input } = await assemblyFixture();
  input.inputs.title = "Café";
  const pinned = await requestFor(input.inputs);
  const expected = await assembler.assemble(pinned);
  pinned.inputs.title = "  Cafe\u0301  ";
  pinned.inputs.dataAsOf = "2026-09-03T11:00:00-07:00";
  assert.deepEqual(await assembler.assemble(pinned), expected);
  assert.equal(expected.snapshot.identity.publicRepackId, pinned.request.publicRepackId);
});

test("capture is synchronous: later source mutation and operational sequencing cannot alter bytes", async () => {
  const { input, golden } = await assemblyFixture();
  const pending = assembler.assemble(input);
  input.inputs.title = "Concurrent source update";
  input.inputs.contents[0]!.displayName = "Later source display";
  input.request.evidence.sourceRevisionIdentity = "later:2";
  const built = await pending;
  assert.deepEqual(built.snapshot, golden.snapshot);
  assert.ok(Object.isFrozen(built.snapshot.payload.contents[0]));
  const { input: next } = await assemblyFixture();
  next.request.packPublicationSequence = "99"; next.request.evidence.packPublicationSequence = "99";
  next.request.expectedPublicationEpoch = 7; next.request.requestedAt = "2026-09-03T18:06:00.000Z";
  assert.deepEqual((await assembler.assemble(next)).snapshot, golden.snapshot);
});

test("exact artifact reuse is separate from evidence and a changed public byte creates a new identity", async () => {
  const { input, golden } = await assemblyFixture();
  assert.equal((await assembler.assemble({ ...input, existingSnapshot: golden.snapshot })).disposition, "reused");
  input.inputs.title = "New title";
  const changed = await assembler.assemble({ ...await requestFor(input.inputs), existingSnapshot: golden.snapshot });
  assert.equal(changed.disposition, "created");
  assert.notEqual(changed.snapshot.identity.publicPackSnapshotId, golden.snapshot.identity.publicPackSnapshotId);
  const { input: profileOnly } = await assemblyFixture();
  profileOnly.inputs.expectedDependencies = [{ kind: "provider_profile", identity: profileOnly.inputs.providerId, contentSha256: "d".repeat(64) }];
  profileOnly.inputs.observedDependencies = structuredClone(profileOnly.inputs.expectedDependencies);
  const independent = await assembler.assemble({ ...await requestFor(profileOnly.inputs), existingSnapshot: golden.snapshot });
  assert.equal(independent.disposition, "reused");
  assert.equal(independent.canonicalBytes, golden.canonicalBytes);
  assert.notDeepEqual(independent.evidence.sharedDependencies, input.request.evidence.sharedDependencies);
});

test("all eligible valuations participate, with a stable native-ID tie break", async () => {
  const { input, golden } = await assemblyFixture();
  const nonTop = input.inputs.contents[1]!;
  assert.equal(nonTop.valuation.status, "available");
  if (nonTop.valuation.status !== "available") throw new Error("fixture");
  nonTop.valuation.amount.minorUnits = 40_000;
  nonTop.valuation.valuationIdentity = "e".repeat(64);
  if (input.inputs.ev?.status === "available") input.inputs.ev.amount.minorUnits = 35_000;
  await refreshEvInputs(input.inputs);
  const raised = await assembler.assemble(await requestFor(input.inputs));
  assert.equal(raised.snapshot.payload.topChase?.publicCollectibleId, nonTop.publicCollectibleId);
  assert.notEqual(raised.snapshot.identity.contentSha256, golden.snapshot.identity.contentSha256);
  assert.notEqual(raised.snapshot.payload.valuationsSha256, golden.snapshot.payload.valuationsSha256);
  nonTop.valuation.amount.minorUnits = 30_000;
  await refreshEvInputs(input.inputs);
  const tied = await requestFor(input.inputs);
  tied.inputs.contents.reverse();
  assert.equal((await assembler.assemble(tied)).snapshot.payload.topChase?.publicCollectibleId,
    [...input.inputs.contents].map(row => row.publicCollectibleId).sort()[0]);
});

test("domain-unavailable EV and no eligible chase do not invent a numeric value", async () => {
  const { input } = await assemblyFixture("packB");
  for (const row of input.inputs.contents) {
    row.eligibleForChase = false;
    row.valuation = { status: "unavailable", reason: "NOT_ELIGIBLE", valuationIdentity: row.valuation.valuationIdentity };
  }
  await refreshEvInputs(input.inputs);
  const built = await assembler.assemble(await requestFor(input.inputs));
  assert.equal(built.snapshot.payload.topChase, null);
  assert.equal(built.snapshot.payload.ev.status, "unavailable");
  assert.equal("amount" in built.snapshot.payload.ev, false);
});

test("lifecycle clone changes provenance and eligibility while freezing complete economics and display", async () => {
  const { input, golden } = await assemblyFixture("packAUpdate");
  const before = structuredClone(input.inputs.lifecycleBaseline!);
  const built = await assembler.assemble(input);
  const payload = built.snapshot.payload;
  assert.deepEqual(payload.contents, before.payload.contents);
  assert.deepEqual(payload.ev, before.payload.ev);
  assert.equal(payload.economicsSha256, before.payload.economicsSha256);
  assert.equal(payload.lifecycleFreeze?.previousSnapshotId, before.identity.publicPackSnapshotId);
  assert.ok(payload.actions.every(action => !action.enabled && action.disabledReason === "PACK_UNAVAILABLE"));
  assert.equal(payload.lifecycle.availability, "sold_out");
  assert.deepEqual(built.snapshot, golden.snapshot);
  assert.deepEqual(input.inputs.lifecycleBaseline, before);
  assert.equal(packCatalogCanonicalJson(payload.searchProjection), packCatalogCanonicalJson(before.payload.searchProjection));
});
