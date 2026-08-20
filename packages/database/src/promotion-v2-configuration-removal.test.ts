import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJson } from "@packscout/contracts";
import {
  ApprovedPublicCatalogConfigurationPersistenceError,
} from "./catalog-release-source-repository.ts";
import { PrismaCatalogPromotionBootstrapProofRepository } from
  "./catalog-promotion-bootstrap-proof-repository.ts";
import { PrismaManifestPromotionRepository } from
  "./manifest-promotion-repository.ts";
import {
  promotionV2Sha256,
  type ExactPromotionOperationInput,
} from "./promotion-v2-types.ts";
import { PrismaProviderPromotionRepository } from
  "./provider-promotion-repository.ts";
import {
  providerPublicationFixture,
  seedPromotionV2AuthoritativeConfiguration,
  seedPromotionV2VerifiedEmptyBootstrap,
} from "./promotion-v2-test-fixtures.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const deploymentKey = "promotion-v2-removal";
const base = new Date("2026-08-16T18:00:00.000Z");

function recoveryRequired(error: unknown): boolean {
  return error instanceof ApprovedPublicCatalogConfigurationPersistenceError &&
    error.code === "PUBLIC_CONFIGURATION_PROMOTION_RECOVERY_REQUIRED";
}

async function seedScope(
  organizationId: string,
  slug: string,
  platformKeys: readonly string[],
) {
  const harness = await createMigratedTestDatabase();
  await harness.client.organizations.create({
    data: { id: organizationId, slug, name: slug },
  });
  await seedPromotionV2AuthoritativeConfiguration(
    harness, organizationId, platformKeys, base,
  );
  await seedPromotionV2VerifiedEmptyBootstrap(
    harness, organizationId, deploymentKey, platformKeys, base,
  );
  return harness;
}

test("a dispatched provider plan survives proof drift through exact resend and terminal restart", async () => {
  const organizationId = "5a000000-0000-4000-8000-000000000030";
  const harness = await seedScope(
    organizationId, "provider-proof-drift", ["alpha"],
  );
  try {
    const provider = new PrismaProviderPromotionRepository(harness.client, {
      organizationId,
      deploymentKey,
      platformKey: "alpha",
    });
    const publication = await providerPublicationFixture();
    await provider.enqueueEvaluation({
      checkpoint: publication.checkpoint,
      requestedAt: base,
    });
    const claim = await provider.claim({
      workerId: "provider-first-dispatch",
      now: base,
      leaseExpiresAt: new Date(base.getTime() + 60_000),
    });
    assert.ok(claim);
    await provider.persistPreparedOperations({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      preparedAt: new Date(base.getTime() + 1_000),
      summary: publication.summary,
      operations: publication.operations,
    });
    const first = publication.operations[0]!;
    assert.equal(await provider.markOperationSent({
      attemptId: claim.attemptId,
      operationId: first.operationId,
      claimToken: claim.claimToken,
      sentAt: new Date(base.getTime() + 2_000),
    }), true);

    await seedPromotionV2AuthoritativeConfiguration(
      harness,
      organizationId,
      ["alpha", "beta"],
      new Date(base.getTime() + 3_000),
      2,
    );
    const bootstrap = new PrismaCatalogPromotionBootstrapProofRepository(
      harness.client,
      { organizationId, deploymentKey },
    );
    assert.equal(await bootstrap.loadState(), "verified_empty");

    const recovery = await provider.claim({
      workerId: "provider-status-first-recovery",
      now: new Date(base.getTime() + 61_000),
      leaseExpiresAt: new Date(base.getTime() + 121_000),
    });
    assert.ok(recovery);
    assert.equal(await provider.markOperationSent({
      attemptId: recovery.attemptId,
      operationId: first.operationId,
      claimToken: recovery.claimToken,
      sentAt: new Date(base.getTime() + 62_000),
    }), true);
    assert.equal((await provider.listOperations({
      attemptId: recovery.attemptId,
    }))[0]?.sendCount, 2);

    for (const [index, operation] of publication.operations.entries()) {
      if (index > 0) {
        assert.equal(await provider.markOperationSent({
          attemptId: recovery.attemptId,
          operationId: operation.operationId,
          claimToken: recovery.claimToken,
          sentAt: new Date(base.getTime() + 63_000 + index * 2_000),
        }), true);
      }
      assert.equal(await provider.acknowledgeOperation({
        attemptId: recovery.attemptId,
        operationId: operation.operationId,
        claimToken: recovery.claimToken,
        acknowledgedAt: new Date(base.getTime() + 64_000 + index * 2_000),
        evidence: publication.evidence[index]!,
      }), true);
    }
    const terminalRecovery = await provider.claim({
      workerId: "provider-terminal-recovery",
      now: new Date(base.getTime() + 122_000),
      leaseExpiresAt: new Date(base.getTime() + 182_000),
    });
    assert.ok(terminalRecovery);
    assert.equal(await provider.firstUnacknowledgedOperation({
      attemptId: terminalRecovery.attemptId,
      claimToken: terminalRecovery.claimToken,
      now: new Date(base.getTime() + 122_100),
    }), null);
    assert.equal(await provider.complete({
      attemptId: terminalRecovery.attemptId,
      claimToken: terminalRecovery.claimToken,
      outcome: "published",
      completedAt: new Date(base.getTime() + 123_000),
    }), true);
    assert.equal((await provider.loadCompletedHead())?.targetCheckpoint, 10n);
  } finally {
    await harness.close();
  }
});

