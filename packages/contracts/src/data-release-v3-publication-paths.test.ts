import assert from "node:assert/strict";
import test from "node:test";
import { productionDataReleaseV3PathSchema } from "./data-release-v2-publication-auth.ts";
import { PRODUCTION_DATA_RELEASE_V3_PATHS } from "./data-release-v3-publication-paths.ts";

test("the signed V3 path allowlist includes provider observation refresh", () => {
  assert.deepEqual(Object.keys(PRODUCTION_DATA_RELEASE_V3_PATHS).sort(), [
    "activate",
    "activeState",
    "applyBatch",
    "finalize",
    "refreshProviderObservation",
    "rollback",
    "start",
    "status",
  ]);
  assert.equal(
    PRODUCTION_DATA_RELEASE_V3_PATHS.refreshProviderObservation,
    "/internal/data-release/v3/refresh-provider-observation",
  );
  for (const path of Object.values(PRODUCTION_DATA_RELEASE_V3_PATHS)) {
    assert.equal(productionDataReleaseV3PathSchema.safeParse(path).success, true);
  }
});
