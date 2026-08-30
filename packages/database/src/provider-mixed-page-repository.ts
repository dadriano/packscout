import { randomUUID } from "node:crypto";
import { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import {
  ProviderCanonicalImmutableFactConflictError,
  ProviderCanonicalInputError,
  ProviderCanonicalRetiredError,
  ProviderCanonicalWriteConflictError,
  type CanonicalJsonValue,
} from "./provider-canonical-contract.ts";
import { createProviderCanonicalTransaction } from "./provider-canonical-repository.ts";
import type {
  ProviderPrismaClient,
  ProviderTransactionClient,
} from "./provider-database.ts";
import { appendProviderActivityOutbox } from "./provider-local-evidence.ts";
import {
  type ProviderMixedPageRecord,
  PROVIDER_MIXED_PAGE_MAX_QUARANTINES,
  ProviderMixedPageContractError,
  providerMixedPageCanonicalBytes,
  requireProviderMixedPageWorkerId,
  validateProviderMixedPage,
} from "./provider-mixed-page-contract.ts";
import {
  applyProviderMixedPageRecord,
  ProviderMixedCandidateError,
  providerMixedRecordEntityKey,
} from "./provider-mixed-page-candidates.ts";
import {
  lockProviderWorkerLease,
  providerWorkerLeaseDatabaseNow,
  providerWorkerLeaseIsLive,
  setProviderImportLeaseContext,
} from "./provider-worker-lease-repository.ts";

const TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 30_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.Serializable,
});
const RECORD_LOCAL_PRISMA_CODES = new Set([
  "P2000", "P2002", "P2003", "P2004", "P2005", "P2006", "P2007",
  "P2011", "P2012", "P2013", "P2014", "P2019", "P2023", "P2025",
]);

export interface ProviderMixedPageCounts {
  readonly records: number;
  readonly catalog: number;
  readonly pulls: number;
  readonly marketEvents: number;
  readonly accepted: number;
  readonly duplicate: number;
  readonly quarantined: number;
  readonly materialChanges: number;
}

export interface ProviderMixedPageCommittedResult {
  readonly kind: "committed" | "replayed";
  readonly pageId: string;
  readonly runId: string;
  readonly pageNumber: number;
  readonly resultingCursorFingerprint: string | null;
  readonly reachedHead: boolean;
  readonly counts: ProviderMixedPageCounts;
  readonly quarantineIds: readonly string[];
}

export type CommitProviderMixedPageResult = ProviderMixedPageCommittedResult | {
  readonly kind:
    | "immutable_conflict"
    | "provider_mismatch"
    | "config_mismatch"
    | "page_number_conflict"
    | "cursor_conflict"
    | "lease_lost"
    | "run_not_running"
    | "runtime_not_running";
};

interface RunRow {
  readonly id: string;
  readonly state: "queued" | "running" | "succeeded" | "incomplete" | "failed";
  readonly config_version_id: string;
  readonly config_version_number: bigint;
  readonly worker_fence: bigint;
  readonly page_count: number;
  readonly reached_source_head: boolean;
}

interface RuntimeRow {
  readonly central_provider_id: string;
  readonly operating_state: "idle" | "running" | "paused" | "stopped" | "error";
  readonly source_cursor: ProviderPrisma.JsonValue | null;
  readonly source_cursor_hash: string | null;
}

interface PriorPageRow {
  readonly id: string;
  readonly provider_run_id: string;
  readonly page_number: number;
  readonly contract_version: string;
  readonly requested_cursor: ProviderPrisma.JsonValue | null;
  readonly requested_cursor_hash: string | null;
  readonly next_cursor: ProviderPrisma.JsonValue | null;
  readonly next_cursor_hash: string | null;
  readonly continuation: "more" | "head";
  readonly response_digest: string;
  readonly record_count: number;
  readonly catalog_record_count: number;
  readonly pull_record_count: number;
  readonly market_event_record_count: number;
  readonly accepted_count: number;
  readonly duplicate_count: number;
  readonly quarantined_count: number;
  readonly material_change_count: number;
}

interface QuarantineDraft {
  readonly id: string;
  readonly record: ProviderMixedPageRecord;
  readonly reasonCode: string;
  readonly fieldPath: string | null;
}

function jsonInput(value: CanonicalJsonValue | null): ProviderPrisma.InputJsonValue | typeof ProviderPrisma.DbNull {
  return value === null ? ProviderPrisma.DbNull : value as ProviderPrisma.InputJsonValue;
}

function jsonEqual(left: unknown, right: unknown): boolean {
  return providerMixedPageCanonicalBytes(left).equals(providerMixedPageCanonicalBytes(right));
}

