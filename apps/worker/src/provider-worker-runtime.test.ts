import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProviderImportWorkerService,
  ProviderSchedulerService,
  type ProviderImportRunSummary,
  type ProviderSchedulerResult,
} from "@packscout/services";
import {
  ProviderWorkerRuntime,
  type ProviderWorkerLogEvent,
} from "./provider-worker-runtime.ts";

const now = new Date("2026-08-06T18:00:00.000Z");

function terminalRun(
  overrides: Partial<ProviderImportRunSummary> = {},
): ProviderImportRunSummary {
  return {
    id: "run-1",
    organizationId: "organization-1",
    providerId: "provider-1",
    configRevisionId: "revision-1",
    trigger: "scheduled",
    state: "succeeded",
    requestedCursor: null,
    finalCursor: "provider-head",
    startedAt: now,
    finishedAt: now,
    heartbeatAt: now,
    counters: {
      accepted: 3,
      duplicate: 0,
      quarantined: 0,
      pages: 1,
      records: 3,
      requestAttempts: 1,
      transientRetries: 0,
    },
    reachedProviderHead: true,
    failureCode: null,
    failureSummary: null,
    ...overrides,
  };
}

function capturingLogger(events: ProviderWorkerLogEvent[]) {
  return { write: (event: ProviderWorkerLogEvent) => events.push(event) };
}

function retentionRunner(calls?: string[]) {
  return {
    async runCycle() {
      calls?.push("retention.run");
      return {
        cutoffAt: now.toISOString(),
        discoveredOrganizations: 0,
        attemptedOrganizations: 0,
        batchesRun: 0,
        expired: 0,
        failed: 0,
        knownRemaining: 0,
        deferredOrganizations: 0,
        capReached: false,
        prunedRecords: 0,
        prunedFailures: 0,
      };
    },
  };
}

test("a worker cycle composes durable scheduling, shared import execution, and health", async () => {
  const calls: string[] = [];
  let claimAvailable = true;
  const schedules = {
    async claimDueProvider() {
      if (!claimAvailable) return null;
      claimAvailable = false;
      calls.push("schedule.claim");
      return {
        organizationId: "organization-1",
        providerId: "provider-1",
        configRevisionId: "revision-1",
        scheduleSeconds: 300,
        staleAfterSeconds: 900,
        dueAt: now,
      };
    },
    async completeClaim() {
      calls.push("schedule.complete");
      return true;
    },
    async releaseClaim() {
      calls.push("schedule.release");
    },
  };
  const sharedImports = {
    async requestImport() {
      calls.push("import.request");
      return { run: { id: "run-1" }, coalesced: false };
    },
    async executeImport() {
      calls.push("import.execute");
      return terminalRun();
    },
    async executeNextImport() {
      calls.push("queue.poll");
      return { kind: "idle" as const };
    },
  };
  const health = {
    async recordRunOutcome(input: {
      reachedProviderHead: boolean;
      failureCode: string | null;
    }) {
      calls.push("health.record");
      assert.equal(input.reachedProviderHead, true);
      assert.equal(input.failureCode, null);
    },
  };
  const runtime = new ProviderWorkerRuntime({
    scheduler: new ProviderSchedulerService({
      schedules,
      imports: sharedImports,
      clock: { now: () => now },
    }),
    imports: new ProviderImportWorkerService(sharedImports, health),
    retention: retentionRunner(calls),
    logger: capturingLogger([]),
    workerId: "worker:1",
  });

  const result = await runtime.runCycle();

  assert.deepEqual(result, {
    claims: 1,
    executions: 1,
    contentions: 0,
    failures: 0,
    reason: "idle",
  });
  assert.deepEqual(calls, [
    "schedule.claim",
    "import.request",
    "schedule.complete",
    "import.execute",
    "health.record",
    "queue.poll",
    "queue.poll",
    "retention.run",
  ]);
});

