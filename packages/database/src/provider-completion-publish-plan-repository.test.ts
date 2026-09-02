import assert from "node:assert/strict";
import test from "node:test";
import { MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES } from
  "@packscout/contracts";
import type { CentralPrismaClient } from "./central-database.ts";
import {
  PrismaProviderCompletionPublishPlanRepository,
  ProviderCompletionPublishPlanCapacityError,
} from "./provider-completion-publish-plan-repository.ts";

const now = new Date("2026-09-02T12:00:00.000Z");

function metadataRow(input: Readonly<{
  providerKey?: string;
  eventId?: string;
  publicProviderReleaseId?: string;
  planByteCount: number;
  identityConflict?: boolean;
}>) {
  return {
    eventId: input.eventId ?? "10000000-0000-4000-8000-000000000001",
    providerId: "20000000-0000-4000-8000-000000000001",
    providerKey: input.providerKey ?? "alpha",
    providerReleaseId: "30000000-0000-4000-8000-000000000001",
    publicProviderReleaseId: input.publicProviderReleaseId ??
      "40000000-0000-5000-8000-000000000001",
    providerReleaseFingerprint: "a".repeat(64),
    catalogVersionId: "50000000-0000-4000-8000-000000000001",
    catalogContentHash: "b".repeat(64),
    providerReleaseContentHash: "c".repeat(64),
    completedThroughChangeSequence: 1n,
    artifactAttemptId: "60000000-0000-4000-8000-000000000001",
    terminalOperationKind: "finalize",
    terminalOperationId: "finalize:alpha:1",
    terminalReceiptSha256: "d".repeat(64),
    evidenceDigest: "e".repeat(64),
    activityEvidenceDigest: "e".repeat(64),
    activityEventType: "provider_release_completed",
    activityEventAt: now,
    activityReceivedAt: now,
    planSha256: "f".repeat(64),
    completedHeadSha256: "1".repeat(64),
    activeObservationSha256: "2".repeat(64),
    planByteCount: input.planByteCount,
    completedHeadByteCount: 2,
    activeObservationByteCount: 2,
    verifiedAt: now,
    createdAt: now,
    identityConflict: input.identityConflict ?? false,
  };
}

function metadataOnlyClient(
  rows: readonly unknown[],
  payloadFailure?: unknown,
) {
  let metadataReads = 0;
  let payloadReads = 0;
  let payloadReadInsideTransaction = false;
  let transactionCount = 0;
  const central = {
    async $transaction<T>(read: (client: {
      $queryRaw(): Promise<readonly unknown[]>;
    }) => Promise<T>) {
      transactionCount += 1;
      const metadataTransaction = transactionCount === 1;
      return read({
        async $queryRaw() {
          if (metadataTransaction) {
            metadataReads += 1;
            return rows;
          }
          payloadReads += 1;
          payloadReadInsideTransaction = true;
          if (payloadFailure !== undefined) throw payloadFailure;
          return [];
        },
      });
    },
    async $queryRaw() {
      payloadReads += 1;
      if (payloadFailure !== undefined) throw payloadFailure;
      return [];
    },
  } as unknown as CentralPrismaClient;
  return {
    central,
    observations: () => ({
      metadataReads,
      payloadReads,
      payloadReadInsideTransaction,
      transactionCount,
    }),
  };
}

test("aggregate admission rejects metadata before any plan bytes hydrate", async () => {
  const harness = metadataOnlyClient([metadataRow({
    planByteCount: MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES,
  })]);
  const repository = new PrismaProviderCompletionPublishPlanRepository(
    harness.central,
  );

  await assert.rejects(
    repository.loadByEvidence({
      providerId: "20000000-0000-4000-8000-000000000001",
      evidenceDigest: "e".repeat(64),
    }, { deadlineAt: Date.now() + 10_000 }),
    ProviderCompletionPublishPlanCapacityError,
  );
  assert.deepEqual(harness.observations(), {
    metadataReads: 1,
    payloadReads: 0,
    payloadReadInsideTransaction: false,
    transactionCount: 1,
  });
});

test("a pruned selected event fails closed after the metadata transaction", async () => {
  const row = metadataRow({ planByteCount: 1_024 });
  const harness = metadataOnlyClient([row]);
  const repository = new PrismaProviderCompletionPublishPlanRepository(
    harness.central,
  );

  assert.equal(await repository.loadForManifestReferences([{
    providerKey: row.providerKey,
    publicProviderReleaseId: row.publicProviderReleaseId,
    providerReleaseFingerprint: row.providerReleaseFingerprint,
  }], { deadlineAt: Date.now() + 10_000 }), null);
  assert.deepEqual(harness.observations(), {
    metadataReads: 1,
    payloadReads: 1,
    payloadReadInsideTransaction: true,
    transactionCount: 2,
  });
});

test("explicit target ambiguity fails from metadata without hydration", async () => {
  const harness = metadataOnlyClient([metadataRow({
    planByteCount: 1_024,
    identityConflict: true,
  })]);
  const repository = new PrismaProviderCompletionPublishPlanRepository(
    harness.central,
  );

  await assert.rejects(repository.loadExplicitTarget({
    providerId: "20000000-0000-4000-8000-000000000001",
    providerReleaseId: "30000000-0000-4000-8000-000000000001",
    catalogVersionId: "50000000-0000-4000-8000-000000000001",
  }, { deadlineAt: Date.now() + 10_000 }), /cache is inconsistent/u);
  assert.equal(harness.observations().payloadReads, 0);
});

test("a stalled exact-event read remains inside its own bounded transaction", async () => {
  const stalled = Object.assign(new Error("simulated transaction timeout"), {
    code: "P2028",
  });
  const row = metadataRow({ planByteCount: 1_024 });
  const harness = metadataOnlyClient([row], stalled);
  const repository = new PrismaProviderCompletionPublishPlanRepository(
    harness.central,
  );

  await assert.rejects(repository.loadForManifestReferences([{
    providerKey: row.providerKey,
    publicProviderReleaseId: row.publicProviderReleaseId,
    providerReleaseFingerprint: row.providerReleaseFingerprint,
  }], { deadlineAt: Date.now() + 10_000 }), /simulated transaction timeout/u);
  assert.deepEqual(harness.observations(), {
    metadataReads: 1,
    payloadReads: 1,
    payloadReadInsideTransaction: true,
    transactionCount: 2,
  });
});
