import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tsImport } from "tsx/esm/api";
const db = await tsImport("@packscout/database", import.meta.url);
const { createMembershipHarness, postgresBinDirectory } = await tsImport(
  "../../packages/database/src/provider-pack-content-snapshot.test-support.ts", import.meta.url);
const { failedHeadReviewSchema, failedHeadDigest: digest, failedHeadIds, failedHeadAction: action } =
  await tsImport("./provider-failed-head-policy.mts", import.meta.url);
const { failedHeadResumeGuard } = await tsImport("./provider-failed-head-guard.mts", import.meta.url);
export { db, digest, failedHeadResumeGuard, postgresBinDirectory };

/** Real run/command/lease lifecycle; only prior operator authorization is fixture data. */
export async function failedHeadPostgresFixture(bin) {
  const providerId = randomUUID(), configId = randomUUID(), operatorId = randomUUID(), priorOperationId = randomUUID();
  const harness = await createMembershipHarness(bin, providerId), { client } = harness;
  const leases = new db.PrismaProviderWorkerLeaseRepository(client), runs = new db.PrismaProviderRunRepository(client);
  const commands = new db.PrismaProviderCommandRepository(client), admin = new db.PrismaAdminProviderRuntimeRepository(client);
  const cursor = { fixture: "immutable-completed-head" }, hash = db.providerMixedCursorFingerprint(cursor);
  const runtime = () => client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
  const evidence = row => ({ sequence: row.sequence.toString(), digest: digest(row) });
  const readRun = id => client.provider_runs.findUniqueOrThrow({ where: { id } });
  const readCommand = id => client.control_commands.findUniqueOrThrow({ where: { id } });
  const audit = (correlationId, auditAction, targetType, targetId, details, actor = operatorId) =>
    client.local_audit_events.create({ data: { correlation_id: correlationId, actor_operator_id: actor,
      action: auditAction, target_type: targetType, target_id: targetId, outcome: "success", details, occurred_at: new Date() } });
  const acquire = async owner => {
    const result = await leases.acquire({ role: "import", owner, leaseMilliseconds: 120_000 });
    assert.equal(result.kind, "acquired"); return result.lease;
  };
  const release = async lease => assert.equal(await leases.release({ role: "import", owner: lease.owner, fence: lease.fence }), true);
  const startQueued = async (runId, commandId, correlationId, lease) => {
    const queued = await readRun(runId);
    assert.equal(queued.state, "queued");
    const result = await runs.start({ runId, idempotencyKey: queued.idempotency_key, trigger: "manual",
      requestedByOperatorId: operatorId, configVersionId: configId, configVersionNumber: 4n,
      workerId: lease.owner, workerFence: lease.fence, correlationId, requestedAt: queued.requested_at, controlCommandId: commandId });
    assert.equal(result.kind, "started");
  };
  const finish = async (runId, lease, state) => {
    const failed = state === "failed";
    const result = await runs.finish({ runId, workerId: lease.owner, workerFence: lease.fence, state,
      failureCode: failed ? "DATABASE_TRANSACTION_INVALID" : null, failureClass: failed ? "database" : null,
      failureSummary: failed ? "Synthetic no-page failure" : null, correlationId: randomUUID(), finishedAt: new Date() });
    assert.equal(result.kind, "finished");
  };
  const queue = async (ids, operationId, held) => {
    const current = await runtime();
    const result = await admin.requestRunNow({ providerId, operatorId, expectedConfigVersionId: configId,
      expectedConfigVersionNumber: 4n, expectedGeneration: current.state_generation, idempotencyKey: ids.runKey,
      commandId: ids.command, runId: ids.run, correlationId: operationId, expectedCursorFingerprint: hash,
      requireNoActiveRun: true, ...(held ? { expectedImportLease: { owner: held.owner, fence: held.fence } } : {}) });
    assert.equal(result.kind, "created");
  };
  try {
    await client.provider_runtime.update({ where: { singleton_key: true }, data: {
      cached_config_version_id: configId, cached_config_version_number: 4n,
      cached_configuration: { fixture: true }, schedule_seconds: 300, last_control_sync_at: new Date(),
      source_cursor: cursor, source_cursor_hash: hash, row_version: { increment: 1n } } });
    const headId = randomUUID(), headPageId = randomUUID(), headLease = await acquire("fixture:head");
    assert.equal((await runs.start({ runId: headId, idempotencyKey: `fixture/${headId}`, trigger: "manual",
      requestedByOperatorId: operatorId, configVersionId: configId, configVersionNumber: 4n,
      workerId: headLease.owner, workerFence: headLease.fence, correlationId: randomUUID(), requestedAt: new Date() })).kind, "started");
    assert.equal((await runs.commitPage({ pageId: headPageId, runId: headId, workerId: headLease.owner,
      workerFence: headLease.fence, contractVersion: "provider_mixed_page_v1", requestedCursor: cursor,
      requestedCursorHash: hash, nextCursor: cursor, nextCursorHash: hash, continuation: "head", responseDigest: "a".repeat(64),
      counts: { records: 0, catalog: 0, pulls: 0, marketEvents: 0, accepted: 0, duplicate: 0, quarantined: 0, materialChanges: 0 },
      committedAt: new Date() })).kind, "committed");
    await audit(randomUUID(), "provider.run.head_reconciliation", "provider_run", headId, { schemaVersion: 1,
      headPageId, configVersionId: configId, checkpointHash: hash, leaseFence: headLease.fence.toString(), batchNumber: 1,
      phase: "complete", packAfterId: null, collectibleAfterId: null, packScanDone: true, collectibleScanDone: true,
      quarantineAfterId: null, quarantineAfterAt: null });
    await finish(headId, headLease, "succeeded"); await release(headLease);
    const rootIds = { run: randomUUID(), command: randomUUID(), runKey: `fixture/root/${randomUUID()}` };
    await queue(rootIds, priorOperationId);
    const rootLease = await acquire("fixture:root");
    await startQueued(rootIds.run, rootIds.command, priorOperationId, rootLease);
    await finish(rootIds.run, rootLease, "failed"); await release(rootLease);
    const root = await readRun(rootIds.run), prior = await readRun(headId), rootCommand = await readCommand(rootIds.command);
    const headProof = await db.readProviderRunHeadProof(client, headId); assert.ok(headProof?.reconciliationComplete);
    // Immutable prior operator authorization is independently pinned. The two
    // failures and their command/start/finish history are never hand-built.
    const adoptionResume = await client.control_commands.create({ data: { id: randomUUID(), idempotency_key: `fixture/adoption/${randomUUID()}`,
      command_type: "resume", state: "completed", expected_generation: 1n, requested_by_operator_id: operatorId,
      correlation_id: priorOperationId, requested_at: root.requested_at, acknowledged_at: root.started_at, completed_at: root.started_at,
      result: { outcome: "accepted", code: "RUNTIME_TRANSITION_APPLIED", generation: "2" } } });
    const provenance = {};
    for (const [name, verb] of [["adoption", "provider.paused_head.adoption"], ["adoptionCompleted", "provider.paused_head.adoption.completed"],
      ["operation", "local.provider_continuous.operation"], ["cycle", "local.provider_continuous.cycle"]]) {
      provenance[name] = evidence(await audit(priorOperationId, verb, "provider_run", headId, { runId: root.id }));
    }
    provenance.adoptionResume = { id: adoptionResume.id, digest: digest(adoptionResume) };
    const initial = await runtime(), operationId = randomUUID();
    const target = { host: "provider.example.test", port: 5432, databaseName: "packscout_clutchpacks", sslMode: "verify-full" };
    const previousReview = failedHeadReviewSchema.parse({ version: 1, authorization: "operator_requested_zero_commit_head_continuation",
      pins: { organizationId: randomUUID(), providerId, providerKey: "clutchpacks", configId, initialRunId: root.id, operationId, operatorId },
      sourceCommit: "a".repeat(40), central: { ...target, host: "central.example.test", databaseName: "packscout" }, provider: target,
      migrationProofPath: "/synthetic/migration.json", migrationProofDigest: "b".repeat(64), authorityDigest: "c".repeat(64),
      priorOperationId, priorHeadRunId: headId, priorHeadRunDigest: digest(prior), priorHeadProofDigest: digest(headProof), provenance,
      configNumber: "4", generation: initial.state_generation.toString(), runtimeRowVersion: initial.row_version.toString(),
      importFence: rootLease.fence.toString(), checkpointHash: hash, parentDigest: digest(root), parentCommandDigest: digest(rootCommand),
      failureCode: root.failure_code, finishedAt: root.finished_at.toISOString() });
    const ids = failedHeadIds(previousReview), receipt = { version: 1, review: previousReview,
      historyDigest: digest({ root, prior }), sourceRequestsPerformed: false, automaticRetryPolicyChanged: false };
    const receiptRow = await audit(operationId, action, "provider_run", root.id, receipt), held = await acquire(ids.owner);
    const claim = await audit(operationId, `${action}.lease_claimed`, "provider_run", root.id,
      { owner: ids.owner, fence: held.fence.toString(), receiptDigest: digest(receipt) });
    const resumeResult = await commands.submit({ commandId: ids.resume, commandType: "resume", expectedGeneration: initial.state_generation,
      targetRunId: null, targetQuarantineId: null, idempotencyKey: ids.resumeKey, requestedByOperatorId: operatorId,
      correlationId: operationId, reason: null, requestedAt: new Date(), expectedRuntimeGuard:
        failedHeadResumeGuard(previousReview, cursor, { owner: held.owner, fence: held.fence }) });
    assert.equal(resumeResult.outcome, "accepted");
    await queue(ids, operationId, held);
    const completed = await audit(operationId, `${action}.completed`, "provider_run", root.id,
      { receiptDigest: digest(receipt), resumeCommandId: ids.resume, runId: ids.run, commandId: ids.command });
    await release(held);
    const beforeStart = await client.local_audit_events.findMany({ orderBy: { sequence: "asc" } });
    const workerLease = await acquire("fixture:continuation");
    await startQueued(ids.run, ids.command, operationId, workerLease);
    await finish(ids.run, workerLease, "failed"); await release(workerLease);
    const leaf = await readRun(ids.run), command = await readCommand(ids.command), current = await runtime();
    const audits = await client.local_audit_events.findMany({ where: { correlation_id: operationId }, orderBy: { sequence: "asc" } });
    const find = verb => audits.find(row => row.action === verb);
    const resume = await readCommand(ids.resume);
    const review = failedHeadReviewSchema.parse({ ...previousReview, version: 2,
      authorization: "operator_requested_two_failure_head_continuation", previousReview,
      pins: { ...previousReview.pins, initialRunId: leaf.id, operationId: randomUUID() },
      generation: current.state_generation.toString(), runtimeRowVersion: current.row_version.toString(), importFence: workerLease.fence.toString(),
      parentDigest: digest(leaf), parentCommandDigest: digest(command), failureCode: leaf.failure_code, finishedAt: leaf.finished_at.toISOString(),
      chain: { receipt: evidence(receiptRow), completed: evidence(completed), leaseClaim: evidence(claim),
        resumeGuard: evidence(find("provider.runtime.resume_guard")), requested: evidence(find("provider.run.requested")),
        resume: { id: resume.id, digest: digest(resume) } } });
    assert.deepEqual(await readRun(root.id), root); assert.deepEqual(await readRun(prior.id), prior);
    assert.deepEqual(await readCommand(rootCommand.id), rootCommand);
    assert.deepEqual((await client.local_audit_events.findMany({ orderBy: { sequence: "asc" } })).slice(0, beforeStart.length), beforeStart);
    return { ...harness, review, previousReview, ids, cursor, hash, root, prior, leaf, command, audits, runtime, acquire, release };
  } catch (error) { await harness.close(); throw error; }
}
