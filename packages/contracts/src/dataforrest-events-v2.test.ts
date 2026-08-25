import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
  DATAFORREST_EVENTS_V3_ADAPTER_VERSION,
  dataforrestEventRecordV1Schema,
  dataforrestEventRecordV2Schema,
  dataforrestEventsSourceAdapterManifests,
  dataforrestEventsV1SourceAdapterManifest,
  dataforrestEventsV2SourceAdapterManifest,
  dataforrestEventsV3SourceAdapterManifest,
  normalizeDataforrestEventRecord,
  normalizeDataforrestEventRecordV2,
  normalizeDataforrestEventRecordV3,
} from "./dataforrest-events-v1.ts";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
  sourceAdapterManifestV1Schema,
  sourceAdapterManifestV2Schema,
} from "./provider-source-contract-v1.ts";

const pullBase = {
  stream: "pulls" as const,
  platform: "clutchpacks" as const,
  record_id: "pull-42",
  occurred_at: "2026-08-20T12:00:00.000Z",
  collected_at: "2026-08-20T12:00:01.000Z",
  data: {},
  pack_id: null,
  card_id: "card-42",
};

test("DataForrest raw event v2 accepts either one-sided pull", () => {
  const cases = [
    { raw: pullBase, expected: ["card"] },
    {
      raw: { ...pullBase, pack_id: "pack-42", card_id: null },
      expected: ["pack"],
    },
  ] as const;
  for (const { raw, expected } of cases) {
    assert.equal(dataforrestEventRecordV1Schema.safeParse(raw).success, false);
    const parsed = dataforrestEventRecordV2Schema.parse(raw);
    const observation = normalizeDataforrestEventRecordV3(
      parsed,
      "clutchpacks",
      "page_record:0",
    );
    assert.equal(observation.kind, "pull");
    assert.deepEqual(
      observation.relationships.map(({ relationship }) => relationship),
      expected,
    );
  }
});

test("DataForrest raw event v2 requires both keys and at least one relationship", () => {
  const fullyRelated = { ...pullBase, pack_id: "pack-42" };
  const { card_id: removedCardId, ...withoutCard } = fullyRelated;
  const { pack_id: removedPackId, ...withoutPack } = fullyRelated;
  assert.equal(removedCardId, "card-42");
  assert.equal(removedPackId, "pack-42");
  for (const invalid of [
    withoutCard,
    withoutPack,
    { ...pullBase, card_id: null },
    { ...pullBase, card_id: "" },
    { ...pullBase, pack_id: "", card_id: null },
  ]) {
    assert.equal(dataforrestEventRecordV2Schema.safeParse(invalid).success, false);
  }

  const withPack = dataforrestEventRecordV2Schema.parse(fullyRelated);
  const observation = normalizeDataforrestEventRecordV3(
    withPack,
    "clutchpacks",
    "page_record:1",
  );
  assert.deepEqual(
    observation.relationships.map(({ relationship }) => relationship),
    ["pack", "card"],
  );
});

test("DataForrest adapters v1 and v2 retain both-required pull behavior", () => {
  for (const oneSided of [
    pullBase,
    { ...pullBase, pack_id: "pack-42", card_id: null },
  ]) {
    assert.equal(
      dataforrestEventRecordV1Schema.safeParse(oneSided).success,
      false,
    );
  }
  const raw = dataforrestEventRecordV1Schema.parse({
    ...pullBase,
    pack_id: "pack-42",
  });
  for (const normalize of [
    normalizeDataforrestEventRecord,
    normalizeDataforrestEventRecordV2,
  ]) {
    const observation = normalize(raw, "clutchpacks", "page_record:legacy");
    assert.equal(observation.kind, "pull");
    assert.deepEqual(
      observation.relationships.map(({ relationship }) => relationship),
      ["pack", "card"],
    );
  }
});

test("DataForrest v3 is the only manifest pinned to observation v2", () => {
  assert.deepEqual(
    dataforrestEventsSourceAdapterManifests.map(
      ({ adapterVersion }) => adapterVersion,
    ),
    [
      DATAFORREST_EVENTS_V1_ADAPTER_VERSION,
      DATAFORREST_EVENTS_V2_ADAPTER_VERSION,
      DATAFORREST_EVENTS_V3_ADAPTER_VERSION,
    ],
  );
  for (const manifest of [
    dataforrestEventsV1SourceAdapterManifest,
    dataforrestEventsV2SourceAdapterManifest,
  ]) {
    assert.equal(
      manifest.normalizedContractVersion,
      PROVIDER_OBSERVATION_CONTRACT_VERSION,
    );
    assert.equal(sourceAdapterManifestV1Schema.safeParse(manifest).success, true);
    assert.equal(sourceAdapterManifestV2Schema.safeParse(manifest).success, false);
  }
  assert.equal(
    dataforrestEventsV3SourceAdapterManifest.normalizedContractVersion,
    PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
  );
  assert.equal(
    sourceAdapterManifestV2Schema.safeParse(
      dataforrestEventsV3SourceAdapterManifest,
    ).success,
    true,
  );
  assert.equal(
    sourceAdapterManifestV1Schema.safeParse(
      dataforrestEventsV3SourceAdapterManifest,
    ).success,
    false,
  );
});
