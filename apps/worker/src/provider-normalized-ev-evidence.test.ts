import assert from "node:assert/strict";
import test from "node:test";
import {
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  normalizeDataforrestEventRecordForAdapter,
  normalizedProviderObservationPageSchema,
  providerPackEvEvidenceV1Schema,
  type DataforrestEventRecordV1,
} from "@packscout/contracts";
import { createProviderDataforrestLiveIntegration } from
  "./provider-dataforrest-live-integration.ts";
import { translateProviderNormalizedObservations } from
  "./provider-normalized-mixed-page-translation.ts";

const organizationId = "00000000-0000-4000-8000-000000000001";
const providerId = "11111111-1111-4111-8111-111111111111";
const integration = createProviderDataforrestLiveIntegration(
  "clutchpacks",
  dataforrestClutchpacksDistributedSourceAdapterManifest,
);
const protectedMarker = "native-actor-and-raw-payload-must-not-be-retained";

function sourceRecord(): DataforrestEventRecordV1 {
  return {
    stream: "catalog",
    platform: "clutchpacks",
    entity: "pack",
    record_id: "ascent-source-pack",
    occurred_at: "2026-08-29T12:00:00.000Z",
    collected_at: "2026-08-29T12:00:01.000Z",
    first_seen_at: "2026-08-29T11:00:00.000Z",
    available: true,
    data: {
      name: "Ascent",
      price: { price_amount: "100.00", currency: { code: "USD", decimals: 2 } },
      average_value: "100.00",
      series: {
        description: "Instant buyback offer of 90%. One graded or authenticated card per pack.",
      },
      price_bucket_odds: [
        {
          bucket_id: "commons",
          name: "Commons",
          drawable_count: 3,
          min_price: "$20",
          max_price: "$99.99",
          live_pool_percentage: "deliberately not used",
          preview_cards: [{ owner: protectedMarker }],
        },
        {
          bucket_id: "chasers",
          name: "Chasers",
          drawable_count: 1,
          min_price: "$100",
          max_price: "$1,000",
        },
      ],
      native_actor: protectedMarker,
    },
  };
}

function translate(records: readonly DataforrestEventRecordV1[]) {
  const manifest = integration.manifest;
  return translateProviderNormalizedObservations({
    organizationId,
    providerId,
    integration,
    page: normalizedProviderObservationPageSchema.parse({
      provider: "clutchpacks",
      normalizedContractVersion: manifest.normalizedContractVersion,
      outcomes: records.map((record, recordIndex) => ({
        status: "valid",
        recordIndex,
        observation: normalizeDataforrestEventRecordForAdapter(
          record,
          "clutchpacks",
          `protected-native:${recordIndex}`,
          manifest.adapterVersion,
        ),
      })),
      nextCursor: {
        sourceInstanceId: "source-1",
        sourceRevisionId: "source-revision-1",
        sourceTypeKey: manifest.sourceTypeKey,
        adapterVersion: manifest.adapterVersion,
        cursorCodecKey: manifest.cursorCodecKey,
        cursorGeneration: 1,
        value: null,
      },
      continuation: { kind: "poll_after", minimumDelaySeconds: 60 },
      measurements: {
        durationMilliseconds: 1,
        responseBytes: JSON.stringify(records).length,
        recordCount: records.length,
      },
      diagnostics: [],
    }),
  });
}

function packCandidates(records: readonly DataforrestEventRecordV1[]) {
  return translate(records).records.flatMap((record) =>
    "entityType" in record && record.entityType === "pack"
      ? [record.candidate]
      : []);
}

function evidence(candidate: ReturnType<typeof packCandidates>[number]) {
  // The persistence boundary stores canonical JSON. Round-trip through that
  // codec before using the independent publication contract validator.
  const stored: unknown = JSON.parse(JSON.stringify(candidate.attributes));
  assert.ok(typeof stored === "object" && stored !== null);
  return providerPackEvEvidenceV1Schema.parse(
    (stored as Record<string, unknown>).evInputEvidence,
  );
}

