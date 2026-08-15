import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperationalNotification } from "@packscout/contracts";
import { PrismaAdminNotificationPublisher } from "./operational-alert-repository.ts";
import {
  PrismaPromotionReadinessRepository,
  promotionDeploymentScopeDigest,
} from "./promotion-readiness-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const organizationId = "53000000-0000-4000-8000-000000000001";
const otherOrganizationId = "53000000-0000-4000-8000-000000000002";
const attemptId = "53000000-0000-4000-8000-000000000003";
const deploymentKey = "production-us";
const otherDeploymentKey = "production-eu";
const now = new Date("2026-08-15T12:01:00.000Z");

function event(
  id: string,
  kind: "promotion_activation_delayed" | "promotion_failed" | "promotion_recovered",
  deploymentScopeDigest: string,
): OperationalNotification {
  const alertScope = `promotion:${deploymentScopeDigest}:catalog`;
  const common = {
    id,
    organizationId,
    severity: kind === "promotion_recovered" ? "info" as const : "critical" as const,
    providerId: null,
    runId: null,
    quarantineId: null,
    recoveryKey: `${alertScope}:health`,
    occurredAt: now.toISOString(),
  };
  if (kind === "promotion_activation_delayed") {
    return {
      ...common,
      kind,
      severity: "warning",
      dedupeKey: `${alertScope}:activation-delayed`,
      title: "Catalog publication is delayed",
      summary: "A ready public watermark has not been confirmed within its activation target.",
      evidence: {
        lane: "catalog",
        condition: "activation_lag",
        targetWatermark: "2",
        confirmedWatermark: "1",
        durationMs: 60_000,
      },
    };
  }
  if (kind === "promotion_failed") {
    return {
      ...common,
      kind,
      dedupeKey: `${alertScope}:failed`,
      title: "Catalog publication failed",
      summary: "Publication reconciliation reached a safe terminal failure.",
      evidence: {
        lane: "catalog",
        condition: "reconciliation_failure",
        targetWatermark: "2",
        confirmedWatermark: "1",
        attemptId,
        failureCode: "PUBLICATION_RESPONSE_INVALID",
      },
    };
  }
  return {
    ...common,
    kind,
    dedupeKey: `${alertScope}:recovered`,
    title: "Catalog publication recovered",
    summary: "The public lane is fully confirmed and has no technical settlement block.",
    evidence: {
      lane: "catalog",
      condition: "recovered",
      targetWatermark: "2",
      confirmedWatermark: "2",
      outcome: "PROMOTION_RECOVERED",
    },
  };
}

