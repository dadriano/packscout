import assert from "node:assert/strict";
import { mkdtemp, open, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { backfillManifest, uuid } from "./pack-content-backfill-test-fixture.mjs";
const { packContentBackfillManifestSchema, packContentBackfillDigest, MAX_PACK_CONTENT_BACKFILL_BYTES } =
  await tsImport("./pack-content-backfill-contract.mts", import.meta.url);
const { parseChaseBackfillArguments, readPackContentBackfillManifest } =
  await tsImport("./backfill-clutchpacks-chase-cards.mts", import.meta.url);

test("the pinned manifest preserves partial preview evidence and hashes its time basis and exact contents", () => {
  const manifest = backfillManifest();
  assert.deepEqual(packContentBackfillManifestSchema.parse(manifest), manifest);
  const digest = packContentBackfillDigest(manifest);
  const reordered = Object.fromEntries(Object.entries(manifest).reverse());
  assert.equal(packContentBackfillDigest(reordered), digest);
  for (const change of [
    x => { x.sourceGeneration = "3"; },
    x => { x.snapshots[0].effectiveAtBasis = "provider_updated_at"; },
    x => { x.snapshots[0].items[0].collectibleKey = "card:other"; },
    x => { x.responseHashes[0].sha256 = "b".repeat(64); },
  ]) { const changed = structuredClone(manifest); change(changed); assert.notEqual(packContentBackfillDigest(changed), digest); }
});

test("manifests reject crossed providers, duplicate or missing proofs, external references and scope overflow", () => {
  for (const change of [
    x => { x.snapshots[0].providerId = uuid(99); },
    x => { x.snapshots.push(x.snapshots[0]); },
    x => { x.responseHashes = []; },
    x => { x.responseHashes[0].packKey = "pack:foreign"; },
    x => { x.responseHashes.push(x.responseHashes[0]); },
    x => { x.capturedAt = "2026-08-30T12:00:00.000Z"; },
    x => { x.payloadPath = "/outside/private-file"; },
    x => { x.snapshots[0].payloadUrl = "https://unapproved.example/payload"; },
    x => { x.snapshots = Array.from({ length: 101 }, (_, i) => ({ ...x.snapshots[0], packKey: `pack:${i}` })); },
  ]) {
    const manifest = backfillManifest(); change(manifest);
    assert.equal(packContentBackfillManifestSchema.safeParse(manifest).success, false);
  }
});

test("CLI modes require one absolute manifest and exact mode-specific scope", () => {
  const digest = "a".repeat(64);
  assert.deepEqual(parseChaseBackfillArguments(["--capture", "--manifest", "/tmp/catalog.json", "--operation-id", uuid(1), "--operator-id", uuid(4)]),
    { mode: "--capture", manifestPath: "/tmp/catalog.json", operationId: uuid(1), operatorId: uuid(4) });
  for (const mode of ["--check-only", "--apply"]) {
    assert.deepEqual(parseChaseBackfillArguments([mode, "--manifest", "/tmp/catalog.json", "--digest", digest]),
      { mode, manifestPath: "/tmp/catalog.json", digest });
  }
  for (const args of [[], ["--apply"], ["--unknown"],
    ["--apply", "--manifest", "relative.json", "--digest", digest],
    ["--apply", "--manifest", "/tmp/catalog.json"],
    ["--apply", "--manifest", "/tmp/catalog.json", "--digest", "wrong"],
    ["--apply", "--manifest", "/tmp/catalog.json", "--digest", digest, "--operator-id", uuid(4)],
    ["--apply", "--manifest", "/tmp/catalog.json", "--manifest", "/tmp/other.json", "--digest", digest],
    ["--capture", "--manifest", "/tmp/catalog.json", "--operation-id", uuid(1)],
    ["--capture", "--manifest", "/tmp/catalog.json", "--operation-id", uuid(1), "--operator-id", uuid(4), "--digest", digest],
  ]) assert.throws(() => parseChaseBackfillArguments(args));
});

test("manifest reader validates digest and bounded regular files without following symlinks or malformed UTF-8", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pack-content-manifest-test-"));
  try {
    const manifest = backfillManifest(); const digest = packContentBackfillDigest(manifest);
    const file = path.join(directory, "valid.json");
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    assert.deepEqual(await readPackContentBackfillManifest(file, digest), manifest);
    await assert.rejects(readPackContentBackfillManifest(file, "b".repeat(64)), /DIGEST_MISMATCH/);
    const link = path.join(directory, "link.json"); await symlink(file, link);
    await assert.rejects(readPackContentBackfillManifest(link, digest));
    await assert.rejects(readPackContentBackfillManifest(directory, digest));
    const empty = path.join(directory, "empty.json"); await writeFile(empty, "");
    await assert.rejects(readPackContentBackfillManifest(empty, digest), /MANIFEST_INVALID/);
    const tooLarge = path.join(directory, "large.json"); const handle = await open(tooLarge, "w");
    try { await handle.truncate(MAX_PACK_CONTENT_BACKFILL_BYTES + 1); } finally { await handle.close(); }
    await assert.rejects(readPackContentBackfillManifest(tooLarge, digest), /MANIFEST_INVALID/);
    const malformed = path.join(directory, "malformed.json");
    await writeFile(malformed, Buffer.concat([Buffer.from([0xff]), Buffer.from(JSON.stringify(manifest))]));
    await assert.rejects(readPackContentBackfillManifest(malformed, digest));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
