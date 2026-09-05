import assert from "node:assert/strict";
import { test } from "node:test";
import { PACK_SNAPSHOT_HASH_DOMAIN, hashPackCatalogValue, packCatalogCanonicalByteCount, packSearchText,
  packSnapshotHeaderFromPayload, publicPackSnapshotSchema } from "@packscout/contracts";
import { ProviderPackSnapshotAssembler, PackSnapshotAssemblyError, packSnapshotAssemblyLimits } from "./provider-pack-snapshot-assembler.ts";
import { assemblyFixture, requestFor, refreshEvInputs } from "./provider-pack-snapshot-assembler.test-support.ts";

const assembler = new ProviderPackSnapshotAssembler();
const hash = (value: unknown) => hashPackCatalogValue(PACK_SNAPSHOT_HASH_DOMAIN, value);
function nodeCount(value: unknown): number {
  return 1 + (value !== null && typeof value === "object" ? Object.values(value).reduce<number>((sum, item) => sum + nodeCount(item), 0) : 0);
}

test("pack search accepts exactly 1,024 characters independently of complete member names", async () => {
  const { input } = await assemblyFixture();
  input.inputs.title = "p";
  input.inputs.aliases = [..."abcdefgh"].map(letter => letter.repeat(120)).concat("i".repeat(54));
  input.inputs.contents.forEach(row => { row.displayName = "member".repeat(30); });
  assert.equal(packSearchText(input.inputs.title, input.inputs.aliases).length, 1_024);
  const built = await assembler.assemble(await requestFor(input.inputs));
  assert.equal(built.snapshot.payload.searchProjection.normalizedText, packSearchText(input.inputs.title, input.inputs.aliases));
  assert.deepEqual(built.snapshot.payload.contents.map(row => row.displayName), input.inputs.contents.map(row => row.displayName));
  input.inputs.aliases[8] += "i";
  assert.equal(packSearchText(input.inputs.title, input.inputs.aliases).length, 1_025);
  await assert.rejects(assembler.assemble(await requestFor(input.inputs, true)), PackSnapshotAssemblyError);
});

test("8,000 complete members and maximum shared evidence survive lifecycle assembly and exact reuse", async () => {
  const { input } = await assemblyFixture();
  input.inputs.title = "p"; input.inputs.aliases = [];
  input.inputs.contents = Array.from({ length: 8_000 }, (_, index) => ({ ...structuredClone(input.inputs.contents[0]!),
    publicCollectibleId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    collectibleProfileSnapshotId: `ppfs_${(index + 1).toString(16).padStart(64, "0")}`,
    displayName: "complete member", imageUrl: `https://example.com/${"a".repeat(500)}`, probabilityMicros: 125,
    valuation: { ...structuredClone(input.inputs.contents[0]!.valuation), valuationIdentity: (index + 1).toString(16).padStart(64, "0") },
  }));
  input.inputs.expectedDependencies = Array.from({ length: 10_000 }, (_, index) => ({ kind: "ev_policy" as const,
    identity: `policy:${String(index).padStart(5, "0")}`, contentSha256: "a".repeat(64) }));
  input.inputs.observedDependencies = structuredClone(input.inputs.expectedDependencies);
  await refreshEvInputs(input.inputs);
  const pinned = await requestFor(input.inputs);
  const full = await assembler.assemble(pinned);
  assert.equal(full.batches.length, 32);
  assert.ok(full.batches.every(batch => batch.recordCount === 250 && batch.byteCount <= 480_000));
  assert.equal(full.snapshot.payload.contents.length, 8_000);
  assert.deepEqual(full.batches.flatMap(batch => batch.records), full.snapshot.payload.contents);
  const { contents, ...header } = full.snapshot.payload;
  assert.equal(contents.length, 8_000);
  assert.ok(packCatalogCanonicalByteCount(header) > 480_000, "hash header retains both complete dependency vectors");
  assert.ok(packCatalogCanonicalByteCount(packSnapshotHeaderFromPayload(full.snapshot.payload).header) <= 480_000);
  assert.ok(packCatalogCanonicalByteCount(header) + full.batches.reduce((sum, batch) => sum + batch.byteCount, 0) <= 16_000_000);
  assert.equal(full.snapshot.identity.contentSha256, await hash({ kind: "complete_pack", header,
    batches: full.batches.map(({ batchIndex, recordCount, byteCount, batchSha256 }) => ({ batchIndex, recordCount, byteCount, batchSha256 })) }));
  const lifecycle = await requestFor({ ...pinned.inputs, snapshotKind: "lifecycle_only", lifecycleBaseline: full.snapshot,
    lifecycleProvenanceIdentity: "max:sold-out", lifecycle: { ...pinned.inputs.lifecycle, availability: "sold_out",
      availabilityEvidence: { kind: "explicit_sold_out", sourceIdentity: "max:sold-out" } },
    actions: pinned.inputs.actions.map(action => ({ ...action, enabled: false, disabledReason: "PACK_UNAVAILABLE" })) });
  assert.ok(packCatalogCanonicalByteCount({ ...lifecycle.inputs, lifecycleBaseline: null }) < 16_000_000);
  assert.ok(packCatalogCanonicalByteCount(full.snapshot) < 16_000_000);
  assert.ok(packCatalogCanonicalByteCount(lifecycle.inputs) > 16_000_000, "complete baseline has a separate allowance");
  const frozen = await assembler.assemble(lifecycle);
  assert.deepEqual(frozen.snapshot.payload.contents, full.snapshot.payload.contents);
  assert.equal(frozen.snapshot.payload.economicsSha256, full.snapshot.payload.economicsSha256);
  const reuseInput = { ...lifecycle, existingSnapshot: frozen.snapshot };
  assert.ok(nodeCount(reuseInput) > 500_000, "valid maximum content/dependency/reuse combination exceeds the former node guard");
  const reused = await assembler.assemble(reuseInput);
  assert.equal(reused.disposition, "reused");
  assert.deepEqual(reused.snapshot, frozen.snapshot);
  assert.ok(nodeCount(reuseInput) <= packSnapshotAssemblyLimits.maximumNodes);

  // A different candidate ID must not bypass its own snapshot-byte allowance.
  const oversized = structuredClone(full.snapshot);
  oversized.payload.contents.forEach(row => { row.imageUrl = `https://example.com/${"b".repeat(1_950)}`; });
  assert.ok(packCatalogCanonicalByteCount(oversized) > packSnapshotAssemblyLimits.maximumSnapshotBytes);
  await publicPackSnapshotSchema.parseAsync(oversized);
  const { input: small, golden } = await assemblyFixture();
  assert.notEqual(oversized.identity.publicPackSnapshotId, golden.snapshot.identity.publicPackSnapshotId);
  const candidateInput = { ...small, existingSnapshot: oversized };
  assert.ok(packCatalogCanonicalByteCount(candidateInput) < packSnapshotAssemblyLimits.maximumInputBytes);
  assert.ok(nodeCount(candidateInput) < packSnapshotAssemblyLimits.maximumNodes);
  await assert.rejects(assembler.assemble(candidateInput), error => {
    assert.ok(error instanceof PackSnapshotAssemblyError);
    assert.equal(error.message, "PACK_SNAPSHOT_INPUT_INVALID");
    return true;
  });
});
