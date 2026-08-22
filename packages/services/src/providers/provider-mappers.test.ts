import assert from "node:assert/strict";
import { test } from "node:test";
import {
  beezieProviderMappingAdapter,
  BEEZIE_MAPPING_KEY,
  BEEZIE_PLATFORM_KEY,
} from "./beezie/mapper.ts";
import { beezieSanitizedPage } from "./fixtures/task-014-sanitized.ts";
import { providerMapperManifest } from "./provider-mapper-manifest.ts";

test("Beezie remains a deterministic dormant reference mapper", () => {
  const output = beezieProviderMappingAdapter.mapPage({
    configuration: {
      providerId: "provider-beezie",
      configurationRevisionId: "revision-beezie",
      platform: BEEZIE_PLATFORM_KEY,
      adapterKey: BEEZIE_MAPPING_KEY,
    },
    page: { catalog: [], pulls: [], trades: [], next_cursor: "dormant-end", has_more: false },
    recordIndexes: { catalog: [], pulls: [], trades: [] },
  });
  assert.deepEqual(output, { outcomes: [] });
  assert.equal(
    providerMapperManifest.some(
      ({ descriptor }) => descriptor.provider === (BEEZIE_PLATFORM_KEY as never),
    ),
    false,
  );
});

test("dormant Beezie behavior still maps its sanitized catalog, pull, and trade evidence", () => {
  const output = beezieProviderMappingAdapter.mapPage({
    configuration: {
      providerId: "provider-beezie",
      configurationRevisionId: "revision-beezie",
      platform: BEEZIE_PLATFORM_KEY,
      adapterKey: BEEZIE_MAPPING_KEY,
    },
    page: beezieSanitizedPage,
    recordIndexes: { catalog: [0], pulls: [1], trades: [2] },
  });
  assert.equal(output.outcomes.length, 3);
  assert.ok(output.outcomes.every(({ status }) => status === "mapped"));
  const candidates = output.outcomes.flatMap((outcome) =>
    outcome.status === "mapped" ? outcome.candidates : [],
  );
  assert.deepEqual(
    candidates.map(({ candidateKind }) => candidateKind).sort(),
    ["catalog_asset", "ev_input", "market_event", "pack", "pull"],
  );
});

test("deferred mapper keys cannot appear in production activation composition", () => {
  const keys = providerMapperManifest.map(({ descriptor }) => descriptor.mapperKey);
  assert.equal(keys.includes(BEEZIE_MAPPING_KEY), false);
  assert.equal(keys.some((key) => /gamestop|stadium|trove/u.test(key)), false);
});
