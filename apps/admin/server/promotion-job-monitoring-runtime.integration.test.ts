import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { canonicalJson } from "@packscout/contracts";
import {
  PROMOTION_JOB_DELIVERY_RETENTION_MS,
  PrismaManifestReconciliationJobRepository,
  PrismaProviderPromotionInvocationProjectionRepository,
  promotionJobSha256,
} from "@packscout/database";
import { createMigratedCentralTestDatabase } from
  "@packscout/database/test-support";
import { PrismaPromotionJobMonitoringReadRepository } from
  "./promotion-job-monitoring-runtime.ts";

const organizationId = "91000000-0000-4000-8000-000000000001";
const otherOrganizationId = "91000000-0000-4000-8000-000000000002";
const providerId = "92000000-0000-4000-8000-000000000001";
const disabledProviderId = "92000000-0000-4000-8000-000000000002";
const base = new Date("2026-09-01T12:00:00.000Z");

test("real central repository scopes roster, merged history, and provider detail", async () => {
  const harness = await createMigratedCentralTestDatabase();
  try {
    await harness.client.organizations.createMany({
      data: [{
        id: organizationId,
        slug: "promotion-monitoring",
        name: "Promotion monitoring",
      }, {
        id: otherOrganizationId,
        slug: "promotion-monitoring-other",
        name: "Promotion monitoring other",
      }],
    });
    await harness.client.$executeRawUnsafe(
      'alter table "providers" disable trigger "providers_exact_activation_guard"',
    );
    try {
      await harness.client.providers.createMany({
        data: [{
          id: providerId,
          organization_id: organizationId,
          provider_key: "monitoring_alpha",
          display_name: "Monitoring alpha",
          lifecycle: "active",
        }, {
          id: disabledProviderId,
          organization_id: organizationId,
          provider_key: "monitoring_disabled",
          display_name: "Monitoring disabled",
          lifecycle: "disabled",
        }],
      });
    } finally {
      await harness.client.$executeRawUnsafe(
        'alter table "providers" enable trigger "providers_exact_activation_guard"',
      );
    }

    const manifest = new PrismaManifestReconciliationJobRepository(
      harness.client,
    );
    const issuedAt = new Date(base.getTime() - 1_000);
    const ownershipToken = randomUUID();
    const admission = await manifest.beginOrRecoverInvocation({
      delivery: {
        opaqueKey: "monitoring-manifest-manual",
        issuedAt,
        expiresAt: new Date(
          issuedAt.getTime() + PROMOTION_JOB_DELIVERY_RETENTION_MS,
        ),
      },
      trigger: { kind: "manual" },
      now: base,
      requestedAt: base,
      startedAt: base,
      ownershipKey: "monitoring-integration",
      ownershipToken,
      ownershipExpiresAt: new Date(base.getTime() + 60_000),
    });
    await manifest.terminalize({
      runId: admission.invocation!.runId,
      ownershipToken,
      finishedAt: new Date(base.getTime() + 1_000),
      outcome: "no_change",
      acknowledgeObservedWake: false,
    });

    const projections = new PrismaProviderPromotionInvocationProjectionRepository(
      harness.client,
    );
    const projected = await projections.project({
      providerId,
      opaqueProviderInvocationId: "provider-local-id-never-returned",
      triggerKind: "manual",
      outcome: "caught_up",
      scheduledCheckinAt: null,
      startedAt: new Date(base.getTime() + 2_000),
      finishedAt: new Date(base.getTime() + 3_000),
      progress: {
        beforeLanePosition: 1n,
        afterLanePosition: 2n,
        beforeSettledPosition: 1n,
        afterSettledPosition: 2n,
        cycleCount: 1,
        promotionAttemptCount: 1,
        publicationCount: 0,
        operationCount: 0,
      },
      safeFailureCode: null,
      attempts: [{
        attemptKind: "provider",
        attemptId: "93000000-0000-4000-8000-000000000001",
        observedState: "complete",
        targetPosition: 2n,
        retryCount: 3,
        safeFailureCode: null,
        publicReleaseId: null,
        releaseFingerprint: null,
        totalOperationCount: 0,
        orderedOperationDigest: promotionJobSha256("provider-operations"),
        recentOperations: [],
        observedAt: new Date(base.getTime() + 3_000),
      }],
      projectedAt: new Date(base.getTime() + 4_000),
    });
    const repository = new PrismaPromotionJobMonitoringReadRepository(
      harness.client,
    );

    const [roster, retained, history] = await Promise.all([
      repository.captureEligibleRoster(),
      repository.listRoster(organizationId),
      repository.listHistory({
        organizationId,
        query: { limit: 25 },
        before: null,
      }),
    ]);
    assert.equal(roster.providers.length, 1);
    assert.deepEqual(retained.map(({ providerKey, lifecycle }) => ({
      providerKey,
      lifecycle,
    })), [{
      providerKey: "monitoring_alpha",
      lifecycle: "active",
    }, {
      providerKey: "monitoring_disabled",
      lifecycle: "disabled",
    }]);
    assert.deepEqual(history.map(({ kind }) => kind), ["manifest", "provider"]);
    const providerRecord = history.find(({ kind }) => kind === "provider")!;
    assert.equal(providerRecord.centralId, projected.id);
    assert.equal(providerRecord.settledPosition, 2n);
    assert.equal(providerRecord.retryCount, 3);
    assert.equal(
      JSON.stringify(providerRecord, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value
      ).includes("provider-local-id-never-returned"),
      false,
    );
    assert.notEqual(await repository.readDetail({
      organizationId,
      reference: { kind: "provider", centralId: projected.id },
    }), null);
    assert.equal(await repository.readDetail({
      organizationId: otherOrganizationId,
      reference: { kind: "provider", centralId: projected.id },
    }), null);
    const evidence = await repository.readProviderEvidence({
      organizationId,
      provider: retained[0]!,
      active: null,
    });
    assert.equal(evidence.latestProjection?.centralId, projected.id);
    const persistedAttempts = JSON.parse(projected.canonicalDetailBody) as Array<{
      attemptIdentityDigest: string;
      snapshotDigest: string;
    }>;
    const expectedAttemptSetDigest = promotionJobSha256(canonicalJson(
      persistedAttempts.map(({ attemptIdentityDigest, snapshotDigest }) => ({
        attemptIdentityDigest,
        snapshotDigest,
      })),
    ));
    assert.equal(
      evidence.latestProjection?.attemptSetDigest,
      expectedAttemptSetDigest,
    );
    assert.notEqual(expectedAttemptSetDigest, projected.canonicalDetailDigest);
  } finally {
    await harness.close();
  }
});
