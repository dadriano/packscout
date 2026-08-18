import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperationalNotification } from "@packscout/contracts";
import { PrismaAdminNotificationPublisher } from "./operational-alert-repository.ts";
import {
  PrismaPromotionReadinessRepository,
  promotionDeploymentScopeDigest,
} from "./promotion-readiness-repository.ts";
import { promotionV2Sha256 } from "./promotion-v2-types.ts";
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
  const alertScope = `promotion:${deploymentScopeDigest}:heat`;
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
        lane: "heat",
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
        lane: "heat",
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
      lane: "heat",
      condition: "recovered",
      targetWatermark: "2",
      confirmedWatermark: "2",
      outcome: "PROMOTION_RECOVERED",
    },
  };
}

function providerEvent(
  id: string,
  platformKey: string,
  kind: "promotion_failed" | "promotion_settlement_blocked" | "promotion_recovered",
  deploymentScopeDigest: string,
): OperationalNotification {
  const alertScope =
    `promotion:${deploymentScopeDigest}:provider:${platformKey}`;
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
  if (kind === "promotion_failed") {
    return {
      ...common,
      kind,
      dedupeKey: `${alertScope}:failed`,
      title: "Provider publication reconciliation failed",
      summary: "Provider publication lost its exact predecessor comparison.",
      evidence: {
        lane: "provider",
        platformKey,
        condition: "reconciliation_failure",
        targetWatermark: "1",
        confirmedWatermark: "0",
        attemptId,
        failureCode: "PROVIDER_RELEASE_STATE_CONFLICT",
      },
    };
  }
  if (kind === "promotion_settlement_blocked") {
    return {
      ...common,
      kind,
      severity: "warning",
      dedupeKey: `${alertScope}:settlement-blocked`,
      title: "Provider settlement is blocked",
      summary: "An affected provider derivation has a technical failure.",
      evidence: {
        lane: "provider",
        platformKey,
        condition: "settlement_blocked",
        targetWatermark: "2",
        confirmedWatermark: "0",
        count: 1,
      },
    };
  }
  return {
    ...common,
    kind,
    dedupeKey: `${alertScope}:recovered`,
    title: "Provider publication recovered",
    summary: "The provider lane is fully confirmed and has no technical block.",
    evidence: {
      lane: "provider",
      platformKey,
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
    await harness.client.$transaction(async (transaction) => {
      await transaction.settled_public_watermarks.create({
        data: {
          organization_id: organizationId,
          next_sequence: 3n,
          settled_sequence: 1n,
          source_head_sequence: 2n,
          settled_at: new Date("2026-08-15T11:59:00.000Z"),
          source_head_at: new Date("2026-08-15T11:59:30.000Z"),
        },
      });
      await transaction.public_change_causes.createMany({
        data: [1n, 2n].map((sequence) => ({
          organization_id: organizationId,
          sequence,
          change_kind: "provider_projection" as const,
          entity_key: `canonical:v1:${sequence}`,
          occurred_at: now,
          authoritative_transaction_id: `test:${sequence}`,
        })),
      });
      await transaction.public_change_catalog_impacts.createMany({
        data: [1n, 2n].map((sequence) => ({
          organization_id: organizationId,
          cause_sequence: sequence,
          provider_platform_keys: [],
          created_at: now,
        })),
      });
      await transaction.public_derivation_obligations.create({
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
    });
    await harness.client.promotion_lanes.createMany({
      data: [
        {
          organization_id: organizationId,
          deployment_key: deploymentKey,
          lane_key: "heat",
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
          lane_key: "heat",
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
          lane_key: "heat",
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
        lane_key: "heat",
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
      { organizationId, deploymentKey, lane: "heat" },
    );
    const otherDeploymentRepository = new PrismaPromotionReadinessRepository(
      harness.client,
      {
        organizationId,
        deploymentKey: otherDeploymentKey,
        lane: "heat",
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
      activationConfirmedWatermark: 1n,
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
      activationConfirmedWatermark: 6n,
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

test("provider diagnostics isolate platform obligations, cas losses, and recovery", async () => {
  const harness = await createMigratedTestDatabase();
  const alphaPlatformKey = "alpha-platform";
  const betaPlatformKey = "beta-platform";
  const checkpointBody = "{}";
  const checkpointSha256 = "a".repeat(64);
  try {
    await harness.client.organizations.create({
      data: {
        id: organizationId,
        slug: "provider-readiness",
        name: "Provider Readiness",
      },
    });
    await harness.client.$transaction(async (transaction) => {
      const providerSetBody = JSON.stringify([
        alphaPlatformKey,
        betaPlatformKey,
      ]);
      const bootstrapProofBody = "{}";
      const emptyActiveStateBody = JSON.stringify({
        generation: 0,
        activeManifest: null,
        previousManifest: null,
        observation: null,
        terminalReceiptSha256: null,
      });
      await transaction.manifest_promotion_lanes.create({
        data: {
          organization_id: organizationId,
          deployment_key: deploymentKey,
        },
      });
      await transaction.catalog_promotion_bootstrap_proofs.create({
        data: {
          organization_id: organizationId,
          deployment_key: deploymentKey,
          proof_revision: 1n,
          proof_kind: "empty",
          active_state_request_body: bootstrapProofBody,
          active_state_request_sha256: promotionV2Sha256(bootstrapProofBody),
          active_state_receipt_body: bootstrapProofBody,
          active_state_receipt_sha256: promotionV2Sha256(bootstrapProofBody),
          active_state_body: emptyActiveStateBody,
          active_state_sha256: promotionV2Sha256(emptyActiveStateBody),
          verified_at: now,
        },
      });
      await transaction.manifest_promotion_lanes.update({
        where: {
          organization_id_deployment_key: {
            organization_id: organizationId,
            deployment_key: deploymentKey,
          },
        },
        data: {
          bootstrap_state: "verified_empty",
          bootstrap_verified_at: now,
          bootstrap_provider_set_body: providerSetBody,
          bootstrap_provider_set_sha256: promotionV2Sha256(providerSetBody),
          current_bootstrap_proof_revision: 1n,
          active_state_body: emptyActiveStateBody,
          active_state_sha256: promotionV2Sha256(emptyActiveStateBody),
          active_state_receipt_body: bootstrapProofBody,
          active_state_receipt_sha256: promotionV2Sha256(bootstrapProofBody),
          last_reconciled_at: now,
        },
      });
      await transaction.settled_public_watermarks.create({
        data: {
          organization_id: organizationId,
          next_sequence: 3n,
          settled_sequence: 1n,
          source_head_sequence: 2n,
          settled_at: now,
          source_head_at: now,
        },
      });
      await transaction.public_change_causes.createMany({
        data: [1n, 2n].map((sequence) => ({
          organization_id: organizationId,
          sequence,
          change_kind: "provider_projection" as const,
          entity_key: `provider:v1:${sequence}`,
          occurred_at: now,
          authoritative_transaction_id: `provider-test:${sequence}`,
        })),
      });
      await transaction.provider_sources.create({
        data: {
          organization_id: organizationId,
          platform_key: alphaPlatformKey,
          display_name: "Alpha",
        },
      });
      await transaction.public_change_catalog_impacts.createMany({
        data: [
          {
            organization_id: organizationId,
            cause_sequence: 1n,
            provider_platform_keys: [alphaPlatformKey],
            lifecycle_platform_key: alphaPlatformKey,
            lifecycle_state: "active",
            created_at: now,
          },
          {
            organization_id: organizationId,
            cause_sequence: 2n,
            provider_platform_keys: [betaPlatformKey],
            created_at: now,
          },
        ],
      });
      await transaction.catalog_manifest_lifecycle_checkpoints.create({
        data: {
          organization_id: organizationId,
          settled_sequence: 1n,
          source_head_sequence: 1n,
          settled_at: now,
          source_head_at: now,
          updated_at: now,
        },
      });
      await transaction.public_derivation_obligations.create({
        data: {
          organization_id: organizationId,
          cause_sequence: 2n,
          derivation_kind: "estimated_ev",
          derivation_key: "ev:v1:beta-blocked",
          state: "technical_failure",
          outcome_classification: "technical_failure",
          outcome_reason_code: "CALCULATION_TIMEOUT",
          acknowledged_claim_token: "53000000-0000-4000-8000-000000000004",
          outcome_at: now,
        },
      });
      await transaction.provider_promotion_lanes.createMany({
        data: [alphaPlatformKey, betaPlatformKey].map((platformKey) => ({
          organization_id: organizationId,
          deployment_key: deploymentKey,
          platform_key: platformKey,
          next_evaluation_sequence: platformKey === alphaPlatformKey ? 1n : 0n,
          requested_evaluation_sequence: platformKey === alphaPlatformKey ? 1n : 0n,
          requested_at: platformKey === alphaPlatformKey ? now : null,
          latest_checkpoint_body: platformKey === alphaPlatformKey
            ? checkpointBody
            : null,
          latest_checkpoint_sha256: platformKey === alphaPlatformKey
            ? checkpointSha256
            : null,
          settled_checkpoint: 1n,
          settled_at: now,
          source_head_checkpoint: 2n,
          source_head_at: now,
        })),
      });
      await transaction.provider_promotion_evaluations.create({
        data: {
          organization_id: organizationId,
          deployment_key: deploymentKey,
          platform_key: alphaPlatformKey,
          evaluation_sequence: 1n,
          checkpoint_body: checkpointBody,
          checkpoint_sha256: checkpointSha256,
          settled_checkpoint: 1n,
          source_head_checkpoint: 2n,
          requested_at: now,
        },
      });
      await transaction.provider_promotion_attempts.create({
        data: {
          id: attemptId,
          organization_id: organizationId,
          deployment_key: deploymentKey,
          platform_key: alphaPlatformKey,
          evaluation_sequence: 1n,
          bootstrap_proof_revision: 1n,
          bootstrap_provider_set_sha256: promotionV2Sha256(providerSetBody),
          target_checkpoint: 1n,
          state: "cas_lost",
          failure_class: "reconciliation",
          failure_code: "PROVIDER_RELEASE_STATE_CONFLICT",
          cas_error_body: "{}",
          cas_error_sha256: "b".repeat(64),
          terminal_at: now,
        },
      });
    });

    const alpha = new PrismaPromotionReadinessRepository(harness.client, {
      organizationId,
      deploymentKey,
      lane: "provider",
      platformKey: alphaPlatformKey,
    });
    const beta = new PrismaPromotionReadinessRepository(harness.client, {
      organizationId,
      deploymentKey,
      lane: "provider",
      platformKey: betaPlatformKey,
    });
    assert.notEqual(alpha.alertLaneKey, beta.alertLaneKey);
    assert.throws(
      () => new PrismaPromotionReadinessRepository(harness.client, {
        organizationId,
        deploymentKey,
        lane: "provider",
        platformKey: "ALPHA/unsafe",
      }),
      /readiness scope/u,
    );

    const publisher = new PrismaAdminNotificationPublisher(harness.client);
    await publisher.publish(providerEvent(
      "53000000-0000-4000-8000-000000000020",
      alphaPlatformKey,
      "promotion_failed",
      alpha.deploymentScopeDigest,
    ));
    await publisher.publish(providerEvent(
      "53000000-0000-4000-8000-000000000021",
      betaPlatformKey,
      "promotion_settlement_blocked",
      beta.deploymentScopeDigest,
    ));

    assert.deepEqual(await alpha.load(), {
      activeAlertCount: 1,
      activeFailureAlertCount: 1,
      activeFailureAttemptId: attemptId,
      canonicalSettledWatermark: 1n,
      canonicalSettledAt: now,
      canonicalSourceHeadWatermark: 2n,
      activationConfirmedWatermark: 0n,
      confirmedWatermark: 0n,
      laneTargetWatermark: 1n,
      laneTargetAt: now,
      latestFailedAttemptId: attemptId,
      latestFailedWatermark: 1n,
      latestFailureCode: "PROVIDER_RELEASE_STATE_CONFLICT",
      technicalFailureCount: 0,
    });
    const betaDiagnostic = await beta.load();
    assert.equal(betaDiagnostic.activeAlertCount, 1);
    assert.equal(betaDiagnostic.activeFailureAlertCount, 0);
    assert.equal(betaDiagnostic.latestFailedAttemptId, null);
    assert.equal(betaDiagnostic.technicalFailureCount, 1);
    assert.equal(betaDiagnostic.activationConfirmedWatermark, 1n);
    assert.equal(betaDiagnostic.confirmedWatermark, 1n);

    assert.equal((await publisher.publish(providerEvent(
      "53000000-0000-4000-8000-000000000022",
      alphaPlatformKey,
      "promotion_recovered",
      alpha.deploymentScopeDigest,
    ))).status, "resolved");
    assert.equal((await alpha.load()).activeAlertCount, 0);
    assert.equal((await beta.load()).activeAlertCount, 1);

    await harness.client.$transaction(async (transaction) => {
      await transaction.public_change_causes.create({
        data: {
          organization_id: organizationId,
          sequence: 3n,
          change_kind: "provider_lifecycle",
          entity_key: "provider:lifecycle:alpha-disabled",
          occurred_at: now,
          authoritative_transaction_id: "provider-test:3",
        },
      });
      await transaction.public_change_catalog_impacts.create({
        data: {
          organization_id: organizationId,
          cause_sequence: 3n,
          provider_platform_keys: [],
          lifecycle_platform_key: alphaPlatformKey,
          lifecycle_state: "disabled",
          created_at: now,
        },
      });
      await transaction.catalog_manifest_lifecycle_checkpoints.update({
        where: { organization_id: organizationId },
        data: {
          settled_sequence: 3n,
          source_head_sequence: 3n,
          settled_at: now,
          source_head_at: now,
          updated_at: now,
        },
      });
      await transaction.provider_promotion_lanes.update({
        where: {
          organization_id_deployment_key_platform_key: {
            organization_id: organizationId,
            deployment_key: deploymentKey,
            platform_key: alphaPlatformKey,
          },
        },
        data: {
          settled_checkpoint: 3n,
          source_head_checkpoint: 3n,
          settled_at: now,
          source_head_at: now,
        },
      });
    });
    const disabledDiagnostic = await alpha.load();
    assert.equal(disabledDiagnostic.confirmedWatermark, 3n);
    assert.equal(disabledDiagnostic.activationConfirmedWatermark, 3n);
  } finally {
    await harness.close();
  }
});
