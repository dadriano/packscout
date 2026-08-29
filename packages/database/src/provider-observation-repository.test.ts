import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { CentralPrismaClient } from "./central-database.ts";
import {
  assertProviderActivityEvent,
  providerActivityEventDigest,
  type ProviderActivityEvent,
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
});
