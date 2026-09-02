import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderTransactionClient } from "./provider-database.ts";
import {
  providerResumeEvidenceDigest,
  providerRuntimeResumeGuardMatches,
  type ProviderCatalogOriginResumeGuard,
  type ProviderCatalogQueuedResumeGuard,
} from "./provider-runtime-resume-guard.ts";

const now = new Date("2026-09-01T04:00:00.000Z");
const providerId = "41000000-0000-4000-8000-000000000001";
const operatorId = "41000000-0000-4000-8000-000000000002";
const operationId = "41000000-0000-4000-8000-000000000003";
const configId = "41000000-0000-4000-8000-000000000004";
const runId = "41000000-0000-4000-8000-000000000005";
const pauseCommandId = "41000000-0000-4000-8000-000000000006";
const resumeCommandId = "41000000-0000-4000-8000-000000000007";
const lease = {
  worker_role: "import" as const,
  lease_owner: `live:catalog-bridge:${operationId}`,
  lease_fence: 19n,
  heartbeat_at: now,
  lease_expires_at: new Date(now.getTime() + 60_000),
  row_version: 8n,
  database_now: now,
};
const latest = {
  id: runId,
  state: "incomplete",
  config_version_id: "41000000-0000-4000-8000-000000000008",
  config_version_number: 3n,
  failure_code: "PROVIDER_IMPORT_RUNTIME_UNAVAILABLE",
  final_cursor_hash: "a".repeat(64),
  finished_at: new Date("2026-09-01T03:59:00.000Z"),
};
const pause = {
  id: pauseCommandId,
  idempotency_key: `catalog-bridge/${operationId}/running/pause`,
  command_type: "pause",
  state: "completed",
  target_run_id: null,
  target_quarantine_id: null,
  expected_generation: 11n,
  requested_by_operator_id: operatorId,
  correlation_id: operationId,
  reason: "DataForrest collector_crypt catalog bridge checkpoint drain",
  result: { outcome: "accepted", code: "RUNTIME_TRANSITION_APPLIED", generation: "12" },
  resulting_run_id: null,
  requested_at: new Date("2026-09-01T03:58:29.000Z"),
  completed_at: new Date("2026-09-01T03:58:30.000Z"),
};

function pauseDigest(value = pause) {
  return providerResumeEvidenceDigest({
    id: value.id, idempotencyKey: value.idempotency_key, commandType: value.command_type,
    state: value.state, targetRunId: value.target_run_id, targetQuarantineId: value.target_quarantine_id,
    expectedGeneration: value.expected_generation.toString(), requestedByOperatorId: value.requested_by_operator_id,
    correlationId: value.correlation_id, reason: value.reason, resultOutcome: value.result.outcome,
    resultCode: value.result.code, resultGeneration: value.result.generation,
    resultingRunId: value.resulting_run_id, requestedAt: value.requested_at.toISOString(),
    completedAt: value.completed_at.toISOString(),
  });
}

function guard(): ProviderCatalogOriginResumeGuard {
  return {
    entry: "paused_catalog_origin",
    providerId,
    configVersionId: configId,
    configVersionNumber: 4n,
    runtimeRowVersion: 23n,
    checkpointHash: null,
    checkpoint: null,
    originReceiptDigest: "b".repeat(64),
    latestRunId: runId,
    latestRunDigest: providerResumeEvidenceDigest(latest),
    pauseCommandId,
    pauseCommandDigest: pauseDigest(),
    expectedImportLease: { owner: lease.lease_owner, fence: lease.lease_fence },
    notAfter: new Date(now.getTime() + 60_000),
  };
}