async function lockRun(transaction: ProviderTransactionClient, runId: string): Promise<RunRow | null> {
  const [row] = await transaction.$queryRaw<RunRow[]>(ProviderPrisma.sql`
    select id, state, config_version_id, config_version_number, worker_fence,
           page_count, reached_source_head
    from provider_runs where id = cast(${runId} as uuid) for update
  `);
  return row ?? null;
}

async function lockRuntime(transaction: ProviderTransactionClient): Promise<RuntimeRow> {
  const [row] = await transaction.$queryRaw<RuntimeRow[]>(ProviderPrisma.sql`
    select central_provider_id, operating_state, source_cursor, source_cursor_hash
    from provider_runtime where singleton_key = true for update
  `);
  if (!row) throw new Error("Provider runtime is not initialized.");
  return row;
}

function countsFromPage(page: PriorPageRow): ProviderMixedPageCounts {
  return {
    records: page.record_count,
    catalog: page.catalog_record_count,
    pulls: page.pull_record_count,
    marketEvents: page.market_event_record_count,
    accepted: page.accepted_count,
    duplicate: page.duplicate_count,
    quarantined: page.quarantined_count,
    materialChanges: page.material_change_count,
  };
}

function knownRecordFailure(error: unknown): {
  readonly reasonCode: string;
  readonly fieldPath: string | null;
} | null {
  if (error instanceof ProviderMixedCandidateError) {
    return { reasonCode: error.code, fieldPath: error.fieldPath };
  }
  if (error instanceof ProviderCanonicalInputError) {
    return { reasonCode: error.code, fieldPath: null };
  }
  if (error instanceof ProviderCanonicalWriteConflictError) {
    return { reasonCode: error.code, fieldPath: null };
  }
  if (error instanceof ProviderCanonicalRetiredError) {
    return { reasonCode: error.code, fieldPath: null };
  }
  if (error instanceof ProviderCanonicalImmutableFactConflictError) {
    return { reasonCode: error.code, fieldPath: null };
  }
  if (
    error instanceof ProviderPrisma.PrismaClientKnownRequestError
    && RECORD_LOCAL_PRISMA_CODES.has(error.code)
  ) return { reasonCode: "CANONICAL_CONSTRAINT_FAILED", fieldPath: null };
  if (error instanceof ProviderPrisma.PrismaClientValidationError) {
    return { reasonCode: "CANONICAL_INPUT_INVALID", fieldPath: null };
  }
  return null;
}

async function applyRecordWithSavepoint(
  transaction: ProviderTransactionClient,
  record: ProviderMixedPageRecord,
  sourceQuarantineKeys: Set<string>,
): Promise<
  | { readonly kind: "accepted" | "duplicate"; readonly materialChange: boolean }
  | { readonly kind: "quarantined"; readonly draft: QuarantineDraft }
> {
  if (record.disposition === "quarantine") {
    if (
      record.sourceRecordKey === undefined
      || record.reasonCode === undefined
      || record.fieldPath === undefined
      || record.sanitizedSummary === undefined
    ) {
      throw new ProviderMixedPageContractError(
        "MIXED_PAGE_INVALID",
        "A source quarantine record is incomplete.",
      );
    }
    if (sourceQuarantineKeys.has(record.sourceRecordKey)) {
      return { kind: "duplicate", materialChange: false };
    }
    const existing = await transaction.quarantine_records.findFirst({
      where: { source_record_key: record.sourceRecordKey },
      select: { id: true },
    });
    if (existing !== null) {
      sourceQuarantineKeys.add(record.sourceRecordKey);
      return { kind: "duplicate", materialChange: false };
    }
    sourceQuarantineKeys.add(record.sourceRecordKey);
    return {
      kind: "quarantined",
      draft: {
        id: randomUUID(),
        record,
        reasonCode: record.reasonCode,
        fieldPath: record.fieldPath,
      },
    };
  }
  await transaction.$executeRawUnsafe("SAVEPOINT packscout_mixed_record");
  try {
    const result = await applyProviderMixedPageRecord(
      transaction,
      createProviderCanonicalTransaction(transaction),
      record,
    );
    await transaction.$executeRawUnsafe("RELEASE SAVEPOINT packscout_mixed_record");
    return {
      kind: result.duplicate ? "duplicate" : "accepted",
      materialChange: result.materialChange,
    };
  } catch (error) {
    const failure = knownRecordFailure(error);
    if (failure === null) throw error;
    await transaction.$executeRawUnsafe("ROLLBACK TO SAVEPOINT packscout_mixed_record");
    await transaction.$executeRawUnsafe("RELEASE SAVEPOINT packscout_mixed_record");
    return {
      kind: "quarantined",
      draft: {
        id: randomUUID(),
        record,
        reasonCode: failure.reasonCode,
        fieldPath: failure.fieldPath,
      },
    };
  }
}
function sameReplay(prior: PriorPageRow, page: ReturnType<typeof validateProviderMixedPage>): boolean {
  return prior.provider_run_id === page.runId
    && prior.id === page.pageId
    && prior.page_number === page.pageNumber
    && prior.contract_version === page.contractVersion
    && jsonEqual(prior.requested_cursor, page.inputCursor)
    && prior.requested_cursor_hash === page.inputCursorFingerprint
    && jsonEqual(prior.next_cursor, page.nextCursor)
    && prior.next_cursor_hash === page.nextCursorFingerprint
    && prior.continuation === page.continuation
    && prior.response_digest === page.responseDigest;
}

