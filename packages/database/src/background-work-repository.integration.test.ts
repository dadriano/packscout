import assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaBackgroundWorkRepository } from "./background-work-repository.ts";
import type { PackscoutPrismaClient } from "./database.ts";
import {
  PrismaEstimatedEvRecomputationRepository,
  estimatedEvRecomputationRequestKey,
} from "./estimated-ev-recomputation-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const ids = {
  organization: "51000000-0000-4000-8000-000000000001",
  otherOrganization: "51000000-0000-4000-8000-0000000000f1",
  provider: "51000000-0000-4000-8000-000000000002",
  otherProvider: "51000000-0000-4000-8000-0000000000f2",
  configuration: "51000000-0000-4000-8000-000000000003",
  otherConfiguration: "51000000-0000-4000-8000-0000000000f3",
  stuck: "51000000-0000-4000-8000-000000000010",
  active: "51000000-0000-4000-8000-000000000011",
  failed: "51000000-0000-4000-8000-000000000012",
  readyPending: "51000000-0000-4000-8000-000000000013",
  laterPending: "51000000-0000-4000-8000-000000000014",
  raced: "51000000-0000-4000-8000-000000000016",
  foreign: "51000000-0000-4000-8000-0000000000fa",
  execution: "51000000-0000-4000-8000-000000000020",
  olderExecution: "51000000-0000-4000-8000-000000000021",
  absent: "51000000-0000-4000-8000-0000000000ee",
} as const;

const now = new Date("2026-08-19T12:00:00.000Z");
const staleClaimToken = "51000000-0000-4000-8000-00000000c001";
const liveClaimToken = "51000000-0000-4000-8000-00000000c002";
const racedClaimToken = "51000000-0000-4000-8000-00000000c003";

function at(offsetMs: number): Date {
  return new Date(now.getTime() + offsetMs);
}

async function seedWorkspace(
  database: PackscoutPrismaClient,
  workspace: {
    organization: string;
    provider: string;
    configuration: string;
    slug: string;
  },
): Promise<void> {
  const setup = new PipelineSetupRepository(database);
  await setup.createOrganization({
    id: workspace.organization,
    slug: workspace.slug,
    name: `Workspace ${workspace.slug}`,
    createdAt: at(-3_600_000),
  });
  await setup.createProviderSource({
    id: workspace.provider,
    organizationId: workspace.organization,
    platformKey: `${workspace.slug}-platform`,
    displayName: "Fixture Provider",
    createdAt: at(-3_600_000),
  });
  await setup.createConfigRevision({
    id: workspace.configuration,
    organizationId: workspace.organization,
    providerId: workspace.provider,
    version: 1,
    adapterKey: "fixture-mapper-v1",
    endpointUrl: "https://provider.example/feed",
    authMode: "none",
    createdByActorKey: "actor:test",
    createdAt: at(-3_600_000),
  });
}

async function seedRequest(
  database: PackscoutPrismaClient,
  input: {
    id: string;
    organization?: string;
    provider?: string;
    configuration?: string;
    state: "queued" | "running" | "completed" | "failed";
    availableAt: Date;
    createdAt: Date;
    updatedAt?: Date;
    attemptCount?: number;
    claimedBy?: string;
    claimToken?: string;
    claimExpiresAt?: Date;
    failureCode?: string;
    completedAt?: Date;
  },
): Promise<void> {
  const organizationId = input.organization ?? ids.organization;
  const packExternalId = `pack-${input.id.slice(-4)}`;
  await database.estimated_ev_recomputation_requests.create({
    data: {
      id: input.id,
      request_key: estimatedEvRecomputationRequestKey({
        organizationId,
        platformKey: "fixture-platform",
        packExternalId,
        evInputExternalId: `${packExternalId}:odds`,
        packRevisionId: null,
        evInputRevisionId: null,
      }),
      organization_id: organizationId,
      provider_id: input.provider ?? ids.provider,
      configuration_revision_id: input.configuration ?? ids.configuration,
      platform_key: "fixture-platform",
      pack_external_id: packExternalId,
      ev_input_external_id: `${packExternalId}:odds`,
      state: input.state,
      attempt_count: input.attemptCount ?? 0,
      available_at: input.availableAt,
      created_at: input.createdAt,
      updated_at: input.updatedAt ?? input.createdAt,
      ...(input.claimedBy ? { claimed_by: input.claimedBy } : {}),
      ...(input.claimToken ? { claim_token: input.claimToken } : {}),
      ...(input.claimExpiresAt ? { claim_expires_at: input.claimExpiresAt } : {}),
      ...(input.failureCode ? { failure_code: input.failureCode } : {}),
      ...(input.completedAt ? { completed_at: input.completedAt } : {}),
    },
  });
}

