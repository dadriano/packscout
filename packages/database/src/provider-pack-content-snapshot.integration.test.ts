import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { providerPackContentSnapshotV1Schema, type ProviderPackContentSnapshotV1, type ProviderPackContentSnapshotItemV1 } from "@packscout/contracts";
import { Prisma } from "../prisma/generated/provider/index.js";
import { ProviderCanonicalInputError, ProviderCanonicalWriteConflictError } from "./provider-canonical-contract.ts";
import { appendPromotionRange, createProviderCanonicalTransaction } from "./provider-canonical-repository.ts";
import { applyProviderMixedPageRecord } from "./provider-mixed-page-candidates.ts";
import { assertRecordShape } from "./provider-mixed-page-shape.ts";
import { applyProviderPackContentSnapshot, providerPackContentSnapshotDigest } from "./provider-pack-content-snapshot-repository.ts";
import { createMembershipHarness, postgresBinDirectory } from "./provider-pack-content-snapshot.test-support.ts";

const providerId = randomUUID();
const sourceAt = new Date("2026-08-30T12:00:00.000Z");
function item(collectibleKey: string, changes: Partial<ProviderPackContentSnapshotItemV1> = {}): ProviderPackContentSnapshotItemV1 {
  return {
    collectibleKey, collectibleInstanceKey: null, status: "present", totalQuantity: null,
    availableQuantity: null, contentRole: "possible_outcome", probability: null,
    statedValueAmount: null, statedValueCurrency: null, evidenceKinds: ["vendor_inventory"],
    matchConfidenceBasisPoints: 10_000, displayOrder: 0, ...changes,
  };
}
function snapshot(packKey: string, items: ProviderPackContentSnapshotV1["items"], minute = 1): ProviderPackContentSnapshotV1 {
  const instant = new Date(sourceAt.getTime() + minute * 60_000).toISOString();
  return {
    schemaVersion: "provider_pack_content_snapshot_v1", providerId, packKey, sourceKey: "provider:inventory:v1",
    sourceAdapterVersion: "adapter-1", mapperVersion: "1", effectiveAt: instant,
    effectiveAtBasis: "response_observed_at", collectedAt: instant, completeness: "complete", items,
  };
}

