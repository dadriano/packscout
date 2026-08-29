import { randomUUID } from "node:crypto";
import {
  PrismaProviderCommandRepository,
  PrismaProviderMixedPageRepository,
  PrismaProviderRunRepository,
  PrismaProviderRuntimeRepository,
  PrismaProviderWorkerLeaseRepository,
  type ProviderPrismaClient,
  type ProviderRunCounters,
} from "@packscout/database";
import { ProviderCaptureMixedPageSource } from
  "./provider-capture-mixed-page-source.ts";
import {
  ProviderCaptureSourceError,
  type ProviderCapturePageSourceInput,
} from "./provider-capture-source-contract.ts";

const DEFAULT_LEASE_MILLISECONDS = 5 * 60_000;
const MAXIMUM_CAPTURE_PAGES = 20;

export type ClutchpacksManualImportExecutionResult =
  | Readonly<{ kind: "idle" | "contended" }>
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

export interface ProviderManualImportPageSource {
  supports(adapterKey: string, providerKey: string): boolean;
  nextPage(input: ProviderCapturePageSourceInput): Promise<unknown>;
}

function safeFailureCode(error: unknown): string {
  return error instanceof ProviderCaptureSourceError
    ? error.code
    : "PROVIDER_IMPORT_EXECUTION_FAILED";
}

/**
 * Bounded first-provider executor. It consumes one accepted local Run-now
 * command, claims the provider-local lease, and commits the deterministic
 * ClutchPacks capture through the generic mixed-page repository.
 */
export class ClutchpacksManualImportExecutor {
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
      throw new TypeError("ClutchPacks import lease duration is invalid.");
    }
    this.#leaseMilliseconds = leaseMilliseconds;
    this.#workerId = dependencies.workerId;
  }

  async executeNext(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ClutchpacksManualImportExecutionResult> {
    if (signal.aborted) {
      return { kind: "blocked", runId: null, failureCode: "PROVIDER_CAPTURE_ABORTED" };
    }
    const commands = new PrismaProviderCommandRepository(this.dependencies.database);
    const command = await commands.nextAccepted();
    if (command === null) return { kind: "idle" };
    if (command.command_type !== "run") {
      return {
        kind: "blocked",
        runId: null,
        failureCode: "PROVIDER_MANUAL_COMMAND_UNSUPPORTED",
      };
    }

    // Capability is checked before acquiring a lease or changing the queued
    // command/run. A stale or unknown adapter therefore cannot consume local
    // execution authority and leaves the accepted command available for an
    // operator-visible configuration correction.
    const runtime = await new PrismaProviderRuntimeRepository(
      this.dependencies.database,
    ).snapshot();
    const configuration = runtime.cachedConfiguration;
    if (configuration === null) {
      return {
        kind: "blocked",
        runId: null,
        failureCode: "PROVIDER_CONFIGURATION_UNAVAILABLE",
      };
    }
    const adapterKey = configuration.configuration.adapterKey;
    if (
      typeof adapterKey !== "string"
      || !this.dependencies.source.supports(adapterKey, runtime.providerKey)
    ) {
      return {
        kind: "blocked",
        runId: null,
        failureCode: "PROVIDER_SOURCE_ADAPTER_UNAVAILABLE",
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
    const runs = new PrismaProviderRunRepository(this.dependencies.database);
    let runId: string | null = null;
    try {
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
          runId: null,
          failureCode: "PROVIDER_RUN_" + started.kind.toUpperCase(),
        };
      }
      runId = started.run.id;
      if (started.run.state !== "running") {
        return {
          kind: "blocked",
          runId,
          failureCode: "PROVIDER_RUN_NOT_RUNNING",
        };
      }

      let checkpoint = started.run.cursorFingerprint;
      const pages = new PrismaProviderMixedPageRepository(
        this.dependencies.database,
      );
      for (let index = 0; index < MAXIMUM_CAPTURE_PAGES; index += 1) {
        if (signal.aborted) {
          return this.failRun(runs, runId, fence, "PROVIDER_CAPTURE_ABORTED");
        }
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
          sourceCheckpointFingerprint: checkpoint,
          signal,
        });
        const committed = await pages.commit({
          workerId: this.#workerId,
          page,
        });
        if (committed.kind !== "committed" && committed.kind !== "replayed") {
          return this.failRun(
            runs,
            runId,
            fence,
            "PROVIDER_MIXED_PAGE_" + committed.kind.toUpperCase(),
          );
        }
        checkpoint = committed.resultingCursorFingerprint;
        if (!committed.reachedHead) continue;
        const finished = await runs.finish({
          runId,
          workerId: this.#workerId,
          workerFence: fence,
          state: "succeeded",
          failureCode: null,
          failureClass: null,
          failureSummary: null,
          correlationId: randomUUID(),
          finishedAt: new Date(),
        });
        if (
          finished.kind !== "finished"
          && finished.kind !== "already_terminal"
        ) {
          return {
            kind: "blocked",
            runId,
            failureCode: "PROVIDER_RUN_FINISH_" + finished.kind.toUpperCase(),
          };
        }
        return {
          kind: "completed",
          runId,
          pageCount: finished.run.counters.pages,
          counters: finished.run.counters,
        };
      }
      return this.failRun(
        runs,
        runId,
        fence,
        "PROVIDER_CAPTURE_PAGE_LIMIT_EXCEEDED",
      );
    } catch (error) {
      if (runId === null) {
        return { kind: "failed", runId: null, failureCode: safeFailureCode(error) };
      }
      return this.failRun(runs, runId, fence, safeFailureCode(error));
    } finally {
      await leases.release({
        role: "import",
        owner: this.#workerId,
        fence,
      });
    }
  }

  private async failRun(
    runs: PrismaProviderRunRepository,
    runId: string,
    fence: bigint,
    failureCode: string,
  ): Promise<ClutchpacksManualImportExecutionResult> {
    await runs.finish({
      runId,
      workerId: this.#workerId,
      workerFence: fence,
      state: "failed",
      failureCode,
      failureClass: "source",
      failureSummary: "The provider import stopped with a bounded source failure.",
      correlationId: randomUUID(),
      finishedAt: new Date(),
    });
    return { kind: "failed", runId, failureCode };
  }
}

export function createClutchpacksManualImportExecutor(input: Readonly<{
  database: ProviderPrismaClient;
  captureRoot: string;
  actorHmacKey: Uint8Array;
  workerId: string;
  leaseMilliseconds?: number;
}>): ClutchpacksManualImportExecutor {
  return new ClutchpacksManualImportExecutor({
    database: input.database,
    source: new ProviderCaptureMixedPageSource({
      captureRoot: input.captureRoot,
      actorHmacKey: input.actorHmacKey,
    }),
    workerId: input.workerId,
    ...(input.leaseMilliseconds === undefined
      ? {}
      : { leaseMilliseconds: input.leaseMilliseconds }),
  });
}
