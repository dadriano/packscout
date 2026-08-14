import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PrismaProviderHealthRepository,
  PrismaProviderScheduleRepository,
  projectProviderRunHealth,
} from "./provider-scheduling-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

test("database claims serialize workers, preserve cadence, and recover expired leases", async () => {
  const context = await createMigratedTestDatabase();
  try {
    const organizationId = "10000000-0000-4000-8000-000000000001";
    const providerId = "20000000-0000-4000-8000-000000000001";
    const revisionId = "30000000-0000-4000-8000-000000000001";
    const dueAt = new Date("2026-08-06T12:00:00.000Z");
    await context.client.organizations.create({
      data: {
        id: organizationId,
        slug: "scheduler-test",
        name: "Scheduler test",
      },
    });
    await context.client.provider_sources.create({
      data: {
        id: providerId,
        organization_id: organizationId,
        platform_key: "scheduler-platform",
        display_name: "Scheduler provider",
      },
    });
    await context.client.provider_config_revisions.create({
      data: {
        id: revisionId,
        organization_id: organizationId,
        provider_id: providerId,
        version: 1,
        adapter_key: "http-cursor-v2",
        endpoint_url: "https://provider.example/feed",
        auth_mode: "none",
        schedule_seconds: 300,
        stale_after_seconds: 900,
        tested_at: new Date("2026-08-06T11:55:00.000Z"),
        tested_by_actor_key: "actor:test",
        created_by_actor_key: "actor:test",
      },
    });
    await context.client.provider_sources.update({
      where: { id: providerId },
      data: {
        state: "active",
        active_revision_id: revisionId,
        next_run_at: dueAt,
      },
    });

    const independentClient = await context.createIndependentClient();
    const repository = new PrismaProviderScheduleRepository(context.client);
    const contenderRepository = new PrismaProviderScheduleRepository(
      independentClient,
    );
    const [firstClaim, secondClaim] = await Promise.all([
      repository.claimDueProvider({
        workerId: "worker-a",
        now: dueAt,
        leaseExpiresAt: new Date("2026-08-06T12:00:30.000Z"),
      }),
      contenderRepository.claimDueProvider({
        workerId: "worker-b",
        now: dueAt,
        leaseExpiresAt: new Date("2026-08-06T12:00:30.000Z"),
      }),
    ]);
    assert.equal([firstClaim, secondClaim].filter(Boolean).length, 1);
    const winnerWorker = firstClaim ? "worker-a" : "worker-b";
    assert.equal((firstClaim ?? secondClaim)?.providerId, providerId);

    const contendingClaim = await contenderRepository.claimDueProvider({
      workerId: "worker-contender",
      now: new Date("2026-08-06T12:00:10.000Z"),
      leaseExpiresAt: new Date("2026-08-06T12:00:40.000Z"),
    });
    assert.equal(contendingClaim, null);

    const recoveredClaim = await contenderRepository.claimDueProvider({
      workerId: "worker-recovery",
      now: new Date("2026-08-06T12:00:31.000Z"),
      leaseExpiresAt: new Date("2026-08-06T12:01:01.000Z"),
    });
    assert.equal(recoveredClaim?.providerId, providerId);

    assert.equal(
      await repository.completeClaim({
        workerId: "worker-foreign",
        organizationId,
        providerId,
        configRevisionId: revisionId,
        outcome: "coalesced",
        runId: null,
        completedAt: new Date("2026-08-06T12:00:31.500Z"),
        nextDueAt: new Date("2026-08-06T14:00:00.000Z"),
      }),
      false,
    );
    assert.equal(
      (
        await context.client.provider_sources.findUniqueOrThrow({
          where: { id: providerId },
          select: { next_run_at: true },
        })
      ).next_run_at?.getTime(),
      dueAt.getTime(),
    );

    const staleRetryAt = new Date("2026-08-06T13:00:00.000Z");
    await repository.releaseClaim({
      workerId: winnerWorker,
      organizationId,
      providerId,
      configRevisionId: revisionId,
      releasedAt: new Date("2026-08-06T12:00:32.000Z"),
      retryAt: staleRetryAt,
    });
    const stillRecovered = await context.client.provider_schedules.findUniqueOrThrow({
      where: { provider_id: providerId },
    });
    assert.equal(stillRecovered.claim_owner, "worker-recovery");
    assert.equal(stillRecovered.next_due_at.getTime(), dueAt.getTime());
    assert.equal(
      (
        await context.client.provider_sources.findUniqueOrThrow({
          where: { id: providerId },
          select: { next_run_at: true },
        })
      ).next_run_at?.getTime(),
      dueAt.getTime(),
    );

    const nextDueAt = new Date("2026-08-06T12:05:31.000Z");
    assert.equal(
      await contenderRepository.completeClaim({
        workerId: "worker-recovery",
        organizationId,
        providerId,
        configRevisionId: revisionId,
        outcome: "coalesced",
        runId: null,
        completedAt: new Date("2026-08-06T12:00:31.000Z"),
        nextDueAt,
      }),
      true,
    );
    assert.equal(
      await repository.claimDueProvider({
        workerId: "worker-c",
        now: new Date("2026-08-06T12:05:30.000Z"),
        leaseExpiresAt: new Date("2026-08-06T12:06:00.000Z"),
      }),
      null,
    );
    assert.equal(
      (
        await repository.claimDueProvider({
          workerId: "worker-c",
          now: nextDueAt,
          leaseExpiresAt: new Date("2026-08-06T12:06:01.000Z"),
        })
      )?.providerId,
      providerId,
    );
  } finally {
    await context.close();
  }
});

