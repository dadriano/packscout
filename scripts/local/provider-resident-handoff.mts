import { z } from "zod";
import { lockProviderWorkerLease, providerMixedPageDigest,
  type ProviderPrismaClient, type ProviderQueryClient } from "@packscout/database";
import { backfillDigest, backfillId, backfillPinsSchema, refuseBackfill, type BackfillPins } from "./provider-backfill-supervisor-policy.mts";
import type { BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";
import type { BackfillView } from "./provider-backfill-supervisor.mts";
import { readBackfillSnapshot } from "./provider-backfill-supervisor-state.mts";
import { readBackfillView } from "./run-provider-backfill-supervisor.mts";
import { assertContinuousHead } from "./provider-continuous-policy.mts";

const action = "local.provider_resident.handoff";
const releaseAction = "local.provider_resident.release";
const schema = z.object({ pins: backfillPinsSchema, authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  headRunId: z.string().uuid(), checkpointHash: z.string().regex(/^[a-f0-9]{64}$/u),
  generation: z.string().regex(/^(0|[1-9][0-9]*)$/u), continuousOperationId: z.string().uuid(),
  createdAt: z.string().datetime(),
}).strict();
export type ResidentHandoff = z.infer<typeof schema>;
const releaseSchema = z.object({ schemaVersion: z.literal(1), pins: backfillPinsSchema,
  authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u), headRunId: z.string().uuid(),
  handoffDigest: z.string().regex(/^[a-f0-9]{64}$/u), resumedReceiptDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  releasedAt: z.string().datetime(),
}).strict();
export type ResidentRelease = z.infer<typeof releaseSchema>;
export const residentContinuousPins = (handoff: ResidentHandoff): BackfillPins => ({ ...handoff.pins,
  initialRunId: handoff.headRunId, operationId: handoff.continuousOperationId });
export type ResidentBootstrapView = { handoff: ResidentHandoff; backfill: null }
  | { handoff: null; backfill: BackfillView }
  | { handoff: null; backfill: null; awaitingInitialRun: true };

export async function readResidentHandoff(database: ProviderQueryClient, pins: BackfillPins,
  authority: BackfillAuthority): Promise<ResidentHandoff | null> {
  const rows = await database.local_audit_events.findMany({ where: { correlation_id: pins.operationId, action }, take: 2 });
  if (!rows.length) return null;
  const row = rows[0]!;
  const parsed = schema.safeParse(row.details);
  if (rows.length !== 1 || !parsed.success || row.outcome !== "success" || row.target_id !== parsed.data.headRunId ||
    row.actor_operator_id !== pins.operatorId || backfillDigest(parsed.data.pins) !== backfillDigest(pins) ||
    parsed.data.authorityDigest !== authority.digest ||
    parsed.data.continuousOperationId !== backfillId(pins.operationId, "resident/continuous")) refuseBackfill("CONTINUOUS_HANDOFF_DRIFT");
  return parsed.data;
}
export async function readResidentRelease(database: ProviderQueryClient, pins: BackfillPins,
  authority: BackfillAuthority, handoff: ResidentHandoff,
  resumedReceiptDigest?: string): Promise<ResidentRelease | null> {
  const rows = await database.local_audit_events.findMany({
    where: { correlation_id: pins.operationId, action: releaseAction }, take: 2,
  });
  if (!rows.length) return null;
  const row = rows[0]!;
  const parsed = releaseSchema.safeParse(row.details);
  if (rows.length !== 1 || !parsed.success || row.outcome !== "success" ||
    row.target_type !== "provider_run" || row.target_id !== handoff.headRunId ||
    row.actor_operator_id !== pins.operatorId ||
    backfillDigest(parsed.data.pins) !== backfillDigest(pins) ||
    parsed.data.authorityDigest !== authority.digest || parsed.data.headRunId !== handoff.headRunId ||
    parsed.data.handoffDigest !== backfillDigest(handoff) ||
    (resumedReceiptDigest !== undefined && parsed.data.resumedReceiptDigest !== resumedReceiptDigest)) {
    refuseBackfill("CONTINUOUS_RELEASE_DRIFT");
  }
  return parsed.data;
}
export async function readResidentBootstrapView(database: ProviderPrismaClient, pins: BackfillPins,
  authority: BackfillAuthority, awaitInitialRun = false): Promise<ResidentBootstrapView> {
  const handoff = await readResidentHandoff(database, pins, authority);
  if (handoff) {
    if (!awaitInitialRun || await readResidentRelease(database, pins, authority, handoff)) {
      return { handoff, backfill: null };
    }
    return { handoff: null, backfill: null, awaitingInitialRun: true };
  }
  if (awaitInitialRun) {
    const awaiting = await database.$transaction(async tx => {
      const lease = await lockProviderWorkerLease(tx, "import");
      await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
      const [run, runtime, activeRuns, commands] = await Promise.all([
        tx.provider_runs.findUnique({ where: { id: pins.initialRunId } }),
        tx.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
        tx.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
        tx.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
      ]);
      if (run) return false;
      if (runtime.central_provider_id !== pins.providerId || runtime.provider_key !== pins.providerKey ||
        runtime.operating_state !== "paused" || runtime.cached_config_version_id !== pins.configId ||
        runtime.cached_config_version_number !== authority.configNumber ||
        providerMixedPageDigest(runtime.cached_configuration) !==
          providerMixedPageDigest(authority.cachedConfiguration) ||
        runtime.source_cursor === null || runtime.source_cursor_hash === null ||
        providerMixedPageDigest(runtime.source_cursor) !== runtime.source_cursor_hash ||
        activeRuns !== 0 || commands !== 0 || lease.lease_owner !== null ||
        lease.heartbeat_at !== null || lease.lease_expires_at !== null) {
        refuseBackfill("CONTINUOUS_INITIAL_RUN_WAIT_BOUNDARY_CHANGED");
      }
      return true;
    }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 15_000 });
    if (awaiting) return { handoff: null, backfill: null, awaitingInitialRun: true };
  }
  return { handoff: null, backfill: await readBackfillView(database, pins, authority) };
}

