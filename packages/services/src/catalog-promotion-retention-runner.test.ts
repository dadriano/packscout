import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CATALOG_RETENTION_SCHEMA_VERSION,
  canonicalJson,
  catalogRetentionManifestRequestSchema,
  catalogRetentionPostgresProofSnapshotDigest,
  catalogRetentionPublicationRequestDigest,
  type CatalogRetentionPostgresProofSnapshot,
} from "@packscout/contracts";
import { CatalogRetentionPublicationClientError } from
  "./convex-catalog-retention-client.ts";
import {
  CatalogPromotionRetentionRunner,
  type CatalogPromotionRetentionBarrier,
  type CatalogPromotionRetentionOperation,
  type CatalogPromotionRetentionRepositoryPort,
  type CatalogPromotionRetentionTransportPort,
} from "./catalog-promotion-retention-runner.ts";

const now = new Date("2026-08-16T12:00:00.000Z");
const hash = "a".repeat(64);

async function proof(): Promise<CatalogRetentionPostgresProofSnapshot> {
  const body: Omit<CatalogRetentionPostgresProofSnapshot, "snapshotDigest"> = {
    snapshotId: "retention:snapshot:runner:1",
    snapshotSequence: "1",
    evaluatedAt: now.toISOString(),
    activeState: {
      state: {
        generation: 0,
        activeManifest: null,
        previousManifest: null,
        observation: null,
        terminalReceiptSha256: null,
      },
      terminalOperationId: null,
    },
    completedHeads: [{
      platformKey: "alpha",
      completedHead: {
        platformKey: "alpha",
        publicProviderReleaseId: null,
        sharedConfigurationEpoch: null,
        providerCheckpoint: { settledSequence: "0", settledAt: null },
        observation: null,
        terminalReceiptSha256: null,
      },
      terminalOperationId: null,
    }],
    manifestProtections: [],
    providerProtectionsByPlatform: [],
  };
  return { ...body, snapshotDigest: await catalogRetentionPostgresProofSnapshotDigest(body) };
}

async function manifestOperation(
  state: CatalogPromotionRetentionOperation["state"],
): Promise<CatalogPromotionRetentionOperation> {
  const request = catalogRetentionManifestRequestSchema.parse({
    schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
    operationId: "retention:1:0",
    idempotencyKey: "retention:1:0",
    expectedRetentionGeneration: 0,
    maximumDocuments: 90,
    phase: "manifests",
    postgresProof: await proof(),
  });
  return {
    operationIndex: 0,
    operationId: request.operationId,
    operationKind: "retainManifests",
    phase: "manifests",
    platformKey: null,
    expectedRetentionGeneration: 0,
    canonicalRequestBody: canonicalJson(request),
    requestSha256: await catalogRetentionPublicationRequestDigest(request),
    state,
    sendCount: state === "pending" ? 0 : 1,
    lastSentAt: state === "pending" ? null : now,
    acknowledgedAt: state === "acknowledged" ? now : null,
    canonicalReceiptBody: state === "acknowledged" ? "{}" : null,
    receiptSha256: state === "acknowledged" ? hash : null,
    exactResponseBody: state === "acknowledged" ? "{}" : null,
    responseSha256: state === "acknowledged" ? hash : null,
    postgresCleanupComplete: state === "acknowledged",
  };
}

async function barrier(resumed = true): Promise<CatalogPromotionRetentionBarrier> {
  const postgresProof = await proof();
  return {
    barrierGeneration: 1n,
    barrierToken: "54000000-0000-4000-8000-000000000001",
    retentionGeneration: 0,
    postgresProof,
    canonicalPostgresProofBody: canonicalJson(postgresProof),
    resumed,
  };
}

function runner(
  repository: CatalogPromotionRetentionRepositoryPort,
  transport: CatalogPromotionRetentionTransportPort,
  maximumStepsPerCycle = 10,
) {
  return new CatalogPromotionRetentionRunner({
    repository,
    transport,
    maximumDocuments: 90,
    maximumPostgresRowsPerStep: 100,
    maximumStepsPerCycle,
    clock: { now: () => now },
  });
}

