import assert from "node:assert/strict";
import test from "node:test";
import {
  ManifestPromotionOperationalReadinessSink,
  ProviderPromotionOperationalReadinessSink,
} from "./promotion-v2-operational-readiness.ts";

test("provider readiness remains platform-scoped and uses checkpoint target", async () => {
  const calls: unknown[] = [];
  const events: unknown[] = [];
  const sink = new ProviderPromotionOperationalReadinessSink({
    assess() { calls.push("assess"); return Promise.resolve(); },
    publicationFailed(input) { calls.push(input); return Promise.resolve(); },
  }, { write: (event) => events.push(event) }, "worker-1", {
    now: () => new Date("2026-08-16T12:00:00.000Z"),
  });
  await sink.report({
    platformKey: "alpha",
    lifecycleState: "active",
    settledCheckpoint: 30n,
    sourceHeadCheckpoint: 31n,
    requestedEvaluationSequence: 4n,
    confirmedEvaluationSequence: 3n,
    completedCheckpoint: 20n,
    completedPublicProviderReleaseId: null,
    activeCheckpoint: 15n,
    activePublicProviderReleaseId: null,
    activeManifestPublicReleaseId: null,
    activeAttemptId: null,
    activeAttemptState: "retry_wait",
    activeAttemptStartedAt: new Date("2026-08-16T11:59:50.000Z"),
    retryAt: new Date("2026-08-16T12:00:01.000Z"),
    completedAt: new Date("2026-08-16T11:59:00.000Z"),
  });
  await sink.notify({
    platformKey: "alpha",
    attemptId: "51000000-0000-4000-8000-000000000001",
    evaluationSequence: 7n,
    targetCheckpoint: 20n,
    failureCode: "PROVIDER_RELEASE_STATE_CONFLICT",
    occurredAt: new Date(),
  });
  assert.deepEqual(calls, [
    "assess",
    {
      attemptId: "51000000-0000-4000-8000-000000000001",
      targetWatermark: 20n,
      failureCode: "PROVIDER_RELEASE_STATE_CONFLICT",
    },
  ]);
  assert.deepEqual(events, [{
    level: "info",
    event: "promotion_v2_provider_health",
    workerId: "worker-1",
    platformKey: "alpha",
    lifecycleState: "active",
    settledCheckpoint: "30",
    sourceHeadCheckpoint: "31",
    completedCheckpoint: "20",
    activeCheckpoint: "15",
    checkpointLag: "10",
    completedLag: "10",
    activeLag: "15",
    requestedEvaluationSequence: "4",
    confirmedEvaluationSequence: "3",
    activeAttemptState: "retry_wait",
    activeAttemptStartedAt: "2026-08-16T11:59:50.000Z",
    activeAttemptAgeSeconds: 10,
    retryAt: "2026-08-16T12:00:01.000Z",
    completedAt: "2026-08-16T11:59:00.000Z",
  }]);
});

test("disabled provider health does not report intentional omission as active lag", async () => {
  const events: unknown[] = [];
  const sink = new ProviderPromotionOperationalReadinessSink(
    { assess: () => Promise.resolve(), publicationFailed: () => Promise.resolve() },
    { write: (event) => events.push(event) },
    "worker-1",
  );
  await sink.report({
    platformKey: "alpha",
    lifecycleState: "disabled",
    settledCheckpoint: 30n,
    sourceHeadCheckpoint: 30n,
    requestedEvaluationSequence: 4n,
    confirmedEvaluationSequence: 3n,
    completedCheckpoint: 20n,
    completedPublicProviderReleaseId: null,
    activeCheckpoint: null,
    activePublicProviderReleaseId: null,
    activeManifestPublicReleaseId: null,
    activeAttemptId: null,
    activeAttemptState: null,
    activeAttemptStartedAt: null,
    retryAt: null,
    completedAt: null,
  });
  assert.deepEqual(events, [{
    level: "info",
    event: "promotion_v2_provider_health",
    workerId: "worker-1",
    platformKey: "alpha",
    lifecycleState: "disabled",
    settledCheckpoint: "30",
    sourceHeadCheckpoint: "30",
    completedCheckpoint: "20",
    checkpointLag: "10",
    completedLag: "10",
    activeLag: "0",
    requestedEvaluationSequence: "4",
    confirmedEvaluationSequence: "3",
  }]);
});

