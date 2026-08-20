import assert from "node:assert/strict";
import { test } from "node:test";
import { DataReleaseV3ReleaseAssembler } from "./buyback-adjusted-ev-release-assembler.ts";
import {
  DataReleaseV3PublisherError,
  DataReleaseV3ReleasePublisher,
} from "./buyback-adjusted-ev-release-publisher.ts";
import type {
  DataReleaseV3CanonicalSnapshot,
  DataReleaseV3PublishPlan,
} from "./buyback-adjusted-ev-release-types.ts";
import {
  InMemoryDataReleaseV3Port,
  RELEASE_READ_AT,
  buildPublishableEligibility,
  buildReleaseProduct,
  buildReleaseSnapshot,
  buildUnavailableEligibility,
} from "./buyback-adjusted-ev-release.test-support.ts";

const REPACK_A = "00000000-0000-5000-8000-000000000301";
const REPACK_B = "00000000-0000-5000-8000-000000000302";

async function assemblePlan(
  snapshot: DataReleaseV3CanonicalSnapshot,
  gross = 12_000,
): Promise<DataReleaseV3PublishPlan> {
  const assembler = new DataReleaseV3ReleaseAssembler(
    { loadCatalogSnapshot: async () => snapshot },
    {
      getPublicationEligibleRevision: async () =>
        buildPublishableEligibility(gross),
    },
  );
  const plan = await assembler.assemble({ readAt: RELEASE_READ_AT });
  if (plan.classification !== "publish") {
    throw new Error(`expected publish plan, got ${plan.classification}`);
  }
  return plan;
}

function planOneSnapshot(): DataReleaseV3CanonicalSnapshot {
  return buildReleaseSnapshot([buildReleaseProduct({ publicRepackId: REPACK_A })]);
}

function planTwoSnapshot(): DataReleaseV3CanonicalSnapshot {
  return buildReleaseSnapshot([
    buildReleaseProduct({ publicRepackId: REPACK_A }),
    buildReleaseProduct({ publicRepackId: REPACK_B, name: "Second Pack" }),
  ]);
}

test("publishes one complete release: stage, reconcile, read back, activate", async () => {
  const port = new InMemoryDataReleaseV3Port();
  const publisher = new DataReleaseV3ReleasePublisher(port);
  const plan = await assemblePlan(planOneSnapshot());
  const outcome = await publisher.publish(plan);
  assert.equal(outcome.outcome, "activated");
  if (outcome.outcome !== "activated") return;
  assert.equal(outcome.publicReleaseId, plan.publicReleaseId);
  assert.equal(outcome.generation, 1);
  assert.equal(outcome.previousPublicReleaseId, null);
  assert.equal(port.state.activeRelease?.publicReleaseId, plan.publicReleaseId);
  assert.equal(
    port.state.activeRelease?.releaseFingerprint,
    plan.releaseFingerprint,
  );
});

test("identical replay is unchanged and never re-stages", async () => {
  const port = new InMemoryDataReleaseV3Port();
  const publisher = new DataReleaseV3ReleasePublisher(port);
  const plan = await assemblePlan(planOneSnapshot());
  await publisher.publish(plan);
  const generationBefore = port.state.generation;
  const replay = await publisher.publish(plan);
  assert.deepEqual(replay, {
    outcome: "unchanged",
    publicReleaseId: plan.publicReleaseId,
    releaseFingerprint: plan.releaseFingerprint,
  });
  assert.equal(port.state.generation, generationBefore);
});

