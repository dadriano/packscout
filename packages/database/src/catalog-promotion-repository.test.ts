import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Prisma } from "@prisma/client";
import {
  PrismaCatalogPromotionRepository,
  PromotionLedgerError,
  type PromotionAttemptClaim,
  type PromotionOperationInput,
} from "./catalog-promotion-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const organizationId = "91000000-0000-4000-8000-000000000001";
const otherOrganizationId = "91000000-0000-4000-8000-000000000002";
const deploymentKey = "convex-production-us";
const catalogLane = "catalog";
const contentIdentity = "a".repeat(64);
const publicationIdentity = "91333333-3333-4333-8333-333333333333";

const operations: readonly PromotionOperationInput[] = [
  {
    operationIndex: 0,
    operationId: `start:${publicationIdentity}`,
    operationKind: "start",
    requestPath: "/internal/data-release/v2/start",
    canonicalRequestBody: `{"operationId":"start:${publicationIdentity}","value":1}`,
  },
  {
    operationIndex: 1,
    operationId: `apply:${publicationIdentity}:0`,
    operationKind: "applyBatch",
    requestPath: "/internal/data-release/v2/apply-batch",
    canonicalRequestBody: `{"operationId":"apply:${publicationIdentity}:0","records":[1,2]}`,
  },
  {
    operationIndex: 2,
    operationId: `finalize:${publicationIdentity}`,
    operationKind: "finalize",
    requestPath: "/internal/data-release/v2/finalize",
    canonicalRequestBody: `{"operationId":"finalize:${publicationIdentity}"}`,
  },
];

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function isLedgerError(code: PromotionLedgerError["code"]): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof PromotionLedgerError);
    assert.equal(error.code, code);
    return true;
  };
}

async function createOrganization(client: {
  organizations: {
    create(input: { data: { id: string; slug: string; name: string } }): Promise<unknown>;
  };
}, id = organizationId, slug = "promotion-ledger") {
  await client.organizations.create({ data: { id, slug, name: slug } });
}

async function readyLane(
  repository: PrismaCatalogPromotionRepository,
  watermark: bigint,
  at: Date,
  laneKey = catalogLane,
): Promise<void> {
  await repository.coalesceSettledWatermark({
    laneKey,
    settledWatermark: watermark,
    settledAt: at,
    delayedVendorCount: 0,
  });
  await repository.verifyBootstrap({
    laneKey,
    observedPublicationIdentity: null,
    observedWatermark: 0n,
    observedReceiptSha256: null,
    verifiedAt: at,
  });
}

async function claim(
  repository: PrismaCatalogPromotionRepository,
  now: Date,
  laneKey = catalogLane,
): Promise<PromotionAttemptClaim> {
  const claimed = await repository.claimAttempt({
    laneKey,
    claimOwner: "worker-a",
    now,
    claimExpiresAt: new Date(now.getTime() + 30_000),
  });
  assert.ok(claimed);
  return claimed;
}