function fixture(input: Readonly<{
  replay?: boolean;
  active?: number;
  actionable?: number;
  cursor?: unknown;
  cursorHash?: string | null;
  configVersionId?: string;
  correlationId?: string;
}> = {}) {
  const replay = input.replay ?? false;
  const runtime = {
    central_provider_id: providerId,
    operating_state: replay ? "idle" : "paused",
    state_generation: replay ? 13n : 12n,
    row_version: replay ? 24n : 23n,
    cached_config_version_id: input.configVersionId ?? configId,
    cached_config_version_number: 4n,
    config_expires_at: null,
    source_cursor: input.cursor ?? null,
    source_cursor_hash: input.cursorHash ?? null,
  };
  const expectedGuard = guard();
  const { expectedImportLease: _expectedImportLease, notAfter: _notAfter, ...semanticGuard } = expectedGuard;
  void _expectedImportLease;
  void _notAfter;
  const evidence = replay ? [{
    outcome: "success",
    actor_operator_id: operatorId,
    correlation_id: operationId,
    target_type: "control_command",
    target_id: resumeCommandId,
    details: { guardDigest: providerResumeEvidenceDigest(semanticGuard) },
  }] : [];
  const transaction = {
    provider_runtime: { findUniqueOrThrow: async () => runtime },
    provider_runs: {
      findFirst: async () => latest,
      count: async () => input.active ?? 0,
    },
    control_commands: {
      count: async () => input.actionable ?? 0,
      findUnique: async () => ({ ...pause, correlation_id: input.correlationId ?? pause.correlation_id }),
    },
    local_audit_events: { findMany: async () => evidence },
    $queryRaw: async () => [{ now }],
  } as unknown as ProviderTransactionClient;
  return { expectedGuard, replay, transaction };
}

function command(expectedRuntimeGuard: ProviderCatalogOriginResumeGuard | ProviderCatalogQueuedResumeGuard,
  expectedGeneration = 12n) {
  return { commandId: resumeCommandId, commandType: "resume", expectedGeneration,
    requestedByOperatorId: operatorId, correlationId: operationId, requestedAt: now, expectedRuntimeGuard };
}

test("catalog-origin resume admits an explicit null cursor and an exact idempotent replay", async () => {
  for (const replay of [false, true]) {
    const value = fixture({ replay });
    assert.equal(await providerRuntimeResumeGuardMatches(value.transaction,
      command(value.expectedGuard), lease, replay), true);
  }
});

test("catalog-origin resume refuses cursor, configuration, work and pause-operation drift", async () => {
  const changes = [
    { cursor: { unexpected: "checkpoint" }, cursorHash: "a".repeat(64) },
    { configVersionId: "41000000-0000-4000-8000-000000000009" },
    { active: 1 },
    { actionable: 1 },
    { correlationId: "41000000-0000-4000-8000-000000000009" },
  ];
  for (const change of changes) {
    const value = fixture(change);
    assert.equal(await providerRuntimeResumeGuardMatches(value.transaction,
      command(value.expectedGuard), lease, false), false);
  }
  const receipt = fixture();
  const changedReceipt = { ...receipt.expectedGuard, originReceiptDigest: "invalid" };
  assert.equal(await providerRuntimeResumeGuardMatches(receipt.transaction,
    command(changedReceipt), lease, false), false);
});