async function insertManifestOperation(
  harness: Awaited<ReturnType<typeof createMigratedTestDatabase>>,
  organizationId: string,
  attemptId: string,
): Promise<ExactPromotionOperationInput> {
  const operation: ExactPromotionOperationInput = {
    operationIndex: 0,
    operationId: `manifest:activation:${organizationId.slice(-4)}`,
    operationKind: "activateManifest",
    requestPath: "/production/catalog-manifests/activate",
    canonicalRequestBody: canonicalJson({ test: "prepared-before-removal" }),
  };
  await harness.client.manifest_promotion_operations.create({
    data: {
      attempt_id: attemptId,
      organization_id: organizationId,
      deployment_key: deploymentKey,
      operation_index: operation.operationIndex,
      operation_id: operation.operationId,
      operation_kind: operation.operationKind,
      request_path: operation.requestPath,
      canonical_request_body: operation.canonicalRequestBody,
      request_sha256: promotionV2Sha256(operation.canonicalRequestBody),
    },
  });
  return operation;
}

test("configuration removal serializes both dispatch-first and approval-first orders", async () => {
  const providerDispatchOrganization =
    "5a000000-0000-4000-8000-000000000031";
  const providerDispatch = await seedScope(
    providerDispatchOrganization,
    "provider-dispatch-first",
    ["alpha", "beta"],
  );
  try {
    const provider = new PrismaProviderPromotionRepository(
      providerDispatch.client,
      {
        organizationId: providerDispatchOrganization,
        deploymentKey,
        platformKey: "alpha",
      },
    );
    const publication = await providerPublicationFixture();
    await provider.enqueueEvaluation({ checkpoint: publication.checkpoint, requestedAt: base });
    const claim = await provider.claim({
      workerId: "provider-removal-race",
      now: base,
      leaseExpiresAt: new Date(base.getTime() + 60_000),
    });
    assert.ok(claim);
    await provider.persistPreparedOperations({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      preparedAt: new Date(base.getTime() + 1_000),
      summary: publication.summary,
      operations: publication.operations,
    });
    await provider.markOperationSent({
      attemptId: claim.attemptId,
      operationId: publication.operations[0]!.operationId,
      claimToken: claim.claimToken,
      sentAt: new Date(base.getTime() + 2_000),
    });
    await assert.rejects(
      () => seedPromotionV2AuthoritativeConfiguration(
        providerDispatch,
        providerDispatchOrganization,
        ["beta"],
        new Date(base.getTime() + 3_000),
        2,
      ),
      recoveryRequired,
    );
  } finally {
    await providerDispatch.close();
  }

  const approvalFirstOrganization =
    "5a000000-0000-4000-8000-000000000032";
  const approvalFirst = await seedScope(
    approvalFirstOrganization,
    "provider-approval-first",
    ["alpha", "beta"],
  );
  try {
    const provider = new PrismaProviderPromotionRepository(approvalFirst.client, {
      organizationId: approvalFirstOrganization,
      deploymentKey,
      platformKey: "alpha",
    });
    const publication = await providerPublicationFixture();
    await provider.enqueueEvaluation({ checkpoint: publication.checkpoint, requestedAt: base });
    const claim = await provider.claim({
      workerId: "provider-pending-removal",
      now: base,
      leaseExpiresAt: new Date(base.getTime() + 60_000),
    });
    assert.ok(claim);
    await provider.persistPreparedOperations({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      preparedAt: new Date(base.getTime() + 1_000),
      summary: publication.summary,
      operations: publication.operations,
    });
    await seedPromotionV2AuthoritativeConfiguration(
      approvalFirst,
      approvalFirstOrganization,
      ["beta"],
      new Date(base.getTime() + 2_000),
      2,
    );
    assert.equal((await approvalFirst.client.provider_promotion_attempts
      .findUniqueOrThrow({ where: { id: claim.attemptId } })).state, "superseded");
    assert.equal(await provider.markOperationSent({
      attemptId: claim.attemptId,
      operationId: publication.operations[0]!.operationId,
      claimToken: claim.claimToken,
      sentAt: new Date(base.getTime() + 3_000),
    }), false);
  } finally {
    await approvalFirst.close();
  }
});