test("a conflicting replay fails without moving the active pointer", async () => {
  const port = new InMemoryDataReleaseV3Port();
  const publisher = new DataReleaseV3ReleasePublisher(port);
  const plan = await assemblePlan(planOneSnapshot());
  await publisher.publish(plan);
  const conflicting: DataReleaseV3PublishPlan = {
    ...plan,
    releaseFingerprint: "4".repeat(64),
  };
  await assert.rejects(
    publisher.publish(conflicting),
    (error: unknown) =>
      error instanceof DataReleaseV3PublisherError &&
      error.stage === "start" &&
      error.code === "CONFLICTING_REPLAY",
  );
  assert.equal(port.state.activeRelease?.publicReleaseId, plan.publicReleaseId);
  assert.equal(
    port.state.activeRelease?.releaseFingerprint,
    plan.releaseFingerprint,
  );

  // A conflicting start against a non-active staged identity is refused
  // server-side before anything can activate.
  const different = await assemblePlan(planTwoSnapshot());
  const tamperedDifferent: DataReleaseV3PublishPlan = {
    ...different,
    publicReleaseId: different.publicReleaseId,
    releaseFingerprint: different.releaseFingerprint,
    manifest: { ...different.manifest, topChaseCount: 0 },
  };
  await assert.rejects(publisher.publish(tamperedDifferent));
  assert.equal(port.state.activeRelease?.publicReleaseId, plan.publicReleaseId);
});

test("a mid-stage failure never activates and a retry converges", async () => {
  const port = new InMemoryDataReleaseV3Port();
  const publisher = new DataReleaseV3ReleasePublisher(port);
  const plan = await assemblePlan(planOneSnapshot());
  port.failNextApplyBatch = true;
  await assert.rejects(
    publisher.publish(plan),
    (error: unknown) =>
      error instanceof DataReleaseV3PublisherError &&
      error.stage === "apply_batch",
  );
  const afterFailure = await port.activeState();
  assert.equal(afterFailure.activeRelease, null);
  const retried = await publisher.publish(plan);
  assert.equal(retried.outcome, "activated");
  const afterRetry = await port.activeState();
  assert.equal(afterRetry.activeRelease?.publicReleaseId, plan.publicReleaseId);
});

test("activation retains the predecessor and rollback restores it", async () => {
  const port = new InMemoryDataReleaseV3Port();
  const publisher = new DataReleaseV3ReleasePublisher(port);
  const planOne = await assemblePlan(planOneSnapshot());
  await publisher.publish(planOne);
  const planTwo = await assemblePlan(planTwoSnapshot(), 11_000);
  const outcome = await publisher.publish(planTwo);
  assert.equal(outcome.outcome, "activated");
  if (outcome.outcome !== "activated") return;
  assert.equal(outcome.previousPublicReleaseId, planOne.publicReleaseId);
  assert.equal(port.state.previousRelease?.publicReleaseId, planOne.publicReleaseId);

  await publisher.rollback({
    expectedActivePublicReleaseId: planTwo.publicReleaseId,
    targetPublicReleaseId: planOne.publicReleaseId,
  });
  assert.equal(port.state.activeRelease?.publicReleaseId, planOne.publicReleaseId);
  assert.equal(port.state.previousRelease?.publicReleaseId, planTwo.publicReleaseId);
});

test("a tampered transport receipt fails closed before activation", async () => {
  const port = new InMemoryDataReleaseV3Port();
  const publisher = new DataReleaseV3ReleasePublisher(port);
  const plan = await assemblePlan(planOneSnapshot());
  port.tamperNextReceipt = true;
  await assert.rejects(
    publisher.publish(plan),
    (error: unknown) =>
      error instanceof DataReleaseV3PublisherError &&
      error.code === "RECEIPT_INTEGRITY_FAILED",
  );
  assert.equal(port.state.activeRelease, null);
});

test("no pre-buyback estimate can enter a plan: only task-006 projections compose", async () => {
  // The eligibility port is the only EV source, and an unavailable projection
  // yields an explicit unavailable public state rather than any legacy value.
  const snapshot = planOneSnapshot();
  const assembler = new DataReleaseV3ReleaseAssembler(
    { loadCatalogSnapshot: async () => snapshot },
    {
      getPublicationEligibleRevision: async () =>
        buildUnavailableEligibility("PRICE_UNAVAILABLE"),
    },
  );
  const plan = await assembler.assemble({ readAt: RELEASE_READ_AT });
  assert.equal(plan.classification, "publish");
  if (plan.classification !== "publish") return;
  const detail = plan.batches.find(({ kind }) => kind === "repacks")!
    .records[0] as { evEstimates: { packScout: { status: string; reason?: string } } };
  assert.equal(detail.evEstimates.packScout.status, "unavailable");
  assert.equal(detail.evEstimates.packScout.reason, "PRICE_UNAVAILABLE");
});
