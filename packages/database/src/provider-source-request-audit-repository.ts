import { Prisma as ProviderPrisma } from "../prisma/generated/provider/index.js";
import {
  providerSourceResponseLimitDiagnosticSchema,
  type ProviderSourceResponseLimitDiagnostic,
} from "@packscout/contracts";
import type {
  ProviderPrismaClient,
  ProviderTransactionClient,
} from "./provider-database.ts";
import { appendProviderLocalAudit } from "./provider-local-evidence.ts";
import {
  lockProviderWorkerLease,
  providerWorkerLeaseDatabaseNow,
  providerWorkerLeaseIsLive,
  setProviderImportLeaseContext,
} from "./provider-worker-lease-repository.ts";

const TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 15_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.Serializable,
});
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const safeCodePattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/u;
const workerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

interface LockedRun {
  readonly records_per_request: number | null;
  readonly request_settings_revision_id: string | null;
  readonly id: string;
  readonly state: "queued" | "running" | "succeeded" | "incomplete" | "failed";
  readonly worker_fence: bigint;
}

export type ProviderSourceRequestAuditResult =
  | Readonly<{ kind: "recorded"; occurredAt: Date }>
  | Readonly<{ kind: "lease_lost" | "run_not_running" | "request_settings_mismatch" | "request_limit_exceeded" }>;

function requireUuid(value: string, field: string): string {
  if (!uuidPattern.test(value)) throw new TypeError(`${field} must be a UUID.`);
  return value;
}