test("manifest dispatch blocks removal while approval-first supersedes zero-send work", async () => {
  for (const [suffix, dispatchFirst] of [["33", true], ["34", false]] as const) {
    const organizationId =
      `5a000000-0000-4000-8000-0000000000${suffix}`;
    const harness = await seedScope(
      organizationId,
      `manifest-removal-${suffix}`,
      ["alpha", "beta"],
    );
    try {
      const manifest = new PrismaManifestPromotionRepository(harness.client, {
        organizationId,
        deploymentKey,
      });
      await manifest.enqueueEvaluation({
        cause: "configuration_settled",
        causeIdentity: `manifest-removal-${suffix}`,
        requestedAt: base,
      });
      const claim = await manifest.claim({
        workerId: `manifest-removal-${suffix}`,
        now: base,
        leaseExpiresAt: new Date(base.getTime() + 60_000),
      });
      assert.ok(claim);
      const operation = await insertManifestOperation(
        harness, organizationId, claim.attemptId,
      );
      if (dispatchFirst) {
        assert.equal(await manifest.markOperationSent({
          attemptId: claim.attemptId,
          operationId: operation.operationId,
          claimToken: claim.claimToken,
          sentAt: new Date(base.getTime() + 1_000),
        }), true);
        await assert.rejects(
          () => seedPromotionV2AuthoritativeConfiguration(
            harness,
            organizationId,
            ["beta"],
            new Date(base.getTime() + 2_000),
            2,
          ),
          recoveryRequired,
        );
      } else {
        await seedPromotionV2AuthoritativeConfiguration(
          harness,
          organizationId,
          ["beta"],
          new Date(base.getTime() + 1_000),
          2,
        );
        assert.equal((await harness.client.manifest_promotion_attempts
          .findUniqueOrThrow({ where: { id: claim.attemptId } })).state,
        "superseded");
        assert.equal(await manifest.markOperationSent({
          attemptId: claim.attemptId,
          operationId: operation.operationId,
          claimToken: claim.claimToken,
          sentAt: new Date(base.getTime() + 2_000),
        }), false);
      }
    } finally {
      await harness.close();
    }
  }
});

test("an unrelated dispatched manifest selection does not block provider removal", async () => {
  const organizationId = "5a000000-0000-4000-8000-000000000035";
  const harness = await seedScope(
    organizationId,
    "manifest-unrelated-removal",
    ["alpha", "beta"],
  );
  try {
    const manifest = new PrismaManifestPromotionRepository(harness.client, {
      organizationId,
      deploymentKey,
    });
    await manifest.enqueueEvaluation({
      cause: "configuration_settled",
      causeIdentity: "manifest-unrelated-removal",
      requestedAt: base,
    });
    const claim = await manifest.claim({
      workerId: "manifest-unrelated-removal",
      now: base,
      leaseExpiresAt: new Date(base.getTime() + 60_000),
    });
    assert.ok(claim);
    const summaryBody = canonicalJson({
      providerSelections: [{ platformKey: "beta" }],
    });
    await harness.client.manifest_promotion_attempts.update({
      where: { id: claim.attemptId },
      data: {
        prepared_operation_kind: "activateManifest",
        prepared_summary_body: summaryBody,
        prepared_summary_sha256: promotionV2Sha256(summaryBody),
        evaluation_snapshot_body: "{}",
        evaluation_snapshot_sha256: promotionV2Sha256("{}"),
        expected_active_state_sha256: "a".repeat(64),
        prepared_at: new Date(base.getTime() + 500),
        state: "ready",
      },
    });
    const operation = await insertManifestOperation(
      harness,
      organizationId,
      claim.attemptId,
    );
    assert.equal(await manifest.markOperationSent({
      attemptId: claim.attemptId,
      operationId: operation.operationId,
      claimToken: claim.claimToken,
      sentAt: new Date(base.getTime() + 1_000),
    }), true);
    await seedPromotionV2AuthoritativeConfiguration(
      harness,
      organizationId,
      ["beta"],
      new Date(base.getTime() + 2_000),
      2,
    );
    assert.equal((await harness.client.manifest_promotion_attempts
      .findUniqueOrThrow({ where: { id: claim.attemptId } })).state,
    "in_progress");
  } finally {
    await harness.close();
  }
});