test("settled requests coalesce atomically and unknown remote bootstrap state fails closed", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await createOrganization(harness.client);
    const secondClient = await harness.createIndependentClient();
    const repository = new PrismaCatalogPromotionRepository(harness.client, {
      organizationId,
      deploymentKey,
    });
    const contender = new PrismaCatalogPromotionRepository(secondClient, {
      organizationId,
      deploymentKey,
    });
    await Promise.all([
      repository.coalesceSettledWatermark({
        laneKey: catalogLane,
        settledWatermark: 5n,
        settledAt: new Date("2026-08-15T12:00:05.000Z"),
        delayedVendorCount: 1,
      }),
      contender.coalesceSettledWatermark({
        laneKey: catalogLane,
        settledWatermark: 9n,
        settledAt: new Date("2026-08-15T12:00:09.000Z"),
        delayedVendorCount: 3,
      }),
      repository.coalesceSettledWatermark({
        laneKey: catalogLane,
        settledWatermark: 7n,
        settledAt: new Date("2026-08-15T12:00:07.000Z"),
        delayedVendorCount: 2,
      }),
    ]);
    const beforeBootstrap = await repository.loadHealthSnapshot({
      laneKey: catalogLane,
      now: new Date("2026-08-15T12:00:10.000Z"),
    });
    assert.equal(beforeBootstrap?.settledWatermark, 9n);
    assert.equal(beforeBootstrap?.requestedWatermark, 9n);
    assert.equal(beforeBootstrap?.delayedVendorCount, 3);
    await assert.rejects(
      repository.claimAttempt({
        laneKey: catalogLane,
        claimOwner: "worker-a",
        now: new Date("2026-08-15T12:00:10.000Z"),
        claimExpiresAt: new Date("2026-08-15T12:00:40.000Z"),
      }),
      isLedgerError("PROMOTION_BOOTSTRAP_UNVERIFIED"),
    );
    await assert.rejects(
      repository.verifyBootstrap({
        laneKey: catalogLane,
        observedPublicationIdentity: publicationIdentity,
        observedWatermark: 4n,
        observedReceiptSha256: "b".repeat(64),
        verifiedAt: new Date("2026-08-15T12:00:11.000Z"),
      }),
      isLedgerError("PROMOTION_BOOTSTRAP_UNPROVEN"),
    );
    assert.equal(
      (await repository.loadHealthSnapshot({
        laneKey: catalogLane,
        now: new Date("2026-08-15T12:00:11.000Z"),
      }))?.bootstrapState,
      "unverified",
    );
    await repository.verifyBootstrap({
      laneKey: catalogLane,
      observedPublicationIdentity: null,
      observedWatermark: 0n,
      observedReceiptSha256: null,
      verifiedAt: new Date("2026-08-15T12:00:12.000Z"),
    });
    const [first, second] = await Promise.all([
      repository.claimAttempt({
        laneKey: catalogLane,
        claimOwner: "worker-a",
        now: new Date("2026-08-15T12:00:13.000Z"),
        claimExpiresAt: new Date("2026-08-15T12:00:43.000Z"),
      }),
      contender.claimAttempt({
        laneKey: catalogLane,
        claimOwner: "worker-b",
        now: new Date("2026-08-15T12:00:13.000Z"),
        claimExpiresAt: new Date("2026-08-15T12:00:43.000Z"),
      }),
    ]);
    assert.equal([first, second].filter(Boolean).length, 1);
    assert.equal((first ?? second)?.targetWatermark, 9n);
    assert.equal(await harness.client.promotion_attempts.count(), 1);
    const lowerAttempt = first ?? second;
    assert.ok(lowerAttempt);
    await repository.coalesceSettledWatermark({
      laneKey: catalogLane,
      settledWatermark: 12n,
      settledAt: new Date("2026-08-15T12:00:14.000Z"),
      delayedVendorCount: 0,
    });
    const higherPublicationIdentity = "91444444-4444-4444-8444-444444444444";
    const higherReceipt = "{\"result\":\"activated-higher\"}";
    await harness.client.promotion_attempts.create({
      data: {
        organization_id: organizationId,
        deployment_key: deploymentKey,
        lane_key: catalogLane,
        target_watermark: 12n,
        state: "published",
        content_identity: "c".repeat(64),
        publication_identity: higherPublicationIdentity,
        terminal_receipt_body: higherReceipt,
        terminal_receipt_sha256: digest(higherReceipt),
        terminal_at: new Date("2026-08-15T12:00:15.000Z"),
        created_at: new Date("2026-08-15T12:00:15.000Z"),
        updated_at: new Date("2026-08-15T12:00:15.000Z"),
      },
    });
    // Model startup recovery before the lane is verified. Once a lane is
    // verified, a stale remote probe is intentionally ignored instead.
    await harness.client.promotion_lanes.update({
      where: {
        organization_id_deployment_key_lane_key: {
          organization_id: organizationId,
          deployment_key: deploymentKey,
          lane_key: catalogLane,
        },
      },
      data: { bootstrap_state: "unverified", bootstrap_verified_at: null },
    });
    await repository.verifyBootstrap({
      laneKey: catalogLane,
      observedPublicationIdentity: higherPublicationIdentity,
      observedWatermark: 12n,
      observedReceiptSha256: digest(higherReceipt),
      verifiedAt: new Date("2026-08-15T12:00:16.000Z"),
    });
    await assert.rejects(
      repository.completeAttempt({
        attemptId: lowerAttempt.attemptId,
        claimToken: lowerAttempt.claimToken,
        terminalState: "published",
        completedAt: new Date("2026-08-15T12:00:17.000Z"),
        receiptBody: "{\"result\":\"activated-lower\"}",
        failureClass: null,
        failureCode: null,
      }),
      isLedgerError("PROMOTION_WATERMARK_REGRESSED"),
    );
  } finally {
    await harness.close();
  }
});

