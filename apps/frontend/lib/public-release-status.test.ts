import assert from "node:assert/strict";
import { test } from "node:test";
import {
  publicReadError,
  type DataReleaseMetadata,
} from "@packscout/contracts";
import {
  dataReleaseStatusFromMetadata,
  dataReleaseStatusFromPublicResult,
} from "./public-release-status";

const metadata = {
  schemaVersion: "data_release_v2",
  publicReleaseId: "20000000-0000-4000-8000-000000000001",
  dataSource: "mock",
  sourceWatermark: "mock.release.v2",
  manifestFingerprint: "4".repeat(64),
  contentHash: "5".repeat(64),
  publicConfigRevision: 1,
  publicConfigHash: "6".repeat(64),
  originSetHash: "7".repeat(64),
  repackSearchIndexHash: "8".repeat(64),
  createdAt: "2026-08-11T11:57:00Z",
  completedAt: "2026-08-11T11:58:00Z",
  dataAsOf: "2026-08-11T11:52:00Z",
  lastSuccessfulObservationAt: "2026-08-11T12:00:00Z",
  staleAt: "2026-08-11T12:15:00Z",
  freshness: "fresh",
  delayedVendorCount: 0,
  vendorCount: 2,
  categoryCount: 4,
  repackCount: 9,
  collectibleCount: 12,
  repackChaseCount: 16,
  searchAlgorithmVersion: "repack_search_v2",
  confidencePolicyVersion: "confidence-v1",
} satisfies DataReleaseMetadata;

test("release status maps complete metadata and honors its stale deadline", () => {
  assert.deepEqual(dataReleaseStatusFromPublicResult(publicReadError("RELEASE_UNAVAILABLE")), {
    state: "unavailable",
  });
  assert.deepEqual(dataReleaseStatusFromMetadata(metadata, Date.parse("2026-08-11T12:10:00Z")), {
    state: "fresh",
    updatedAt: metadata.lastSuccessfulObservationAt,
    staleAt: metadata.staleAt,
    dataSource: "mock",
  });
  assert.deepEqual(dataReleaseStatusFromMetadata(metadata, Date.parse(metadata.staleAt)), {
    state: "delayed",
    updatedAt: metadata.lastSuccessfulObservationAt,
    staleAt: metadata.staleAt,
    dataSource: "mock",
  });
});
