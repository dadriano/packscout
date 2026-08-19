import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProviderImportHealthService,
  type ProviderImportOperationalHooks,
  type ProviderRunHealthPort,
} from "./provider-import-health-service.ts";
import type { ProviderImportRunSummary } from "./provider-import-types.ts";

function terminalRun(
  overrides: Partial<ProviderImportRunSummary> = {},
): ProviderImportRunSummary {
  return {
    id: "run-1",
    organizationId: "organization-1",
    providerId: "provider-1",
    configRevisionId: "revision-1",
    trigger: "scheduled",
    archiveSha256: null,
    state: "succeeded",
    requestedCursor: null,
    finalCursor: "cursor-1",
    startedAt: new Date("2026-08-06T12:00:00.000Z"),
    finishedAt: new Date("2026-08-06T12:00:05.000Z"),
    heartbeatAt: new Date("2026-08-06T12:00:04.000Z"),
    counters: {
      accepted: 1,
      duplicate: 0,
      quarantined: 0,
      pages: 1,
      records: 1,
      requestAttempts: 1,
      transientRetries: 0,
    },
    reachedProviderHead: true,
    failureCode: null,
    failureSummary: null,
    ...overrides,
  };
}

test("terminal import outcomes update provider health with bounded run evidence", async () => {
  const healthInputs: Parameters<ProviderRunHealthPort["recordRunOutcome"]>[0][] = [];
  const service = new ProviderImportHealthService(
    { executeImport: async () => terminalRun() },
    { recordRunOutcome: async (input) => void healthInputs.push(input) },
  );

  const result = await service.executeImport({
    organizationId: "organization-1",
    runId: "run-1",
    workerId: "worker-1",
  });

  assert.equal(result.state, "succeeded");
  assert.deepEqual(healthInputs, [
    {
      organizationId: "organization-1",
      providerId: "provider-1",
      reachedProviderHead: true,
      failureCode: null,
      finishedAt: new Date("2026-08-06T12:00:05.000Z"),
    },
  ]);
});

test("failed imports retain their sanitized failure code in health", async () => {
  let healthFailureCode: string | null | undefined;
  const service = new ProviderImportHealthService(
    {
      executeImport: async () =>
        terminalRun({
          state: "failed",
          reachedProviderHead: false,
          failureCode: "IMPORT_TIMEOUT",
          failureSummary: "Provider request timed out.",
        }),
    },
    {
      recordRunOutcome: async (input) => {
        healthFailureCode = input.failureCode;
      },
    },
  );

  await service.executeImport({
    organizationId: "organization-1",
    runId: "run-1",
    workerId: "worker-1",
  });
  assert.equal(healthFailureCode, "IMPORT_TIMEOUT");
});

test("a cooperative page-budget yield does not change health or emit terminal telemetry", async () => {
  const calls: string[] = [];
  const yielded = terminalRun({
    state: "queued",
    reachedProviderHead: false,
    finishedAt: null,
    failureCode: null,
    failureSummary: null,
  });
  const service = new ProviderImportHealthService(
    { executeImport: async () => yielded },
    {
      async recordRunOutcome() {
        calls.push("health");
      },
    },
    {
      events: {
        async runFailed() {
          calls.push("failed");
          return { status: "accepted", alertId: null, failureCode: null };
        },
        async runIncomplete() {
          calls.push("incomplete");
          return { status: "accepted", alertId: null, failureCode: null };
        },
        async providerRecovered() {
          calls.push("recovered");
          return { status: "resolved", alertId: null, failureCode: null };
        },
      },
      reporter: {
        run() {
          calls.push("run-metric");
        },
        cursorLag() {
          calls.push("lag-metric");
        },
      },
    },
  );

  const result = await service.executeImport({
    organizationId: yielded.organizationId,
    runId: yielded.id,
    workerId: "cooperative-worker",
  });

  assert.equal(result, yielded);
  assert.deepEqual(calls, []);
});

test("terminal outcomes emit fixed events and run measurements after health persistence", async () => {
  const calls: string[] = [];
  const operational: ProviderImportOperationalHooks = {
    events: {
      async runFailed(input) {
        calls.push(`event:failed:${input.failureCode}`);
        return { status: "accepted", alertId: null, failureCode: null };
      },
      async runIncomplete() {
        calls.push("event:incomplete");
        return { status: "accepted", alertId: null, failureCode: null };
      },
      async providerRecovered() {
        calls.push("event:recovered");
        return { status: "resolved", alertId: null, failureCode: null };
      },
    },
    reporter: {
      run(input) {
        calls.push(`metric:run:${input.outcome}:${input.durationMs}`);
      },
      cursorLag(input) {
        calls.push(`metric:lag:${input.pagesBehindProxy}`);
      },
    },
  };
  const service = new ProviderImportHealthService(
    {
      executeImport: async () =>
        terminalRun({
          state: "failed",
          reachedProviderHead: false,
          failureCode: "IMPORT_TIMEOUT",
        }),
    },
    {
      async recordRunOutcome() {
        calls.push("health");
      },
    },
    operational,
  );

  await service.executeImport({
    organizationId: "organization-1",
    runId: "run-1",
    workerId: "worker-1",
  });

  assert.deepEqual(calls, [
    "health",
    "metric:run:FAILED:5000",
    "metric:lag:1",
    "event:failed:IMPORT_TIMEOUT",
  ]);
});

test("incomplete and head-reaching runs select their matching lifecycle events", async () => {
  const events: string[] = [];
  const operational: ProviderImportOperationalHooks = {
    events: {
      async runFailed() {
        events.push("failed");
        return { status: "accepted", alertId: null, failureCode: null };
      },
      async runIncomplete() {
        events.push("incomplete");
        return { status: "accepted", alertId: null, failureCode: null };
      },
      async providerRecovered() {
        events.push("recovered");
        return { status: "resolved", alertId: null, failureCode: null };
      },
    },
    reporter: { run() {}, cursorLag() {} },
  };
  let run = terminalRun({
    state: "incomplete",
    reachedProviderHead: false,
    failureCode: "IMPORT_INCOMPLETE",
  });
  const service = new ProviderImportHealthService(
    { executeImport: async () => run },
    { recordRunOutcome: async () => undefined },
    operational,
  );

  await service.executeImport({
    organizationId: "organization-1",
    runId: "run-1",
    workerId: "worker-1",
  });
  run = terminalRun();
  await service.executeImport({
    organizationId: "organization-1",
    runId: "run-2",
    workerId: "worker-1",
  });

  assert.deepEqual(events, ["incomplete", "recovered"]);
});

test("operational sink failures never change an already persisted import outcome", async () => {
  let eventAttempted = false;
  const service = new ProviderImportHealthService(
    { executeImport: async () => terminalRun() },
    { recordRunOutcome: async () => undefined },
    {
      events: {
        runFailed: async () => {
          throw new Error("sink unavailable");
        },
        runIncomplete: async () => {
          throw new Error("sink unavailable");
        },
        providerRecovered: async () => {
          eventAttempted = true;
          throw new Error("sink unavailable");
        },
      },
      reporter: {
        run() {
          throw new Error("metrics unavailable");
        },
        cursorLag() {
          throw new Error("metrics unavailable");
        },
      },
    },
  );

  const result = await service.executeImport({
    organizationId: "organization-1",
    runId: "run-1",
    workerId: "worker-1",
  });
  assert.equal(result.state, "succeeded");
  assert.equal(eventAttempted, true);
});
