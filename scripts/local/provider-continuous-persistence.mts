import { PrismaAdminProviderRuntimeRepository, PrismaProviderWorkerLeaseRepository, lockProviderWorkerLease,
  providerWorkerLeaseIsLive, type ProviderPrismaClient, type ProviderQueryClient, type ProviderTransactionClient } from "@packscout/database";
import { backfillDigest, refuseBackfill, type BackfillPins } from "./provider-backfill-supervisor-policy.mts";
import type { BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";
import { readBackfillSnapshot } from "./provider-backfill-supervisor-state.mts";
import { readBackfillView } from "./run-provider-backfill-supervisor.mts";
import { assertContinuousCycle, assertContinuousHead, continuousCycleSchema, continuousQueueOwner as queueOwner, cyclePins, makeContinuousCycle,
  type ContinuousCycle, type ContinuousView } from "./provider-continuous-policy.mts";
import { defaultContinuousCadence, effectiveContinuousIntervalSeconds, validatedContinuousCadence,
  type ContinuousCadence } from "./provider-continuous-cadence.mts";
import { defaultContinuousPostHeadPolicy, validatedContinuousPostHeadPolicy,
  type ContinuousPostHeadPolicy } from "./provider-continuous-post-head-policy.mts";

const operationAction = "local.provider_continuous.operation";
const cycleAction = "local.provider_continuous.cycle";
const options = { isolationLevel: "Serializable" as const, maxWait: 5000, timeout: 15_000 };
const queueKey = (cycle: ContinuousCycle) => `continuous/${cycle.pins.operationId}/${cycle.parentRunId}/run`;

async function assertOperation(database: ProviderQueryClient, pins: BackfillPins, authority: BackfillAuthority, create: boolean,
  cadence: ContinuousCadence, postHeadPolicy: ContinuousPostHeadPolicy, active: () => void = () => {}) {
  const details = { version: 2, pins, authorityDigest: authority.digest, cadence: validatedContinuousCadence(cadence),
    postHeadPolicy: validatedContinuousPostHeadPolicy(postHeadPolicy),
    effectiveIntervalSeconds: effectiveContinuousIntervalSeconds(authority.scheduleSeconds, cadence) };
  const rows = await database.local_audit_events.findMany({ where: { correlation_id: pins.operationId, action: operationAction }, take: 2 });
  if (rows.length > 1 || (rows[0] && (rows[0].target_id !== pins.initialRunId || rows[0].outcome !== "success" ||
    rows[0].target_type !== "provider_run" || rows[0].actor_operator_id !== pins.operatorId ||
    backfillDigest(rows[0].details) !== backfillDigest(details)))) refuseBackfill("CONTINUOUS_OPERATION_DRIFT");
  if (create && !rows.length) { active(); await database.local_audit_events.create({ data: {
    correlation_id: pins.operationId, actor_operator_id: pins.operatorId, action: operationAction,
    target_type: "provider_run", target_id: pins.initialRunId, outcome: "success", details, occurred_at: new Date() } }); }
  return rows.length === 1 || create;
}
export async function readContinuousCycle(database: ProviderQueryClient, pins: BackfillPins, authority: BackfillAuthority,
  cadence: ContinuousCadence = defaultContinuousCadence, postHeadPolicy: ContinuousPostHeadPolicy = defaultContinuousPostHeadPolicy) {
  const row = await database.local_audit_events.findFirst({ where: { correlation_id: pins.operationId, action: cycleAction },
    orderBy: { sequence: "desc" } });
  if (!row) return null;
  const parsed = continuousCycleSchema.safeParse(row.details);
  if (!parsed.success || row.target_id !== parsed.data.parentRunId || row.outcome !== "success" ||
    row.target_type !== "provider_run" || row.actor_operator_id !== pins.operatorId) refuseBackfill("CONTINUOUS_CYCLE_DRIFT");
  assertContinuousCycle(parsed.data, pins, authority.digest, cadence, authority.scheduleSeconds, postHeadPolicy);
  return parsed.data;
}
/** Recognize a completed queue before comparing the now-advanced runtime cursor. */
export async function findContinuousQueuedRun(database: ProviderQueryClient, cycle: ContinuousCycle): Promise<boolean> {
  const command = await database.control_commands.findUnique({ where: { id: cycle.commandId } });
  const run = await database.provider_runs.findUnique({ where: { id: cycle.runId } });
  if (!command && !run) return false;
  if (!command || !run || command.command_type !== "run" || command.resulting_run_id !== run.id ||
    command.idempotency_key !== queueKey(cycle) || command.expected_generation !== BigInt(cycle.generation) ||
    command.requested_by_operator_id !== cycle.pins.operatorId || command.correlation_id !== cycle.pins.operationId ||
    !["accepted", "completed", "failed"].includes(command.state) || run.control_command_id !== command.id ||
    run.trigger !== "manual" || run.recovery_of_run_id !== null || run.requested_by_operator_id !== cycle.pins.operatorId ||
    run.config_version_id !== cycle.pins.configId || run.config_version_number !== BigInt(cycle.configNumber) ||
    run.requested_cursor_hash !== cycle.checkpointHash || backfillDigest(run.requested_cursor) !== cycle.checkpointHash) {
    refuseBackfill("CONTINUOUS_QUEUED_RUN_DRIFT");
  }
  return true;
}
async function assertLatestRun(database: ProviderQueryClient, runId: string) {
  const latest = await database.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }], select: { id: true } });
  if (latest?.id !== runId) refuseBackfill("CONTINUOUS_FOREIGN_RUN");
}
export async function readContinuousView(database: ProviderPrismaClient, pins: BackfillPins, authority: BackfillAuthority,
  cadence: ContinuousCadence = defaultContinuousCadence,
  postHeadPolicy: ContinuousPostHeadPolicy = defaultContinuousPostHeadPolicy): Promise<ContinuousView> {
  const selected = validatedContinuousCadence(cadence);
  const selectedPostHead = validatedContinuousPostHeadPolicy(postHeadPolicy);
  const operation = await assertOperation(database, pins, authority, false, selected, selectedPostHead);
  const cycle = await readContinuousCycle(database, pins, authority, selected, selectedPostHead);
  if (cycle && !operation) refuseBackfill("CONTINUOUS_OPERATION_DRIFT");
  const cycleQueued = cycle !== null && await findContinuousQueuedRun(database, cycle);
  const backfill = cycle && cycleQueued ? await readBackfillView(database, cyclePins(cycle), authority) : null;
  const snapshot = backfill?.snapshot ?? await readBackfillSnapshot(database, pins, authority, cycle?.parentRunId ?? pins.initialRunId);
  await assertLatestRun(database, snapshot.run.id);
  return { snapshot, cycle, cycleQueued, scheduleSeconds: authority.scheduleSeconds, cadence: selected,
    postHeadPolicy: selectedPostHead, authorityDigest: authority.digest,
    ownedLeaseExpiresAt: backfill?.ownedLeaseExpiresAt ?? null };
}
async function lockState(tx: ProviderTransactionClient, runId: string) {
  const lease = await lockProviderWorkerLease(tx, "import");
  await tx.$queryRaw`select id from provider_runs where id=${runId}::uuid for update`;
  await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
  return lease;
}
/** Bind a new operation before its first wait; replay never requires re-adopting
 * the original head after this same operation has queued or advanced a cycle. */
