import { readProviderRunHeadProof } from "./provider-run-head-proof.ts";
import { randomUUID } from "node:crypto";
import { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import type {
  ProviderPrismaClient,
  ProviderTransactionClient,
} from "./provider-database.ts";
import {
  validateProviderFactQuarantineCandidate,
  type ProviderFactQuarantineRecordKind,
} from "./provider-fact-quarantine-candidate.ts";
import {
  appendProviderActivityOutbox,
  appendProviderLocalAudit,
} from "./provider-local-evidence.ts";
import {
  PROVIDER_MIXED_PAGE_CONTRACT_VERSION,
  validateProviderMixedPageRecord,
} from "./provider-mixed-page-contract.ts";
import {
  lockProviderWorkerLease,
  providerWorkerLeaseDatabaseNow,
  providerWorkerLeaseIsLive,
  setProviderImportLeaseContext,
} from "./provider-worker-lease-repository.ts";

const TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 30_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.ReadCommitted,
});
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

export const PROVIDER_FACT_QUARANTINE_RECONCILIATION_MAX_BATCH = 100;

export interface ProviderFactQuarantineScanCursor {
  readonly createdAt: Date;
  readonly quarantineId: string;
}

export interface ProviderFactQuarantineReconciliationBatch {
  readonly kind: "reconciled";
  readonly scannedCount: number;
  readonly resolvedCount: number;
  readonly nextScanCursor: ProviderFactQuarantineScanCursor | null;
}

export type ProviderFactQuarantineReconciliationResult =
  | ProviderFactQuarantineReconciliationBatch
  | { readonly kind: "lease_lost" | "run_not_ready" };

interface QuarantineRow {
  readonly id: string;
  readonly provider_run_id: string;
  readonly record_index: number;
  readonly record_kind: ProviderFactQuarantineRecordKind;
  readonly entity_key: string | null;
  readonly normalized_candidate: ProviderPrisma.JsonValue;
  readonly created_at: Date;
  readonly row_version: bigint;
}

interface CanonicalFactRow {
  readonly stableKey: string;
  readonly factDigest: string;
}

function requireUuid(value: string, field: string): string {
  if (!UUID_PATTERN.test(value)) throw new TypeError(`${field} must be a UUID.`);
  return value;
}

function requireWorker(value: string): string {
  if (!WORKER_PATTERN.test(value)) {
    throw new TypeError("Provider fact quarantine reconciliation worker ID is invalid.");
  }
  return value;
}

function requireCursor(
  cursor: ProviderFactQuarantineScanCursor | undefined,
): ProviderFactQuarantineScanCursor | null {
  if (cursor === undefined) return null;
  if (
    !(cursor.createdAt instanceof Date)
    || !Number.isFinite(cursor.createdAt.getTime())
  ) throw new TypeError("Provider fact quarantine scan time is invalid.");
  requireUuid(cursor.quarantineId, "Provider fact quarantine scan ID");
  return cursor;
}

async function sourceHeadRunIsReady(
  transaction: ProviderTransactionClient,
  input: {
    readonly runId: string;
    readonly workerFence: bigint;
  },
): Promise<boolean> {
  const [run] = await transaction.$queryRaw<Array<{ readonly ready: boolean }>>(
    ProviderPrisma.sql`
      select (
        run.state = 'running'::"run_state"
        and run.worker_fence = ${input.workerFence}
        and run.reached_source_head = true
        and runtime.operating_state = 'running'::"runtime_state"

      ) as ready
      from provider_runs as run
      cross join provider_runtime as runtime
      where run.id = cast(${input.runId} as uuid)
        and runtime.singleton_key = true
      for update of run, runtime
    `,
  );
  return run?.ready === true && (await readProviderRunHeadProof(transaction, input.runId))?.fullReplay === true;
}