/** Immutable handoff is committed before any continuous receipt or command. A
 * restart uses these original head pins even after many newer poll cycles. */
export async function persistResidentHandoff(database: ProviderPrismaClient, pins: BackfillPins,
  authority: BackfillAuthority, observed: BackfillView, active: () => void = () => {}): Promise<ResidentHandoff> {
  active();
  if (observed.authorityDigest !== authority.digest) refuseBackfill("CONTINUOUS_HANDOFF_AUTHORITY_CHANGED");
  return database.$transaction(async tx => {
    await lockProviderWorkerLease(tx, "import");
    await tx.$queryRaw`select id from provider_runs where id=${observed.snapshot.run.id}::uuid for update`;
    await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
    const existing = await readResidentHandoff(tx, pins, authority);
    if (existing) return existing;
    const snapshot = await readBackfillSnapshot(tx, pins, authority, observed.snapshot.run.id);
    assertContinuousHead(snapshot, pins, authority.configNumber);
    const latest = await tx.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }], select: { id: true } });
    if (latest?.id !== snapshot.run.id || snapshot.generation !== observed.snapshot.generation ||
      snapshot.checkpointHash !== observed.snapshot.checkpointHash) refuseBackfill("CONTINUOUS_HANDOFF_HEAD_CHANGED");
    const handoff = schema.parse({ pins, authorityDigest: authority.digest, headRunId: snapshot.run.id,
      checkpointHash: snapshot.checkpointHash, generation: snapshot.generation.toString(),
      continuousOperationId: backfillId(pins.operationId, "resident/continuous"), createdAt: snapshot.now.toISOString() });
    active();
    await tx.local_audit_events.create({ data: { correlation_id: pins.operationId, actor_operator_id: pins.operatorId,
      action, target_type: "provider_run", target_id: handoff.headRunId, outcome: "success", details: handoff,
      occurred_at: snapshot.now } });
    return handoff;
  }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 15_000 });
}

/** The catalog bridge writes this exact release only after its public resumed
 * journal receipt is durable. Until then an awaited resident may not poll. */
export async function persistResidentRelease(database: ProviderPrismaClient, pins: BackfillPins,
  authority: BackfillAuthority, resumedReceiptDigest: string,
  active: () => void = () => {}): Promise<ResidentRelease | null> {
  active();
  if (!/^[a-f0-9]{64}$/u.test(resumedReceiptDigest)) refuseBackfill("CONTINUOUS_RELEASE_DRIFT");
  return database.$transaction(async tx => {
    await lockProviderWorkerLease(tx, "import");
    const handoff = await readResidentHandoff(tx, pins, authority);
    if (!handoff) return null;
    await tx.$queryRaw`select id from provider_runs where id=${handoff.headRunId}::uuid for update`;
    await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
    const existing = await readResidentRelease(tx, pins, authority, handoff, resumedReceiptDigest);
    if (existing) return existing;
    const snapshot = await readBackfillSnapshot(tx, pins, authority, handoff.headRunId);
    assertContinuousHead(snapshot, pins, authority.configNumber);
    const latest = await tx.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }],
      select: { id: true } });
    if (latest?.id !== handoff.headRunId || snapshot.generation.toString() !== handoff.generation ||
      snapshot.checkpointHash !== handoff.checkpointHash) refuseBackfill("CONTINUOUS_RELEASE_HEAD_CHANGED");
    const release = releaseSchema.parse({ schemaVersion: 1, pins, authorityDigest: authority.digest,
      headRunId: handoff.headRunId, handoffDigest: backfillDigest(handoff), resumedReceiptDigest,
      releasedAt: snapshot.now.toISOString() });
    active();
    await tx.local_audit_events.create({ data: { correlation_id: pins.operationId,
      actor_operator_id: pins.operatorId, action: releaseAction, target_type: "provider_run",
      target_id: release.headRunId, outcome: "success", details: release,
      occurred_at: snapshot.now } });
    return release;
  }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 15_000 });
}
