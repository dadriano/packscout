import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGlobalCatalogObservationFixtureV1,
  buildGlobalCatalogProviderSelectionsFixtureV1,
  buildGlobalCatalogManifestFixtureV1,
} from "./__fixtures__/global-catalog-manifest-v1.fixture.ts";
import {
  MAX_GLOBAL_CATALOG_MANIFEST_BYTES,
  MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES,
  derivePublicCatalogReleaseIdV1,
  globalCatalogManifestCanonicalByteCount,
  globalCatalogManifestV1Schema,
  globalCatalogProviderReferenceIdentityBodyV1,
  globalCatalogProviderReferencesCanonicalByteCount,
  recomputeGlobalCatalogCompositionProofHashV1,
  recomputeGlobalCatalogManifestFingerprintV1,
  recomputeGlobalCatalogProviderReferenceSetHashV1,
  verifyGlobalCatalogManifestV1,
} from "./index.ts";

test("global manifest proof is deterministic, bounded, and runtime neutral", async () => {
  const first = await buildGlobalCatalogManifestFixtureV1();
  const second = await buildGlobalCatalogManifestFixtureV1();

  assert.deepEqual(first, second);
  assert.equal(first.providerReferences.length, 2);
  assert.equal(first.counts.categories, 3);
  assert.equal(first.providerReferences.reduce(
    (sum, reference) => sum + reference.counts.categories,
    0,
  ), 4, "shared categories are represented once in the global count");
  assert.equal(first.counts.collectibles, 3);
  assert.equal(
    globalCatalogManifestCanonicalByteCount(first) <=
      MAX_GLOBAL_CATALOG_MANIFEST_BYTES,
    true,
  );
  assert.equal(
    globalCatalogProviderReferencesCanonicalByteCount(
      first.providerReferences,
    ) < globalCatalogManifestCanonicalByteCount(first),
    true,
  );
  assert.deepEqual(await verifyGlobalCatalogManifestV1(first), first);
});

test("sole public release identity excludes every mutable selection fact", async () => {
  const manifest = await buildGlobalCatalogManifestFixtureV1();
  const selections = buildGlobalCatalogProviderSelectionsFixtureV1(manifest);
  const refreshed = selections.map((selection) => ({
    ...selection,
    terminalOperationKind: "confirmReuse" as const,
    terminalOperationId: `${selection.terminalOperationId}:reuse`,
    terminalReceiptSha256: "9".repeat(64),
    selectedProviderCheckpoint: {
      settledSequence: "30",
      settledAt: "2026-08-15T00:06:00.000Z",
    },
    latestAffectedSettledSequence: "30",
    latestAffectedSourceHeadSequence: "30",
    lastSuccessfulObservationAt: "2026-08-15T00:06:00.000Z",
    staleAt: "2026-08-15T00:16:00.000Z",
  }));

  assert.notDeepEqual(
    buildGlobalCatalogObservationFixtureV1(manifest, 1, selections),
    buildGlobalCatalogObservationFixtureV1(manifest, 2, refreshed),
  );
  assert.equal(
    await derivePublicCatalogReleaseIdV1(manifest),
    manifest.publicReleaseId,
  );
  assert.equal(
    await recomputeGlobalCatalogManifestFingerprintV1(manifest),
    manifest.manifestFingerprint,
  );

  const withOperationalEvidence = manifest.providerReferences.map(
    (reference, index) => ({
      ...reference,
      providerCheckpoint: refreshed[index]!.selectedProviderCheckpoint,
      terminalOperationId: refreshed[index]!.terminalOperationId,
      terminalReceiptSha256: refreshed[index]!.terminalReceiptSha256,
    }),
  );
  assert.equal(
    await recomputeGlobalCatalogProviderReferenceSetHashV1(
      withOperationalEvidence,
    ),
    manifest.providerReferenceSetHash,
  );
  assert.deepEqual(
    globalCatalogProviderReferenceIdentityBodyV1(withOperationalEvidence[0]!),
    globalCatalogProviderReferenceIdentityBodyV1(
      manifest.providerReferences[0]!,
    ),
  );
});

test("mock and canonical manifests use the same contract with distinct identities", async () => {
  const canonical = await buildGlobalCatalogManifestFixtureV1("canonical");
  const mock = await buildGlobalCatalogManifestFixtureV1("mock");

  assert.equal(canonical.dataSource, "canonical");
  assert.equal(mock.dataSource, "mock");
  assert.notEqual(mock.publicReleaseId, canonical.publicReleaseId);
  assert.notEqual(mock.manifestFingerprint, canonical.manifestFingerprint);
  await verifyGlobalCatalogManifestV1(mock);
});

test("manifest schema rejects noncanonical and duplicate references", async () => {
  const manifest = await buildGlobalCatalogManifestFixtureV1();
  const reversed = structuredClone(manifest);
  reversed.providerReferences.reverse();
  assert.equal(globalCatalogManifestV1Schema.safeParse(reversed).success, false);

  const duplicate = structuredClone(manifest);
  duplicate.providerReferences[1] = {
    ...duplicate.providerReferences[1]!,
    platformKey: "alpha",
  };
  duplicate.enabledPlatformKeys = ["alpha", "alpha"];
  assert.equal(globalCatalogManifestV1Schema.safeParse(duplicate).success, false);

  const wrongOrigins = structuredClone(manifest);
  wrongOrigins.providerReferences[1]!.publicAssetOrigins = [
    "https://other.packscout.test",
  ];
  assert.equal(globalCatalogManifestV1Schema.safeParse(wrongOrigins).success, false);
});

