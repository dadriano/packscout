import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson } from "@packscout/contracts";
import { PrismaManifestPromotionRepository } from
  "./manifest-promotion-repository.ts";
import { PrismaProviderPromotionRepository } from
  "./provider-promotion-repository.ts";
import {
  providerPublicationFixture,
  seedPromotionV2AuthoritativeConfiguration,
  seedPromotionV2VerifiedEmptyBootstrap,
} from "./promotion-v2-test-fixtures.ts";
import { promotionV2Sha256 } from "./promotion-v2-types.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const deploymentKey = "promotion-v2-retry-exhaustion";
const base = new Date("2026-08-16T21:00:00.000Z");

function at(milliseconds: number): Date {
  return new Date(base.getTime() + milliseconds);
}

async function seedScope(
  organizationId: string,
  slug: string,
) {
  const harness = await createMigratedTestDatabase();
  await harness.client.organizations.create({
    data: { id: organizationId, slug, name: slug },
  });
  await seedPromotionV2AuthoritativeConfiguration(
    harness, organizationId, ["alpha"], base,
  );
  await seedPromotionV2VerifiedEmptyBootstrap(
    harness, organizationId, deploymentKey, ["alpha"], base,
  );
  return harness;
}

test("provider retry exhaustion forces N+1 only before remote dispatch", async () => {
  const undispatchedOrganization =
    "5a000000-0000-4000-8000-000000000051";
  const undispatched = await seedScope(
    undispatchedOrganization,
    "provider-retry-undispatched",
  );
  try {
    const repository = new PrismaProviderPromotionRepository(
      undispatched.client,
      {
        organizationId: undispatchedOrganization,
        deploymentKey,
        platformKey: "alpha",
      },
    );
    const fixture = await providerPublicationFixture();
    await repository.enqueueEvaluation({
      checkpoint: fixture.checkpoint,
      requestedAt: base,
    });
    const first = await repository.claim({
      workerId: "provider-retry-first",
      now: base,
      leaseExpiresAt: at(60_000),
    });
    assert.ok(first);
    assert.deepEqual(await repository.recordRetryExhaustion({
      attemptId: first.attemptId,
      claimToken: first.claimToken,
      failedAt: at(1_000),
      retryAt: at(61_000),
      failureClass: "technical",
      failureCode: "PROVIDER_RETRY_EXHAUSTED",
    }), { result: "requeued", evaluationSequence: 2n });
    assert.equal((await undispatched.client.provider_promotion_attempts
      .findUniqueOrThrow({ where: { id: first.attemptId } })).state, "failed");
    assert.deepEqual(await repository.enqueueEvaluation({
      checkpoint: fixture.checkpoint,
      requestedAt: at(2_000),
    }), { result: "coalesced", evaluationSequence: 2n });
    const successor = await repository.claim({
      workerId: "provider-retry-successor",
      now: at(2_000),
      leaseExpiresAt: at(62_000),
    });
    assert.equal(successor?.evaluationSequence, 2n);
    const health = await repository.loadHealth({ now: at(3_000) });
    assert.equal(health.confirmedEvaluationSequence, 0n);
    assert.equal(health.requestedEvaluationSequence, 2n);
  } finally {
    await undispatched.close();
  }

  const dispatchedOrganization =
    "5a000000-0000-4000-8000-000000000052";
  const dispatched = await seedScope(
    dispatchedOrganization,
    "provider-retry-dispatched",
  );
  try {
    const repository = new PrismaProviderPromotionRepository(dispatched.client, {
      organizationId: dispatchedOrganization,
      deploymentKey,
      platformKey: "alpha",
    });
    const fixture = await providerPublicationFixture();
    await repository.enqueueEvaluation({
      checkpoint: fixture.checkpoint,
      requestedAt: base,
    });
    const first = await repository.claim({
      workerId: "provider-status-required",
      now: base,
      leaseExpiresAt: at(60_000),
    });
    assert.ok(first);
    await repository.persistPreparedOperations({
      attemptId: first.attemptId,
      claimToken: first.claimToken,
      preparedAt: at(500),
      summary: fixture.summary,
      operations: fixture.operations,
    });
    assert.equal(await repository.markOperationSent({
      attemptId: first.attemptId,
      operationId: fixture.operations[0]!.operationId,
      claimToken: first.claimToken,
      sentAt: at(1_000),
    }), true);
    assert.deepEqual(await repository.recordRetryExhaustion({
      attemptId: first.attemptId,
      claimToken: first.claimToken,
      failedAt: at(2_000),
      retryAt: at(62_000),
      failureClass: "technical",
      failureCode: "PROVIDER_STATUS_REQUIRED",
    }), { result: "status_required", evaluationSequence: 1n });
    assert.equal(await repository.claim({
      workerId: "provider-too-early",
      now: at(61_000),
      leaseExpiresAt: at(121_000),
    }), null);
    const recovery = await repository.claim({
      workerId: "provider-status-recovery",
      now: at(62_000),
      leaseExpiresAt: at(122_000),
    });
    assert.equal(recovery?.attemptId, first.attemptId);
    assert.equal(recovery?.evaluationSequence, 1n);
    assert.equal((await repository.firstUnacknowledgedOperation({
      attemptId: recovery!.attemptId,
      claimToken: recovery!.claimToken,
      now: at(62_500),
    }))?.sendCount, 1);
  } finally {
    await dispatched.close();
  }
});