test("a queued manual run is picked up without waiting for a provider schedule", async () => {
  const calls: string[] = [];
  let queueAvailable = true;
  const sharedImports = {
    async executeImport(): Promise<never> {
      throw new Error("not reached");
    },
    async executeNextImport() {
      calls.push("queue.poll");
      if (!queueAvailable) return { kind: "idle" as const };
      queueAvailable = false;
      return {
        kind: "executed" as const,
        run: terminalRun({ trigger: "manual" }),
      };
    },
  };
  const imports = new ProviderImportWorkerService(sharedImports, {
    async recordRunOutcome() {
      calls.push("health.record");
    },
  });
  const runtime = new ProviderWorkerRuntime({
    scheduler: {
      async runOnce() {
        calls.push("schedule.poll");
        return { kind: "idle" as const };
      },
    },
    imports,
    retention: retentionRunner(calls),
    logger: capturingLogger([]),
    workerId: "worker:1",
  });

  const result = await runtime.runCycle();

  assert.deepEqual(result, {
    claims: 1,
    executions: 1,
    contentions: 0,
    failures: 0,
    reason: "idle",
  });
  assert.deepEqual(calls, [
    "schedule.poll",
    "queue.poll",
    "health.record",
    "schedule.poll",
    "queue.poll",
    "retention.run",
  ]);
});

test("queued ownership loss is recorded as contention and polling continues", async () => {
  const events: ProviderWorkerLogEvent[] = [];
  let schedulerCalls = 0;
  let queueCalls = 0;
  const runtime = new ProviderWorkerRuntime({
    scheduler: {
      async runOnce() {
        schedulerCalls += 1;
        return { kind: "idle" as const };
      },
    },
    imports: {
      async executeImport(): Promise<never> {
        throw new Error("not reached");
      },
      async executeNextImport() {
        queueCalls += 1;
        if (queueCalls === 1) {
          throw {
            code: "RUN_OWNERSHIP_LOST",
            message: "postgresql://worker:super-secret-token@db.test/data",
          };
        }
        return { kind: "idle" as const };
      },
    },
    retention: retentionRunner(),
    logger: capturingLogger(events),
    workerId: "worker:1",
  });

  const result = await runtime.runCycle();

  assert.deepEqual(result, {
    claims: 1,
    executions: 0,
    contentions: 1,
    failures: 0,
    reason: "idle",
  });
  assert.equal(schedulerCalls, 2);
  assert.equal(queueCalls, 2);
  assert.deepEqual(
    events.find(({ event }) => event === "provider_import_contended"),
    {
      level: "info",
      event: "provider_import_contended",
      workerId: "worker:1",
      failureCode: "RUN_OWNERSHIP_LOST",
    },
  );
  assert.equal(
    events.some(({ event }) => event === "provider_import_queue_failed"),
    false,
  );
  assert.equal(JSON.stringify(events).includes("super-secret-token"), false);
});

test("a coalesced active run is attempted without treating lease contention as failure", async () => {
  const events: ProviderWorkerLogEvent[] = [];
  let schedulerCalls = 0;
  const runtime = new ProviderWorkerRuntime({
    scheduler: {
      async runOnce(): Promise<ProviderSchedulerResult> {
        schedulerCalls += 1;
        return schedulerCalls === 1
          ? {
              kind: "coalesced",
              organizationId: "organization-1",
              providerId: "provider\nsuper-secret-token",
              configRevisionId: "revision-1",
              runId: "run-1",
              nextDueAt: new Date(now.getTime() + 300_000),
            }
          : { kind: "idle" };
      },
    },
    imports: {
      async executeImport(): Promise<never> {
        throw {
          code: "IMPORT_RUN_NOT_CLAIMABLE",
          message: "super-secret-token",
        };
      },
      async executeNextImport() {
        return { kind: "idle" as const };
      },
    },
    retention: retentionRunner(),
    logger: capturingLogger(events),
    workerId: "worker:1",
  });

  const result = await runtime.runCycle();

  assert.equal(result.contentions, 1);
  assert.equal(result.failures, 0);
  assert.equal(
    events.some(({ event }) => event === "provider_import_contended"),
    true,
  );
  assert.equal(JSON.stringify(events).includes("super-secret-token"), false);
});