test("normalized ClutchPacks drawable-count evidence survives canonical JSON without calculating EV", () => {
  const [pack] = packCandidates([sourceRecord()]);
  assert.ok(pack);
  const retained = evidence(pack);
  assert.equal(retained.organizationId, organizationId);
  assert.equal(retained.providerId, providerId);
  assert.equal(retained.providerKey, "clutchpacks");
  assert.equal(retained.providerRecordId, "ascent-source-pack");
  assert.equal(retained.sourceAdapterVersion, integration.manifest.adapterVersion);
  assert.equal(retained.mapperKey, integration.mapper.mapperKey);
  assert.equal(retained.identityNamespaceKey, integration.mapper.identityNamespaceKey);
  assert.equal(retained.recordIdScopeKey, "catalog-pack-v1");
  assert.equal(retained.effectiveAt, "2026-08-29T12:00:00.000Z");
  assert.equal(retained.collectedAt, "2026-08-29T12:00:01.000Z");
  assert.deepEqual(retained.price, {
    state: "present", value: { amount: 100, currency: "USD" },
  });
  assert.deepEqual(retained.buybackPercent, { state: "present", value: 90 });
  assert.equal(retained.evInput.state, "present");
  if (retained.evInput.state !== "present") assert.fail("missing source odds");
  assert.equal(retained.evInput.value.totalQuantity, 4);
  assert.deepEqual(retained.evInput.value.buckets, [
    {
      bucketId: "commons", label: "Commons", quantity: 3,
      probability: 0.75, lowerValue: 20, upperValue: 99.99,
    },
    {
      bucketId: "chasers", label: "Chasers", quantity: 1,
      probability: 0.25, lowerValue: 100, upperValue: 1_000,
    },
  ]);
  assert.equal(pack.packscoutEvAmount, null);
  assert.equal(pack.packscoutEvCalculatedAt, null);
  assert.equal(pack.packscoutEvUnavailableReason, "not_calculated");
  assert.equal(JSON.stringify(pack).includes(protectedMarker), false);
  assert.equal(JSON.stringify(pack).includes("protected-native:"), false);
});

test("multiple revisions of a source pack retain their own price, odds and source clocks", () => {
  const initial = sourceRecord();
  const changed = sourceRecord();
  changed.occurred_at = "2026-08-29T12:05:00.000Z";
  changed.collected_at = "2026-08-29T12:05:01.000Z";
  changed.data.price = {
    price_amount: "200.00", currency: { code: "USD", decimals: 2 },
  };
  const packs = packCandidates([initial, changed]);
  assert.equal(packs.length, 2);
  const first = evidence(packs[0]!);
  const second = evidence(packs[1]!);
  assert.equal(first.effectiveAt, initial.occurred_at);
  assert.equal(second.effectiveAt, changed.occurred_at);
  assert.deepEqual(first.price, { state: "present", value: { amount: 100, currency: "USD" } });
  assert.deepEqual(second.price, { state: "present", value: { amount: 200, currency: "USD" } });
  const redelivery = { ...initial, collected_at: "2026-08-29T12:10:00.000Z" };
  const [redelivered] = packCandidates([redelivery]);
  assert.ok(redelivered);
  assert.equal(redelivered.sourceUpdatedAt, initial.occurred_at);
  assert.equal(evidence(redelivered).effectiveAt, initial.occurred_at);
});

test("absent buyback and malformed odds remain explicit evidence states", () => {
  const absent = sourceRecord();
  delete absent.data.series;
  const malformed = sourceRecord();
  malformed.data.price_bucket_odds = [{ drawable_count: -1 }];
  const [withoutBuyback, withoutOdds] = packCandidates([absent, malformed]);
  assert.ok(withoutBuyback);
  assert.ok(withoutOdds);
  const retained = evidence(withoutBuyback);
  assert.deepEqual(retained.buybackPercent, { state: "absent" });
  assert.equal(retained.evInput.state, "present");
  if (retained.evInput.state !== "present") assert.fail("missing source odds");
  assert.equal(retained.evInput.value.buybackPercent, null);
  assert.deepEqual(evidence(withoutOdds).evInput, { state: "malformed" });
});

test("stored EV evidence rejects raw extensions, conflicting namespaces and invalid chronology", () => {
  const [pack] = packCandidates([sourceRecord()]);
  assert.ok(pack);
  const retained = evidence(pack);
  for (const changed of [
    { ...retained, raw: { secret: protectedMarker } },
    { ...retained, providerKey: "courtyard" },
    { ...retained, recordIdScopeKey: "catalog-card-v1" },
    { ...retained, collectedAt: "2026-08-29T11:59:59.000Z" },
    { ...retained, effectiveAt: "2026-08-29T12:00:00Z" },
  ]) {
    assert.equal(providerPackEvEvidenceV1Schema.safeParse(changed).success, false);
  }
});
