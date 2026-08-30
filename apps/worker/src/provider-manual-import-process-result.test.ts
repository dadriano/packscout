import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderManualImportExecutionResult } from
  "./provider-manual-import-executor.ts";
import type { ProviderManualImportLaneOutcome } from
  "./provider-manual-import-lane-supervisor.ts";
import { providerManualImportProcessExitCode } from
  "./provider-manual-import-process-result.ts";

const runId = "00000000-0000-4000-8000-000000000031";
const completed: ProviderManualImportExecutionResult = Object.freeze({
  kind: "completed",
  runId,
  pageCount: 2,
  counters: Object.freeze({
    pages: 2,
    catalog: 1,
    pulls: 0,
    marketEvents: 0,
    accepted: 1,
    duplicate: 0,
    quarantined: 0,
    materialChanges: 1,
  }),
});

test("single-lane process status exhaustively distinguishes success from blockage", () => {
  const expectations: readonly Readonly<{
    result: ProviderManualImportExecutionResult;
    exitCode: 0 | 1;
  }>[] = [
    { result: { kind: "idle" }, exitCode: 0 },
    { result: completed, exitCode: 0 },
    { result: { kind: "contended" }, exitCode: 1 },
    { result: { kind: "progress", runId, pageCount: 1 }, exitCode: 1 },
    {
      result: {
        kind: "blocked",
        runId,
        failureCode: "PROVIDER_IMPORT_LEASE_LOST",
      },
      exitCode: 1,
    },
    {
      result: {
        kind: "failed",
        runId,
        failureCode: "PROVIDER_CAPTURE_RECORD_INVALID",
      },
      exitCode: 1,
    },
  ];

  for (const expectation of expectations) {
    assert.equal(
      providerManualImportProcessExitCode(expectation.result),
      expectation.exitCode,
      expectation.result.kind,
    );
  }
});

test("resolved Clutch failure makes the process fail without changing Courtyard success", () => {
  const outcomes: readonly ProviderManualImportLaneOutcome[] = Object.freeze([
    Object.freeze({
      providerId: "00000000-0000-4000-8000-000000000020",
      providerKey: "clutchpacks",
      status: "fulfilled",
      result: Object.freeze({
        kind: "failed",
        runId,
        failureCode: "PROVIDER_CAPTURE_RECORD_INVALID",
      }),
    }),
    Object.freeze({
      providerId: "00000000-0000-4000-8000-000000000021",
      providerKey: "courtyard",
      status: "fulfilled",
      result: completed,
    }),
  ]);

  assert.equal(providerManualImportProcessExitCode(outcomes), 1);
  assert.equal(outcomes[0]?.status, "fulfilled");
  assert.equal(outcomes[0]?.result.kind, "failed");
  assert.equal(outcomes[1]?.status, "fulfilled");
  assert.equal(outcomes[1]?.result.kind, "completed");
});

test("multi-lane idle and completed outcomes succeed while rejection fails", () => {
  const successful: readonly ProviderManualImportLaneOutcome[] = [
    {
      providerId: "00000000-0000-4000-8000-000000000020",
      providerKey: "clutchpacks",
      status: "fulfilled",
      result: { kind: "idle" },
    },
    {
      providerId: "00000000-0000-4000-8000-000000000021",
      providerKey: "courtyard",
      status: "fulfilled",
      result: completed,
    },
  ];
  const rejected: readonly ProviderManualImportLaneOutcome[] = [
    ...successful,
    {
      providerId: "00000000-0000-4000-8000-000000000022",
      providerKey: "collector_crypt",
      status: "rejected",
      failureCode: "PROVIDER_IMPORT_CAPABILITY_UNAVAILABLE",
    },
  ];

  assert.equal(providerManualImportProcessExitCode(successful), 0);
  assert.equal(providerManualImportProcessExitCode(rejected), 1);
});
