import { z } from "zod";
import { lockProviderWorkerLease, providerWorkerLeaseIsLive,
  type ProviderPrismaClient, type ProviderQueryClient, type ProviderWorkerLease } from "@packscout/database";
import { assertBackfillPins, backfillDelayMilliseconds, backfillDigest, classifyBackfillCheckpoint,
  refuseBackfill, type BackfillPins, type BackfillSnapshot } from "./provider-backfill-supervisor-policy.mts";
import { currentBackfillRunId, readBackfillSnapshot } from "./provider-backfill-supervisor-state.mts";
import type { BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";

const launchSchema = z.object({ runId: z.string().uuid(), anchorRunId: z.string().uuid(), owner: z.string().min(1).max(256),
  fence: z.string().regex(/^[1-9][0-9]*$/u), generation: z.string().regex(/^(0|[1-9][0-9]*)$/u),
  state: z.enum(["queued", "running"]), authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type BackfillLaunch = z.infer<typeof launchSchema>;
const restartSchema = launchSchema.extend({ kind: z.literal("closed_child_restart"),
  checkpointHash: z.string().regex(/^[a-f0-9]{64}$/u),
  consecutiveNoProgress: z.number().int().positive(), notBefore: z.string().datetime(),
}).strict();
export type BackfillRestart = z.infer<typeof restartSchema>;
const action = "local.provider_backfill.closed_child_restart";
const transactionOptions = { isolationLevel: "Serializable" as const, maxWait: 5000, timeout: 15_000 };

export async function readBackfillRestart(database: ProviderQueryClient, pins: BackfillPins,
  authority: BackfillAuthority): Promise<BackfillRestart | null> {
  const row = await database.local_audit_events.findFirst({ where: { correlation_id: pins.operationId, action },
    orderBy: { sequence: "desc" } });
  if (!row) return null;
  const parsed = restartSchema.safeParse(row.details);
  if (!parsed.success || row.target_id !== parsed.data.runId || row.outcome !== "success" ||
    parsed.data.authorityDigest !== authority.digest) refuseBackfill("BACKFILL_RESTART_RECEIPT_INVALID");
  return parsed.data;
}

export function backfillRestartApplies(restart: BackfillRestart | null, snapshot: BackfillSnapshot): boolean {
  return restart !== null && restart.runId === snapshot.run.id && restart.generation === snapshot.generation.toString() &&
    restart.state === snapshot.run.state && restart.checkpointHash === snapshot.checkpointHash;
}

export async function recordBackfillLaunch(database: ProviderPrismaClient, pins: BackfillPins,
  authority: BackfillAuthority, lease: ProviderWorkerLease, runId: string, anchorRunId: string,
  active: () => void = () => {}): Promise<BackfillLaunch> {
  active();
  return database.$transaction(async (tx) => {
    const owned = await lockProviderWorkerLease(tx, "import");
    await tx.$queryRaw`select id from provider_runs where id=${runId}::uuid for update`;
    await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
    const s = await readBackfillSnapshot(tx, pins, authority, runId);
    assertBackfillPins(s, pins, authority.configNumber);
    if (!providerWorkerLeaseIsLive(owned, lease) || classifyBackfillCheckpoint(s) !== "execute" ||
      s.actionableCommands.some(command => command.runId !== runId)) refuseBackfill("BACKFILL_LAUNCH_PIN_CHANGED");
    const launch = launchSchema.parse({ runId, anchorRunId, owner: lease.owner, fence: lease.fence.toString(),
      generation: s.generation.toString(), state: s.run.state, authorityDigest: authority.digest });
    active();
    await tx.local_audit_events.create({ data: { correlation_id: pins.operationId, actor_operator_id: pins.operatorId,
      action: "local.provider_backfill.launch", target_type: "provider_run", target_id: runId,
      outcome: "success", details: launch, occurred_at: owned.database_now } });
    return launch;
  }, transactionOptions);
}

export function assertClosedBackfillChild(input: { snapshot: BackfillSnapshot; launch: BackfillLaunch;
  lease: ProviderWorkerLease; childClosed: boolean; aborted: boolean }): void {
  const { snapshot: s, launch, lease } = input;
  const generation = BigInt(launch.generation) + (launch.state === "queued" && s.run.state === "running" ? 1n : 0n);
  if (!input.childClosed || input.aborted || launch.owner !== lease.owner || launch.fence !== lease.fence.toString() ||
    s.generation !== generation || classifyBackfillCheckpoint(s) !== "execute" ||
    (s.run.state === "queued" ? s.run.id !== launch.runId : s.run.fence !== lease.fence) ||
    s.actionableCommands.some(command => command.runId !== s.run.id) ||
    (s.lease.owner !== null && (s.lease.owner !== lease.owner || s.lease.fence !== lease.fence))) {
    refuseBackfill("BACKFILL_CLOSED_CHILD_PROOF_INVALID");
  }
}

/** Called only after the owned subprocess 'close' event, never for a timeout or uncertain process. */
export async function persistClosedBackfillRestart(input: { database: ProviderPrismaClient; pins: BackfillPins;
  authority: BackfillAuthority; lease: ProviderWorkerLease; launch: BackfillLaunch;
  childClosed: boolean; aborted: boolean; jitter: number; active?: () => void }): Promise<void> {
  const { database, pins, authority, launch, lease } = input;
  input.active?.();
  await database.$transaction(async (tx) => {
    const owned = await lockProviderWorkerLease(tx, "import");
    const runId = await currentBackfillRunId(tx, launch.runId);
    await tx.$queryRaw`select id from provider_runs where id=${runId}::uuid for update`;
    await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
    const s = await readBackfillSnapshot(tx, pins, authority, runId);
    assertBackfillPins(s, pins, authority.configNumber);
    const recorded = await tx.local_audit_events.findFirst({ where: { correlation_id: pins.operationId,
      action: "local.provider_backfill.launch", details: { path: ["fence"], equals: lease.fence.toString() } },
      orderBy: { sequence: "desc" } });
    if (!recorded || backfillDigest(recorded.details) !== backfillDigest(launch) ||
      (owned.lease_owner !== null && (owned.lease_owner !== lease.owner || owned.lease_fence !== lease.fence))) {
      refuseBackfill("BACKFILL_CLOSED_CHILD_PROOF_INVALID");
    }
    assertClosedBackfillChild({ ...input, snapshot: s });
    const previous = await readBackfillRestart(tx, pins, authority);
    const count = previous?.checkpointHash === s.checkpointHash ? previous.consecutiveNoProgress + 1 : 1;
    const restart = restartSchema.parse({ ...launch, runId, state: s.run.state, generation: s.generation.toString(),
      kind: "closed_child_restart", checkpointHash: s.checkpointHash, consecutiveNoProgress: count,
      notBefore: new Date(owned.database_now.getTime() + backfillDelayMilliseconds(count, input.jitter)).toISOString() });
    input.active?.();
    await tx.local_audit_events.create({ data: { correlation_id: pins.operationId, actor_operator_id: pins.operatorId,
      action, target_type: "provider_run", target_id: runId, outcome: "success", details: restart, occurred_at: owned.database_now } });
  }, transactionOptions);
}
