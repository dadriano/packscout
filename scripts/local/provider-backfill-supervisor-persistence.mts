import { PrismaProviderWorkerLeaseRepository, lockProviderWorkerLease, providerWorkerLeaseIsLive,
  type ProviderPrismaClient, type ProviderQueryClient, type ProviderTransactionClient, type ProviderWorkerLease } from "@packscout/database";
import { assertBackfillLeaseAvailable, assertBackfillPins, backfillDigest,
  classifyBackfillCheckpoint, createBackfillIntent, refuseBackfill,
  type BackfillIntent, type BackfillPins, type BackfillSnapshot } from "./provider-backfill-supervisor-policy.mts";
import { backfillAuditAction, currentBackfillRunId, readBackfillIntent, readBackfillSnapshot } from "./provider-backfill-supervisor-state.mts";
import type { BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";

const transactionOptions = { isolationLevel: "Serializable" as const, maxWait: 5000, timeout: 15_000 };
/** Process death releases the local socket, not a surviving child's DB lease.
 * Prove the exact operation's live claim before waiting; this grants no write. */
export async function readOwnedBackfillLeaseExpiry(database: ProviderQueryClient, pins: BackfillPins,
  authority: BackfillAuthority, snapshot: BackfillSnapshot): Promise<Date | null> {
  const lease = snapshot.lease;
  if (lease.owner === null || lease.expiresAt === null) return null;
  const row = await database.local_audit_events.findFirst({ where: { correlation_id: pins.operationId,
    action: "local.provider_backfill.execution_claim", details: { path: ["owner"], equals: lease.owner } },
    orderBy: { sequence: "desc" } });
  const details = row?.details;
  if (!row || row.outcome !== "success" || row.actor_operator_id !== pins.operatorId || row.target_type !== "provider_run" ||
    !details || typeof details !== "object" || Array.isArray(details) || details.owner !== lease.owner ||
    details.fence !== lease.fence.toString() || details.authorityDigest !== authority.digest ||
    await currentBackfillRunId(database, row.target_id) !== snapshot.run.id) return null;
  return lease.expiresAt;
}
async function lockState(tx: ProviderTransactionClient, runId: string) {
  const lease = await lockProviderWorkerLease(tx, "import");
  await tx.$queryRaw`select id from provider_runs where id=${runId}::uuid for update`;
  await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
  return lease;
}

export async function assertBackfillOperation(database: ProviderPrismaClient, pins: BackfillPins,
  authority: BackfillAuthority, create: boolean, active: () => void = () => {}): Promise<void> {
  const details = { pins, authorityDigest: authority.digest };
  const inspect = async (client: ProviderPrismaClient | ProviderTransactionClient) => {
    const rows = await client.local_audit_events.findMany({ where: { correlation_id: pins.operationId,
      action: "local.provider_backfill.operation" }, take: 2 });
    const row = rows[0];
    if (rows.length > 1 || (row && (row.target_id !== pins.initialRunId || row.outcome !== "success" ||
      backfillDigest(row.details) !== backfillDigest(details)))) refuseBackfill("BACKFILL_OPERATION_DRIFT");
    return row;
  };
  if (!create) { await inspect(database); return; }
  await database.$transaction(async (tx) => {
    await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
    if (!await inspect(tx)) { active(); await tx.local_audit_events.create({ data: { correlation_id: pins.operationId,
      actor_operator_id: pins.operatorId, action: "local.provider_backfill.operation", target_type: "provider_run",
      target_id: pins.initialRunId, outcome: "success", details, occurred_at: new Date() } }); }
  }, transactionOptions);
}

export async function persistBackfillIntent(database: ProviderPrismaClient, pins: BackfillPins,
  authority: BackfillAuthority, snapshot: BackfillSnapshot, previous: BackfillIntent | null, jitter: number,
  active: () => void = () => {}) {
  active();
  return database.$transaction(async (tx) => {
    await lockState(tx, snapshot.run.id);
    const current = await readBackfillSnapshot(tx, pins, authority, snapshot.run.id);
    assertBackfillPins(current, pins, authority.configNumber);
    const existing = await readBackfillIntent(tx, pins);
    if (existing?.parentRunId === current.run.id) return existing;
    if (backfillDigest(existing) !== backfillDigest(previous) || current.generation !== snapshot.generation ||
      current.checkpointHash !== snapshot.checkpointHash || current.lease.owner !== null) refuseBackfill("BACKFILL_INTENT_STATE_CHANGED");
    const intent = createBackfillIntent({ pins, authorityDigest: authority.digest, snapshot: current, previous, jitter });
    if (intent.kind === "page_bound_continuation" && await tx.local_audit_events.findFirst({ where: {
      correlation_id: pins.operationId, action: backfillAuditAction,
      details: { path: ["checkpointHash"], equals: intent.checkpointHash },
    }, select: { sequence: true } })) refuseBackfill("BACKFILL_CHECKPOINT_CYCLE");
    active();
    await tx.local_audit_events.create({ data: { correlation_id: pins.operationId, actor_operator_id: pins.operatorId, action: backfillAuditAction,
      target_type: "provider_run", target_id: current.run.id, outcome: "success", details: intent, occurred_at: current.now } });
    return intent;
  }, transactionOptions);
}

export async function claimBackfillExecution(database: ProviderPrismaClient, pins: BackfillPins,
  authority: BackfillAuthority, snapshot: BackfillSnapshot, owner: string, active: () => void = () => {},
  requireHead = false): Promise<ProviderWorkerLease> {
  active();
  await database.$transaction(async (tx) => {
    await lockState(tx, snapshot.run.id);
    const current = await readBackfillSnapshot(tx, pins, authority, snapshot.run.id);
    assertBackfillPins(current, pins, authority.configNumber);
    if (current.generation !== snapshot.generation || current.checkpointHash !== snapshot.checkpointHash ||
      current.lease.owner !== snapshot.lease.owner || current.lease.fence !== snapshot.lease.fence ||
      current.state === "paused" || current.state === "stopped") refuseBackfill("BACKFILL_EXECUTION_STATE_CHANGED");
    const oldClaim = current.lease.owner === null ? null : await tx.local_audit_events.findFirst({
      where: { correlation_id: pins.operationId, action: "local.provider_backfill.execution_claim",
        details: { path: ["owner"], equals: current.lease.owner } }, orderBy: { sequence: "desc" }, select: { details: true },
    });
    const details = oldClaim?.details;
    const allowed = details && typeof details === "object" && !Array.isArray(details) &&
      details.fence === current.lease.fence.toString() && details.authorityDigest === authority.digest
      ? new Set([current.lease.owner!]) : new Set<string>();
    assertBackfillLeaseAvailable(current, allowed);
    if (requireHead && (current.lease.owner === null ||
      classifyBackfillCheckpoint({ ...current, lease: { ...current.lease, owner: null, expiresAt: null } }) !== "head")) {
      refuseBackfill("BACKFILL_HEAD_LEASE_CHANGED");
    }
    // Persist before acquire: a crash in the acquire→child gap is still attributable.
    active();
    await tx.local_audit_events.create({ data: { correlation_id: pins.operationId,
      actor_operator_id: pins.operatorId, action: "local.provider_backfill.execution_claim", target_type: "provider_run",
      target_id: current.run.id, outcome: "success", details: { owner, fence: (current.lease.fence + 1n).toString(),
        authorityDigest: authority.digest }, occurred_at: current.now } });
  }, transactionOptions);
  const leases = new PrismaProviderWorkerLeaseRepository(database);
  active();
  const acquired = await leases.acquire({ role: "import", owner, leaseMilliseconds: 300_000 });
  if (acquired.kind === "held") refuseBackfill("BACKFILL_LEASE_UNAVAILABLE");
  if (acquired.lease.fence !== snapshot.lease.fence + 1n) {
    await leases.release({ role: "import", owner, fence: acquired.lease.fence });
    refuseBackfill("BACKFILL_LEASE_CHANGED");
  }
  return acquired.lease;
}

/** A terminal head may retain its own expired lease after process death. Use
 * normal acquire/release and preserve every run/page/cursor; never force-clear. */
export async function releaseExpiredBackfillHeadLease(database: ProviderPrismaClient, pins: BackfillPins,
  authority: BackfillAuthority, snapshot: BackfillSnapshot, owner: string, active: () => void = () => {}) {
  const expiry = await readOwnedBackfillLeaseExpiry(database, pins, authority, snapshot);
  if (!expiry || expiry > snapshot.now ||
    classifyBackfillCheckpoint({ ...snapshot, lease: { ...snapshot.lease, owner: null, expiresAt: null } }) !== "head") {
    refuseBackfill("BACKFILL_HEAD_LEASE_CHANGED");
  }
  active();
  const lease = await claimBackfillExecution(database, pins, authority, snapshot, owner, active, true);
  await new PrismaProviderWorkerLeaseRepository(database).release(lease);
}

export async function assertBackfillRetryPinned(database: ProviderPrismaClient, authority: BackfillAuthority,
  intent: BackfillIntent, lease: ProviderWorkerLease, resumed: boolean): Promise<void> {
  await database.$transaction(async (tx) => {
    const owned = await lockState(tx, intent.parentRunId);
    const current = await readBackfillSnapshot(tx, intent.pins, authority, intent.parentRunId);
    assertBackfillPins(current, intent.pins, authority.configNumber);
    if (!providerWorkerLeaseIsLive(owned, lease) || current.state !== (resumed ? "idle" : "error") ||
      current.generation !== BigInt(intent.generation) + (resumed ? 1n : 0n) ||
      current.checkpointHash !== intent.checkpointHash || current.run.state !== "failed" ||
      current.run.failureCode !== intent.failureCode || !current.run.finalMatches ||
      current.run.finalHash !== intent.checkpointHash || current.activeRunIds.length || current.actionableCommands.length ||
      classifyBackfillCheckpoint({ ...current, state: "error" }) !== intent.kind) refuseBackfill("BACKFILL_RETRY_PIN_CHANGED");
  }, transactionOptions);
}
