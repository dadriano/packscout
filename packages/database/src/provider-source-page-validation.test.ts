import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
  emptyNormalizedProviderFacts,
  normalizedObservationSemanticContent,
  normalizedObservationSemanticContentV2,
  normalizedProviderObservationSchema,
  normalizedProviderObservationV2Schema,
  type ProviderSourceCanonicalProjectionPlan,
} from "@packscout/contracts";
import {
  ProviderSourceAtomicPagePersistenceError,
  validateProviderSourceCanonicalProjections,
} from "./provider-source-page-validation.ts";
import { hashJson } from "./security.ts";

test("database validation rejects canonical relationships retargeted away from semantic lineage", () => {
  const semanticContent = normalizedObservationSemanticContent(
    normalizedProviderObservationSchema.parse({
      kind: "trade",
      providerRecordIdentity: {
        recordIdScopeKey: "trade-v1",
        providerRecordId: "trade-1",
      },
      effectiveAt: "2026-08-21T12:00:00.000Z",
      collectedAt: "2026-08-21T12:00:01.000Z",
      relationships: [{
        relationship: "card",
        target: {
          recordIdScopeKey: "catalog-card-v1",
          providerRecordId: "card-1",
        },
      }],
      eventType: "sale",
      amount: null,
      currency: null,
      paymentMethod: null,
      protectedTransactionEvidenceRef: null,
      protectedNativeEvidenceRef: "evidence:trade-1",
      providerFacts: emptyNormalizedProviderFacts("trade"),
    }),
  );
  const content = {
    eventKind: "market_event",
    providerEventType: "sale",
    eventCategory: "sale",
    amount: null,
    paymentMethod: null,
    displayName: null,
    imageUrls: [],
  } as const;
  const exact: ProviderSourceCanonicalProjectionPlan = {
    projectionKind: "primary",
    platformKey: "courtyard",
    recordKind: "market_event",
    providerRecordId: "trade-1",
    recordIdScopeKey: "trade-v1",
    effectiveAt: semanticContent.effectiveAt,
    contentFingerprint: hashJson(content),
    content,
    relationships: [{
      relationship: "card",
      targetRecordIdScopeKey: "catalog-card-v1",
      targetCanonicalKind: "catalog_asset",
      targetProviderRecordId: "card-1",
    }],
    affectedPackProviderRecordId: null,
    evInputStatus: "not_applicable",
  };

  assert.doesNotThrow(() => validateProviderSourceCanonicalProjections({
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    provider: "courtyard",
    semanticContent,
    projections: [exact],
  }));
  assert.throws(
    () => validateProviderSourceCanonicalProjections({
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
      provider: "courtyard",
      semanticContent,
      projections: [{
        ...exact,
        relationships: [{
          relationship: "pack",
          targetRecordIdScopeKey: "catalog-pack-v1",
          targetCanonicalKind: "pack",
          targetProviderRecordId: "wrong-pack",
        }],
      }],
    }),
    (error: unknown) =>
      error instanceof ProviderSourceAtomicPagePersistenceError &&
      error.code === "invalid_page_plan",
  );
});

test("database validation accepts one-target pulls only under the exact v2 pin", () => {
  const semanticContent = normalizedObservationSemanticContentV2(
    normalizedProviderObservationV2Schema.parse({
      kind: "pull",
      providerRecordIdentity: {
        recordIdScopeKey: "pull-v1",
        providerRecordId: "pull-without-pack-1",
      },
      effectiveAt: "2026-08-25T12:00:00.000Z",
      collectedAt: "2026-08-25T12:00:01.000Z",
      relationships: [{
        relationship: "card",
        target: {
          recordIdScopeKey: "catalog-card-v1",
          providerRecordId: "card-1",
        },
      }],
      protectedNativeEvidenceRef: "evidence:pull-without-pack-1",
      providerFacts: emptyNormalizedProviderFacts("pull"),
    }),
  );
  const content = {
    eventKind: "pull",
    displayName: null,
    imageUrls: [],
    value: null,
    valueSource: null,
  } as const;
  const projection: ProviderSourceCanonicalProjectionPlan = {
    projectionKind: "primary",
    platformKey: "clutchpacks",
    recordKind: "pull",
    providerRecordId: "pull-without-pack-1",
    recordIdScopeKey: "pull-v1",
    effectiveAt: semanticContent.effectiveAt,
    contentFingerprint: hashJson(content),
    content,
    relationships: [{
      relationship: "card",
      targetRecordIdScopeKey: "catalog-card-v1",
      targetCanonicalKind: "catalog_asset",
      targetProviderRecordId: "card-1",
    }],
    affectedPackProviderRecordId: null,
    evInputStatus: "not_applicable",
  };

  assert.doesNotThrow(() => validateProviderSourceCanonicalProjections({
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
    provider: "clutchpacks",
    semanticContent,
    projections: [projection],
  }));
  for (const normalizedContractVersion of [
    PROVIDER_OBSERVATION_CONTRACT_VERSION,
    "packscout.provider-observation.future",
  ]) {
    assert.throws(
      () => validateProviderSourceCanonicalProjections({
        normalizedContractVersion,
        provider: "clutchpacks",
        semanticContent,
        projections: [projection],
      }),
      (error: unknown) =>
        error instanceof ProviderSourceAtomicPagePersistenceError &&
      error.code === "invalid_page_plan",
    );
  }

  const packOnlySemanticContent = normalizedObservationSemanticContentV2(
    normalizedProviderObservationV2Schema.parse({
      kind: "pull",
      providerRecordIdentity: {
        recordIdScopeKey: "pull-v1",
        providerRecordId: "pull-without-card-1",
      },
      effectiveAt: "2026-08-25T12:00:00.000Z",
      collectedAt: "2026-08-25T12:00:01.000Z",
      relationships: [{
        relationship: "pack",
        target: {
          recordIdScopeKey: "catalog-pack-v1",
          providerRecordId: "pack-1",
        },
      }],
      protectedNativeEvidenceRef: "evidence:pull-without-card-1",
      providerFacts: emptyNormalizedProviderFacts("pull"),
    }),
  );
  const packOnlyProjection: ProviderSourceCanonicalProjectionPlan = {
    ...projection,
    providerRecordId: "pull-without-card-1",
    relationships: [{
      relationship: "pack",
      targetRecordIdScopeKey: "catalog-pack-v1",
      targetCanonicalKind: "pack",
      targetProviderRecordId: "pack-1",
    }],
  };
  assert.doesNotThrow(() => validateProviderSourceCanonicalProjections({
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
    provider: "clutchpacks",
    semanticContent: packOnlySemanticContent,
    projections: [packOnlyProjection],
  }));
  assert.throws(
    () => validateProviderSourceCanonicalProjections({
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
      provider: "clutchpacks",
      semanticContent: packOnlySemanticContent,
      projections: [packOnlyProjection],
    }),
    (error: unknown) =>
      error instanceof ProviderSourceAtomicPagePersistenceError &&
      error.code === "invalid_page_plan",
  );
});
