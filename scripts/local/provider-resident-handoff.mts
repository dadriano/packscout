import { z } from "zod";
import { lockProviderWorkerLease, type ProviderPrismaClient, type ProviderQueryClient } from "@packscout/database";
import { backfillDigest, backfillId, backfillPinsSchema, refuseBackfill, type BackfillPins } from "./provider-backfill-supervisor-policy.mts";
import type { BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";
import type { BackfillView } from "./provider-backfill-supervisor.mts";
import { readBackfillSnapshot } from "./provider-backfill-supervisor-state.mts";
import { readBackfillView } from "./run-provider-backfill-supervisor.mts";
import { assertContinuousHead } from "./provider-continuous-policy.mts";

const action = "local.provider_resident.handoff";
const schema = z.object({ pins: backfillPinsSchema, authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  headRunId: z.string().uuid(), checkpointHash: z.string().regex(/^[a-f0-9]{64}$/u),
  generation: z.string().regex(/^(0|[1-9][0-9]*)$/u), continuousOperationId: z.string().uuid(),
  createdAt: z.string().datetime(),
}).strict();
export type ResidentHandoff = z.infer<typeof schema>;
export const residentContinuousPins = (handoff: ResidentHandoff): BackfillPins => ({ ...handoff.pins,
  initialRunId: handoff.headRunId, operationId: handoff.continuousOperationId });
export type ResidentBootstrapView = { handoff: ResidentHandoff; backfill: null }
  | { handoff: null; backfill: BackfillView };

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
export async function readResidentBootstrapView(database: ProviderPrismaClient, pins: BackfillPins,
  authority: BackfillAuthority): Promise<ResidentBootstrapView> {
  const handoff = await readResidentHandoff(database, pins, authority);
  return handoff ? { handoff, backfill: null } : { handoff: null, backfill: await readBackfillView(database, pins, authority) };
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
