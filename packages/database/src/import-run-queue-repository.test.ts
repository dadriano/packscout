import assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaImportRunRepository } from "./import-run-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

test("concurrent requests coalesce without changing immutable run evidence", async () => {
  const context = await createMigratedTestDatabase();
  const organizationId = "10000000-0000-4000-8000-000000000002";
  const providerId = "20000000-0000-4000-8000-000000000002";
  const revisionId = "30000000-0000-4000-8000-000000000002";
  const requestedAt = new Date("2026-08-06T11:00:00.000Z");
  const requests = [
    {
      runId: "40000000-0000-4000-8000-000000000002",
      trigger: "manual" as const,
      requestedByActorKey: "actor:manual-request",
    },
    {
      runId: "40000000-0000-4000-8000-000000000003",
      trigger: "scheduled" as const,
      requestedByActorKey: null,
    },
  ];
  try {
    await context.client.organizations.create({
      data: {
        id: organizationId,
        slug: "request-coalescing-test",
        name: "Request coalescing test",
      },
    });
    await context.client.provider_sources.create({
      data: {
        id: providerId,
        organization_id: organizationId,
        platform_key: "request-coalescing-platform",
        display_name: "Request coalescing provider",
      },
    });
    await context.client.provider_config_revisions.create({
      data: {
        id: revisionId,
        organization_id: organizationId,
        provider_id: providerId,
        version: 1,
        adapter_key: "http-cursor-v1",
        endpoint_url: "https://provider.example/feed",
        auth_mode: "none",
        tested_at: new Date("2026-08-06T10:59:00.000Z"),
        tested_by_actor_key: "actor:test",
        created_by_actor_key: "actor:test",
      },
    });
    await context.client.provider_sources.update({
      where: { id: providerId },
      data: { state: "active", active_revision_id: revisionId },
    });
    await context.client.provider_cursor_checkpoints.create({
      data: {
        organization_id: organizationId,
        provider_id: providerId,
        config_revision_id: revisionId,
        cursor: "cursor-before-request",
      },
    });

    const independentClient = await context.createIndependentClient();
    const first = new PrismaImportRunRepository(context.client);
    const second = new PrismaImportRunRepository(independentClient);
    const results = await Promise.all([
      first.requestRun({
        organizationId,
        providerId,
        ...requests[0],
        requestedAt,
        expectedConfigurationRevisionId: revisionId,
      }),
      second.requestRun({
        organizationId,
        providerId,
        ...requests[1],
        requestedAt,
        expectedConfigurationRevisionId: revisionId,
      }),
    ]);
    assert.equal(results.filter(({ kind }) => kind === "created").length, 1);
    assert.equal(results.filter(({ kind }) => kind === "active").length, 1);
    const created = results.find(({ kind }) => kind === "created");
    const active = results.find(({ kind }) => kind === "active");
    if (created?.kind !== "created" || active?.kind !== "active") {
      throw new Error("Expected one created and one coalesced request.");
    }
    assert.equal(active.run.id, created.run.id);
    const request = requests.find(({ runId }) => runId === created.run.id);
    assert.ok(request);
    const stored = await context.client.import_runs.findUniqueOrThrow({
      where: { id: created.run.id },
    });
    assert.equal(stored.config_revision_id, revisionId);
    assert.equal(stored.trigger, request?.trigger);
    assert.equal(stored.requested_by_actor_key, request?.requestedByActorKey);
    assert.equal(stored.requested_cursor, "cursor-before-request");
    assert.equal(await context.client.import_runs.count(), 1);
    assert.equal(await context.client.audit_events.count(), 1);

    assert.deepEqual(
      await first.requestRun({
        organizationId,
        providerId,
        runId: "40000000-0000-4000-8000-000000000004",
        trigger: "manual",
        requestedByActorKey: "actor:conflict",
        requestedAt: new Date("2026-08-06T11:01:00.000Z"),
        expectedConfigurationRevisionId:
          "30000000-0000-4000-8000-000000000099",
      }),
      {
        kind: "revision_conflict",
        activeConfigurationRevisionId: revisionId,
      },
    );
    await context.client.provider_sources.update({
      where: { id: providerId },
      data: { state: "disabled" },
    });
    assert.deepEqual(
      await second.requestRun({
        organizationId,
        providerId,
        runId: "40000000-0000-4000-8000-000000000005",
        trigger: "scheduled",
        requestedByActorKey: null,
        requestedAt: new Date("2026-08-06T11:02:00.000Z"),
      }),
      { kind: "provider_unavailable" },
    );
    const claimed = await second.claimRun({
      organizationId,
      runId: created.run.id,
      workerId: "worker-existing-owner",
      claimedAt: new Date("2026-08-06T11:03:00.000Z"),
      leaseExpiresAt: new Date("2026-08-06T11:04:00.000Z"),
    });
    assert.equal(claimed.kind, "claimed");
  } finally {
    await context.close();
  }
});

