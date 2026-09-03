import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CentralPrismaClient } from "./central-database.ts";
import {
  assertProviderActivityEvent,
  providerActivityEventDigest,
  type ProviderActivityEvent,
  type ProviderLocalHealthObservation,
} from "./provider-activity-contract.ts";
import { CentralProviderObservationRepository } from
  "./provider-observation-repository.ts";

const organizationId = "10000000-0000-4000-8000-000000000001";
const localRunId = "10000000-0000-4000-8000-000000000002";
const localQuarantineId = "10000000-0000-4000-8000-000000000003";
const clutchpacksId = "10000000-0000-4000-8000-000000000010";
const courtyardId = "10000000-0000-4000-8000-000000000020";

function repositoryWithResolutions(
  resolutions: readonly (readonly { provider_id: string }[])[],
): CentralProviderObservationRepository {
  let index = 0;
  return new CentralProviderObservationRepository({
    async $queryRaw() {
      return resolutions[index++] ?? [];
    },
  } as unknown as CentralPrismaClient);
}

describe("central provider local-reference routing", () => {
  test("resolves one copied run and quarantine reference", async () => {
    const repository = repositoryWithResolutions([
      [{ provider_id: clutchpacksId }],
      [{ provider_id: courtyardId }],
    ]);

    assert.deepEqual(
      await repository.resolveRunProvider({ organizationId, localRunId }),
      { status: "resolved", providerId: clutchpacksId },
    );
    assert.deepEqual(
      await repository.resolveQuarantineProvider({
        organizationId,
        localQuarantineId,
      }),
      { status: "resolved", providerId: courtyardId },
    );
  });

  test("returns missing without probing a provider database", async () => {
    const repository = repositoryWithResolutions([[]]);
    assert.deepEqual(
      await repository.resolveRunProvider({ organizationId, localRunId }),
      { status: "missing", providerId: null },
    );
  });

  test("fails closed when one local UUID collides across providers", async () => {
    const repository = repositoryWithResolutions([[
      { provider_id: clutchpacksId },
      { provider_id: courtyardId },
    ]]);
    assert.deepEqual(
      await repository.resolveRunProvider({ organizationId, localRunId }),
      { status: "ambiguous", providerId: null },
    );
  });

  test("validates central and local identities before querying", async () => {
    const repository = repositoryWithResolutions([]);
    await assert.rejects(
      repository.resolveRunProvider({ organizationId: "other", localRunId }),
      /Organization ID must be a UUID/,
    );
    await assert.rejects(
      repository.resolveQuarantineProvider({
        organizationId,
        localQuarantineId: "other",
      }),
      /Provider local reference must be a UUID/,
    );
  });
});

describe("provider activity relay contract", () => {
  function activity(): ProviderActivityEvent {
    const values = {
      id: "10000000-0000-4000-8000-000000000030",
      eventType: "provider.run.terminal",
      severity: "info" as const,
      dedupeKey: "run-health",
      recoveryKey: "run-health",
      localRunId,
      localQuarantineId: null,
      title: "Provider run completed",
      summary: "The provider run reached its terminal state.",
      evidence: { runState: "succeeded" },
      eventAt: new Date("2026-08-29T12:00:00.000Z"),
    };
    return {
      ...values,
      eventDigest: providerActivityEventDigest(values),
      deliveryAttemptCount: 0,
      lastFailureCode: null,
    };
  }

  test("binds immutable payload content into the relay digest", () => {
    const event = activity();
    assert.deepEqual(assertProviderActivityEvent(event), event);
    assert.throws(
      () => assertProviderActivityEvent({
        ...event,
        summary: "A changed terminal result.",
      }),
      /digest does not match/,
    );
  });

  test("rejects protected evidence before central persistence", () => {
    const event = activity();
    assert.throws(
      () => providerActivityEventDigest({
        ...event,
        evidence: { failureCode: "postgresql://user:secret@db/packscout" },
      }),
      /unsafe value/,
    );
  });

  test("reachable probe preserves local health and emits recovery only once", async () => {
    const health: ProviderLocalHealthObservation = {
      providerId: clutchpacksId,
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
      observedAt: new Date("2026-08-29T12:00:00.000Z"),
    };
    const states = ["unreachable", "idle"];
    const probeTimes = [
      new Date("2026-08-29T12:01:00.000Z"),
      new Date("2026-08-29T12:02:00.000Z"),
    ];
    const rawValues: unknown[][] = [];
    let recoveryEvents = 0;
    let queryIndex = 0;
    const transaction = {
      providers: { findFirst: () => Promise.resolve({ id: clutchpacksId }) },
      $queryRaw() {
        const clockQuery = queryIndex % 2 === 0;
        queryIndex += 1;
        return Promise.resolve(clockQuery
          ? [{ probed_at: probeTimes.shift() }]
          : [{
              observed_state: states.shift(),
              last_direct_probe_at: null,
            }]);
      },
      $executeRaw(query: { values?: unknown[] }) {
        rawValues.push(query.values ?? []);
        return Promise.resolve(1);
      },
      provider_activity_events: {
        create() {
          recoveryEvents += 1;
          return Promise.resolve({});
        },
      },
    };
    const central = {
      $transaction<T>(operation: (client: typeof transaction) => Promise<T>) {
        return operation(transaction);
      },
    } as unknown as CentralPrismaClient;
    const repository = new CentralProviderObservationRepository(central);

    await repository.observeReachableHealth({
      organizationId,
      providerId: clutchpacksId,
      health,
    });
    await repository.observeReachableHealth({
      organizationId,
      providerId: clutchpacksId,
      health: { ...health, observedAt: new Date("2026-08-29T12:02:00.000Z") },
    });

    assert.equal(recoveryEvents, 1);
    assert.ok(rawValues.flat().includes("idle"));
    assert.ok(rawValues.flat().includes("fresh"));
    assert.ok(rawValues.flat().includes("healthy"));
  });

  test("relay target pages expose a stable cursor for the next bounded cycle", async () => {
    const queries: unknown[] = [];
    const repository = new CentralProviderObservationRepository({
      providers: {
        findMany(query: unknown) {
          queries.push(query);
          return Promise.resolve([{
            organization_id: organizationId,
            id: clutchpacksId,
            provider_key: "clutchpacks",
          }]);
        },
      },
    } as unknown as CentralPrismaClient);

    const page = await repository.listRelayTargets({ limit: 1, after: null });
    assert.deepEqual(page.nextCursor, {
      organizationId,
      providerKey: "clutchpacks",
      providerId: clutchpacksId,
    });
    await repository.listRelayTargets({ limit: 1, after: page.nextCursor });
    assert.match(JSON.stringify(queries[1]), /"gt":"clutchpacks"/u);
    assert.match(JSON.stringify(queries[1]), new RegExp(clutchpacksId, "u"));
  });
});