export async function persistContinuousOperation(database: ProviderPrismaClient, pins: BackfillPins,
  authority: BackfillAuthority, observed: ContinuousView, active: () => void = () => {},
  cadence: ContinuousCadence = defaultContinuousCadence,
  postHeadPolicy: ContinuousPostHeadPolicy = defaultContinuousPostHeadPolicy): Promise<void> {
  const selected = validatedContinuousCadence(cadence);
  const selectedPostHead = validatedContinuousPostHeadPolicy(postHeadPolicy);
  if (backfillDigest(observed.cadence) !== backfillDigest(selected) ||
    backfillDigest(observed.postHeadPolicy) !== backfillDigest(selectedPostHead) || observed.authorityDigest !== authority.digest) {
    refuseBackfill("CONTINUOUS_OPERATION_DRIFT");
  }
  active();
  await database.$transaction(async tx => {
    await lockState(tx, observed.snapshot.run.id);
    if (await assertOperation(tx, pins, authority, false, selected, selectedPostHead)) return;
    if (await readContinuousCycle(tx, pins, authority, selected, selectedPostHead)) refuseBackfill("CONTINUOUS_OPERATION_DRIFT");
    const snapshot = await readBackfillSnapshot(tx, pins, authority, pins.initialRunId);
    await assertLatestRun(tx, snapshot.run.id);
    assertContinuousHead(snapshot, pins, authority.configNumber);
    if (snapshot.run.id !== observed.snapshot.run.id || snapshot.generation !== observed.snapshot.generation ||
      snapshot.checkpointHash !== observed.snapshot.checkpointHash) refuseBackfill("CONTINUOUS_CHECKPOINT_CHANGED");
    await assertOperation(tx, pins, authority, true, selected, selectedPostHead, active);
  }, options);
}
export async function persistContinuousCycle(database: ProviderPrismaClient, pins: BackfillPins,
  authority: BackfillAuthority, observed: ContinuousView, active: () => void = () => {},
  cadence: ContinuousCadence = defaultContinuousCadence,
  postHeadPolicy: ContinuousPostHeadPolicy = defaultContinuousPostHeadPolicy): Promise<ContinuousCycle> {
  const selected = validatedContinuousCadence(cadence);
  const selectedPostHead = validatedContinuousPostHeadPolicy(postHeadPolicy);
  if (backfillDigest(observed.cadence) !== backfillDigest(selected) ||
    backfillDigest(observed.postHeadPolicy) !== backfillDigest(selectedPostHead) || observed.authorityDigest !== authority.digest) {
    refuseBackfill("CONTINUOUS_OPERATION_DRIFT");
  }
  active();
  return database.$transaction(async tx => {
    await lockState(tx, observed.snapshot.run.id);
    const operation = await assertOperation(tx, pins, authority, false, selected, selectedPostHead);
    const previous = await readContinuousCycle(tx, pins, authority, selected, selectedPostHead);
    if (previous && !operation) refuseBackfill("CONTINUOUS_OPERATION_DRIFT");
    if (previous?.parentRunId === observed.snapshot.run.id) return previous;
    if (backfillDigest(previous) !== backfillDigest(observed.cycle)) refuseBackfill("CONTINUOUS_CYCLE_DRIFT");
    const snapshot = await readBackfillSnapshot(tx, pins, authority, observed.snapshot.run.id);
    await assertLatestRun(tx, snapshot.run.id);
    if (snapshot.generation !== observed.snapshot.generation || snapshot.checkpointHash !== observed.snapshot.checkpointHash) {
      refuseBackfill("CONTINUOUS_CHECKPOINT_CHANGED");
    }
    const cycle = makeContinuousCycle({ ...observed, snapshot, authorityDigest: authority.digest,
      scheduleSeconds: authority.scheduleSeconds, cadence: selected, postHeadPolicy: selectedPostHead }, pins);
    await assertOperation(tx, pins, authority, true, selected, selectedPostHead, active);
    active();
    await tx.local_audit_events.create({ data: { correlation_id: pins.operationId, actor_operator_id: pins.operatorId,
      action: cycleAction, target_type: "provider_run", target_id: cycle.parentRunId, outcome: "success",
      details: cycle, occurred_at: snapshot.now } });
    return cycle;
  }, options);
}
async function assertQueueCheckpoint(database: ProviderQueryClient, authority: BackfillAuthority, cycle: ContinuousCycle,
  cadence: ContinuousCadence, postHeadPolicy: ContinuousPostHeadPolicy, held?: { owner: string; fence: bigint }) {
  assertContinuousCycle(cycle, cycle.pins, authority.digest, cadence, authority.scheduleSeconds, postHeadPolicy);
  if (!await assertOperation(database, cycle.pins, authority, false, cadence, postHeadPolicy)) refuseBackfill("CONTINUOUS_OPERATION_DRIFT");
  const s = await readBackfillSnapshot(database, cycle.pins, authority, cycle.parentRunId);
  await assertLatestRun(database, cycle.parentRunId);
  const own = s.lease.owner === queueOwner(cycle) && s.lease.expiresAt !== null &&
    (held ? s.lease.fence === held.fence && s.lease.expiresAt > s.now : s.lease.expiresAt <= s.now);
  if (s.lease.owner !== null && !own) refuseBackfill("CONTINUOUS_LEASE_UNAVAILABLE");
  assertContinuousHead(own ? { ...s, lease: { ...s.lease, owner: null, expiresAt: null } } : s, cycle.pins, authority.configNumber);
  if (s.generation !== BigInt(cycle.generation) || s.checkpointHash !== cycle.checkpointHash ||
    s.run.finishedAt?.toISOString() !== cycle.headFinishedAt || Date.parse(cycle.notBefore) > s.now.getTime() ||
    backfillDigest(await readContinuousCycle(database, cycle.pins, authority, cadence, postHeadPolicy)) !== backfillDigest(cycle)) {
    refuseBackfill("CONTINUOUS_CHECKPOINT_CHANGED");
  }
  return s;
}
/** Receipt precedes lease acquisition. Resume is deliberately absent: only idle
 * head is eligible, never paused/stopped/failed. Queue copies the current cursor. */
