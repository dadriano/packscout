import assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaAdminProviderRuntimeRepository } from "./admin-provider-runtime-repository.ts";
import type { ProviderPrismaClient } from "./provider-database.ts";
import { providerMixedCursorFingerprint } from "./provider-mixed-page-contract.ts";

const now = new Date("2026-08-30T00:00:00Z");
const cursor = { opaque: "test-checkpoint" };
const fingerprint = providerMixedCursorFingerprint(cursor);
const request = {
  providerId: "cc9b75a1-91dd-4a5b-9ee6-70b501cfe901",
  operatorId: "cc9b75a1-91dd-4a5b-9ee6-70b501cfe902",
  expectedConfigVersionId: "cc9b75a1-91dd-4a5b-9ee6-70b501cfe903",
  expectedConfigVersionNumber: 4n, expectedGeneration: 3n,
  idempotencyKey: "recovery/test", commandId: "cc9b75a1-91dd-4a5b-9ee6-70b501cfe904",
  runId: "cc9b75a1-91dd-4a5b-9ee6-70b501cfe905",
  correlationId: "cc9b75a1-91dd-4a5b-9ee6-70b501cfe906",
};

function fixture() {
  const runtime = { central_provider_id: request.providerId, operating_state: "idle",
    state_generation: 3n, cached_config_version_id: request.expectedConfigVersionId,
    cached_config_version_number: 4n, config_expires_at: null,
    source_cursor: cursor as { opaque: string } | null, source_cursor_hash: fingerprint };
  const run = { id: request.runId, trigger: "manual", state: "queued",
    requested_by_operator_id: request.operatorId, config_version_id: request.expectedConfigVersionId,
    records_per_request: 100, request_settings_revision_id: request.correlationId, request_settings_parent_run_id: null,
    config_version_number: 4n, worker_fence: 0n, attempt_number: 1, recovery_of_run_id: null,
    requested_cursor_hash: fingerprint, final_cursor_hash: null, reached_source_head: false,
    page_count: 0, catalog_record_count: 0, pull_record_count: 0, market_event_record_count: 0,
    accepted_count: 0, duplicate_count: 0, quarantined_count: 0, material_change_count: 0,
    failure_code: null, failure_class: null, requested_at: now, started_at: null,
    last_progress_at: null, heartbeat_at: null, finished_at: null };
  let command: Record<string, unknown> | null = null;
  let active = false;
  const writes: string[] = [];
  const transaction = {
    $queryRaw: async (sql: { strings?: readonly string[] } | readonly string[]) => {
      const text = (Array.isArray(sql) ? sql : (sql as { strings: readonly string[] }).strings).join(" ");
      if (text.includes("from provider_runtime")) return [runtime];
      if (text.includes("from provider_runs")) return active ? [{ id: run.id }] : [];
      if (text.includes("clock_timestamp")) return [{ now }];
      throw new Error("Unexpected query in recovery guard test.");
    },
    control_commands: {
      findUnique: async () => command,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        writes.push("command"); command = { ...data, reason: null }; return command;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(command!, data); return command; },
    },
    provider_runs: {
      findUnique: async () => run, findUniqueOrThrow: async () => run,
      create: async () => { writes.push("run"); return run; },
    },
    provider_request_settings: { findUnique: async () => ({ active_revision: {
      id: request.correlationId, revision_number: 1n, records_per_request: 100, origin: "operator",
      config_version_id: request.expectedConfigVersionId, config_version_number: 4n,
      adapter_key: "test-adapter", created_by_operator_id: request.operatorId, created_at: now,
    } }) },
    local_audit_events: { create: async () => { writes.push("audit"); } },
    provider_activity_outbox: { create: async () => { writes.push("activity"); } },
  };
  const database = { $transaction: async (fn: (tx: typeof transaction) => unknown) => fn(transaction) };
  return { runtime, run, writes, repository: new PrismaAdminProviderRuntimeRepository(database as unknown as ProviderPrismaClient),
    setActive() { active = true; },
    setReplay() { command = { id: request.commandId, command_type: "run", expected_generation: 3n,
      requested_by_operator_id: request.operatorId, reason: null, resulting_run_id: run.id,
      correlation_id: request.correlationId }; },
  };
}

test("recovery queue pins both the stored cursor hash and actual cursor before any write", async () => {
  for (const mutation of ["hash", "value"] as const) {
    const f = fixture();
    if (mutation === "hash") f.runtime.source_cursor_hash = "f".repeat(64);
    else f.runtime.source_cursor = { opaque: "changed-checkpoint" };
    assert.equal((await f.repository.requestRunNow({ ...request,
      expectedCursorFingerprint: fingerprint, requireNoActiveRun: true })).kind, "cursor_conflict");
    assert.deepEqual(f.writes, []);
  }
});

test("recovery refuses unrelated active work atomically while ordinary UI coalescing is unchanged", async () => {
  const recovery = fixture(); recovery.setActive();
  assert.equal((await recovery.repository.requestRunNow({ ...request,
    expectedCursorFingerprint: fingerprint, requireNoActiveRun: true })).kind, "active_run_conflict");
  assert.deepEqual(recovery.writes, []);
  const ui = fixture(); ui.setActive();
  assert.equal((await ui.repository.requestRunNow(request)).kind, "deduplicated");
  assert.equal(ui.writes.includes("run"), false);
});

test("same pinned retry creates once and idempotently recognizes its run after progress", async () => {
  const f = fixture();
  const pinned = { ...request, expectedCursorFingerprint: fingerprint, requireNoActiveRun: true };
  assert.equal((await f.repository.requestRunNow(pinned)).kind, "created");
  f.setActive(); f.runtime.source_cursor = { opaque: "later-checkpoint" };
  f.runtime.source_cursor_hash = providerMixedCursorFingerprint(f.runtime.source_cursor);
  f.runtime.state_generation = 4n; f.run.state = "running";
  assert.equal((await f.repository.requestRunNow(pinned)).kind, "deduplicated");
  assert.equal(f.writes.filter((item) => item === "run").length, 1);
  assert.equal((await f.repository.requestRunNow({ ...pinned,
    expectedCursorFingerprint: "a".repeat(64) })).kind, "cursor_conflict");
});

test("null origin is explicit and generation/config guards still fail without mutation", async () => {
  const f = fixture();
  assert.equal((await f.repository.requestRunNow({ ...request, expectedCursorFingerprint: null })).kind, "cursor_conflict");
  assert.equal((await f.repository.requestRunNow({ ...request, expectedGeneration: 99n })).kind, "generation_conflict");
  assert.equal((await f.repository.requestRunNow({ ...request, expectedConfigVersionNumber: 99n })).kind, "configuration_conflict");
  assert.deepEqual(f.writes, []);
});
