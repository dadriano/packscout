import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type BoundedProviderDatabaseGateway,
  providerActivityEventDigest,
  type ProviderActivityEvent,
  type ProviderActivityRelayTarget,
  type ProviderLocalHealthObservation,
} from "@packscout/database";
import {
  GatewayProviderActivityLocalStore,
  ProviderActivityRelayCoordinator,
  type ProviderActivityLocalStore,
  type ProviderActivityRelayDirectory,
  type ProviderActivityRelayObservability,
} from "./provider-activity-relay.ts";

const organizationId = "71000000-0000-4000-8000-000000000001";
const providerA: ProviderActivityRelayTarget = {
  organizationId,
  providerId: "71000000-0000-4000-8000-000000000002",
  providerKey: "provider_a",
};
const providerB: ProviderActivityRelayTarget = {
  organizationId,
  providerId: "71000000-0000-4000-8000-000000000003",
  providerKey: "provider_b",
};
const observedAt = new Date("2026-08-29T12:00:00.000Z");

function health(providerId: string): ProviderLocalHealthObservation {
  return {
    providerId,
    observedState: "idle",
    freshnessState: "fresh",
    qualityState: "healthy",
    consecutiveFailures: 0,
    openQuarantineCount: 0,
    lastAttemptedAt: null,
    lastHeadReachedAt: null,
    recoveredAt: null,
    lastRunnerHeartbeatAt: null,
    latestFailureCode: null,
    recoveryHint: "No recovery action required.",
    publicationLag: 0n,
    observedAt,
  };
}

function activity(): ProviderActivityEvent {
  const identity = {
    id: "71000000-0000-4000-8000-000000000004",
    eventType: "provider.run.terminal",
    severity: "critical" as const,
    dedupeKey: "run:71000000-0000-4000-8000-000000000005",
    recoveryKey: "run:71000000-0000-4000-8000-000000000005",
    localRunId: "71000000-0000-4000-8000-000000000005",
    localQuarantineId: null,
    title: "Provider run failed",
    summary: "The provider run ended with a bounded failure.",
    evidence: { runState: "failed", failureCode: "SOURCE_FAILED" },
    eventAt: observedAt,
  } as const;
  return {
    ...identity,
    eventDigest: providerActivityEventDigest(identity),
    deliveryAttemptCount: 0,
    lastFailureCode: null,
  };
}

test("an unreachable provider is isolated while another outbox delivers", async () => {
  const calls: string[] = [];
  const logs: Parameters<ProviderActivityRelayObservability["log"]>[0][] = [];
  const event = activity();
  const directory: ProviderActivityRelayDirectory = {
    listRelayTargets: () => Promise.resolve({
      targets: [providerA, providerB],
      nextCursor: null,
    }),
    observeReachableHealth(input) {
      calls.push(`reachable-health:${input.providerId}`);
      return Promise.resolve();
    },
    acceptProviderActivity(input) {
      calls.push(`accept:${input.providerId}`);
      return Promise.resolve({ state: "accepted" });
    },
    recordDirectProbe(input) {
      calls.push(`probe:${input.providerId}:${input.state}`);
      return Promise.resolve();
    },
  };
  const local: ProviderActivityLocalStore = {
    read(input) {
      return Promise.resolve(input.providerId === providerA.providerId
        ? {
            state: "unreachable" as const,
            failureCode: "DATABASE_UNREACHABLE",
            retryHint: "Retry the bounded provider connection.",
            observedAt,
          }
        : {
            state: "reachable" as const,
            batch: {
              providerId: providerB.providerId,
              health: health(providerB.providerId),
              events: [event],
            },
          });
    },
    markDelivered(target) {
      calls.push(`delivered:${target.providerId}`);
      return Promise.resolve();
    },
    markFailed: () => Promise.resolve(),
  };
  const result = await new ProviderActivityRelayCoordinator({
    directory,
    local,
    clock: () => new Date("2026-08-29T12:01:00.000Z"),
    baseBackoffMilliseconds: 100,
    observability: { log: (entry) => void logs.push(entry) },
  }).runCycle();

  assert.deepEqual(result, {
    providers: 2,
    delivered: 1,
    deduplicated: 0,
    unreachable: 1,
    failures: 0,
    backpressured: 0,
  });
  assert.ok(calls.includes(`probe:${providerA.providerId}:unreachable`));
  assert.ok(calls.includes(`accept:${providerB.providerId}`));
  assert.ok(
    calls.includes(`reachable-health:${providerB.providerId}`),
  );
  assert.ok(!calls.includes(`probe:${providerB.providerId}:reachable`));
  assert.doesNotMatch(JSON.stringify(logs), /password|postgresql:\/\//iu);
});

test("central failure keeps an event pending, backs off, then deduplicates", async () => {
  let clock = new Date("2026-08-29T12:00:00.000Z");
  let attempts = 0;
  const marks: string[] = [];
  const output: unknown[] = [];
  const event = activity();
  const relay = new ProviderActivityRelayCoordinator({
    directory: {
      listRelayTargets: () => Promise.resolve({
        targets: [providerB],
        nextCursor: null,
      }),
      observeReachableHealth: () => Promise.resolve(),
      recordDirectProbe: () => Promise.resolve(),
      async acceptProviderActivity() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("postgresql://observer:secret@central/packscout");
        }
        return { state: "deduplicated" };
      },
    },
    local: {
      read: () => Promise.resolve({
        state: "reachable",
        batch: {
          providerId: providerB.providerId,
          health: health(providerB.providerId),
          events: [event],
        },
      }),
      markDelivered: () => {
        marks.push("delivered");
        return Promise.resolve();
      },
      markFailed: () => {
        marks.push("failed");
        return Promise.resolve();
      },
    },
    baseBackoffMilliseconds: 100,
    clock: () => new Date(clock),
    observability: { log: (entry) => void output.push(entry) },
  });

  assert.equal((await relay.runCycle()).failures, 1);
  assert.deepEqual(marks, ["failed"]);
  assert.equal((await relay.runCycle()).backpressured, 1);
  clock = new Date(clock.getTime() + 101);
  assert.equal((await relay.runCycle()).deduplicated, 1);
  assert.deepEqual(marks, ["failed", "delivered"]);
  assert.doesNotMatch(JSON.stringify(output), /secret|postgresql:\/\//iu);
});

