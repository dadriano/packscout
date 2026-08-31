import { randomUUID } from "node:crypto";
import {
  PrismaProviderCommandRepository,
  ProviderCanonicalRepository,
  PrismaProviderMixedPageRepository,
  PrismaProviderRunRepository,
  PrismaProviderRuntimeRepository,
  PrismaProviderWorkerLeaseRepository,
  validateProviderMixedPage,
  type ProviderPrismaClient,
  type ProviderRunCounters,
  type ProviderRunSummary,
} from "@packscout/database";
import { ProviderCaptureMixedPageSource } from
  "./provider-capture-mixed-page-source.ts";
import {
  ProviderCaptureSourceError,
  type ProviderCapturePageSourceInput,
} from "./provider-capture-source-contract.ts";
import {
  PROVIDER_MANUAL_IMPORT_MAXIMUM_PAGES,
  providerManualImportPageNumberWithinBound,
} from "./provider-manual-import-bounds.ts";
import {
  classifyProviderManualImportFailure,
  providerManualImportTerminalDiagnostic,
  type ProviderManualImportFailureDiagnostic,
  type ProviderManualImportStage,
} from "./provider-manual-import-diagnostics.ts";

import { finishProviderImportHead } from "./provider-manual-import-head.ts";
import { reconcileProviderPageFactReferences } from "./provider-manual-import-reconciliation.ts";

const DEFAULT_LEASE_MILLISECONDS = 5 * 60_000;
const MAXIMUM_HEAD_RECONCILIATION_BATCHES = 10_000;

export type ProviderManualImportExecutionResult =
  | Readonly<{ kind: "idle" | "contended" }>
  | Readonly<{
      kind: "progress";
      runId: string;
      pageCount: number;
      reconciliationPending?: true;
    }>
  | Readonly<{
      kind: "completed";
      runId: string;
      pageCount: number;
      counters: ProviderRunCounters;
    }>
  | Readonly<{
      kind: "blocked" | "failed";
      runId: string | null;
      failureCode: string;
    }>;

export type ProviderManualImportInterruptionFailureCode =
  | "PROVIDER_IMPORT_AUTHORITY_EXPIRED"
  | "PROVIDER_CAPTURE_ABORTED"
  | "PROVIDER_IMPORT_STEP_LIMIT_EXCEEDED";

export interface ProviderManualImportPageSource {
  supports(adapterKey: string, providerKey: string): boolean;
  nextPage(input: ProviderCapturePageSourceInput): Promise<unknown>;
}

/** Selects exactly one installed source implementation from cached authority. */
export class ProviderManualImportPageSourceRouter
implements ProviderManualImportPageSource {
  readonly #sources: readonly ProviderManualImportPageSource[];

  constructor(sources: readonly ProviderManualImportPageSource[]) {
    if (sources.length < 1) {
      throw new TypeError("At least one provider page source is required.");
    }
    this.#sources = Object.freeze([...sources]);
  }

  supports(adapterKey: string, providerKey: string): boolean {
    return this.#matching(adapterKey, providerKey).length === 1;
  }

  nextPage(input: ProviderCapturePageSourceInput): Promise<unknown> {
    const adapterKey = input.authority.configuration.adapterKey;
    if (typeof adapterKey !== "string") {
      throw new ProviderCaptureSourceError(
        "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE",
      );
    }
    const matches = this.#matching(adapterKey, input.authority.providerKey);
    if (matches.length !== 1) {
      throw new ProviderCaptureSourceError(
        "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE",
      );
    }
    return matches[0]!.nextPage(input);
  }

  #matching(
    adapterKey: string,
    providerKey: string,
  ): readonly ProviderManualImportPageSource[] {
    return this.#sources.filter((source) =>
      source.supports(adapterKey, providerKey)
    );
  }
}

/**
 * Bounded provider executor. It consumes one accepted Run-now command, claims
 * the provider-local lease, and commits deterministic mixed pages.
 */
export class ProviderManualImportExecutor {
  readonly #leaseMilliseconds: number;
  readonly #workerId: string;

  constructor(private readonly dependencies: Readonly<{
    database: ProviderPrismaClient;
    source: ProviderManualImportPageSource;
    workerId: string;
    leaseMilliseconds?: number;
  }>) {
    const leaseMilliseconds = dependencies.leaseMilliseconds
      ?? DEFAULT_LEASE_MILLISECONDS;
    if (
      !Number.isInteger(leaseMilliseconds)
      || leaseMilliseconds < 30_000
      || leaseMilliseconds > 15 * 60_000
    ) {
      throw new TypeError("Provider import lease duration is invalid.");
    }
    this.#leaseMilliseconds = leaseMilliseconds;
    this.#workerId = dependencies.workerId;
  }

