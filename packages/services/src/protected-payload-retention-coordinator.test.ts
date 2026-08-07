import assert from "node:assert/strict";
import { test } from "node:test";
import type { RetentionBatchResult } from "@packscout/contracts";
import {
  ProtectedPayloadRetentionCoordinator,
  type ProtectedPayloadRetentionRunner,
} from "./protected-payload-retention-coordinator.ts";

const organizations = [
  "77000000-0000-4000-8000-000000000001",
  "77000000-0000-4000-8000-000000000002",
] as const;
const now = new Date("2026-11-05T12:00:00.000Z");

function batch(
  executionId: string,
  overrides: Partial<RetentionBatchResult> = {},
): RetentionBatchResult {
  return {
    executionId,
    selected: 1,
    expired: 1,
    alreadyExpired: 0,
    failed: 0,
    remaining: 0,
    pagesExpired: 1,
    sourceRecordsExpired: 0,
    quarantinesExpired: 0,
    startedAt: now.toISOString(),
    finishedAt: now.toISOString(),
    durationMs: 0,
    replayed: false,
    ...overrides,
  };
}

function idSource() {
  let value = 0;
  return {
    id: () =>
      `78000000-0000-4000-8000-${String(++value).padStart(12, "0")}`,
  };
}

test("a cycle round-robins due tenants with fresh execution IDs until drained", async () => {
  const calls: Parameters<ProtectedPayloadRetentionRunner["run"]>[0][] = [];
  const perTenantCalls = new Map<string, number>();
  const coordinator = new ProtectedPayloadRetentionCoordinator(
    {
      async discoverEligibleOrganizations(input) {
        assert.deepEqual(input, { cutoffAt: now, limit: 10 });
        return [organizations[0], organizations[1], organizations[0]];
      },
    },
    {
      async run(input) {
        calls.push(input);
        const attempt = (perTenantCalls.get(input.organizationId) ?? 0) + 1;
        perTenantCalls.set(input.organizationId, attempt);
        return batch(input.executionId, {
          remaining: input.organizationId === organizations[0] && attempt === 1 ? 1 : 0,
        });
      },
    },
    idSource(),
    { now: () => new Date(now) },
    {
      batchSize: 25,
      maxBatchesPerCycle: 5,
      organizationDiscoveryLimit: 10,
    },
  );

  const result = await coordinator.runCycle();

  assert.deepEqual(
    calls.map(({ organizationId }) => organizationId),
    [organizations[0], organizations[1], organizations[0]],
  );
  assert.equal(new Set(calls.map(({ executionId }) => executionId)).size, 3);
  assert.equal(calls.every(({ cutoffAt }) => cutoffAt.getTime() === now.getTime()), true);
  assert.equal(calls.every(({ batchSize }) => batchSize === 25), true);
  assert.deepEqual(result, {
    cutoffAt: now.toISOString(),
    discoveredOrganizations: 2,
    attemptedOrganizations: 2,
    batchesRun: 3,
    expired: 3,
    failed: 0,
    knownRemaining: 0,
    deferredOrganizations: 0,
    capReached: false,
  });
});

test("the cycle cap bounds work and leaves progress discoverable next cycle", async () => {
  const executionIds: string[] = [];
  const coordinator = new ProtectedPayloadRetentionCoordinator(
    { discoverEligibleOrganizations: async () => [organizations[0]] },
    {
      async run(input) {
        executionIds.push(input.executionId);
        return batch(input.executionId, { remaining: 5 });
      },
    },
    idSource(),
    { now: () => new Date(now) },
    {
      batchSize: 1,
      maxBatchesPerCycle: 2,
      organizationDiscoveryLimit: 10,
    },
  );

  const first = await coordinator.runCycle();
  const second = await coordinator.runCycle();

  assert.equal(first.batchesRun, 2);
  assert.equal(first.capReached, true);
  assert.equal(first.deferredOrganizations, 1);
  assert.equal(second.batchesRun, 2);
  assert.equal(new Set(executionIds).size, 4);
});

test("no-progress and failed batches stop safely without spinning", async () => {
  let calls = 0;
  const noProgress = new ProtectedPayloadRetentionCoordinator(
    { discoverEligibleOrganizations: async () => organizations },
    {
      async run(input) {
        calls += 1;
        return input.organizationId === organizations[0]
          ? batch(input.executionId, { selected: 0, expired: 0, remaining: 3 })
          : batch(input.executionId, { failed: 1, expired: 0, remaining: 1 });
      },
    },
    idSource(),
    { now: () => new Date(now) },
    {
      batchSize: 10,
      maxBatchesPerCycle: 10,
      organizationDiscoveryLimit: 10,
    },
  );

  const result = await noProgress.runCycle();

  assert.equal(calls, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.knownRemaining, 4);
  assert.equal(result.capReached, false);
});

test("a replayed execution is not double-counted or requeued", async () => {
  let calls = 0;
  const coordinator = new ProtectedPayloadRetentionCoordinator(
    { discoverEligibleOrganizations: async () => [organizations[0]] },
    {
      async run(input) {
        calls += 1;
        return batch(input.executionId, {
          selected: 4,
          expired: 4,
          remaining: 2,
          replayed: true,
        });
      },
    },
    idSource(),
    { now: () => new Date(now) },
    {
      batchSize: 10,
      maxBatchesPerCycle: 10,
      organizationDiscoveryLimit: 10,
    },
  );

  const result = await coordinator.runCycle();

  assert.equal(calls, 1);
  assert.equal(result.expired, 0);
  assert.equal(result.knownRemaining, 2);
});

test("invalid cycle bounds fail before discovery", () => {
  assert.throws(
    () =>
      new ProtectedPayloadRetentionCoordinator(
        { discoverEligibleOrganizations: async () => [] },
        { run: async (input) => batch(input.executionId) },
        idSource(),
        { now: () => new Date(now) },
        {
          batchSize: 0,
          maxBatchesPerCycle: 1,
          organizationDiscoveryLimit: 1,
        },
      ),
    /configuration is invalid/,
  );
});
