import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_HASH_VERSION,
  emptyNormalizedProviderFacts,
  normalizedObservationSemanticContentSchema,
  providerIdentityNamespaceByLaunchProvider,
} from "@packscout/contracts";
import {
  BuybackEvRevisionRepository,
  type PersistBuybackEvRevisionRowInput,
} from "./buyback-ev-revision-repository.ts";
import type { PackscoutTransactionClient } from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import {
  createAcceptanceProviderSource,
  createProviderSourceAcceptanceFixture,
  type AcceptanceSource,
  type ProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";
import {
  hashNormalizedObservationSemanticContent,
  ProviderSourceObservationRepository,
} from "./provider-source-observation-repository.ts";
import { allocatePublicChangeCauses } from "./public-change-settlement-repository.ts";

const observedAt = new Date("2026-08-28T12:00:00.000Z");
const calculatedAt = "2026-08-28T12:05:00.000Z";
const freshnessExpiresAt = "2026-08-28T13:00:00.000Z";

type CanonicalRecordKind = "pack" | "ev_input";

async function createCanonicalRevision(
  fixture: ProviderSourceAcceptanceFixture,
  source: AcceptanceSource,
  input: Readonly<{
    externalId: string;
    recordKind: CanonicalRecordKind;
    contentHashCharacter: string;
    provenanceHashCharacter: string;
  }>,
) {
  const normalizedContent = normalizedObservationSemanticContentSchema.parse({
    kind: "catalog",
    entity: "pack",
    providerRecordIdentity: {
      recordIdScopeKey: "catalog-pack-v1",
      providerRecordId: input.externalId,
    },
    effectiveAt: observedAt.toISOString(),
    firstSeenAt: observedAt.toISOString(),
    availability: "available",
    providerFacts: emptyNormalizedProviderFacts("pack"),
    relationships: [],
  });
  const semanticContentHash =
    hashNormalizedObservationSemanticContent(normalizedContent);
  const observationRepository = new ProviderSourceObservationRepository();

  return fixture.database.$transaction(
    async (transaction: PackscoutTransactionClient) => {
      const observation =
        await observationRepository.upsertSemanticObservationInTransaction(
          transaction,
          {
            organizationId: fixture.organizationId,
            providerId: source.providerId,
            sourceInstanceId: source.sourceInstanceId,
            sourceRevisionId: source.sourceRevisionId,
            recordIdScopeKey: "catalog-pack-v1",
            providerRecordId: input.externalId,
            recordKind: "catalog",
            recordDiscriminator: "catalog_pack",
            effectiveSourceTime: observedAt,
            normalizedContractVersion:
              PROVIDER_OBSERVATION_CONTRACT_VERSION,
            hashVersion: PROVIDER_OBSERVATION_HASH_VERSION,
            normalizedContentHash: semanticContentHash,
            normalizedContent,
          },
        );
      assert.equal(observation.kind, "ready");
      if (observation.kind !== "ready") {
        throw new Error("The canonical fixture semantic observation conflicted.");
      }
      const [cause] = await allocatePublicChangeCauses(transaction, {
        organizationId: fixture.organizationId,
        changes: [
          {
            changeKind: "provider_projection",
            entityKey: `canonical:v1:${source.platformKey}:${input.recordKind}:${input.externalId}`,
            sourceKey: source.platformKey,
            sourceRevisionKey: observation.semanticObservationId,
            occurredAt: observedAt,
            catalogImpact: { kind: "none" },
          },
        ],
      });
      assert.ok(cause);
      const entity = await transaction.canonical_entities.create({
        data: {
          organization_id: fixture.organizationId,
          platform_key: source.platformKey,
          record_kind: input.recordKind,
          external_id: input.externalId,
        },
      });
      const revision = await transaction.canonical_revisions.create({
        data: {
          organization_id: fixture.organizationId,
          entity_id: entity.id,
          revision_number: 1,
          source_record_id: null,
          origin_semantic_observation_id: observation.semanticObservationId,
          content_json: { availability: "available" },
          content_hash: input.contentHashCharacter.repeat(64),
          provenance_json: {
            semanticObservationId: observation.semanticObservationId,
          },
          provenance_hash: input.provenanceHashCharacter.repeat(64),
          actor_key: "provider-source-import",
          source_updated_at: observedAt,
          source_collected_at: observedAt,
          accepted_at: observedAt,
          public_change_sequence: cause.sequence,
        },
      });
      await transaction.canonical_entities.update({
        where: { id: entity.id },
        data: { current_revision_id: revision.id },
      });
      return {
        semanticObservationId: observation.semanticObservationId,
        semanticContentHash,
        canonicalRevisionId: revision.id,
      };
    },
  );
}

function canonicalSourceReference(
  referenceIndex: number,
  canonicalRevisionId: string,
  sourceManifestSha256: string,
) {
  return {
    referenceIndex,
    sourceRevisionId: `canonical:${canonicalRevisionId}`,
    sourceManifestSha256,
    canonicalRevisionId,
  } as const;
}

function availableInput(input: Readonly<{
  fixture: ProviderSourceAcceptanceFixture;
  source: AcceptanceSource;
  productKey: string;
  productRevisionId: string;
  governingSemanticObservationId: string;
  governingSemanticContentHash: string;
  canonicalReferences: readonly ReturnType<typeof canonicalSourceReference>[];
  hashCharacters: readonly [string, string, string];
}>): PersistBuybackEvRevisionRowInput {
  const governingSourceRevisionId =
    `semantic:${input.governingSemanticObservationId}`;
  return {
    organizationId: input.fixture.organizationId,
    providerId: input.source.providerId,
    providerSourceRevisionId: input.source.sourceRevisionId,
    platformKey: input.source.platformKey,
    productKey: input.productKey,
    productRevisionId: input.productRevisionId,
    status: "available",
    calculationKey: input.hashCharacters[0].repeat(64),
    effectiveFingerprint: input.hashCharacters[1].repeat(64),
    resultHash: input.hashCharacters[2].repeat(64),
    sourceRevisionId: governingSourceRevisionId,
    sourceManifestSha256: input.governingSemanticContentHash,
    observationCoherence: "provider_revision",
    oddsSource: "current_remaining_inventory",
    usedClosedRangeMidpoint: false,
    calculatedAt,
    dataAsOf: { state: "known", observedAt: observedAt.toISOString() },
    metrics: {
      packPriceMinorUnits: 10_000,
      underlyingOutcomeEvMinorUnits: 10_000,
      drawMultiplier: 1,
      grossEvMinorUnits: 8_500,
      grossReturnBasisPoints: 8_500,
      evDollarsMinorUnits: -1_500,
      evPercentBasisPoints: -1_500,
    },
    confidence: {
      scoreBasisPoints: 10_000,
      band: "high",
      limitationCodes: [],
    },
    freshness: {
      state: "current",
      sourceAgeMilliseconds: 300_000,
      expiresAt: freshnessExpiresAt,
    },
    internalReasons: [],
    publicPrimaryReason: null,
    sourceReferences: [
      {
        referenceIndex: 0,
        sourceRevisionId: governingSourceRevisionId,
        sourceManifestSha256: input.governingSemanticContentHash,
        canonicalRevisionId: null,
      },
      ...input.canonicalReferences,
    ],
  };
}

test("buyback EV persistence fences same-organization provider and canonical platform lineage", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "buyback-ev-provider-lineage",
  );
  try {
    const courtyard = await createAcceptanceProviderSource(fixture, {
      platformKey: "courtyard",
      displayName: "Courtyard",
      mapperKey: "courtyard-provider-observation",
      identityNamespaceKey:
        providerIdentityNamespaceByLaunchProvider.courtyard,
      intervalSeconds: 60,
      hashCharacter: "1",
    });
    const clutchpacks = await createAcceptanceProviderSource(fixture, {
      platformKey: "clutchpacks",
      displayName: "ClutchPacks",
      mapperKey: "clutchpacks-provider-observation",
      identityNamespaceKey:
        providerIdentityNamespaceByLaunchProvider.clutchpacks,
      intervalSeconds: 60,
      hashCharacter: "2",
    });
    const courtyardPack = await createCanonicalRevision(fixture, courtyard, {
      externalId: "courtyard-pack",
      recordKind: "pack",
      contentHashCharacter: "3",
      provenanceHashCharacter: "4",
    });
    const courtyardEvInput = await createCanonicalRevision(
      fixture,
      courtyard,
      {
        externalId: "courtyard-pack",
        recordKind: "ev_input",
        contentHashCharacter: "5",
        provenanceHashCharacter: "6",
      },
    );
    const mixtapePack = await createCanonicalRevision(fixture, courtyard, {
      externalId: "mixtape",
      recordKind: "pack",
      contentHashCharacter: "7",
      provenanceHashCharacter: "8",
    });
    const clutchpacksPack = await createCanonicalRevision(
      fixture,
      clutchpacks,
      {
        externalId: "clutchpacks-pack",
        recordKind: "pack",
        contentHashCharacter: "9",
        provenanceHashCharacter: "a",
      },
    );
    const repository = new BuybackEvRevisionRepository(fixture.database);
    const courtyardInput = availableInput({
      fixture,
      source: courtyard,
      productKey: "courtyard-pack",
      productRevisionId: courtyardPack.canonicalRevisionId,
      governingSemanticObservationId:
        courtyardPack.semanticObservationId,
      governingSemanticContentHash: courtyardPack.semanticContentHash,
      canonicalReferences: [
        canonicalSourceReference(
          1,
          courtyardPack.canonicalRevisionId,
          "3".repeat(64),
        ),
        canonicalSourceReference(
          2,
          courtyardEvInput.canonicalRevisionId,
          "5".repeat(64),
        ),
      ],
      hashCharacters: ["b", "c", "d"],
    });

    await assert.rejects(
      repository.persistCompletedRevision({
        ...courtyardInput,
        providerSourceRevisionId: clutchpacks.sourceRevisionId,
        productKey: "wrong-provider-source-revision",
        calculationKey: "e".repeat(64),
        effectiveFingerprint: "f".repeat(64),
        resultHash: "0".repeat(64),
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "TENANT_SCOPE_VIOLATION",
      "a same-organization source revision owned by another provider must fail closed",
    );

    const valid = await repository.persistCompletedRevision(courtyardInput);
    assert.equal(valid.outcome, "created");

    const mixtapeInput: PersistBuybackEvRevisionRowInput = {
      ...availableInput({
        fixture,
        source: courtyard,
        productKey: "mixtape",
        productRevisionId: mixtapePack.canonicalRevisionId,
        governingSemanticObservationId: mixtapePack.semanticObservationId,
        governingSemanticContentHash: mixtapePack.semanticContentHash,
        canonicalReferences: [
          canonicalSourceReference(
            1,
            mixtapePack.canonicalRevisionId,
            "7".repeat(64),
          ),
        ],
        hashCharacters: ["1", "2", "3"],
      }),
      status: "unavailable",
      metrics: null,
      confidence: null,
      internalReasons: ["MISSING_BUYBACK"],
      publicPrimaryReason: "BUYBACK_UNAVAILABLE",
    };
    const packOnly = await repository.persistCompletedRevision(mixtapeInput);
    assert.equal(packOnly.outcome, "created");

    await assert.rejects(
      repository.persistCompletedRevision({
        ...courtyardInput,
        productKey: "wrong-canonical-platform",
        calculationKey: "4".repeat(64),
        effectiveFingerprint: "5".repeat(64),
        resultHash: "6".repeat(64),
        sourceReferences: [
          courtyardInput.sourceReferences[0]!,
          canonicalSourceReference(
            1,
            clutchpacksPack.canonicalRevisionId,
            "9".repeat(64),
          ),
          canonicalSourceReference(
            2,
            courtyardEvInput.canonicalRevisionId,
            "5".repeat(64),
          ),
        ],
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "TENANT_SCOPE_VIOLATION",
      "a same-organization canonical revision owned by another provider platform must fail closed",
    );

    assert.equal(
      await fixture.database.buyback_ev_revisions.count(),
      2,
      "rejected cross-provider lineage must not persist a revision",
    );
    assert.deepEqual(
      await fixture.database.buyback_ev_revision_source_refs.groupBy({
        by: ["revision_id"],
        _count: { _all: true },
        orderBy: { _count: { revision_id: "desc" } },
      }).then((rows) => rows.map((row) => row._count._all).sort()),
      [2, 3],
      "price/pack plus EV-input references and Mixtape pack-only references both remain valid",
    );
  } finally {
    await fixture.close();
  }
});
