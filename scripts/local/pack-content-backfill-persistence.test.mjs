import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const { PROVIDER_OBSERVATION_CONTRACT_VERSION, providerPackEvEvidenceV1Schema } =
  await tsImport("@packscout/contracts", import.meta.url);
const { createMembershipHarness, postgresBinDirectory } = await tsImport(
  "../../packages/database/src/provider-pack-content-snapshot.test-support.ts", import.meta.url,
);
const { PrismaProviderRunRepository, PrismaProviderRuntimeRepository, PrismaProviderWorkerLeaseRepository,
  createProviderCanonicalTransaction, appendPromotionRange, providerMixedCursorFingerprint } =
  await tsImport("@packscout/database", import.meta.url);
const { applyPackContentBackfill, readPackContentBackfillBoundary } =
  await tsImport("./pack-content-backfill-persistence.mts", import.meta.url);
const { packContentBackfillDigest, PACK_CONTENT_BACKFILL_START_ACTION, PACK_CONTENT_BACKFILL_PACK_ACTION,
  PACK_CONTENT_BACKFILL_ACTION } = await tsImport("./pack-content-backfill-contract.mts", import.meta.url);

async function fixture(bin) {
  const providerId = randomUUID(); const operatorId = randomUUID();
  const harness = await createMembershipHarness(bin, providerId);
  const db = harness.client;
  try {
    const sourceAt = new Date(Date.now() - 60_000);
    const packs = await db.$transaction(async tx => {
      const card = await tx.collectibles.create({ data: { id: randomUUID(), collectible_key: "card:known",
        collectible_type: "card", display_name: "Known card", normalized_name: "known card", data_as_of: sourceAt } });
      await appendPromotionRange(tx, [{ entityType: "collectible", entityId: card.id, entityVersion: 1n, operation: "upsert" }]);
      const result = [];
      for (const key of ["pack:a", "pack:b"]) {
        const row = await tx.packs.create({ data: { id: randomUUID(), pack_key: key, display_name: key,
          pack_format: "repack", availability: "available", content_evidence: "unknown", source_updated_at: sourceAt,
          price_amount: "25", price_currency: "USD", price_usd_amount: "25", buyback_rate: "0.9",
          buyback_source_kind: "provider_statement", packscout_ev_model_version: "not_calculated",
          packscout_ev_confidence_policy_version: "not_calculated", attributes: { evInputEvidence: {
            schemaVersion: "provider_pack_ev_evidence_v1", organizationId: operatorId, providerId,
            providerKey: "clutchpacks", providerRecordId: key.slice(5), recordIdScopeKey: "catalog-pack-v1",
            sourceTypeKey: "dataforrest-events-v1", sourceAdapterVersion: "dataforrest-clutchpacks-distributed-adapter-v1",
            normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION, mapperKey: "clutchpacks-provider-observation",
            mapperVersion: "1", identityNamespaceKey: "dataforrest-clutchpacks-records-v1",
            effectiveAt: sourceAt.toISOString(), collectedAt: sourceAt.toISOString(),
            price: { state: "present", value: { amount: 25, currency: "USD" } },
            buybackPercent: { state: "present", value: 90 }, drawCount: { state: "present", value: 1 },
            evInput: { state: "present", value: { approved: true, currency: "USD", unitBasis: "per_pack",
              drawCount: 1, buybackPercent: 90, totalQuantity: 1,
              buckets: [{ bucketId: "one", label: "One", probability: 1, quantity: 1, lowerValue: 20, upperValue: 30 }] } },
          } } } });
        result.push(row);
        await appendPromotionRange(tx, [{ entityType: "pack", entityId: row.id, entityVersion: 1n, operation: "upsert" }]);
      }
      await createProviderCanonicalTransaction(tx).insertPull({ pullKey: "pull:retained", factDigest: "a".repeat(64),
        packKey: result[0].pack_key, packId: result[0].id, providerAccountId: null, occurredAt: sourceAt,
        paidAmount: "25", paidCurrency: "USD", items: [{ collectibleKey: card.collectible_key, collectibleId: card.id,
          collectibleInstanceId: null, quantity: 1n, statedValueAmount: "20", statedValueCurrency: "USD" }] });
      return result;
    });
    for (const row of packs) providerPackEvEvidenceV1Schema.parse(row.attributes.evInputEvidence);
    const runtime = new PrismaProviderRuntimeRepository(db);
    const configVersionId = randomUUID(); const owner = "test:membership-backfill";
    assert.equal((await runtime.synchronizeConfiguration({ centralProviderId: providerId, providerKey: "clutchpacks",
      configVersionId, configVersionNumber: 1n, configuration: { adapter: "reviewed" }, expiresAt: null,
      scheduleSeconds: 3600, nextDueAt: null, synchronizedAt: new Date() })).kind, "updated");
    const leases = new PrismaProviderWorkerLeaseRepository(db);
    const acquired = await leases.acquire({ role: "import", owner, leaseMilliseconds: 300_000 });
    assert.equal(acquired.kind, "acquired"); const lease = acquired.lease;
    const runs = new PrismaProviderRunRepository(db);
    const runId = randomUUID();
    // Seed a historical, request-unmanaged run without inventing an HTTP receipt.
    assert.equal((await runs.start({ runId, idempotencyKey: "fixture:head", trigger: "scheduled",
      requestedByOperatorId: null, configVersionId, configVersionNumber: 1n, workerId: owner,
      workerFence: lease.fence, correlationId: randomUUID(), requestedAt: new Date(),
      requestSettingsPolicy: "unmanaged" })).kind, "started");
    const cursor = { opaque: "protected-fixture-checkpoint-do-not-log" };
    assert.equal((await runs.commitPage({ pageId: randomUUID(), runId, workerId: owner, workerFence: lease.fence,
      contractVersion: "fixture-page-v1", requestedCursor: null, requestedCursorHash: null,
      nextCursor: cursor, nextCursorHash: providerMixedCursorFingerprint(cursor), continuation: "head",
      responseDigest: "b".repeat(64), counts: { records: 0, catalog: 0, pulls: 0, marketEvents: 0,
        accepted: 0, duplicate: 0, quarantined: 0, materialChanges: 0 }, committedAt: new Date(),
      requestSettingsPolicy: "unmanaged" })).kind, "committed");
    assert.equal((await runs.finish({ runId, workerId: owner, workerFence: lease.fence, state: "succeeded",
      failureCode: null, failureClass: null, failureSummary: null, correlationId: randomUUID(), finishedAt: new Date() })).kind, "finished");
    const capturedAt = new Date().toISOString();
    const manifest = { schemaVersion: "provider_pack_content_backfill_manifest_v1", operationId: randomUUID(),
      organizationId: randomUUID(), operatorId, ...await readPackContentBackfillBoundary(db), capturedAt,
      snapshots: packs.map(row => ({ schemaVersion: "provider_pack_content_snapshot_v1", providerId,
        packKey: row.pack_key, sourceKey: "provider:inventory:v1", sourceAdapterVersion: "adapter-1", mapperVersion: "1",
        effectiveAt: capturedAt, effectiveAtBasis: "response_observed_at", collectedAt: capturedAt, completeness: "complete",
        items: [{ collectibleKey: "card:known", collectibleInstanceKey: null, status: "present", totalQuantity: null,
          availableQuantity: null, contentRole: "possible_outcome", probability: null, statedValueAmount: null,
          statedValueCurrency: null, evidenceKinds: ["vendor_inventory"], matchConfidenceBasisPoints: 10000, displayOrder: 0 }] })),
      responseHashes: packs.map(row => ({ packKey: row.pack_key, sha256: "c".repeat(64) })) };
    const preserved = async () => ({ packs: await db.packs.findMany({ orderBy: { id: "asc" } }),
      pulls: await db.pulls.findMany({ orderBy: { id: "asc" } }), pullItems: await db.pull_items.findMany({ orderBy: { id: "asc" } }),
      runtime: await db.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
      runs: await db.provider_runs.findMany({ orderBy: { id: "asc" } }), quarantines: await db.quarantine_records.findMany() });
    const audits = () => db.local_audit_events.findMany({ where: { correlation_id: manifest.operationId }, orderBy: { sequence: "asc" } });
    const execute = (changes = {}) => applyPackContentBackfill({ database: db, manifest, lease, revalidateAuthority: async () => {}, ...changes });
    return { ...harness, db, manifest, lease, runtime, runs, execute, preserved, audits };
  } catch (error) { await harness.close(); throw error; }
}

