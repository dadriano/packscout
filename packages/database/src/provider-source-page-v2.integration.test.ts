import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
  PROVIDER_OBSERVATION_HASH_VERSION_V2,
  emptyNormalizedProviderFacts,
  normalizedObservationSemanticContentV2,
  normalizedObservationSemanticCanonicalJsonV2,
  normalizedProviderObservationPageV2Schema,
  normalizedProviderObservationV2Schema,
  providerSourceSuccessfulCaptureCanonicalJson,
  type ProviderSourceCanonicalProjectionPlan,
  type ProviderSourcePagePlanV2,
} from "@packscout/contracts";
import {
  ACCEPTANCE_CURSOR_CODEC_VERSION,
  ACCEPTANCE_SOURCE_ADAPTER_VERSION,
  ACCEPTANCE_SOURCE_TYPE_KEY,
  createProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";
import { ProviderSourceImportRunRepository } from
  "./provider-source-import-run-repository.ts";
import { ProviderSourcePageRepository } from
  "./provider-source-page-repository.ts";
import { ProviderSourceSupervisorRepository } from
  "./provider-source-supervisor-repository.ts";
import { hashJson } from "./security.ts";
import type { PackscoutPrismaClient } from "./database.ts";

async function databaseNow(database: PackscoutPrismaClient): Promise<Date> {
  const [row] = await database.$queryRaw<Array<{ now: Date }>>`
    select clock_timestamp() as "now"
  `;
  return row!.now;
}

function pullObservation(
  providerRecordId: string,
  relationship: Readonly<{
    relationship: "pack" | "card";
    target: Readonly<{
      recordIdScopeKey: "catalog-pack-v1" | "catalog-card-v1";
      providerRecordId: string;
    }>;
  }>,
  effectiveAt: string,
) {
  return normalizedProviderObservationV2Schema.parse({
    kind: "pull",
    providerRecordIdentity: {
      recordIdScopeKey: "pull-v1",
      providerRecordId,
    },
    effectiveAt,
    collectedAt: effectiveAt,
    providerFacts: emptyNormalizedProviderFacts("pull"),
    relationships: [relationship],
    protectedNativeEvidenceRef: `evidence:${providerRecordId}`,
  });
}

function projectionFor(
  observation: ReturnType<typeof pullObservation>,
): ProviderSourceCanonicalProjectionPlan {
  if (observation.kind !== "pull") throw new TypeError("pull required");
  const content = {
    eventKind: "pull",
    displayName: null,
    imageUrls: [],
    value: null,
    valueSource: null,
  } as const;
  return {
    projectionKind: "primary",
    platformKey: "clutchpacks",
    recordKind: "pull",
    providerRecordId: observation.providerRecordIdentity.providerRecordId,
    recordIdScopeKey: "pull-v1",
    effectiveAt: observation.effectiveAt,
    contentFingerprint: hashJson(content),
    content,
    relationships: observation.relationships.map((relationship) => ({
      relationship: relationship.relationship,
      targetRecordIdScopeKey: relationship.target.recordIdScopeKey,
      targetCanonicalKind: relationship.relationship === "pack"
        ? "pack" as const
        : "catalog_asset" as const,
      targetProviderRecordId: relationship.target.providerRecordId,
    })),
    affectedPackProviderRecordId: null,
    evInputStatus: "not_applicable",
  };
}

test("atomic v2 page commit stores each one-target pull without fabricating an edge", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "atomic-v2-one-target-pulls",
  );
  try {
    const now = await databaseNow(fixture.database);
    const providerId = await fixture.setup.createProviderSource({
      organizationId: fixture.organizationId,
      platformKey: "clutchpacks",
      displayName: "ClutchPacks",
      createdAt: now,
    });
    const source = await fixture.lifecycle.createSourceInstanceRevision({
      organizationId: fixture.organizationId,
      providerId,
      connectionProfileId: fixture.connectionProfileId,
      sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
      sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
      mapperKey: "clutchpacks-provider-observation",
      mapperVersion: "2",
      identityNamespaceKey: "dataforrest-clutchpacks-records-v1",
      cursorCodecVersion: ACCEPTANCE_CURSOR_CODEC_VERSION,
      revisionNumber: 1,
      intervalSeconds: 60,
      configuration: { provider: "clutchpacks" },
      configurationHash: "6".repeat(64),
      recordIdScopes: [
        "catalog-pack-v1",
        "catalog-card-v1",
        "pull-v1",
        "trade-v1",
      ],
      actorKey: "operator-admin",
      createdAt: now,
    });
    await fixture.database.$transaction(async (transaction) => {
      await transaction.provider_sources.update({
        where: { id: providerId },
        data: { state: "active", updated_at: now },
      });
      await transaction.source_connection_revisions.update({
        where: { id: fixture.connectionRevisionId },
        data: { state: "active", activated_at: now },
      });
      await transaction.source_connection_profiles.update({
        where: { id: fixture.connectionProfileId },
        data: {
          state: "active",
          active_revision_id: fixture.connectionRevisionId,
          updated_at: now,
        },
      });
      await transaction.provider_source_instances.update({
        where: { id: source.sourceInstanceId },
        data: { state: "active", activated_at: now, updated_at: now },
      });
    });

    const runId = randomUUID();
    const requested = await new ProviderSourceImportRunRepository(
      fixture.database,
    ).requestRun({
      organizationId: fixture.organizationId,
      providerId,
      runId,
      trigger: "manual",
      requestedByActorKey: "operator-admin",
      requestedAt: await databaseNow(fixture.database),
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    assert.equal(requested.kind, "created");
    if (requested.kind !== "created") throw new Error("run unavailable");

    const ownerKey = "atomic-v2-worker";
    const supervisorLeaseToken = randomUUID();
    const supervisor = await new ProviderSourceSupervisorRepository(
      fixture.database,
    ).acquire({
      environmentKey: "atomic-v2-one-target-pulls",
      ownerKey,
      leaseToken: supervisorLeaseToken,
      now: await databaseNow(fixture.database),
    });
    const runLeaseToken = randomUUID();
    const runClaimLeaseId = randomUUID();
    await fixture.database.import_runs.update({
      where: { id: runId },
      data: {
        state: "running",
        started_at: await databaseNow(fixture.database),
        lease_owner: ownerKey,
        lease_token: runLeaseToken,
        claim_lease_id: runClaimLeaseId,
        lease_expires_at: supervisor.leaseExpiresAt,
      },
    });

    const requestedCursor = {
      sourceInstanceId: source.sourceInstanceId,
      sourceRevisionId: source.sourceRevisionId,
      sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
      adapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
      cursorCodecKey: ACCEPTANCE_CURSOR_CODEC_VERSION,
      cursorGeneration: 1,
      value: null,
    } as const;
    const nextCursor = { ...requestedCursor, value: "cursor-v2-next" };
    const effectiveAt = now.toISOString();
    const observations = [
      pullObservation("pull-card-only", {
        relationship: "card",
        target: {
          recordIdScopeKey: "catalog-card-v1",
          providerRecordId: "card-1",
        },
      }, effectiveAt),
      pullObservation("pull-pack-only", {
        relationship: "pack",
        target: {
          recordIdScopeKey: "catalog-pack-v1",
          providerRecordId: "pack-1",
        },
      }, effectiveAt),
    ] as const;
    const rawResponse = new TextEncoder().encode("v2-one-target-pulls");
    const normalizedPage = normalizedProviderObservationPageV2Schema.parse({
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
      provider: "clutchpacks",
      outcomes: observations.map((observation, recordIndex) => ({
        status: "valid" as const,
        recordIndex,
        observation,
      })),
      nextCursor,
      continuation: { kind: "continue" },
      measurements: {
        durationMilliseconds: 7,
        responseBytes: rawResponse.byteLength,
        recordCount: observations.length,
      },
      diagnostics: [],
    });
    const plan = {
      normalizedPage,
      outcomes: observations.map((observation, recordIndex) => {
        const semanticContent = normalizedObservationSemanticContentV2(
          observation,
        );
        return {
          kind: "semantic" as const,
          recordIndex,
          observation,
          semanticContent,
          normalizedContentHash: createHash("sha256")
            .update(normalizedObservationSemanticCanonicalJsonV2(
              semanticContent,
            ))
            .digest("hex"),
          protectedNativeEvidenceRef: observation.protectedNativeEvidenceRef,
          protectedTransactionEvidenceRef: null,
          warnings: [],
          mapping: {
            status: "mapped" as const,
            projections: [projectionFor(observation)],
          },
        };
      }),
      counts: {
        catalog: 0,
        pulls: 2,
        trades: 0,
        adapterInvalid: 0,
        mapperQuarantined: 0,
        warnings: 0,
      },
    } satisfies ProviderSourcePagePlanV2;
    const rawResponseSha256 = createHash("sha256")
      .update(rawResponse)
      .digest("hex");
    const requestAttemptId = randomUUID();
    const requestLeaseId = randomUUID();
    const pageId = randomUUID();
    const capturedAt = await databaseNow(fixture.database);
    const captureHash = createHash("sha256")
      .update(providerSourceSuccessfulCaptureCanonicalJson({
        protectedRawResponseSha256: rawResponseSha256,
        responseBytes: normalizedPage.measurements.responseBytes,
        durationMilliseconds:
          normalizedPage.measurements.durationMilliseconds,
      }))
      .digest("hex");
    await fixture.database.compact_source_request_attempts.create({
      data: {
        request_attempt_id: requestAttemptId,
        organization_id: fixture.organizationId,
        operation_kind: "page_read",
        request_lease_id: requestLeaseId,
        claim_owner: ownerKey,
        claim_token: runLeaseToken,
        supervisor_epoch_id: supervisor.epochId,
        connection_profile_id: fixture.connectionProfileId,
        connection_revision_id: fixture.connectionRevisionId,
        expected_health_generation: 0n,
        provider_id: providerId,
        source_instance_id: source.sourceInstanceId,
        source_revision_id: source.sourceRevisionId,
        run_id: runId,
        page_number: 1,
        cursor_generation: 1n,
        requested_cursor_key: "initial",
        terminal_state: "captured",
        outcome_class: "response_captured",
        safe_outcome_hash: captureHash,
        response_bytes: normalizedPage.measurements.responseBytes,
        duration_ms: normalizedPage.measurements.durationMilliseconds,
        started_at: capturedAt,
        terminal_at: capturedAt,
      },
    });

    const committed = await new ProviderSourcePageRepository(fixture.database, {
      actorPseudonymKey: new Uint8Array(32).fill(11),
    }).commitPage({
      pins: {
        organizationId: fixture.organizationId,
        providerId,
        provider: "clutchpacks",
        sourceInstanceId: source.sourceInstanceId,
        sourceRevisionId: source.sourceRevisionId,
        sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
        sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
        normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
        mapperKey: "clutchpacks-provider-observation",
        mapperVersion: "2",
        identityNamespaceKey: "dataforrest-clutchpacks-records-v1",
        connectionProfileId: fixture.connectionProfileId,
        connectionRevisionId: fixture.connectionRevisionId,
        connectionHealthGeneration: 0n,
        requestAttemptId,
        requestLeaseId,
        supervisorEpochId: supervisor.epochId,
        singletonFencingEpoch: Number(supervisor.epochNumber),
        supervisorOwnerKey: ownerKey,
        supervisorLeaseToken,
        runId,
        runTrigger: "manual",
        runLeaseOwner: ownerKey,
        runLeaseToken,
        runClaimLeaseId,
        pageId,
        pageNumber: 1,
        cursorCodecVersion: ACCEPTANCE_CURSOR_CODEC_VERSION,
        cursorGeneration: 1n,
        requestedCursor,
        requestedCursorFingerprint: null,
      },
      plan,
      protectedRawResponse: rawResponse,
      protectedRawResponseSha256: rawResponseSha256,
      protectedNativeEvidence: observations.map((observation) => ({
        reference: observation.protectedNativeEvidenceRef,
        value: {
          providerRecordId:
            observation.providerRecordIdentity.providerRecordId,
        },
      })),
      nextCursorFingerprint: "c".repeat(64),
      committedAt: capturedAt,
    });
    assert.equal(committed.kind, "committed");
    assert.deepEqual(committed.counts, {
      inserted: 2,
      revised: 0,
      duplicate: 0,
      quarantined: 0,
      warnings: 0,
      unresolvedRelationships: 2,
      canonicalRevisions: 2,
      evRequests: 0,
    });

    const relationships = await fixture.database.$queryRaw<Array<{
      sourceExternalId: string;
      relationshipKind: string;
      targetRecordKind: string;
      targetExternalId: string;
    }>>`
      select source.external_id as "sourceExternalId",
             relationship.relationship_kind as "relationshipKind",
             relationship.target_record_kind::text as "targetRecordKind",
             relationship.target_external_id as "targetExternalId"
      from public.canonical_relationships as relationship
      join public.canonical_entities as source
        on source.id = relationship.source_entity_id
       and source.organization_id = relationship.organization_id
      where relationship.organization_id = ${fixture.organizationId}::uuid
        and source.platform_key = 'clutchpacks'
        and source.record_kind = 'pull'::public.canonical_record_kind
      order by source.external_id
    `;
    assert.deepEqual(relationships, [
      {
        sourceExternalId: "pull-card-only",
        relationshipKind: "card",
        targetRecordKind: "catalog_asset",
        targetExternalId: "card-1",
      },
      {
        sourceExternalId: "pull-pack-only",
        relationshipKind: "pack",
        targetRecordKind: "pack",
        targetExternalId: "pack-1",
      },
    ]);
    assert.equal(
      await fixture.database.canonical_entities.count({
        where: {
          organization_id: fixture.organizationId,
          platform_key: "clutchpacks",
          record_kind: "pull",
        },
      }),
      2,
    );
    assert.equal(
      await fixture.database.source_semantic_observations.count({
        where: {
          organization_id: fixture.organizationId,
          normalized_contract_version:
            PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
          hash_version: PROVIDER_OBSERVATION_HASH_VERSION_V2,
        },
      }),
      2,
    );
  } finally {
    await fixture.close();
  }
});