test("scheduler failures stop the cycle without exposing thrown details", async () => {
  const events: ProviderWorkerLogEvent[] = [];
  const runtime = new ProviderWorkerRuntime({
    scheduler: {
      async runOnce(): Promise<never> {
        throw new Error("postgresql://operator:super-secret-token@db.test/data");
      },
    },
    imports: {
      async executeImport(): Promise<never> {
        throw new Error("not reached");
      },
      async executeNextImport() {
        return { kind: "idle" as const };
      },
    },
    retention: retentionRunner(),
    logger: capturingLogger(events),
    workerId: "worker:1",
  });

  const result = await runtime.runCycle();

  assert.equal(result.reason, "scheduler_failed");
  assert.equal(result.failures, 1);
  assert.equal(JSON.stringify(events).includes("super-secret-token"), false);
});

test("graceful stop finishes an in-flight import and takes no new claim", async () => {
  const events: ProviderWorkerLogEvent[] = [];
  let schedulerCalls = 0;
  let releaseImport: (() => void) | undefined;
  let markImportStarted: (() => void) | undefined;
  const importGate = new Promise<void>((resolve) => {
    releaseImport = resolve;
  });
  const importStarted = new Promise<void>((resolve) => {
    markImportStarted = resolve;
  });
  const runtime = new ProviderWorkerRuntime({
    scheduler: {
      async runOnce(): Promise<ProviderSchedulerResult> {
        schedulerCalls += 1;
        return {
          kind: "started",
          organizationId: "organization-1",
          providerId: "provider-1",
          configRevisionId: "revision-1",
          runId: "run-1",
          nextDueAt: new Date(now.getTime() + 300_000),
        };
      },
    },
    imports: {
      async executeImport() {
        markImportStarted?.();
        await importGate;
        return terminalRun();
      },
      async executeNextImport() {
        return { kind: "idle" as const };
      },
    },
    retention: retentionRunner(),
    logger: capturingLogger(events),
    workerId: "worker:1",
    pollIntervalMilliseconds: 100,
  });

  const running = runtime.start();
  await importStarted;
  runtime.stop();
  releaseImport?.();
  await running;

  assert.equal(schedulerCalls, 1);
  assert.deepEqual(
    events
      .filter(({ event }) => event.startsWith("provider_worker_"))
      .map(({ event }) => event),
    ["provider_worker_started", "provider_worker_stopped"],
  );
});

test("a cycle drains only its configured bounded claim count", async () => {
  let schedulerCalls = 0;
  const runtime = new ProviderWorkerRuntime({
    scheduler: {
      async runOnce(): Promise<ProviderSchedulerResult> {
        schedulerCalls += 1;
        return {
          kind: "not_enabled",
          organizationId: "organization-1",
          providerId: `provider-${schedulerCalls}`,
          configRevisionId: "revision-1",
          runId: null,
          nextDueAt: null,
        };
      },
    },
    imports: {
      async executeImport(): Promise<never> {
        throw new Error("not reached");
      },
      async executeNextImport() {
        return { kind: "idle" as const };
      },
    },
    retention: retentionRunner(),
    logger: capturingLogger([]),
    workerId: "worker:1",
    maximumClaimsPerCycle: 2,
  });

  const result = await runtime.runCycle();

  assert.equal(result.reason, "claim_limit");
  assert.equal(result.claims, 2);
  assert.equal(schedulerCalls, 2);
});

test("retention runs after imports and failures never poison later polling", async () => {
  const events: ProviderWorkerLogEvent[] = [];
  const calls: string[] = [];
  let retentionCalls = 0;
  const runtime = new ProviderWorkerRuntime({
    scheduler: {
      async runOnce() {
        calls.push("schedule.poll");
        return { kind: "idle" as const };
      },
    },
    imports: {
      async executeImport(): Promise<never> {
        throw new Error("not reached");
      },
      async executeNextImport() {
        calls.push("queue.poll");
        return { kind: "idle" as const };
      },
    },
    retention: {
      async runCycle() {
        calls.push("retention.run");
        retentionCalls += 1;
        if (retentionCalls === 1) {
          throw new Error("postgresql://worker:super-secret-token@db.test/data");
        }
        return retentionRunner().runCycle();
      },
    },
    logger: capturingLogger(events),
    workerId: "worker:1",
  });

  const first = await runtime.runCycle();
  const second = await runtime.runCycle();

  assert.equal(first.reason, "idle");
  assert.equal(second.reason, "idle");
  assert.deepEqual(calls, [
    "schedule.poll",
    "queue.poll",
    "retention.run",
    "schedule.poll",
    "queue.poll",
    "retention.run",
  ]);
  assert.equal(
    events.some(
      ({ event, failureCode }) =>
        event === "provider_retention_cycle_failed" &&
        failureCode === "RETENTION_CYCLE_ERROR",
    ),
    true,
  );
  assert.equal(
    events.some(
      ({ event }) => event === "provider_retention_cycle_finished",
    ),
    true,
  );
  assert.equal(JSON.stringify(events).includes("super-secret-token"), false);
});

