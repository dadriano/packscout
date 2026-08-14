import { safeValidateProviderStreamPageV2 } from "@packscout/contracts";
import type { ProviderClock, ProviderIdSource } from "./provider-configuration-service.ts";
import { PROVIDER_ARCHIVE_DEFAULT_LIMITS } from "./provider-archive-reader.ts";
import { ProviderImportPlanningError } from "./provider-import-page-planner.ts";
import type {
  ClaimedProviderImportRun,
  ProviderArchiveImportRepository,
  ProviderArchiveImportPagePlanner,
  ProviderImportPageRepository,
  ProviderImportRunRepository,
  ProviderImportRunSummary,
} from "./provider-import-types.ts";

const DEFAULT_LEASE_DURATION_MS = 120_000;
const MAXIMUM_ARCHIVE_OPERATION_RECORDS = 1_000_000;
const MAXIMUM_ARCHIVE_OPERATION_PAGES = 10_000;

export interface ProviderArchiveChunkV2 {
  readonly requestedCursor: string;
  readonly nextCursor: string;
  readonly hasMore: boolean;
  readonly records: readonly unknown[];
  /** Exact uncompressed NDJSON bytes represented by this chunk. */
  readonly uncompressedBytes: number;
  /** Bounded metadata only. Exact raw NDJSON bytes are represented by payloadHash. */
  readonly pageEvidence: Readonly<Record<string, unknown>>;
  readonly payloadHash: string;
}

export interface ProviderArchiveImportServiceDependencies {
  readonly archives: ProviderArchiveImportRepository;
  readonly runs: ProviderImportRunRepository;
  readonly pages: ProviderImportPageRepository;
  readonly pagePlanner: ProviderArchiveImportPagePlanner;
  readonly clock: ProviderClock;
  readonly ids: ProviderIdSource;
  readonly leaseDurationMs?: number;
  readonly maximumOperationUncompressedBytes?: number;
  readonly maximumOperationElapsedMs?: number;
}

export class ProviderArchiveImportError extends Error {
  constructor(
    readonly code:
      | "ARCHIVE_ACTIVE_RUN"
      | "ARCHIVE_CONFIGURATION_UNAVAILABLE"
      | "ARCHIVE_INVALID"
      | "ARCHIVE_NOT_CLAIMABLE"
      | "ARCHIVE_NOT_FOUND"
      | "ARCHIVE_OWNERSHIP_LOST"
      | "ARCHIVE_PROVIDER_UNAVAILABLE"
      | "ARCHIVE_RECOVERY_CONFLICT"
      | "ARCHIVE_REVISION_CONFLICT",
    message: string,
  ) {
    super(message);
    this.name = "ProviderArchiveImportError";
  }
}

export class ProviderArchiveImportService {
  readonly #leaseDurationMs: number;
  readonly #maximumOperationUncompressedBytes: number;
  readonly #maximumOperationElapsedMs: number;

