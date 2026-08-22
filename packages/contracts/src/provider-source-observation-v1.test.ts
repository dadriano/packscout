import assert from "node:assert/strict";
import { test } from "node:test";
import {
  absentNormalizedFact,
  emptyNormalizedProviderFacts,
  normalizedCurrencyTickerSchema,
  normalizedEvInputEvidenceSchema,
  normalizedPackProviderFactsSchema,
  normalizedProviderMoneySchema,
} from "./provider-source-facts-v1.ts";
import {
  normalizedObservationSemanticContent,
  normalizedObservationSemanticContentSchema,
  normalizedProviderObservationSchema,
} from "./provider-source-observation-v1.ts";

const packFacts = normalizedPackProviderFactsSchema.parse({
  ...emptyNormalizedProviderFacts("pack"),
  displayName: { state: "present", value: "Court Kings" },
});

const packObservation = normalizedProviderObservationSchema.parse({
  kind: "catalog",
  entity: "pack",
  providerRecordIdentity: {
    recordIdScopeKey: "catalog-pack-v1",
    providerRecordId: "pack-42",
  },
  effectiveAt: "2026-08-20T12:00:00.000Z",
  collectedAt: "2026-08-20T12:00:01.000Z",
  firstSeenAt: "2026-08-01T00:00:00.000Z",
  availability: "available",
  providerFacts: packFacts,
  relationships: [],
  protectedNativeEvidenceRef: "protected:page:record:0",
});

test("provider facts are strict, source-neutral, and catalog-discriminator bound", () => {
  assert.equal(
    normalizedProviderObservationSchema.safeParse(packObservation).success,
    true,
  );
  assert.equal(
    normalizedProviderObservationSchema.safeParse({
      ...packObservation,
      providerFacts: emptyNormalizedProviderFacts("card"),
    }).success,
    false,
  );
  assert.equal(
    normalizedPackProviderFactsSchema.safeParse({
      ...packFacts,
      rawData: { vendorField: true },
    }).success,
    false,
  );
  assert.equal(
    normalizedPackProviderFactsSchema.safeParse({
      ...packFacts,
      displayName: { state: "present", value: " " },
    }).success,
    false,
  );
});

test("semantic construction includes provider facts and excludes delivery evidence", () => {
  const semantic = normalizedObservationSemanticContent(packObservation);
  assert.deepEqual(semantic.providerFacts, packFacts);
  assert.equal("collectedAt" in semantic, false);
  assert.equal("protectedNativeEvidenceRef" in semantic, false);
  assert.equal(
    normalizedObservationSemanticContentSchema.safeParse({
      ...semantic,
      collectedAt: packObservation.collectedAt,
    }).success,
    false,
  );
  assert.notDeepEqual(
    normalizedObservationSemanticContent(
      normalizedProviderObservationSchema.parse({
        ...packObservation,
        providerFacts: {
          ...packFacts,
          price: {
            state: "present",
            value: { amount: 49.99, currency: "USD" },
          },
        },
      }),
    ),
    semantic,
  );
});