function queuedFixture(input: Readonly<{
  replay?: boolean;
  active?: number;
  actionable?: number;
  runCommandId?: string;
  originGuardDigest?: string;
  runExpectedGeneration?: bigint;
  runResultGeneration?: string;
  runReason?: string | null;
  runCompletedAt?: Date | null;
  originResultGeneration?: string;
  originReason?: string | null;
  originResultingRunId?: string | null;
  originCompletedAt?: Date | null;
  prequeue?: boolean;
  prequeueResumeResultGeneration?: string;
}> = {}) {
  const queuedRunCommandId = "41000000-0000-4000-8000-000000000009";
  const originResumeCommandId = "41000000-0000-4000-8000-000000000010";
  const queuedGeneration = input.prequeue ? 13n : 11n;
  const safetyPause = { ...pause, id: pauseCommandId,
    idempotency_key: `catalog-bridge/${operationId}/catalog-admission-recovery/${queuedGeneration}/pause`,
    expected_generation: queuedGeneration, correlation_id: operationId,
    reason: `DataForrest collector_crypt catalog bridge queued admission recovery at generation ${queuedGeneration}`,
    result: { outcome: "accepted", code: "RUNTIME_TRANSITION_APPLIED",
      generation: (queuedGeneration + 1n).toString() } };
  const queuedRun = { ...latest, id: runId, state: "queued", reached_source_head: false,
    worker_fence: 0n, control_command_id: input.runCommandId ?? queuedRunCommandId,
    idempotency_key: `catalog-bridge/${operationId}/catalog/run`,
    config_version_id: configId, config_version_number: 4n,
    requested_cursor: null, requested_cursor_hash: null, finished_at: null, final_cursor_hash: null };
  const runCommand = { id: queuedRunCommandId,
    idempotency_key: `catalog-bridge/${operationId}/catalog/run`, command_type: "run",
    state: "accepted", target_run_id: null, target_quarantine_id: null,
    expected_generation: input.runExpectedGeneration ?? queuedGeneration, requested_by_operator_id: operatorId,
    correlation_id: operationId, reason: input.runReason ?? null,
    result: { outcome: "accepted", code: "COMMAND_ACCEPTED",
      generation: input.runResultGeneration ?? queuedGeneration.toString() },
    resulting_run_id: runId, requested_at: now,
    completed_at: input.runCompletedAt ?? null };
  const originResume = { ...runCommand, id: originResumeCommandId,
    idempotency_key: `catalog-bridge/${operationId}/catalog/resume`, command_type: "resume",
    state: "completed", expected_generation: 10n,
    result: { outcome: "accepted", code: "RUNTIME_TRANSITION_APPLIED",
      generation: input.originResultGeneration ?? "11" },
    reason: input.originReason ?? null,
    resulting_run_id: input.originResultingRunId ?? null,
    completed_at: input.originCompletedAt === undefined ? now : input.originCompletedAt };
  const originGuardDigest = input.originGuardDigest ?? "c".repeat(64);
  const prequeuePause = { ...pause,
    id: "41000000-0000-4000-8000-000000000011",
    idempotency_key: `catalog-bridge/${operationId}/catalog-prequeue-recovery/11/pause`,
    expected_generation: 11n, correlation_id: operationId,
    reason: "DataForrest collector_crypt catalog bridge prequeue recovery at generation 11",
    result: { outcome: "accepted", code: "RUNTIME_TRANSITION_APPLIED", generation: "12" } };
  const prequeueResume = { ...runCommand,
    id: "41000000-0000-4000-8000-000000000012",
    idempotency_key: `catalog-bridge/${operationId}/catalog-prequeue-recovery/12/resume`,
    command_type: "resume", state: "completed", expected_generation: 12n,
    reason: "DataForrest collector_crypt catalog bridge catalog-prequeue recovery at generation 12",
    result: { outcome: "accepted", code: "RUNTIME_TRANSITION_APPLIED",
      generation: input.prequeueResumeResultGeneration ?? "13" },
    resulting_run_id: null, completed_at: now };
  const prequeueGuardDigest = "d".repeat(64);
  const prequeueRecoveryChain = input.prequeue ? [{
    pauseCommandId: prequeuePause.id, pauseCommandDigest: pauseDigest(prequeuePause),
    resumeCommandId: prequeueResume.id,
    resumeCommandDigest: providerResumeEvidenceDigest(prequeueResume),
    resumeGuardDigest: prequeueGuardDigest,
  }] : [];
  const expectedGuard: ProviderCatalogQueuedResumeGuard = {
    entry: "paused_catalog_queued", providerId, configVersionId: configId,
    configVersionNumber: 4n, runtimeRowVersion: input.prequeue ? 26n : 24n,
    checkpointHash: null, checkpoint: null,
    latestRunId: runId, latestRunDigest: providerResumeEvidenceDigest(queuedRun),
    pauseCommandId, pauseCommandDigest: providerResumeEvidenceDigest(safetyPause),
    runCommandId: queuedRunCommandId,
    runCommandIdempotencyKey: runCommand.idempotency_key,
    originResumeCommandId, originResumeIdempotencyKey: originResume.idempotency_key,
    originResumeGuardDigest: originGuardDigest,
    prequeueRecoveryChain,
    expectedImportLease: { owner: lease.lease_owner, fence: lease.lease_fence },
    notAfter: new Date(now.getTime() + 60_000),
  };
  const replay = input.replay ?? false;
  const runtime = { central_provider_id: providerId, operating_state: replay ? "idle" : "paused",
    state_generation: replay ? queuedGeneration + 2n : queuedGeneration + 1n,
    row_version: replay ? (input.prequeue ? 27n : 25n) : (input.prequeue ? 26n : 24n),
    cached_config_version_id: configId, cached_config_version_number: 4n,
    config_expires_at: null, source_cursor: null, source_cursor_hash: null };
  const { expectedImportLease: _lease, notAfter: _deadline, ...semantic } = expectedGuard;
  void _lease; void _deadline;
  const recoveryEvidence = replay ? [{ outcome: "success", actor_operator_id: operatorId,
    correlation_id: operationId, target_type: "control_command", target_id: resumeCommandId,
    details: { guardDigest: providerResumeEvidenceDigest(semantic) } }] : [];
  const originEvidence = { outcome: "success", actor_operator_id: operatorId,
    correlation_id: operationId, target_type: "control_command", target_id: originResumeCommandId,
    details: { guardDigest: originGuardDigest } };
  const transaction = {
    provider_runtime: { findUniqueOrThrow: async () => runtime },
    provider_runs: { findFirst: async () => queuedRun, count: async () => input.active ?? 1 },
    control_commands: { count: async () => input.actionable ?? 1,
      findUnique: async ({ where: { id } }: { where: { id: string } }) =>
        id === pauseCommandId ? safetyPause : id === queuedRunCommandId ? runCommand :
          id === originResumeCommandId ? originResume : id === prequeuePause.id ? prequeuePause :
            id === prequeueResume.id ? prequeueResume : null },
    local_audit_events: { findMany: async () => recoveryEvidence,
      findFirst: async ({ where: { command_id: commandId } }: {
        where: { command_id: string };
      }) => commandId === prequeueResume.id ? { ...originEvidence, target_id: prequeueResume.id,
        details: { guardDigest: prequeueGuardDigest } } : originEvidence },
    $queryRaw: async () => [{ now }],
  } as unknown as ProviderTransactionClient;
  return { expectedGuard, replay, transaction };
}