function requireMeasurement(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer.`);
  }
  return value;
}

async function lockRun(
  transaction: ProviderTransactionClient,
  runId: string,
): Promise<LockedRun | null> {
  const [row] = await transaction.$queryRaw<LockedRun[]>(ProviderPrisma.sql`
    select id, state, worker_fence, records_per_request, request_settings_revision_id
    from provider_runs
    where id = cast(${runId} as uuid)
    for update
  `);
  return row ?? null;
}

/**
 * Commits a sanitized source-request outcome before the adapter may release
 * its request permit or interpret protected response bytes. The provider run
 * and import lease are checked in the same transaction, so a stale worker can
 * never manufacture a durable terminalization receipt.
 */
export class PrismaProviderSourceRequestAuditRepository {
  constructor(private readonly database: ProviderPrismaClient) {}

  async #recordWithLiveImportAuthority(
    input: Readonly<{
      runId: string;
      workerId: string;
      workerFence: bigint;
    }>,
    append: (
      transaction: ProviderTransactionClient,
      occurredAt: Date,
      run: LockedRun,
    ) => Promise<void | "request_settings_mismatch" | "request_limit_exceeded">,
  ): Promise<ProviderSourceRequestAuditResult> {
    return this.database.$transaction(async (transaction) => {
      const lease = await lockProviderWorkerLease(transaction, "import");
      if (!providerWorkerLeaseIsLive(lease, {
        owner: input.workerId,
        fence: input.workerFence,
      })) return { kind: "lease_lost" as const };
      await setProviderImportLeaseContext(transaction, {
        owner: input.workerId,
        fence: input.workerFence,
      });
      const run = await lockRun(transaction, input.runId);
      if (
        run?.state !== "running"
        || run.worker_fence !== input.workerFence
      ) return { kind: "run_not_running" as const };
      const occurredAt = providerWorkerLeaseDatabaseNow(lease);
      const failure = await append(transaction, occurredAt, run);
      if (failure !== undefined) return { kind: failure };
      return { kind: "recorded" as const, occurredAt };
    }, TRANSACTION_OPTIONS);
  }

  async record(input: Readonly<{
    runId: string;
    workerId: string;
    workerFence: bigint;
    requestAttemptId: string;
    requestLeaseId: string;
    pageNumber: number;
    outcome: "success" | "failure";
    resultCode: string;
    durationMilliseconds: number;
    responseBytes: number;
    responseLimitDiagnostic?: ProviderSourceResponseLimitDiagnostic;
  }>): Promise<ProviderSourceRequestAuditResult> {
    requireUuid(input.runId, "runId");
    requireUuid(input.requestAttemptId, "requestAttemptId");
    requireUuid(input.requestLeaseId, "requestLeaseId");
    if (!workerIdPattern.test(input.workerId) || input.workerFence < 1n) {
      throw new TypeError("Provider source request worker identity is invalid.");
    }
    if (!Number.isSafeInteger(input.pageNumber) || input.pageNumber < 1) {
      throw new TypeError("pageNumber must be a positive safe integer.");
    }
    if (!safeCodePattern.test(input.resultCode)) {
      throw new TypeError("resultCode is invalid.");
    }
    requireMeasurement(input.durationMilliseconds, "durationMilliseconds");
    requireMeasurement(input.responseBytes, "responseBytes");
    const parsedLimit = input.responseLimitDiagnostic === undefined ? undefined
      : providerSourceResponseLimitDiagnosticSchema.safeParse(input.responseLimitDiagnostic);
    if (parsedLimit !== undefined && (!parsedLimit.success || input.outcome !== "failure" ||
      input.resultCode !== "SOURCE_REQUEST_RESPONSE_TOO_LARGE" || input.responseBytes !== 0)) {
      throw new TypeError("Source response limit diagnostic is invalid.");
    }
    const limitDiagnostic = parsedLimit?.success ? parsedLimit.data : undefined;

    return this.#recordWithLiveImportAuthority(
      input,
      async (transaction, occurredAt) => {
        await appendProviderLocalAudit(transaction, {
          correlationId: input.requestAttemptId,
          action: "provider.source.request.terminalized",
          targetType: "source_request_attempt",
          targetId: input.requestAttemptId,
          outcome: input.outcome,
          details: {
            durationMilliseconds: input.durationMilliseconds,
            leaseFence: input.workerFence.toString(),
            pageNumber: input.pageNumber,
            requestLeaseId: input.requestLeaseId,
            responseBytes: input.responseBytes,
            resultCode: input.resultCode,
            runId: input.runId,
            ...(limitDiagnostic === undefined ? {} : {
              responseLimitTrigger: limitDiagnostic.trigger,
              maximumResponseBytes: limitDiagnostic.maximumResponseBytes,
              ...(limitDiagnostic.reportedResponseBytes === undefined ? {} : {
                reportedResponseBytes: limitDiagnostic.reportedResponseBytes,
              }),
            }),
          },
          occurredAt,
        });
      },
    );
  }

  /**
   * Records only safe post-interpretation counts. Request correlation and page
   * identity stay in UUID audit fields; raw records and cursor material never
   * enter provider-local evidence.
   */
  async recordPageTranslation(input: Readonly<{
    runId: string;
    workerId: string;
    workerFence: bigint;
    requestAttemptId: string;
    pageAttemptId: string;
    pageNumber: number;
    sourceRecordCount: number;
    normalizedRecordCount: number;
    mixedPageId?: string;
    responseDigest?: string;
    recordsPerRequest?: number;
    requestSettingsRevisionId?: string;
  }>): Promise<ProviderSourceRequestAuditResult> {
    requireUuid(input.runId, "runId");
    requireUuid(input.requestAttemptId, "requestAttemptId");
    requireUuid(input.pageAttemptId, "pageAttemptId");
    if (!workerIdPattern.test(input.workerId) || input.workerFence < 1n) {
      throw new TypeError("Provider source request worker identity is invalid.");
    }
    if (!Number.isSafeInteger(input.pageNumber) || input.pageNumber < 1) {
      throw new TypeError("pageNumber must be a positive safe integer.");
    }
    requireMeasurement(input.sourceRecordCount, "sourceRecordCount");
    requireMeasurement(input.normalizedRecordCount, "normalizedRecordCount");
    if (input.mixedPageId !== undefined) requireUuid(input.mixedPageId, "mixedPageId");
    if (input.requestSettingsRevisionId !== undefined) requireUuid(input.requestSettingsRevisionId, "requestSettingsRevisionId");
    if (input.responseDigest !== undefined && !/^[a-f0-9]{64}$/u.test(input.responseDigest)) {
      throw new TypeError("Source page response digest is invalid.");
    }

    return this.#recordWithLiveImportAuthority(
      input,
      async (transaction, occurredAt, run) => {
        const pinned = run.records_per_request !== null;
        if (pinned && (input.recordsPerRequest !== run.records_per_request
          || input.requestSettingsRevisionId !== run.request_settings_revision_id
          || input.mixedPageId === undefined || input.responseDigest === undefined)) return "request_settings_mismatch";
        if (pinned && input.sourceRecordCount > run.records_per_request!) return "request_limit_exceeded";
        await appendProviderLocalAudit(transaction, {
          // New receipts use the existing correlation index for exact page
          // admission without adding an index over historical audit rows.
          correlationId: pinned ? input.mixedPageId! : input.requestAttemptId,
          action: "provider.source.page.translated",
          targetType: pinned ? "provider_mixed_page" : "source_page_attempt",
          targetId: pinned ? input.mixedPageId! : input.pageAttemptId,
          outcome: "success",
          details: {
            leaseFence: input.workerFence.toString(),
            normalizedRecordCount: input.normalizedRecordCount,
            pageNumber: input.pageNumber,
            runId: input.runId,
            sourceRecordCount: input.sourceRecordCount,
            ...(pinned ? { requestAttemptId: input.requestAttemptId, pageAttemptId: input.pageAttemptId, responseDigest: input.responseDigest!,
              recordsPerRequest: run.records_per_request!, requestSettingsRevisionId: run.request_settings_revision_id! } : {}),
          },
          occurredAt,
        });
      },
    );
  }
}