test("bounded retention failures are surfaced without changing import counts", async () => {
  const events: ProviderWorkerLogEvent[] = [];
  const runtime = new ProviderWorkerRuntime({
    scheduler: { runOnce: async () => ({ kind: "idle" }) },
    imports: {
      async executeImport(): Promise<never> {
        throw new Error("not reached");
      },
      executeNextImport: async () => ({ kind: "idle" }),
    },
    retention: {
      async runCycle() {
        return {
          cutoffAt: now.toISOString(),
          discoveredOrganizations: 2,
          attemptedOrganizations: 2,
          batchesRun: 3,
          expired: 4,
          failed: 1,
          knownRemaining: 5,
          deferredOrganizations: 1,
          capReached: true,
          prunedRecords: 2,
          prunedFailures: 0,
        };
      },
    },
    logger: capturingLogger(events),
    workerId: "worker:1",
  });

  const result = await runtime.runCycle();

  assert.deepEqual(result, {
    claims: 0,
    executions: 0,
    contentions: 0,
    failures: 0,
    reason: "idle",
  });
  assert.deepEqual(
    events.find(
      ({ event }) => event === "provider_retention_cycle_finished",
    ),
    {
      level: "error",
      event: "provider_retention_cycle_finished",
      workerId: "worker:1",
      outcome: "degraded",
      retentionBatches: 3,
      retentionExpired: 4,
      retentionFailures: 1,
      retentionDeferredOrganizations: 1,
      retentionCapReached: true,
      retentionPruned: 2,
      retentionPruneFailures: 0,
      failureCode: "RETENTION_BATCH_FAILED",
    },
  );
});

test("estimated EV work is isolated from import success and recovers on later cycles", async () => {
  const events: ProviderWorkerLogEvent[] = [];
  const calls: string[] = [];
  let evCycles = 0;
  const runtime = new ProviderWorkerRuntime({
    scheduler: { runOnce: async () => ({ kind: "idle" }) },
    imports: {
      async executeImport(): Promise<never> {
        throw new Error("not reached");
      },
      executeNextImport: async () => ({ kind: "idle" }),
    },
    estimatedEv: {
      async runCycle() {
        calls.push("estimated-ev.run");
        evCycles += 1;
        if (evCycles === 1) throw new Error("private-provider-payload");
        return {
          claimed: 2,
          completed: 1,
          estimated: 0,
          unavailable: 1,
          retrying: 1,
          failed: 0,
          lost: 0,
          capReached: true,
        };
      },
    },
    retention: retentionRunner(calls),
    logger: capturingLogger(events),
    workerId: "worker:1",
  });

  const first = await runtime.runCycle();
  const second = await runtime.runCycle();

  assert.deepEqual(first, {
    claims: 0,
    executions: 0,
    contentions: 0,
    failures: 0,
    reason: "idle",
  });
  assert.deepEqual(second, first);
  assert.deepEqual(calls, [
    "estimated-ev.run",
    "retention.run",
    "estimated-ev.run",
    "retention.run",
  ]);
  assert.deepEqual(
    events.find(
      ({ event }) => event === "provider_estimated_ev_cycle_finished",
    ),
    {
      level: "error",
      event: "provider_estimated_ev_cycle_finished",
      workerId: "worker:1",
      outcome: "degraded",
      evClaimed: 2,
      evCompleted: 1,
      evUnavailable: 1,
      evFailures: 1,
      evCapReached: true,
      failureCode: "ESTIMATED_EV_REQUEST_FAILED",
    },
  );
  assert.equal(
    events.some(
      ({ event, failureCode }) =>
        event === "provider_estimated_ev_cycle_failed" &&
        failureCode === "ESTIMATED_EV_CYCLE_ERROR",
    ),
    true,
  );
  assert.equal(JSON.stringify(events).includes("private-provider-payload"), false);
});