test("sent recovery checks signed status before the only permitted resend", async () => {
  let pending: CatalogPromotionRetentionOperation | null =
    await manifestOperation("sent");
  const calls: string[] = [];
  const repository = {
    async acquireBarrier() { return await barrier(); },
    async loadPendingOperation() { return pending; },
    async loadOperationRequiringCleanup() { return null; },
    async prepareOperation() { return null; },
    async markOperationSent() { calls.push("mark-sent"); return true; },
    async acknowledgeOperation() {
      calls.push("acknowledge");
      pending = null;
      return { receipt: {} as never, receiptSha256: hash, postgresCleanupPending: false };
    },
    async deleteProviderArtifactChunk() { return { deletedRowCount: 0, complete: true }; },
    async releaseBarrier() { calls.push("release"); return true; },
  } satisfies CatalogPromotionRetentionRepositoryPort;
  const transport = {
    async status(request: { target: unknown }) {
      calls.push("status");
      return {
        receipt: {
          schemaVersion: CATALOG_RETENTION_SCHEMA_VERSION,
          target: request.target,
          terminalState: "not_found",
          result: "not_found",
          serverTime: now.toISOString(),
          requestDigest: pending!.requestSha256,
          details: {},
          receiptDigest: null,
        },
        canonicalReceiptBody: "{}",
        receiptSha256: hash,
        exactResponseBody: "{}",
        exactResponseSha256: hash,
      };
    },
    async sendExact() {
      calls.push("send-exact");
      return {
        receipt: {}, canonicalReceiptBody: "{}", receiptSha256: hash,
        exactResponseBody: "{\"signed\":true}", exactResponseSha256: hash,
      };
    },
  } as unknown as CatalogPromotionRetentionTransportPort;

  const result = await runner(repository, transport).runCycle();

  assert.equal(result.outcome, "released");
  assert.deepEqual(calls, ["status", "mark-sent", "send-exact", "acknowledge", "release"]);
  assert.equal(result.networkRequests, 2);
});

test("ambiguous send leaves durable sent state for a later status cycle", async () => {
  const operation = await manifestOperation("pending");
  let marked = false;
  const repository = {
    async acquireBarrier() { return await barrier(false); },
    async loadPendingOperation() { return operation; },
    async loadOperationRequiringCleanup() { return null; },
    async prepareOperation() { return null; },
    async markOperationSent() { marked = true; return true; },
    async acknowledgeOperation() { throw new Error("must not acknowledge"); },
    async deleteProviderArtifactChunk() { return { deletedRowCount: 0, complete: true }; },
    async releaseBarrier() { throw new Error("must not release"); },
  } satisfies CatalogPromotionRetentionRepositoryPort;
  const transport = {
    async sendExact() {
      throw new CatalogRetentionPublicationClientError(
        "PUBLICATION_NETWORK_ERROR", "retryable", true,
      );
    },
    async status() { throw new Error("must not status an unsent operation"); },
  } as unknown as CatalogPromotionRetentionTransportPort;

  const result = await runner(repository, transport).runCycle();

  assert.equal(marked, true);
  assert.equal(result.outcome, "retry_required");
  assert.equal(result.operationsAcknowledged, 0);
  assert.equal(result.networkRequests, 1);
});

test("acknowledged provider cleanup resumes in bounded PostgreSQL chunks", async () => {
  let cleanup = { ...(await manifestOperation("acknowledged")),
    operationKind: "retainProviderReleases" as const,
    phase: "provider_releases" as const,
    platformKey: "alpha",
    postgresCleanupComplete: false,
  };
  const chunkSizes: number[] = [];
  const repository = {
    async acquireBarrier() { return await barrier(); },
    async loadPendingOperation() { return null; },
    async loadOperationRequiringCleanup() {
      return cleanup.postgresCleanupComplete ? null : cleanup;
    },
    async prepareOperation() { return null; },
    async markOperationSent() { throw new Error("must not send"); },
    async acknowledgeOperation() { throw new Error("must not acknowledge"); },
    async deleteProviderArtifactChunk(input: { maximumRows: number }) {
      chunkSizes.push(input.maximumRows);
      if (chunkSizes.length === 2) cleanup = { ...cleanup, postgresCleanupComplete: true };
      return { deletedRowCount: chunkSizes.length === 1 ? 100 : 7,
        complete: chunkSizes.length === 2 };
    },
    async releaseBarrier() { return true; },
  } satisfies CatalogPromotionRetentionRepositoryPort;
  const transport = {
    async sendExact() { throw new Error("must not send"); },
    async status() { throw new Error("must not status"); },
  } as unknown as CatalogPromotionRetentionTransportPort;

  const result = await runner(repository, transport).runCycle();

  assert.equal(result.outcome, "released");
  assert.deepEqual(chunkSizes, [100, 100]);
  assert.equal(result.postgresRowsDeleted, 107);
  assert.equal(result.networkRequests, 0);
});

