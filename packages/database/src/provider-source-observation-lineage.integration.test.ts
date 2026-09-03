import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_HASH_VERSION,
  emptyNormalizedProviderFacts,
  normalizedObservationSemanticContentSchema,
  providerIdentityNamespaceByLaunchProvider,
} from "@packscout/contracts";
import { ProviderSourceLifecycleRepository } from "./provider-source-lifecycle-repository.ts";
import {
  hashNormalizedObservationSemanticContent,
  ProviderSourceObservationRepository,
} from "./provider-source-observation-repository.ts";
import { allocatePublicChangeCauses } from "./public-change-settlement-repository.ts";
import { PipelineSetupRepository } from "./setup-repository.ts";
import { createMigratedTestDatabase } from "./test-support.ts";

const observedAt = new Date("2026-08-20T12:00:00.000Z");
const sourceTypeKey = "dataforrest-events-v1";
const sourceAdapterVersion = "dataforrest-events-adapter-v1";
const normalizedContractVersion = PROVIDER_OBSERVATION_CONTRACT_VERSION;

function catalogSemanticContent(input: {
  providerRecordId: string;
  entity: "pack" | "card";
  effectiveAt?: Date;
}) {
  const effectiveAt = (input.effectiveAt ?? observedAt).toISOString();
  return normalizedObservationSemanticContentSchema.parse({
    kind: "catalog" as const,
    entity: input.entity,
    providerRecordIdentity: {
      recordIdScopeKey:
        input.entity === "pack"
          ? ("catalog-pack-v1" as const)
          : ("catalog-card-v1" as const),
      providerRecordId: input.providerRecordId,
    },
    effectiveAt,
    firstSeenAt: effectiveAt,
    availability: "available" as const,
    providerFacts: emptyNormalizedProviderFacts(input.entity),
    relationships: [],
  });
}

async function sourceFixture() {
  const harness = await createMigratedTestDatabase();
  const setup = new PipelineSetupRepository(harness.database);
  const organizationId = await setup.createOrganization({
    slug: "semantic-observation-lineage",
    name: "Semantic observation lineage",
    createdAt: observedAt,
  });
  const providerId = await setup.createProviderSource({
    organizationId,
    platformKey: "courtyard",
    displayName: "Courtyard semantic lineage",
    createdAt: observedAt,
  });
  const lifecycle = new ProviderSourceLifecycleRepository(harness.database);
  const connection = await lifecycle.createConnectionProfileRevision({
    organizationId,
    sourceTypeKey,
    connectionTypeKey: "dataforrest-events-connection-v1",
    displayName: "DataForrest semantic lineage",
    requestLimit: 2,
    sourceAdapterVersion,
    revisionNumber: 1,
    configurationCiphertext: new Uint8Array(32).fill(1),
    configurationNonce: new Uint8Array(12).fill(2),
    configurationAuthTag: new Uint8Array(16).fill(3),
    encryptionKeyVersion: 1,
    configurationFingerprint: "a".repeat(64),
    actorKey: "operator-admin",
    createdAt: observedAt,
  });
  const source = await lifecycle.createSourceInstanceRevision({
    organizationId,
    providerId,
    connectionProfileId: connection.profileId,
    sourceTypeKey,
    sourceAdapterVersion,
    normalizedContractVersion,
    mapperKey: "courtyard-provider-observation",
    mapperVersion: "1",
    identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.courtyard,
    cursorCodecVersion: "dataforrest-cursor-v1",
    revisionNumber: 1,
    intervalSeconds: 60,
    configuration: { provider: "courtyard" },
    configurationHash: "b".repeat(64),
    recordIdScopes: [
      "catalog-pack-v1",
      "catalog-card-v1",
      "pull-v1",
      "trade-v1",
    ],
    actorKey: "operator-admin",
    createdAt: observedAt,
  });
  return {
    ...harness,
    organizationId,
    providerId,
    setup,
    lifecycle,
    ...connection,
    ...source,
  };
}

