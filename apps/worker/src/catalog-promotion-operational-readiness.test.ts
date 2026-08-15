import assert from "node:assert/strict";
import { test } from "node:test";
import { CatalogPromotionOperationalReadinessSink } from "./catalog-promotion-operational-readiness.ts";

test("catalog readiness bridge forwards only generic health and terminal signals", async () => {
  let assessments = 0;
  const failures: unknown[] = [];
  const sink = new CatalogPromotionOperationalReadinessSink({
    async assess() {
      assessments += 1;
    },
    async publicationFailed(input) {
      failures.push(input);
    },
  });
  await sink.report({
    settledWatermark: 4n,
    requestedWatermark: 4n,
    activeAttempt: null,
    lastActivatedWatermark: 3n,
    lastActivatedAt: new Date("2026-08-15T12:00:00.000Z"),
    lastUnchangedWatermark: null,
    lastUnchangedAt: null,
    retryAt: null,
    delayedVendorCount: 0,
  });
  await sink.notify({
    attemptId: "55000000-0000-4000-8000-000000000001",
    requestedWatermark: 4n,
    failureCode: "PUBLICATION_RESPONSE_INVALID",
    occurredAt: new Date("2026-08-15T12:01:00.000Z"),
  });
  assert.equal(assessments, 1);
  assert.deepEqual(failures, [{
    attemptId: "55000000-0000-4000-8000-000000000001",
    targetWatermark: 4n,
    failureCode: "PUBLICATION_RESPONSE_INVALID",
  }]);
});
