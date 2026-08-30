import assert from "node:assert/strict";
import { test } from "node:test";
import type { ProviderPrismaClient, ProviderTransactionClient } from "./provider-database.ts";
import { PrismaProviderSourceRequestAuditRepository } from "./provider-source-request-audit-repository.ts";

const fixture = {
  runId: "11111111-1111-4111-8111-111111111111", workerId: "fixture:worker", workerFence: 1n,
  requestAttemptId: "22222222-2222-4222-8222-222222222222",
  requestLeaseId: "33333333-3333-4333-8333-333333333333", pageNumber: 1,
  outcome: "failure" as const, resultCode: "SOURCE_REQUEST_RESPONSE_TOO_LARGE",
  durationMilliseconds: 902, responseBytes: 0,
};

test("request audit retains only validated oversize metadata under the existing live lease and run guards", async () => {
  let transactions = 0; let query = 0;
  const writes: unknown[] = [];
  const now = new Date("2026-08-30T00:00:00Z");
  const tx = { async $queryRaw() {
    query += 1;
    if (query % 3 === 1) return [{ lease_owner: fixture.workerId, lease_fence: 1n,
      lease_expires_at: new Date(now.getTime() + 60_000), database_now: now }];
    if (query % 3 === 2) return [];
    return [{ id: fixture.runId, state: "running", worker_fence: 1n }];
  }, local_audit_events: { async create(input: unknown) { writes.push(input); } } } as unknown as ProviderTransactionClient;
  const database = { async $transaction<T>(callback: (client: ProviderTransactionClient) => Promise<T>) {
    transactions += 1; return callback(tx);
  } } as unknown as ProviderPrismaClient;
  const repository = new PrismaProviderSourceRequestAuditRepository(database);
  const responseLimitDiagnostic = { trigger: "streamed_body" as const, maximumResponseBytes: 4, reportedResponseBytes: 6 };
  const result = await repository.record({ ...fixture, responseLimitDiagnostic });
  assert.equal(result.kind, "recorded");
  assert.deepEqual((writes[0] as { data: { details: unknown } }).data.details, {
    durationMilliseconds: 902, leaseFence: "1", pageNumber: 1, requestLeaseId: fixture.requestLeaseId,
    responseBytes: 0, resultCode: fixture.resultCode, runId: fixture.runId,
    responseLimitTrigger: "streamed_body", maximumResponseBytes: 4, reportedResponseBytes: 6,
  });
  for (const invalid of [
    { ...responseLimitDiagnostic, reportedResponseBytes: Number.MAX_SAFE_INTEGER + 1 },
    { ...responseLimitDiagnostic, reportedResponseBytes: Infinity },
    { ...responseLimitDiagnostic, reportedResponseBytes: -1 },
    { ...responseLimitDiagnostic, maximumResponseBytes: 1.5 },
    { ...responseLimitDiagnostic, reportedResponseBytes: 4 },
    { ...responseLimitDiagnostic, trigger: "raw-secret-marker" },
    { ...responseLimitDiagnostic, unexpected: "raw-secret-marker" },
  ]) {
    await assert.rejects(repository.record({ ...fixture,
      responseLimitDiagnostic: invalid as typeof responseLimitDiagnostic,
    }), /diagnostic is invalid/);
  }
  await assert.rejects(repository.record({ ...fixture, outcome: "success", responseLimitDiagnostic }), /diagnostic is invalid/);
  await assert.rejects(repository.record({ ...fixture, resultCode: "SOURCE_REQUEST_REQUEST_TIMEOUT", responseLimitDiagnostic }), /diagnostic is invalid/);
  assert.equal(transactions, 1);
  assert.equal(JSON.stringify(writes).includes("raw-secret-marker"), false);
});