async function seedQueue(database: PackscoutPrismaClient): Promise<void> {
  await seedRequest(database, {
    id: ids.readyPending,
    state: "queued",
    availableAt: at(-600_000),
    createdAt: at(-600_000),
  });
  await seedRequest(database, {
    id: ids.laterPending,
    state: "queued",
    availableAt: at(600_000),
    createdAt: at(-500_000),
  });
  await seedRequest(database, {
    id: ids.stuck,
    state: "running",
    availableAt: at(-400_000),
    createdAt: at(-400_000),
    updatedAt: at(-300_000),
    attemptCount: 1,
    claimedBy: "worker:departed:1",
    claimToken: staleClaimToken,
    claimExpiresAt: at(-60_000),
  });
  await seedRequest(database, {
    id: ids.active,
    state: "running",
    availableAt: at(-200_000),
    createdAt: at(-200_000),
    updatedAt: at(-10_000),
    attemptCount: 1,
    claimedBy: "worker:alive:2",
    claimToken: liveClaimToken,
    claimExpiresAt: at(60_000),
  });
  await seedRequest(database, {
    id: ids.failed,
    state: "failed",
    availableAt: at(-100_000),
    createdAt: at(-100_000),
    attemptCount: 5,
    failureCode: "ESTIMATED_EV_CALCULATION_FAILED",
  });
}

test("queue aggregates and pages are tenant-scoped and accurate past the page", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await seedWorkspace(harness.database, {
      organization: ids.organization,
      provider: ids.provider,
      configuration: ids.configuration,
      slug: "background-work",
    });
    await seedWorkspace(harness.database, {
      organization: ids.otherOrganization,
      provider: ids.otherProvider,
      configuration: ids.otherConfiguration,
      slug: "other-workspace",
    });
    await seedQueue(harness.database);
    await seedRequest(harness.database, {
      id: ids.foreign,
      organization: ids.otherOrganization,
      provider: ids.otherProvider,
      configuration: ids.otherConfiguration,
      state: "queued",
      availableAt: at(-900_000),
      createdAt: at(-900_000),
    });
    const repository = new PrismaBackgroundWorkRepository(harness.database);

    const aggregate = await repository.aggregateRecomputations({
      organizationId: ids.organization,
      now,
    });
    assert.deepEqual(
      {
        pending: aggregate.pending,
        readyPending: aggregate.readyPending,
        claimed: aggregate.claimed,
        expiredClaims: aggregate.expiredClaims,
        failed: aggregate.failed,
      },
      { pending: 2, readyPending: 1, claimed: 2, expiredClaims: 1, failed: 1 },
    );
    // The oldest pending age is measured from the durable availability, not
    // from whichever rows happen to fit on the first page.
    assert.deepEqual(aggregate.oldestPendingAvailableAt, at(-600_000));

    // Another workspace's older pending entry never enters these measures.
    const foreignAggregate = await repository.aggregateRecomputations({
      organizationId: ids.otherOrganization,
      now,
    });
    assert.equal(foreignAggregate.pending, 1);

    const firstPage = await repository.listRecomputations({
      organizationId: ids.organization,
      limit: 2,
    });
    assert.equal(firstPage.hasMore, true);
    assert.deepEqual(
      firstPage.items.map(({ id }) => id),
      [ids.failed, ids.active],
    );
    const last = firstPage.items.at(-1);
    const secondPage = await repository.listRecomputations({
      organizationId: ids.organization,
      limit: 2,
      before: { createdAt: last!.createdAt, id: last!.id },
    });
    assert.deepEqual(
      secondPage.items.map(({ id }) => id),
      [ids.stuck, ids.laterPending],
    );

    const failedOnly = await repository.listRecomputations({
      organizationId: ids.organization,
      limit: 25,
      state: "failed",
    });
    assert.deepEqual(
      failedOnly.items.map(({ id, attemptCount, failureCode }) => ({
        id,
        attemptCount,
        failureCode,
      })),
      [
        {
          id: ids.failed,
          attemptCount: 5,
          failureCode: "ESTIMATED_EV_CALCULATION_FAILED",
        },
      ],
    );

    const claimed = await repository.listRecomputations({
      organizationId: ids.organization,
      limit: 25,
      state: "running",
    });
    assert.deepEqual(
      claimed.items.map(({ id, claimedBy }) => ({ id, claimedBy })),
      [
        { id: ids.active, claimedBy: "worker:alive:2" },
        { id: ids.stuck, claimedBy: "worker:departed:1" },
      ],
    );

    await assert.rejects(
      repository.listRecomputations({
        organizationId: ids.organization,
        limit: 500,
      }),
      /page limit is invalid/,
    );
  } finally {
    await harness.close();
  }
});