test("byte-exact operations survive lease recovery and stale workers cannot acknowledge them", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await createOrganization(harness.client);
    const recoveryClient = await harness.createIndependentClient();
    const repository = new PrismaCatalogPromotionRepository(harness.client, {
      organizationId,
      deploymentKey,
    });
    const recovery = new PrismaCatalogPromotionRepository(recoveryClient, {
      organizationId,
      deploymentKey,
    });
    const startedAt = new Date("2026-08-15T13:00:00.000Z");
    await readyLane(repository, 11n, startedAt);
    const original = await claim(repository, startedAt);
    const persisted = await repository.persistAssembledOperations({
      attemptId: original.attemptId,
      claimToken: original.claimToken,
      now: startedAt,
      contentIdentity,
      publicationIdentity,
      operations,
    });
    assert.ok(persisted);
    assert.equal(persisted.length, 3);
    assert.equal(persisted[0]?.canonicalRequestBody, operations[0]?.canonicalRequestBody);
    assert.equal(persisted[0]?.requestSha256, digest(operations[0]!.canonicalRequestBody));
    assert.deepEqual(
      await repository.persistAssembledOperations({
        attemptId: original.attemptId,
        claimToken: original.claimToken,
        now: new Date("2026-08-15T13:00:01.000Z"),
        contentIdentity,
        publicationIdentity,
        operations,
      }),
      persisted,
    );
    await assert.rejects(
      repository.persistAssembledOperations({
        attemptId: original.attemptId,
        claimToken: original.claimToken,
        now: new Date("2026-08-15T13:00:02.000Z"),
        contentIdentity,
        publicationIdentity,
        operations: operations.map((operation, index) => index === 0
          ? { ...operation, canonicalRequestBody: "{\"changed\":true}" }
          : operation),
      }),
      isLedgerError("PROMOTION_OPERATION_CONFLICT"),
    );
    await assert.rejects(
      repository.markOperationSent({
        attemptId: original.attemptId,
        operationId: operations[1]!.operationId,
        claimToken: original.claimToken,
        sentAt: new Date("2026-08-15T13:00:03.000Z"),
      }),
      isLedgerError("PROMOTION_OPERATION_ORDER_INVALID"),
    );
    assert.equal(await repository.markOperationSent({
      attemptId: original.attemptId,
      operationId: operations[0]!.operationId,
      claimToken: original.claimToken,
      sentAt: new Date("2026-08-15T13:00:04.000Z"),
    }), true);
    assert.equal(await repository.heartbeat({
      attemptId: original.attemptId,
      claimToken: original.claimToken,
      heartbeatAt: new Date("2026-08-15T13:00:05.000Z"),
      claimExpiresAt: new Date("2026-08-15T13:00:31.000Z"),
    }), true);
    assert.equal(await recovery.claimAttempt({
      laneKey: catalogLane,
      claimOwner: "worker-too-early",
      now: new Date("2026-08-15T13:00:30.000Z"),
      claimExpiresAt: new Date("2026-08-15T13:01:00.000Z"),
    }), null);

    const recovered = await recovery.claimAttempt({
      laneKey: catalogLane,
      claimOwner: "worker-recovery",
      now: new Date("2026-08-15T13:00:32.000Z"),
      claimExpiresAt: new Date("2026-08-15T13:01:02.000Z"),
    });
    assert.ok(recovered);
    assert.equal(recovered.attemptId, original.attemptId);
    assert.equal(recovered.recovered, true);
    assert.equal(recovered.claimCount, 2);
    assert.notEqual(recovered.claimToken, original.claimToken);
    assert.equal(await repository.acknowledgeOperation({
      attemptId: original.attemptId,
      operationId: operations[0]!.operationId,
      claimToken: original.claimToken,
      acknowledgedAt: new Date("2026-08-15T13:00:32.000Z"),
      receiptBody: "{\"result\":\"created\"}",
    }), false);
    const resume = await recovery.firstUnacknowledgedOperation({
      attemptId: recovered.attemptId,
      claimToken: recovered.claimToken,
      now: new Date("2026-08-15T13:00:32.000Z"),
    });
    assert.equal(resume?.operationId, operations[0]?.operationId);
    assert.equal(resume?.state, "sent");
    assert.equal(resume?.canonicalRequestBody, operations[0]?.canonicalRequestBody);
    const receipts = [
      "{\"result\":\"created\"}",
      "{\"result\":\"accepted\"}",
      "{\"result\":\"activated\"}",
    ];
    for (const [index, operation] of operations.entries()) {
      await recovery.markOperationSent({
        attemptId: recovered.attemptId,
        operationId: operation.operationId,
        claimToken: recovered.claimToken,
        sentAt: new Date(`2026-08-15T13:00:${33 + index * 2}.000Z`),
      });
      assert.equal(await recovery.acknowledgeOperation({
        attemptId: recovered.attemptId,
        operationId: operation.operationId,
        claimToken: recovered.claimToken,
        acknowledgedAt: new Date(`2026-08-15T13:00:${34 + index * 2}.000Z`),
        receiptBody: receipts[index]!,
      }), true);
    }
    await assert.rejects(
      recovery.acknowledgeOperation({
        attemptId: recovered.attemptId,
        operationId: operations[2]!.operationId,
        claimToken: recovered.claimToken,
        acknowledgedAt: new Date("2026-08-15T13:00:40.000Z"),
        receiptBody: "{\"result\":\"different\"}",
      }),
      isLedgerError("PROMOTION_OPERATION_CONFLICT"),
    );
    const terminalReceipt = "{\"activePublicReleaseId\":\"91333333-3333-4333-8333-333333333333\"}";
    assert.equal(await recovery.completeAttempt({
      attemptId: recovered.attemptId,
      claimToken: recovered.claimToken,
      terminalState: "published",
      completedAt: new Date("2026-08-15T13:00:41.000Z"),
      receiptBody: terminalReceipt,
      failureClass: null,
      failureCode: null,
    }), true);
    const rows = await harness.client.promotion_operations.findMany({
      orderBy: { operation_index: "asc" },
    });
    assert.equal(rows[0]?.canonical_request_body, operations[0]?.canonicalRequestBody);
    assert.equal(rows[0]?.request_sha256, digest(operations[0]!.canonicalRequestBody));
    assert.equal(rows[2]?.receipt_body, receipts[2]);
    assert.equal(rows[2]?.receipt_sha256, digest(receipts[2]!));
    await assert.rejects(
      harness.client.promotion_operations.update({
        where: { id: rows[0]!.id },
        data: { canonical_request_body: "{}" },
      }),
      /immutable/i,
    );
    const health = await recovery.loadHealthSnapshot({
      laneKey: catalogLane,
      now: new Date("2026-08-15T13:00:42.000Z"),
    });
    assert.equal(health?.activeAttemptId, null);
    assert.equal(health?.confirmedWatermark, 11n);
    assert.equal(health?.lastActivatedWatermark, 11n);
    assert.equal(health?.confirmedPublicationIdentity, publicationIdentity);
    await recovery.verifyBootstrap({
      laneKey: catalogLane,
      observedPublicationIdentity: publicationIdentity,
      observedWatermark: 11n,
      observedReceiptSha256: digest(terminalReceipt),
      verifiedAt: new Date("2026-08-15T13:00:43.000Z"),
    });
  } finally {
    await harness.close();
  }
});

