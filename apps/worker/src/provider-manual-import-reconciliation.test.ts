import assert from "node:assert/strict";
import { test } from "node:test";
import type { FactReferenceReconciliationResult, ProviderFactReferenceScan,
  ValidatedProviderMixedPage } from "@packscout/database";
import { providerPageFactReferenceTargets, reconcileProviderPageFactReferences,
  reconcileProviderPageFactReferencesOpportunistically } from "./provider-manual-import-reconciliation.ts";

const page = { records: [
  { kind: "catalog", entityType: "pack", candidate: { packKey: "new-pack" } },
  { kind: "catalog", entityType: "pack", candidate: { packKey: "new-pack" } },
  { kind: "catalog", entityType: "collectible", candidate: { collectibleKey: "new-card" } },
  { kind: "catalog", entityType: "pack", operation: "retire", candidate: { packKey: "retired" } },
  { kind: "catalog", entityType: "collectible", disposition: "quarantine", candidate: { collectibleKey: "rejected" } },
  { kind: "pull", candidate: { packKey: "known-pack" } },
] } as unknown as ValidatedProviderMixedPage;
const next = { packs: { afterKey: null, done: true }, collectibles: { afterKey: "scan-position", done: false } };
const result = (cursor: typeof next | null): FactReferenceReconciliationResult => ({
  pullPackCount: 0, pullItemCollectibleCount: 0, marketEventPackCount: 0,
  marketEventCollectibleCount: 0, materialChangeCount: 0, promotionRange: null, nextScanCursor: cursor,
});

test("only arriving catalog keys trigger per-page reconciliation", async () => {
  assert.deepEqual(providerPageFactReferenceTargets(page), { packKeys: ["new-pack"], collectibleKeys: ["new-card"] });
  let called = false;
  assert.equal(await reconcileProviderPageFactReferences({
    page: { records: [{ kind: "pull", candidate: {} }] } as unknown as ValidatedProviderMixedPage,
    reachedHead: false, signal: new AbortController().signal, maximumBatches: 2,
    renewLease: async () => { called = true; return true; }, reconcile: async () => { called = true; return result(null); },
  }), "complete");
  assert.equal(called, false);
});

test("head scanning follows continuation across zero changes and renews before every bounded transaction", async () => {
  const scans: ProviderFactReferenceScan[] = []; const order: string[] = [];
  assert.equal(await reconcileProviderPageFactReferences({ page, reachedHead: true,
    signal: new AbortController().signal, maximumBatches: 3,
    renewLease: async () => { order.push("renew"); return true; },
    reconcile: async scan => { order.push("reconcile"); scans.push(scan); return result(scans.length === 1 ? next : null); },
  }), "complete");
  assert.deepEqual(scans, [{}, { after: next }]);
  assert.deepEqual(order, ["renew", "reconcile", "renew", "reconcile"]);
});

test("lease loss, cancellation and exhausted scan bounds never skip to success", async () => {
  for (const outcome of ["lease_lost", "aborted", "limit_exceeded"] as const) {
    const abort = new AbortController(); if (outcome === "aborted") abort.abort();
    let calls = 0;
    assert.equal(await reconcileProviderPageFactReferences({ page, reachedHead: true,
      signal: abort.signal, maximumBatches: 2, renewLease: async () => outcome !== "lease_lost",
      reconcile: async () => { calls += 1; return result(next); },
    }), outcome);
    assert.equal(calls, outcome === "limit_exceeded" ? 2 : 0);
  }
});

test("the opportunistic pass absorbs a database fault and still surfaces every other outcome", async () => {
  const databaseFault = Object.assign(new Error("transaction closed"), { code: "P2028" });
  const isDatabaseFailure = (error: unknown) =>
    (error as { code?: unknown }).code === "P2028";
  const base = { page, reachedHead: false, maximumBatches: 2, isDatabaseFailure,
    signal: new AbortController().signal, renewLease: async () => true };

  // The page is already committed and the checkpoint already advanced, so this
  // fault must not fail the run; head reconciliation redoes the work.
  assert.equal(await reconcileProviderPageFactReferencesOpportunistically({
    ...base, reconcile: async () => { throw databaseFault; },
  }), "complete");

  // A defect in our own code is not a database fault and must still escape.
  const defect = new TypeError("mapper is not a function");
  await assert.rejects(reconcileProviderPageFactReferencesOpportunistically({
    ...base, reconcile: async () => { throw defect; },
  }), (error: unknown) => error === defect);

  // Absorbing must not swallow the non-throwing failure outcomes: a lost lease
  // still has to stop the run rather than read as a completed reconciliation.
  assert.equal(await reconcileProviderPageFactReferencesOpportunistically({
    ...base, reachedHead: true, renewLease: async () => false,
    reconcile: async () => result(null),
  }), "lease_lost");
  const aborted = new AbortController(); aborted.abort();
  assert.equal(await reconcileProviderPageFactReferencesOpportunistically({
    ...base, reachedHead: true, signal: aborted.signal,
    reconcile: async () => result(null),
  }), "aborted");
});