test("catalog queued recovery resumes only the exact guarded null-origin admission", async () => {
  for (const replay of [false, true]) {
    const value = queuedFixture({ replay });
    assert.equal(await providerRuntimeResumeGuardMatches(value.transaction,
      command(value.expectedGuard), lease, replay), true);
  }
  for (const changed of [
    { active: 0 }, { actionable: 0 },
    { runCommandId: "41000000-0000-4000-8000-000000000011" },
    { originGuardDigest: "invalid" },
    { runExpectedGeneration: 12n }, { runResultGeneration: "12" },
    { runReason: "foreign" }, { runCompletedAt: now },
    { originResultGeneration: "12" }, { originReason: "foreign" },
    { originResultingRunId: runId }, { originCompletedAt: null },
  ]) {
    const value = queuedFixture(changed);
    assert.equal(await providerRuntimeResumeGuardMatches(value.transaction,
      command(value.expectedGuard), lease, false), false);
  }
});

test("catalog queued recovery binds every exact prequeue pause and resume cycle", async () => {
  for (const replay of [false, true]) {
    const value = queuedFixture({ prequeue: true, replay });
    assert.equal(await providerRuntimeResumeGuardMatches(value.transaction,
      command(value.expectedGuard, 14n), lease, replay), true);
  }
  const changed = queuedFixture({ prequeue: true });
  const [entry] = changed.expectedGuard.prequeueRecoveryChain;
  assert.ok(entry);
  const guard = { ...changed.expectedGuard,
    prequeueRecoveryChain: [{ ...entry, resumeGuardDigest: "e".repeat(64) }] };
  assert.equal(await providerRuntimeResumeGuardMatches(changed.transaction,
    command(guard, 14n), lease, false), false);

  const changedGeneration = queuedFixture({ prequeue: true,
    prequeueResumeResultGeneration: "14" });
  assert.equal(await providerRuntimeResumeGuardMatches(changedGeneration.transaction,
    command(changedGeneration.expectedGuard, 14n), lease, false), false);

  const changedId = queuedFixture({ prequeue: true });
  const [idEntry] = changedId.expectedGuard.prequeueRecoveryChain;
  assert.ok(idEntry);
  const idGuard = { ...changedId.expectedGuard, prequeueRecoveryChain: [{ ...idEntry,
    resumeCommandId: "41000000-0000-4000-8000-000000000013" }] };
  assert.equal(await providerRuntimeResumeGuardMatches(changedId.transaction,
    command(idGuard, 14n), lease, false), false);
});