test("retry preserves one active attempt while newer requests coalesce behind it", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await createOrganization(harness.client);
    const repository = new PrismaCatalogPromotionRepository(harness.client, {
      organizationId,
      deploymentKey,
    });
    const startedAt = new Date("2026-08-15T14:00:00.000Z");
    await readyLane(repository, 5n, startedAt);
    const first = await claim(repository, startedAt);
    const oneOperation = [operations[0]!] as const;
    await repository.persistAssembledOperations({
      attemptId: first.attemptId,
      claimToken: first.claimToken,
      now: startedAt,
      contentIdentity,
      publicationIdentity,
      operations: oneOperation,
    });
    assert.equal(await repository.scheduleRetry({
      attemptId: first.attemptId,
      claimToken: first.claimToken,
      failedAt: new Date("2026-08-15T14:00:01.000Z"),
      retryAt: new Date("2026-08-15T14:01:00.000Z"),
      failureClass: "technical",
      failureCode: "NETWORK_TIMEOUT",
    }), true);
    await repository.coalesceSettledWatermark({
      laneKey: catalogLane,
      settledWatermark: 10n,
      settledAt: new Date("2026-08-15T14:00:30.000Z"),
      delayedVendorCount: 2,
    });
    assert.equal(await repository.claimAttempt({
      laneKey: catalogLane,
      claimOwner: "too-early",
      now: new Date("2026-08-15T14:00:59.000Z"),
      claimExpiresAt: new Date("2026-08-15T14:01:29.000Z"),
    }), null);
    const retry = await repository.claimAttempt({
      laneKey: catalogLane,
      claimOwner: "retry-worker",
      now: new Date("2026-08-15T14:01:00.000Z"),
      claimExpiresAt: new Date("2026-08-15T14:01:30.000Z"),
    });
    assert.ok(retry);
    assert.equal(retry.attemptId, first.attemptId);
    assert.equal(retry.targetWatermark, 5n);
    await repository.markOperationSent({
      attemptId: retry.attemptId,
      operationId: oneOperation[0].operationId,
      claimToken: retry.claimToken,
      sentAt: new Date("2026-08-15T14:01:01.000Z"),
    });
    await repository.acknowledgeOperation({
      attemptId: retry.attemptId,
      operationId: oneOperation[0].operationId,
      claimToken: retry.claimToken,
      acknowledgedAt: new Date("2026-08-15T14:01:02.000Z"),
      receiptBody: "{\"result\":\"activated\"}",
    });
    await repository.completeAttempt({
      attemptId: retry.attemptId,
      claimToken: retry.claimToken,
      terminalState: "published",
      completedAt: new Date("2026-08-15T14:01:03.000Z"),
      receiptBody: "{\"result\":\"activated\"}",
      failureClass: null,
      failureCode: null,
    });
    const next = await repository.claimAttempt({
      laneKey: catalogLane,
      claimOwner: "newer-worker",
      now: new Date("2026-08-15T14:01:04.000Z"),
      claimExpiresAt: new Date("2026-08-15T14:01:34.000Z"),
    });
    assert.ok(next);
    assert.equal(next.targetWatermark, 10n);
    assert.notEqual(next.attemptId, first.attemptId);
    assert.equal(next.expectedPredecessorIdentity, publicationIdentity);
    await repository.coalesceSettledWatermark({
      laneKey: catalogLane,
      settledWatermark: 7n,
      settledAt: new Date("2026-08-15T14:01:05.000Z"),
      delayedVendorCount: 0,
    });
    const health = await repository.loadHealthSnapshot({
      laneKey: catalogLane,
      now: new Date("2026-08-15T14:01:06.000Z"),
    });
    assert.equal(health?.settledWatermark, 10n);
    assert.equal(health?.requestedWatermark, 10n);
    assert.equal(health?.activeAttemptWatermark, 10n);
    assert.equal(health?.delayedVendorCount, 2);
  } finally {
    await harness.close();
  }
});