test("providers with different catalog epochs and asset origins compose independently", async () => {
  const manifest = await buildGlobalCatalogManifestFixtureV1("canonical", {
    mixedProviderEpochs: true,
    distinctProviderOrigins: true,
  });

  assert.notDeepEqual(
    manifest.providerReferences[0]!.sharedConfigurationEpoch,
    manifest.providerReferences[1]!.sharedConfigurationEpoch,
  );
  assert.deepEqual(manifest.publicAssetOrigins, [
    "https://cdn.packscout.test",
    "https://other.packscout.test",
  ]);
  assert.deepEqual(await verifyGlobalCatalogManifestV1(manifest), manifest);
});

test("manifest aggregate limits are global rather than per-provider multiples", async () => {
  const manifest = await buildGlobalCatalogManifestFixtureV1();
  const overflow = structuredClone(manifest);
  overflow.providerReferences[0]!.counts.repacks = 4_001;
  overflow.providerReferences[1]!.counts.repacks = 4_000;
  overflow.counts.repacks = 8_001;
  assert.equal(globalCatalogManifestV1Schema.safeParse(overflow).success, false);

  const sharedCategoryCopyOverflow = structuredClone(manifest);
  sharedCategoryCopyOverflow.providerReferences[0]!.counts.categories = 4_096;
  sharedCategoryCopyOverflow.providerReferences[1]!.counts.categories = 4_096;
  sharedCategoryCopyOverflow.counts.categories = 4_096;
  assert.equal(
    globalCatalogManifestV1Schema.safeParse(sharedCategoryCopyOverflow).success,
    false,
    "the summed provider copies must stay within the public read bound",
  );

  assert.ok(
    MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES > 8,
    "the safety ceiling must not encode the former fixed-eight roster",
  );
  const dynamicNine = structuredClone(manifest);
  dynamicNine.providerReferences = Array.from(
    { length: 9 },
    (_, index) => ({
      ...manifest.providerReferences[0]!,
      platformKey: `provider-${String(index).padStart(2, "0")}`,
    }),
  );
  dynamicNine.enabledPlatformKeys = dynamicNine.providerReferences.map(
    ({ platformKey }) => platformKey,
  );
  dynamicNine.counts = {
    vendors: 9,
    categories: 2,
    collectibles: 2,
    repacks: 9,
    repackChases: 18,
    searchShards: 9,
  };
  assert.equal(
    globalCatalogManifestV1Schema.safeParse(dynamicNine).success,
    true,
  );

  const capacityOverflow = structuredClone(manifest);
  capacityOverflow.providerReferences = Array.from(
    { length: MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES + 1 },
    (_, index) => ({
      ...manifest.providerReferences[0]!,
      platformKey: `provider-${String(index).padStart(2, "0")}`,
    }),
  );
  capacityOverflow.enabledPlatformKeys = capacityOverflow.providerReferences.map(
    ({ platformKey }) => platformKey,
  );
  assert.equal(
    globalCatalogManifestV1Schema.safeParse(capacityOverflow).success,
    false,
  );
});

test("manifest verifier rejects every caller-chosen aggregate digest", async () => {
  const manifest = await buildGlobalCatalogManifestFixtureV1();
  const fields = [
    ["providerReferenceSetHash"],
    ["governingHashes", "providerConfigurationsHash"],
    ["governingHashes", "sharedCategoriesHash"],
    ["governingHashes", "identityMappingsHash"],
    ["governingHashes", "originSetHash"],
    ["entityHashes", "repacks"],
    ["contentHash"],
    ["repackSearchIndexHash"],
    ["manifestFingerprint"],
  ] as const;

  for (const path of fields) {
    const tampered = structuredClone(manifest) as unknown as Record<
      string,
      unknown
    >;
    let target = tampered;
    for (const key of path.slice(0, -1)) {
      target = target[key] as Record<string, unknown>;
    }
    target[path[path.length - 1]!] = "0".repeat(64);
    await assert.rejects(verifyGlobalCatalogManifestV1(tampered));
  }

  await assert.rejects(verifyGlobalCatalogManifestV1({
    ...manifest,
    publicReleaseId: "33333333-3333-5333-8333-333333333333",
  }));
});

test("composition hashes domain-separate shared collisions and ownership", async () => {
  const proof = ["same-public-id", "same-canonical-bytes"];
  const category = await recomputeGlobalCatalogCompositionProofHashV1({
    kind: "shared_category_identity_bytes",
    canonicalProof: proof,
  });
  const collectible = await recomputeGlobalCatalogCompositionProofHashV1({
    kind: "shared_collectible_identity_bytes",
    canonicalProof: proof,
  });
  const ownership = await recomputeGlobalCatalogCompositionProofHashV1({
    kind: "unique_repack_ownership",
    canonicalProof: proof,
  });

  assert.notEqual(category, collectible);
  assert.notEqual(category, ownership);
  assert.equal(category.length, 64);
});
