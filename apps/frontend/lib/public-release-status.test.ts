import assert from "node:assert/strict";
import { test } from "node:test";
import { publicReadError } from "@packscout/contracts";
import {
  dataReleaseStatusFromPublicResult,
  dataReleaseStatusFromRelease,
} from "./public-release-status";
import { buildV3ReleaseIdentity } from "./packscout-ev-fixtures.test-support";

const release = buildV3ReleaseIdentity();
const staleAt = new Date(
  Date.parse(release.dataAsOf) + 60 * 60_000,
).toISOString();

test("release status maps the v3 identity and honors the EV freshness window", () => {
  assert.deepEqual(
    dataReleaseStatusFromPublicResult(publicReadError("RELEASE_UNAVAILABLE")),
    { state: "unavailable" },
  );
  assert.deepEqual(
    dataReleaseStatusFromRelease(
      release,
      Date.parse(release.dataAsOf) + 10 * 60_000,
    ),
    { state: "fresh", updatedAt: release.dataAsOf, staleAt },
  );
  assert.deepEqual(
    dataReleaseStatusFromRelease(release, Date.parse(staleAt)),
    { state: "delayed", updatedAt: release.dataAsOf, staleAt },
  );
  assert.deepEqual(
    dataReleaseStatusFromPublicResult({ ok: true, data: { release } }),
    dataReleaseStatusFromRelease(release),
  );
});
