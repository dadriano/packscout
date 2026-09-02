import assert from "node:assert/strict";
import test from "node:test";
import type { GlobalCatalogManifestV1 } from "@packscout/contracts";
import type {
  ManifestActivationMirror,
  ProviderManifestPlanReference,
} from "@packscout/database";
import {
  readDistributedPromotionManifestPlanCacheCoverage,
} from "./distributed-promotion-cutover-preflight-composition.ts";

function manifest(
  fingerprint: string,
  providerKeys: readonly string[],
): GlobalCatalogManifestV1 {
  return {
    manifestFingerprint: fingerprint,
    providerReferences: providerKeys.map((providerKey, index) => ({
      platformKey: providerKey,
      publicProviderReleaseId:
        `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      providerReleaseFingerprint: String(index + 1).repeat(64).slice(0, 64),
    })),
  } as GlobalCatalogManifestV1;
}

function mirror(input: Readonly<{
  rowVersion?: bigint;
  active?: GlobalCatalogManifestV1 | null;
  previous?: GlobalCatalogManifestV1 | null;
}> = {}): ManifestActivationMirror {
  return {
    generation: 7n,
    activeManifest: input.active ?? null,
    activeState: null,
    previousManifest: input.previous ?? null,
    lastReceiptId: null,
    rowVersion: input.rowVersion ?? 3n,
    updatedAt: new Date("2026-09-01T12:00:00.000Z"),
  };
}

test("cutover cache coverage counts exact active and previous references", async () => {
  const snapshot = mirror({
    active: manifest("a".repeat(64), ["alpha", "bravo"]),
    previous: manifest("b".repeat(64), ["alpha"]),
  });
  const calls: readonly ProviderManifestPlanReference[][] = [];
  const mutableCalls = calls as ProviderManifestPlanReference[][];
  const result = await readDistributedPromotionManifestPlanCacheCoverage({
    activations: { async loadMirror() { return snapshot; } },
    plans: {
      async loadMetadataForManifestReferences(references) {
        mutableCalls.push([...references]);
        return references.map(() => ({} as never));
      },
    },
  });
  assert.deepEqual(result, {
    mirrorStable: true,
    mirrorGeneration: 7n,
    activeManifestFingerprint: "a".repeat(64),
    previousManifestFingerprint: "b".repeat(64),
    activeReferenceCount: 2,
    cachedActiveReferenceCount: 2,
    previousReferenceCount: 1,
    cachedPreviousReferenceCount: 1,
  });
  assert.deepEqual(calls.map((references) => references.length), [2, 1]);
});

test("cutover cache coverage reports a missing reference as incomplete", async () => {
  const snapshot = mirror({
    active: manifest("a".repeat(64), ["alpha", "bravo"]),
  });
  const result = await readDistributedPromotionManifestPlanCacheCoverage({
    activations: { async loadMirror() { return snapshot; } },
    plans: { async loadMetadataForManifestReferences() { return null; } },
  });
  assert.equal(result.activeReferenceCount, 2);
  assert.equal(result.cachedActiveReferenceCount, 0);
});

test("cutover cache coverage refuses a mirror that changes during the read", async () => {
  const active = manifest("a".repeat(64), ["alpha"]);
  const snapshots = [
    mirror({ active, rowVersion: 3n }),
    mirror({ active, rowVersion: 4n }),
  ];
  const result = await readDistributedPromotionManifestPlanCacheCoverage({
    activations: { async loadMirror() { return snapshots.shift()!; } },
    plans: {
      async loadMetadataForManifestReferences(references) {
        return references.map(() => ({} as never));
      },
    },
  });
  assert.equal(result.mirrorStable, false);
});
