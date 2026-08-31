import assert from "node:assert/strict";
import test from "node:test";
import { readProviderRunRequestPin } from "./provider-run-request-pin.ts";

const authority = { configVersionId: "00000000-0000-4000-8000-000000000001", configVersionNumber: 4n };
const run = { ...authority, recordsPerRequest: 100,
  requestSettingsRevisionId: "00000000-0000-4000-8000-000000000002" };

test("execution retains an older run's request pin independently of mutable settings", () => {
  const newerRuntime = { ...authority, configuration: { recordsPerRequest: 1_000,
    requestSettingsRevisionId: "00000000-0000-4000-8000-000000000003" } };
  assert.deepEqual(readProviderRunRequestPin(run, newerRuntime), {
    recordsPerRequest: 100, requestSettingsRevisionId: run.requestSettingsRevisionId,
  });
});

test("unrecorded historical pins and mismatched run configuration fail closed without latest-value fallback", () => {
  for (const change of [
    { recordsPerRequest: null }, { requestSettingsRevisionId: null },
    { recordsPerRequest: 0 }, { recordsPerRequest: 5_001 },
    { requestSettingsRevisionId: "invalid" }, { configVersionNumber: 5n },
    { configVersionId: "00000000-0000-4000-8000-000000000004" },
  ]) assert.equal(readProviderRunRequestPin({ ...run, ...change }, authority), null);
});