test("catalog-only backfill checkpoints are fenced, resumable and preserve the event import", async context => {
  const bin = await postgresBinDirectory();
  if (!bin) { context.skip("PostgreSQL is required for a socket-only backfill database."); return; }
  await context.test("authority loss between packs resumes exactly; completed replay makes no writes", async () => {
    const f = await fixture(bin);
    try {
      const before = await f.preserved(); let calls = 0;
      await assert.rejects(f.execute({ revalidateAuthority: async () => { if (++calls === 3) throw new Error("AUTHORITY_CHANGED"); } }), /AUTHORITY_CHANGED/);
      assert.equal(await f.db.pack_contents.count(), 1);
      assert.deepEqual((await f.audits()).map(row => row.action), [PACK_CONTENT_BACKFILL_START_ACTION, PACK_CONTENT_BACKFILL_PACK_ACTION]);
      assert.deepEqual(await f.preserved(), before);
      const completed = await f.execute(); assert.equal(completed.replayed, false);
      assert.equal(await f.db.pack_contents.count(), 2);
      const audits = await f.audits(); const changes = await f.db.promotion_changes.findMany({ orderBy: { sequence: "asc" } });
      assert.equal(audits.filter(row => row.action === PACK_CONTENT_BACKFILL_ACTION).length, 1);
      const replay = await f.execute(); assert.equal(replay.replayed, true);
      assert.deepEqual(replay.receipt, completed.receipt);
      assert.deepEqual(await f.audits(), audits);
      assert.deepEqual(await f.db.promotion_changes.findMany({ orderBy: { sequence: "asc" } }), changes);
      assert.deepEqual(await f.preserved(), before);
      assert.equal(JSON.stringify(audits, (_key, value) => typeof value === "bigint" ? String(value) : value).includes("protected-fixture-checkpoint"), false);
    } finally { await f.close(); }
  });

  await context.test("foreign fence, changed pins and changed cursor refuse before any backfill writes", async () => {
    const f = await fixture(bin);
    try {
      const before = await f.preserved();
      for (const changes of [
        { lease: { ...f.lease, owner: "foreign-worker" } }, { lease: { ...f.lease, fence: f.lease.fence + 1n } },
        { manifest: { ...f.manifest, sourceGeneration: "999" } },
        { manifest: { ...f.manifest, configVersionId: randomUUID() } },
        { manifest: { ...f.manifest, sourceCheckpointHash: "d".repeat(64) } },
      ]) await assert.rejects(f.execute(changes), /PACK_CONTENT_BACKFILL_STATE_CHANGED/);
      assert.deepEqual(await f.preserved(), before);
      await f.db.provider_runtime.update({ where: { singleton_key: true }, data: {
        source_cursor: { opaque: "changed-checkpoint" }, source_cursor_hash: providerMixedCursorFingerprint({ opaque: "changed-checkpoint" }),
        row_version: { increment: 1n },
      } });
      await assert.rejects(f.execute(), /PACK_CONTENT_BACKFILL_STATE_CHANGED/);
      assert.equal((await f.audits()).length, 0); assert.equal(await f.db.pack_contents.count(), 0);
    } finally { await f.close(); }
  });

  await context.test("a changed manifest or runtime generation cannot resume a partial backfill", async () => {
    const f = await fixture(bin);
    try {
      let calls = 0;
      await assert.rejects(f.execute({ revalidateAuthority: async () => { if (++calls === 3) throw new Error("STOP"); } }), /STOP/);
      const before = await f.audits();
      await assert.rejects(f.execute({ manifest: { ...f.manifest, responseHashes: f.manifest.responseHashes.map(row => ({ ...row, sha256: "e".repeat(64) })) } }), /PACK_CONTENT_BACKFILL_STATE_CHANGED/);
      let generation = BigInt(f.manifest.sourceGeneration);
      for (const to of ["paused", "idle"]) {
        assert.equal((await f.runtime.transition({ expectedGeneration: generation++, to, reason: to === "paused" ? "test_pause" : null,
          actorType: "operator", actorId: "test:operator", actorOperatorId: f.manifest.operatorId,
          correlationId: randomUUID(), occurredAt: new Date() })).kind, "transitioned");
      }
      await assert.rejects(f.execute(), /PACK_CONTENT_BACKFILL_STATE_CHANGED/);
      assert.deepEqual(await f.audits(), before); assert.equal(await f.db.pack_contents.count(), 1);
    } finally { await f.close(); }
  });

  await context.test("a later incomplete run is not mistaken for the previous successful head", async () => {
    const f = await fixture(bin);
    try {
      const runId = randomUUID();
      assert.equal((await f.runs.start({ runId, idempotencyKey: "fixture:incomplete", trigger: "scheduled", requestedByOperatorId: null,
        configVersionId: f.manifest.configVersionId, configVersionNumber: BigInt(f.manifest.configVersionNumber),
        workerId: f.lease.owner, workerFence: f.lease.fence, correlationId: randomUUID(), requestedAt: new Date(),
        requestSettingsPolicy: "unmanaged" })).kind, "started");
      assert.equal((await f.runs.finish({ runId, workerId: f.lease.owner, workerFence: f.lease.fence, state: "incomplete",
        failureCode: "TEST_INTERRUPTION", failureClass: "worker", failureSummary: "Test incomplete run",
        correlationId: randomUUID(), finishedAt: new Date() })).kind, "finished");
      await assert.rejects(readPackContentBackfillBoundary(f.db), /PACK_CONTENT_BACKFILL_STATE_CHANGED/);
      assert.equal(await f.db.pack_contents.count(), 0);
    } finally { await f.close(); }
  });

  await context.test("a failed start audit cannot masquerade as a resumable successful operation", async () => {
    const f = await fixture(bin);
    try {
      await f.db.local_audit_events.create({ data: { correlation_id: f.manifest.operationId,
        actor_operator_id: randomUUID(), action: PACK_CONTENT_BACKFILL_START_ACTION, target_type: "provider",
        target_id: f.manifest.providerId, outcome: "failure", details: { manifestDigest: packContentBackfillDigest(f.manifest) }, occurred_at: new Date() } });
      await assert.rejects(f.execute(), /PACK_CONTENT_BACKFILL_STATE_CHANGED/);
      assert.equal((await f.audits()).length, 1); assert.equal(await f.db.pack_contents.count(), 0);
    } finally { await f.close(); }
  });
});
