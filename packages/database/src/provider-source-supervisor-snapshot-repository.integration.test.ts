import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { ProviderSourceSupervisorRepository } from
  "./provider-source-supervisor-repository.ts";
import { ProviderSourceSupervisorSnapshotRepository } from
  "./provider-source-supervisor-snapshot-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

test("concurrent supervisor snapshot publishes serialize without deadlocking", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const clock = await harness.database.$queryRaw<Array<{ now: Date }>>`
      select clock_timestamp() as "now"
    `;
    const ownerKey = "concurrent-snapshot-publisher";
    const leaseToken = randomUUID();
    const epoch = await new ProviderSourceSupervisorRepository(
      harness.database,
    ).acquire({
      environmentKey: "concurrent-snapshot-publisher",
      ownerKey,
      leaseToken,
      now: clock[0]!.now,
    });
    const snapshots = new ProviderSourceSupervisorSnapshotRepository(
      harness.database,
    );

    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      snapshots.publish({
        epochId: epoch.epochId,
        ownerKey,
        leaseToken,
        capacity: {
          maximumExecutionSlots: 4,
          activeExecutionSlots: index % 4,
          profiles: [],
        },
        admission: { state: "available", safeCode: null },
      })));

    const stored = await harness.database.source_supervisor_epochs
      .findUniqueOrThrow({ where: { id: epoch.epochId } });
    assert.equal(stored.state, "active");
    assert.notEqual(stored.snapshot_updated_at, null);
  } finally {
    await harness.close();
  }
});