  async executeNext(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ProviderManualImportExecutionResult> {
    return this.#execute(signal, PROVIDER_MANUAL_IMPORT_MAXIMUM_PAGES);
  }

  /** One resumable page step for centrally routed, bounded gateway calls. */
  async executeNextPage(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ProviderManualImportExecutionResult> {
    return this.#execute(signal, 1);
  }

  /** Stops only the exact still-owned page continuation, without source I/O. */
  async terminalizeProgress(input: Readonly<{
    progress: Extract<ProviderManualImportExecutionResult, { kind: "progress" }>;
    failureCode: ProviderManualImportInterruptionFailureCode;
  }>): Promise<ProviderManualImportExecutionResult> {
    const runs = new PrismaProviderRunRepository(this.dependencies.database);
    const active = await runs.active();
    if (
      active === null
      || active.state !== "running"
      || active.id !== input.progress.runId
      || active.counters.pages !== input.progress.pageCount
    ) {
      return {
        kind: "blocked",
        runId: input.progress.runId,
        failureCode: "PROVIDER_IMPORT_LEASE_LOST",
      };
    }

    // A running run's fence is immutable. finish() rechecks its exact fence
    // and this worker's live ownership while holding the lease/run locks.
    // Never acquire a replacement lease or recover a different attempt here.
    const finished = await runs.finish({
      runId: active.id,
      workerId: this.#workerId,
      workerFence: active.workerFence,
      state: "failed",
      failureCode: input.failureCode,
      failureClass: input.failureCode === "PROVIDER_IMPORT_AUTHORITY_EXPIRED"
        ? "configuration"
        : "worker",
      failureSummary:
        "The provider import stopped before another source page was requested.",
      correlationId: randomUUID(),
      finishedAt: new Date(),
    });
    if (finished.kind !== "finished") {
      return {
        kind: "blocked",
        runId: input.progress.runId,
        failureCode: "PROVIDER_IMPORT_LEASE_LOST",
      };
    }
    await new PrismaProviderWorkerLeaseRepository(
      this.dependencies.database,
    ).release({
      role: "import",
      owner: this.#workerId,
      fence: active.workerFence,
    });
    return {
      kind: "failed",
      runId: finished.run.id,
      failureCode: input.failureCode,
    };
  }

  async #execute(
    signal: AbortSignal,
    maximumPagesThisExecution: number,
  ): Promise<ProviderManualImportExecutionResult> {
    if (signal.aborted) {
      return { kind: "blocked", runId: null, failureCode: "PROVIDER_CAPTURE_ABORTED" };
    }
    const commands = new PrismaProviderCommandRepository(this.dependencies.database);
    const command = await commands.nextAccepted({ commandTypes: ["run"] });

    const runtime = await new PrismaProviderRuntimeRepository(
      this.dependencies.database,
    ).snapshot();
    const configuration = runtime.cachedConfiguration;
    const adapterKey = configuration?.configuration.adapterKey;
    const capabilityFailure = configuration === null
      ? "PROVIDER_CONFIGURATION_UNAVAILABLE"
      : typeof adapterKey !== "string"
        || !this.dependencies.source.supports(adapterKey, runtime.providerKey)
        ? "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE"
        : null;
    const runs = new PrismaProviderRunRepository(this.dependencies.database);
    const activeBeforeLease = await runs.active();

    // A new or merely queued run has not consumed execution authority yet, so
    // an unavailable adapter is rejected before taking the lease or mutating
    // command/run state. A running attempt must pass through fenced recovery
    // first so an old fence can never leave it permanently active.
    if (activeBeforeLease?.state !== "running" && capabilityFailure !== null) {
      return {
        kind: "blocked",
        runId: null,
        failureCode: capabilityFailure,
      };
    }

    const leases = new PrismaProviderWorkerLeaseRepository(
      this.dependencies.database,
    );
    const acquired = await leases.acquire({
      role: "import",
      owner: this.#workerId,
      leaseMilliseconds: this.#leaseMilliseconds,
    });
    if (acquired.kind === "held") return { kind: "contended" };
    const fence = acquired.lease.fence;
    let runId: string | null = null;
    let retainLeaseForNextPage = false;
    let stage: ProviderManualImportStage = "run_preparation";
    try {
      const recovery = await runs.recoverActive({
        recoveryRunId: randomUUID(),
        workerId: this.#workerId,
        workerFence: fence,
        correlationId: randomUUID(),
      });
      if (recovery.kind === "lease_lost") {
        return {
          kind: "blocked",
          runId: null,
          failureCode: "PROVIDER_IMPORT_LEASE_LOST",
        };
      }
      if (
        recovery.kind !== "none"
        && recovery.kind !== "resumed"
        && recovery.kind !== "recovered"
      ) {
        return {
          kind: "blocked",
          runId: null,
          failureCode: "PROVIDER_RUN_RECOVERY_" + recovery.kind.toUpperCase(),
        };
      }

      let runningRun: ProviderRunSummary | null =
        recovery.kind === "resumed" || recovery.kind === "recovered"
          ? recovery.run
          : null;
      if (capabilityFailure !== null) {
        if (runningRun !== null) {
          runId = runningRun.id;
          return await this.failRun(
            runs,
            runId,
            fence,
            capabilityFailure,
          );
        }
        return {
          kind: "blocked",
          runId: null,
          failureCode: capabilityFailure,
        };
      }
      if (configuration === null) {
        return {
          kind: "blocked",
          runId: runningRun?.id ?? null,
          failureCode: "PROVIDER_CONFIGURATION_UNAVAILABLE",
        };
      }
      if (command !== null) {
        const started = await runs.start({
          runId: randomUUID(),
          idempotencyKey: "command/" + command.id,
          trigger: "manual",
          requestedByOperatorId: command.requested_by_operator_id,
          configVersionId: configuration.id,
          configVersionNumber: configuration.version,
          workerId: this.#workerId,
          workerFence: fence,
          correlationId: command.correlation_id,
          requestedAt: command.requested_at,
          controlCommandId: command.id,
        });
        if (
          started.kind !== "started"
          && started.kind !== "deduplicated"
          && started.kind !== "active"
        ) {
          return {
            kind: "blocked",
            runId: runningRun?.id ?? null,
            failureCode: "PROVIDER_RUN_" + started.kind.toUpperCase(),
          };
        }
        runningRun = started.run;
      }
      if (runningRun === null) return { kind: "idle" };
      runId = runningRun.id;
      if (runningRun.state !== "running") {
        return {
          kind: "blocked",
          runId,
          failureCode: "PROVIDER_RUN_NOT_RUNNING",
        };
      }

      const finishHead = () => finishProviderImportHead({ database: this.dependencies.database,
        runId: runId!, workerId: this.#workerId, fence, leaseMilliseconds: this.#leaseMilliseconds,
        signal, onStage: (next) => { stage = next; } });
      if (runningRun.reachedSourceHead) {
        const result = await finishHead();
        retainLeaseForNextPage = result.kind === "progress";
        return result;
      }

      let checkpoint = recovery.kind === "resumed"
          || recovery.kind === "recovered"
        ? recovery.checkpoint
        : runningRun.requestedCursor;
      let checkpointFingerprint = recovery.kind === "resumed"
          || recovery.kind === "recovered"
        ? recovery.checkpointFingerprint
        : runningRun.requestedCursorFingerprint;
      const startingPageNumber = runningRun.counters.pages + 1;
      const pages = new PrismaProviderMixedPageRepository(
        this.dependencies.database,
      );
      const canonical = new ProviderCanonicalRepository(
        this.dependencies.database,
      );
      let pagesProcessed = 0;
      for (
        let index = 0;
        index < maximumPagesThisExecution
          && providerManualImportPageNumberWithinBound(
            startingPageNumber + index,
          );
        index += 1
      ) {
        const pageDeadlineAt = Date.now() + 55_000;
        if (signal.aborted) {
          return await this.failRun(runs, runId, fence, "PROVIDER_CAPTURE_ABORTED");
        }
        stage = "lease_renewal";
        const renewed = await leases.renew({
          role: "import",
          owner: this.#workerId,
          fence,
          leaseMilliseconds: this.#leaseMilliseconds,
        });
        if (renewed === null) {
          return {
            kind: "blocked",
            runId,
            failureCode: "PROVIDER_IMPORT_LEASE_LOST",
          };
        }
        stage = "source_read";
        const page = await this.dependencies.source.nextPage({
          authority: {
            providerId: runtime.providerId,
            providerKey: runtime.providerKey,
            configVersionId: configuration.id,
            configVersionNumber: configuration.version,
            configuration: configuration.configuration,
          },
          runId,
          workerFence: fence,
          pageNumber: startingPageNumber + index,
          sourceCheckpoint: checkpoint,
          sourceCheckpointFingerprint: checkpointFingerprint,
          signal,
        });
        stage = "page_validation";
        const validatedPage = validateProviderMixedPage(page);
        stage = "page_commit";
        const committed = await pages.commit({
          workerId: this.#workerId,
          page, deadlineAt: pageDeadlineAt,
        });
        if (committed.kind !== "committed" && committed.kind !== "replayed") {
          return await this.failRun(
            runs,
            runId,
            fence,
            "PROVIDER_MIXED_PAGE_" + committed.kind.toUpperCase(),
          );
        }
        pagesProcessed = index + 1;
        checkpoint = validatedPage.nextCursor;
        checkpointFingerprint = committed.resultingCursorFingerprint;
        if (signal.aborted) {
          return await this.failRun(runs, runId, fence, "PROVIDER_CAPTURE_ABORTED");
        }
        if (committed.reachedHead) {
          const result: ProviderManualImportExecutionResult = Date.now() + 35_000 > pageDeadlineAt
            ? { kind: "progress", runId, pageCount: committed.pageNumber, reconciliationPending: true }
            : await finishHead();
          retainLeaseForNextPage = result.kind === "progress";
          return result;
        }
        const reconciled = await reconcileProviderPageFactReferences({
          page: validatedPage, reachedHead: committed.reachedHead, signal,
          maximumBatches: MAXIMUM_HEAD_RECONCILIATION_BATCHES,
          renewLease: async () => {
            stage = "lease_renewal";
            return await leases.renew({ role: "import", owner: this.#workerId,
              fence, leaseMilliseconds: this.#leaseMilliseconds }) !== null;
          },
          reconcile: (scan) => {
            stage = "fact_reference_reconciliation";
            return canonical.reconcileFactReferences({ workerId: this.#workerId,
              workerFence: fence, ...scan });
          },
        });
        if (reconciled === "lease_lost") {
          return { kind: "blocked", runId, failureCode: "PROVIDER_IMPORT_LEASE_LOST" };
        }
        if (reconciled !== "complete") {
          return await this.failRun(runs, runId, fence, reconciled === "aborted"
            ? "PROVIDER_CAPTURE_ABORTED" : "PROVIDER_FACT_RECONCILIATION_LIMIT_EXCEEDED");
        }

      }
      if (
        pagesProcessed === maximumPagesThisExecution
        && providerManualImportPageNumberWithinBound(
          startingPageNumber + pagesProcessed,
        )
      ) {
        // Centrally routed executions re-enter through a fresh executor for
        // every page. Retaining the live same-owner lease lets acquire()
        // renew this exact fence on the next step, so recoverActive() resumes
        // the same run instead of treating a deliberate release as a crash.
        retainLeaseForNextPage = true;
        return {
          kind: "progress",
          runId,
          pageCount: startingPageNumber + pagesProcessed - 1,
        };
      }
      return await this.failRun(
        runs,
        runId,
        fence,
        "PROVIDER_IMPORT_PAGE_LIMIT_EXCEEDED",
      );
    } catch (error) {
      const diagnostic = classifyProviderManualImportFailure(error, stage);
      if (runId === null) {
        return { kind: "failed", runId: null, failureCode: diagnostic.failureCode };
      }
      return await this.failRun(runs, runId, fence, diagnostic.failureCode, diagnostic);
    } finally {
      if (!retainLeaseForNextPage) {
        await leases.release({
          role: "import",
          owner: this.#workerId,
          fence,
        });
      }
    }
  }

  private async failRun(
    runs: PrismaProviderRunRepository,
    runId: string,
    fence: bigint,
    failureCode: string,
    diagnostic: ProviderManualImportFailureDiagnostic =
      providerManualImportTerminalDiagnostic(failureCode),
  ): Promise<ProviderManualImportExecutionResult> {
    const finished = await runs.finish({
      runId,
      workerId: this.#workerId,
      workerFence: fence,
      state: "failed",
      failureCode,
      failureClass: diagnostic.failureClass,
      failureSummary: diagnostic.failureSummary,
      correlationId: randomUUID(),
      finishedAt: new Date(),
    });
    if (!("run" in finished)) {
      return {
        kind: "blocked",
        runId,
        failureCode: finished.kind === "lease_lost"
          ? "PROVIDER_IMPORT_LEASE_LOST"
          : "PROVIDER_RUN_FINISH_" + finished.kind.toUpperCase(),
      };
    }
    if (finished.run.state === "succeeded") {
      return {
        kind: "completed",
        runId,
        pageCount: finished.run.counters.pages,
        counters: finished.run.counters,
      };
    }
    return {
      kind: "failed",
      runId,
      failureCode: finished.run.failureCode ?? failureCode,
    };
  }
}

export function createProviderManualImportExecutor(input: Readonly<{
  database: ProviderPrismaClient;
  captureRoot: string | null;
  actorHmacKey: Uint8Array | null;
  workerId: string;
  liveSource?: ProviderManualImportPageSource;
  leaseMilliseconds?: number;
}>): ProviderManualImportExecutor {
  const source = input.liveSource ?? (() => {
    if (input.captureRoot === null || input.actorHmacKey === null) {
      throw new TypeError(
        "Capture imports require a capture root and actor pseudonymization key.",
      );
    }
    return new ProviderCaptureMixedPageSource({
      captureRoot: input.captureRoot,
      actorHmacKey: input.actorHmacKey,
    });
  })();
  return new ProviderManualImportExecutor({
    database: input.database,
    source,
    workerId: input.workerId,
    ...(input.leaseMilliseconds === undefined
      ? {}
      : { leaseMilliseconds: input.leaseMilliseconds }),
  });
}