  constructor(private readonly dependencies: ProviderArchiveImportServiceDependencies) {
    this.#leaseDurationMs = dependencies.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.#maximumOperationUncompressedBytes =
      dependencies.maximumOperationUncompressedBytes ??
      PROVIDER_ARCHIVE_DEFAULT_LIMITS.maximumStreamBytes;
    this.#maximumOperationElapsedMs =
      dependencies.maximumOperationElapsedMs ??
      PROVIDER_ARCHIVE_DEFAULT_LIMITS.maximumElapsedMs;
    if (
      !Number.isSafeInteger(this.#leaseDurationMs) ||
      this.#leaseDurationMs < 10_000 ||
      this.#leaseDurationMs > 15 * 60_000
    ) {
      throw new RangeError("Archive import lease duration is invalid.");
    }
    if (
      !Number.isSafeInteger(this.#maximumOperationUncompressedBytes) ||
      this.#maximumOperationUncompressedBytes < 1 ||
      this.#maximumOperationUncompressedBytes >
        PROVIDER_ARCHIVE_DEFAULT_LIMITS.maximumStreamBytes ||
      !Number.isSafeInteger(this.#maximumOperationElapsedMs) ||
      this.#maximumOperationElapsedMs < 1 ||
      this.#maximumOperationElapsedMs > PROVIDER_ARCHIVE_DEFAULT_LIMITS.maximumElapsedMs
    ) {
      throw new RangeError("Archive operation resource limits are invalid.");
    }
  }

  ensureArchiveRevision(input: {
    organizationId: string;
    providerId: string;
    configurationRevisionId: string;
    platformKey: string;
    mappingAdapterKey: string;
    actorPseudonymKeyFingerprint: string;
    archiveImporterBuildSha: string;
    archiveSha256: string;
    requestedByActorKey: string;
  }): Promise<{ readonly created: boolean }> {
    return this.dependencies.archives.ensureArchiveRevision({
      organizationId: input.organizationId,
      providerId: input.providerId,
      configurationRevisionId: input.configurationRevisionId,
      platformKey: input.platformKey,
      mappingAdapterKey: input.mappingAdapterKey,
      actorPseudonymKeyFingerprint: input.actorPseudonymKeyFingerprint,
      archiveImporterBuildSha: input.archiveImporterBuildSha,
      archiveSha256: input.archiveSha256,
      actorKey: input.requestedByActorKey,
      createdAt: this.dependencies.clock.now(),
    });
  }

  async requestArchive(input: {
    organizationId: string;
    providerId: string;
    configurationRevisionId: string;
    archiveSha256: string;
    requestedByActorKey: string;
    initialCursor: string;
  }): Promise<{ run: ProviderImportRunSummary; existing: boolean }> {
    const result = await this.dependencies.archives.requestArchiveRun({
      ...input,
      runId: this.dependencies.ids.id(),
      requestedAt: this.dependencies.clock.now(),
      maximumElapsedMs: this.#maximumOperationElapsedMs,
    });
    if (result.kind === "created") return { run: result.run, existing: false };
    if (result.kind === "existing") return { run: result.run, existing: true };
    if (result.kind === "active") {
      throw new ProviderArchiveImportError(
        "ARCHIVE_ACTIVE_RUN",
        "Another import is active for this provider.",
      );
    }
    if (result.kind === "not_found") {
      throw new ProviderArchiveImportError("ARCHIVE_NOT_FOUND", "Provider not found.");
    }
    if (result.kind === "revision_conflict") {
      throw new ProviderArchiveImportError(
        "ARCHIVE_REVISION_CONFLICT",
        "The explicit archive revision is not bound to this archive digest.",
      );
    }
    throw new ProviderArchiveImportError(
      "ARCHIVE_PROVIDER_UNAVAILABLE",
      "Provider is unavailable for archive import.",
    );
  }

  async recoverFailedArchive(input: {
    organizationId: string;
    providerId: string;
    runId: string;
    archiveSha256: string;
    requestedByActorKey: string;
  }): Promise<void> {
    const result = await this.dependencies.archives.requeueFailedArchiveRun({
      organizationId: input.organizationId,
      providerId: input.providerId,
      runId: input.runId,
      archiveSha256: input.archiveSha256,
      actorKey: input.requestedByActorKey,
      requeuedAt: this.dependencies.clock.now(),
    });
    if (result.kind === "requeued") return;
    throw new ProviderArchiveImportError(
      result.kind === "not_found" ? "ARCHIVE_NOT_FOUND" : "ARCHIVE_RECOVERY_CONFLICT",
      result.kind === "not_found"
        ? "Archive run not found for the explicit recovery scope."
        : "Archive run is not in a recoverable failed state.",
    );
  }

  async executeArchive(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    chunks: (
      resumeCursor: string,
      platform: string,
    ) => AsyncIterable<ProviderArchiveChunkV2>;
  }): Promise<ProviderImportRunSummary> {
    const claimedAt = this.dependencies.clock.now();
    const claim = await this.dependencies.archives.claimArchiveRun({
      organizationId: input.organizationId,
      runId: input.runId,
      workerId: input.workerId,
      claimedAt,
      leaseExpiresAt: this.leaseExpiresAt(claimedAt),
    });
    if (claim.kind === "not_found") {
      throw new ProviderArchiveImportError("ARCHIVE_NOT_FOUND", "Archive run not found.");
    }
    if (claim.kind === "not_claimable") {
      throw new ProviderArchiveImportError(
        "ARCHIVE_NOT_CLAIMABLE",
        "Archive run cannot be claimed.",
      );
    }
    return this.executeClaimedArchive(claim.run, input.chunks);
  }

  private async executeClaimedArchive(
    run: ClaimedProviderImportRun,
    chunks: (
      resumeCursor: string,
      platform: string,
    ) => AsyncIterable<ProviderArchiveChunkV2>,
  ): Promise<ProviderImportRunSummary> {
    if (
      run.trigger !== "archive" ||
      !run.archiveSha256 ||
      !run.currentCursor ||
      !run.startedAt ||
      !Number.isSafeInteger(run.committedArchiveUncompressedBytes) ||
      run.committedArchiveUncompressedBytes < 0 ||
      !Number.isSafeInteger(run.archiveMaximumElapsedMs) ||
      run.archiveMaximumElapsedMs < 1 ||
      run.archiveMaximumElapsedMs > PROVIDER_ARCHIVE_DEFAULT_LIMITS.maximumElapsedMs
    ) {
      return this.finishFailure(run, "ARCHIVE_INVALID", "Archive run metadata is invalid.");
    }
    const committedTerminalPage = await this.dependencies.archives
      .hasCommittedTerminalPage({
        organizationId: run.organizationId,
        runId: run.id,
        pageNumber: run.nextPageNumber - 1,
        finalCursor: run.currentCursor,
      });
    if (committedTerminalPage) {
      return this.finish(
        run,
        run.counters.quarantined > 0 ? "incomplete" : "succeeded",
        true,
        null,
        null,
      );
    }
    if (!this.withinElapsedBudget(run)) {
      return this.finishFailure(
        run,
        "ARCHIVE_INVALID",
        "Archive exceeds the operation elapsed-time limit.",
      );
    }
    const revision = await this.dependencies.archives.getArchiveRevision({
      organizationId: run.organizationId,
      providerId: run.providerId,
      configurationRevisionId: run.configRevisionId,
    });
    if (!revision) {
      return this.finishFailure(
        run,
        "ARCHIVE_CONFIGURATION_UNAVAILABLE",
        "Archive mapping configuration is unavailable.",
      );
    }

    let cursor = run.currentCursor;
    let pageNumber = run.nextPageNumber;
    let lastHasMore: boolean | null = null;
    let terminalSeen = false;
    let quarantined = run.counters.quarantined;
    let operationRecords = run.counters.records;
    let operationPages = run.counters.pages;
    let operationUncompressedBytes = run.committedArchiveUncompressedBytes;
    if (operationUncompressedBytes > this.#maximumOperationUncompressedBytes) {
      return this.finishFailure(
        run,
        "ARCHIVE_INVALID",
        "Archive exceeds the operation resource limit.",
      );
    }
    try {
      for await (const chunk of chunks(cursor, revision.platformKey)) {
        if (!this.withinElapsedBudget(run)) {
          return this.finishFailure(
            run,
            "ARCHIVE_INVALID",
            "Archive exceeds the operation elapsed-time limit.",
          );
        }
        if (terminalSeen || chunk.requestedCursor !== cursor) {
          return this.finishFailure(
            run,
            "ARCHIVE_INVALID",
            "Archive chunk cursors are not contiguous.",
          );
        }
        if (
          operationRecords + chunk.records.length > MAXIMUM_ARCHIVE_OPERATION_RECORDS ||
          operationPages + 1 > MAXIMUM_ARCHIVE_OPERATION_PAGES ||
          !Number.isSafeInteger(chunk.uncompressedBytes) ||
          chunk.uncompressedBytes < 1 ||
          operationUncompressedBytes + chunk.uncompressedBytes >
            this.#maximumOperationUncompressedBytes
        ) {
          return this.finishFailure(
            run,
            "ARCHIVE_INVALID",
            "Archive exceeds the operation resource limit.",
          );
        }
        if (!/^[0-9a-f]{64}$/.test(chunk.payloadHash)) {
          return this.finishFailure(
            run,
            "ARCHIVE_INVALID",
            "Archive chunk hash is invalid.",
          );
        }
        if (chunk.pageEvidence.uncompressedBytes !== chunk.uncompressedBytes) {
          return this.finishFailure(
            run,
            "ARCHIVE_INVALID",
            "Archive chunk byte evidence is invalid.",
          );
        }
        const validated = safeValidateProviderStreamPageV2({
          rawPage: chunk.pageEvidence,
          normalizedPage: {
            requestedCursor: chunk.requestedCursor,
            nextCursor: chunk.nextCursor,
            hasMore: chunk.hasMore,
            records: chunk.records,
          },
          context: {
            requestedPlatform: revision.platformKey,
            requestedCursor: chunk.requestedCursor,
          },
        });
        if (!validated.success) {
          return this.finishFailure(
            run,
            "ARCHIVE_INVALID",
            "Archive chunk failed the V2 provider contract.",
          );
        }
        await this.requireLease(run);
        if (!this.withinElapsedBudget(run)) {
          return this.finishFailure(
            run,
            "ARCHIVE_INVALID",
            "Archive exceeds the operation elapsed-time limit.",
          );
        }
        let planned;
        try {
          planned = await this.dependencies.pagePlanner.planArchive({
            configuration: {
              providerId: run.providerId,
              configurationRevisionId: run.configRevisionId,
              platform: revision.platformKey,
              adapterKey: revision.mappingAdapterKey,
            },
            page: validated.data,
          });
        } catch (error) {
          return this.finishFailure(
            run,
            "ARCHIVE_INVALID",
            error instanceof ProviderImportPlanningError
              ? error.message
              : "Archive chunk could not be mapped.",
          );
        }
        await this.requireLease(run);
        if (!this.withinElapsedBudget(run)) {
          return this.finishFailure(
            run,
            "ARCHIVE_INVALID",
            "Archive exceeds the operation elapsed-time limit.",
          );
        }
        const committed = await this.dependencies.pages.commitPage({
          organizationId: run.organizationId,
          providerId: run.providerId,
          configRevisionId: run.configRevisionId,
          runId: run.id,
          workerId: run.workerId,
          pageNumber,
          requestedCursor: cursor,
          nextCursor: chunk.nextCursor,
          hasMore: chunk.hasMore,
          payload: chunk.pageEvidence,
          payloadHash: chunk.payloadHash,
          archiveUncompressedBytes: chunk.uncompressedBytes,
          checkpointMode: "archive",
          records: planned.records,
          quarantines: planned.quarantines,
          committedAt: this.dependencies.clock.now(),
        });
        quarantined = committed.counters.quarantined;
        operationRecords = committed.counters.records;
        operationPages = committed.counters.pages;
        operationUncompressedBytes += chunk.uncompressedBytes;
        cursor = chunk.nextCursor;
        pageNumber += 1;
        lastHasMore = chunk.hasMore;
        terminalSeen = !chunk.hasMore;
      }
    } catch (error) {
      if (
        error instanceof ProviderArchiveImportError &&
        error.code === "ARCHIVE_OWNERSHIP_LOST"
      ) {
        throw error;
      }
      return this.finishFailure(
        run,
        "ARCHIVE_INVALID",
        "Archive streaming or persistence failed.",
      );
    }
    if (lastHasMore === null) {
      return this.finishFailure(run, "ARCHIVE_INVALID", "Archive contained no import chunks.");
    }
    if (lastHasMore === true) {
      return this.finishFailure(run, "ARCHIVE_INVALID", "Archive ended before its terminal chunk.");
    }
    return this.finish(
      run,
      quarantined > 0 ? "incomplete" : "succeeded",
      true,
      null,
      null,
    );
  }

  private async requireLease(run: ClaimedProviderImportRun): Promise<void> {
    const now = this.dependencies.clock.now();
    const renewed = await this.dependencies.runs.renewLease({
      organizationId: run.organizationId,
      runId: run.id,
      workerId: run.workerId,
      renewedAt: now,
      leaseExpiresAt: this.leaseExpiresAt(now),
    });
    if (!renewed) {
      throw new ProviderArchiveImportError(
        "ARCHIVE_OWNERSHIP_LOST",
        "Archive run ownership was lost.",
      );
    }
  }

  private leaseExpiresAt(now: Date): Date {
    return new Date(now.getTime() + this.#leaseDurationMs);
  }

  private withinElapsedBudget(run: ClaimedProviderImportRun): boolean {
    if (!run.startedAt) return false;
    const elapsedMs = this.dependencies.clock.now().getTime() - run.startedAt.getTime();
    return elapsedMs >= 0 && elapsedMs < run.archiveMaximumElapsedMs;
  }

  private finishFailure(
    run: ClaimedProviderImportRun,
    code: string,
    summary: string,
  ): Promise<ProviderImportRunSummary> {
    return this.finish(run, "failed", false, code, summary);
  }

  private async finish(
    run: ClaimedProviderImportRun,
    state: "succeeded" | "incomplete" | "failed",
    reachedProviderHead: boolean,
    failureCode: string | null,
    failureSummary: string | null,
  ): Promise<ProviderImportRunSummary> {
    const result = await this.dependencies.runs.finishRun({
      organizationId: run.organizationId,
      runId: run.id,
      workerId: run.workerId,
      state,
      reachedProviderHead,
      failureCode,
      failureSummary,
      finishedAt: this.dependencies.clock.now(),
    });
    if (result.kind === "finished" || result.kind === "already_terminal") {
      return result.run;
    }
    throw new ProviderArchiveImportError(
      result.kind === "not_found" ? "ARCHIVE_NOT_FOUND" : "ARCHIVE_OWNERSHIP_LOST",
      result.kind === "not_found" ? "Archive run not found." : "Archive run ownership was lost.",
    );
  }
}
