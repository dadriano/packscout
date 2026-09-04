import { randomUUID } from "node:crypto";
import { PrismaProviderHeadReconciliationRepository, PrismaProviderRunRepository,
  PrismaProviderWorkerLeaseRepository, type ProviderPrismaClient } from "@packscout/database";
import type { ProviderManualImportExecutionResult } from "./provider-manual-import-executor.ts";
import type { ProviderManualImportStage } from "./provider-manual-import-diagnostics.ts";

export async function finishProviderImportHead(input: {
  database: ProviderPrismaClient; runId: string; workerId: string; fence: bigint;
  leaseMilliseconds: number; transactionMilliseconds: number; signal: AbortSignal;
  onStage(stage: ProviderManualImportStage): void;
}): Promise<ProviderManualImportExecutionResult> {
  if (input.signal.aborted) return { kind: "blocked", runId: input.runId, failureCode: "PROVIDER_CAPTURE_ABORTED" };
  input.onStage("lease_renewal");
  if (!await new PrismaProviderWorkerLeaseRepository(input.database).renew({ role: "import", owner: input.workerId,
    fence: input.fence, leaseMilliseconds: input.leaseMilliseconds })) {
    return { kind: "blocked", runId: input.runId, failureCode: "PROVIDER_IMPORT_LEASE_LOST" };
  }
  input.onStage("head_reconciliation");
  const step = await new PrismaProviderHeadReconciliationRepository(input.database).step({
    runId: input.runId, workerId: input.workerId, workerFence: input.fence,
    timeoutMilliseconds: input.transactionMilliseconds,
  });
  const runs = new PrismaProviderRunRepository(input.database);
  if (step === "progress") {
    const active = await runs.active();
    if (!active || active.id !== input.runId) return { kind: "blocked", runId: input.runId, failureCode: "PROVIDER_RUN_NOT_RUNNING" };
    return { kind: "progress", runId: input.runId, pageCount: active.counters.pages, reconciliationPending: true };
  }
  if (step !== "complete") return { kind: "blocked", runId: input.runId,
    failureCode: step === "lease_lost" ? "PROVIDER_IMPORT_LEASE_LOST" : "PROVIDER_HEAD_RECONCILIATION_NOT_READY" };
  if (input.signal.aborted) return { kind: "blocked", runId: input.runId, failureCode: "PROVIDER_CAPTURE_ABORTED" };
  input.onStage("run_finish");
  const finished = await runs.finish({ runId: input.runId, workerId: input.workerId, workerFence: input.fence,
    state: "succeeded", failureCode: null, failureClass: null, failureSummary: null, correlationId: randomUUID(), finishedAt: new Date() });
  if (finished.kind !== "finished" && finished.kind !== "already_terminal") return { kind: "blocked", runId: input.runId,
    failureCode: finished.kind === "lease_lost" ? "PROVIDER_IMPORT_LEASE_LOST" : "PROVIDER_RUN_FINISH_" + finished.kind.toUpperCase() };
  return { kind: "completed", runId: input.runId, pageCount: finished.run.counters.pages, counters: finished.run.counters };
}