test("provider health mutations serialize and remain tenant scoped", async () => {
  const context = await createMigratedTestDatabase();
  const organizationId = "11000000-0000-4000-8000-000000000001";
  const providerId = "21000000-0000-4000-8000-000000000001";
  try {
    await context.client.organizations.create({
      data: {
        id: organizationId,
        slug: "health-test",
        name: "Health test",
      },
    });
    await context.client.provider_sources.create({
      data: {
        id: providerId,
        organization_id: organizationId,
        platform_key: "health-platform",
        display_name: "Health provider",
      },
    });
    const independentClient = await context.createIndependentClient();
    const first = new PrismaProviderHealthRepository(context.client);
    const second = new PrismaProviderHealthRepository(independentClient);
    await Promise.all([
      first.recordRunOutcome({
        organizationId,
        providerId,
        reachedProviderHead: false,
        failureCode: "IMPORT_TIMEOUT",
        finishedAt: new Date("2026-08-06T11:00:00.000Z"),
      }),
      second.recordRunOutcome({
        organizationId,
        providerId,
        reachedProviderHead: false,
        failureCode: "IMPORT_UNREACHABLE",
        finishedAt: new Date("2026-08-06T11:01:00.000Z"),
      }),
    ]);
    assert.equal(
      (
        await context.client.provider_health_states.findUniqueOrThrow({
          where: { provider_id: providerId },
        })
      ).consecutive_failures,
      2,
    );

    const recoveredAt = new Date("2026-08-06T12:00:00.000Z");
    await first.recordRunOutcome({
      organizationId,
      providerId,
      reachedProviderHead: true,
      failureCode: null,
      finishedAt: recoveredAt,
    });
    await first.recordQualitySignal({
      organizationId,
      providerId,
      kind: "mapping",
      severity: "warning",
      occurredAt: new Date("2026-08-06T12:01:00.000Z"),
    });
    await second.recordQualitySignal({
      organizationId,
      providerId,
      kind: "calculation",
      severity: "degraded",
      occurredAt: new Date("2026-08-06T12:02:00.000Z"),
    });
    await first.resolveQualitySignal({
      organizationId,
      providerId,
      kind: "mapping",
      resolvedAt: new Date("2026-08-06T12:03:00.000Z"),
    });
    const health = await context.client.provider_health_states.findUniqueOrThrow({
      where: { provider_id: providerId },
    });
    assert.equal(health.consecutive_failures, 0);
    assert.equal(health.latest_failure_code, null);
    assert.equal(health.last_head_reached_at?.getTime(), recoveredAt.getTime());
    assert.equal(health.recovered_at?.getTime(), recoveredAt.getTime());
    assert.equal(health.mapping_warning_active, false);
    assert.equal(health.calculation_warning_active, true);
    assert.equal(health.calculation_warning_severity, "degraded");

    await assert.rejects(
      second.recordRunOutcome({
        organizationId: "11000000-0000-4000-8000-000000000099",
        providerId,
        reachedProviderHead: false,
        failureCode: "IMPORT_TIMEOUT",
        finishedAt: new Date("2026-08-06T12:04:00.000Z"),
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TENANT_SCOPE_VIOLATION",
    );
  } finally {
    await context.close();
  }
});

test("archive history does not affect live health while an active archive remains visible", async () => {
  const context = await createMigratedTestDatabase();
  const organizationId = "12000000-0000-4000-8000-000000000001";
  const providerId = "22000000-0000-4000-8000-000000000001";
  const httpRevisionId = "32000000-0000-4000-8000-000000000001";
  const archiveRevisionId = "32000000-0000-4000-8000-000000000002";
  const liveRunId = "42000000-0000-4000-8000-000000000001";
  try {
    await context.client.organizations.create({
      data: { id: organizationId, slug: "archive-health", name: "Archive Health" },
    });
    await context.client.provider_sources.create({
      data: {
        id: providerId,
        organization_id: organizationId,
        platform_key: "collector_crypt",
        display_name: "Collector Crypt",
      },
    });
    await context.client.provider_config_revisions.createMany({
      data: [
        {
          id: httpRevisionId,
          organization_id: organizationId,
          provider_id: providerId,
          version: 1,
          adapter_key: "http-cursor-v2",
          endpoint_url: "https://provider.example/feed",
          auth_mode: "none",
          created_by_actor_key: "actor:test",
        },
        {
          id: archiveRevisionId,
          organization_id: organizationId,
          provider_id: providerId,
          version: 2,
          adapter_key: "provider-archive-v2",
          mapping_adapter_key: "collector-crypt-v2",
          actor_pseudonym_key_fingerprint: "a".repeat(64),
          archive_importer_build_sha: "b".repeat(40),
          endpoint_url: `archive://sha256/${"c".repeat(64)}`,
          auth_mode: "none",
          schedule_seconds: 60,
          stale_after_seconds: 1,
          source_mode: "archive",
          created_by_actor_key: "actor:test",
        },
      ],
    });
    const liveFinishedAt = new Date("2026-08-06T10:00:00.000Z");
    await context.client.import_runs.createMany({
      data: [
        {
          id: liveRunId,
          organization_id: organizationId,
          provider_id: providerId,
          config_revision_id: httpRevisionId,
          trigger: "scheduled",
          state: "succeeded",
          reached_provider_head: true,
          started_at: new Date("2026-08-06T09:59:00.000Z"),
          finished_at: liveFinishedAt,
          created_at: new Date("2026-08-06T09:58:00.000Z"),
        },
        {
          id: "42000000-0000-4000-8000-000000000002",
          organization_id: organizationId,
          provider_id: providerId,
          config_revision_id: archiveRevisionId,
          trigger: "archive",
          archive_sha256: "c".repeat(64),
          requested_by_actor_key: "actor:archive",
          state: "succeeded",
          reached_provider_head: true,
          started_at: new Date("2026-08-06T11:59:00.000Z"),
          finished_at: new Date("2026-08-06T12:00:00.000Z"),
          created_at: new Date("2026-08-06T11:58:00.000Z"),
        },
        {
          id: "42000000-0000-4000-8000-000000000003",
          organization_id: organizationId,
          provider_id: providerId,
          config_revision_id: archiveRevisionId,
          trigger: "archive",
          archive_sha256: "d".repeat(64),
          requested_by_actor_key: "actor:archive",
          state: "incomplete",
          finished_at: new Date("2026-08-06T12:01:00.000Z"),
          created_at: new Date("2026-08-06T12:00:30.000Z"),
        },
        {
          id: "42000000-0000-4000-8000-000000000004",
          organization_id: organizationId,
          provider_id: providerId,
          config_revision_id: archiveRevisionId,
          trigger: "archive",
          archive_sha256: "e".repeat(64),
          requested_by_actor_key: "actor:archive",
          state: "queued",
          created_at: new Date("2026-08-06T12:02:00.000Z"),
        },
      ],
    });

    const health = await new PrismaProviderHealthRepository(
      context.client,
    ).loadHealthEvidence({ organizationId, providerId });
    assert.equal(health?.configRevisionId, httpRevisionId);
    assert.equal(health?.activeRun?.id, "42000000-0000-4000-8000-000000000004");
    assert.equal(health?.activeRun?.state, "queued");
    assert.equal(health?.latestRun?.id, liveRunId);
    assert.equal(health?.latestIncompleteRunId, null);
    assert.equal(health?.lastAttemptedAt?.toISOString(), "2026-08-06T09:59:00.000Z");
    assert.equal(health?.lastHeadReachedAt?.getTime(), liveFinishedAt.getTime());
  } finally {
    await context.close();
  }
});

test("consecutive failures reset only after provider head recovery", () => {
  const initial = {
    consecutiveFailures: 0,
    latestFailureCode: null,
    lastHeadReachedAt: new Date("2026-08-06T10:00:00.000Z"),
    recoveredAt: null,
  };
  const firstFailure = projectProviderRunHealth(initial, {
    reachedProviderHead: false,
    failureCode: "IMPORT_TIMEOUT",
    finishedAt: new Date("2026-08-06T11:00:00.000Z"),
  });
  const secondFailure = projectProviderRunHealth(firstFailure, {
    reachedProviderHead: false,
    failureCode: "IMPORT_UNREACHABLE",
    finishedAt: new Date("2026-08-06T11:30:00.000Z"),
  });
  assert.equal(secondFailure.consecutiveFailures, 2);
  assert.equal(secondFailure.latestFailureCode, "IMPORT_UNREACHABLE");

  const recovered = projectProviderRunHealth(secondFailure, {
    reachedProviderHead: true,
    failureCode: null,
    finishedAt: new Date("2026-08-06T12:00:00.000Z"),
  });
  assert.equal(recovered.consecutiveFailures, 0);
  assert.equal(recovered.latestFailureCode, null);
  assert.ok(recovered.lastHeadReachedAt);
  assert.equal(recovered.lastHeadReachedAt.toISOString(), "2026-08-06T12:00:00.000Z");
  assert.equal(recovered.recoveredAt?.toISOString(), "2026-08-06T12:00:00.000Z");
});

test("health projection rejects unbounded failure material", () => {
  assert.throws(
    () =>
      projectProviderRunHealth(
        {
          consecutiveFailures: 0,
          latestFailureCode: null,
          lastHeadReachedAt: null,
          recoveredAt: null,
        },
        {
          reachedProviderHead: false,
          failureCode: "credential=secret value",
          finishedAt: new Date("2026-08-06T12:00:00.000Z"),
        },
      ),
    /failure code is invalid/,
  );
});
