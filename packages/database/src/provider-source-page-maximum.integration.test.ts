import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  emptyNormalizedProviderFacts,
  normalizedObservationSemanticCanonicalJson,
  normalizedObservationSemanticContent,
  normalizedProviderObservationPageSchema,
  normalizedProviderObservationSchema,
  providerSourceSuccessfulCaptureCanonicalJson,
  type ProviderSourceCanonicalProjectionPlan,
  type ProviderSourcePagePlan,
} from "@packscout/contracts";
import {
  ACCEPTANCE_CURSOR_CODEC_VERSION,
  ACCEPTANCE_SOURCE_ADAPTER_VERSION,
  ACCEPTANCE_SOURCE_TYPE_KEY,
  activateAcceptanceRuntime,
  createAcceptanceProviderSource,
  createProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";
import type { PackscoutPrismaClient } from "./database.ts";
import { ProviderSourceImportRunRepository } from
  "./provider-source-import-run-repository.ts";
import { ProviderSourcePageRepository } from
  "./provider-source-page-repository.ts";
import { ProviderSourceSupervisorRepository } from
  "./provider-source-supervisor-repository.ts";
import { hashJson } from "./security.ts";

const MAXIMUM_PAGE_RECORDS = 5_000;
const UNIQUE_PAGE_RECORDS = MAXIMUM_PAGE_RECORDS - 1;

/**
 * The page path chunks every record-shaped identity/read/write at 500 rows, so
 * an exact maximum page has ten chunks. The canonical writer is the widest
 * phase and is bounded to fewer than 40 statements per chunk; 100 additional
 * statements cover ownership, semantic, occurrence, cursor, diagnostic, and
 * settlement work. This ceiling detects any return to per-record SQL while
 * retaining headroom for fixed-shape repository evolution.
 */
const MAXIMUM_COMMIT_SQL_STATEMENTS = 500;

async function databaseNow(database: PackscoutPrismaClient): Promise<Date> {
  const [row] = await database.$queryRaw<Array<{ now: Date }>>`
    select clock_timestamp() as "now"
  `;
  return row!.now;
}

function pullObservation(
  providerRecordId: string,
  recordIndex: number,
  effectiveAt: string,
) {
  return normalizedProviderObservationSchema.parse({
    kind: "pull",
    providerRecordIdentity: {
      recordIdScopeKey: "pull-v1",
      providerRecordId,
    },
    effectiveAt,
    collectedAt: effectiveAt,
    providerFacts: emptyNormalizedProviderFacts("pull"),
    relationships: [{
      relationship: "pack",
      target: {
        recordIdScopeKey: "catalog-pack-v1",
        providerRecordId: `pack-${providerRecordId}`,
      },
    }],
    protectedNativeEvidenceRef: `evidence:maximum:${recordIndex}`,
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
      targetCanonicalKind: "pack" as const,
      targetProviderRecordId: relationship.target.providerRecordId,
    })),
    affectedPackProviderRecordId: null,
    evInputStatus: "not_applicable",
  };
}