test("reachable observations preserve provider health through one atomic call", async () => {
  const observations: ProviderLocalHealthObservation[] = [];
  const relay = new ProviderActivityRelayCoordinator({
    directory: {
      listRelayTargets: () => Promise.resolve({
        targets: [providerB],
        nextCursor: null,
      }),
      observeReachableHealth(input) {
        observations.push(input.health);
        return Promise.resolve();
      },
      recordDirectProbe() {
        throw new Error("reachable probes must not overwrite provider health");
      },
      acceptProviderActivity: () => Promise.resolve({ state: "accepted" }),
    },
    local: {
      read: () => Promise.resolve({
        state: "reachable",
        batch: {
          providerId: providerB.providerId,
          health: health(providerB.providerId),
          events: [],
        },
      }),
      markDelivered: () => Promise.resolve(),
      markFailed: () => Promise.resolve(),
    },
    clock: () => new Date("2026-08-29T12:01:00.000Z"),
  });

  assert.equal((await relay.runCycle()).failures, 0);
  assert.equal((await relay.runCycle()).failures, 0);
  assert.equal(observations.length, 2);
  assert.deepEqual(observations[1], health(providerB.providerId));
});

test("relay rotates a bounded cursor so targets beyond the limit are visited", async () => {
  const targets = Array.from({ length: 5 }, (_, index) => ({
    organizationId,
    providerId: `71000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
    providerKey: `provider_${index}`,
  }));
  const visited: string[] = [];
  const relay = new ProviderActivityRelayCoordinator({
    directory: {
      listRelayTargets({ limit, after }) {
        const start = after === null
          ? 0
          : targets.findIndex((target) => target.providerId === after.providerId) + 1;
        const page = targets.slice(start, start + limit);
        const last = page.at(-1);
        return Promise.resolve({
          targets: page,
          nextCursor: page.length < limit || last === undefined
            ? null
            : {
                organizationId: last.organizationId,
                providerKey: last.providerKey,
                providerId: last.providerId,
              },
        });
      },
      observeReachableHealth: () => Promise.resolve(),
      acceptProviderActivity: () => Promise.resolve({ state: "accepted" }),
      recordDirectProbe: () => Promise.resolve(),
    },
    local: {
      read(input) {
        visited.push(input.providerId);
        return Promise.resolve({
          state: "reachable",
          batch: {
            providerId: input.providerId,
            health: health(input.providerId),
            events: [],
          },
        });
      },
      markDelivered: () => Promise.resolve(),
      markFailed: () => Promise.resolve(),
    },
    maximumProviders: 2,
  });

  await relay.runCycle();
  await relay.runCycle();
  await relay.runCycle();
  assert.deepEqual(visited, targets.map((target) => target.providerId));
});

test("provider outboxes use the validated admin route so disabled lanes drain", async () => {
  let adminCalls = 0;
  const gateway = {
    runWithProviderDatabase() {
      throw new Error("active-only provider route must not be used");
    },
    runWithAdminProviderDatabase() {
      adminCalls += 1;
      return Promise.resolve({
        state: "reachable" as const,
        providerId: providerB.providerId,
        value: adminCalls === 1
          ? {
              providerId: providerB.providerId,
              health: health(providerB.providerId),
              events: [],
            }
          : "already_delivered",
        observedAt: observedAt.toISOString(),
      });
    },
  } as unknown as BoundedProviderDatabaseGateway;
  const local = new GatewayProviderActivityLocalStore(gateway);

  assert.equal((await local.read({ ...providerB, limit: 1 })).state, "reachable");
  await local.markDelivered(providerB, activity(), observedAt);
  await local.markFailed(providerB, activity(), observedAt, "CENTRAL_UNAVAILABLE");
  assert.equal(adminCalls, 3);
});