test("manifest retry exhaustion forces N+1 and preserves dispatched status recovery", async () => {
  for (const [suffix, sent] of [["53", false], ["54", true]] as const) {
    const organizationId =
      `5a000000-0000-4000-8000-0000000000${suffix}`;
    const harness = await seedScope(
      organizationId,
      `manifest-retry-${suffix}`,
    );
    try {
      const repository = new PrismaManifestPromotionRepository(harness.client, {
        organizationId,
        deploymentKey,
      });
      await repository.enqueueEvaluation({
        cause: "observation_succeeded",
        causeIdentity: `manifest-retry-${suffix}`,
        requestedAt: base,
      });
      const first = await repository.claim({
        workerId: `manifest-retry-${suffix}`,
        now: base,
        leaseExpiresAt: at(60_000),
      });
      assert.ok(first);
      if (sent) {
        const requestBody = canonicalJson({ test: "manifest-status-required" });
        const operationId = `manifest:retry:${suffix}`;
        await harness.client.manifest_promotion_operations.create({
          data: {
            attempt_id: first.attemptId,
            organization_id: organizationId,
            deployment_key: deploymentKey,
            operation_index: 0,
            operation_id: operationId,
            operation_kind: "activateManifest",
            request_path: "/production/catalog-manifests/activate",
            canonical_request_body: requestBody,
            request_sha256: promotionV2Sha256(requestBody),
          },
        });
        assert.equal(await repository.markOperationSent({
          attemptId: first.attemptId,
          operationId,
          claimToken: first.claimToken,
          sentAt: at(1_000),
        }), true);
      }
      const exhausted = await repository.recordRetryExhaustion({
        attemptId: first.attemptId,
        claimToken: first.claimToken,
        failedAt: at(2_000),
        retryAt: at(62_000),
        failureClass: "technical",
        failureCode: sent
          ? "MANIFEST_STATUS_REQUIRED" : "MANIFEST_RETRY_EXHAUSTED",
      });
      if (sent) {
        assert.deepEqual(exhausted, {
          result: "status_required",
          evaluationSequence: 1n,
        });
        const recovery = await repository.claim({
          workerId: "manifest-status-recovery",
          now: at(62_000),
          leaseExpiresAt: at(122_000),
        });
        assert.equal(recovery?.attemptId, first.attemptId);
        assert.equal(recovery?.evaluationSequence, 1n);
        assert.equal((await repository.listOperations({
          attemptId: recovery!.attemptId,
        }))[0]?.sendCount, 1);
      } else {
        assert.deepEqual(exhausted, {
          result: "requeued",
          evaluationSequence: 2n,
        });
        assert.equal((await harness.client.manifest_promotion_attempts
          .findUniqueOrThrow({ where: { id: first.attemptId } })).state,
        "failed");
        const successor = await repository.claim({
          workerId: "manifest-retry-successor",
          now: at(3_000),
          leaseExpiresAt: at(63_000),
        });
        assert.equal(successor?.evaluationSequence, 2n);
        const health = await repository.loadHealth({ now: at(4_000) });
        assert.equal(health.confirmedEvaluationSequence, 0n);
        assert.equal(health.requestedEvaluationSequence, 2n);
      }
    } finally {
      await harness.close();
    }
  }
});