test("a released claim is re-claimable by a worker exactly once", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await seedWorkspace(harness.database, {
      organization: ids.organization,
      provider: ids.provider,
      configuration: ids.configuration,
      slug: "background-work",
    });
    await seedQueue(harness.database);
    const repository = new PrismaBackgroundWorkRepository(harness.database);
    const queue = new PrismaEstimatedEvRecomputationRepository(harness.database);

    const released = await repository.releaseStuckClaim({
      organizationId: ids.organization,
      requestId: ids.stuck,
      actorKey: "actor:v1:operator",
      now,
    });
    assert.equal(released.outcome, "released");
    assert.equal(released.record?.state, "queued");
    assert.equal(released.record?.claimedBy, null);
    assert.equal(released.record?.claimExpiresAt, null);
    // The attempt history survives the release.
    assert.equal(released.record?.attemptCount, 1);

    // The worker that still held the stale claim can no longer finish or fail
    // the request, so recovery cannot double-process it.
    assert.equal(
      await queue.complete({
        requestId: ids.stuck,
        claimToken: staleClaimToken,
        completedAt: at(1_000),
        resultStatus: "estimated",
        calculationRevisionId: ids.configuration,
      }),
      false,
    );
    assert.equal(
      await queue.recordFailure({
        requestId: ids.stuck,
        claimToken: staleClaimToken,
        failedAt: at(1_000),
        retryAt: at(2_000),
        failureCode: "ESTIMATED_EV_RECOMPUTATION_FAILED",
        maximumAttempts: 5,
      }),
      "lost",
    );

    const first = await queue.claimBatch({
      workerId: "worker:fresh:3",
      now: at(2_000),
      limit: 10,
      leaseMilliseconds: 30_000,
    });
    const second = await queue.claimBatch({
      workerId: "worker:fresh:4",
      now: at(3_000),
      limit: 10,
      leaseMilliseconds: 30_000,
    });
    const claims = [...first, ...second].filter(({ id }) => id === ids.stuck);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.attemptCount, 2);
    assert.notEqual(claims[0]?.claimToken, staleClaimToken);
  } finally {
    await harness.close();
  }
});

