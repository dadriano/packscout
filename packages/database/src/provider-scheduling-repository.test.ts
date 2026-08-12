import assert from "node:assert/strict";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import {
  DrizzleProviderScheduleRepository,
  projectProviderRunHealth,
} from "./provider-scheduling-repository.ts";
import {
  organizations,
  providerConfigRevisions,
  providerSources,
} from "./schema/core.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

test("database claims serialize workers, preserve cadence, and recover expired leases", async () => {
  const context = await createMigratedTestDatabase();
  try {
    const organizationId = "10000000-0000-4000-8000-000000000001";
    const providerId = "20000000-0000-4000-8000-000000000001";
    const revisionId = "30000000-0000-4000-8000-000000000001";
    const dueAt = new Date("2026-08-06T12:00:00.000Z");
    await context.database.insert(organizations).values({
      id: organizationId,
      slug: "scheduler-test",
      name: "Scheduler test",
    });
    await context.database.insert(providerSources).values({
      id: providerId,
      organizationId,
      platformKey: "scheduler-platform",
      displayName: "Scheduler provider",
    });
    await context.database.insert(providerConfigRevisions).values({
      id: revisionId,
      organizationId,
      providerId,
      version: 1,
      adapterKey: "http-cursor-v1",
      endpointUrl: "https://provider.example/feed",
      authMode: "none",
      scheduleSeconds: 300,
      staleAfterSeconds: 900,
      testedAt: new Date("2026-08-06T11:55:00.000Z"),
      testedByActorKey: "actor:test",
      createdByActorKey: "actor:test",
    });
    await context.database
      .update(providerSources)
      .set({
        state: "active",
        activeRevisionId: revisionId,
        nextRunAt: dueAt,
      })
      .where(eq(providerSources.id, providerId));

    const repository = new DrizzleProviderScheduleRepository(context.database);
    const firstClaim = await repository.claimDueProvider({
      workerId: "worker-a",
      now: dueAt,
      leaseExpiresAt: new Date("2026-08-06T12:00:30.000Z"),
    });
    assert.equal(firstClaim?.providerId, providerId);

    const contendingClaim = await repository.claimDueProvider({
      workerId: "worker-b",
      now: new Date("2026-08-06T12:00:10.000Z"),
      leaseExpiresAt: new Date("2026-08-06T12:00:40.000Z"),
    });
    assert.equal(contendingClaim, null);

    const recoveredClaim = await repository.claimDueProvider({
      workerId: "worker-b",
      now: new Date("2026-08-06T12:00:31.000Z"),
      leaseExpiresAt: new Date("2026-08-06T12:01:01.000Z"),
    });
    assert.equal(recoveredClaim?.providerId, providerId);

    const nextDueAt = new Date("2026-08-06T12:05:31.000Z");
    assert.equal(
      await repository.completeClaim({
        workerId: "worker-b",
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
