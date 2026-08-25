import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
  PROVIDER_OBSERVATION_HASH_VERSION,
  PROVIDER_OBSERVATION_HASH_VERSION_V2,
} from "./provider-source-contract-v1.ts";
import { emptyNormalizedProviderFacts } from "./provider-source-facts-v1.ts";
import {
  normalizedObservationSemanticCanonicalJson,
  normalizedObservationSemanticContentSchema,
  normalizedProviderObservationPageSchema,
  normalizedProviderObservationSchema,
  semanticObservationIdentitySchema,
} from "./provider-source-observation-v1.ts";
import {
  normalizedObservationSemanticCanonicalJsonV2,
  normalizedObservationSemanticContentV2,
  normalizedObservationSemanticContentV2Schema,
  normalizedProviderObservationPageV2Schema,
  normalizedProviderObservationV2Schema,
  semanticObservationIdentityV2Schema,
} from "./provider-source-observation-v2.ts";

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

test("observation v1 stays fully related while v2 accepts one-sided pulls", () => {
  const cardOnly = { ...pullBase, relationships: [cardRelationship] };
  const packOnly = { ...pullBase, relationships: [packRelationship] };
  for (const oneSided of [cardOnly, packOnly]) {
    assert.equal(
      normalizedProviderObservationSchema.safeParse(oneSided).success,
      false,
    );
    assert.equal(
      normalizedObservationSemanticContentSchema.safeParse({
        kind: oneSided.kind,
        providerRecordIdentity: oneSided.providerRecordIdentity,
        effectiveAt: oneSided.effectiveAt,
        providerFacts: oneSided.providerFacts,
        relationships: oneSided.relationships,
      }).success,
      false,
    );
    assert.equal(
      normalizedProviderObservationV2Schema.safeParse(oneSided).success,
      true,
    );
  }

  const parsed = normalizedProviderObservationV2Schema.parse(cardOnly);
  assert.deepEqual(
    parsed.relationships.map(({ relationship }) => relationship),
    ["card"],
  );
  const semantic = normalizedObservationSemanticContentV2(parsed);
  assert.equal("collectedAt" in semantic, false);
  assert.equal("protectedNativeEvidenceRef" in semantic, false);
  assert.equal(
    normalizedObservationSemanticContentV2Schema.safeParse(semantic).success,
    true,
  );
  assert.throws(() => normalizedObservationSemanticCanonicalJson(semantic));
  assert.doesNotThrow(() =>
    normalizedObservationSemanticCanonicalJsonV2(semantic)
  );
});

test("observation v2 orders pack before card and rejects empty or duplicate edges", () => {
  const withPack = normalizedProviderObservationV2Schema.parse({
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
      normalizedProviderObservationV2Schema.safeParse({
        ...pullBase,
        relationships,
      }).success,
      false,
      relationships.map(({ relationship }) => relationship).join(","),
    );
  }
});

test("observation pages and semantic identities retain exact version bounds", () => {
  assert.equal(
    PROVIDER_OBSERVATION_CONTRACT_VERSION,
    "packscout.provider-observation.v1",
  );
  assert.equal(
    PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
    "packscout.provider-observation.v2",
  );
  assert.equal(
    PROVIDER_OBSERVATION_HASH_VERSION,
    "packscout.provider-observation-hash.v1",
  );
  assert.equal(
    PROVIDER_OBSERVATION_HASH_VERSION_V2,
    "packscout.provider-observation-hash.v2",
  );

  const observation = normalizedProviderObservationV2Schema.parse({
    ...pullBase,
    relationships: [cardRelationship],
  });
  const page = {
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
    provider: "clutchpacks" as const,
    outcomes: [{ status: "valid" as const, recordIndex: 0, observation }],
    nextCursor: {
      sourceInstanceId: "source-1",
      sourceRevisionId: "revision-1",
      sourceTypeKey: "dataforrest-events-v1",
      adapterVersion: "dataforrest-events-adapter-v3",
      cursorCodecKey: "dataforrest-cursor-v1",
      cursorGeneration: 1,
      value: "next",
    },
    continuation: { kind: "continue" as const },
    measurements: {
      durationMilliseconds: 1,
      responseBytes: 100,
      recordCount: 1,
    },
    diagnostics: [],
  };
  assert.equal(normalizedProviderObservationPageV2Schema.safeParse(page).success, true);
  assert.equal(normalizedProviderObservationPageSchema.safeParse(page).success, false);
  assert.equal(
    normalizedProviderObservationPageV2Schema.safeParse({
      ...page,
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    }).success,
    false,
  );

  const identity = {
    sourceRecord: {
      organizationId: "organization-1",
      sourceInstanceId: "source-1",
      recordIdScopeKey: "pull-v1" as const,
      providerRecordId: "pull-42",
    },
    effectiveAt: observation.effectiveAt,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
    hashVersion: PROVIDER_OBSERVATION_HASH_VERSION_V2,
    normalizedContentHash: "a".repeat(64),
  };
  assert.equal(semanticObservationIdentityV2Schema.safeParse(identity).success, true);
  assert.equal(semanticObservationIdentitySchema.safeParse(identity).success, false);
});