async function selectBatch(
  transaction: ProviderTransactionClient,
  input: {
    readonly now: Date;
    readonly limit: number;
    readonly after: ProviderFactQuarantineScanCursor | null;
  },
): Promise<readonly QuarantineRow[]> {
  const afterPredicate = input.after === null
    ? ProviderPrisma.empty
    : ProviderPrisma.sql`
        and (quarantine.created_at, quarantine.id)
          > (${input.after.createdAt}, cast(${input.after.quarantineId} as uuid))
      `;
  return transaction.$queryRaw<QuarantineRow[]>(ProviderPrisma.sql`
    select quarantine.id, quarantine.provider_run_id,
           quarantine.record_index, quarantine.record_kind,
           quarantine.entity_key, quarantine.normalized_candidate,
           quarantine.created_at, quarantine.row_version
    from quarantine_records as quarantine
    where quarantine.state = 'open'::"quarantine_state"
      and quarantine.evidence_expires_at > ${input.now}
      and quarantine.evidence_expired_at is null
      and quarantine.normalized_candidate is not null
      and jsonb_typeof(quarantine.normalized_candidate) = 'object'
      and quarantine.source_record_key is null
      and quarantine.candidate_schema_version = ${PROVIDER_MIXED_PAGE_CONTRACT_VERSION}
      and quarantine.record_kind in ('pull', 'market_event')
      and not exists (
        select 1
        from quarantine_attempts as attempt
        where attempt.quarantine_record_id = quarantine.id
          and attempt.state = 'running'::"quarantine_attempt_state"
      )
      ${afterPredicate}
    order by quarantine.created_at asc, quarantine.id asc
    limit ${input.limit}
    for update of quarantine skip locked
  `);
}

function validatedCandidate(
  row: QuarantineRow,
  providerId: string,
): ReturnType<typeof validateProviderFactQuarantineCandidate> | null {
  try {
    const record = validateProviderMixedPageRecord({
      position: row.record_index,
      providerId,
      kind: row.record_kind,
      candidate: row.normalized_candidate,
    }, {
      providerId,
      position: row.record_index,
    });
    return validateProviderFactQuarantineCandidate({
      recordKind: row.record_kind,
      candidate: record.candidate,
    });
  } catch {
    return null;
  }
}

async function canonicalFacts(
  transaction: ProviderTransactionClient,
  rows: readonly QuarantineRow[],
): Promise<ReadonlyMap<string, CanonicalFactRow>> {
  const pullKeys = rows
    .filter(({ record_kind }) => record_kind === "pull")
    .flatMap(({ entity_key }) => entity_key === null ? [] : [entity_key]);
  const eventKeys = rows
    .filter(({ record_kind }) => record_kind === "market_event")
    .flatMap(({ entity_key }) => entity_key === null ? [] : [entity_key]);
  const [pulls, events] = await Promise.all([
    pullKeys.length === 0
      ? []
      : transaction.pulls.findMany({
          where: { pull_key: { in: pullKeys } },
          select: { pull_key: true, fact_digest: true },
        }),
    eventKeys.length === 0
      ? []
      : transaction.market_events.findMany({
          where: { event_key: { in: eventKeys } },
          select: { event_key: true, fact_digest: true },
        }),
  ]);
  return new Map<string, CanonicalFactRow>([
    ...pulls.map((row) => [
      `pull\u0000${row.pull_key}`,
      { stableKey: row.pull_key, factDigest: row.fact_digest },
    ] as const),
    ...events.map((row) => [
      `market_event\u0000${row.event_key}`,
      { stableKey: row.event_key, factDigest: row.fact_digest },
    ] as const),
  ]);
}

async function resolveMatchedRow(
  transaction: ProviderTransactionClient,
  input: {
    readonly row: QuarantineRow;
    readonly currentRunId: string;
    readonly resolvedAt: Date;
  },
): Promise<boolean> {
  const updated = await transaction.quarantine_records.updateMany({
    where: {
      id: input.row.id,
      state: "open",
      row_version: input.row.row_version,
      evidence_expired_at: null,
      evidence_expires_at: { gt: input.resolvedAt },
      source_record_key: null,
    },
    data: {
      state: "resolved",
      resolved_at: input.resolvedAt,
      row_version: { increment: 1n },
      updated_at: input.resolvedAt,
    },
  });
  if (updated.count !== 1) return false;
  const correlationId = randomUUID();
  await appendProviderLocalAudit(transaction, {
    correlationId,
    action: "provider.quarantine.fact_reconciled",
    targetType: "quarantine_record",
    targetId: input.row.id,
    outcome: "success",
    details: {
      quarantineId: input.row.id,
      resultCode: "CANONICAL_FACT_REPLAY_MATCH",
      runId: input.currentRunId,
    },
    occurredAt: input.resolvedAt,
  });
  await appendProviderActivityOutbox(transaction, {
    eventType: "provider.quarantine.resolved",
    severity: "info",
    dedupeKey: `quarantine:${input.row.id}:fact-reconciled`,
    recoveryKey: `quarantine:${input.row.id}`,
    localRunId: input.row.provider_run_id,
    localQuarantineId: input.row.id,
    title: "Provider quarantine reconciled",
    summary: "A full source replay proved the retained fact already exists canonically.",
    evidence: { quarantineState: "resolved" },
    eventAt: input.resolvedAt,
  });
  return true;
}

