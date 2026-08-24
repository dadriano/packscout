import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyNormalizedProviderFacts,
  normalizedObservationSemanticContent,
  normalizedProviderObservationSchema,
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
    provider: "courtyard",
    semanticContent,
    projections: [exact],
  }));
  assert.throws(
    () => validateProviderSourceCanonicalProjections({
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
