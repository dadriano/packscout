import assert from "node:assert/strict";
import test from "node:test";
import {
  DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  dataforrestCourtyardDistributedV2SourceAdapterManifest,
  dataforrestEventRecordV1Schema,
  normalizeDataforrestEventRecordForAdapter,
  type NormalizedProviderObservationPage,
} from "@packscout/contracts";
import type { ProductionProviderObservationMapperRegistry } from "@packscout/services";
import type {
  ProviderMixedPageCandidateRecordDraft,
  ProviderMixedPageQuarantineRecordDraft,
  ProviderMixedPageRecordDraft,
} from "./provider-capture-source-contract.ts";
import { createProviderDataforrestLiveIntegration } from
  "./provider-dataforrest-live-integration.ts";
import { translateProviderNormalizedObservations } from
  "./provider-normalized-mixed-page-translation.ts";

function isQuarantine(
  record: ProviderMixedPageRecordDraft,
): record is ProviderMixedPageQuarantineRecordDraft {
  return "disposition" in record && record.disposition === "quarantine";
}

function isCandidate(
  record: ProviderMixedPageRecordDraft,
): record is ProviderMixedPageCandidateRecordDraft {
  return !isQuarantine(record);
}

const ORGANIZATION_ID = "3c9fa4d3-fe16-569c-8cfa-b4a44c63eb4a";
const PROVIDER_ID = "eeba923b-3d0f-53bc-9006-d84fab651824";

const integration = createProviderDataforrestLiveIntegration(
  "courtyard",
  dataforrestCourtyardDistributedV2SourceAdapterManifest,
);

/**
 * The Courtyard v2 adapter declares no pack fact reader, so a pack record is
 * read for its declared display-name field alone. That is the exact production
 * shape behind the rejected Courtyard catalog records.
 */
function catalogPage(
  entity: "pack" | "card",
  data: Readonly<Record<string, unknown>>,
): NormalizedProviderObservationPage {
  const record = dataforrestEventRecordV1Schema.parse({
    stream: "catalog",
    platform: "courtyard",
    record_id: `courtyard-${entity}-001`,
    occurred_at: "2026-09-02T00:00:00.000Z",
    collected_at: "2026-09-02T00:00:01.000Z",
    data,
    entity,
    first_seen_at: "2026-09-01T00:00:00.000Z",
    available: true,
  });
  return {
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    provider: "courtyard",
    outcomes: [{
      status: "valid",
      recordIndex: 0,
      observation: normalizeDataforrestEventRecordForAdapter(
        record,
        "courtyard",
        "protected:courtyard-evidence",
        DATAFORREST_COURTYARD_DISTRIBUTED_ADAPTER_V2_VERSION,
      ),
    }],
    nextCursor: {
      sourceInstanceId: "courtyard-source",
      sourceRevisionId: "courtyard-revision",
      sourceTypeKey: integration.manifest.sourceTypeKey,
      adapterVersion: integration.manifest.adapterVersion,
      cursorCodecKey: integration.manifest.cursorCodecKey,
      cursorGeneration: 1,
      value: "courtyard-cursor-001",
    },
    continuation: { kind: "continue" },
    measurements: { durationMilliseconds: 1, responseBytes: 1, recordCount: 1 },
    diagnostics: [],
  } as NormalizedProviderObservationPage;
}

function translate(
  page: NormalizedProviderObservationPage,
  mappers?: ProductionProviderObservationMapperRegistry,
) {
  return translateProviderNormalizedObservations({
    organizationId: ORGANIZATION_ID,
    providerId: PROVIDER_ID,
    integration,
    page,
    ...(mappers === undefined ? {} : { mappers }),
  });
}

function onlyQuarantine(
  translation: ReturnType<typeof translate>,
): ProviderMixedPageQuarantineRecordDraft {
  const quarantines = translation.records.filter(isQuarantine);
  assert.equal(quarantines.length, 1);
  return quarantines[0]!;
}

test("a pack the adapter cannot name quarantines with its own reason and field", () => {
  const quarantine = onlyQuarantine(translate(catalogPage("pack", {
    name: "Sample Repack",
    price_usd: 25,
  })));

  assert.equal(quarantine.reasonCode, "SOURCE_RECORD_PACK_DISPLAY_NAME_REQUIRED");
  assert.equal(quarantine.fieldPath, "providerFacts.displayName");
  assert.equal(quarantine.kind, "catalog");
  assert.equal(quarantine.candidate.name, undefined);
  assert.equal(quarantine.candidate.price_usd, undefined);
});

test("a card the draft rejects keeps the draft failure code", () => {
  const quarantine = onlyQuarantine(translate(catalogPage("card", {
    provider_label: "Do not fall back",
  })));

  assert.equal(quarantine.reasonCode, "PROVIDER_CAPTURE_RECORD_INVALID");
  assert.equal(quarantine.fieldPath, null);
  assert.equal(quarantine.kind, "catalog");
});

test("an unrecognized mapping failure keeps the generic reason", () => {
  const failing = {
    resolve: () => ({
      map: () => {
        throw new Error("unrecognized mapping failure");
      },
    }),
  } as unknown as ProductionProviderObservationMapperRegistry;
  const quarantine = onlyQuarantine(
    translate(catalogPage("pack", { provider_label: "Sample Repack" }), failing),
  );

  assert.equal(quarantine.reasonCode, "SOURCE_RECORD_MAPPING_INVALID");
  assert.equal(quarantine.fieldPath, null);
});

test("a nameable pack still maps without quarantine", () => {
  const translation = translate(catalogPage("pack", {
    provider_label: "Sample Repack",
  }));

  assert.equal(translation.counts.packs, 1);
  assert.equal(translation.records.some(isQuarantine), false);
  const pack = translation.records
    .filter(isCandidate)
    .find((record) => record.entityType === "pack");
  assert.ok(pack);
  assert.equal(pack.candidate.displayName, "Sample Repack");
});