test("timestamps and pull relationships canonicalize before semantic identity", () => {
  const catalogObservation = normalizedProviderObservationSchema.parse({
    ...packObservation,
    effectiveAt: "2026-08-20T05:00:00.000-07:00",
    collectedAt: "2026-08-20T05:00:01.000-07:00",
    firstSeenAt: "2026-07-31T17:00:00.000-07:00",
  });
  assert.equal(catalogObservation.effectiveAt, "2026-08-20T12:00:00.000Z");
  assert.equal(catalogObservation.collectedAt, "2026-08-20T12:00:01.000Z");
  assert.equal(catalogObservation.kind, "catalog");
  if (catalogObservation.kind !== "catalog") {
    throw new Error("Expected catalog observation.");
  }
  assert.equal(catalogObservation.firstSeenAt, "2026-08-01T00:00:00.000Z");

  const pullObservation = normalizedProviderObservationSchema.parse({
    kind: "pull",
    providerRecordIdentity: {
      recordIdScopeKey: "pull-v1",
      providerRecordId: "pull-42",
    },
    effectiveAt: "2026-08-20T05:00:00.000-07:00",
    collectedAt: "2026-08-20T05:00:01.000-07:00",
    providerFacts: emptyNormalizedProviderFacts("pull"),
    relationships: [
      {
        relationship: "card",
        target: {
          recordIdScopeKey: "catalog-card-v1",
          providerRecordId: "card-42",
        },
      },
      {
        relationship: "pack",
        target: {
          recordIdScopeKey: "catalog-pack-v1",
          providerRecordId: "pack-42",
        },
      },
    ],
    protectedNativeEvidenceRef: "protected:page:record:1",
  });

  assert.equal(pullObservation.effectiveAt, "2026-08-20T12:00:00.000Z");
  assert.equal(pullObservation.collectedAt, "2026-08-20T12:00:01.000Z");
  assert.deepEqual(
    pullObservation.relationships.map(({ relationship }) => relationship),
    ["pack", "card"],
  );

  const catalogSemantic = normalizedObservationSemanticContentSchema.parse({
    ...normalizedObservationSemanticContent(packObservation),
    effectiveAt: "2026-08-20T05:00:00.000-07:00",
    firstSeenAt: "2026-07-31T17:00:00.000-07:00",
  });
  assert.equal(catalogSemantic.effectiveAt, "2026-08-20T12:00:00.000Z");
  assert.equal(catalogSemantic.kind, "catalog");
  if (catalogSemantic.kind !== "catalog") {
    throw new Error("Expected catalog semantic content.");
  }
  assert.equal(catalogSemantic.firstSeenAt, "2026-08-01T00:00:00.000Z");
});

test("authoritative sold-out evidence is pack-only and closed", () => {
  assert.equal(
    normalizedPackProviderFactsSchema.safeParse({
      ...packFacts,
      authoritativeAvailability: {
        state: "present",
        value: {
          state: "sold_out",
          authority: "provider_explicit_sold_out",
        },
      },
    }).success,
    true,
  );
  for (const invalid of [
    {
      state: "present",
      value: { state: "unavailable", authority: "provider_explicit_sold_out" },
    },
    {
      state: "present",
      value: { state: "sold_out", authority: "native_wording" },
    },
    { state: "absent", value: "sold_out" },
  ]) {
    assert.equal(
      normalizedPackProviderFactsSchema.safeParse({
        ...packFacts,
        authoritativeAvailability: invalid,
      }).success,
      false,
    );
  }
  assert.deepEqual(absentNormalizedFact, { state: "absent" });
});

test("normalized currency tickers reject noncanonical provider values", () => {
  for (const valid of ["USD", "USDC", "1INCH"]) {
    assert.equal(normalizedCurrencyTickerSchema.safeParse(valid).success, true);
  }

  for (const invalid of [
    " USD",
    "USD ",
    "US D",
    "USD/USD",
    "usd",
    "ABCDEFGHIJKLM",
  ]) {
    assert.equal(
      normalizedCurrencyTickerSchema.safeParse(invalid).success,
      false,
    );
    assert.equal(
      normalizedProviderMoneySchema.safeParse({ amount: 1, currency: invalid })
        .success,
      false,
    );
    assert.equal(
      normalizedEvInputEvidenceSchema.safeParse({
        approved: true,
        currency: invalid,
        unitBasis: null,
        drawCount: null,
        buybackPercent: null,
        totalQuantity: null,
        buckets: [],
      }).success,
      false,
    );
    assert.equal(
      normalizedProviderObservationSchema.safeParse({
        kind: "trade",
        providerRecordIdentity: {
          recordIdScopeKey: "trade-v1",
          providerRecordId: "trade-42",
        },
        effectiveAt: "2026-08-20T12:00:00.000Z",
        collectedAt: "2026-08-20T12:00:01.000Z",
        relationships: [
          {
            relationship: "card",
            target: {
              recordIdScopeKey: "catalog-card-v1",
              providerRecordId: "card-42",
            },
          },
        ],
        eventType: "sale",
        amount: 1,
        currency: invalid,
        paymentMethod: null,
        protectedTransactionEvidenceRef: null,
        providerFacts: emptyNormalizedProviderFacts("trade"),
        protectedNativeEvidenceRef: "protected:page:record:2",
      }).success,
      false,
    );
  }
});
