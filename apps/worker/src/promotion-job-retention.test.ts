import assert from "node:assert/strict";
import test from "node:test";
import { PromotionJobRetentionCoordinator } from
  "./promotion-job-retention.ts";

const now = new Date("2026-09-01T12:00:00.000Z");

test("runs release, authority pruning, and central projection pruning in order", async () => {
  const calls: string[] = [];
  const coordinator = new PromotionJobRetentionCoordinator({
    maximumRows: 25,
    protectionRelease: {
      async releasePrunableRetentionProtection(input) {
        calls.push(`release:${input.maximumRows}:${input.now.toISOString()}`);
        return { released: 2, moreEligible: false };
      },
    },
    invocations: {
      async prune(input) {
        calls.push(`invocations:${input.maximumRows}:${input.now.toISOString()}`);
        return {
          invocationSummariesDeleted: 3,
          tombstonesDeleted: 4,
          moreEligibleSummaries: false,
          moreExpiredTombstones: true,
        };
      },
    },
    projections: {
      async pruneScheduled(input) {
        calls.push(`projections:${input.maximumRows}:${input.now.toISOString()}`);
        return { deleted: 5, moreEligible: false };
      },
    },
  });

  assert.deepEqual(await coordinator.runCycle(now), {
    protectionsReleased: 2,
    invocationSummariesDeleted: 3,
    tombstonesDeleted: 4,
    providerProjectionsDeleted: 5,
    moreEligible: true,
  });
  assert.deepEqual(calls, [
    "release:25:2026-09-01T12:00:00.000Z",
    "invocations:25:2026-09-01T12:00:00.000Z",
    "projections:25:2026-09-01T12:00:00.000Z",
  ]);
});

test("provider-only cycles never release protection before relay acknowledgement", async () => {
  let pruneCalls = 0;
  const coordinator = new PromotionJobRetentionCoordinator({
    invocations: {
      async prune() {
        pruneCalls += 1;
        return {
          invocationSummariesDeleted: 0,
          tombstonesDeleted: 0,
          moreEligibleSummaries: false,
          moreExpiredTombstones: false,
        };
      },
    },
  });

  assert.deepEqual(await coordinator.runCycle(now), {
    protectionsReleased: 0,
    invocationSummariesDeleted: 0,
    tombstonesDeleted: 0,
    providerProjectionsDeleted: 0,
    moreEligible: false,
  });
  assert.equal(pruneCalls, 1);
});

test("rejects unbounded batches and invalid cycle time", async () => {
  const invocations = {
    async prune() {
      throw new Error("must not run");
    },
  };
  assert.throws(
    () => new PromotionJobRetentionCoordinator({
      invocations,
      maximumRows: 1_001,
    }),
    /bounds are invalid/u,
  );
  await assert.rejects(
    new PromotionJobRetentionCoordinator({ invocations }).runCycle(
      new Date(Number.NaN),
    ),
    /time is invalid/u,
  );
});