/**
 * Resolves historical relationship quarantines only after an exact immutable
 * fact is observed during a full source replay. It never writes canonical
 * facts, run/page counters, or source cursors.
 */
export async function reconcileProviderFactQuarantineTransaction(transaction: ProviderTransactionClient, input: {
    readonly runId: string;
    readonly workerId: string;
    readonly workerFence: bigint;
    readonly limit: number;
    readonly after?: ProviderFactQuarantineScanCursor;
  }): Promise<ProviderFactQuarantineReconciliationResult> {
    requireUuid(input.runId, "Provider source-head run ID");
    const workerId = requireWorker(input.workerId);
    if (input.workerFence < 1n) {
      throw new TypeError("Provider fact quarantine worker fence is invalid.");
    }
    if (
      !Number.isInteger(input.limit)
      || input.limit < 1
      || input.limit > PROVIDER_FACT_QUARANTINE_RECONCILIATION_MAX_BATCH
    ) throw new RangeError("Provider fact quarantine batch limit is invalid.");
    const after = requireCursor(input.after);


      const lease = await lockProviderWorkerLease(transaction, "import");
      if (!providerWorkerLeaseIsLive(lease, {
        owner: workerId,
        fence: input.workerFence,
      })) return { kind: "lease_lost" as const };
      await setProviderImportLeaseContext(transaction, {
        owner: workerId,
        fence: input.workerFence,
      });
      if (!await sourceHeadRunIsReady(transaction, input)) {
        return { kind: "run_not_ready" as const };
      }
      const now = providerWorkerLeaseDatabaseNow(lease);
      const identity = await transaction.database_identity.findUnique({
        where: { singleton_key: true },
        select: { provider_id: true },
      });
      if (identity?.provider_id === null || identity?.provider_id === undefined) {
        return { kind: "run_not_ready" as const };
      }
      const rows = await selectBatch(transaction, {
        now,
        limit: input.limit,
        after,
      });
      const facts = await canonicalFacts(transaction, rows);
      let resolvedCount = 0;
      for (const row of rows) {
        if (row.entity_key === null) continue;
        const candidate = validatedCandidate(row, identity.provider_id);
        if (
          candidate === null
          || candidate.entityKey !== row.entity_key
          || candidate.claimedDigest !== candidate.recomputedDigest
        ) continue;
        const fact = facts.get(`${row.record_kind}\u0000${row.entity_key}`);
        if (
          fact === undefined
          || fact.stableKey !== row.entity_key
          || fact.factDigest !== candidate.recomputedDigest
        ) continue;
        if (await resolveMatchedRow(transaction, {
          row,
          currentRunId: input.runId,
          resolvedAt: now,
        })) resolvedCount += 1;
      }
      const last = rows.at(-1);
      return {
        kind: "reconciled" as const,
        scannedCount: rows.length,
        resolvedCount,
        nextScanCursor: rows.length === input.limit && last !== undefined
          ? { createdAt: last.created_at, quarantineId: last.id }
          : null,
      };

}

export class PrismaProviderFactQuarantineReconciliationRepository {
  constructor(private readonly database: ProviderPrismaClient) {}

  async reconcileBatch(input: {
    readonly runId: string;
    readonly workerId: string;
    readonly workerFence: bigint;
    readonly limit: number;
    readonly after?: ProviderFactQuarantineScanCursor;
  }): Promise<ProviderFactQuarantineReconciliationResult> {
    requireUuid(input.runId, "Provider source-head run ID");
    return this.database.$transaction(transaction => reconcileProviderFactQuarantineTransaction(transaction, input), TRANSACTION_OPTIONS);
  }
}
