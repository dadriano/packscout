import assert from "node:assert/strict";
import { test } from "node:test";
import type { PackscoutPrismaClient } from "./database.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { PrismaProviderScheduleRepository } from "./provider-scheduling-repository.ts";
import { PrismaWorkerFleetReadRepository } from "./worker-fleet-read-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

/**
 * Schedule health has to describe what is actually scheduled.
 *
 * `provider_schedules` is claim history: it does not exist until a worker first
 * claims a provider, and nothing removes it when the provider stops being
 * scheduled. Reading it as the register of scheduled work therefore hides the
 * newly enabled provider no worker ever reached — the outage most worth an
 * alert — and keeps reporting one that was disabled long ago.
 */

const organizationId = "9d000000-0000-4000-8000-000000000001";
const providerId = "9d000000-0000-4000-8000-000000000002";
const revisionId = "9d000000-0000-4000-8000-000000000003";
const activatedAt = new Date("2026-08-20T12:00:00.000Z");
const nextRunAt = new Date("2026-08-20T12:05:00.000Z");

async function enabledProvider(
  database: PackscoutPrismaClient,
): Promise<void> {
  const setup = new PipelineSetupRepository(database);
  await setup.createOrganization({
    id: organizationId,
    slug: "fleet-schedules",
    name: "Fleet Schedules",
    createdAt: activatedAt,
  });
  await setup.createProviderSource({
    id: providerId,
    organizationId,
    platformKey: "fanatics",
    displayName: "Fanatics Live",
    createdAt: activatedAt,
  });
  await setup.createConfigRevision({
    id: revisionId,
    organizationId,
    providerId,
    version: 1,
    adapterKey: "fanatics",
    endpointUrl: "https://provider.invalid/feed",
    authMode: "none",
    createdByActorKey: "actor:v1:setup",
    createdAt: activatedAt,
  });
  await setup.recordSuccessfulConnectionTest({
    organizationId,
    providerId,
    revisionId,
    actorKey: "actor:v1:setup",
    testedAt: activatedAt,
    latencyMs: 12,
  });
  await setup.activateConfiguration({
    organizationId,
    providerId,
    revisionId,
    actorKey: "actor:v1:setup",
    activatedAt,
    nextRunAt,
  });
}

test("a provider enabled before any worker claimed it is visible in schedule health", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await enabledProvider(harness.database);

    // Activation only moves the source: no schedule row exists yet, because no
    // worker has claimed this provider even once.
    assert.equal(await harness.database.provider_schedules.count(), 0);

    const page = await new PrismaWorkerFleetReadRepository(
      harness.database,
    ).listSchedules({ organizationId, limit: 50 });

    assert.deepEqual(
      page.items.map((record) => ({
        providerId: record.providerId,
        providerName: record.providerName,
        platformKey: record.platformKey,
        nextDueAt: record.nextDueAt.toISOString(),
        claimOwner: record.claimOwner,
        claimExpiresAt: record.claimExpiresAt,
        lastClaimedAt: record.lastClaimedAt,
        lastOutcome: record.lastOutcome,
        lastRunId: record.lastRunId,
      })),
      [
        {
          providerId,
          providerName: "Fanatics Live",
          platformKey: "fanatics",
          nextDueAt: nextRunAt.toISOString(),
          claimOwner: null,
          claimExpiresAt: null,
          lastClaimedAt: null,
          lastOutcome: null,
          lastRunId: null,
        },
      ],
    );
    assert.equal(page.hasMore, false);
  } finally {
    await harness.close();
  }
});

test("a provider disabled after being claimed leaves schedule health, claim history and all", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await enabledProvider(harness.database);
    const claimedAt = new Date(nextRunAt.getTime() + 1_000);
    const claimed = await new PrismaProviderScheduleRepository(
      harness.database,
    ).claimDueProvider({
      workerId: "worker:alpha:1:8f0a2c2e-6f0a-4a2e-9c31-0a6b2f5d8e11",
      now: claimedAt,
      leaseExpiresAt: new Date(claimedAt.getTime() + 30_000),
    });
    assert.equal(claimed?.providerId, providerId);

    const fleet = new PrismaWorkerFleetReadRepository(harness.database);
    const claimedPage = await fleet.listSchedules({
      organizationId,
      limit: 50,
    });
    assert.equal(claimedPage.items.length, 1);
    assert.equal(
      claimedPage.items[0]?.claimOwner,
      "worker:alpha:1:8f0a2c2e-6f0a-4a2e-9c31-0a6b2f5d8e11",
    );

    // Disabling a provider clears its next run; the schedule row it was claimed
    // through survives, and must not keep the provider on the page.
    await harness.database.provider_sources.update({
      where: { id: providerId },
      data: { state: "disabled", next_run_at: null, updated_at: claimedAt },
    });
    assert.equal(await harness.database.provider_schedules.count(), 1);

    const disabledPage = await fleet.listSchedules({
      organizationId,
      limit: 50,
    });

    assert.deepEqual(disabledPage.items, []);
    assert.equal(disabledPage.hasMore, false);
  } finally {
    await harness.close();
  }
});
