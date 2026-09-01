import assert from "node:assert/strict";
import { test } from "node:test";
import { publicReadError } from "@packscout/contracts";
import { dataReleaseStatusFromRecordUpdateResult } from "./public-release-status";

const latestCatalogRecordUpdatedAt = "2026-08-19T10:03:00.000Z";
const evaluatedAt = "2026-08-19T10:15:00.000Z";

test("shell status uses the newest catalog record timestamp", () => {
  assert.deepEqual(
    dataReleaseStatusFromRecordUpdateResult(
      publicReadError("RELEASE_UNAVAILABLE"),
    ),
    { state: "unavailable" },
  );
  assert.deepEqual(
    dataReleaseStatusFromRecordUpdateResult({
      ok: true,
      data: {
        schemaVersion: "data_release_v3",
        publicReleaseId: "10000000-0000-4000-8000-000000000001",
        latestCatalogRecordUpdatedAt,
        evaluatedAt,
      },
    }),
    {
      state: "available",
      updatedAt: latestCatalogRecordUpdatedAt,
      evaluatedAt,
    },
  );
  assert.deepEqual(
    dataReleaseStatusFromRecordUpdateResult(
      {
        ok: true,
        data: {
          schemaVersion: "data_release_v3",
          publicReleaseId: "10000000-0000-4000-8000-000000000001",
          latestCatalogRecordUpdatedAt,
          evaluatedAt,
        },
      },
      "10000000-0000-4000-8000-000000000002",
    ),
    { state: "unavailable" },
    "a parallel read from a different active release must fail closed",
  );
});