async function replayResult(
  transaction: ProviderTransactionClient,
  prior: PriorPageRow,
): Promise<ProviderMixedPageCommittedResult> {
  const quarantines = await transaction.quarantine_records.findMany({
    where: { provider_run_page_id: prior.id },
    orderBy: [{ record_index: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return {
    kind: "replayed",
    pageId: prior.id,
    runId: prior.provider_run_id,
    pageNumber: prior.page_number,
    resultingCursorFingerprint: prior.next_cursor_hash,
    reachedHead: prior.continuation === "head",
    counts: countsFromPage(prior),
    quarantineIds: quarantines.map(({ id }) => id),
  };
}

export class PrismaProviderMixedPageRepository {
  constructor(private readonly database: ProviderPrismaClient) {}

  async commit(input: {
    readonly workerId: string;
    readonly page: unknown;
  }): Promise<CommitProviderMixedPageResult> {
    const workerId = requireProviderMixedPageWorkerId(input.workerId);
    const page = validateProviderMixedPage(input.page);
    return this.database.$transaction(async (transaction) => {
      const lease = await lockProviderWorkerLease(transaction, "import");
      if (!providerWorkerLeaseIsLive(lease, { owner: workerId, fence: page.leaseFence })) {
        return { kind: "lease_lost" as const };
      }
      await setProviderImportLeaseContext(transaction, { owner: workerId, fence: page.leaseFence });
      const committedAt = providerWorkerLeaseDatabaseNow(lease);
      const identity = await transaction.database_identity.findUnique({
        where: { singleton_key: true },
        select: { provider_id: true },
      });
      if (identity?.provider_id !== page.providerId) return { kind: "provider_mismatch" as const };
      const run = await lockRun(transaction, page.runId);
      if (!run || run.worker_fence !== page.leaseFence) return { kind: "run_not_running" as const };
      const prior = await transaction.provider_run_pages.findFirst({
        where: {
          OR: [
            { id: page.pageId },
            { provider_run_id: page.runId, requested_cursor_hash: page.inputCursorFingerprint },
          ],
        },
      }) as PriorPageRow | null;
      if (prior !== null) {
        return sameReplay(prior, page)
          ? replayResult(transaction, prior)
          : { kind: "immutable_conflict" as const };
      }
      if (run.state !== "running") return { kind: "run_not_running" as const };
      if (
        run.config_version_id !== page.configVersionId
        || run.config_version_number !== page.configVersionNumber
      ) return { kind: "config_mismatch" as const };
      if (page.pageNumber !== run.page_count + 1) return { kind: "page_number_conflict" as const };
      const runtime = await lockRuntime(transaction);
      if (runtime.operating_state !== "running") return { kind: "runtime_not_running" as const };
      if (
        runtime.central_provider_id !== page.providerId
        || runtime.source_cursor_hash !== page.inputCursorFingerprint
        || !jsonEqual(runtime.source_cursor, page.inputCursor)
      ) return { kind: "cursor_conflict" as const };

      let accepted = 0;
      let duplicate = 0;
      let materialChanges = 0;
      const quarantines: QuarantineDraft[] = [];
      const sourceQuarantineKeys = new Set<string>();
      for (const record of page.records) {
        const result = await applyRecordWithSavepoint(
          transaction,
          record,
          sourceQuarantineKeys,
        );
        if (result.kind === "quarantined") {
          quarantines.push(result.draft);
          if (quarantines.length > PROVIDER_MIXED_PAGE_MAX_QUARANTINES) {
            throw new ProviderMixedPageContractError(
              "MIXED_PAGE_OVERSIZED",
              "The provider mixed page exceeds the bounded quarantine limit.",
            );
          }
        } else if (result.kind === "accepted") {
          accepted += 1;
          if (result.materialChange) materialChanges += 1;
        } else {
          duplicate += 1;
        }
      }
      const counts: ProviderMixedPageCounts = {
        records: page.records.length,
        catalog: page.records.filter(({ kind }) => kind === "catalog").length,
        pulls: page.records.filter(({ kind }) => kind === "pull").length,
        marketEvents: page.records.filter(({ kind }) => kind === "market_event").length,
        accepted,
        duplicate,
        quarantined: quarantines.length,
        materialChanges,
      };
      await transaction.provider_runtime.update({
        where: { singleton_key: true },
        data: {
          source_cursor: jsonInput(page.nextCursor),
          source_cursor_hash: page.nextCursorFingerprint,
          last_attempted_at: committedAt,
          last_runner_heartbeat_at: committedAt,
          row_version: { increment: 1n },
        },
      });
      await transaction.provider_runs.update({
        where: { id: page.runId },
        data: {
          page_count: { increment: 1 }, catalog_record_count: { increment: counts.catalog },
          pull_record_count: { increment: counts.pulls },
          market_event_record_count: { increment: counts.marketEvents },
          accepted_count: { increment: counts.accepted }, duplicate_count: { increment: counts.duplicate },
          quarantined_count: { increment: counts.quarantined },
          material_change_count: { increment: counts.materialChanges },
          reached_source_head: page.continuation === "head" || run.reached_source_head,
          heartbeat_at: committedAt, last_progress_at: committedAt,
          row_version: { increment: 1n },
        },
      });
      await transaction.provider_run_pages.create({
        data: {
          id: page.pageId, provider_run_id: page.runId, page_number: page.pageNumber,
          contract_version: page.contractVersion,
          requested_cursor: jsonInput(page.inputCursor), requested_cursor_hash: page.inputCursorFingerprint,
          next_cursor: jsonInput(page.nextCursor), next_cursor_hash: page.nextCursorFingerprint,
          continuation: page.continuation, response_digest: page.responseDigest,
          record_count: counts.records, catalog_record_count: counts.catalog,
          pull_record_count: counts.pulls, market_event_record_count: counts.marketEvents,
          accepted_count: counts.accepted, duplicate_count: counts.duplicate,
          quarantined_count: counts.quarantined, material_change_count: counts.materialChanges,
          committed_at: committedAt,
        },
      });
      for (const quarantine of quarantines) {
        const sourceQuarantine = quarantine.record.disposition === "quarantine";
        await transaction.quarantine_records.create({
          data: {
            id: quarantine.id, provider_run_id: page.runId, provider_run_page_id: page.pageId,
            record_index: quarantine.record.position, record_kind: quarantine.record.kind,
            entity_key: providerMixedRecordEntityKey(quarantine.record),
            source_record_key: sourceQuarantine
              ? quarantine.record.sourceRecordKey ?? null
              : null,
            external_id: null, reason_code: quarantine.reasonCode, field_path: quarantine.fieldPath,
            sanitized_summary: sourceQuarantine
              ? quarantine.record.sanitizedSummary
                ?? "The validated source record could not be mapped to the provider schema."
              : "The normalized candidate could not be committed to the provider catalog.",
            candidate_schema_version: page.contractVersion,
            normalized_candidate: sourceQuarantine
              ? ProviderPrisma.DbNull
              : quarantine.record.candidate as ProviderPrisma.InputJsonObject,
            protected_evidence: ProviderPrisma.DbNull,
            created_at: committedAt,
            updated_at: committedAt,
            ...(sourceQuarantine
              ? {
                  evidence_expires_at: committedAt,
                  evidence_expired_at: committedAt,
                  state: "expired" as const,
                }
              : {}),
          },
        });
        await appendProviderActivityOutbox(transaction, {
          eventType: sourceQuarantine
            ? "provider.quarantine.expired"
            : "provider.quarantine.opened",
          severity: "warning",
          dedupeKey: `quarantine:${quarantine.id}:${sourceQuarantine ? "expired" : "open"}`,
          recoveryKey: `quarantine:${quarantine.id}`,
          localRunId: page.runId, localQuarantineId: quarantine.id,
          title: sourceQuarantine
            ? "Provider source record rejected"
            : "Provider record quarantined",
          summary: sourceQuarantine
            ? "A source record was rejected before canonical persistence and has no retained retry artifact."
            : "A normalized provider record requires operator review before retry.",
          evidence: {
            quarantineState: sourceQuarantine ? "expired" : "open",
          },
          eventAt: committedAt,
        });
      }
      return {
        kind: "committed" as const, pageId: page.pageId, runId: page.runId,
        pageNumber: page.pageNumber, resultingCursorFingerprint: page.nextCursorFingerprint,
        reachedHead: page.continuation === "head", counts,
        quarantineIds: quarantines.map(({ id }) => id),
      };
    }, TRANSACTION_OPTIONS);
  }
}