test("exact 5,000-record atomic page stays statement-bounded and preserves first duplicate ordering", async (context) => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "atomic-maximum-page",
  );
  try {
    const now = await databaseNow(fixture.database);
    const source = await createAcceptanceProviderSource(fixture, {
      platformKey: "clutchpacks",
      displayName: "ClutchPacks maximum page",
      mapperKey: "clutchpacks-provider-observation",
      identityNamespaceKey: "dataforrest-clutchpacks-records-v1",
      intervalSeconds: 60,
      recordsPerRequest: MAXIMUM_PAGE_RECORDS,
      hashCharacter: "6",
      createdAt: now,
    });
    await activateAcceptanceRuntime(fixture.database, fixture, source, now);

    const runId = randomUUID();
    const requested = await new ProviderSourceImportRunRepository(
      fixture.database,
    ).requestRun({
      organizationId: fixture.organizationId,
      providerId: source.providerId,
      runId,
      trigger: "manual",
      requestedByActorKey: "operator-admin",
      requestedAt: await databaseNow(fixture.database),
      expectedSourceRevisionId: source.sourceRevisionId,
    });
    assert.equal(requested.kind, "created");
    if (requested.kind !== "created") throw new Error("run unavailable");
    assert.equal(requested.run.recordsPerRequest, MAXIMUM_PAGE_RECORDS);

    const ownerKey = "atomic-maximum-worker";
    const supervisorLeaseToken = randomUUID();
    const supervisor = await new ProviderSourceSupervisorRepository(
      fixture.database,
    ).acquire({
      environmentKey: "atomic-maximum-page",
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
    const nextCursor = { ...requestedCursor, value: "maximum-page-next" };
    const effectiveAt = now.toISOString();
    const observations = Array.from(
      { length: MAXIMUM_PAGE_RECORDS },
      (_, recordIndex) => {
        // The last delivery is an exact stable-identity replay of the first.
        // Its evidence reference remains position-specific delivery lineage.
        const identityIndex = recordIndex === MAXIMUM_PAGE_RECORDS - 1
          ? 0
          : recordIndex;
        return pullObservation(
          `maximum-pull-${identityIndex}`,
          recordIndex,
          effectiveAt,
        );
      },
    );
    const rawResponse = new TextEncoder().encode("maximum-provider-source-page");
    const normalizedPage = normalizedProviderObservationPageSchema.parse({
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
      provider: "clutchpacks",
      outcomes: observations.map((observation, recordIndex) => ({
        status: "valid" as const,
        recordIndex,
        observation,
      })),
      nextCursor,
      continuation: { kind: "continue" },
      measurements: {
        durationMilliseconds: 10,
        responseBytes: rawResponse.byteLength,
        recordCount: observations.length,
      },
      diagnostics: [],
    });
    const plan = {
      normalizedPage,
      outcomes: observations.map((observation, recordIndex) => {
        const semanticContent = normalizedObservationSemanticContent(
          observation,
        );
        return {
          kind: "semantic" as const,
          recordIndex,
          observation,
          semanticContent,
          normalizedContentHash: createHash("sha256")
            .update(normalizedObservationSemanticCanonicalJson(semanticContent))
            .digest("hex"),
          protectedNativeEvidenceRef:
            observation.protectedNativeEvidenceRef,
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
        pulls: MAXIMUM_PAGE_RECORDS,
        trades: 0,
        adapterInvalid: 0,
        mapperQuarantined: 0,
        warnings: 0,
      },
    } satisfies ProviderSourcePagePlan;

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
        provider_id: source.providerId,
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

    fixture.statementCounter.reset();
    const startedAt = performance.now();
    const committed = await new ProviderSourcePageRepository(fixture.database, {
      actorPseudonymKey: new Uint8Array(32).fill(11),
    }).commitPage({
      pins: {
        organizationId: fixture.organizationId,
        providerId: source.providerId,
        provider: "clutchpacks",
        sourceInstanceId: source.sourceInstanceId,
        sourceRevisionId: source.sourceRevisionId,
        sourceTypeKey: ACCEPTANCE_SOURCE_TYPE_KEY,
        sourceAdapterVersion: ACCEPTANCE_SOURCE_ADAPTER_VERSION,
        normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
        mapperKey: source.mapperKey,
        mapperVersion: "1",
        identityNamespaceKey: source.identityNamespaceKey,
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
      protectedNativeEvidence: observations.map((observation, recordIndex) => ({
        reference: observation.protectedNativeEvidenceRef,
        value: { recordIndex },
      })),
      nextCursorFingerprint: "c".repeat(64),
      committedAt: capturedAt,
    });
    const commitDurationMilliseconds = performance.now() - startedAt;
    const commitStatementCount = fixture.statementCounter.count;
    context.diagnostic(
      `maximum page commit: ${commitStatementCount} SQL statements in ${commitDurationMilliseconds.toFixed(1)}ms`,
    );

    assert.equal(committed.kind, "committed");
    assert.deepEqual(committed.counts, {
      inserted: UNIQUE_PAGE_RECORDS,
      revised: 0,
      duplicate: 1,
      quarantined: 0,
      warnings: 0,
      unresolvedRelationships: MAXIMUM_PAGE_RECORDS,
      canonicalRevisions: UNIQUE_PAGE_RECORDS,
      evRequests: 0,
    });
    assert.ok(
      commitDurationMilliseconds < 30_000,
      `maximum page commit took ${commitDurationMilliseconds.toFixed(1)}ms`,
    );
    assert.ok(
      commitStatementCount <= MAXIMUM_COMMIT_SQL_STATEMENTS,
      `maximum page commit issued ${commitStatementCount} SQL statements`,
    );

    const [identityCount, observationCount, occurrenceCount, entityCount,
      revisionCount, relationshipCount, pinnedRun, duplicateOccurrences] =
      await Promise.all([
        fixture.database.source_record_identities.count({
          where: { organization_id: fixture.organizationId },
        }),
        fixture.database.source_semantic_observations.count({
          where: { organization_id: fixture.organizationId },
        }),
        fixture.database.source_delivery_occurrences.count({
          where: { page_id: pageId },
        }),
        fixture.database.canonical_entities.count({
          where: {
            organization_id: fixture.organizationId,
            platform_key: "clutchpacks",
            record_kind: "pull",
          },
        }),
        fixture.database.canonical_revisions.count({
          where: { organization_id: fixture.organizationId },
        }),
        fixture.database.canonical_relationships.count({
          where: { organization_id: fixture.organizationId },
        }),
        fixture.database.import_runs.findUniqueOrThrow({
          where: { id: runId },
          select: { records_per_request: true },
        }),
        fixture.database.source_delivery_occurrences.findMany({
          where: {
            page_id: pageId,
            record_index: { in: [0, MAXIMUM_PAGE_RECORDS - 1] },
          },
          orderBy: { record_index: "asc" },
          select: {
            record_index: true,
            source_record_id: true,
            semantic_observation_id: true,
            disposition: true,
          },
        }),
      ]);
    assert.deepEqual(
      {
        identityCount,
        observationCount,
        occurrenceCount,
        entityCount,
        revisionCount,
        relationshipCount,
        recordsPerRequest: pinnedRun.records_per_request,
      },
      {
        identityCount: UNIQUE_PAGE_RECORDS,
        observationCount: UNIQUE_PAGE_RECORDS,
        occurrenceCount: MAXIMUM_PAGE_RECORDS,
        entityCount: UNIQUE_PAGE_RECORDS,
        revisionCount: UNIQUE_PAGE_RECORDS,
        relationshipCount: UNIQUE_PAGE_RECORDS,
        recordsPerRequest: MAXIMUM_PAGE_RECORDS,
      },
    );
    assert.equal(duplicateOccurrences.length, 2);
    assert.equal(duplicateOccurrences[0]?.record_index, 0);
    assert.equal(duplicateOccurrences[0]?.disposition, "inserted");
    assert.equal(
      duplicateOccurrences[1]?.record_index,
      MAXIMUM_PAGE_RECORDS - 1,
    );
    assert.equal(duplicateOccurrences[1]?.disposition, "duplicate");
    assert.equal(
      duplicateOccurrences[1]?.source_record_id,
      duplicateOccurrences[0]?.source_record_id,
    );
    assert.equal(
      duplicateOccurrences[1]?.semantic_observation_id,
      duplicateOccurrences[0]?.semantic_observation_id,
    );
  } finally {
    await fixture.close();
  }
});
