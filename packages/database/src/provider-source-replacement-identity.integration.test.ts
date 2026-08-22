import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyNormalizedProviderFacts,
  normalizedObservationSemanticContentSchema,
  providerIdentityNamespaceByLaunchProvider,
} from "@packscout/contracts";
import { ProviderSourceDiagnosticRepository } from "./provider-source-diagnostic-repository.ts";
import {
  hashNormalizedObservationSemanticContent,
  ProviderSourceObservationRepository,
} from "./provider-source-observation-repository.ts";
import { allocatePublicChangeCauses } from "./public-change-settlement-repository.ts";
import {
  ACCEPTANCE_CREATED_AT,
  ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
  ACCEPTANCE_OBSERVATION_HASH_VERSION,
  ACCEPTANCE_SOURCE_ADAPTER_VERSION,
  ACCEPTANCE_SOURCE_TYPE_KEY,
  createAcceptanceProviderSource,
  createAcceptanceSourceInstance,
  createPinnedSourceRun,
  createProviderSourceAcceptanceFixture,
  type AcceptanceSource,
  type ProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";

const courtyardDefinition = {
  platformKey: "courtyard",
  displayName: "Courtyard",
  mapperKey: "courtyard-provider-observation",
  identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.courtyard,
  intervalSeconds: 60,
  hashCharacter: "b",
} as const;

const collectorDefinition = {
  platformKey: "collector_crypt",
  displayName: "Collector Crypt",
  mapperKey: "collector-crypt-provider-observation",
  identityNamespaceKey:
    providerIdentityNamespaceByLaunchProvider.collector_crypt,
  intervalSeconds: 120,
  hashCharacter: "c",
} as const;

function normalizedPackContent(effectiveAt: Date) {
  return normalizedObservationSemanticContentSchema.parse({
    kind: "catalog",
    entity: "pack",
    providerRecordIdentity: {
      recordIdScopeKey: "catalog-pack-v1",
      providerRecordId: "shared-pack-42",
    },
    effectiveAt: effectiveAt.toISOString(),
    firstSeenAt: ACCEPTANCE_CREATED_AT.toISOString(),
    availability: "available",
    providerFacts: emptyNormalizedProviderFacts("pack"),
    relationships: [],
  });
}

async function snapshotSource(
  fixture: ProviderSourceAcceptanceFixture,
  source: AcceptanceSource,
) {
  return Promise.all([
    fixture.database.provider_sources.findUniqueOrThrow({
      where: { id: source.providerId },
    }),
    fixture.database.provider_source_instances.findUniqueOrThrow({
      where: { id: source.sourceInstanceId },
    }),
    fixture.database.provider_source_schedules.findUniqueOrThrow({
      where: { source_instance_id: source.sourceInstanceId },
    }),
    fixture.database.provider_source_checkpoints.findUniqueOrThrow({
      where: { source_instance_id: source.sourceInstanceId },
    }),
    fixture.database.provider_source_health_states.findUniqueOrThrow({
      where: { source_instance_id: source.sourceInstanceId },
    }),
    fixture.database.import_runs.findMany({
      where: { source_instance_id: source.sourceInstanceId },
      orderBy: { created_at: "asc" },
    }),
    fixture.database.source_processor_diagnostic_events.findMany({
      where: { source_instance_id: source.sourceInstanceId },
      orderBy: { occurred_at: "asc" },
    }),
  ]);
}

async function appendCanonicalPackRevision(
  fixture: ProviderSourceAcceptanceFixture,
  input: Readonly<{
    entityId: string | null;
    semanticObservationId: string;
    revisionNumber: number;
    observedAt: Date;
    contentHashCharacter: string;
    provenanceHashCharacter: string;
  }>,
): Promise<{ entityId: string; revisionId: string }> {
  return fixture.database.$transaction(async (transaction) => {
    const [cause] = await allocatePublicChangeCauses(transaction, {
      organizationId: fixture.organizationId,
      changes: [
        {
          changeKind: "provider_projection",
          entityKey: "canonical:v1:courtyard:pack:shared-pack-42",
          sourceKey: "courtyard",
          sourceRevisionKey: input.semanticObservationId,
          occurredAt: input.observedAt,
          catalogImpact: { kind: "none" },
        },
      ],
    });
    const entity = input.entityId
      ? await transaction.canonical_entities.findUniqueOrThrow({
          where: { id: input.entityId },
        })
      : await transaction.canonical_entities.create({
          data: {
            organization_id: fixture.organizationId,
            platform_key: "courtyard",
            record_kind: "pack",
            external_id: "shared-pack-42",
          },
        });
    const revision = await transaction.canonical_revisions.create({
      data: {
        organization_id: fixture.organizationId,
        entity_id: entity.id,
        revision_number: input.revisionNumber,
        source_record_id: null,
        origin_semantic_observation_id: input.semanticObservationId,
        content_json: {
          available: true,
          revision: input.revisionNumber,
        },
        content_hash: input.contentHashCharacter.repeat(64),
        provenance_json: {
          semanticObservationId: input.semanticObservationId,
        },
        provenance_hash: input.provenanceHashCharacter.repeat(64),
        actor_key: "provider-source-import",
        source_updated_at: input.observedAt,
        source_collected_at: input.observedAt,
        accepted_at: input.observedAt,
        public_change_sequence: cause!.sequence,
      },
    });
    await transaction.canonical_entities.update({
      where: { id: entity.id },
      data: { current_revision_id: revision.id },
    });
    return { entityId: entity.id, revisionId: revision.id };
  });
}

test("source replacement preserves provider and canonical identity without touching a sibling", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "replacement-identity",
  );
  try {
    const original = await createAcceptanceProviderSource(
      fixture,
      courtyardDefinition,
    );
    const sibling = await createAcceptanceProviderSource(
      fixture,
      collectorDefinition,
    );
    const siblingRun = await createPinnedSourceRun(
      fixture.database,
      fixture,
      sibling,
      {
        state: "succeeded",
        createdAt: ACCEPTANCE_CREATED_AT,
        requestedCheckpoint: null,
        requestedCheckpointFingerprint: null,
      },
    );
    await fixture.database.provider_source_schedules.update({
      where: { source_instance_id: sibling.sourceInstanceId },
      data: { last_run_id: siblingRun.id, last_outcome: "head_reached" },
    });
    const diagnostics = new ProviderSourceDiagnosticRepository(
      fixture.database,
    );
    await diagnostics.append({
      organizationId: fixture.organizationId,
      scope: "source",
      correlationKind: "run",
      eventKind: "source_run",
      severity: "info",
      phase: "run",
      safeCode: "COLLECTOR_CRYPT_RUN",
      occurredAt: ACCEPTANCE_CREATED_AT,
      sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
      sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
      normalizedContractVersion: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
      providerId: sibling.providerId,
      sourceInstanceId: sibling.sourceInstanceId,
      sourceRevisionId: sibling.sourceRevisionId,
      connectionProfileId: fixture.connectionProfileId,
      connectionRevisionId: fixture.connectionRevisionId,
      runId: siblingRun.id,
      runTrigger: "scheduled",
    });
    const siblingBefore = await snapshotSource(fixture, sibling);

    const observations = new ProviderSourceObservationRepository();
    const originalNormalizedPackContent = normalizedPackContent(
      ACCEPTANCE_CREATED_AT,
    );
    const firstObservation = await fixture.database.$transaction(
      (transaction) =>
        observations.upsertSemanticObservationInTransaction(transaction, {
          organizationId: fixture.organizationId,
          providerId: original.providerId,
          sourceInstanceId: original.sourceInstanceId,
          sourceRevisionId: original.sourceRevisionId,
          recordIdScopeKey: "catalog-pack-v1",
          providerRecordId: "shared-pack-42",
          recordKind: "catalog",
          recordDiscriminator: "catalog_pack",
          effectiveSourceTime: ACCEPTANCE_CREATED_AT,
          normalizedContractVersion: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
          hashVersion: ACCEPTANCE_OBSERVATION_HASH_VERSION,
          normalizedContentHash: hashNormalizedObservationSemanticContent(
            originalNormalizedPackContent,
          ),
          normalizedContent: originalNormalizedPackContent,
        }),
    );
    assert.equal(firstObservation.kind, "ready");
    const canonical = await appendCanonicalPackRevision(fixture, {
      entityId: null,
      semanticObservationId: firstObservation.semanticObservationId,
      revisionNumber: 1,
      observedAt: ACCEPTANCE_CREATED_AT,
      contentHashCharacter: "e",
      provenanceHashCharacter: "f",
    });

    const replacedAt = new Date(ACCEPTANCE_CREATED_AT.getTime() + 10_000);
    await fixture.database.provider_source_instances.update({
      where: { id: original.sourceInstanceId },
      data: {
        state: "replaced",
        replaced_at: replacedAt,
        updated_at: replacedAt,
      },
    });
    const replacementIds = await createAcceptanceSourceInstance(fixture, {
      providerId: original.providerId,
      definition: {
        ...courtyardDefinition,
        hashCharacter: "9",
        createdAt: replacedAt,
      },
    });
    const replacement: AcceptanceSource = {
      ...original,
      ...replacementIds,
    };
    const secondObservation = await fixture.database.$transaction(
      (transaction) => {
        const replacementNormalizedPackContent =
          normalizedPackContent(replacedAt);
        return observations.upsertSemanticObservationInTransaction(
          transaction,
          {
            organizationId: fixture.organizationId,
            providerId: replacement.providerId,
            sourceInstanceId: replacement.sourceInstanceId,
            sourceRevisionId: replacement.sourceRevisionId,
            recordIdScopeKey: "catalog-pack-v1",
            providerRecordId: "shared-pack-42",
            recordKind: "catalog",
            recordDiscriminator: "catalog_pack",
            effectiveSourceTime: replacedAt,
            normalizedContractVersion: ACCEPTANCE_NORMALIZED_CONTRACT_VERSION,
            hashVersion: ACCEPTANCE_OBSERVATION_HASH_VERSION,
            normalizedContentHash: hashNormalizedObservationSemanticContent(
              replacementNormalizedPackContent,
            ),
            normalizedContent: replacementNormalizedPackContent,
          },
        );
      },
    );
    assert.equal(secondObservation.kind, "ready");
    await appendCanonicalPackRevision(fixture, {
      entityId: canonical.entityId,
      semanticObservationId: secondObservation.semanticObservationId,
      revisionNumber: 2,
      observedAt: replacedAt,
      contentHashCharacter: "2",
      provenanceHashCharacter: "3",
    });

    const providerSources =
      await fixture.database.provider_source_instances.findMany({
        where: { provider_id: original.providerId },
        orderBy: { created_at: "asc" },
      });
    assert.equal(providerSources.length, 2);
    assert.deepEqual(
      providerSources.map(({ provider_id: providerId }) => providerId),
      [original.providerId, original.providerId],
    );
    assert.deepEqual(
      providerSources.map(({ state }) => state),
      ["replaced", "draft"],
    );
    assert.equal(
      await fixture.database.canonical_entities.count({
        where: {
          organization_id: fixture.organizationId,
          platform_key: "courtyard",
          record_kind: "pack",
          external_id: "shared-pack-42",
        },
      }),
      1,
    );
    const canonicalRevisions =
      await fixture.database.canonical_revisions.findMany({
        where: { entity_id: canonical.entityId },
        orderBy: { revision_number: "asc" },
        include: { source_semantic_observations: true },
      });
    assert.equal(canonicalRevisions.length, 2);
    const semanticSourceRecords =
      await fixture.database.source_record_identities.findMany({
        where: {
          id: {
            in: canonicalRevisions.map(
              ({ source_semantic_observations: observation }) =>
                observation!.source_record_id,
            ),
          },
        },
        orderBy: { created_at: "asc" },
      });
    assert.deepEqual(
      new Set(
        semanticSourceRecords.map(
          ({ source_instance_id: sourceInstanceId }) => sourceInstanceId,
        ),
      ),
      new Set([original.sourceInstanceId, replacement.sourceInstanceId]),
    );
    const [oldCheckpoint, replacementCheckpoint] = await Promise.all([
      fixture.database.provider_source_checkpoints.findUniqueOrThrow({
        where: { source_instance_id: original.sourceInstanceId },
      }),
      fixture.database.provider_source_checkpoints.findUniqueOrThrow({
        where: { source_instance_id: replacement.sourceInstanceId },
      }),
    ]);
    assert.equal(oldCheckpoint.checkpoint_fingerprint, null);
    assert.equal(replacementCheckpoint.checkpoint_fingerprint, null);
    assert.deepEqual(await snapshotSource(fixture, sibling), siblingBefore);
  } finally {
    await fixture.close();
  }
});
