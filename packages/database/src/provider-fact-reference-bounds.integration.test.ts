import assert from "node:assert/strict";
import { test } from "node:test";
import { createProviderHarness } from "./provider-canonical-integration-support.ts";
import { ProviderCanonicalRepository } from "./provider-canonical-repository.ts";
import { PrismaProviderWorkerLeaseRepository } from "./provider-worker-lease-repository.ts";
import type { ProviderFactReferenceScanCursor } from "./provider-canonical-contract.ts";
import { FACT_REFERENCE_RECONCILIATION_LIMIT } from "./provider-fact-reference-reconciliation.ts";

// This proves traversal, rollback and update bounds in a disposable database.
// Large source histories are never used as fixtures or modified by this test.
test("a wide no-match catalog continues to a late matching key and publishes only committed resolutions", {
  timeout: 180_000,
}, async context => {
  if (!process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL) {
    context.skip("An explicit disposable PostgreSQL test target is required."); return;
  }
  // One event more than a full batch, so the last target page must drain twice.
  const targets = 7501;
  const events = FACT_REFERENCE_RECONCILIATION_LIMIT + 1;
  const harness = await createProviderHarness(); const { client } = harness;
  try {
    await client.$transaction(async tx => {
      await tx.$executeRaw`
        INSERT INTO collectibles (id, collectible_key, collectible_type, display_name, normalized_name, data_as_of)
        SELECT md5('bounded-target-' || n)::uuid, 'target-' || lpad(n::text, 6, '0'),
          'card'::collectible_type, 'Synthetic target', 'synthetic target', CURRENT_TIMESTAMP
        FROM generate_series(1, ${targets}) AS n
      `;
      await tx.$executeRaw`
        INSERT INTO market_events (id, event_key, fact_digest, event_type, collectible_key, occurred_at)
        SELECT md5('bounded-event-' || n)::uuid, 'event-' || n, repeat('b', 64),
          'sale'::market_event_type, 'target-007501', CURRENT_TIMESTAMP FROM generate_series(1, ${events}) AS n
      `;
      await tx.promotion_ledger.update({ where: { singleton_key: true }, data: { last_sequence: BigInt(targets + events) } });
      await tx.$executeRaw`
        INSERT INTO promotion_changes (sequence, entity_type, entity_id, entity_version, operation, changed_at)
        SELECT row_number() OVER (ORDER BY kind, id), kind, id, 1, 'upsert'::promotion_operation, CURRENT_TIMESTAMP
        FROM (SELECT 'collectible' AS kind, id FROM collectibles UNION ALL SELECT 'market_event', id FROM market_events) AS seed
      `;
    }, { timeout: 90_000 });
    const owner = "integration:bounded-reconciliation";
    const acquired = await new PrismaProviderWorkerLeaseRepository(client).acquire({ role: "import", owner, leaseMilliseconds: 300_000 });
    assert.notEqual(acquired.kind, "held"); if (acquired.kind === "held") return;
    const authority = { workerId: owner, workerFence: acquired.lease.fence };
    const repository = new ProviderCanonicalRepository(client);
    let after: ProviderFactReferenceScanCursor | undefined;
    let batches = 0; let resolved = 0;
    do {
      const result = await repository.reconcileFactReferences({ ...authority, ...(after ? { after } : {}) });
      assert.ok(result); batches += 1; resolved += result.materialChangeCount;
      assert.ok(result.marketEventCollectibleCount <= FACT_REFERENCE_RECONCILIATION_LIMIT);
      if (batches <= 30) { assert.equal(result.materialChangeCount, 0); assert.ok(result.nextScanCursor); }
      after = result.nextScanCursor ?? undefined;
    } while (after);
    assert.equal(batches, 32); assert.equal(resolved, events);
    assert.equal(await client.market_events.count({ where: { collectible_id: null } }), 0);
    assert.equal(await client.promotion_changes.count(), targets + 2 * events);
    assert.equal((await client.promotion_ledger.findUniqueOrThrow({ where: { singleton_key: true } })).last_sequence, BigInt(targets + 2 * events));

    // Repeating a completed scan changes neither facts nor the promotion ledger.
    assert.equal((await repository.reconcileFactReferences({ ...authority,
      targets: { packKeys: [], collectibleKeys: ["target-007501"] },
    }))?.materialChangeCount, 0);
    assert.equal(await client.promotion_changes.count(), targets + 2 * events);
    context.diagnostic(`${targets.toLocaleString("en-US")} targets traversed in 32 bounded transactions; 30 zero-change pages did not hide ${events.toLocaleString("en-US")} late matches.`);
  } finally { await harness.close(); }
});
