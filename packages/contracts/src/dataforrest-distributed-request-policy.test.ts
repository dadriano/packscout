import assert from "node:assert/strict";
import test from "node:test";
import {
  dataforrestEventsV1SourceAdapterManifest,
  dataforrestEventsV1SourceAdapterManifests,
  dataforrestEventsJsonNodeBudget,
} from "./dataforrest-events-v1.ts";
import { dataforrestDistributedRequestPolicy } from "./dataforrest-distributed-request-policy.ts";

test("distributed request capacity does not redefine historical defaults or byte/time/node admission", () => {
  const before = JSON.stringify(dataforrestEventsV1SourceAdapterManifests);
  let policies = 0;
  for (const manifest of dataforrestEventsV1SourceAdapterManifests) {
    for (const { provider } of manifest.supportedProviders) {
      const policy = dataforrestDistributedRequestPolicy(manifest.adapterVersion, provider);
      if (policy === null) continue;
      policies += 1;
      assert.equal(policy.maximumRecordsPerRequest, 5_000);
      assert.equal(policy.defaultRecordsPerRequest, manifest.requestBounds.pageLimit);
      assert.equal(policy.maximumResponseBytes, manifest.requestBounds.maximumResponseBytes);
      assert.equal(policy.timeoutMilliseconds, 10_000);
      assert.equal(dataforrestEventsJsonNodeBudget(manifest.adapterVersion),
        manifest.adapterVersion === "dataforrest-courtyard-distributed-adapter-v2" ? 640_000 : 480_000);
      assert.ok(Object.isFrozen(policy));
    }
  }
  assert.equal(policies, 9);
  assert.equal(JSON.stringify(dataforrestEventsV1SourceAdapterManifests), before);
  assert.equal(dataforrestDistributedRequestPolicy("dataforrest-phygitals-distributed-adapter-v2", "phygitals")?.defaultRecordsPerRequest, 100);
});

test("distributed capacity refuses shared adapters, unknown versions and cross-provider identities", () => {
  assert.equal(dataforrestDistributedRequestPolicy(dataforrestEventsV1SourceAdapterManifest.adapterVersion, "phygitals"), null);
  assert.equal(dataforrestDistributedRequestPolicy("dataforrest-phygitals-distributed-adapter-v3", "phygitals"), null);
  assert.equal(dataforrestDistributedRequestPolicy("dataforrest-phygitals-distributed-adapter-v2", "collector_crypt"), null);
});