test("cycle cap preserves the active barrier instead of releasing early", async () => {
  const cleanup = { ...(await manifestOperation("acknowledged")),
    operationKind: "retainProviderReleases" as const,
    phase: "provider_releases" as const,
    platformKey: "alpha",
    postgresCleanupComplete: false,
  };
  let releases = 0;
  const repository = {
    async acquireBarrier() { return await barrier(); },
    async loadPendingOperation() { return null; },
    async loadOperationRequiringCleanup() { return cleanup; },
    async prepareOperation() { return null; },
    async markOperationSent() { return false; },
    async acknowledgeOperation() { throw new Error("must not acknowledge"); },
    async deleteProviderArtifactChunk() { return { deletedRowCount: 10, complete: false }; },
    async releaseBarrier() { releases += 1; return true; },
  } satisfies CatalogPromotionRetentionRepositoryPort;
  const transport = {} as CatalogPromotionRetentionTransportPort;

  const result = await runner(repository, transport, 2).runCycle();

  assert.equal(result.outcome, "bounded");
  assert.equal(releases, 0);
  assert.equal(result.steps, 2);
});

test("cleanup refuses a corrupt no-progress result instead of spinning", async () => {
  const cleanup = { ...(await manifestOperation("acknowledged")),
    operationKind: "retainProviderReleases" as const,
    phase: "provider_releases" as const,
    platformKey: "alpha",
    postgresCleanupComplete: false,
  };
  const repository = {
    async acquireBarrier() { return await barrier(); },
    async loadPendingOperation() { return null; },
    async loadOperationRequiringCleanup() { return cleanup; },
    async prepareOperation() { return null; },
    async markOperationSent() { return false; },
    async acknowledgeOperation() { throw new Error("must not acknowledge"); },
    async deleteProviderArtifactChunk() {
      return { deletedRowCount: 0, complete: false };
    },
    async releaseBarrier() { throw new Error("must not release"); },
  } satisfies CatalogPromotionRetentionRepositoryPort;

  await assert.rejects(
    () => runner(repository, {} as CatalogPromotionRetentionTransportPort)
      .runCycle(),
    { code: "CATALOG_PROMOTION_RETENTION_COORDINATOR_INVALID" },
  );
});

test("cleanup refuses a non-provider operation at the repository port boundary", async () => {
  const invalid = {
    ...(await manifestOperation("acknowledged")),
    postgresCleanupComplete: false,
  };
  let deletionCalled = false;
  const repository = {
    async acquireBarrier() { return await barrier(); },
    async loadPendingOperation() { return null; },
    async loadOperationRequiringCleanup() { return invalid; },
    async prepareOperation() { return null; },
    async markOperationSent() { return false; },
    async acknowledgeOperation() { throw new Error("must not acknowledge"); },
    async deleteProviderArtifactChunk() {
      deletionCalled = true;
      return { deletedRowCount: 1, complete: true };
    },
    async releaseBarrier() { throw new Error("must not release"); },
  } satisfies CatalogPromotionRetentionRepositoryPort;

  await assert.rejects(
    () => runner(repository, {} as CatalogPromotionRetentionTransportPort)
      .runCycle(),
    { code: "CATALOG_PROMOTION_RETENTION_COORDINATOR_INVALID" },
  );
  assert.equal(deletionCalled, false);
});
