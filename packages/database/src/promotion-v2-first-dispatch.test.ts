import assert from "node:assert/strict";
import { test } from "node:test";
import { PrismaManifestPromotionRepository } from
  "./manifest-promotion-repository.ts";
import { PrismaProviderPromotionRepository } from
  "./provider-promotion-repository.ts";
import {
  manifestActivationFixture,
  providerPublicationFixture,
  seedPromotionV2AuthoritativeConfiguration,
  seedPromotionV2VerifiedEmptyBootstrap,
  type ManifestActivationFixture,
  type ProviderPublicationFixture,
} from "./promotion-v2-test-fixtures.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const deploymentKey = "promotion-v2-first-dispatch";
const base = new Date("2026-08-16T23:00:00.000Z");

function at(milliseconds: number): Date {
  return new Date(base.getTime() + milliseconds);
}

async function seedScope(organizationId: string, slug: string) {
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

async function acknowledgeProviderPublication(
  repository: PrismaProviderPromotionRepository,
  claim: Readonly<{ attemptId: string; claimToken: string }>,
  fixture: ProviderPublicationFixture,
  startAt: number,
): Promise<void> {
  for (const [index, operation] of fixture.operations.entries()) {
    assert.equal(await repository.markOperationSent({
      attemptId: claim.attemptId,
      operationId: operation.operationId,
      claimToken: claim.claimToken,
      sentAt: at(startAt + index * 2_000),
    }), true);
    assert.equal(await repository.acknowledgeOperation({
      attemptId: claim.attemptId,
      operationId: operation.operationId,
      claimToken: claim.claimToken,
      acknowledgedAt: at(startAt + index * 2_000 + 1_000),
      evidence: fixture.evidence[index]!,
    }), true);
  }
}

test("provider first dispatch serializes with a newer checkpoint evaluation", async () => {
  for (const [suffix, dispatchFirst] of [["61", false], ["62", true]] as const) {
    const organizationId = `5a000000-0000-4000-8000-0000000000${suffix}`;
    const harness = await seedScope(
      organizationId, `provider-first-dispatch-${suffix}`,
    );
    try {
      const repository = new PrismaProviderPromotionRepository(harness.client, {
        organizationId,
        deploymentKey,
        platformKey: "alpha",
      });
      const first = await providerPublicationFixture({ sequence: 10n });
      const successor = await providerPublicationFixture({
        sequence: 11n,
        operationTag: `successor-${suffix}`,
      });
      await repository.enqueueEvaluation({ checkpoint: first.checkpoint, requestedAt: base });
      const claim = await repository.claim({
        workerId: `provider-${suffix}`,
        now: base,
        leaseExpiresAt: at(120_000),
      });
      assert.ok(claim);
      await repository.persistPreparedOperations({
        attemptId: claim.attemptId,
        claimToken: claim.claimToken,
        preparedAt: at(1_000),
        summary: first.summary,
        operations: first.operations,
      });
      const firstOperation = first.operations[0]!;

      if (!dispatchFirst) {
        await seedPromotionV2AuthoritativeConfiguration(
          harness, organizationId, ["alpha", "beta"], at(2_000), 2,
        );
        assert.equal(await repository.markOperationSent({
          attemptId: claim.attemptId,
          operationId: firstOperation.operationId,
          claimToken: claim.claimToken,
          sentAt: at(3_000),
        }), false);
        const retired = await harness.client.provider_promotion_attempts
          .findUniqueOrThrow({ where: { id: claim.attemptId } });
        assert.equal(retired.state, "superseded");
        assert.equal((await repository.listOperations({
          attemptId: claim.attemptId,
        }))[0]!.sendCount, 0);
      } else {
        assert.equal(await repository.markOperationSent({
          attemptId: claim.attemptId,
          operationId: firstOperation.operationId,
          claimToken: claim.claimToken,
          sentAt: at(2_000),
        }), true);
        assert.deepEqual(await repository.enqueueEvaluation({
          checkpoint: successor.checkpoint,
          requestedAt: at(3_000),
        }), { evaluationSequence: 2n, result: "created" });
        assert.equal(await repository.acknowledgeOperation({
          attemptId: claim.attemptId,
          operationId: firstOperation.operationId,
          claimToken: claim.claimToken,
          acknowledgedAt: at(4_000),
          evidence: first.evidence[0]!,
        }), true);
        for (let index = 1; index < first.operations.length; index += 1) {
          const operation = first.operations[index]!;
          assert.equal(await repository.markOperationSent({
            attemptId: claim.attemptId,
            operationId: operation.operationId,
            claimToken: claim.claimToken,
            sentAt: at(5_000 + index * 2_000),
          }), true);
          assert.equal(await repository.acknowledgeOperation({
            attemptId: claim.attemptId,
            operationId: operation.operationId,
            claimToken: claim.claimToken,
            acknowledgedAt: at(6_000 + index * 2_000),
            evidence: first.evidence[index]!,
          }), true);
        }
        assert.equal(await repository.complete({
          attemptId: claim.attemptId,
          claimToken: claim.claimToken,
          outcome: "published",
          completedAt: at(20_000),
        }), true);
      }

      const next = await repository.claim({
        workerId: `provider-successor-${suffix}`,
        now: at(21_000),
        leaseExpiresAt: at(141_000),
      });
      if (dispatchFirst) {
        assert.equal(next?.evaluationSequence, 2n);
        assert.equal(next?.checkpointSha256, successor.summary.checkpointSha256);
      } else {
        assert.equal(next, null);
        const health = await repository.loadHealth({ now: at(22_000) });
        assert.equal(health.requestedEvaluationSequence, 2n);
        assert.equal(health.confirmedEvaluationSequence, 0n);
      }
    } finally {
      await harness.close();
    }
  }
});

test("proof drift before preparation retires provider and manifest attempts", async () => {
  const organizationId = "5a000000-0000-4000-8000-000000000067";
  const harness = await seedScope(
    organizationId, "proof-drift-before-preparation",
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
    const publication = await providerPublicationFixture();
    await provider.enqueueEvaluation({ checkpoint: publication.checkpoint, requestedAt: base });
    await manifest.enqueueEvaluation({
      cause: "bootstrap_reconcile",
      causeIdentity: "before-preparation",
      requestedAt: base,
    });
    const providerClaim = await provider.claim({
      workerId: "provider-before-preparation",
      now: base,
      leaseExpiresAt: at(120_000),
    });
    const manifestClaim = await manifest.claim({
      workerId: "manifest-before-preparation",
      now: base,
      leaseExpiresAt: at(120_000),
    });
    assert.ok(providerClaim);
    assert.ok(manifestClaim);
    await seedPromotionV2AuthoritativeConfiguration(
      harness, organizationId, ["alpha", "beta"], at(1_000), 2,
    );

    assert.equal(await provider.persistPreparedOperations({
      attemptId: providerClaim.attemptId,
      claimToken: providerClaim.claimToken,
      preparedAt: at(2_000),
      summary: publication.summary,
      operations: publication.operations,
    }), null);
    assert.equal(await manifest.loadEvaluationSnapshot({
      attemptId: manifestClaim.attemptId,
      claimToken: manifestClaim.claimToken,
      now: at(2_000),
    }), null);
    assert.equal((await harness.client.provider_promotion_attempts
      .findUniqueOrThrow({ where: { id: providerClaim.attemptId } })).state,
    "superseded");
    assert.equal((await harness.client.manifest_promotion_attempts
      .findUniqueOrThrow({ where: { id: manifestClaim.attemptId } })).state,
    "superseded");
    assert.equal((await provider.loadHealth({ now: at(3_000) }))
      .requestedEvaluationSequence, 2n);
    assert.equal((await manifest.loadHealth({ now: at(3_000) }))
      .requestedEvaluationSequence, 2n);
  } finally {
    await harness.close();
  }
});

async function prepareManifestActivation(
  organizationId: string,
  slug: string,
): Promise<Readonly<{
  harness: Awaited<ReturnType<typeof seedScope>>;
  repository: PrismaManifestPromotionRepository;
  claim: NonNullable<Awaited<ReturnType<PrismaManifestPromotionRepository["claim"]>>>;
  activation: ManifestActivationFixture;
}>> {
  const harness = await seedScope(organizationId, slug);
  const provider = new PrismaProviderPromotionRepository(harness.client, {
    organizationId,
    deploymentKey,
    platformKey: "alpha",
  });
  const publication = await providerPublicationFixture({ sequence: 10n });
  await provider.enqueueEvaluation({ checkpoint: publication.checkpoint, requestedAt: base });
  const providerClaim = await provider.claim({
    workerId: `${slug}-provider`,
    now: base,
    leaseExpiresAt: at(120_000),
  });
  assert.ok(providerClaim);
  await provider.persistPreparedOperations({
    attemptId: providerClaim.attemptId,
    claimToken: providerClaim.claimToken,
    preparedAt: at(1_000),
    summary: publication.summary,
    operations: publication.operations,
  });
  await acknowledgeProviderPublication(provider, providerClaim, publication, 2_000);
  assert.equal(await provider.complete({
    attemptId: providerClaim.attemptId,
    claimToken: providerClaim.claimToken,
    outcome: "published",
    completedAt: at(20_000),
  }), true);

  const repository = new PrismaManifestPromotionRepository(harness.client, {
    organizationId,
    deploymentKey,
  });
  const claim = await repository.claim({
    workerId: `${slug}-manifest`,
    now: at(21_000),
    leaseExpiresAt: at(141_000),
  });
  assert.ok(claim);
  const activation = await manifestActivationFixture({
    publication,
    organizationId,
    evaluationSequence: claim.evaluationSequence,
    publishArtifactAttemptId: providerClaim.attemptId,
    operationTag: slug,
  });
  await harness.client.manifest_promotion_attempts.update({
    where: { id: claim.attemptId },
    data: {
      evaluation_snapshot_body: activation.snapshotBody,
      evaluation_snapshot_sha256: activation.snapshotSha256,
    },
  });
  await repository.persistPreparedOperation({
    attemptId: claim.attemptId,
    claimToken: claim.claimToken,
    preparedAt: at(22_000),
    summary: activation.summary,
    operation: activation.operation,
  });
  return { harness, repository, claim, activation };
}

test("manifest first dispatch serializes with a newer evaluation", async () => {
  for (const [suffix, dispatchFirst] of [["63", false], ["64", true]] as const) {
    const organizationId = `5a000000-0000-4000-8000-0000000000${suffix}`;
    const prepared = await prepareManifestActivation(
      organizationId, `manifest-first-dispatch-${suffix}`,
    );
    const { harness, repository, claim, activation } = prepared;
    try {
      if (dispatchFirst) {
        assert.equal(await repository.markOperationSent({
          attemptId: claim.attemptId,
          operationId: activation.operation.operationId,
          claimToken: claim.claimToken,
          sentAt: at(23_000),
        }), true);
      }
      if (dispatchFirst) {
        assert.deepEqual(await repository.enqueueEvaluation({
          cause: "observation_succeeded",
          causeIdentity: `manifest-successor-${suffix}`,
          requestedAt: at(24_000),
        }), { evaluationSequence: 2n, result: "created" });
      } else {
        await seedPromotionV2AuthoritativeConfiguration(
          harness, organizationId, ["alpha", "beta"], at(24_000), 2,
        );
      }

      if (!dispatchFirst) {
        assert.equal(await repository.markOperationSent({
          attemptId: claim.attemptId,
          operationId: activation.operation.operationId,
          claimToken: claim.claimToken,
          sentAt: at(25_000),
        }), false);
        assert.equal((await repository.listOperations({
          attemptId: claim.attemptId,
        }))[0]!.sendCount, 0);
        assert.equal((await harness.client.manifest_promotion_attempts
          .findUniqueOrThrow({ where: { id: claim.attemptId } })).state,
        "superseded");
      } else {
        assert.equal(await repository.acknowledgeOperation({
          attemptId: claim.attemptId,
          operationId: activation.operation.operationId,
          claimToken: claim.claimToken,
          acknowledgedAt: at(25_000),
          evidence: activation.evidence,
        }), true);
        assert.equal(await repository.complete({
          attemptId: claim.attemptId,
          claimToken: claim.claimToken,
          outcome: "activated",
          completedAt: at(26_000),
        }), true);
      }

      const next = await repository.claim({
        workerId: `manifest-successor-${suffix}`,
        now: at(27_000),
        leaseExpiresAt: at(147_000),
      });
      if (dispatchFirst) {
        assert.equal(next?.evaluationSequence, 2n);
      } else {
        assert.equal(next, null);
        const health = await repository.loadHealth({ now: at(28_000) });
        assert.equal(health.requestedEvaluationSequence, 2n);
        assert.equal(health.confirmedEvaluationSequence, 0n);
      }
    } finally {
      await harness.close();
    }
  }
});

test("manifest no-change cannot confirm after a newer evaluation is requested", async () => {
  const organizationId = "5a000000-0000-4000-8000-000000000065";
  const harness = await seedScope(
    organizationId, "manifest-stale-no-change",
  );
  try {
    const repository = new PrismaManifestPromotionRepository(harness.client, {
      organizationId,
      deploymentKey,
    });
    await repository.enqueueEvaluation({
      cause: "bootstrap_reconcile",
      causeIdentity: "no-change-1",
      requestedAt: base,
    });
    const claim = await repository.claim({
      workerId: "manifest-no-change",
      now: base,
      leaseExpiresAt: at(120_000),
    });
    assert.ok(claim);
    const snapshot = await repository.loadEvaluationSnapshot({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      now: at(1_000),
    });
    assert.ok(snapshot?.activeState);
    assert.deepEqual(snapshot.eligibility.enabledPlatformKeys, []);
    const epoch = {
      ...snapshot.eligibility.sharedConfigurationEpoch,
      publicChangeSequence: String(
        snapshot.eligibility.sharedConfigurationEpoch.publicChangeSequence,
      ),
    };
    await repository.persistPreparedOperation({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      preparedAt: at(2_000),
      summary: {
        operationKind: "no_change",
        evaluationSnapshotSha256: snapshot.snapshotSha256,
        expectedActiveState: snapshot.activeState.state,
        sharedConfigurationEpoch: epoch,
        enabledPlatformKeys: [],
        providerSelections: [],
        manifestIdentity: null,
      },
      operation: null,
    });
    await seedPromotionV2AuthoritativeConfiguration(
      harness, organizationId, ["alpha", "beta"], at(3_000), 2,
    );
    assert.equal(await repository.complete({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      outcome: "no_change",
      completedAt: at(4_000),
    }), false);
    assert.equal((await harness.client.manifest_promotion_attempts
      .findUniqueOrThrow({ where: { id: claim.attemptId } })).state,
    "superseded");
    const health = await repository.loadHealth({ now: at(5_000) });
    assert.equal(health.confirmedEvaluationSequence, 0n);
    assert.equal(health.requestedEvaluationSequence, 2n);
    assert.equal(await repository.claim({
      workerId: "manifest-no-change-successor",
      now: at(5_000),
      leaseExpiresAt: at(125_000),
    }), null);
  } finally {
    await harness.close();
  }
});

test("same-proof no-change yields to an already-enqueued successor", async () => {
  const organizationId = "5a000000-0000-4000-8000-000000000068";
  const harness = await seedScope(
    organizationId, "manifest-no-change-successor",
  );
  try {
    const repository = new PrismaManifestPromotionRepository(harness.client, {
      organizationId,
      deploymentKey,
    });
    await repository.enqueueEvaluation({
      cause: "bootstrap_reconcile",
      causeIdentity: "same-proof-no-change-1",
      requestedAt: base,
    });
    const claim = await repository.claim({
      workerId: "same-proof-no-change",
      now: base,
      leaseExpiresAt: at(120_000),
    });
    assert.ok(claim);
    const snapshot = await repository.loadEvaluationSnapshot({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      now: at(1_000),
    });
    assert.ok(snapshot?.activeState);
    const epoch = {
      ...snapshot.eligibility.sharedConfigurationEpoch,
      publicChangeSequence: String(
        snapshot.eligibility.sharedConfigurationEpoch.publicChangeSequence,
      ),
    };
    await repository.persistPreparedOperation({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      preparedAt: at(2_000),
      summary: {
        operationKind: "no_change",
        evaluationSnapshotSha256: snapshot.snapshotSha256,
        expectedActiveState: snapshot.activeState.state,
        sharedConfigurationEpoch: epoch,
        enabledPlatformKeys: [],
        providerSelections: [],
        manifestIdentity: null,
      },
      operation: null,
    });
    await repository.enqueueEvaluation({
      cause: "observation_succeeded",
      causeIdentity: "same-proof-no-change-2",
      requestedAt: at(3_000),
    });
    assert.equal(await repository.complete({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      outcome: "no_change",
      completedAt: at(4_000),
    }), false);
    const health = await repository.loadHealth({ now: at(5_000) });
    assert.equal(health.requestedEvaluationSequence, 2n);
    assert.equal(health.confirmedEvaluationSequence, 1n);
    assert.equal((await repository.claim({
      workerId: "same-proof-successor",
      now: at(5_000),
      leaseExpiresAt: at(125_000),
    }))?.evaluationSequence, 2n);
  } finally {
    await harness.close();
  }
});