test("membership reconciliation is atomic, source-ordered and restartable in real PostgreSQL", async (context) => {
  const bin = await postgresBinDirectory();
  if (bin === null) { context.skip("PostgreSQL is required for a socket-only membership database."); return; }
  const { client, close } = await createMembershipHarness(bin, providerId);
  const options = { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 };
  const apply = (value: ProviderPackContentSnapshotV1) => client.$transaction((tx) => applyProviderPackContentSnapshot(tx, value), options);
  const rows = (packId: string) => client.pack_contents.findMany({ where: { pack_id: packId }, orderBy: { id: "asc" } });
  const head = async () => (await client.promotion_ledger.findUniqueOrThrow({ where: { singleton_key: true } })).last_sequence;
  async function pack(key: string) {
    return client.$transaction(async (tx) => {
      const row = await tx.packs.create({ data: {
        id: randomUUID(), pack_key: key, display_name: key, pack_format: "repack", availability: "available",
        content_evidence: "unknown", packscout_ev_model_version: "not_calculated",
        packscout_ev_confidence_policy_version: "not_calculated", source_updated_at: sourceAt,
        attributes: { existing: "preserved" }, price_amount: "25", price_currency: "USD", price_usd_amount: "25",
      } });
      await appendPromotionRange(tx, [{ entityType: "pack", entityId: row.id, entityVersion: 1n, operation: "upsert" }]);
      return row;
    });
  }
  try {
    const cards = await client.$transaction(async (tx) => {
      const created = [];
      for (const key of ["card:a", "card:b", "card:c"]) {
        const row = await tx.collectibles.create({ data: {
          id: randomUUID(), collectible_key: key, collectible_type: "card", display_name: key,
          normalized_name: key, data_as_of: sourceAt,
        } });
        created.push(row);
        await appendPromotionRange(tx, [{ entityType: "collectible", entityId: row.id, entityVersion: 1n, operation: "upsert" }]);
      }
      return created;
    });

    await context.test("first application publishes receipt and links; same source replay cannot renew them", async () => {
      const p = await pack("pack:replay");
      const original = snapshot(p.pack_key, [item("card:a"), item("card:b", { displayOrder: 1 })]);
      const before = await head();
      const applied = await apply(original);
      assert.equal(applied.outcome, "applied");
      assert.equal(applied.upsertedCount, 2);
      assert.deepEqual(applied.promotionRange, { first: before + 1n, last: before + 3n });
      const retained = await rows(p.id);
      assert.ok(retained.every((row) => row.source_snapshot_id === applied.snapshotId));
      const receipt = await client.pack_content_snapshots.findUniqueOrThrow({ where: { id: applied.snapshotId! } });
      const proof = providerPackContentSnapshotV1Schema.parse(receipt.normalized_snapshot);
      assert.equal(proof.sourceAdapterVersion, original.sourceAdapterVersion);
      assert.equal(proof.mapperVersion, original.mapperVersion);
      assert.equal(providerPackContentSnapshotDigest(proof), receipt.snapshot_digest);
      const after = await head();
      const replayed = await apply({ ...original, items: [...original.items].reverse(), collectedAt: "2026-08-30T13:00:00.000Z" });
      assert.equal(replayed.outcome, "replayed");
      assert.equal(await head(), after);
      assert.deepEqual(await rows(p.id), retained);
      assert.deepEqual(await client.pack_content_snapshots.findUniqueOrThrow({ where: { id: receipt.id } }), receipt);
      assert.deepEqual(await client.packs.findUniqueOrThrow({ where: { id: p.id } }), p);
      await assert.rejects(apply({ ...original, items: [item("card:c")] }), ProviderCanonicalWriteConflictError);
      await assert.rejects(apply({ ...original, sourceAdapterVersion: "adapter-2" }), ProviderCanonicalWriteConflictError);
      await assert.rejects(apply({ ...original, mapperVersion: "2" }), ProviderCanonicalWriteConflictError);
      for (const key of ["sourceAdapterVersion", "mapperVersion"]) {
        const missingVersion = Object.fromEntries(Object.entries(proof).filter(([name]) => name !== key));
        const nextAt = new Date(receipt.effective_at.getTime() + 60_000);
        await assert.rejects(client.pack_content_snapshots.create({ data: {
          ...receipt, id: randomUUID(), effective_at: nextAt, collected_at: nextAt,
          normalized_snapshot: missingVersion as Prisma.InputJsonObject,
        } }), /pack_content_snapshots_version_identity_check/);
      }
      assert.equal(await head(), after);
    });

    await context.test("partial omissions preserve proof while explicit removal and complete omission retire", async () => {
      const p = await pack("pack:partial");
      const first = await apply(snapshot(p.pack_key, [item("card:a"), item("card:b")]));
      await apply({ ...snapshot(p.pack_key, [item("card:c")], 2), completeness: "partial" });
      let active = (await rows(p.id)).filter((row) => row.lifecycle === "active");
      assert.equal(active.length, 3);
      assert.equal(active.find((row) => row.collectible_id === cards[0]!.id)?.source_snapshot_id, first.snapshotId);
      await apply({ ...snapshot(p.pack_key, [item("card:a", { status: "removed" })], 3), completeness: "partial" });
      assert.equal((await rows(p.id)).filter((row) => row.lifecycle === "active").length, 2);
      await apply(snapshot(p.pack_key, [item("card:c")], 4));
      active = (await rows(p.id)).filter((row) => row.lifecycle === "active");
      assert.equal(active.length, 1);
      assert.equal(active[0]!.collectible_id, cards[2]!.id);
      const old = await apply(snapshot(p.pack_key, [item("card:a"), item("card:b")], 1));
      assert.equal(old.outcome, "ignored_older");
      await apply(snapshot(p.pack_key, [item("card:a")], 5));
      const history = (await rows(p.id)).filter((row) => row.collectible_id === cards[0]!.id);
      assert.equal(history.length, 2);
      assert.equal(history.filter((row) => row.lifecycle === "retired").length, 1);
    });

    await context.test("newer canonical source excludes historical initial attachment and stale refresh", async () => {
      const p = await pack("pack:source-bound");
      const old = await apply(snapshot(p.pack_key, [item("card:a")], -1));
      assert.equal(old.outcome, "ignored_older");
      assert.equal(await client.pack_content_snapshots.count({ where: { pack_id: p.id } }), 0);
      const initial = snapshot(p.pack_key, [item("card:a")], 1);
      await apply(initial);
      await client.$transaction(async (tx) => {
        await tx.packs.update({ where: { id: p.id }, data: { source_updated_at: new Date(sourceAt.getTime() + 10 * 60_000), row_version: 2n } });
        await appendPromotionRange(tx, [{ entityType: "pack", entityId: p.id, entityVersion: 2n, operation: "upsert" }]);
      });
      assert.equal((await apply(initial)).outcome, "replayed");
      assert.equal((await apply(snapshot(p.pack_key, [item("card:b")], 2))).outcome, "ignored_older");
      assert.equal((await rows(p.id))[0]!.collectible_id, cards[0]!.id);
    });

    await context.test("unresolved and cross-provider references cannot partially erase membership", async () => {
      const p = await pack("pack:invalid");
      await client.$transaction((tx) => createProviderCanonicalTransaction(tx).upsertCollectibleInstance({
        instanceKey: "instance:card-b", collectibleId: cards[1]!.id, certifier: null, certificationNumber: null, attributes: {},
      }));
      await apply(snapshot(p.pack_key, [item("card:a")]));
      const previous = await rows(p.id);
      const previousHead = await head();
      for (const value of [
        snapshot(p.pack_key, [item("card:b"), item("card:missing")], 2),
        { ...snapshot(p.pack_key, [], 2), providerId: randomUUID() },
        snapshot(p.pack_key, [item("card:a", { collectibleInstanceKey: "missing-instance" })], 2),
        snapshot(p.pack_key, [item("card:a", { collectibleInstanceKey: "instance:card-b" })], 2),
      ]) await assert.rejects(apply(value), ProviderCanonicalInputError);
      assert.deepEqual(await rows(p.id), previous);
      assert.equal(await head(), previousHead);
    });

    await context.test("complete empty and zero quantity snapshots produce honest removals", async () => {
      const p = await pack("pack:empty");
      const empty = await apply(snapshot(p.pack_key, []));
      assert.equal(empty.promotionRange!.last, empty.promotionRange!.first);
      await apply(snapshot(p.pack_key, [item("card:a")], 2));
      await apply({ ...snapshot(p.pack_key, [item("card:a", { availableQuantity: "0" })], 3), completeness: "partial" });
      assert.equal((await rows(p.id)).filter((row) => row.lifecycle === "active").length, 0);
    });

    await context.test("concurrent duplicate application is serialized once", async () => {
      const p = await pack("pack:concurrent");
      const value = snapshot(p.pack_key, [item("card:a")]);
      const outcomes = await Promise.all([apply(value), apply(value)]);
      assert.deepEqual(outcomes.map((result) => result.outcome).sort(), ["applied", "replayed"]);
      assert.equal((await rows(p.id)).length, 1);
      assert.equal(await client.pack_content_snapshots.count({ where: { pack_id: p.id } }), 1);
    });

    await context.test("immutable receipts, exact promotion proof and same-pack source binding are enforced", async () => {
      const p = await pack("pack:constraints");
      const other = await pack("pack:other");
      const result = await apply(snapshot(p.pack_key, [item("card:a")]));
      const receipt = await client.pack_content_snapshots.findUniqueOrThrow({ where: { id: result.snapshotId! } });
      await assert.rejects(client.pack_content_snapshots.update({ where: { id: receipt.id }, data: { completeness: "partial" } }), /append_only/);
      await assert.rejects(client.pack_content_snapshots.delete({ where: { id: receipt.id } }), /append_only/);
      await assert.rejects(client.pack_content_snapshots.create({ data: {
        ...receipt, normalized_snapshot: receipt.normalized_snapshot as Prisma.InputJsonObject,
        id: randomUUID(), effective_at: new Date(sourceAt.getTime() + 99 * 60_000), collected_at: new Date(sourceAt.getTime() + 99 * 60_000),
      } }), /snapshot_write_requires_promotion_change/);
      const row = (await rows(p.id))[0]!;
      await assert.rejects(client.pack_contents.create({ data: { ...row, id: randomUUID() } }), (error: unknown) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002");
      await assert.rejects(client.pack_contents.create({ data: { ...row, id: randomUUID(), pack_id: other.id } }), /foreign key|Foreign key/i);
    });

    await context.test("the mixed-page catalog boundary accepts only atomic upsert snapshots", async () => {
      const p = await pack("pack:mixed");
      const record = {
        position: 0, providerId, kind: "catalog" as const, operation: "upsert" as const,
        entityType: "pack_content_snapshot" as const, candidate: snapshot(p.pack_key, [item("card:a")]),
      };
      assertRecordShape(record, 0);
      assert.throws(() => assertRecordShape({ ...record, operation: "retire" }, 0));
      const result = await client.$transaction((tx) => applyProviderMixedPageRecord(tx, createProviderCanonicalTransaction(tx), record));
      assert.deepEqual(result, { duplicate: false, materialChange: true });
      assert.equal((await rows(p.id)).length, 1);
    });

    await context.test("a bounded 500-card snapshot commits and replays without partial state", async () => {
      const p = await pack("pack:capacity");
      const records = Array.from({ length: 500 }, (_, index) => ({
        id: randomUUID(), collectible_key: `capacity:${index}`, collectible_type: "card" as const,
        display_name: `Capacity ${index}`, normalized_name: `capacity ${index}`, data_as_of: sourceAt,
      }));
      await client.$transaction(async (tx) => {
        await tx.collectibles.createMany({ data: records });
        await appendPromotionRange(tx, records.map((row) => ({ entityType: "collectible", entityId: row.id, entityVersion: 1n, operation: "upsert" })));
      });
      const value = snapshot(p.pack_key, records.map((row, index) => item(row.collectible_key, { displayOrder: index })));
      const result = await apply(value);
      assert.equal(result.upsertedCount, 500);
      assert.equal((await rows(p.id)).length, 500);
      const currentHead = await head();
      assert.equal((await apply(value)).outcome, "replayed");
      assert.equal(await head(), currentHead);
    });
  } finally { await close(); }
});