test("recovery conflicts resolve cleanly instead of corrupting queue state", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await seedWorkspace(harness.database, {
      organization: ids.organization,
      provider: ids.provider,
      configuration: ids.configuration,
      slug: "background-work",
    });
    await seedWorkspace(harness.database, {
      organization: ids.otherOrganization,
      provider: ids.otherProvider,
      configuration: ids.otherConfiguration,
      slug: "other-workspace",
    });
    await seedQueue(harness.database);
    await seedRequest(harness.database, {
      id: ids.raced,
      state: "running",
      availableAt: at(-300_000),
      createdAt: at(-300_000),
      updatedAt: at(-250_000),
      attemptCount: 1,
      claimedBy: "worker:racing:9",
      claimToken: racedClaimToken,
      claimExpiresAt: at(-30_000),
    });
    await seedRequest(harness.database, {
      id: ids.foreign,
      organization: ids.otherOrganization,
      provider: ids.otherProvider,
      configuration: ids.otherConfiguration,
      state: "failed",
      availableAt: at(-900_000),
      createdAt: at(-900_000),
      attemptCount: 5,
      failureCode: "ESTIMATED_EV_CALCULATION_FAILED",
    });
    const repository = new PrismaBackgroundWorkRepository(harness.database);
    const queue = new PrismaEstimatedEvRecomputationRepository(harness.database);

    // A worker that resolves the entry first wins; the operator's release
    // reports the conflict rather than reopening settled work.
    assert.equal(
      await queue.recordFailure({
        requestId: ids.raced,
        claimToken: racedClaimToken,
        failedAt: at(-1_000),
        retryAt: at(-1_000),
        failureCode: "ESTIMATED_EV_CALCULATION_FAILED",
        maximumAttempts: 1,
      }),
      "failed",
    );
    const raced = await repository.releaseStuckClaim({
      organizationId: ids.organization,
      requestId: ids.raced,
      actorKey: "actor:v1:operator",
      now,
    });
    assert.equal(raced.outcome, "already_resolved");
    assert.equal(raced.record?.state, "failed");

    // A live claim is not stuck, so it is never taken from its worker.
    const active = await repository.releaseStuckClaim({
      organizationId: ids.organization,
      requestId: ids.active,
      actorKey: "actor:v1:operator",
      now,
    });
    assert.equal(active.outcome, "claim_active");
    assert.equal(active.record?.claimedBy, "worker:alive:2");

    // Releasing something that was never claimed is a conflict, not a write.
    const pending = await repository.releaseStuckClaim({
      organizationId: ids.organization,
      requestId: ids.readyPending,
      actorKey: "actor:v1:operator",
      now,
    });
    assert.equal(pending.outcome, "already_resolved");
    assert.equal(pending.record?.state, "queued");

    const missing = await repository.releaseStuckClaim({
      organizationId: ids.organization,
      requestId: ids.absent,
      actorKey: "actor:v1:operator",
      now,
    });
    assert.deepEqual(missing, { outcome: "not_found", record: null });

    // Another workspace's failed entry is invisible to this operator.
    const foreign = await repository.requeueFailedEntry({
      organizationId: ids.organization,
      requestId: ids.foreign,
      actorKey: "actor:v1:operator",
      now,
    });
    assert.deepEqual(foreign, { outcome: "not_found", record: null });
    assert.equal(
      (
        await harness.database.estimated_ev_recomputation_requests.findUnique({
          where: { id: ids.foreign },
          select: { state: true },
        })
      )?.state,
      "failed",
    );

    const requeued = await repository.requeueFailedEntry({
      organizationId: ids.organization,
      requestId: ids.failed,
      actorKey: "actor:v1:operator",
      now,
    });
    assert.equal(requeued.outcome, "requeued");
    assert.equal(requeued.record?.state, "queued");
    assert.equal(requeued.record?.failureCode, null);
    assert.equal(requeued.record?.attemptCount, 5);

    const repeated = await repository.requeueFailedEntry({
      organizationId: ids.organization,
      requestId: ids.failed,
      actorKey: "actor:v1:operator",
      now,
    });
    assert.equal(repeated.outcome, "already_resolved");

    // Every operator attempt is audited under the acting workspace, whether it
    // changed the queue or ran into a conflict.
    const audits = await harness.database.audit_events.findMany({
      where: { subject_type: "estimated_ev_recomputation_request" },
      select: {
        action: true,
        outcome: true,
        actor_key: true,
        organization_id: true,
      },
    });
    assert.ok(
      audits.every(
        (audit) =>
          audit.actor_key === "actor:v1:operator" &&
          audit.organization_id === ids.organization,
      ),
    );
    const tally = audits.reduce<Record<string, number>>((counts, audit) => {
      const key = `${audit.action}:${audit.outcome}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    assert.deepEqual(tally, {
      "provider.estimated_ev.release:blocked": 4,
      "provider.estimated_ev.requeue:blocked": 2,
      "provider.estimated_ev.requeue:success": 1,
    });

    await assert.rejects(
      repository.releaseStuckClaim({
        organizationId: ids.organization,
        requestId: "not-a-uuid",
        actorKey: "actor:v1:operator",
        now,
      }),
      /identity is invalid/,
    );
    await assert.rejects(
      repository.requeueFailedEntry({
        organizationId: ids.organization,
        requestId: ids.failed,
        actorKey: "",
        now,
      }),
      /actor key is invalid/,
    );
  } finally {
    await harness.close();
  }
});

test("retention executions page newest first and expose the latest for cadence", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await seedWorkspace(harness.database, {
      organization: ids.organization,
      provider: ids.provider,
      configuration: ids.configuration,
      slug: "background-work",
    });
    await harness.database.retention_executions.createMany({
      data: [
        {
          id: ids.olderExecution,
          organization_id: ids.organization,
          state: "failed",
          cutoff_at: at(-7_200_000),
          batch_size: 500,
          failed_count: 1,
          failure_code: "RETENTION_BATCH_FAILED",
          sanitized_summary: "A bounded protected-data cleanup did not complete.",
          started_at: at(-7_200_000),
          finished_at: at(-7_199_000),
        },
        {
          id: ids.execution,
          organization_id: ids.organization,
          state: "succeeded",
          cutoff_at: at(-3_600_000),
          batch_size: 500,
          selected_count: 9,
          expired_count: 9,
          already_expired_count: 4,
          remaining_count: 3,
          pages_expired_count: 2,
          source_records_expired_count: 5,
          quarantines_expired_count: 2,
          started_at: at(-3_600_000),
          finished_at: at(-3_598_000),
        },
      ],
    });
    const repository = new PrismaBackgroundWorkRepository(harness.database);

    const page = await repository.listRetentionExecutions({
      organizationId: ids.organization,
      limit: 1,
    });
    assert.equal(page.hasMore, true);
    assert.equal(page.items[0]?.id, ids.execution);
    assert.equal(page.items[0]?.remaining, 3);
    assert.equal(page.items[0]?.pagesExpired, 2);
    assert.equal(page.items[0]?.sourceRecordsExpired, 5);
    assert.equal(page.items[0]?.quarantinesExpired, 2);

    const next = await repository.listRetentionExecutions({
      organizationId: ids.organization,
      limit: 25,
      before: {
        createdAt: page.items[0]!.startedAt,
        id: page.items[0]!.id,
      },
    });
    assert.deepEqual(
      next.items.map(({ id, state, failureCode }) => ({ id, state, failureCode })),
      [
        {
          id: ids.olderExecution,
          state: "failed",
          failureCode: "RETENTION_BATCH_FAILED",
        },
      ],
    );

    const latest = await repository.latestRetentionExecution({
      organizationId: ids.organization,
    });
    assert.equal(latest?.id, ids.execution);
    assert.equal(
      await repository.latestRetentionExecution({
        organizationId: ids.otherOrganization,
      }),
      null,
    );
  } finally {
    await harness.close();
  }
});
