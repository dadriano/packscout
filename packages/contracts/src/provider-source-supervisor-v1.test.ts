import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_SOURCE_SUPERVISOR_SNAPSHOT_VERSION,
  providerSourceRunBounds,
  providerSourceSupervisorSnapshotSchema,
  providerSourceSupervisorWaitReasons,
  providerSourceTransientRetryPolicy,
} from "./provider-source-supervisor-v1.ts";

test("supervisor launch and source retry bounds are frozen", () => {
  assert.deepEqual(providerSourceRunBounds, {
    maximumCommittedPages: 1_000,
    maximumElapsedMilliseconds: 900_000,
  });
  assert.deepEqual(providerSourceTransientRetryPolicy, {
    maximumAttempts: 3,
    backoffMilliseconds: [1_000, 5_000, 15_000],
  });
  assert.equal(Object.isFrozen(providerSourceRunBounds), true);
  assert.equal(Object.isFrozen(providerSourceTransientRetryPolicy), true);
  assert.deepEqual(providerSourceSupervisorWaitReasons, [
    "not_due",
    "request_lane_capacity",
    "execution_capacity",
    "capacity_blocked",
    "connection_blocked",
    "paused",
    "retry_backoff",
    "action_required",
    "supervisor_offline",
    "graceful_shutdown",
    "source_lane_busy",
  ]);
});

test("the durable snapshot contract rejects inferred or inconsistent lane state", () => {
  const base = {
    version: PROVIDER_SOURCE_SUPERVISOR_SNAPSHOT_VERSION,
    presence: {
      state: "offline",
      environmentKey: "local",
      databaseTime: "2026-08-21T12:00:00.000Z",
      epochId: null,
      epochNumber: null,
      ownerKey: null,
      lastRenewedAt: null,
      leaseExpiresAt: null,
      safeTakeoverAt: null,
      safeReasonCode: null,
    },
    capacity: {
      state: "available",
      safeCode: null,
      checkedAt: null,
      executionSlots: { used: 0, maximum: 4 },
      requestPermitLanes: [
        {
          scope: "platform",
          organizationId: "54000000-0000-4000-8000-000000000001",
          connectionProfileId: "54000000-0000-4000-8000-000000000005",
          providerId: "54000000-0000-4000-8000-000000000002",
          used: 0,
          maximum: 2,
          waiting: 0,
        },
        {
          scope: "connection_test",
          organizationId: "54000000-0000-4000-8000-000000000001",
          connectionProfileId: "54000000-0000-4000-8000-000000000005",
          providerId: null,
          used: 0,
          maximum: 2,
          waiting: 0,
        },
      ],
    },
    sources: [{
      organizationId: "54000000-0000-4000-8000-000000000001",
      providerId: "54000000-0000-4000-8000-000000000002",
      provider: "courtyard",
      sourceInstanceId: "54000000-0000-4000-8000-000000000003",
      sourceRevisionId: "54000000-0000-4000-8000-000000000004",
      connectionProfileId: "54000000-0000-4000-8000-000000000005",
      connectionRevisionId: "54000000-0000-4000-8000-000000000006",
      sourceTypeKey: "fixture-source-v1",
      sourceAdapterVersion: "v1",
      normalizedContractVersion: "normalized-v1",
      mapperKey: "courtyard",
      mapperVersion: "v1",
      identityNamespaceKey: "fixture-identities-v1",
      cursorCodecVersion: "fixture-cursor-v1",
      cursorGeneration: "1",
      lifecycle: "active",
      phase: "idle",
      activity: "inactive",
      waitReason: null,
      actionRequiredCode: null,
      currentRunId: null,
      runLeaseAgeMilliseconds: null,
      retry: { attempt: 0, notBefore: null },
      progress: {
        pagesCommitted: 0,
        recordsCommitted: 0,
        lastProgressAt: null,
      },
      cursorFingerprint: null,
      continuation: null,
      nextDueAt: null,
      connectionEpisode: null,
    }],
  } as const;

  assert.equal(providerSourceSupervisorSnapshotSchema.safeParse(base).success, true);
  assert.equal(
    providerSourceSupervisorSnapshotSchema.safeParse({
      ...base,
      capacity: {
        ...base.capacity,
        requestPermitLanes: [{
          ...base.capacity.requestPermitLanes[0],
          providerId: null,
        }],
      },
    }).success,
    false,
  );
  assert.equal(
    providerSourceSupervisorSnapshotSchema.safeParse({
      ...base,
      capacity: {
        ...base.capacity,
        requestPermitLanes: [{
          ...base.capacity.requestPermitLanes[0],
          maximum: 3,
        }],
      },
    }).success,
    false,
  );
  assert.equal(
    providerSourceSupervisorSnapshotSchema.safeParse({
      ...base,
      capacity: {
        ...base.capacity,
        requestPermitLanes: [{
          ...base.capacity.requestPermitLanes[0],
          profileCapacity: 2,
        }],
      },
    }).success,
    false,
  );
  assert.equal(
    providerSourceSupervisorSnapshotSchema.safeParse({
      ...base,
      capacity: {
        ...base.capacity,
        requestPermitLanes: [{
          ...base.capacity.requestPermitLanes[1],
          providerId: "54000000-0000-4000-8000-000000000002",
        }],
      },
    }).success,
    false,
  );
  assert.equal(
    providerSourceSupervisorSnapshotSchema.safeParse({
      ...base,
      capacity: {
        ...base.capacity,
        requestPermitLanes: [{
          ...base.capacity.requestPermitLanes[0],
          used: 3,
        }],
      },
    }).success,
    false,
  );
  assert.equal(
    providerSourceSupervisorSnapshotSchema.safeParse({
      ...base,
      sources: [{
        ...base.sources[0],
        activity: "waiting",
        waitReason: null,
      }],
    }).success,
    false,
  );
  assert.equal(
    providerSourceSupervisorSnapshotSchema.safeParse({
      ...base,
      sources: [{ ...base.sources[0], cursorGeneration: "0" }],
    }).success,
    false,
  );
});
