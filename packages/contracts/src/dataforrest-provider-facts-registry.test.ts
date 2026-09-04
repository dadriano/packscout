import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_CLUTCHPACKS_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_CATALOG_ADAPTER_V3_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_V2_VERSION,
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_LAUNCH_DISTRIBUTED_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_V2_VERSION,
  DATAFORREST_PHYGITALS_CATALOG_ADAPTER_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION,
  DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION,
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
    ["courtyard", DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_VERSION],
    ["courtyard", DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION],
    ["courtyard", DATAFORREST_COURTYARD_CATALOG_ADAPTER_VERSION],
    ["phygitals", DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION],
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

/**
 * The catalog-scoped pack identities cannot serve production: their source
 * configuration pins stream "catalog", which stops pull and trade ingestion.
 * These distributed identities are the ones production can actually activate,
 * so each must resolve BOTH entities - a pack-only version would fix packs and
 * silently regress every card back to the display-name fallback.
 */
/**
 * Asserting only that a card reader resolves is not enough: pointing a v3 row at
 * an older card reader would silently regress that provider's reviewed native
 * interpretation while still returning kind "card". Each v3 must read a card
 * byte-identically to the distributed-v2 it inherits from.
 */
test("each new distributed version reads a card identically to its predecessor", () => {
  const inherited = [
    ["courtyard", DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
      DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION,
      { asset: { title: "Sample Card", front_image_url: "https://example.test/a.png" } }],
    ["phygitals", DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION,
      DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION,
      // Must use an inventory wrapper: V2 delegates chase/asset straight to V1,
      // so a chase payload cannot distinguish the two readers.
      { inventory: { title: "Sample Inventory Card" } }],
    ["phygitals", DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION,
      DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION,
      { inventory: { title: "Sample Inventory Card" } }],
    ["collector_crypt", DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
      DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V3_VERSION,
      { provider_label: "Sample Card" }],
  ] as const;
  for (const [provider, predecessor, successor, payload] of inherited) {
    assert.deepEqual(
      readDataforrestProviderFacts(successor, provider, "card", payload),
      readDataforrestProviderFacts(predecessor, provider, "card", payload),
      `${provider} v3 must read a card exactly as ${predecessor} does`,
    );
  }
});

test("each new distributed adapter version resolves both a card and a pack reader", () => {
  const distributedPackReaders = [
    ["courtyard", DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V3_VERSION],
    ["phygitals", DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V3_VERSION],
    ["phygitals", DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V4_VERSION],
    [
      "collector_crypt",
      DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V3_VERSION,
    ],
  ] as const;
  for (const [provider, adapterVersion] of distributedPackReaders) {
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
    // The identity stays provider-local and catalog-entity-local.
    for (const crossed of [
      "clutchpacks",
      "collector_crypt",
      "courtyard",
      "phygitals",
    ] as const) {
      if (crossed === provider) continue;
      assert.equal(
        readDataforrestProviderFacts(adapterVersion, crossed, "pack", {}),
        null,
        `${adapterVersion} must not read ${crossed} packs`,
      );
    }
    for (const kind of ["pull", "trade"] as const) {
      assert.equal(
        readDataforrestProviderFacts(adapterVersion, provider, kind, {}),
        null,
        `${adapterVersion} must leave ${kind} unmapped`,
      );
    }
  }
});

/**
 * The distributed versions production runs today are immutable admissions. A
 * pack row added to any of them would change how already-committed backfill
 * history normalizes.
 */
test("pre-existing distributed adapter versions gain no pack reader", () => {
  const frozenDistributed = [
    ["courtyard", DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_VERSION],
    ["courtyard", DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION],
    ["phygitals", DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_VERSION],
    ["phygitals", DATAFORREST_PHYGITALS_DISTRIBUTED_ADAPTER_V2_VERSION],
    ["collector_crypt", DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_VERSION],
    [
      "collector_crypt",
      DATAFORREST_COLLECTOR_CRYPT_DISTRIBUTED_ADAPTER_V2_VERSION,
    ],
  ] as const;
  for (const [provider, adapterVersion] of frozenDistributed) {
    assert.equal(
      readDataforrestProviderFacts(adapterVersion, provider, "pack", {}),
      null,
      `${provider} must NOT resolve a pack reader on frozen ${adapterVersion}`,
    );
  }
});
