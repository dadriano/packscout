import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  createAcceptanceProviderSource,
  createProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";
import { ProviderSourceSupervisorRepository } from
  "./provider-source-supervisor-repository.ts";
import { ProviderSourceSupervisorSnapshotRepository } from
  "./provider-source-supervisor-snapshot-repository.ts";

test("concurrent supervisor snapshot publishes serialize without deadlocking", async () => {
  const harness = await createProviderSourceAcceptanceFixture(
    "concurrent-snapshot-publisher",
  );
  try {
    const source = await createAcceptanceProviderSource(harness, {
      platformKey: "courtyard",
      displayName: "Courtyard",
      mapperKey: "courtyard-provider-observation",
      identityNamespaceKey: "dataforrest-courtyard-records-v1",
      intervalSeconds: 60,
      hashCharacter: "b",
    });
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
          requestPermitLanes: [
            {
              scope: "platform",
              organizationId: harness.organizationId,
              connectionProfileId: harness.connectionProfileId,
              providerId: source.providerId,
              approvedRequestCap: 2,
              activeRequestPermits: index % 2,
              queuedOperations: index,
            },
            {
              scope: "connection_test",
              organizationId: harness.organizationId,
              connectionProfileId: harness.connectionProfileId,
              providerId: null,
              approvedRequestCap: 2,
              activeRequestPermits: 0,
              queuedOperations: 0,
            },
          ],
        },
        admission: { state: "available", safeCode: null },
      })));

    const stored = await harness.database.source_supervisor_epochs
      .findUniqueOrThrow({ where: { id: epoch.epochId } });
    assert.equal(stored.state, "active");
    assert.notEqual(stored.snapshot_updated_at, null);
    const snapshot = await snapshots.read({
      environmentKey: "concurrent-snapshot-publisher",
      organizationId: harness.organizationId,
    });
    assert.equal(snapshot.capacity.requestPermitLanes.length, 2);
    assert.deepEqual(
      new Set(snapshot.capacity.requestPermitLanes.map((lane) => lane.scope)),
      new Set(["platform", "connection_test"]),
    );
    assert.equal(
      snapshot.capacity.requestPermitLanes.find(
        (lane) => lane.scope === "platform",
      )?.providerId,
      source.providerId,
    );

    await snapshots.publish({
      epochId: epoch.epochId,
      ownerKey,
      leaseToken,
      capacity: {
        maximumExecutionSlots: 4,
        activeExecutionSlots: 0,
        requestPermitLanes: [{
          scope: "platform",
          organizationId: harness.organizationId,
          connectionProfileId: harness.connectionProfileId,
          providerId: source.providerId,
          approvedRequestCap: 2,
          activeRequestPermits: 0,
          queuedOperations: 0,
        }],
      },
      admission: { state: "available", safeCode: null },
    });
    const replacedSnapshot = await snapshots.read({
      environmentKey: "concurrent-snapshot-publisher",
      organizationId: harness.organizationId,
    });
    assert.deepEqual(
      replacedSnapshot.capacity.requestPermitLanes.map((lane) => lane.scope),
      ["platform"],
    );
  } finally {
    await harness.close();
  }
});