test("unchanged and deterministic failures are terminal, health-safe, and tenant bound", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await createOrganization(harness.client);
    await createOrganization(harness.client, otherOrganizationId, "other-promotion-ledger");
    const repository = new PrismaCatalogPromotionRepository(harness.client, {
      organizationId,
      deploymentKey,
    });
    const otherTenant = new PrismaCatalogPromotionRepository(harness.client, {
      organizationId: otherOrganizationId,
      deploymentKey,
    });
    const startedAt = new Date("2026-08-15T15:00:00.000Z");
    const terminalLane = "terminal-health";
    await readyLane(repository, 3n, startedAt, terminalLane);
    const baseline = await claim(repository, startedAt, terminalLane);
    await repository.persistAssembledOperations({
      attemptId: baseline.attemptId,
      claimToken: baseline.claimToken,
      now: startedAt,
      contentIdentity,
      publicationIdentity,
      operations: [operations[0]!],
    });
    await repository.markOperationSent({
      attemptId: baseline.attemptId,
      operationId: operations[0]!.operationId,
      claimToken: baseline.claimToken,
      sentAt: new Date("2026-08-15T15:00:01.000Z"),
    });
    await repository.acknowledgeOperation({
      attemptId: baseline.attemptId,
      operationId: operations[0]!.operationId,
      claimToken: baseline.claimToken,
      acknowledgedAt: new Date("2026-08-15T15:00:02.000Z"),
      receiptBody: "{\"result\":\"activated\"}",
    });
    await repository.completeAttempt({
      attemptId: baseline.attemptId,
      claimToken: baseline.claimToken,
      terminalState: "published",
      completedAt: new Date("2026-08-15T15:00:03.000Z"),
      receiptBody: "{\"result\":\"activated\"}",
      failureClass: null,
      failureCode: null,
    });
    await repository.coalesceSettledWatermark({
      laneKey: terminalLane,
      settledWatermark: 4n,
      settledAt: new Date("2026-08-15T15:00:04.000Z"),
      delayedVendorCount: 0,
    });
    const unchanged = await claim(
      repository,
      new Date("2026-08-15T15:00:05.000Z"),
      terminalLane,
    );
    const refreshOperation: PromotionOperationInput = {
      operationIndex: 0,
      operationId: `refresh:${publicationIdentity}:4`,
      operationKind: "refreshObservation",
      requestPath: "/internal/data-release/v2/refresh-observation",
      canonicalRequestBody: `{"operationId":"refresh:${publicationIdentity}:4"}`,
    };
    await repository.persistAssembledOperations({
      attemptId: unchanged.attemptId,
      claimToken: unchanged.claimToken,
      now: new Date("2026-08-15T15:00:05.000Z"),
      contentIdentity: "b".repeat(64),
      publicationIdentity,
      operations: [refreshOperation],
    });
    await repository.markOperationSent({
      attemptId: unchanged.attemptId,
      operationId: refreshOperation.operationId,
      claimToken: unchanged.claimToken,
      sentAt: new Date("2026-08-15T15:00:06.000Z"),
    });
    await repository.acknowledgeOperation({
      attemptId: unchanged.attemptId,
      operationId: refreshOperation.operationId,
      claimToken: unchanged.claimToken,
      acknowledgedAt: new Date("2026-08-15T15:00:07.000Z"),
      receiptBody: "{\"result\":\"refreshed\"}",
    });
    await repository.completeAttempt({
      attemptId: unchanged.attemptId,
      claimToken: unchanged.claimToken,
      terminalState: "unchanged",
      completedAt: new Date("2026-08-15T15:00:08.000Z"),
      receiptBody: "{\"result\":\"refreshed\"}",
      failureClass: null,
      failureCode: null,
    });
    const unchangedHealth = await repository.loadHealthSnapshot({
      laneKey: terminalLane,
      now: new Date("2026-08-15T15:00:09.000Z"),
    });
    assert.equal(unchangedHealth?.lastUnchangedWatermark, 4n);
    assert.equal(unchangedHealth?.activeAttemptId, null);
    await repository.verifyBootstrap({
      laneKey: terminalLane,
      observedPublicationIdentity: publicationIdentity,
      observedWatermark: 3n,
      observedReceiptSha256: digest("{\"result\":\"activated\"}"),
      verifiedAt: new Date("2026-08-15T15:00:09.500Z"),
    });
    assert.equal((await repository.loadHealthSnapshot({
      laneKey: terminalLane,
      now: new Date("2026-08-15T15:00:09.750Z"),
    }))?.confirmedWatermark, 4n);
    assert.equal(
      await otherTenant.loadHealthSnapshot({
        laneKey: terminalLane,
        now: startedAt,
      }),
      null,
    );
    assert.equal(await otherTenant.heartbeat({
      attemptId: unchanged.attemptId,
      claimToken: unchanged.claimToken,
      heartbeatAt: startedAt,
      claimExpiresAt: new Date(startedAt.getTime() + 30_000),
    }), false);

    await repository.coalesceSettledWatermark({
      laneKey: terminalLane,
      settledWatermark: 5n,
      settledAt: new Date("2026-08-15T15:00:10.000Z"),
      delayedVendorCount: 0,
    });
    const failed = await claim(
      repository,
      new Date("2026-08-15T15:00:11.000Z"),
      terminalLane,
    );
    assert.equal(await repository.completeAttempt({
      attemptId: failed.attemptId,
      claimToken: failed.claimToken,
      terminalState: "failed",
      completedAt: new Date("2026-08-15T15:00:12.000Z"),
      receiptBody: null,
      failureClass: "deterministic",
      failureCode: "PUBLIC_CONTRACT_INVALID",
    }), true);
    assert.equal(await repository.claimAttempt({
      laneKey: terminalLane,
      claimOwner: "same-watermark",
      now: new Date("2026-08-15T15:00:13.000Z"),
      claimExpiresAt: new Date("2026-08-15T15:00:43.000Z"),
    }), null);
    const terminal = await harness.client.promotion_attempts.findUniqueOrThrow({
      where: { id: failed.attemptId },
    });
    assert.equal(terminal.state, "failed");
    assert.equal(terminal.failure_class, "deterministic");
    assert.equal(terminal.failure_code, "PUBLIC_CONTRACT_INVALID");
    assert.equal(
      await harness.client.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        select count(*) as count from public.promotion_attempts
        where organization_id = cast(${organizationId} as uuid)
          and deployment_key = ${deploymentKey}
          and lane_key = ${terminalLane}
      `).then((rows) => rows[0]?.count),
      3n,
    );
  } finally {
    await harness.close();
  }
});

test("catalog runner port aliases durably restore prepared summaries, operations, baseline, and health", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await createOrganization(harness.client);
    const repository = new PrismaCatalogPromotionRepository(harness.client, {
      organizationId,
      deploymentKey,
    });
    const scope = { organizationId, deploymentKey, lane: "catalog" } as const;
    const now = new Date("2026-08-15T16:00:00.000Z");
    assert.equal(await repository.coalesce({
      ...scope,
      settledWatermark: 6n,
      requestedAt: now,
    }), "created");
    await repository.verifyBootstrap({
      laneKey: catalogLane,
      observedPublicationIdentity: null,
      observedWatermark: 0n,
      observedReceiptSha256: null,
      verifiedAt: now,
    });
    const claimed = await repository.claim({
      ...scope,
      workerId: "runner-worker",
      now,
      leaseExpiresAt: new Date("2026-08-15T16:00:30.000Z"),
    });
    assert.ok(claimed);
    assert.equal(claimed.prepared, null);
    assert.deepEqual(claimed.operations, []);
    const bodyJson = `{"operationId":"start:${publicationIdentity}"}`;
    const prepared = {
      classification: "publish",
      publicReleaseId: publicationIdentity,
      requestedWatermark: 6n,
      observationSequence: 6,
      contentHash: contentIdentity,
      publicConfigHash: "d".repeat(64),
      repackSearchIndexHash: "e".repeat(64),
      publicVendorKeys: ["alpha", "beta"],
      delayedVendorCount: 1,
      expectedPredecessorPublicReleaseId: null,
    } as const;
    assert.equal(await repository.persistPreparedOperations({
      attemptId: claimed.attemptId,
      claimToken: claimed.claimToken,
      prepared,
      operations: [{
        ordinal: 0,
        kind: "start",
        operationId: `start:${publicationIdentity}`,
        publicationId: publicationIdentity,
        path: "/internal/data-release/v2/start",
        bodyJson,
        bodyDigest: digest(bodyJson),
        dispatchCount: 0,
        lastDispatchedAt: null,
        acknowledgedAt: null,
        receipt: null,
      }],
      preparedAt: new Date("2026-08-15T16:00:01.000Z"),
    }), true);
    assert.equal(await repository.heartbeat({
      attemptId: claimed.attemptId,
      claimToken: claimed.claimToken,
      now: new Date("2026-08-15T16:00:02.000Z"),
      leaseExpiresAt: new Date("2026-08-15T16:00:32.000Z"),
    }), true);
    assert.equal(await repository.markOperationDispatched({
      attemptId: claimed.attemptId,
      claimToken: claimed.claimToken,
      ordinal: 0,
      dispatchedAt: new Date("2026-08-15T16:00:03.000Z"),
    }), true);
    const receipt = {
      schemaVersion: "data_release_v2",
      operationId: `start:${publicationIdentity}`,
      operationKind: "start",
      publicationId: publicationIdentity,
      terminalState: "staging",
      result: "created",
      serverTime: "2026-08-15T16:00:04.000Z",
      requestDigest: digest(bodyJson),
      receiptDigest: "f".repeat(64),
      details: {
        sourceWatermark: "public-change:6",
        manifestFingerprint: "1".repeat(64),
        contentHash: contentIdentity,
        expectedBatchCount: 0,
        expectedBatchChainHash: "2".repeat(64),
        expectedCounts: {
          vendors: 0,
          categories: 0,
          collectibles: 0,
          repacks: 0,
          repackChases: 0,
          searchShards: 0,
        },
      },
    } as const;
    assert.equal(await repository.acknowledgeOperation({
      attemptId: claimed.attemptId,
      claimToken: claimed.claimToken,
      ordinal: 0,
      receipt,
      acknowledgedAt: new Date("2026-08-15T16:00:04.000Z"),
    }), true);
    assert.equal(await repository.acknowledgeTerminal({
      attemptId: claimed.attemptId,
      claimToken: claimed.claimToken,
      outcome: "published",
      failureCode: null,
      receipt,
      completedAt: new Date("2026-08-15T16:00:05.000Z"),
      prepared,
    }), true);
    assert.deepEqual(await repository.loadBaseline(scope), {
      activePublicReleaseId: publicationIdentity,
      observationSequence: 6,
      contentHash: contentIdentity,
      publicConfigHash: "d".repeat(64),
      repackSearchIndexHash: "e".repeat(64),
      publicVendorKeys: ["alpha", "beta"],
    });
    const health = await repository.loadHealth(scope);
    assert.equal(health.settledWatermark, 6n);
    assert.equal(health.requestedWatermark, 6n);
    assert.equal(health.activeAttempt, null);
    assert.equal(health.lastActivatedWatermark, 6n);
    assert.equal(health.delayedVendorCount, 1);
  } finally {
    await harness.close();
  }
});
