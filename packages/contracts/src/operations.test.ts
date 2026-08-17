import assert from "node:assert/strict";
import { test } from "node:test";
import { operationalNotificationSchema } from "./operations.ts";

const event = {
  id: "40000000-0000-4000-8000-000000000001",
  organizationId: "40000000-0000-4000-8000-000000000002",
  kind: "run_failed",
  severity: "critical",
  providerId: "40000000-0000-4000-8000-000000000003",
  runId: "40000000-0000-4000-8000-000000000004",
  quarantineId: null,
  dedupeKey: "provider:failure:40000000-0000-4000-8000-000000000003",
  recoveryKey: "provider:health:40000000-0000-4000-8000-000000000003",
  title: "Provider import failed",
  summary: "The import stopped with a sanitized failure code.",
  evidence: { failureCode: "PROVIDER_IMPORT_FAILED", count: 1 },
  occurredAt: "2026-08-06T12:00:00.000Z",
} as const;

test("operational notifications accept only bounded allowlisted evidence", () => {
  assert.equal(operationalNotificationSchema.safeParse(event).success, true);
  assert.equal(
    operationalNotificationSchema.safeParse({
      ...event,
      evidence: { ...event.evidence, rawPayload: { token: "secret" } },
    }).success,
    false,
  );
  assert.equal(
    operationalNotificationSchema.safeParse({
      ...event,
      summary: "Authorization: Bearer should-never-be-stored",
    }).success,
    false,
  );
  assert.equal(
    operationalNotificationSchema.safeParse({
      ...event,
      evidence: { failureCode: "Bearer secret" },
    }).success,
    false,
  );
});

test("promotion notifications require lane-bound sanitized health evidence", () => {
  const promotion = {
    ...event,
    providerId: null,
    runId: null,
    kind: "promotion_failed",
    dedupeKey: "promotion:manifest:failed",
    recoveryKey: "promotion:manifest:health",
    title: "Catalog publication failed",
    summary: "Publication reconciliation reached a safe terminal failure.",
    evidence: {
      lane: "manifest",
      condition: "reconciliation_failure",
      targetWatermark: "42",
      confirmedWatermark: "41",
      attemptId: "40000000-0000-4000-8000-000000000005",
      failureCode: "PUBLICATION_RESPONSE_INVALID",
    },
  } as const;
  assert.equal(
    operationalNotificationSchema.safeParse(promotion).success,
    true,
  );
  assert.equal(
    operationalNotificationSchema.safeParse({
      ...promotion,
      evidence: { ...promotion.evidence, sourcePayload: "private" },
    }).success,
    false,
  );
  assert.equal(
    operationalNotificationSchema.safeParse({
      ...promotion,
      evidence: { ...promotion.evidence, targetWatermark: "-1" },
    }).success,
    false,
  );
  assert.equal(
    operationalNotificationSchema.safeParse({
      ...promotion,
      evidence: { ...promotion.evidence, actorHash: "a".repeat(64) },
    }).success,
    false,
  );
  assert.equal(
    operationalNotificationSchema.safeParse({
      ...promotion,
      kind: "promotion_recovered",
    }).success,
    false,
  );
  assert.equal(
    operationalNotificationSchema.safeParse({
      ...event,
      evidence: { ...event.evidence, lane: "manifest" },
    }).success,
    false,
  );
});

test("provider promotion evidence requires one canonical platform key", () => {
  const providerPromotion = {
    ...event,
    providerId: null,
    runId: null,
    kind: "promotion_failed",
    dedupeKey: "promotion:provider:alpha-platform:failed",
    recoveryKey: "promotion:provider:alpha-platform:health",
    title: "Provider publication failed",
    summary: "Provider publication reconciliation reached a safe terminal failure.",
    evidence: {
      lane: "provider",
      platformKey: "alpha-platform",
      condition: "reconciliation_failure",
      targetWatermark: "42",
      confirmedWatermark: "41",
      attemptId: "40000000-0000-4000-8000-000000000005",
      failureCode: "PROVIDER_RELEASE_STATE_CONFLICT",
    },
  } as const;
  assert.equal(
    operationalNotificationSchema.safeParse(providerPromotion).success,
    true,
  );
  for (const platformKey of ["ALPHA", "alpha/platform", "a".repeat(129)]) {
    assert.equal(
      operationalNotificationSchema.safeParse({
        ...providerPromotion,
        evidence: { ...providerPromotion.evidence, platformKey },
      }).success,
      false,
    );
  }
  assert.equal(
    operationalNotificationSchema.safeParse({
      ...providerPromotion,
      evidence: {
        ...providerPromotion.evidence,
        platformKey: undefined,
      },
    }).success,
    false,
  );
  assert.equal(
    operationalNotificationSchema.safeParse({
      ...providerPromotion,
      evidence: {
        ...providerPromotion.evidence,
        lane: "manifest",
      },
    }).success,
    false,
  );
});
