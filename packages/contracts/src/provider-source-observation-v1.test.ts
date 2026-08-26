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
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_HASH_VERSION,
} from "./provider-source-contract-v1.ts";
import {
  normalizedObservationSemanticCanonicalJson,
  normalizedObservationSemanticContent,
  normalizedObservationSemanticContentSchema,
  normalizedProviderObservationPageSchema,
  normalizedProviderObservationSchema,
  semanticObservationIdentitySchema,
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

const packRelationship = {
  relationship: "pack" as const,
  target: {
    recordIdScopeKey: "catalog-pack-v1" as const,
    providerRecordId: "pack-42",
  },
};
const cardRelationship = {
  relationship: "card" as const,
  target: {
    recordIdScopeKey: "catalog-card-v1" as const,
    providerRecordId: "card-42",
  },
};
const pullBase = {
  kind: "pull" as const,
  providerRecordIdentity: {
    recordIdScopeKey: "pull-v1" as const,
    providerRecordId: "pull-42",
  },
  effectiveAt: "2026-08-20T12:00:00.000Z",
  collectedAt: "2026-08-20T12:00:01.000Z",
  providerFacts: emptyNormalizedProviderFacts("pull"),
  protectedNativeEvidenceRef: "protected:page:record:0",
};

test("observation v1 accepts either one-sided pull", () => {
  for (const relationships of [[cardRelationship], [packRelationship]]) {
    const parsed = normalizedProviderObservationSchema.parse({
      ...pullBase,
      relationships,
    });
    const semantic = normalizedObservationSemanticContent(parsed);
    assert.equal("collectedAt" in semantic, false);
    assert.equal("protectedNativeEvidenceRef" in semantic, false);
    assert.equal(
      normalizedObservationSemanticContentSchema.safeParse(semantic).success,
      true,
    );
    assert.doesNotThrow(() =>
      normalizedObservationSemanticCanonicalJson(semantic)
    );
  }
});

test("observation v1 orders pack before card and rejects empty or duplicate edges", () => {
  const withPack = normalizedProviderObservationSchema.parse({
    ...pullBase,
    relationships: [cardRelationship, packRelationship],
  });
  assert.deepEqual(
    withPack.relationships.map(({ relationship }) => relationship),
    ["pack", "card"],
  );

  for (const relationships of [
    [],
    [cardRelationship, cardRelationship],
    [packRelationship, packRelationship],
    [packRelationship, cardRelationship, cardRelationship],
  ]) {
    assert.equal(
      normalizedProviderObservationSchema.safeParse({
        ...pullBase,
        relationships,
      }).success,
      false,
      relationships.map(({ relationship }) => relationship).join(","),
    );
  }
});

test("observation pages, semantic identities, and hashes retain the sole v1 domain", () => {
  assert.equal(
    PROVIDER_OBSERVATION_CONTRACT_VERSION,
    "packscout.provider-observation.v1",
  );
  assert.equal(
    PROVIDER_OBSERVATION_HASH_VERSION,
    "packscout.provider-observation-hash.v1",
  );
  const observation = normalizedProviderObservationSchema.parse({
    ...pullBase,
    relationships: [cardRelationship],
  });
  const page = normalizedProviderObservationPageSchema.parse({
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    provider: "clutchpacks",
    outcomes: [{ status: "valid", recordIndex: 0, observation }],
    nextCursor: {
      sourceInstanceId: "source-1",
      sourceRevisionId: "revision-1",
      sourceTypeKey: "dataforrest-events-v1",
      adapterVersion: "dataforrest-events-adapter-v1",
      cursorCodecKey: "dataforrest-cursor-v1",
      cursorGeneration: 1,
      value: "next",
    },
    continuation: { kind: "continue" },
    measurements: {
      durationMilliseconds: 1,
      responseBytes: 100,
      recordCount: 1,
    },
    diagnostics: [],
  });
  assert.equal(page.normalizedContractVersion, PROVIDER_OBSERVATION_CONTRACT_VERSION);
  const semantic = normalizedObservationSemanticContent(observation);
  assert.equal(
    normalizedObservationSemanticCanonicalJson(semantic),
    normalizedObservationSemanticCanonicalJson({
      relationships: semantic.relationships,
      providerFacts: semantic.providerFacts,
      kind: semantic.kind,
      effectiveAt: semantic.effectiveAt,
      providerRecordIdentity: semantic.providerRecordIdentity,
    }),
  );
  assert.equal(semanticObservationIdentitySchema.safeParse({
    sourceRecord: {
      organizationId: "organization-1",
      sourceInstanceId: "source-1",
      recordIdScopeKey: "pull-v1",
      providerRecordId: "pull-42",
    },
    effectiveAt: observation.effectiveAt,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    hashVersion: PROVIDER_OBSERVATION_HASH_VERSION,
    normalizedContentHash: "a".repeat(64),
  }).success, true);
});
