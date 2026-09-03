import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
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
  for (const adapterVersion of [
    DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
    DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
  ]) {
    assert.deepEqual(
      readDataforrestProviderFacts(
        adapterVersion,
        "collector_crypt",
        "card",
        { asset: { itemName: "Collector card" } },
      )?.displayName,
      { state: "present", value: "Collector card" },
    );
  }
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

/**
 * Pack readers are reachable ONLY through their own new adapter version. Without
 * this, deleting a pack row from the registry regresses every pack of that
 * provider back to the display-name fallback - which quarantines Courtyard
 * outright and hollows the other two - while the whole suite stays green.
 */
test("each new catalog adapter version resolves its provider's pack reader", () => {
  const packReaders = [
    ["courtyard", DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION],
    ["phygitals", DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION],
    ["collector_crypt", DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION],
  ] as const;
  for (const [provider, adapterVersion] of packReaders) {
    assert.equal(
      readDataforrestProviderFacts(adapterVersion, provider, "pack", {})?.kind,
      "pack",
      `${provider} must resolve a pack reader on ${adapterVersion}`,
    );
    assert.equal(
      readDataforrestProviderFacts(adapterVersion, provider, "card", {})?.kind,
      "card",
      `${provider} must keep its card reader on ${adapterVersion}`,
    );
  }
});

/**
 * Registered adapter versions are immutable admissions: a pack reader must never
 * appear on a version that already ran in production, because that would change
 * how already-committed history normalizes.
 */
test("pre-existing adapter versions gain no pack reader", () => {
  const frozen = [
    ["courtyard", DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION],
    ["courtyard", DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION],
    ["phygitals", DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION],
    ["phygitals", DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION],
    ["collector_crypt", DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION],
    ["collector_crypt", DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION],
    ["collector_crypt", DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION],
  ] as const;
  for (const [provider, adapterVersion] of frozen) {
    assert.equal(
      readDataforrestProviderFacts(adapterVersion, provider, "pack", {}),
      null,
      `${provider} must NOT resolve a pack reader on frozen ${adapterVersion}`,
    );
  }
});