test("semantic observations share the outer commit and are the normalized canonical origin", async () => {
  const fixture = await sourceFixture();
  try {
    const repository = new ProviderSourceObservationRepository();
    const normalizedContent = catalogSemanticContent({
      entity: "pack",
      providerRecordId: "courtyard-pack-42",
    });
    const observationInput = {
      organizationId: fixture.organizationId,
      providerId: fixture.providerId,
      sourceInstanceId: fixture.sourceInstanceId,
      sourceRevisionId: fixture.sourceRevisionId,
      recordIdScopeKey: "catalog-pack-v1",
      providerRecordId: "courtyard-pack-42",
      recordKind: "catalog" as const,
      recordDiscriminator: "catalog_pack" as const,
      effectiveSourceTime: observedAt,
      normalizedContractVersion,
      hashVersion: PROVIDER_OBSERVATION_HASH_VERSION,
      normalizedContentHash:
        hashNormalizedObservationSemanticContent(normalizedContent),
      normalizedContent,
    };

    await assert.rejects(
      fixture.database.$transaction(async (transaction) => {
        await repository.upsertSemanticObservationInTransaction(
          transaction,
          observationInput,
        );
        throw new Error("forced canonical failure");
      }),
      /forced canonical failure/,
    );
    assert.equal(await fixture.database.source_record_identities.count(), 0);
    assert.equal(
      await fixture.database.source_semantic_observations.count(),
      0,
    );

    const committed = await fixture.database.$transaction(
      async (transaction) => {
        const observation =
          await repository.upsertSemanticObservationInTransaction(
            transaction,
            observationInput,
          );
        assert.equal(observation.kind, "ready");
        const [cause] = await allocatePublicChangeCauses(transaction, {
          organizationId: fixture.organizationId,
          changes: [
            {
              changeKind: "provider_projection",
              entityKey: "canonical:v1:courtyard:pack:courtyard-pack-42",
              sourceKey: "courtyard",
              sourceRevisionKey: observation.semanticObservationId,
              occurredAt: observedAt,
              catalogImpact: { kind: "none" },
            },
          ],
        });
        const entity = await transaction.canonical_entities.create({
          data: {
            organization_id: fixture.organizationId,
            platform_key: "courtyard",
            record_kind: "pack",
            external_id: "courtyard-pack-42",
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
            content_hash: "d".repeat(64),
            provenance_json: {
              semanticObservationId: observation.semanticObservationId,
            },
            provenance_hash: "e".repeat(64),
            actor_key: "provider-source-import",
            source_updated_at: observedAt,
            source_collected_at: observedAt,
            accepted_at: observedAt,
            public_change_sequence: cause!.sequence,
          },
        });
        await transaction.canonical_entities.update({
          where: { id: entity.id },
          data: { current_revision_id: revision.id },
        });
        return {
          observation,
          entityId: entity.id,
          revisionId: revision.id,
          publicChangeSequence: cause!.sequence,
        };
      },
    );

    assert.equal(committed.observation.semanticObservationCreated, true);
    const revision =
      await fixture.database.canonical_revisions.findUniqueOrThrow({
        where: { id: committed.revisionId },
        include: { source_semantic_observations: true },
      });
    assert.equal(revision.source_record_id, null);
    assert.equal(
      revision.source_semantic_observations?.id,
      committed.observation.semanticObservationId,
    );

    const replay = await fixture.database.$transaction((transaction) =>
      repository.upsertSemanticObservationInTransaction(
        transaction,
        observationInput,
      ),
    );
    assert.equal(replay.kind, "ready");
    assert.equal(replay.semanticObservationCreated, false);
    assert.equal(
      await fixture.database.source_semantic_observations.count(),
      1,
    );

    const derivedEvInput = await fixture.database.$transaction(
      async (transaction) => {
        const [cause] = await allocatePublicChangeCauses(transaction, {
          organizationId: fixture.organizationId,
          changes: [
            {
              changeKind: "provider_projection",
              entityKey:
                "canonical:v1:courtyard:ev_input:courtyard-pack-42",
              sourceKey: "courtyard",
              sourceRevisionKey: committed.observation.semanticObservationId,
              occurredAt: observedAt,
              catalogImpact: { kind: "none" },
            },
          ],
        });
        const entity = await transaction.canonical_entities.create({
          data: {
            organization_id: fixture.organizationId,
            platform_key: "courtyard",
            record_kind: "ev_input",
            external_id: "courtyard-pack-42",
          },
        });
        const revision = await transaction.canonical_revisions.create({
          data: {
            organization_id: fixture.organizationId,
            entity_id: entity.id,
            revision_number: 1,
            source_record_id: null,
            origin_semantic_observation_id:
              committed.observation.semanticObservationId,
            content_json: { approved: false },
            content_hash: "1".repeat(64),
            provenance_json: {
              semanticObservationId:
                committed.observation.semanticObservationId,
            },
            provenance_hash: "2".repeat(64),
            actor_key: "provider-source-import",
            source_updated_at: observedAt,
            source_collected_at: observedAt,
            accepted_at: observedAt,
            public_change_sequence: cause!.sequence,
          },
        });
        return { entityId: entity.id, revisionId: revision.id };
      },
    );
    assert.equal(
      (
        await fixture.database.canonical_revisions.findUniqueOrThrow({
          where: { id: derivedEvInput.revisionId },
        })
      ).origin_semantic_observation_id,
      committed.observation.semanticObservationId,
    );

    const originConstraints = await fixture.database.$queryRaw<
      Array<{
        definition: string;
      }>
    >`
      select pg_get_constraintdef(oid) as definition
      from pg_constraint
      where conname = 'canonical_revisions_exactly_one_source_origin_check'
    `;
    assert.match(
      originConstraints[0]?.definition ?? "",
      /num_nonnulls\(source_record_id, origin_semantic_observation_id, origin_ev_recomputation_request_id\) = 1/u,
    );

    const assertRejectedOrigin = async (
      semanticObservationId: string,
      entityId = committed.entityId,
    ): Promise<void> => {
      const revisionCountBefore =
        await fixture.database.canonical_revisions.count();
      await assert.rejects(
        fixture.database.canonical_revisions.create({
          data: {
            organization_id: fixture.organizationId,
            entity_id: entityId,
            revision_number: 2,
            source_record_id: null,
            origin_semantic_observation_id: semanticObservationId,
            content_json: { availability: "unavailable" },
            content_hash: "f".repeat(64),
            provenance_json: { semanticObservationId },
            provenance_hash: "0".repeat(64),
            actor_key: "provider-source-import",
            source_updated_at: observedAt,
            source_collected_at: observedAt,
            accepted_at: observedAt,
            public_change_sequence: committed.publicChangeSequence,
          },
        }),
        /canonical semantic origin does not match entity identity/u,
      );
      assert.equal(
        await fixture.database.canonical_revisions.count(),
        revisionCountBefore,
      );
    };

    const crossRecordObservation = await fixture.database.$transaction(
      (transaction) => {
        const normalizedCrossRecordContent = catalogSemanticContent({
          entity: "pack",
          providerRecordId: "courtyard-pack-99",
        });
        return repository.upsertSemanticObservationInTransaction(transaction, {
          ...observationInput,
          providerRecordId: "courtyard-pack-99",
          normalizedContent: normalizedCrossRecordContent,
          normalizedContentHash: hashNormalizedObservationSemanticContent(
            normalizedCrossRecordContent,
          ),
        });
      },
    );
    assert.equal(crossRecordObservation.kind, "ready");
    await assertRejectedOrigin(crossRecordObservation.semanticObservationId);

    const crossKindObservation = await fixture.database.$transaction(
      (transaction) => {
        const normalizedCardContent = catalogSemanticContent({
          entity: "card",
          providerRecordId: "courtyard-pack-42",
        });
        return repository.upsertSemanticObservationInTransaction(transaction, {
          ...observationInput,
          recordIdScopeKey: "catalog-card-v1",
          recordDiscriminator: "catalog_card",
          normalizedContentHash: hashNormalizedObservationSemanticContent(
            normalizedCardContent,
          ),
          normalizedContent: normalizedCardContent,
        });
      },
    );
    assert.equal(crossKindObservation.kind, "ready");
    await assertRejectedOrigin(crossKindObservation.semanticObservationId);

    const invalidDerivedEntity =
      await fixture.database.canonical_entities.create({
        data: {
          organization_id: fixture.organizationId,
          platform_key: "courtyard",
          record_kind: "estimated_ev",
          external_id: "courtyard-pack-42",
        },
      });
    await assertRejectedOrigin(
      committed.observation.semanticObservationId,
      invalidDerivedEntity.id,
    );

    const cardAsEvInputEntity =
      await fixture.database.canonical_entities.create({
        data: {
          organization_id: fixture.organizationId,
          platform_key: "courtyard",
          record_kind: "ev_input",
          external_id: "courtyard-pack-42-card-origin",
        },
      });
    const cardAsEvInputObservation = await fixture.database.$transaction(
      (transaction) => {
        const normalizedCardContent = catalogSemanticContent({
          entity: "card",
          providerRecordId: "courtyard-pack-42-card-origin",
        });
        return repository.upsertSemanticObservationInTransaction(transaction, {
          ...observationInput,
          recordIdScopeKey: "catalog-card-v1",
          providerRecordId: "courtyard-pack-42-card-origin",
          recordDiscriminator: "catalog_card",
          normalizedContentHash: hashNormalizedObservationSemanticContent(
            normalizedCardContent,
          ),
          normalizedContent: normalizedCardContent,
        });
      },
    );
    assert.equal(cardAsEvInputObservation.kind, "ready");
    await assertRejectedOrigin(
      cardAsEvInputObservation.semanticObservationId,
      cardAsEvInputEntity.id,
    );

    const otherProviderId = await fixture.setup.createProviderSource({
      organizationId: fixture.organizationId,
      platformKey: "collector_crypt",
      displayName: "Collector Crypt semantic lineage",
      createdAt: observedAt,
    });
    const otherSource = await fixture.lifecycle.createSourceInstanceRevision({
      organizationId: fixture.organizationId,
      providerId: otherProviderId,
      connectionProfileId: fixture.profileId,
      sourceTypeKey,
      sourceAdapterVersion,
      normalizedContractVersion,
      mapperKey: "collector-crypt-provider-observation",
      mapperVersion: "1",
      identityNamespaceKey:
        providerIdentityNamespaceByLaunchProvider.collector_crypt,
      cursorCodecVersion: "dataforrest-cursor-v1",
      revisionNumber: 1,
      intervalSeconds: 60,
      configuration: { provider: "collector_crypt" },
      configurationHash: "3".repeat(64),
      recordIdScopes: [
        "catalog-pack-v1",
        "catalog-card-v1",
        "pull-v1",
        "trade-v1",
      ],
      actorKey: "operator-admin",
      createdAt: observedAt,
    });
    const crossProviderObservation = await fixture.database.$transaction(
      (transaction) =>
        repository.upsertSemanticObservationInTransaction(transaction, {
          ...observationInput,
          providerId: otherProviderId,
          sourceInstanceId: otherSource.sourceInstanceId,
          sourceRevisionId: otherSource.sourceRevisionId,
        }),
    );
    assert.equal(crossProviderObservation.kind, "ready");
    await assertRejectedOrigin(crossProviderObservation.semanticObservationId);

    const originTriggers = await fixture.database.$queryRaw<
      Array<{ definition: string }>
    >`
      select pg_get_triggerdef(oid) as definition
      from pg_trigger
      where tgname = 'canonical_revision_semantic_origin_identity_guard'
        and not tgisinternal
    `;
    assert.match(
      originTriggers[0]?.definition ?? "",
      /enforce_canonical_semantic_origin_identity/u,
    );
  } finally {
    await fixture.close();
  }
});