test("queued manual runs have one durable owner and recover after lease expiry", async () => {
  const context = await createMigratedTestDatabase();
  const organizationId = "10000000-0000-4000-8000-000000000001";
  const providerId = "20000000-0000-4000-8000-000000000001";
  const revisionId = "30000000-0000-4000-8000-000000000001";
  const runId = "40000000-0000-4000-8000-000000000001";
  const requestedAt = new Date("2026-08-06T12:00:00.000Z");
  try {
    await context.client.organizations.create({
      data: {
        id: organizationId,
        slug: "manual-queue-test",
        name: "Manual queue test",
      },
    });
    await context.client.provider_sources.create({
      data: {
        id: providerId,
        organization_id: organizationId,
        platform_key: "manual-queue-platform",
        display_name: "Manual queue provider",
      },
    });
    await context.client.provider_config_revisions.create({
      data: {
        id: revisionId,
        organization_id: organizationId,
        provider_id: providerId,
        version: 1,
        adapter_key: "http-cursor-v1",
        endpoint_url: "https://provider.example/feed",
        auth_mode: "none",
        schedule_seconds: 300,
        stale_after_seconds: 900,
        created_by_actor_key: "actor:test",
      },
    });
    await context.client.import_runs.create({
      data: {
        id: runId,
        organization_id: organizationId,
        provider_id: providerId,
        config_revision_id: revisionId,
        trigger: "manual",
        requested_by_actor_key: "actor:manual-request",
        state: "queued",
        created_at: requestedAt,
      },
    });
    const independentClient = await context.createIndependentClient();
    const firstRepository = new PrismaImportRunRepository(context.client);
    const secondRepository = new PrismaImportRunRepository(independentClient);
    const claimedAt = new Date("2026-08-06T12:00:01.000Z");
    const leaseExpiresAt = new Date("2026-08-06T12:02:01.000Z");
    const raced = await Promise.all([
      firstRepository.claimNextRun({
        workerId: "worker-a",
        claimedAt,
        leaseExpiresAt,
      }),
      secondRepository.claimNextRun({
        workerId: "worker-b",
        claimedAt,
        leaseExpiresAt,
      }),
    ]);

    const claimed = raced.find((result) => result.kind === "claimed");
    assert.equal(
      raced.filter((result) => result.kind === "claimed").length,
      1,
    );
    assert.equal(raced.filter((result) => result.kind === "idle").length, 1);
    assert.equal(claimed?.kind, "claimed");
    if (claimed?.kind !== "claimed") throw new Error("Run was not claimed.");
    assert.equal(claimed.run.id, runId);
    assert.equal(claimed.run.organizationId, organizationId);
    assert.equal(claimed.run.trigger, "manual");

    const recovered = await secondRepository.claimNextRun({
      workerId: "worker-recovery",
      claimedAt: leaseExpiresAt,
      leaseExpiresAt: new Date("2026-08-06T12:04:01.000Z"),
    });
    assert.equal(recovered.kind, "claimed");
    if (recovered.kind !== "claimed") throw new Error("Run was not recovered.");
    assert.equal(recovered.run.id, runId);
    assert.equal(recovered.run.workerId, "worker-recovery");

    assert.equal(
      await firstRepository.renewLease({
        organizationId,
        runId,
        workerId: claimed.run.workerId,
        renewedAt: new Date("2026-08-06T12:02:02.000Z"),
        leaseExpiresAt: new Date("2026-08-06T12:05:02.000Z"),
      }),
      false,
    );
    assert.deepEqual(
      await Promise.all([
        firstRepository.recordRequestAttempt({
          organizationId,
          runId,
          workerId: "worker-recovery",
          transientRetry: false,
        }),
        secondRepository.recordRequestAttempt({
          organizationId,
          runId,
          workerId: "worker-recovery",
          transientRetry: true,
        }),
      ]),
      [true, true],
    );
    assert.equal(
      (
        await firstRepository.finishRun({
          organizationId,
          runId,
          workerId: claimed.run.workerId,
          state: "succeeded",
          reachedProviderHead: true,
          failureCode: null,
          failureSummary: null,
          finishedAt: new Date("2026-08-06T12:02:03.000Z"),
        })
      ).kind,
      "ownership_lost",
    );
    const finished = await secondRepository.finishRun({
      organizationId,
      runId,
      workerId: "worker-recovery",
      state: "succeeded",
      reachedProviderHead: true,
      failureCode: null,
      failureSummary: null,
      finishedAt: new Date("2026-08-06T12:02:04.000Z"),
    });
    assert.equal(finished.kind, "finished");
    if (finished.kind !== "finished") throw new Error("Run did not finish.");
    assert.equal(finished.run.counters.requestAttempts, 2);
    assert.equal(finished.run.counters.transientRetries, 1);

    const stored = await context.client.import_runs.findUniqueOrThrow({
      where: { id: runId },
      select: {
        attempt: true,
        requested_by_actor_key: true,
        config_revision_id: true,
      },
    });
    assert.equal(stored.attempt, 2);
    assert.equal(stored.requested_by_actor_key, "actor:manual-request");
    assert.equal(stored.config_revision_id, revisionId);
  } finally {
    await context.close();
  }
});
