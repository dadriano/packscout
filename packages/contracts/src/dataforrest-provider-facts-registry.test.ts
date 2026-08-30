import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
} from "./dataforrest-events-v1-adapter-versions.ts";
import { readDataforrestProviderFacts } from
  "./dataforrest-provider-facts-registry.ts";

test("provider facts specializations follow the declared adapter versions", () => {
  assert.equal(
    readDataforrestProviderFacts(
      DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
      "clutchpacks",
      "card",
      {},
    )?.kind,
    "card",
  );
  assert.equal(
    readDataforrestProviderFacts(
      DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
      "clutchpacks",
      "card",
      {},
    )?.kind,
    "card",
  );
  assert.equal(
    readDataforrestProviderFacts(
      DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
      "clutchpacks",
      "pack",
      {},
    )?.kind,
    "pack",
  );
  assert.equal(
    readDataforrestProviderFacts(
      DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
      "clutchpacks",
      "pack",
      {},
    )?.kind,
    "pack",
  );
});

test("provider facts dispatch fails closed for an unknown adapter version", () => {
  assert.throws(
    () =>
      readDataforrestProviderFacts(
        "dataforrest-events-adapter-v4",
        "clutchpacks",
        "pack",
        {},
      ),
    {
      name: "RangeError",
      message: "dataforrest_events.adapter_version_unsupported",
    },
  );
});

test("supported generic facts tuples retain the documented fallback", () => {
  assert.equal(
    readDataforrestProviderFacts(
      DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
      "courtyard",
      "pack",
      {},
    ),
    null,
  );
  assert.equal(
    readDataforrestProviderFacts(
      DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
      "courtyard",
      "pack",
      {},
    ),
    null,
  );
});
