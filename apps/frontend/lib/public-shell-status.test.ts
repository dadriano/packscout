import assert from "node:assert/strict";
import { test } from "node:test";
import {
  publicReadError,
  type SnapshotMetadata,
} from "@packscout/contracts";
import { snapshotStatusFromPublicResult } from "./public-shell-status";

const metadata = {
  schemaVersion: "catalog_snapshot_v1",
  publicationId: "20000000-0000-4000-8000-000000000001",
  dataSource: "mock",
  sourceWatermark: "mock.catalog.v1",
  manifestFingerprint: "4".repeat(64),
  contentHash: "5".repeat(64),
  publicConfigRevision: 1,
  publicConfigHash: "6".repeat(64),
  originSetHash: "7".repeat(64),
  createdAt: "2026-08-11T11:57:00Z",
  completedAt: "2026-08-11T11:58:00Z",
  dataAsOf: "2026-08-11T11:52:00Z",
  lastSuccessfulObservationAt: "2026-08-11T12:00:00Z",
  staleAt: "2026-08-11T12:15:00Z",
  freshness: "fresh",
  delayedSourceCount: 0,
  platformConfigCount: 2,
  packCount: 9,
  searchAlgorithmVersion: "packscout_relevance_v1",
} satisfies SnapshotMetadata;

test("shell status maps only complete public metadata and never invents freshness", () => {
  assert.deepEqual(snapshotStatusFromPublicResult(publicReadError("SNAPSHOT_UNAVAILABLE")), {
    state: "unavailable",
  });
  assert.deepEqual(snapshotStatusFromPublicResult({ ok: true, data: { metadata } }), {
    state: "fresh",
    updatedAt: metadata.lastSuccessfulObservationAt,
    dataSource: "mock",
  });
});
