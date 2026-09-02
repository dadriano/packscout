import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ProviderPackContentSnapshotItemV1, ProviderPackContentSnapshotV1 } from "@packscout/contracts";
import { Prisma } from "../prisma/generated/provider/index.js";
import type { ProviderTransactionClient } from "./provider-database.ts";
import { ProviderCanonicalWriteConflictError, type CanonicalJsonObject } from "./provider-canonical-contract.ts";
import { appendPromotionRange } from "./provider-canonical-repository.ts";
import { applyProviderPackContentSnapshot } from "./provider-pack-content-snapshot-repository.ts";
import { createMembershipHarness, postgresBinDirectory } from "./provider-pack-content-snapshot.test-support.ts";
import { PrismaProviderMixedPageRepository } from "./provider-mixed-page-repository.ts";
import { batchState, batchWorker, prepareBatchFixture } from "./provider-quarantine-batch-integration-support.ts";

function observedTransaction(transaction: ProviderTransactionClient, operations: string[], afterActiveRead?: () => Promise<void>,
  afterRawQuery?: (query: unknown) => void) {
  return new Proxy(transaction, { get(target, key) {
    const value = Reflect.get(target, key);
    if (typeof value === "function") return async (...args: unknown[]) => {
      operations.push(String(key)); const result = await Reflect.apply(value, target, args);
      if (key === "$queryRaw") afterRawQuery?.(args[0]);
      return result;
    };
    if (value === null || typeof value !== "object") return value;
    return new Proxy(value, { get(delegate, method) {
      const operation = Reflect.get(delegate, method);
      if (typeof operation !== "function") return operation;
      return async (...args: unknown[]) => {
        operations.push(`${String(key)}.${String(method)}`);
        const result = await Reflect.apply(operation, delegate, args);
        if (key === "pack_contents" && method === "findMany") await afterActiveRead?.();
        return result;
      };
    } });
  } });
}

