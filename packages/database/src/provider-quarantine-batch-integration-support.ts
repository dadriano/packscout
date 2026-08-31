import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { ProviderPrismaClient } from "./provider-database.ts";
import { PrismaProviderRuntimeRepository } from "./provider-runtime-repository.ts";
import { PrismaProviderWorkerLeaseRepository } from "./provider-worker-lease-repository.ts";
import { PrismaProviderRunRepository } from "./provider-run-repository.ts";
import { PROVIDER_MIXED_PAGE_CONTRACT_VERSION, providerMixedCursorFingerprint,
  providerMixedPageDigest, type ProviderMixedPageRecord } from "./provider-mixed-page-contract.ts";

export const batchWorker = "integration:quarantine-batch";
type RecordInput = Omit<ProviderMixedPageRecord, "providerId" | "position">;

export function sourceRejection(key: string): RecordInput {
  return { kind: "pull", disposition: "quarantine", candidate: {},
    sourceRecordKey: `source:${createHash("sha256").update(key).digest("hex")}`,
    reasonCode: "NORMALIZED_CANDIDATE_INVALID", fieldPath: null, sanitizedSummary: "Synthetic mapping failure." };
}

export function batchRecords(): RecordInput[] {
  return [sourceRejection("prior"), sourceRejection("new-0"), sourceRejection("new-0"),
    { kind: "catalog", entityType: "category", operation: "upsert", candidate: {
      categoryKey: "after-savepoint", parentCategoryKey: "missing-parent", displayName: "Synthetic category" } },
    { kind: "catalog", entityType: "category", operation: "upsert", candidate: {
      categoryKey: "after-savepoint", parentCategoryKey: null, displayName: "Synthetic category" } },
    ...Array.from({ length: 101 }, (_, index) => sourceRejection(`new-${index + 1}`))];
}

export async function prepareBatchFixture(client: ProviderPrismaClient, providerKey: string, leaseMilliseconds = 300_000) {
  const { provider_id: providerId } = await client.database_identity.findUniqueOrThrow({ where: { singleton_key: true } });
  assert.ok(providerId);
  const configId = randomUUID(), runId = randomUUID();
  await new PrismaProviderRuntimeRepository(client).synchronizeConfiguration({ centralProviderId: providerId,
    providerKey, configVersionId: configId, configVersionNumber: 1n, configuration: { adapterKey: "synthetic" },
    expiresAt: null, scheduleSeconds: 300, nextDueAt: null, synchronizedAt: new Date() });
  const claim = await new PrismaProviderWorkerLeaseRepository(client).acquire({ role: "import", owner: batchWorker,
    leaseMilliseconds });
  assert.notEqual(claim.kind, "held"); if (claim.kind === "held") throw new Error("Synthetic lease unavailable.");
  const started = await new PrismaProviderRunRepository(client).start({ runId, idempotencyKey: "quarantine-batch",
    trigger: "manual", requestedByOperatorId: null, configVersionId: configId, configVersionNumber: 1n,
    workerId: batchWorker, workerFence: claim.lease.fence, correlationId: randomUUID(), requestedAt: new Date() });
  assert.equal(started.kind, "started");
  return { runId, providerId, page(records: readonly RecordInput[], pageNumber = 1) {
    const inputCursor = pageNumber === 1 ? null : { page: pageNumber - 1 }, nextCursor = { page: pageNumber };
    const body = { contractVersion: PROVIDER_MIXED_PAGE_CONTRACT_VERSION, providerId, runId,
      configVersionId: configId, configVersionNumber: "1", leaseFence: claim.lease.fence.toString(),
      pageId: randomUUID(), pageNumber, inputCursor, inputCursorFingerprint: providerMixedCursorFingerprint(inputCursor),
      nextCursor, nextCursorFingerprint: providerMixedCursorFingerprint(nextCursor), continuation: "more",
      records: records.map((record, position) => ({ ...record, providerId, position })) };
    return { ...body, responseDigest: providerMixedPageDigest(body) };
  } };
}

export async function batchState(client: ProviderPrismaClient, runId: string) {
  return {
    runtime: await client.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
    run: await client.provider_runs.findUniqueOrThrow({ where: { id: runId } }),
    pages: await client.provider_run_pages.findMany({ orderBy: { page_number: "asc" } }),
    quarantines: await client.quarantine_records.findMany({ orderBy: { id: "asc" } }),
    outbox: await client.provider_activity_outbox.findMany({ orderBy: { id: "asc" } }),
    categories: await client.categories.findMany({ orderBy: { id: "asc" } }),
    promotions: await client.promotion_changes.findMany({ orderBy: { sequence: "asc" } }),
    ledger: await client.promotion_ledger.findUniqueOrThrow({ where: { singleton_key: true } }),
  };
}

export function recordBatchOperations(client: ProviderPrismaClient) {
  const operations: string[] = [];
  const database = client.$extends({ query: { $allModels: { $allOperations({ model, operation, args, query }) {
    if (model === "quarantine_records" || model === "provider_activity_outbox") operations.push(`${model}.${operation}`);
    return query(args);
  } } } });
  return { database: database as unknown as ProviderPrismaClient, operations };
}
