import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PrismaEstimatedEvRecomputationRepository,
  estimatedEvRecomputationRequestKey,
  type EstimatedEvRecomputationIdentity,
} from "./estimated-ev-recomputation-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const organizationId = "51000000-0000-4000-8000-000000000001";
const providerId = "51000000-0000-4000-8000-000000000002";
const configurationRevisionId = "51000000-0000-4000-8000-000000000003";

function identity(packExternalId: string): EstimatedEvRecomputationIdentity {
  return {
    organizationId,
    platformKey: "queue-platform",
    packExternalId,
    evInputExternalId: `${packExternalId}:odds`,
    packRevisionId: null,
    evInputRevisionId: null,
  };
}

test("EV workers claim disjoint work, recover leases, and reject stale acknowledgements", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.create({
      data: {
        id: organizationId,
        slug: "estimated-ev-queue",
        name: "Estimated EV Queue",
      },
    });
    await harness.client.provider_sources.create({
      data: {
        id: providerId,
        organization_id: organizationId,
        platform_key: "queue-platform",
        display_name: "Queue Provider",
      },
    });
    await harness.client.provider_config_revisions.create({
      data: {
        id: configurationRevisionId,
        organization_id: organizationId,
        provider_id: providerId,
        version: 1,
        adapter_key: "http-cursor-v1",
        endpoint_url: "https://provider.example/feed",
        auth_mode: "none",
        created_by_actor_key: "actor:test",
      },
    });
    const firstIdentity = identity("pack-1");
    const secondIdentity = identity("pack-2");
    const availableAt = new Date("2026-08-06T12:00:00.000Z");
    await harness.client.estimated_ev_recomputation_requests.createMany({
      data: [
        {
          id: "51000000-0000-4000-8000-000000000011",
          request_key: estimatedEvRecomputationRequestKey(firstIdentity),
          organization_id: organizationId,
          provider_id: providerId,
          configuration_revision_id: configurationRevisionId,
          platform_key: firstIdentity.platformKey,
          pack_external_id: firstIdentity.packExternalId,
          ev_input_external_id: firstIdentity.evInputExternalId,
          available_at: availableAt,
          created_at: availableAt,
          updated_at: availableAt,
        },
        {
          id: "51000000-0000-4000-8000-000000000012",
          request_key: estimatedEvRecomputationRequestKey(secondIdentity),
          organization_id: organizationId,
          provider_id: providerId,
          configuration_revision_id: configurationRevisionId,
          platform_key: secondIdentity.platformKey,
          pack_external_id: secondIdentity.packExternalId,
          ev_input_external_id: secondIdentity.evInputExternalId,
          available_at: availableAt,
          created_at: new Date("2026-08-06T12:00:00.001Z"),
          updated_at: availableAt,
        },
      ],
    });

    const independentClient = await harness.createIndependentClient();
    const firstQueue = new PrismaEstimatedEvRecomputationRepository(
      harness.client,
    );
    const secondQueue = new PrismaEstimatedEvRecomputationRepository(
      independentClient,
    );
    const claimedAt = new Date("2026-08-06T12:00:01.000Z");
    const [left, right] = await Promise.all([
      firstQueue.claimBatch({
        workerId: "ev-worker-a",
        now: claimedAt,
        limit: 1,
        leaseMilliseconds: 1_000,
      }),
      secondQueue.claimBatch({
        workerId: "ev-worker-b",
        now: claimedAt,
        limit: 1,
        leaseMilliseconds: 1_000,
      }),
    ]);
    const claims = [...left, ...right];
    assert.equal(claims.length, 2);
    assert.equal(new Set(claims.map(({ id }) => id)).size, 2);
    assert.equal(new Set(claims.map(({ claimToken }) => claimToken)).size, 2);
    assert.ok(claims.every(({ attemptCount }) => attemptCount === 1));

    const crashed = claims.find(
      ({ id }) => id === "51000000-0000-4000-8000-000000000011",
    );
    const terminal = claims.find(({ id }) => id !== crashed?.id);
    assert.ok(crashed);
    assert.ok(terminal);
    if (!crashed || !terminal) throw new Error("Expected both EV claims.");
    assert.equal(
      await firstQueue.recordFailure({
        requestId: terminal.id,
        claimToken: terminal.claimToken,
        failedAt: new Date("2026-08-06T12:00:01.500Z"),
        retryAt: new Date("2026-08-06T12:00:03.000Z"),
        failureCode: "TERMINAL_TEST_FAILURE",
        maximumAttempts: 1,
      }),
      "failed",
    );

    const [recovered] = await secondQueue.claimBatch({
      workerId: "ev-worker-recovery",
      now: new Date("2026-08-06T12:00:02.000Z"),
      limit: 1,
      leaseMilliseconds: 1_000,
    });
    assert.equal(recovered?.id, crashed.id);
    assert.equal(recovered?.attemptCount, 2);
    assert.notEqual(recovered?.claimToken, crashed.claimToken);
    if (!recovered) throw new Error("Expected the expired EV claim to recover.");

    assert.equal(
      await firstQueue.complete({
        requestId: crashed.id,
        claimToken: crashed.claimToken,
        completedAt: new Date("2026-08-06T12:00:02.100Z"),
        resultStatus: "estimated",
        calculationRevisionId: "51000000-0000-4000-8000-000000000099",
      }),
      false,
    );
    const retryAt = new Date("2026-08-06T12:00:05.000Z");
    assert.equal(
      await secondQueue.recordFailure({
        requestId: crashed.id,
        claimToken: crashed.claimToken,
        failedAt: new Date("2026-08-06T12:00:02.200Z"),
        retryAt,
        failureCode: "STALE_FAILURE",
        maximumAttempts: 3,
      }),
      "lost",
    );
    assert.equal(
      await secondQueue.recordFailure({
        requestId: recovered.id,
        claimToken: recovered.claimToken,
        failedAt: new Date("2026-08-06T12:00:02.300Z"),
        retryAt,
        failureCode: "TRANSIENT_TEST_FAILURE",
        maximumAttempts: 3,
      }),
      "retrying",
    );
    assert.equal(
      (
        await firstQueue.claimBatch({
          workerId: "ev-worker-early",
          now: new Date("2026-08-06T12:00:04.999Z"),
          limit: 1,
          leaseMilliseconds: 1_000,
        })
      ).length,
      0,
    );
    const [retried] = await firstQueue.claimBatch({
      workerId: "ev-worker-final",
      now: retryAt,
      limit: 1,
      leaseMilliseconds: 1_000,
    });
    assert.equal(retried?.id, crashed.id);
    assert.equal(retried?.attemptCount, 3);
    if (!retried) throw new Error("Expected the queued EV retry.");
    assert.equal(
      await firstQueue.recordFailure({
        requestId: retried.id,
        claimToken: retried.claimToken,
        failedAt: retryAt,
        retryAt: new Date("2026-08-06T12:00:06.000Z"),
        failureCode: "TERMINAL_TEST_FAILURE",
        maximumAttempts: 3,
      }),
      "failed",
    );

    const stored = await harness.client.estimated_ev_recomputation_requests.findUniqueOrThrow({
      where: { id: crashed.id },
    });
    assert.equal(stored.state, "failed");
    assert.equal(stored.attempt_count, 3);
    assert.equal(stored.result_status, null);
    assert.equal(stored.calculation_revision_id, null);
  } finally {
    await harness.close();
  }
});
