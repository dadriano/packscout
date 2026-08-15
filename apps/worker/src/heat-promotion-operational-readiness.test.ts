import assert from "node:assert/strict";
import { test } from "node:test";
import { HeatPromotionOperationalReadinessSink } from "./heat-promotion-operational-readiness.ts";

test("Heat readiness bridge forwards only generic health and terminal signals", async () => {
  let assessments = 0;
  const failures: unknown[] = [];
  const sink = new HeatPromotionOperationalReadinessSink({
    async assess() {
      assessments += 1;
    },
    async publicationFailed(input) {
      failures.push(input);
    },
  });
  await sink.report({
    settledWatermark: 11n,
    requestedWatermark: 12n,
    confirmedWatermark: 11n,
    confirmedPublicationIdentity: "55000000-0000-4000-8000-000000000001",
    activeAttemptId: null,
    activeAttemptState: null,
    retryAt: null,
    lastActivatedAt: new Date("2026-08-15T12:00:00.000Z"),
    lastUnchangedObservedAt: null,
  });
  await sink.notify({
    attemptId: "55000000-0000-4000-8000-000000000002",
    frameSequence: 12n,
    failureCode: "PUBLICATION_RECONCILIATION_FAILED",
    occurredAt: new Date("2026-08-15T12:01:00.000Z"),
  });
  assert.equal(assessments, 1);
  assert.deepEqual(failures, [{
    attemptId: "55000000-0000-4000-8000-000000000002",
    targetWatermark: 12n,
    failureCode: "PUBLICATION_RECONCILIATION_FAILED",
  }]);
});