test("manifest readiness uses monotonic evaluation sequence", async () => {
  const calls: unknown[] = [];
  const events: unknown[] = [];
  const sink = new ManifestPromotionOperationalReadinessSink({
    assess() { calls.push("assess"); return Promise.resolve(); },
    publicationFailed(input) { calls.push(input); return Promise.resolve(); },
  }, { write: (event) => events.push(event) }, "worker-1", {
    now: () => new Date("2026-08-16T12:00:02.000Z"),
  });
  await sink.report({
    bootstrapState: "verified_active",
    requestedEvaluationSequence: 12n,
    confirmedEvaluationSequence: 11n,
    activeGeneration: 8n,
    activePublicReleaseId: "71000000-0000-5000-8000-000000000001",
    activeConfigurationEpochSequence: 20n,
    delayedProviderCount: 1,
    activeAttemptId: "51000000-0000-4000-8000-000000000003",
    activeAttemptState: "in_progress",
    activeAttemptStartedAt: new Date("2026-08-16T11:59:57.000Z"),
    retryAt: null,
    lastActivatedAt: new Date("2026-08-16T12:00:00.000Z"),
    lastReconciledAt: new Date("2026-08-16T12:00:02.000Z"),
  });
  await sink.notify({
    attemptId: "51000000-0000-4000-8000-000000000002",
    evaluationSequence: 12n,
    failureCode: "CATALOG_MANIFEST_STATE_CONFLICT",
    occurredAt: new Date(),
  });
  assert.deepEqual(calls, [
    "assess",
    {
      attemptId: "51000000-0000-4000-8000-000000000002",
      targetWatermark: 12n,
      failureCode: "CATALOG_MANIFEST_STATE_CONFLICT",
    },
  ]);
  assert.deepEqual(events, [{
    level: "info",
    event: "promotion_v2_manifest_health",
    workerId: "worker-1",
    bootstrapState: "verified_active",
    requestedEvaluationSequence: "12",
    confirmedEvaluationSequence: "11",
    activeGeneration: "8",
    activePublicReleaseId: "71000000-0000-5000-8000-000000000001",
    activeConfigurationEpochSequence: "20",
    delayedProviderCount: 1,
    activeAttemptState: "in_progress",
    activeAttemptStartedAt: "2026-08-16T11:59:57.000Z",
    activeAttemptAgeSeconds: 5,
    lastActivatedAt: "2026-08-16T12:00:00.000Z",
    lastReconciledAt: "2026-08-16T12:00:02.000Z",
  }]);
});

test("health output clamps unsafe identities, counts, timestamps, and secrets", async () => {
  const events: unknown[] = [];
  const sink = new ProviderPromotionOperationalReadinessSink(
    { assess: () => Promise.resolve(), publicationFailed: () => Promise.resolve() },
    { write: (event) => events.push(event) },
    "worker\nsecret-token",
  );
  await sink.report({
    platformKey: "alpha\nsecret-token",
    lifecycleState: null,
    settledCheckpoint: -1n,
    sourceHeadCheckpoint: -2n,
    requestedEvaluationSequence: -3n,
    confirmedEvaluationSequence: -4n,
    completedCheckpoint: -5n,
    completedPublicProviderReleaseId: "secret-token",
    activeCheckpoint: -6n,
    activePublicProviderReleaseId: "secret-token",
    activeManifestPublicReleaseId: "secret-token",
    activeAttemptId: "secret-token",
    activeAttemptState: "secret token",
    activeAttemptStartedAt: new Date(Number.NaN),
    retryAt: new Date(Number.NaN),
    completedAt: null,
  });
  const rendered = JSON.stringify(events);
  assert.equal(rendered.includes("secret-token"), false);
  assert.match(rendered, /"workerId":"invalid"/u);
  assert.match(rendered, /"platformKey":"invalid"/u);
  assert.match(rendered, /"lifecycleState":"unknown"/u);
  assert.match(rendered, /"activeLag":"0"/u);
  assert.match(rendered, /"completedCheckpoint":"0"/u);
});