test("snapshot batches preserve membership semantics and bound writes independently of member count", async context => {
  const bin = await postgresBinDirectory();
  if (bin === null) { context.skip("PostgreSQL is required for a socket-only membership database."); return; }
  const providerId = randomUUID(), sourceAt = new Date("2026-08-30T12:00:00.000Z");
  const { client, close } = await createMembershipHarness(bin, providerId);
  const options = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 };
  const cards = Array.from({ length: 1_000 }, (_, index) => ({ id: randomUUID(),
    collectible_key: `b${String(index).padStart(4, "0")}`, collectible_type: "card" as const,
    display_name: `Batch ${index}`, normalized_name: `batch ${index}`, data_as_of: sourceAt }));
  const item = (index: number, changes: Partial<ProviderPackContentSnapshotItemV1> = {}): ProviderPackContentSnapshotItemV1 => ({
    collectibleKey: cards[index]!.collectible_key, collectibleInstanceKey: null, status: "present",
    totalQuantity: null, availableQuantity: null, contentRole: "possible_outcome", probability: null,
    statedValueAmount: null, statedValueCurrency: null, evidenceKinds: ["vendor_inventory"],
    matchConfidenceBasisPoints: 10_000, displayOrder: index % 500, ...changes,
  });
  const snapshot = (packKey: string, items: ProviderPackContentSnapshotItemV1[], minute: number,
    completeness: "complete" | "partial" = "complete"): ProviderPackContentSnapshotV1 => ({
    schemaVersion: "provider_pack_content_snapshot_v1", providerId, packKey, sourceKey: "fixture:inventory",
    sourceAdapterVersion: "fixture-1", mapperVersion: "1", effectiveAtBasis: "provider_updated_at", completeness, items,
    effectiveAt: new Date(sourceAt.getTime() + minute * 60_000).toISOString(),
    collectedAt: new Date(sourceAt.getTime() + minute * 60_000).toISOString(),
  });
  const apply = async (value: ProviderPackContentSnapshotV1, afterActiveRead?: () => Promise<void>) => {
    const operations: string[] = [];
    const result = await client.$transaction(tx => applyProviderPackContentSnapshot(
      observedTransaction(tx, operations, afterActiveRead), value), options);
    return { result, operations };
  };
  const state = async (packId: string) => ({
    pack: await client.packs.findUniqueOrThrow({ where: { id: packId } }),
    contents: await client.pack_contents.findMany({ where: { pack_id: packId }, orderBy: { id: "asc" } }),
    receipts: await client.pack_content_snapshots.findMany({ where: { pack_id: packId }, orderBy: { effective_at: "asc" } }),
    promotions: await client.promotion_changes.findMany({ orderBy: { sequence: "asc" } }),
    ledger: await client.promotion_ledger.findUniqueOrThrow({ where: { singleton_key: true } }),
  });
  const pack = (key: string) => client.$transaction(async tx => {
    const row = await tx.packs.create({ data: { id: randomUUID(), pack_key: key, display_name: key,
      pack_format: "repack", availability: "available", content_evidence: "unknown",
      packscout_ev_model_version: "not_calculated", packscout_ev_confidence_policy_version: "not_calculated",
      source_updated_at: sourceAt, price_amount: "25", price_currency: "USD", price_usd_amount: "25",
      attributes: { existing: "preserved" } } });
    await appendPromotionRange(tx, [{ entityType: "pack", entityId: row.id, entityVersion: 1n, operation: "upsert" }]);
    return row;
  });
  try {
    await client.$transaction(async tx => {
      await tx.collectibles.createMany({ data: cards });
      await appendPromotionRange(tx, cards.map(row => ({ entityType: "collectible", entityId: row.id, entityVersion: 1n, operation: "upsert" })));
    }, options);
    await context.test("valid partial snapshots insert and refresh 500 members; complete omission retires 1000 with bounded roundtrips", async () => {
      const p = await pack("batch:capacity");
      const first = snapshot(p.pack_key, Array.from({ length: 500 }, (_, index) => item(index)), 1, "partial");
      const initial = await apply(first);
      assert.equal(initial.result.upsertedCount, 500);
      assert.ok(initial.operations.length <= 20, `Unexpected full snapshot operation count: ${initial.operations.length}`);
      assert.equal(initial.operations.filter(value => value === "promotion_ledger.update").length, 1);
      const initialState = await state(p.id);
      const initialChanges = initialState.promotions.filter(row => row.sequence >= initial.result.promotionRange!.first);
      const byCard = new Map(initialState.contents.map(row => [row.collectible_id, row.id]));
      assert.deepEqual(initialChanges.map(row => row.entity_id), [...cards.slice(0, 500).map(row => byCard.get(row.id)), initial.result.snapshotId]);
      await apply(snapshot(p.pack_key, Array.from({ length: 500 }, (_, index) => item(index + 500)), 2, "partial"));
      const full = await state(p.id);
      assert.equal(full.contents.length, 1_000);
      assert.deepEqual(full.pack, p, "Membership changes must not alter pack EV or economics.");
      const refreshed = await apply({ ...first, effectiveAt: snapshot(p.pack_key, [], 3).effectiveAt,
        collectedAt: snapshot(p.pack_key, [], 3).collectedAt });
      assert.equal(refreshed.result.upsertedCount, 500);
      assert.ok(refreshed.operations.length <= 20);
      const beforeRemoval = await state(p.id);
      for (const row of beforeRemoval.contents) {
        const prior = full.contents.find(value => value.id === row.id)!;
        assert.deepEqual(row.created_at, prior.created_at);
        assert.equal(row.row_version, cards.slice(0, 500).some(card => card.id === row.collectible_id) ? 2n : 1n);
      }
      const removedSnapshot = snapshot(p.pack_key, [], 4);
      const removed = await apply(removedSnapshot);
      assert.equal(removed.result.retiredCount, 1_000); assert.equal(removed.result.upsertedCount, 0);
      assert.ok(removed.operations.length <= 25, `1000-member retirement used ${removed.operations.length} operations`);
      assert.equal(removed.operations.filter(value => value === "promotion_ledger.update").length, 2);
      context.diagnostic(JSON.stringify({ snapshotDatabaseOperations: { insert500: initial.operations.length,
        refresh500: refreshed.operations.length, retire1000: removed.operations.length } }));
      const after = await state(p.id), changes = after.promotions.filter(row => row.sequence >= removed.result.promotionRange!.first);
      assert.equal(changes.length, 1_001);
      assert.deepEqual(changes.slice(0, -1).map(row => row.entity_id), beforeRemoval.contents.map(row => row.id));
      assert.ok(changes.slice(0, -1).every(row => row.operation === "retire" && row.changed_at.toISOString() === removedSnapshot.effectiveAt));
      assert.equal(changes.at(-1)!.entity_id, removed.result.snapshotId);
      assert.ok(after.contents.every(row => row.lifecycle === "retired" && row.retired_at!.toISOString() === removedSnapshot.effectiveAt));
      assert.equal((await apply(removedSnapshot)).result.outcome, "replayed");
      assert.deepEqual(await state(p.id), after);
      await apply(snapshot(p.pack_key, [item(0)], 5));
      const history = (await state(p.id)).contents.filter(row => row.collectible_id === cards[0]!.id);
      assert.equal(history.length, 2); assert.equal(history.filter(row => row.lifecycle === "active").length, 1);
      assert.notEqual(history.find(row => row.lifecycle === "active")!.id, byCard.get(cards[0]!.id));
    });

    await context.test("bulk update preserves nullable values, exact decimals, large quantities and chase evidence", async () => {
      const p = await pack("batch:precision");
      await apply(snapshot(p.pack_key, [item(0), item(1)], 1));
      const value = item(0, { totalQuantity: "9007199254740993", availableQuantity: "9007199254740992",
        probability: "0.123456789012345678", statedValueAmount: "12345.123456789012345678", statedValueCurrency: "USD",
        contentRole: "top_chase", evidenceKinds: ["vendor_odds", "vendor_inventory"], matchConfidenceBasisPoints: 9_876 });
      await apply(snapshot(p.pack_key, [value, item(1)], 2));
      const after = await state(p.id), row = after.contents.find(entry => entry.collectible_id === cards[0]!.id)!;
      assert.equal(row.total_quantity, 9_007_199_254_740_993n); assert.equal(row.available_quantity, 9_007_199_254_740_992n);
      assert.equal(row.probability!.toFixed(), value.probability); assert.equal(row.stated_value_amount!.toFixed(), value.statedValueAmount);
      assert.equal(row.content_role, "top_chase"); assert.deepEqual(row.evidence_kinds, ["vendor_inventory", "vendor_odds"]);
      assert.equal(row.match_confidence_basis_points, 9_876); assert.deepEqual(after.pack, p);
      const nullable = after.contents.find(entry => entry.collectible_id === cards[1]!.id)!;
      for (const field of ["total_quantity", "available_quantity", "probability", "stated_value_amount", "stated_value_currency", "collectible_instance_id"] as const) assert.equal(nullable[field], null);
    });

    await context.test("a concurrent member version change aborts receipt, retirements and inserts without erasing the other writer", async () => {
      const p = await pack("batch:cas");
      await apply(snapshot(p.pack_key, [item(0), item(1)], 1));
      const before = await state(p.id), changed = before.contents.find(row => row.collectible_id === cards[1]!.id)!;
      let concurrent: Awaited<ReturnType<typeof state>> | undefined;
      await assert.rejects(apply(snapshot(p.pack_key, [item(1), item(2)], 2), async () => {
        await client.$transaction(async tx => {
          await tx.pack_contents.update({ where: { id: changed.id }, data: { display_order: 77, row_version: changed.row_version + 1n } });
          await appendPromotionRange(tx, [{ entityType: "pack_content", entityId: changed.id, entityVersion: changed.row_version + 1n, operation: "upsert" }]);
        }, options);
        concurrent = await state(p.id);
      }), ProviderCanonicalWriteConflictError);
      assert.ok(concurrent); assert.deepEqual(await state(p.id), concurrent);
      assert.equal((await apply(snapshot(p.pack_key, [item(1), item(2)], 2))).result.outcome, "applied");
    });

    await context.test("a later insert chunk constraint failure rolls back earlier chunks and promotion state", async () => {
      const p = await pack("batch:constraint"), before = await state(p.id);
      await client.$executeRawUnsafe(`CREATE FUNCTION fixture_reject_late_membership() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.display_order >= 100 THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'fixture_late_membership'; END IF; RETURN NEW; END; $$`);
      await client.$executeRawUnsafe(`CREATE TRIGGER fixture_reject_late_membership BEFORE INSERT ON pack_contents FOR EACH ROW EXECUTE FUNCTION fixture_reject_late_membership()`);
      const value = snapshot(p.pack_key, Array.from({ length: 200 }, (_, index) => item(index)), 1);
      try { await assert.rejects(apply(value)); assert.deepEqual(await state(p.id), before); }
      finally { await client.$executeRawUnsafe("DROP TRIGGER fixture_reject_late_membership ON pack_contents"); }
      assert.equal((await apply(value)).result.upsertedCount, 200);
    });

    await context.test("known snapshot SQL constraints quarantine only that mixed record; unknown SQL aborts the complete page", async () => {
      const p = await pack("batch:mixed-constraint");
      await apply(snapshot(p.pack_key, [item(0), item(1)], 1));
      const before = await state(p.id);
      const fixture = await prepareBatchFixture(client, "clutchpacks"), repository = new PrismaProviderMixedPageRepository(client);
      const rejected = snapshot(p.pack_key, [item(1, { displayOrder: 77 }), item(2)], 2);
      const snapshotRecord = { kind: "catalog" as const, entityType: "pack_content_snapshot" as const,
        operation: "upsert" as const, candidate: rejected as unknown as CanonicalJsonObject };
      const goodCategory = { kind: "catalog" as const, entityType: "category" as const, operation: "upsert" as const,
        candidate: { categoryKey: "after-snapshot-constraint", parentCategoryKey: null, displayName: "Later valid category" } };
      await client.$executeRawUnsafe(`CREATE FUNCTION fixture_reject_membership_update() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.display_order = 77 AND NEW.lifecycle = 'active' THEN NEW.collectible_id = '00000000-0000-4000-8000-000000000001'::uuid; END IF; RETURN NEW; END; $$`);
      await client.$executeRawUnsafe(`CREATE TRIGGER fixture_reject_membership_update BEFORE UPDATE ON pack_contents FOR EACH ROW EXECUTE FUNCTION fixture_reject_membership_update()`);
      try {
        const page = fixture.page([snapshotRecord, goodCategory]);
        const result = await repository.commit({ workerId: batchWorker, page });
        assert.equal(result.kind, "committed"); if (result.kind !== "committed") return;
        assert.deepEqual(result.counts, { records: 2, catalog: 2, pulls: 0, marketEvents: 0,
          accepted: 1, duplicate: 0, quarantined: 1, materialChanges: 1 });
        const after = await state(p.id), pageState = await batchState(client, fixture.runId);
        assert.deepEqual(after.pack, before.pack); assert.deepEqual(after.contents, before.contents);
        assert.deepEqual(after.receipts, before.receipts);
        assert.equal(after.promotions.length, before.promotions.length + 1);
        assert.equal(after.promotions.at(-1)!.entity_type, "category");
        assert.equal(pageState.runtime.source_cursor_hash, page.nextCursorFingerprint);
        assert.equal(pageState.pages.length, 1); assert.equal(pageState.quarantines.length, 1);
        assert.equal(pageState.quarantines[0]!.record_index, 0);
        assert.equal(pageState.quarantines[0]!.reason_code, "CANONICAL_CONSTRAINT_FAILED");
        assert.equal(pageState.quarantines[0]!.state, "open");
        assert.equal(pageState.outbox.filter(row => row.local_quarantine_id === pageState.quarantines[0]!.id).length, 1);
        assert.equal((await repository.commit({ workerId: batchWorker, page })).kind, "replayed");
        assert.deepEqual(await batchState(client, fixture.runId), pageState);
        const unknownPage = fixture.page([{ ...goodCategory, candidate: { ...goodCategory.candidate, categoryKey: "must-rollback" } }, snapshotRecord], 2);
        for (const sqlState of ["23514", "P0001"] as const) {
          await client.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fixture_reject_membership_update() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.display_order = 77 AND NEW.lifecycle = 'active' THEN RAISE EXCEPTION USING ERRCODE = '${sqlState}', MESSAGE = 'fixture_unknown_failure'; END IF; RETURN NEW; END; $$`);
          await assert.rejects(repository.commit({ workerId: batchWorker, page: unknownPage }), (error: unknown) => sqlState === "23514"
            ? error instanceof Prisma.PrismaClientUnknownRequestError
            : error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2010");
          assert.deepEqual(await batchState(client, fixture.runId), pageState);
          assert.deepEqual(await state(p.id), after);
        }
        await client.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION fixture_reject_membership_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$`);
        const transactionError = new Prisma.PrismaClientKnownRequestError("Synthetic unknown transaction failure", {
          code: "P2028", clientVersion: "6.19.3", meta: { error: "Synthetic non-expiration failure" } });
        let transactions = 0, injected = false;
        const operations: string[] = [];
        const database = new Proxy(client, { get(target, property, receiver) {
          if (property !== "$transaction") return Reflect.get(target, property, receiver);
          return <T>(operation: (tx: ProviderTransactionClient) => Promise<T>, selectedOptions: object) => {
            transactions += 1;
            return target.$transaction(tx => operation(observedTransaction(tx, operations, undefined, query => {
              if (!injected && query !== null && typeof query === "object" && "sql" in query && typeof query.sql === "string"
                && query.sql.includes("jsonb_to_recordset")) { injected = true; throw transactionError; }
            })), selectedOptions);
          };
        } });
        await assert.rejects(new PrismaProviderMixedPageRepository(database).commit({ workerId: batchWorker, page: unknownPage }),
          (error: unknown) => error === transactionError);
        assert.equal(injected, true); assert.equal(transactions, 1);
        assert.equal(operations.filter(value => value === "pack_contents.findFirst").length, 0, "Unknown P2028 cannot start canonical fallback.");
        assert.deepEqual(await batchState(client, fixture.runId), pageState); assert.deepEqual(await state(p.id), after);
      } finally { await client.$executeRawUnsafe("DROP TRIGGER fixture_reject_membership_update ON pack_contents"); }
    });
  } finally { await close(); }
});
