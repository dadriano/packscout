import assert from "node:assert/strict";
import { test } from "node:test";
import type { OperationalNotification } from "@packscout/contracts";
import { PrismaAdminNotificationPublisher } from "./operational-alert-repository.ts";
import { PrismaPromotionReadinessRepository } from "./promotion-readiness-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const organizationId = "53000000-0000-4000-8000-000000000001";
const otherOrganizationId = "53000000-0000-4000-8000-000000000002";
const attemptId = "53000000-0000-4000-8000-000000000003";
const now = new Date("2026-08-15T12:01:00.000Z");

function event(
  id: string,
  kind: "promotion_activation_delayed" | "promotion_failed" | "promotion_recovered",
): OperationalNotification {
  const common = {
    id,
    organizationId,
    severity: kind === "promotion_recovered" ? "info" as const : "critical" as const,
    providerId: null,
    runId: null,
    quarantineId: null,
    recoveryKey: "promotion:catalog:health",
    occurredAt: now.toISOString(),
  };
  if (kind === "promotion_activation_delayed") {
    return {
      ...common,
      kind,
      severity: "warning",
      dedupeKey: "promotion:catalog:activation-delayed",
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
      dedupeKey: "promotion:catalog:failed",
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
    dedupeKey: "promotion:catalog:recovered",
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

test("promotion diagnostics and durable recovery remain scoped to one organization and lane", async () => {
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
      data: [organizationId, otherOrganizationId].map((organization, index) => ({
        organization_id: organization,
        deployment_key: "production-us",
        lane_key: "catalog",
        bootstrap_state: "verified_local",
        bootstrap_verified_at: now,
        settled_watermark: index === 0 ? 2n : 99n,
        settled_at: now,
        requested_watermark: index === 0 ? 2n : 99n,
        requested_at: now,
        confirmed_watermark: index === 0 ? 1n : 99n,
        confirmed_publication_identity: `release-${index}`,
        confirmed_receipt_sha256: String(index + 1).repeat(64),
        last_activated_watermark: index === 0 ? 1n : 99n,
        last_activated_at: now,
      })),
    });
    await harness.client.promotion_attempts.create({
      data: {
        id: attemptId,
        organization_id: organizationId,
        deployment_key: "production-us",
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

    const publisher = new PrismaAdminNotificationPublisher(harness.client);
    assert.equal((await publisher.publish(event(
      "53000000-0000-4000-8000-000000000010",
      "promotion_activation_delayed",
    ))).status, "accepted");
    assert.equal((await publisher.publish(event(
      "53000000-0000-4000-8000-000000000011",
      "promotion_failed",
    ))).status, "accepted");

    const diagnostic = await new PrismaPromotionReadinessRepository(
      harness.client,
      {
        organizationId,
        deploymentKey: "production-us",
        lane: "catalog",
      },
    ).load();
    assert.deepEqual(diagnostic, {
      activeAlertCount: 2,
      activeFailureAlertCount: 1,
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

    assert.equal((await publisher.publish(event(
      "53000000-0000-4000-8000-000000000012",
      "promotion_recovered",
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
  } finally {
    await harness.close();
  }
});
