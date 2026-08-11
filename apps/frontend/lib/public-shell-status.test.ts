import assert from "node:assert/strict";
import { test } from "node:test";
import { publicReadError } from "@packscout/contracts";
import { buildDemoDashboard } from "./catalog-demo-data.server";
import { snapshotStatusFromPublicResult } from "./public-shell-status";

test("shell status maps only complete public metadata and never invents freshness", () => {
  assert.deepEqual(snapshotStatusFromPublicResult(publicReadError("SNAPSHOT_UNAVAILABLE")), {
    state: "unavailable",
  });
  const metadata = buildDemoDashboard().metadata;
  assert.deepEqual(snapshotStatusFromPublicResult({ ok: true, data: { metadata } }), {
    state: "fresh",
    updatedAt: metadata.lastSuccessfulObservationAt,
  });
});