test("proof drift requeues zero-send exhaustion but preserves sent status recovery", async () => {
  for (const [suffix, sent] of [["55", false], ["56", true]] as const) {
    const organizationId =
      `5a000000-0000-4000-8000-0000000000${suffix}`;
    const harness = await seedScope(
      organizationId, `proof-drift-exhaustion-${suffix}`,
    );
    try {
      const provider = new PrismaProviderPromotionRepository(harness.client, {
        organizationId,
        deploymentKey,
        platformKey: "alpha",
      });
      const manifest = new PrismaManifestPromotionRepository(harness.client, {
        organizationId,
        deploymentKey,
      });
      const fixture = await providerPublicationFixture();
      await provider.enqueueEvaluation({ checkpoint: fixture.checkpoint, requestedAt: base });
      await manifest.enqueueEvaluation({
        cause: "bootstrap_reconcile",
        causeIdentity: `proof-drift-${suffix}`,
        requestedAt: base,
      });
      const providerClaim = await provider.claim({
        workerId: `proof-provider-${suffix}`,
        now: base,
        leaseExpiresAt: at(120_000),
      });
      const manifestClaim = await manifest.claim({
        workerId: `proof-manifest-${suffix}`,
        now: base,
        leaseExpiresAt: at(120_000),
      });
      assert.ok(providerClaim);
      assert.ok(manifestClaim);

      await provider.persistPreparedOperations({
        attemptId: providerClaim.attemptId,
        claimToken: providerClaim.claimToken,
        preparedAt: at(500),
        summary: fixture.summary,
        operations: fixture.operations,
      });
      const manifestOperationId = `manifest:proof-drift:${suffix}`;
      const manifestRequestBody = canonicalJson({ operationId: manifestOperationId });
      await harness.client.manifest_promotion_operations.create({
        data: {
          attempt_id: manifestClaim.attemptId,
          organization_id: organizationId,
          deployment_key: deploymentKey,
          operation_index: 0,
          operation_id: manifestOperationId,
          operation_kind: "activateManifest",
          request_path: "/production/catalog-manifests/activate",
          canonical_request_body: manifestRequestBody,
          request_sha256: promotionV2Sha256(manifestRequestBody),
        },
      });
      if (sent) {
        assert.equal(await provider.markOperationSent({
          attemptId: providerClaim.attemptId,
          operationId: fixture.operations[0]!.operationId,
          claimToken: providerClaim.claimToken,
          sentAt: at(1_000),
        }), true);
        assert.equal(await manifest.markOperationSent({
          attemptId: manifestClaim.attemptId,
          operationId: manifestOperationId,
          claimToken: manifestClaim.claimToken,
          sentAt: at(1_000),
        }), true);
      }
      await seedPromotionV2AuthoritativeConfiguration(
        harness, organizationId, ["alpha", "beta"], at(2_000), 2,
      );

      const providerResult = await provider.recordRetryExhaustion({
        attemptId: providerClaim.attemptId,
        claimToken: providerClaim.claimToken,
        failedAt: at(3_000),
        retryAt: at(63_000),
        failureClass: "technical",
        failureCode: "PROVIDER_PROOF_DRIFT_EXHAUSTED",
      });
      const manifestResult = await manifest.recordRetryExhaustion({
        attemptId: manifestClaim.attemptId,
        claimToken: manifestClaim.claimToken,
        failedAt: at(3_000),
        retryAt: at(63_000),
        failureClass: "technical",
        failureCode: "MANIFEST_PROOF_DRIFT_EXHAUSTED",
      });
      assert.deepEqual(providerResult, {
        result: sent ? "status_required" : "requeued",
        evaluationSequence: sent ? 1n : 2n,
      });
      assert.deepEqual(manifestResult, {
        result: sent ? "status_required" : "requeued",
        evaluationSequence: sent ? 1n : 2n,
      });
      assert.equal((await harness.client.provider_promotion_attempts
        .findUniqueOrThrow({ where: { id: providerClaim.attemptId } })).state,
      sent ? "retry_wait" : "superseded");
      assert.equal((await harness.client.manifest_promotion_attempts
        .findUniqueOrThrow({ where: { id: manifestClaim.attemptId } })).state,
      sent ? "retry_wait" : "superseded");
      assert.equal((await provider.listOperations({
        attemptId: providerClaim.attemptId,
      }))[0]!.sendCount, sent ? 1 : 0);
      assert.equal((await manifest.listOperations({
        attemptId: manifestClaim.attemptId,
      }))[0]!.sendCount, sent ? 1 : 0);
    } finally {
      await harness.close();
    }
  }
});