test("promotion diagnostics and recovery isolate two deployments in one organization", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    await harness.client.organizations.createMany({
      data: [
        { id: organizationId, slug: "promotion-ready", name: "Promotion Ready" },
        { id: otherOrganizationId, slug: "promotion-other", name: "Promotion Other" },
      ],
    });
    await harness.client.settled_public_watermarks.create({
      data: {
        organization_id: organizationId,
        next_sequence: 3n,
        settled_sequence: 1n,
        source_head_sequence: 2n,
        settled_at: new Date("2026-08-15T11:59:00.000Z"),
        source_head_at: new Date("2026-08-15T11:59:30.000Z"),
      },
    });
    await harness.client.public_change_causes.createMany({
      data: [1n, 2n].map((sequence) => ({
        organization_id: organizationId,
        sequence,
        change_kind: "provider_projection" as const,
        entity_key: `canonical:v1:${sequence}`,
        occurred_at: now,
        authoritative_transaction_id: `test:${sequence}`,
      })),
    });
    await harness.client.public_derivation_obligations.create({
      data: {
        organization_id: organizationId,
        cause_sequence: 2n,
        derivation_kind: "estimated_ev",
        derivation_key: "ev:v1:blocked",
        state: "technical_failure",
        outcome_classification: "technical_failure",
        outcome_reason_code: "CALCULATION_TIMEOUT",
        acknowledged_claim_token: "53000000-0000-4000-8000-000000000004",
        outcome_at: now,
      },
    });
    await harness.client.promotion_lanes.createMany({
      data: [
        {
          organization_id: organizationId,
          deployment_key: deploymentKey,
          lane_key: "catalog",
          bootstrap_state: "verified_local",
          bootstrap_verified_at: now,
          settled_watermark: 2n,
          settled_at: now,
          requested_watermark: 2n,
          requested_at: now,
          confirmed_watermark: 1n,
          confirmed_publication_identity: "release-us",
          confirmed_receipt_sha256: "1".repeat(64),
          last_activated_watermark: 1n,
          last_activated_at: now,
        },
        {
          organization_id: organizationId,
          deployment_key: otherDeploymentKey,
          lane_key: "catalog",
          bootstrap_state: "verified_local",
          bootstrap_verified_at: now,
          settled_watermark: 7n,
          settled_at: now,
          requested_watermark: 7n,
          requested_at: now,
          confirmed_watermark: 6n,
          confirmed_publication_identity: "release-eu",
          confirmed_receipt_sha256: "2".repeat(64),
          last_activated_watermark: 6n,
          last_activated_at: now,
        },
        {
          organization_id: otherOrganizationId,
          deployment_key: deploymentKey,
          lane_key: "catalog",
          bootstrap_state: "verified_local",
          bootstrap_verified_at: now,
          settled_watermark: 99n,
          settled_at: now,
          requested_watermark: 99n,
          requested_at: now,
          confirmed_watermark: 99n,
          confirmed_publication_identity: "release-other",
          confirmed_receipt_sha256: "3".repeat(64),
          last_activated_watermark: 99n,
          last_activated_at: now,
        },
      ],
    });
    await harness.client.promotion_attempts.create({
      data: {
        id: attemptId,
        organization_id: organizationId,
        deployment_key: deploymentKey,
        lane_key: "catalog",
        target_watermark: 2n,
        state: "failed",
        failure_class: "reconciliation",
        failure_code: "PUBLICATION_RESPONSE_INVALID",
        terminal_at: now,
        created_at: now,
        updated_at: now,
      },
    });

    const repository = new PrismaPromotionReadinessRepository(
      harness.client,
      { organizationId, deploymentKey, lane: "catalog" },
    );
    const otherDeploymentRepository = new PrismaPromotionReadinessRepository(
      harness.client,
      {
        organizationId,
        deploymentKey: otherDeploymentKey,
        lane: "catalog",
      },
    );
    assert.equal(
      repository.deploymentScopeDigest,
      "464781dcba60b9e196424a637b904da473912cffdf4f694c078e9191077a66e1",
    );
    assert.equal(
      repository.deploymentScopeDigest,
      promotionDeploymentScopeDigest(deploymentKey),
    );
    assert.notEqual(
      repository.deploymentScopeDigest,
      otherDeploymentRepository.deploymentScopeDigest,
    );
    assert.throws(
      () => promotionDeploymentScopeDigest("unsafe deployment"),
      /deployment scope/u,
    );

    const publisher = new PrismaAdminNotificationPublisher(harness.client);
    assert.equal((await publisher.publish(event(
      "53000000-0000-4000-8000-000000000010",
      "promotion_activation_delayed",
      repository.deploymentScopeDigest,
    ))).status, "accepted");
    assert.equal((await publisher.publish(event(
      "53000000-0000-4000-8000-000000000011",
      "promotion_failed",
      repository.deploymentScopeDigest,
    ))).status, "accepted");
    assert.equal((await publisher.publish(event(
      "53000000-0000-4000-8000-000000000012",
      "promotion_activation_delayed",
      otherDeploymentRepository.deploymentScopeDigest,
    ))).status, "accepted");

    const diagnostic = await repository.load();
    assert.deepEqual(diagnostic, {
      activeAlertCount: 2,
      activeFailureAlertCount: 1,
      activeFailureAttemptId: attemptId,
      canonicalSettledWatermark: 1n,
      canonicalSettledAt: new Date("2026-08-15T11:59:00.000Z"),
      canonicalSourceHeadWatermark: 2n,
      confirmedWatermark: 1n,
      laneTargetWatermark: 2n,
      laneTargetAt: now,
      latestFailedAttemptId: attemptId,
      latestFailedWatermark: 2n,
      latestFailureCode: "PUBLICATION_RESPONSE_INVALID",
      technicalFailureCount: 1,
    });
    assert.deepEqual(await otherDeploymentRepository.load(), {
      activeAlertCount: 1,
      activeFailureAlertCount: 0,
      activeFailureAttemptId: null,
      canonicalSettledWatermark: 1n,
      canonicalSettledAt: new Date("2026-08-15T11:59:00.000Z"),
      canonicalSourceHeadWatermark: 2n,
      confirmedWatermark: 6n,
      laneTargetWatermark: 7n,
      laneTargetAt: now,
      latestFailedAttemptId: null,
      latestFailedWatermark: null,
      latestFailureCode: null,
      technicalFailureCount: 1,
    });

    assert.equal((await publisher.publish(event(
      "53000000-0000-4000-8000-000000000013",
      "promotion_recovered",
      repository.deploymentScopeDigest,
    ))).status, "resolved");
    assert.equal(await harness.client.admin_alerts.count({
      where: { organization_id: organizationId, state: { not: "resolved" } },
    }), 1);
    assert.equal((await repository.load()).activeAlertCount, 0);
    assert.equal((await otherDeploymentRepository.load()).activeAlertCount, 1);
    assert.equal((await publisher.publish(event(
      "53000000-0000-4000-8000-000000000014",
      "promotion_recovered",
      otherDeploymentRepository.deploymentScopeDigest,
    ))).status, "resolved");
    assert.equal(await harness.client.admin_alerts.count({
      where: { organization_id: organizationId, state: { not: "resolved" } },
    }), 0);
    assert.equal(await harness.client.admin_alerts.count({
      where: { organization_id: otherOrganizationId },
    }), 0);

    const rendered = JSON.stringify(
      await harness.client.operational_events.findMany({
        where: { organization_id: organizationId },
      }),
    );
    assert.doesNotMatch(rendered, /secret|bearer|provider payload/iu);
    assert.doesNotMatch(rendered, /production-(?:us|eu)/u);
  } finally {
    await harness.close();
  }
});
