import assert from "node:assert/strict";
import { test } from "node:test";
import type { PackscoutPrismaClient } from "./database.ts";
import { ProviderSourceDiagnosticRepository } from "./provider-source-diagnostic-repository.ts";
import type { DiagnosticEventInput } from "./provider-source-persistence-types.ts";

const baseLifecycleDiagnostic = {
  organizationId: "organization-1",
  scope: "source",
  correlationKind: "lifecycle",
  eventKind: "source_lifecycle",
  severity: "critical",
  phase: "lifecycle",
  safeCode: "SOURCE_FENCED",
  occurredAt: new Date("2026-08-20T12:00:00.000Z"),
  sourceTypeKey: "dataforrest-events-v1",
  sourceAdapterVersion: "dataforrest-events-v1",
  normalizedContractVersion: "packscout-provider-observation-v1",
  providerId: "provider-1",
  sourceInstanceId: "source-1",
  sourceRevisionId: "source-revision-1",
  connectionProfileId: "profile-1",
  connectionRevisionId: "connection-revision-1",
  auditEventId: "audit-event-1",
} as const satisfies DiagnosticEventInput;

function repositoryFixture(): Readonly<{
  repository: ProviderSourceDiagnosticRepository;
  writes: Array<Record<string, unknown>>;
}> {
  const writes: Array<Record<string, unknown>> = [];
  let stored: Record<string, unknown> | null = null;
  const database = {
    source_connection_health_episodes: {
      findFirst: async () => null,
    },
    source_processor_diagnostic_events: {
      findUnique: async () => stored,
      create: async (input: Readonly<{ data: Record<string, unknown> }>) => {
        const normalized = { ...input.data };
        for (const key of [
          "normalized_contract_version",
          "provider_id",
          "source_instance_id",
          "source_revision_id",
          "blocking_episode_id",
          "connection_test_job_id",
          "source_test_job_id",
          "run_id",
          "page_id",
          "request_attempt_id",
          "run_trigger",
          "command_correlation_key",
          "audit_event_id",
          "continuation_kind",
          "minimum_delay_seconds",
          "retry_delay_ms",
          "duration_ms",
          "response_bytes",
          "checkpoint_fingerprint",
        ]) {
          if (normalized[key] === undefined) normalized[key] = null;
        }
        stored = { ...normalized, id: input.data.id ?? "diagnostic-1" };
        writes.push(normalized);
        return { id: String(stored.id) };
      },
    },
  } as unknown as PackscoutPrismaClient;
  return {
    repository: new ProviderSourceDiagnosticRepository(database),
    writes,
  };
}

function unsafeDiagnosticInput(value: unknown): DiagnosticEventInput {
  return value as DiagnosticEventInput;
}

test("diagnostic append retains contract severity, category, and safe digest", async () => {
  const { repository, writes } = repositoryFixture();
  const id = await repository.append({
    ...baseLifecycleDiagnostic,
    checkpointFingerprint: "a".repeat(64),
  });
  await repository.append({
    ...baseLifecycleDiagnostic,
    auditEventId: null,
    commandCorrelationKey: "command:01j5yr0m2v8q7y3k9h6w4n1c0b",
  });

  assert.equal(id, "diagnostic-1");
  assert.equal(writes.length, 2);
  assert.equal(writes[0]?.severity, "critical");
  assert.equal(writes[0]?.correlation_kind, "lifecycle");
  assert.equal(writes[0]?.event_kind, "source_lifecycle");
  assert.equal(writes[0]?.checkpoint_fingerprint, "a".repeat(64));
  assert.equal(
    writes[1]?.command_correlation_key,
    "command:01j5yr0m2v8q7y3k9h6w4n1c0b",
  );
});

test("diagnostic append rejects reusable checkpoint values and unsafe command keys", async () => {
  const { repository, writes } = repositoryFixture();

  for (const checkpointFingerprint of [
    "provider-cursor-value",
    "a".repeat(63),
    "A".repeat(64),
  ]) {
    await assert.rejects(
      repository.append({
        ...baseLifecycleDiagnostic,
        checkpointFingerprint,
      }),
      /lowercase 64-character keyed digest/u,
    );
  }

  for (const commandCorrelationKey of [
    "Bearer reusable-secret",
    "UPPERCASE-COMMAND",
    `command:${"a".repeat(121)}`,
  ]) {
    await assert.rejects(
      repository.append({
        ...baseLifecycleDiagnostic,
        auditEventId: null,
        commandCorrelationKey,
      }),
      /command correlation key/u,
    );
  }
  assert.equal(writes.length, 0);
});

test("diagnostic category and event kind cannot borrow another correlation shape", async () => {
  const { repository, writes } = repositoryFixture();

  await assert.rejects(
    repository.append(unsafeDiagnosticInput({
      ...baseLifecycleDiagnostic,
      correlationKind: "page",
    })),
    /event kind does not match/u,
  );
  await assert.rejects(
    repository.append(unsafeDiagnosticInput({
      ...baseLifecycleDiagnostic,
      correlationKind: "page",
      eventKind: "source_page",
    })),
    /correlation does not match its category/u,
  );
  await assert.rejects(
    repository.append(unsafeDiagnosticInput({
      ...baseLifecycleDiagnostic,
      scope: "connection",
      correlationKind: "connection_episode",
      eventKind: "connection_episode",
      blockingEpisodeId: "episode-1",
      auditEventId: null,
    })),
    /Connection diagnostic correlation/u,
  );
  assert.equal(writes.length, 0);
});

test("diagnostic numeric measurements stay within PostgreSQL integer bounds", async () => {
  const { repository, writes } = repositoryFixture();

  for (const [field, value] of [
    ["durationMs", -1],
    ["responseBytes", 2_147_483_648],
    ["retryDelayMs", 1.5],
  ] as const) {
    await assert.rejects(
      repository.append(unsafeDiagnosticInput({
        ...baseLifecycleDiagnostic,
        [field]: value,
      })),
      /nonnegative 32-bit integer/u,
    );
  }

  assert.equal(writes.length, 0);
});

test("diagnostic replay compares every bounded metric and evidence field", async () => {
  const { repository, writes } = repositoryFixture();
  const input = {
    ...baseLifecycleDiagnostic,
    id: "diagnostic-idempotency-key",
    durationMs: 12,
    responseBytes: 34,
    counters: { records: 2 },
    evidence: { lifecycle_state: "active" },
  } as const satisfies DiagnosticEventInput;

  assert.equal(await repository.append(input), "diagnostic-idempotency-key");
  assert.equal(await repository.append({
    ...input,
    occurredAt: new Date("2026-08-20T12:00:01.000Z"),
  }), "diagnostic-idempotency-key");
  assert.equal(writes.length, 1);
  for (const conflicting of [
    { ...input, durationMs: 13 },
    { ...input, responseBytes: 35 },
    { ...input, counters: { records: 3 } },
    { ...input, evidence: { lifecycle_state: "paused" } },
  ]) {
    await assert.rejects(
      repository.append(conflicting),
      /different immutable content/u,
    );
  }
});