export async function queueContinuousCycle(input: { database: ProviderPrismaClient; cycle: ContinuousCycle;
  readAuthority: () => Promise<BackfillAuthority>;
  cadence?: ContinuousCadence;
  postHeadPolicy?: ContinuousPostHeadPolicy;
  active?: () => void;
  commands?: Pick<PrismaAdminProviderRuntimeRepository, "requestRunNow"> }) {
  const { database, cycle } = input;
  const cadence = validatedContinuousCadence(input.cadence);
  const postHeadPolicy = validatedContinuousPostHeadPolicy(input.postHeadPolicy === undefined
    ? defaultContinuousPostHeadPolicy : input.postHeadPolicy);
  const active = input.active ?? (() => {});
  active();
  const authority = await input.readAuthority();
  assertContinuousCycle(cycle, cycle.pins, authority.digest, cadence, authority.scheduleSeconds, postHeadPolicy);
  if (!await assertOperation(database, cycle.pins, authority, false, cadence, postHeadPolicy) ||
    backfillDigest(await readContinuousCycle(database, cycle.pins, authority, cadence, postHeadPolicy)) !== backfillDigest(cycle)) {
    refuseBackfill("CONTINUOUS_OPERATION_DRIFT");
  }
  if (await findContinuousQueuedRun(database, cycle)) {
    // A crash after queue acknowledgement may leave only this receipt's short
    // utility lease. Wait for normal expiry, fence it normally, then release.
    const snapshot = await database.$transaction(async tx => {
      await lockState(tx, cycle.runId);
      const s = await readBackfillSnapshot(tx, cycle.pins, authority, cycle.runId);
      if (s.lease.owner !== queueOwner(cycle)) return null;
      if (s.lease.expiresAt === null || s.lease.expiresAt > s.now || s.state !== "idle" || s.run.state !== "queued" ||
        s.activeRunIds.length !== 1 || s.activeRunIds[0] !== cycle.runId ||
        s.actionableCommands.some(command => command.id !== cycle.commandId || command.runId !== cycle.runId) ||
        s.generation !== BigInt(cycle.generation) || s.checkpointHash !== cycle.checkpointHash ||
        backfillDigest(await readContinuousCycle(tx, cycle.pins, authority, cadence, postHeadPolicy)) !== backfillDigest(cycle)) {
        refuseBackfill("CONTINUOUS_LEASE_UNAVAILABLE");
      }
      return s;
    }, options);
    if (snapshot) {
      const leases = new PrismaProviderWorkerLeaseRepository(database);
      active();
      const claim = await leases.acquire({ role: "import", owner: queueOwner(cycle), leaseMilliseconds: 120_000 });
      if (claim.kind === "held") refuseBackfill("CONTINUOUS_LEASE_UNAVAILABLE");
      try { if (claim.lease.fence !== snapshot.lease.fence + 1n) refuseBackfill("CONTINUOUS_LEASE_UNAVAILABLE"); }
      finally { await leases.release(claim.lease); }
    }
    return;
  }
  const before = await database.$transaction(async tx => {
    await lockState(tx, cycle.parentRunId);
    return assertQueueCheckpoint(tx, authority, cycle, cadence, postHeadPolicy);
  }, options);
  const leases = new PrismaProviderWorkerLeaseRepository(database);
  active();
  const acquired = await leases.acquire({ role: "import", owner: queueOwner(cycle), leaseMilliseconds: 120_000 });
  if (acquired.kind === "held") refuseBackfill("CONTINUOUS_LEASE_UNAVAILABLE");
  try {
    if (acquired.lease.fence !== before.lease.fence + 1n) refuseBackfill("CONTINUOUS_LEASE_UNAVAILABLE");
    const fresh = await input.readAuthority();
    await database.$transaction(async tx => {
      const lease = await lockState(tx, cycle.parentRunId);
      if (!providerWorkerLeaseIsLive(lease, acquired.lease)) refuseBackfill("CONTINUOUS_LEASE_UNAVAILABLE");
      await assertQueueCheckpoint(tx, fresh, cycle, cadence, postHeadPolicy, acquired.lease);
    }, options);
    const commands = input.commands ?? new PrismaAdminProviderRuntimeRepository(database);
    active();
    const result = await commands.requestRunNow({ providerId: cycle.pins.providerId, operatorId: cycle.pins.operatorId,
      expectedConfigVersionId: cycle.pins.configId, expectedConfigVersionNumber: BigInt(cycle.configNumber),
      expectedGeneration: BigInt(cycle.generation), expectedCursorFingerprint: cycle.checkpointHash, requireNoActiveRun: true,
      expectedImportLease: acquired.lease,
      idempotencyKey: queueKey(cycle), commandId: cycle.commandId, runId: cycle.runId, correlationId: cycle.pins.operationId });
    if ((result.kind !== "created" && result.kind !== "deduplicated") || result.run.id !== cycle.runId ||
      result.run.requestedCursorHash !== cycle.checkpointHash) refuseBackfill("CONTINUOUS_QUEUE_REFUSED");
    if (!await findContinuousQueuedRun(database, cycle)) refuseBackfill("CONTINUOUS_QUEUE_REFUSED");
  } finally { await leases.release(acquired.lease); }
}
