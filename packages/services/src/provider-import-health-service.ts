import type {
  ProviderImportQueueExecutionResult,
  ProviderImportRunSummary,
  ProviderImportWorkerLane,
} from "./provider-import-types.ts";
import type {
  OperationalEventService,
  PipelineOperationalReporter,
} from "./operational-events.ts";

export interface ProviderImportExecutionPort {
  executeImport(input: {
    organizationId: string;
    runId: string;
    workerId: string;
    workerLane?: ProviderImportWorkerLane;
  }): Promise<ProviderImportRunSummary>;
}

export interface ProviderImportQueueExecutionPort {
  executeNextImport(input: {
    workerId: string;
  }): Promise<ProviderImportQueueExecutionResult>;
}

export interface ProviderRunHealthPort {
  recordRunOutcome(input: {
    organizationId: string;
    providerId: string;
    reachedProviderHead: boolean;
    failureCode: string | null;
    finishedAt: Date;
  }): Promise<void>;
}

export interface ProviderImportOperationalHooks {
  readonly events: Pick<
    OperationalEventService,
    "providerRecovered" | "runFailed" | "runIncomplete"
  >;
  readonly reporter: Pick<PipelineOperationalReporter, "cursorLag" | "run">;
}

export class ProviderImportHealthService {
  constructor(
    private readonly imports: ProviderImportExecutionPort,
    private readonly health: ProviderRunHealthPort,
    private readonly operational?: ProviderImportOperationalHooks,
  ) {}

  async executeImport(input: {
    organizationId: string;
    runId: string;
    workerId: string;
  }): Promise<ProviderImportRunSummary> {
    return this.recordOutcome(await this.imports.executeImport(input));
  }

  protected async recordOutcome(
    run: ProviderImportRunSummary,
  ): Promise<ProviderImportRunSummary> {
    if (
      !run.finishedAt &&
      (run.state === "queued" || run.state === "running")
    ) {
      return run;
    }
    if (!run.finishedAt) {
      throw new Error("Import execution returned a non-terminal run.");
    }
    await this.health.recordRunOutcome({
      organizationId: run.organizationId,
      providerId: run.providerId,
      reachedProviderHead: run.reachedProviderHead,
      failureCode: run.failureCode,
      finishedAt: run.finishedAt,
    });
    await this.reportTerminalRun(run);
    return run;
  }

  private async reportTerminalRun(
    run: ProviderImportRunSummary,
  ): Promise<void> {
    if (!this.operational || !run.finishedAt) return;
    const durationMs = run.startedAt
      ? Math.max(0, run.finishedAt.getTime() - run.startedAt.getTime())
      : 0;
    const outcome =
      run.state === "succeeded"
        ? "SUCCEEDED"
        : run.state === "incomplete"
          ? "INCOMPLETE"
          : "FAILED";
    try {
      this.operational.reporter.run({
        organizationId: run.organizationId,
        providerId: run.providerId,
        outcome,
        durationMs,
        pages: run.counters.pages,
        records: run.counters.records,
      });
    } catch {
      // Terminal persistence is authoritative; reporting is failure-isolated.
    }
    try {
      this.operational.reporter.cursorLag({
        organizationId: run.organizationId,
        providerId: run.providerId,
        pagesBehindProxy: run.reachedProviderHead ? 0 : 1,
      });
    } catch {
      // One telemetry failure must not suppress the remaining runtime hooks.
    }
    try {
      if (run.state === "failed") {
        await this.operational.events.runFailed({
          organizationId: run.organizationId,
          providerId: run.providerId,
          runId: run.id,
          failureCode: run.failureCode ?? "PROVIDER_IMPORT_FAILED",
        });
      } else if (run.state === "incomplete") {
        await this.operational.events.runIncomplete({
          organizationId: run.organizationId,
          providerId: run.providerId,
          runId: run.id,
          failureCode: run.failureCode,
        });
      } else if (run.reachedProviderHead) {
        await this.operational.events.providerRecovered({
          organizationId: run.organizationId,
          providerId: run.providerId,
        });
      }
    } catch {
      // Notification delivery cannot change an already persisted run outcome.
    }
  }
}

export class ProviderImportWorkerService extends ProviderImportHealthService {
  constructor(
    private readonly workerImports: ProviderImportExecutionPort &
      ProviderImportQueueExecutionPort,
    health: ProviderRunHealthPort,
    operational?: ProviderImportOperationalHooks,
  ) {
    super(workerImports, health, operational);
  }

  async executeNextImport(input: {
    workerId: string;
  }): Promise<ProviderImportQueueExecutionResult> {
    const result = await this.workerImports.executeNextImport(input);
    if (result.kind === "idle") return result;
    return {
      kind: "executed",
      run: await this.recordOutcome(result.run),
    };
  }
}
