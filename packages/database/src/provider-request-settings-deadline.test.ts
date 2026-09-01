import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { ProviderPrismaClient } from "./provider-database.ts";
import { PrismaProviderRequestSettingsRepository } from "./provider-request-settings-repository.ts";

test("settings deadline expiry after staged writes rolls back instead of reporting an early failure while writing", async () => {
  const now = new Date(); const deadline = new Date(now.getTime() + 60_000);
  const providerId = randomUUID(); const configId = randomUUID(); const revisionId = randomUUID();
  const original = { id: revisionId, revision_number: 1n, records_per_request: 100, origin: "operator",
    config_version_id: configId, config_version_number: 1n, adapter_key: "test-adapter",
    created_by_operator_id: randomUUID(), created_at: now };
  let attemptedWrites = 0; let committedWrites = 0; let clocks = 0;
  const transaction = {
    $queryRaw: async (sql: { strings: readonly string[] }) => {
      if (sql.strings.join(" ").includes("from provider_runtime")) return [{ provider_id: providerId,
        central_provider_id: providerId, cached_config_version_id: configId, cached_config_version_number: 1n,
        adapter_key: "test-adapter", config_expires_at: null, database_now: now }];
      clocks++; return [{ now: clocks >= 4 ? deadline : now }];
    },
    provider_request_settings: { findUnique: async () => ({ active_revision: original }), update: async () => { attemptedWrites++; } },
    provider_request_settings_revisions: { create: async ({ data }: { data: object }) => { attemptedWrites++; return { ...original, ...data }; } },
    local_audit_events: { create: async () => { attemptedWrites++; } },
  };
  const database = { $transaction: async (callback: (tx: typeof transaction) => Promise<unknown>) => {
    const result = await callback(transaction); committedWrites = attemptedWrites; return result;
  } } as unknown as ProviderPrismaClient;
  const repository = new PrismaProviderRequestSettingsRepository(database);
  const input = { providerId, expectedRevisionId: revisionId, recordsPerRequest: 1000,
    actorOperatorId: original.created_by_operator_id, correlationId: randomUUID(), expectedConfigVersionId: configId,
    expectedConfigVersionNumber: 1n, adapterKey: "test-adapter", writeDeadline: deadline };
  assert.equal((await repository.revise(input)).kind, "write_deadline_expired");
  assert.equal(attemptedWrites, 3); assert.equal(committedWrites, 0);
  attemptedWrites = 0;
  assert.equal((await repository.revise({ ...input, writeDeadline: new Date(0) })).kind, "write_deadline_expired");
  assert.equal(attemptedWrites, 0);
  await assert.rejects(repository.revise({ ...input, writeDeadline: new Date(Number.NaN) }));
});
