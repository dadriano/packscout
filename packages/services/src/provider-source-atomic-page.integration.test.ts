import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PUBLIC_PACK_AVAILABILITY_INPUT_VERSION,
  dataforrestEventsV1SourceAdapterManifest,
  normalizedObservationSemanticContent,
  normalizedProviderObservationPageSchema,
  providerIdentityNamespaceByLaunchProvider,
  providerSourceLaunchBounds,
  projectCanonicalPackAvailabilityV1,
  type LaunchProviderKey,
  type ProviderSourcePageCommitPins,
  type SourceAdapterManifestV1,
} from "@packscout/contracts";
import {
  PipelineSetupRepository,
  PROVIDER_SOURCE_QUARANTINE_RETENTION_DAYS,
  PROVIDER_SOURCE_RAW_PAGE_RETENTION_DAYS,
  IngestionPersistenceRepository,
  PersistenceError,
  PrismaAdminImportRunRepository,
  PrismaEstimatedEvRecomputationRepository,
  ProviderSourceAdminLifecycleRepository,
  ProviderSourceImportRunRepository,
  ProviderSourceAtomicPagePersistenceError,
  ProviderSourceLifecycleRepository,
  ProviderSourcePageRepository,
  ProviderSourceQuarantineRepository,
  ProviderSourceRequestRepository,
  ProviderSourceRetentionRepository,
  ProviderSourceSupervisorRepository,
  ProviderSourceTestResultRepository,
  SourceConnectionRecoveryRepository,
  hashJson,
  type PackscoutPrismaClient,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { OpaqueCursorGuard } from "./opaque-cursor-guard.ts";
import { CanonicalEstimatedEvProjectionRepository } from "./estimated-ev-projection-repository.ts";
import { EstimatedEvRecomputationProcessor } from "./estimated-ev-recomputation-processor.ts";
import { PackScoutEstimatedEvService } from "./estimated-ev-service.ts";
import {
  ProviderSourcePageImportError,
  ProviderSourcePageImportService,
} from "./provider-source-page-import-service.ts";
import {
  ProviderSourcePagePlanner,
  type ProviderObservationMapperResolver,
} from "./provider-source-page-planner.ts";
import { ProviderSourceQuarantineService } from "./provider-source-quarantine-service.ts";
import {
  providerSourceSuccessfulCaptureOutcomeHash,
  type CapturedSourcePageV1,
} from "./source-adapter.ts";
import { createProviderObservationMapperRegistryFromManifest } from "./providers/provider-mapper-manifest.ts";
import {
  StaticCapturedPageSourceAdapter,
  completeAuthenticPageReadForTest,
} from "./source-adapter-page-result.test-support.ts";
import {
  AlternateBookmarkSourceAdapter,
  alternateBookmarkSourceManifest,
  alternateBookmarkWrapper,
} from "./alternate-bookmark-source-adapter.test-support.ts";
import {
  cardObservation,
  descriptorFor,
  packFacts,
  packObservation,
  pullObservation,
  tradeObservation,
} from "./providers/provider-observation-mapper.test-support.ts";

const actorKey = new Uint8Array(32).fill(19);
const cursorKey = new Uint8Array(32).fill(23);
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function assertPending(promise: Promise<unknown>): Promise<void> {
  const state = await Promise.race([
    promise.then(
      () => "settled",
      () => "settled",
    ),
    new Promise<"pending">((resolve) => {
      setTimeout(() => resolve("pending"), 50);
    }),
  ]);
  assert.equal(state, "pending");
}

async function databaseNow(database: PackscoutPrismaClient): Promise<Date> {
  const rows = await database.$queryRaw<Array<{ now: Date }>>`
    select clock_timestamp() as "now"
  `;
  return rows[0]!.now;
}

async function createRuntime(
  testKey: string,
  options: Readonly<{
    completeEv?: boolean;
    soldOut?: boolean;
    withRetiredConnectionPredecessor?: boolean;
    requestProof?: "captured" | "failed" | "in_flight" | "wrong_page";
    sourceManifest?: SourceAdapterManifestV1;
    protectedRawResponseText?: string;
    initialNextCursorValue?: string;
    provider?: LaunchProviderKey;
    fixture?: Awaited<ReturnType<typeof createMigratedTestDatabase>>;
    organizationId?: string;
  }> = {},
) {
  const fixture = options.fixture ?? await createMigratedTestDatabase();
  const database = fixture.database;
  const now = await databaseNow(database);
  const setup = new PipelineSetupRepository(database);
  const provider = options.provider ?? "courtyard";
  const organizationId = options.organizationId ??
    await setup.createOrganization({
      slug: `atomic-page-${testKey}`,
      name: `Atomic page ${testKey}`,
      createdAt: now,
    });
  const providerId = await setup.createProviderSource({
    organizationId,
    platformKey: provider,
    displayName: provider,
    createdAt: now,
  });
  await setup.createConfigRevision({
    organizationId,
    providerId,
    version: 1,
    adapterKey: "http-cursor-v1",
    endpointUrl: "https://courtyard.example.test/legacy-unused",
    authMode: "none",
    createdByActorKey: "operator-admin",
    createdAt: now,
  });
  const lifecycle = new ProviderSourceLifecycleRepository(database);
  const manifest = options.sourceManifest ??
    dataforrestEventsV1SourceAdapterManifest;
  const connection = await lifecycle.createConnectionProfileRevision({
    organizationId,
    sourceTypeKey: manifest.sourceTypeKey,
    connectionTypeKey: manifest.compatibleConnectionTypeKey,
    displayName: `DataForrest atomic ${testKey}`,
    requestLimit: providerSourceLaunchBounds.stableProfileRequestCap,
    sourceAdapterVersion: manifest.adapterVersion,
    revisionNumber: 1,
    configurationCiphertext: new Uint8Array(32).fill(1),
    configurationNonce: new Uint8Array(12).fill(2),
    configurationAuthTag: new Uint8Array(16).fill(3),
    encryptionKeyVersion: 1,
    configurationFingerprint: "a".repeat(64),
    actorKey: "operator-admin",
    createdAt: now,
  });
  const activeConnectionRevisionId = options.withRetiredConnectionPredecessor
    ? randomUUID()
    : connection.revisionId;
  const descriptor = descriptorFor(provider);
  const source = await lifecycle.createSourceInstanceRevision({
    organizationId,
    providerId,
    connectionProfileId: connection.profileId,
    sourceTypeKey: manifest.sourceTypeKey,
    sourceAdapterVersion: manifest.adapterVersion,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    mapperKey: descriptor.mapperKey,
    mapperVersion: descriptor.mapperVersion,
    identityNamespaceKey: providerIdentityNamespaceByLaunchProvider[provider],
    cursorCodecVersion: manifest.cursorCodecKey,
    revisionNumber: 1,
    intervalSeconds: 60,
    configuration: { platform: provider },
    configurationHash: "b".repeat(64),
    recordIdScopes: [
      "catalog-pack-v1",
      "catalog-card-v1",
      "pull-v1",
      "trade-v1",
    ],
    actorKey: "operator-admin",
    createdAt: now,
  });
  await database.$transaction(async (transaction) => {
    await transaction.provider_sources.update({
      where: { id: providerId },
      data: { state: "active", updated_at: now },
    });
    if (options.withRetiredConnectionPredecessor) {
      await transaction.source_connection_revisions.update({
        where: { id: connection.revisionId },
        data: {
          state: "retired",
          activated_at: now,
          retired_at: now,
        },
      });
      await transaction.source_connection_revisions.create({
        data: {
          id: activeConnectionRevisionId,
          organization_id: organizationId,
          connection_profile_id: connection.profileId,
          revision_number: 2,
          source_type_key: manifest.sourceTypeKey,
          source_adapter_version: manifest.adapterVersion,
          configuration_ciphertext: new Uint8Array(32).fill(4),
          configuration_nonce: new Uint8Array(12).fill(5),
          configuration_auth_tag: new Uint8Array(16).fill(6),
          encryption_key_version: 1,
          configuration_fingerprint: "c".repeat(64),
          state: "active",
          created_by_actor_key: "operator-admin",
          created_at: now,
          activated_at: now,
        },
      });
    } else {
      await transaction.source_connection_revisions.update({
        where: { id: connection.revisionId },
        data: { state: "active", activated_at: now },
      });
    }
    await transaction.source_connection_profiles.update({
      where: { id: connection.profileId },
      data: {
        state: "active",
        active_revision_id: activeConnectionRevisionId,
        updated_at: now,
      },
    });
    await transaction.provider_source_instances.update({
      where: { id: source.sourceInstanceId },
      data: { state: "active", activated_at: now, updated_at: now },
    });
  });

  const requested = await new ProviderSourceImportRunRepository(
    database,
  ).requestRun({
    organizationId,
    providerId,
    runId: randomUUID(),
    trigger: "manual",
    requestedByActorKey: "operator-admin",
    requestedAt: await databaseNow(database),
    expectedSourceRevisionId: source.sourceRevisionId,
  });
  assert.equal(requested.kind, "created");
  if (requested.kind !== "created") throw new Error("run fixture unavailable");
  const ownerKey = `atomic-worker-${testKey}`;
  const supervisorLeaseToken = randomUUID();
  const supervisor = await new ProviderSourceSupervisorRepository(
    database,
  ).acquire({
    environmentKey: `atomic-page-${testKey}`,
    ownerKey,
    leaseToken: supervisorLeaseToken,
    now: await databaseNow(database),
  });
  const runLeaseToken = randomUUID();
  const runClaimLeaseId = randomUUID();
  await database.import_runs.update({
    where: { id: requested.run.id },
    data: {
      state: "running",
      started_at: await databaseNow(database),
      lease_owner: ownerKey,
      lease_token: runLeaseToken,
      claim_lease_id: runClaimLeaseId,
      lease_expires_at: supervisor.leaseExpiresAt,
    },
  });

  const guard = new OpaqueCursorGuard(cursorKey);
  const requestedCursor = {
    sourceInstanceId: source.sourceInstanceId,
    sourceRevisionId: source.sourceRevisionId,
    sourceTypeKey: manifest.sourceTypeKey,
    adapterVersion: manifest.adapterVersion,
    cursorCodecKey: manifest.cursorCodecKey,
    cursorGeneration: 1,
    value: null,
  } as const;
  const nextCursor = {
    ...requestedCursor,
    value: options.initialNextCursorValue ?? "cursor-a",
  };
  const raw = new TextEncoder().encode(
    options.protectedRawResponseText ?? "sanitized-mixed-courtyard-page",
  );
  const pack = packObservation({
    providerFacts: packFacts({
      price: { state: "present", value: { amount: 10, currency: "USD" } },
      ...(options.soldOut
        ? {
            authoritativeAvailability: {
              state: "present" as const,
              value: {
                state: "sold_out" as const,
                authority: "provider_explicit_sold_out" as const,
              },
            },
          }
        : {}),
      drawCount: { state: "present", value: 1 },
      buybackPercent: { state: "present", value: 80 },
      evInput: {
        state: "present",
        value: {
          approved: options.completeEv !== false,
          currency: "USD",
          unitBasis: "per_pack",
          drawCount: 1,
          buybackPercent: 80,
          totalQuantity: 2,
          buckets: [
            {
              bucketId: "base",
              label: "Base",
              probability: 1,
              quantity: 2,
              lowerValue: 10,
              upperValue: 20,
            },
          ],
        },
      },
    }),
  });
  const normalizedPack = options.soldOut
    ? { ...pack, availability: "unavailable" as const }
    : pack;
  const page = normalizedProviderObservationPageSchema.parse({
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    provider,
    outcomes: [
      { status: "valid", recordIndex: 0, observation: normalizedPack },
      {
        status: "invalid",
        recordIndex: 1,
        reasonCode: "missing_identity",
        fieldPaths: ["id"],
        protectedNativeEvidenceRef: "evidence:invalid-1",
      },
      { status: "valid", recordIndex: 2, observation: pullObservation() },
      { status: "valid", recordIndex: 3, observation: tradeObservation() },
    ],
    nextCursor,
    continuation: { kind: "continue" },
    measurements: {
      durationMilliseconds: 12,
      responseBytes: raw.byteLength,
      recordCount: 4,
    },
    diagnostics: [],
  });
  const requestAttemptId = randomUUID();
  const requestLeaseId = randomUUID();
  const pageId = randomUUID();
  const capturedAt = await databaseNow(database);
  const rawResponseSha256 = createHash("sha256").update(raw).digest("hex");
  const requestProof = options.requestProof ?? "captured";
  const requestProofScope = {
    organization_id: organizationId,
    operation_kind: "page_read" as const,
    request_lease_id: requestLeaseId,
    claim_owner: ownerKey,
    claim_token: runLeaseToken,
    supervisor_epoch_id: supervisor.epochId,
    connection_profile_id: connection.profileId,
    connection_revision_id: activeConnectionRevisionId,
    expected_health_generation: 0n,
    provider_id: providerId,
    source_instance_id: source.sourceInstanceId,
    source_revision_id: source.sourceRevisionId,
    run_id: requested.run.id,
    page_number: requestProof === "wrong_page" ? 2 : 1,
    cursor_generation: 1n,
    requested_cursor_key: "initial",
    started_at: capturedAt,
  };
  if (requestProof === "in_flight") {
    await database.source_request_attempts.create({
      data: {
        id: requestAttemptId,
        ...requestProofScope,
        state: "in_flight",
      },
    });
  } else await database.compact_source_request_attempts.create({
    data: {
      request_attempt_id: requestAttemptId,
      ...requestProofScope,
      terminal_state: requestProof === "failed" ? "failed" : "captured",
      outcome_class: requestProof === "failed"
        ? "upstream_failure"
        : "response_captured",
      safe_outcome_hash: providerSourceSuccessfulCaptureOutcomeHash({
        ok: true,
        protectedRawResponseSha256: rawResponseSha256,
        measurements: {
          durationMilliseconds: page.measurements.durationMilliseconds,
          responseBytes: page.measurements.responseBytes,
        },
        diagnostics: [],
      }),
      response_bytes: page.measurements.responseBytes,
      duration_ms: page.measurements.durationMilliseconds,
      terminal_at: capturedAt,
    },
  });
  const pageRequestPins = Object.freeze({
    operationKind: "page_read" as const,
    requestAttemptId,
    requestLeaseId,
    organizationId,
    sourceTypeKey: manifest.sourceTypeKey,
    adapterVersion: manifest.adapterVersion,
    singletonFencingEpoch: Number(supervisor.epochNumber),
    connectionProfileId: connection.profileId,
    connectionProfileRevisionId: activeConnectionRevisionId,
    connectionHealthGeneration: 0,
    provider,
    sourceInstanceId: source.sourceInstanceId,
    sourceRevisionId: source.sourceRevisionId,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    identityNamespaceKey: providerIdentityNamespaceByLaunchProvider[provider],
    importRunId: requested.run.id,
    runClaimLeaseId,
    pageAttemptId: pageId,
    pageNumber: 1,
    pageLimit: 250,
    cursorGeneration: 1,
    requestedCursorFingerprint: null,
  });
  const protectedNativeEvidence = [
        {
          reference: "evidence:pack-1",
          value: {
            kind: "pack",
            nativePayloadSentinel: "accepted-native-evidence",
          },
        },
        { reference: "evidence:invalid-1", value: { kind: "invalid" } },
        { reference: "evidence:pull-1", value: { kind: "pull" } },
        { reference: "evidence:trade-1", value: { kind: "trade" } },
      ] as const;
  const adapterResult = await completeAuthenticPageReadForTest(
    {
      manifest,
      pins: pageRequestPins,
      requestedCursor,
      connectionConfiguration: { fixture: "protected" },
      sourceConfiguration: { platform: provider },
    },
    new StaticCapturedPageSourceAdapter(manifest, {
      rawResponse: raw,
      protectedNativeEvidence,
      normalizedPage: page,
    }),
  );
  const pins = {
    organizationId,
    providerId,
    provider,
    sourceInstanceId: source.sourceInstanceId,
    sourceRevisionId: source.sourceRevisionId,
    sourceTypeKey: manifest.sourceTypeKey,
    sourceAdapterVersion: manifest.adapterVersion,
    normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
    mapperKey: descriptor.mapperKey,
    mapperVersion: descriptor.mapperVersion,
    identityNamespaceKey: providerIdentityNamespaceByLaunchProvider[provider],
    connectionProfileId: connection.profileId,
    connectionRevisionId: activeConnectionRevisionId,
    connectionHealthGeneration: 0n,
    requestAttemptId,
    requestLeaseId,
    supervisorEpochId: supervisor.epochId,
    singletonFencingEpoch: Number(supervisor.epochNumber),
    supervisorOwnerKey: ownerKey,
    supervisorLeaseToken,
    runId: requested.run.id,
    runTrigger: "manual" as ProviderSourcePageCommitPins["runTrigger"],
    runLeaseOwner: ownerKey,
    runLeaseToken,
    runClaimLeaseId,
    pageId,
    pageNumber: 1,
    cursorCodecVersion: manifest.cursorCodecKey,
    cursorGeneration: 1n,
    requestedCursor,
    requestedCursorFingerprint: null,
  };
  return {
    ...fixture,
    database,
    organizationId,
    providerId,
    source,
    manifest,
    retiredConnectionRevisionId: options.withRetiredConnectionPredecessor
      ? connection.revisionId
      : null,
    pins,
    adapterResult,
    guard,
  };
}

function service(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  beforeCursorAdvance?: () => void | Promise<void>,
  mapperResolver: ProviderObservationMapperResolver =
    createProviderObservationMapperRegistryFromManifest(),
) {
  return new ProviderSourcePageImportService(
    new ProviderSourcePagePlanner(mapperResolver),
    runtime.guard,
    new ProviderSourcePageRepository(runtime.database, {
      actorPseudonymKey: actorKey,
      beforeCursorAdvance,
    }),
  );
}

const capacityRelations = [
  "import_pages",
  "source_record_identities",
  "source_semantic_observations",
  "source_delivery_occurrences",
  "canonical_entities",
  "canonical_revisions",
  "canonical_relationships",
  "public_change_causes",
  "public_derivation_obligations",
  "estimated_ev_recomputation_requests",
  "quarantine_records",
  "source_processor_diagnostic_events",
  "source_request_attempts",
  "compact_source_request_attempts",
] as const;
const structuredCapacityRelations = new Set<string>([
  "source_record_identities",
  "source_semantic_observations",
  "source_delivery_occurrences",
  "canonical_entities",
  "canonical_revisions",
  "canonical_relationships",
  "public_change_causes",
  "public_derivation_obligations",
  "estimated_ev_recomputation_requests",
]);
const capacityWindowCount = 3;
const capacityPagesPerWindow = 24;
const postgresAllocationPageBytes = 8_192;

interface CapacityRelationMeasurement {
  readonly relation: (typeof capacityRelations)[number];
  readonly rows: number;
  readonly logicalRowBytes: number;
  readonly tableBytes: number;
  readonly indexBytes: number;
  readonly toastAndAuxiliaryBytes: number;
  readonly totalBytes: number;
}

interface CommittedCapacityStorageArtifact {
  readonly storageMeasurement: Readonly<{
    sample: Readonly<{
      inputRecords: number;
      acceptedRecords: number;
      quarantinedRecords: number;
      pages: number;
      windows: number;
      pagesPerWindow: number;
    }>;
    pageDurationMilliseconds: number;
    pageStatementCount: number;
    allocationPageBytes: number;
    structuredPhysicalBytesPerRecord: number;
    normalizedPayloadPhysicalBytesPerRecord: number;
    importPagePhysicalBytes: number;
    quarantinePhysicalBytes: number;
    quarantineEvidencePhysicalBytes: number;
    diagnosticPhysicalBytesPerPage: number;
    terminalAttemptPhysicalBytes: number;
    compactAttemptPhysicalBytes: number;
    windows: readonly Readonly<{
      window: number;
      inputRecords: number;
      structuredPhysicalBytes: number;
      structuredPhysicalBytesPerRecord: number;
      normalizedPayloadPhysicalBytesPerRecord: number;
      importPagePhysicalBytes: number;
      quarantinePhysicalBytes: number;
      quarantineEvidencePhysicalBytes: number;
      diagnosticPhysicalBytesPerPage: number;
      terminalAttemptPhysicalBytes: number;
      compactAttemptPhysicalBytes: number;
    }>[];
    relations: readonly CapacityRelationMeasurement[];
  }>;
}

async function committedCapacityStorageArtifact(): Promise<
  CommittedCapacityStorageArtifact
> {
  return JSON.parse(
    await readFile(
      new URL(
        "../../../docs/provider-source-capacity-measurement-v1.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as CommittedCapacityStorageArtifact;
}

async function measureCapacityRelations(
  database: PackscoutPrismaClient,
  organizationId: string,
): Promise<readonly CapacityRelationMeasurement[]> {
  const logicalRows = await database.$queryRaw<Array<{
    relation: (typeof capacityRelations)[number];
    rows: bigint;
    logical_bytes: bigint;
  }>>`
    select 'import_pages'::text as relation, count(*)::bigint as rows,
           coalesce(sum(pg_column_size(candidate)), 0)::bigint as logical_bytes
    from public.import_pages candidate where organization_id = ${organizationId}::uuid
    union all select 'source_record_identities', count(*)::bigint,
           coalesce(sum(pg_column_size(candidate)), 0)::bigint
    from public.source_record_identities candidate where organization_id = ${organizationId}::uuid
    union all select 'source_semantic_observations', count(*)::bigint,
           coalesce(sum(pg_column_size(candidate)), 0)::bigint
    from public.source_semantic_observations candidate where organization_id = ${organizationId}::uuid
    union all select 'source_delivery_occurrences', count(*)::bigint,
           coalesce(sum(pg_column_size(candidate)), 0)::bigint
    from public.source_delivery_occurrences candidate where organization_id = ${organizationId}::uuid
    union all select 'canonical_entities', count(*)::bigint,
           coalesce(sum(pg_column_size(candidate)), 0)::bigint
    from public.canonical_entities candidate where organization_id = ${organizationId}::uuid
    union all select 'canonical_revisions', count(*)::bigint,
           coalesce(sum(pg_column_size(candidate)), 0)::bigint
    from public.canonical_revisions candidate where organization_id = ${organizationId}::uuid
    union all select 'canonical_relationships', count(*)::bigint,
           coalesce(sum(pg_column_size(candidate)), 0)::bigint
    from public.canonical_relationships candidate where organization_id = ${organizationId}::uuid
    union all select 'public_change_causes', count(*)::bigint,
           coalesce(sum(pg_column_size(candidate)), 0)::bigint
    from public.public_change_causes candidate where organization_id = ${organizationId}::uuid
    union all select 'public_derivation_obligations', count(*)::bigint,
           coalesce(sum(pg_column_size(candidate)), 0)::bigint
    from public.public_derivation_obligations candidate where organization_id = ${organizationId}::uuid
    union all select 'estimated_ev_recomputation_requests', count(*)::bigint,
           coalesce(sum(pg_column_size(candidate)), 0)::bigint
    from public.estimated_ev_recomputation_requests candidate where organization_id = ${organizationId}::uuid
    union all select 'quarantine_records', count(*)::bigint,
           coalesce(sum(pg_column_size(candidate)), 0)::bigint
    from public.quarantine_records candidate where organization_id = ${organizationId}::uuid
    union all select 'source_processor_diagnostic_events', count(*)::bigint,
           coalesce(sum(pg_column_size(candidate)), 0)::bigint
    from public.source_processor_diagnostic_events candidate where organization_id = ${organizationId}::uuid
    union all select 'source_request_attempts', count(*)::bigint,
           coalesce(sum(pg_column_size(candidate)), 0)::bigint
    from public.source_request_attempts candidate where organization_id = ${organizationId}::uuid
    union all select 'compact_source_request_attempts', count(*)::bigint,
           coalesce(sum(pg_column_size(candidate)), 0)::bigint
    from public.compact_source_request_attempts candidate where organization_id = ${organizationId}::uuid
  `;
  const physicalRows = await database.$queryRaw<Array<{
    relation: (typeof capacityRelations)[number];
    table_bytes: bigint;
    index_bytes: bigint;
    total_bytes: bigint;
  }>>`
    select names.relation,
           pg_relation_size(to_regclass('public.' || names.relation))::bigint as table_bytes,
           pg_indexes_size(to_regclass('public.' || names.relation))::bigint as index_bytes,
           pg_total_relation_size(to_regclass('public.' || names.relation))::bigint as total_bytes
    from (values
      ('import_pages'),
      ('source_record_identities'),
      ('source_semantic_observations'),
      ('source_delivery_occurrences'),
      ('canonical_entities'),
      ('canonical_revisions'),
      ('canonical_relationships'),
      ('public_change_causes'),
      ('public_derivation_obligations'),
      ('estimated_ev_recomputation_requests'),
      ('quarantine_records'),
      ('source_processor_diagnostic_events'),
      ('source_request_attempts'),
      ('compact_source_request_attempts')
    ) as names(relation)
  `;
  return capacityRelations.map((relation) => {
    const logical = logicalRows.find((row) => row.relation === relation);
    const physical = physicalRows.find((row) => row.relation === relation);
    if (!logical || !physical) throw new Error("capacity relation unavailable");
    const tableBytes = Number(physical.table_bytes);
    const indexBytes = Number(physical.index_bytes);
    const totalBytes = Number(physical.total_bytes);
    return {
      relation,
      rows: Number(logical.rows),
      logicalRowBytes: Number(logical.logical_bytes),
      tableBytes,
      indexBytes,
      toastAndAuxiliaryBytes: totalBytes - tableBytes - indexBytes,
      totalBytes,
    };
  });
}

function capacityRelationDelta(
  before: readonly CapacityRelationMeasurement[],
  after: readonly CapacityRelationMeasurement[],
  allowVacuumedPhysicalShrink = false,
): readonly CapacityRelationMeasurement[] {
  return capacityRelations.map((relation) => {
    const left = before.find((candidate) => candidate.relation === relation);
    const right = after.find((candidate) => candidate.relation === relation);
    if (!left || !right) throw new Error("capacity relation unavailable");
    const delta = {
      relation,
      rows: right.rows - left.rows,
      logicalRowBytes: right.logicalRowBytes - left.logicalRowBytes,
      tableBytes: right.tableBytes - left.tableBytes,
      indexBytes: right.indexBytes - left.indexBytes,
      toastAndAuxiliaryBytes:
        right.toastAndAuxiliaryBytes - left.toastAndAuxiliaryBytes,
      totalBytes: right.totalBytes - left.totalBytes,
    };
    const vacuumedRelation = allowVacuumedPhysicalShrink &&
      (relation === "import_pages" || relation === "quarantine_records");
    if (Object.entries(delta).some(([field, value]) =>
      typeof value === "number" && value < 0 &&
      !(vacuumedRelation && [
        "tableBytes",
        "indexBytes",
        "toastAndAuxiliaryBytes",
        "totalBytes",
      ].includes(field))
    )) {
      throw new Error(`capacity relation ${relation} shrank during measurement`);
    }
    return delta;
  });
}

function structuredPhysicalBytes(
  relations: readonly CapacityRelationMeasurement[],
): number {
  return relations
    .filter(({ relation }) => structuredCapacityRelations.has(relation))
    .reduce((sum, { totalBytes }) => sum + totalBytes, 0);
}

function relationPhysicalBytes(
  relations: readonly CapacityRelationMeasurement[],
  relation: (typeof capacityRelations)[number],
): number {
  const measured = relations.find((candidate) => candidate.relation === relation);
  if (!measured) throw new Error(`capacity relation ${relation} unavailable`);
  return measured.totalBytes;
}

function physicalBytesPerMeasuredRow(
  relations: readonly CapacityRelationMeasurement[],
  relation: (typeof capacityRelations)[number],
): number {
  const measured = relations.find((candidate) => candidate.relation === relation);
  if (!measured || measured.rows < 1) {
    throw new Error(`capacity relation ${relation} has no sample rows`);
  }
  return Math.ceil(measured.totalBytes / measured.rows);
}

async function expireCapacityEvidence(
  database: PackscoutPrismaClient,
  organizationId: string,
): Promise<void> {
  const expiredAt = await databaseNow(database);
  await database.$executeRaw`
    update public.import_pages
    set payload_json = null,
        protected_raw_response = null,
        payload_expired_at = ${expiredAt}
    where organization_id = ${organizationId}::uuid
      and source_instance_id is not null
      and (payload_json is not null or protected_raw_response is not null)
  `;
  await database.$executeRaw`
    update public.quarantine_records
    set state = 'expired'::public.quarantine_state,
        payload_json = null,
        payload_expired_at = ${expiredAt},
        resolved_at = ${expiredAt}
    where organization_id = ${organizationId}::uuid
      and payload_json is not null
  `;
  // The capacity test owns an isolated migrated database. Rewriting these two
  // relations removes dead pre-expiry tuples so the measured physical slope is
  // the retained lineage itself; reviewed raw-page/record bytes are modeled
  // separately at their 7-day/30-day retention windows.
  await database.$executeRawUnsafe(
    "VACUUM (FULL, ANALYZE) public.import_pages, public.quarantine_records",
  );
}

function plannedPersistenceInput(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
) {
  if (!runtime.adapterResult.ok) throw new Error("adapter fixture unavailable");
  const captured = runtime.adapterResult.value;
  const plan = new ProviderSourcePagePlanner(
    createProviderObservationMapperRegistryFromManifest(),
  ).plan({
    organizationId: runtime.organizationId,
    providerId: runtime.providerId,
    provider: runtime.pins.provider,
    mapperKey: runtime.pins.mapperKey,
    mapperVersion: runtime.pins.mapperVersion,
    normalizedContractVersion: runtime.pins.normalizedContractVersion,
    identityNamespaceKey: runtime.pins.identityNamespaceKey,
    page: captured.normalizedPage,
  });
  return {
    pins: runtime.pins,
    plan,
    protectedRawResponse: captured.requestCapture.protectedRawResponse,
    protectedRawResponseSha256:
      captured.requestCapture.protectedRawResponseSha256,
    protectedNativeEvidence: captured.protectedNativeEvidence,
    nextCursorFingerprint: runtime.guard.fingerprint(
      captured.normalizedPage.nextCursor,
    ),
    committedAt: new Date(),
  };
}

function replaceProjectionContent(
  input: ReturnType<typeof plannedPersistenceInput>,
  recordKind: "pack" | "pull" | "market_event",
  change: (content: Readonly<Record<string, unknown>>) =>
    Readonly<Record<string, unknown>>,
) {
  const plan = {
    ...input.plan,
    outcomes: input.plan.outcomes.map((outcome) => {
      if (outcome.kind !== "semantic" || outcome.mapping.status !== "mapped") {
        return outcome;
      }
      return {
        ...outcome,
        mapping: {
          ...outcome.mapping,
          projections: outcome.mapping.projections.map((projection) => {
            if (projection.recordKind !== recordKind) return projection;
            const content = change(projection.content);
            return {
              ...projection,
              content,
              contentFingerprint: hashJson(content),
            };
          }),
        },
      };
    }),
  };
  return { ...input, plan };
}

test("closed canonical content rejects secrets and malformed event money before any write", async () => {
  const runtime = await createRuntime("closed-canonical-content");
  try {
    const base = plannedPersistenceInput(runtime);
    const forgedInputs = [
      replaceProjectionContent(base, "pack", (content) => ({
        ...content,
        bearer: "protected-token-must-never-persist",
      })),
      replaceProjectionContent(base, "pull", (content) => ({
        ...content,
        value: { amountMinor: -1, currency: "USD" },
      })),
      replaceProjectionContent(base, "market_event", (content) => ({
        ...content,
        amount: { amountMinor: 100, currency: "usd" },
        paymentMethod: "  card  ",
      })),
      replaceProjectionContent(base, "pack", (content) => ({
        ...content,
        evInputStatus: "unavailable",
      })),
    ];
    const repository = new ProviderSourcePageRepository(runtime.database, {
      actorPseudonymKey: actorKey,
    });
    for (const input of forgedInputs) {
      await assert.rejects(
        repository.commitPage(input),
        (error: unknown) =>
          error instanceof ProviderSourceAtomicPagePersistenceError &&
          error.code === "invalid_page_plan",
      );
      assert.deepEqual(
        await Promise.all([
          runtime.database.import_pages.count(),
          runtime.database.source_delivery_occurrences.count(),
          runtime.database.source_semantic_observations.count(),
          runtime.database.canonical_revisions.count(),
          runtime.database.quarantine_records.count(),
          runtime.database.estimated_ev_recomputation_requests.count(),
        ]),
        [0, 0, 0, 0, 0, 0],
      );
    }
  } finally {
    await runtime.close();
  }
});

test("persistence rejects semantic content that was not derived from the exact normalized observation", async () => {
  const runtime = await createRuntime("forged-semantic-content");
  try {
    const base = plannedPersistenceInput(runtime);
    const foreignPack = packObservation({
      providerRecordIdentity: {
        recordIdScopeKey: "catalog-pack-v1",
        providerRecordId: "foreign-pack-identity",
      },
      effectiveAt: "2026-08-21T23:59:00.000Z",
      providerFacts: packFacts({
        price: { state: "present", value: { amount: 999, currency: "USD" } },
      }),
    });
    const foreignPage = normalizedProviderObservationPageSchema.parse({
      ...base.plan.normalizedPage,
      outcomes: base.plan.normalizedPage.outcomes.map((outcome, index) =>
        index === 0 && outcome.status === "valid"
          ? { ...outcome, observation: foreignPack }
          : outcome,
      ),
    });
    const foreignPlan = new ProviderSourcePagePlanner(
      createProviderObservationMapperRegistryFromManifest(),
    ).plan({
      organizationId: runtime.organizationId,
      providerId: runtime.providerId,
      provider: runtime.pins.provider,
      mapperKey: runtime.pins.mapperKey,
      mapperVersion: runtime.pins.mapperVersion,
      normalizedContractVersion: runtime.pins.normalizedContractVersion,
      identityNamespaceKey: runtime.pins.identityNamespaceKey,
      page: foreignPage,
    });
    const originalOutcome = base.plan.outcomes[0];
    const foreignOutcome = foreignPlan.outcomes[0];
    if (
      originalOutcome?.kind !== "semantic" ||
      foreignOutcome?.kind !== "semantic"
    ) {
      assert.fail("Semantic fixture unavailable.");
    }
    assert.notDeepEqual(
      foreignOutcome.semanticContent,
      normalizedObservationSemanticContent(originalOutcome.observation),
    );
    const forged = {
      ...base,
      plan: {
        ...base.plan,
        outcomes: base.plan.outcomes.map((outcome, index) =>
          index === 0
            ? {
                ...outcome,
                semanticContent: foreignOutcome.semanticContent,
                normalizedContentHash: foreignOutcome.normalizedContentHash,
                mapping: foreignOutcome.mapping,
              }
            : outcome,
        ),
      },
    };

    await assert.rejects(
      new ProviderSourcePageRepository(runtime.database, {
        actorPseudonymKey: actorKey,
      }).commitPage(forged),
      (error: unknown) =>
        error instanceof ProviderSourceAtomicPagePersistenceError &&
        error.code === "invalid_page_plan",
    );
    assert.deepEqual(
      await Promise.all([
        runtime.database.import_pages.count(),
        runtime.database.source_record_identities.count(),
        runtime.database.source_semantic_observations.count(),
        runtime.database.source_delivery_occurrences.count(),
        runtime.database.canonical_revisions.count(),
        runtime.database.quarantine_records.count(),
      ]),
      [0, 0, 0, 0, 0, 0],
    );
  } finally {
    await runtime.close();
  }
});

test("atomic persistence snapshots raw bytes and nested plan content before its first await", async () => {
  const runtime = await createRuntime("immutable-command-snapshot");
  const independent = await runtime.createIndependentClient();
  const locked = deferred();
  const release = deferred();
  try {
    const callerInput = structuredClone(plannedPersistenceInput(runtime));
    const semantic = callerInput.plan.outcomes.find(
      (outcome) => outcome.kind === "semantic" &&
        outcome.mapping.status === "mapped" &&
        outcome.observation.kind === "catalog" &&
        outcome.observation.entity === "pack",
    );
    if (!semantic || semantic.kind !== "semantic" ||
        semantic.mapping.status !== "mapped") {
      assert.fail("Pack semantic fixture unavailable.");
    }
    const packProjection = semantic.mapping.projections.find(
      ({ recordKind }) => recordKind === "pack",
    );
    if (!packProjection) assert.fail("Pack projection fixture unavailable.");
    const validatedSemanticContent = structuredClone(semantic.semanticContent);
    const validatedProjectionContent = structuredClone(packProjection.content);
    const validatedRaw = new Uint8Array(callerInput.protectedRawResponse);
    const validatedRawHash = callerInput.protectedRawResponseSha256;

    const blocker = independent.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        select id from public.provider_sources
        where id = ${runtime.providerId}::uuid
        for update
      `;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const committing = new ProviderSourcePageRepository(runtime.database, {
      actorPseudonymKey: actorKey,
    }).commitPage(callerInput);

    callerInput.protectedRawResponse[0] =
      callerInput.protectedRawResponse[0]! ^ 255;
    const mutableSemantic = semantic.semanticContent as unknown as {
      effectiveAt: string;
      providerRecordIdentity: { providerRecordId: string };
      providerFacts: Record<string, unknown>;
    };
    mutableSemantic.effectiveAt = "2099-01-01T00:00:00.000Z";
    mutableSemantic.providerRecordIdentity.providerRecordId = "mutated-pack";
    mutableSemantic.providerFacts = { bearer: "mutated-after-validation" };
    (packProjection.content as Record<string, unknown>).priceValueMinor =
      999_999;
    await assertPending(committing);
    release.resolve();
    await blocker;
    assert.equal((await committing).kind, "committed");

    const [page, storedSemantics, packEntity] = await Promise.all([
      runtime.database.import_pages.findUniqueOrThrow({
        where: { id: runtime.pins.pageId },
      }),
      runtime.database.source_semantic_observations.findMany({
        where: { organization_id: runtime.organizationId },
      }),
      runtime.database.canonical_entities.findFirstOrThrow({
        where: {
          organization_id: runtime.organizationId,
          platform_key: "courtyard",
          record_kind: "pack",
          external_id: "pack-1",
        },
      }),
    ]);
    const storedSemantic = storedSemantics.find((candidate) =>
      (
        candidate.normalized_content_json as {
          providerRecordIdentity?: { providerRecordId?: string };
        }
      ).providerRecordIdentity?.providerRecordId === "pack-1"
    );
    if (!storedSemantic) assert.fail("Stored pack semantic unavailable.");
    assert.equal(page.payload_hash, validatedRawHash);
    assert.deepEqual(page.protected_raw_response, validatedRaw);
    assert.deepEqual(
      storedSemantic.normalized_content_json,
      validatedSemanticContent,
    );
    const packRevision =
      await runtime.database.canonical_revisions.findUniqueOrThrow({
        where: { id: packEntity.current_revision_id! },
      });
    assert.deepEqual(packRevision.content_json, validatedProjectionContent);
  } finally {
    release.resolve();
    await independent.$disconnect();
    await runtime.close();
  }
});

async function capturedPageTurn(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  input: Readonly<{
    pageNumber: number;
    requestedValue: string;
    nextValue: string;
    pack?: ReturnType<typeof packObservation>;
    protectedRawResponseText?: string;
    outcomes?: CapturedSourcePageV1["normalizedPage"]["outcomes"];
    protectedNativeEvidence?: CapturedSourcePageV1["protectedNativeEvidence"];
  }>,
) {
  assert.equal(runtime.adapterResult.ok, true);
  if (!runtime.adapterResult.ok) throw new Error("adapter fixture unavailable");
  if (runtime.adapterResult.operationScope.operationKind !== "page_read") {
    throw new Error("page-read scope fixture unavailable");
  }
  const requestedCursor = {
    ...runtime.pins.requestedCursor,
    value: input.requestedValue,
  };
  const nextCursor = {
    ...requestedCursor,
    value: input.nextValue,
  };
  const raw = new TextEncoder().encode(
    input.protectedRawResponseText ?? `sanitized-page-${input.pageNumber}`,
  );
  const outcomes = input.outcomes ?? (input.pack
    ? runtime.adapterResult.value.normalizedPage.outcomes.map(
        (outcome, index) => index === 0
          ? { status: "valid" as const, recordIndex: 0, observation: input.pack! }
          : outcome,
      )
    : runtime.adapterResult.value.normalizedPage.outcomes);
  const protectedNativeEvidence = input.protectedNativeEvidence ??
    (input.outcomes
      ? outcomes.flatMap((outcome) => {
          const references = outcome.status === "invalid"
            ? [outcome.protectedNativeEvidenceRef]
            : [
                outcome.observation.protectedNativeEvidenceRef,
                ...(outcome.observation.kind === "trade" &&
                    outcome.observation.protectedTransactionEvidenceRef !== null
                  ? [outcome.observation.protectedTransactionEvidenceRef]
                  : []),
              ];
          return references.map((reference) => ({
            reference,
            value: { sanitized: true, recordIndex: outcome.recordIndex },
          }));
        })
      : runtime.adapterResult.value.protectedNativeEvidence);
  const page = normalizedProviderObservationPageSchema.parse({
    ...runtime.adapterResult.value.normalizedPage,
    outcomes,
    nextCursor,
    measurements: {
      ...runtime.adapterResult.value.normalizedPage.measurements,
      responseBytes: raw.byteLength,
      recordCount: outcomes.length,
    },
  });
  const requestedFingerprint = runtime.guard.fingerprint(requestedCursor);
  const protectedRawResponseSha256 = createHash("sha256")
    .update(raw)
    .digest("hex");
  const requestAttemptId = randomUUID();
  const requestLeaseId = randomUUID();
  const pageId = randomUUID();
  const capturedAt = await databaseNow(runtime.database);
  await runtime.database.compact_source_request_attempts.create({
    data: {
      request_attempt_id: requestAttemptId,
      organization_id: runtime.organizationId,
      operation_kind: "page_read",
      terminal_state: "captured",
      outcome_class: "response_captured",
      safe_outcome_hash: providerSourceSuccessfulCaptureOutcomeHash({
        ok: true,
        protectedRawResponseSha256,
        measurements: {
          durationMilliseconds: page.measurements.durationMilliseconds,
          responseBytes: page.measurements.responseBytes,
        },
        diagnostics: [],
      }),
      response_bytes: page.measurements.responseBytes,
      duration_ms: page.measurements.durationMilliseconds,
      request_lease_id: requestLeaseId,
      claim_owner: runtime.pins.runLeaseOwner,
      claim_token: runtime.pins.runLeaseToken,
      supervisor_epoch_id: runtime.pins.supervisorEpochId,
      connection_profile_id: runtime.pins.connectionProfileId,
      connection_revision_id: runtime.pins.connectionRevisionId,
      expected_health_generation: runtime.pins.connectionHealthGeneration,
      provider_id: runtime.providerId,
      source_instance_id: runtime.source.sourceInstanceId,
      source_revision_id: runtime.source.sourceRevisionId,
      run_id: runtime.pins.runId,
      page_number: input.pageNumber,
      cursor_generation: runtime.pins.cursorGeneration,
      requested_cursor_fingerprint: requestedFingerprint,
      requested_cursor_key: requestedFingerprint,
      started_at: capturedAt,
      terminal_at: capturedAt,
    },
  });
  const pins = {
      ...runtime.pins,
      requestAttemptId,
      requestLeaseId,
      pageId,
      pageNumber: input.pageNumber,
      requestedCursor,
      requestedCursorFingerprint: requestedFingerprint,
    };
  const adapterResult = await completeAuthenticPageReadForTest(
    {
      manifest: runtime.manifest,
      pins: {
        operationKind: "page_read",
        requestAttemptId,
        requestLeaseId,
        organizationId: runtime.organizationId,
        sourceTypeKey: runtime.pins.sourceTypeKey,
        adapterVersion: runtime.pins.sourceAdapterVersion,
        singletonFencingEpoch: runtime.pins.singletonFencingEpoch,
        connectionProfileId: runtime.pins.connectionProfileId,
        connectionProfileRevisionId: runtime.pins.connectionRevisionId,
        connectionHealthGeneration: Number(
          runtime.pins.connectionHealthGeneration,
        ),
        provider: runtime.pins.provider,
        sourceInstanceId: runtime.source.sourceInstanceId,
        sourceRevisionId: runtime.source.sourceRevisionId,
        normalizedContractVersion: runtime.pins.normalizedContractVersion,
        identityNamespaceKey: runtime.pins.identityNamespaceKey,
        importRunId: runtime.pins.runId,
        runClaimLeaseId: runtime.pins.runClaimLeaseId,
        pageAttemptId: pageId,
        pageNumber: input.pageNumber,
        pageLimit: 250,
        cursorGeneration: Number(runtime.pins.cursorGeneration),
        requestedCursorFingerprint: requestedFingerprint,
      },
      requestedCursor,
      connectionConfiguration: { fixture: "protected" },
      sourceConfiguration: { platform: runtime.pins.provider },
    },
    new StaticCapturedPageSourceAdapter(runtime.manifest, {
      rawResponse: raw,
      protectedNativeEvidence,
      normalizedPage: page,
    }),
  );
  return {
    pins,
    adapterResult,
    committedAt: capturedAt,
  };
}

async function completeAlternatePageRead(
  runtime: Awaited<ReturnType<typeof createRuntime>>,
  pins: ProviderSourcePageCommitPins,
  payload: ReturnType<typeof alternateBookmarkWrapper>,
) {
  const requestAttemptId = randomUUID();
  const requestLeaseId = randomUUID();
  const replacementPins = {
    ...pins,
    requestAttemptId,
    requestLeaseId,
  };
  const adapterResult = await completeAuthenticPageReadForTest(
    {
      manifest: alternateBookmarkSourceManifest,
      pins: {
        operationKind: "page_read",
        requestAttemptId,
        requestLeaseId,
        organizationId: pins.organizationId,
        sourceTypeKey: pins.sourceTypeKey,
        adapterVersion: pins.sourceAdapterVersion,
        singletonFencingEpoch: pins.singletonFencingEpoch,
        connectionProfileId: pins.connectionProfileId,
        connectionProfileRevisionId: pins.connectionRevisionId,
        connectionHealthGeneration: Number(pins.connectionHealthGeneration),
        provider: pins.provider,
        sourceInstanceId: pins.sourceInstanceId,
        sourceRevisionId: pins.sourceRevisionId,
        normalizedContractVersion: pins.normalizedContractVersion,
        identityNamespaceKey: pins.identityNamespaceKey,
        importRunId: pins.runId,
        runClaimLeaseId: pins.runClaimLeaseId,
        pageAttemptId: pins.pageId,
        pageNumber: pins.pageNumber,
        pageLimit: 250,
        cursorGeneration: Number(pins.cursorGeneration),
        requestedCursorFingerprint: pins.requestedCursorFingerprint,
      },
      requestedCursor: pins.requestedCursor,
      connectionConfiguration: { channel: "fixture" },
      sourceConfiguration: { partition: "courtyard" },
    },
    new AlternateBookmarkSourceAdapter(payload),
  );
  assert.equal(adapterResult.ok, true);
  if (!adapterResult.ok) throw new Error("alternate adapter fixture failed");
  const capturedAt = await databaseNow(runtime.database);
  await runtime.database.compact_source_request_attempts.create({
    data: {
      request_attempt_id: requestAttemptId,
      organization_id: pins.organizationId,
      operation_kind: "page_read",
      terminal_state: "captured",
      outcome_class: "response_captured",
      safe_outcome_hash: providerSourceSuccessfulCaptureOutcomeHash({
        ok: true,
        protectedRawResponseSha256:
          adapterResult.value.requestCapture.protectedRawResponseSha256,
        measurements: adapterResult.measurements,
        diagnostics: [],
      }),
      response_bytes: adapterResult.measurements.responseBytes,
      duration_ms: adapterResult.measurements.durationMilliseconds,
      request_lease_id: requestLeaseId,
      claim_owner: pins.runLeaseOwner,
      claim_token: pins.runLeaseToken,
      supervisor_epoch_id: pins.supervisorEpochId,
      connection_profile_id: pins.connectionProfileId,
      connection_revision_id: pins.connectionRevisionId,
      expected_health_generation: pins.connectionHealthGeneration,
      provider_id: pins.providerId,
      source_instance_id: pins.sourceInstanceId,
      source_revision_id: pins.sourceRevisionId,
      run_id: pins.runId,
      page_number: pins.pageNumber,
      cursor_generation: pins.cursorGeneration,
      requested_cursor_fingerprint: pins.requestedCursorFingerprint,
      requested_cursor_key:
        pins.requestedCursorFingerprint ?? "initial",
      started_at: capturedAt,
      terminal_at: capturedAt,
    },
  });
  return { pins: replacementPins, adapterResult };
}

test("mixed normalized page commits valid siblings, quarantine, EV, diagnostic, and cursor once", async () => {
  const runtime = await createRuntime("success");
  try {
    const before = await databaseNow(runtime.database);
    const input = {
      pins: runtime.pins,
      adapterResult: runtime.adapterResult,
      committedAt: new Date("2000-01-01T00:00:00.000Z"),
    };
    const result = await service(runtime).importPage(input);
    assert.equal(result.kind, "committed");
    assert.deepEqual(result.counts, {
      inserted: 3,
      revised: 0,
      duplicate: 0,
      quarantined: 1,
      warnings: 0,
      unresolvedRelationships: 3,
      canonicalRevisions: 4,
      evRequests: 1,
    });
    const [page, cursor, ev, quarantine] = await Promise.all([
      runtime.database.import_pages.findUniqueOrThrow({
        where: { id: runtime.pins.pageId },
      }),
      runtime.database.provider_source_cursors.findUniqueOrThrow({
        where: { source_instance_id: runtime.source.sourceInstanceId },
      }),
      runtime.database.estimated_ev_recomputation_requests.findFirstOrThrow({
        where: { organization_id: runtime.organizationId },
      }),
      runtime.database.quarantine_records.findFirstOrThrow({
        where: { organization_id: runtime.organizationId },
      }),
    ]);
    assert.ok(page.committed_at >= before);
    assert.notEqual(page.committed_at.toISOString(), input.committedAt.toISOString());
    assert.equal(cursor.cursor_fingerprint, result.cursorFingerprint);
    assert.equal(ev.configuration_revision_id, null);
    assert.equal(ev.source_instance_id, runtime.source.sourceInstanceId);
    assert.equal(ev.source_revision_id, runtime.source.sourceRevisionId);
    assert.notEqual(quarantine.delivery_occurrence_id, null);
    assert.equal(quarantine.source_record_id, null);
    const storedPagePayload = JSON.stringify(page.payload_json);
    assert.match(storedPagePayload, /protectedNativeEvidenceReferences/u);
    assert.doesNotMatch(storedPagePayload, /accepted-native-evidence/u);
    assert.notEqual(page.protected_raw_response, null);

    const adminRun = await new PrismaAdminImportRunRepository(
      runtime.database,
    ).get({
      organizationId: runtime.organizationId,
      runId: runtime.pins.runId,
    });
    assert.deepEqual(adminRun?.counters, {
      pages: 1,
      catalog: 1,
      pulls: 1,
      trades: 1,
      accepted: 3,
      unchanged: 0,
      revised: 0,
      quarantined: 1,
      resolvedQuarantines: 0,
    });
    assert.deepEqual(adminRun?.pages[0] && {
      catalog: adminRun.pages[0].catalog,
      pulls: adminRun.pages[0].pulls,
      trades: adminRun.pages[0].trades,
      accepted: adminRun.pages[0].accepted,
      unchanged: adminRun.pages[0].unchanged,
      revised: adminRun.pages[0].revised,
      quarantined: adminRun.pages[0].quarantined,
    }, {
      catalog: 1,
      pulls: 1,
      trades: 1,
      accepted: 3,
      unchanged: 0,
      revised: 0,
      quarantined: 1,
    });

    const [packRevision, evInputRevision] = await Promise.all([
      runtime.database.canonical_revisions.findUniqueOrThrow({
        where: { id: ev.pack_revision_id! },
      }),
      runtime.database.canonical_revisions.findUniqueOrThrow({
        where: { id: ev.ev_input_revision_id! },
      }),
    ]);
    assert.equal(
      (packRevision.content_json as Record<string, unknown>).priceValueMinor,
      1_000,
    );
    const evInputContent = evInputRevision.content_json as Record<
      string,
      unknown
    >;
    assert.equal(evInputContent.evidenceCompleteness, "complete");
    assert.equal(
      ((evInputContent.probabilityBuckets as Array<Record<string, unknown>>)[0])
        ?.lowerValueMinor,
      1_000,
    );

    const canonical = new IngestionPersistenceRepository(runtime.database, {
      retentionDays: 90,
      actorPseudonymKey: actorKey,
    });
    const calculatedAt = await databaseNow(runtime.database);
    const processor = new EstimatedEvRecomputationProcessor(
      new PrismaEstimatedEvRecomputationRepository(runtime.database),
      new PackScoutEstimatedEvService(
        new CanonicalEstimatedEvProjectionRepository(canonical),
      ),
      { now: () => calculatedAt },
      { workerId: "atomic-source-ev-worker" },
    );
    assert.deepEqual(
      await processor.runCycle(),
      {
        claimed: 1,
        completed: 1,
        estimated: 1,
        unavailable: 0,
        retrying: 0,
        failed: 0,
        lost: 0,
        capReached: false,
      },
    );
    const calculation = await runtime.database.canonical_entities.findFirstOrThrow({
      where: {
        organization_id: runtime.organizationId,
        platform_key: "courtyard",
        record_kind: "estimated_ev",
        external_id: "pack-1",
      },
    });
    const calculatedRevision =
      await runtime.database.canonical_revisions.findUniqueOrThrow({
        where: { id: calculation.current_revision_id! },
      });
    const calculatedContent = calculatedRevision.content_json as Record<
      string,
      unknown
    >;
    assert.equal(calculatedContent.status, "estimated");
    assert.equal(calculatedContent.grossValueMinor, 1_500);
    assert.equal(calculatedContent.evPercent, 150);

    const replay = await service(runtime).importPage(input);
    assert.equal(replay.kind, "already_committed");
    assert.equal(
      await runtime.database.canonical_revisions.count({
        where: { organization_id: runtime.organizationId },
      }),
      5,
    );
    assert.equal(
      await runtime.database.estimated_ev_recomputation_requests.count({
        where: { organization_id: runtime.organizationId },
      }),
      1,
    );
  } finally {
    await runtime.close();
  }
});

test("representative mixed commit measures normalized, canonical, evidence, operational, and lineage storage", async () => {
  const runtime = await createRuntime("capacity-measurement");
  try {
    assert.equal(runtime.adapterResult.ok, true);
    if (!runtime.adapterResult.ok) assert.fail("capacity page unavailable");
    const original = runtime.adapterResult.value.normalizedPage.outcomes;
    const originalPack = original[0]?.status === "valid"
      ? original[0].observation
      : null;
    const originalPull = original[2]?.status === "valid"
      ? original[2].observation
      : null;
    const originalTrade = original[3]?.status === "valid"
      ? original[3].observation
      : null;
    if (
      originalPack?.kind !== "catalog" ||
      originalPack.entity !== "pack" ||
      originalPull?.kind !== "pull" ||
      originalTrade?.kind !== "trade"
    ) {
      assert.fail("capacity observations unavailable");
    }
    const before = await measureCapacityRelations(
      runtime.database,
      runtime.organizationId,
    );
    let pageDurationMilliseconds = 0;
    let pageStatementCount = 0;
    let previousCursor = "";
    let pageNumber = 0;
    const windows: Array<{
      window: number;
      inputRecords: number;
      structuredPhysicalBytes: number;
      structuredPhysicalBytesPerRecord: number;
      normalizedPayloadPhysicalBytesPerRecord: number;
      importPagePhysicalBytes: number;
      quarantinePhysicalBytes: number;
      quarantineEvidencePhysicalBytes: number;
      diagnosticPhysicalBytesPerPage: number;
      terminalAttemptPhysicalBytes: number;
      compactAttemptPhysicalBytes: number;
    }> = [];

    for (let windowIndex = 0; windowIndex < capacityWindowCount; windowIndex += 1) {
      const windowBefore = await measureCapacityRelations(
        runtime.database,
        runtime.organizationId,
      );
      for (let offset = 0; offset < capacityPagesPerWindow; offset += 1) {
        pageNumber += 1;
        if (pageNumber === 1) {
          runtime.statementCounter.reset();
          const startedAt = performance.now();
          const committed = await service(runtime).importPage({
            pins: runtime.pins,
            adapterResult: runtime.adapterResult,
            committedAt: await databaseNow(runtime.database),
          });
          pageDurationMilliseconds = performance.now() - startedAt;
          pageStatementCount = runtime.statementCounter.count;
          assert.equal(committed.kind, "committed");
          previousCursor = "cursor-a";
          continue;
        }
        const suffix = String(pageNumber).padStart(3, "0");
        const nextCursor = `capacity-cursor-${suffix}`;
        const observedAt = new Date(
          Date.parse("2026-08-21T12:00:00.000Z") + pageNumber * 1_000,
        ).toISOString();
        const collectedAt = new Date(Date.parse(observedAt) + 1).toISOString();
        const outcomes = [
          {
            status: "valid" as const,
            recordIndex: 0,
            observation: packObservation({
              ...originalPack,
              providerRecordIdentity: {
                recordIdScopeKey: "catalog-pack-v1",
                providerRecordId: `capacity-pack-${suffix}`,
              },
              effectiveAt: observedAt,
              collectedAt,
              protectedNativeEvidenceRef: `evidence:capacity-pack-${suffix}`,
            }),
          },
          {
            status: "invalid" as const,
            recordIndex: 1,
            reasonCode: "missing_identity",
            fieldPaths: ["id"],
            protectedNativeEvidenceRef: `evidence:capacity-invalid-${suffix}`,
          },
          {
            status: "valid" as const,
            recordIndex: 2,
            observation: pullObservation({
              ...originalPull,
              providerRecordIdentity: {
                recordIdScopeKey: "pull-v1",
                providerRecordId: `capacity-pull-${suffix}`,
              },
              effectiveAt: observedAt,
              collectedAt,
              protectedNativeEvidenceRef: `evidence:capacity-pull-${suffix}`,
            }),
          },
          {
            status: "valid" as const,
            recordIndex: 3,
            observation: tradeObservation({
              ...originalTrade,
              providerRecordIdentity: {
                recordIdScopeKey: "trade-v1",
                providerRecordId: `capacity-trade-${suffix}`,
              },
              effectiveAt: observedAt,
              collectedAt,
              protectedNativeEvidenceRef: `evidence:capacity-trade-${suffix}`,
              protectedTransactionEvidenceRef:
                `transaction-evidence:capacity-trade-${suffix}`,
            }),
          },
        ];
        const committed = await service(runtime).importPage(
          await capturedPageTurn(runtime, {
            pageNumber,
            requestedValue: previousCursor,
            nextValue: nextCursor,
            outcomes,
            protectedRawResponseText: `sanitized-capacity-page-${suffix}`,
          }),
        );
        assert.equal(committed.kind, "committed");
        previousCursor = nextCursor;
      }
      await runtime.database.$executeRaw`
        insert into public.source_request_attempts (
          id, organization_id, operation_kind, state, request_lease_id,
          claim_owner, claim_token, supervisor_epoch_id, connection_profile_id,
          connection_revision_id, expected_health_generation, provider_id,
          source_instance_id, source_revision_id, connection_test_job_id,
          source_test_job_id, run_id, page_number, cursor_generation,
          requested_cursor_fingerprint, requested_cursor_key,
          blocking_episode_id, blocking_episode_connection_revision_id,
          outcome_class, safe_code, safe_outcome_hash, response_status,
          response_bytes, duration_ms, started_at, terminal_at, expires_at,
          compacted_at
        )
        select proof.request_attempt_id, proof.organization_id,
               proof.operation_kind,
               'in_flight'::public.source_request_attempt_state,
               proof.request_lease_id, proof.claim_owner, proof.claim_token,
               proof.supervisor_epoch_id, proof.connection_profile_id,
               proof.connection_revision_id,
               proof.expected_health_generation, proof.provider_id,
               proof.source_instance_id, proof.source_revision_id,
               proof.connection_test_job_id, proof.source_test_job_id,
               proof.run_id, proof.page_number, proof.cursor_generation,
               proof.requested_cursor_fingerprint,
               proof.requested_cursor_key, proof.blocking_episode_id,
               proof.blocking_episode_connection_revision_id,
               null, null, null, null, null, null, proof.started_at,
               null, null, null
        from public.compact_source_request_attempts as proof
        where proof.organization_id = ${runtime.organizationId}::uuid
          and not exists (
            select 1 from public.source_request_attempts as attempt
            where attempt.id = proof.request_attempt_id
          )
      `;
      await runtime.database.$executeRaw`
        update public.source_request_attempts as attempt
        set state = proof.terminal_state,
            outcome_class = proof.outcome_class,
            safe_code = 'response_captured',
            safe_outcome_hash = proof.safe_outcome_hash,
            response_status = 200,
            response_bytes = proof.response_bytes,
            duration_ms = proof.duration_ms,
            terminal_at = proof.terminal_at,
            expires_at = proof.terminal_at + interval '30 days'
        from public.compact_source_request_attempts as proof
        where attempt.organization_id = ${runtime.organizationId}::uuid
          and proof.request_attempt_id = attempt.id
          and attempt.state = 'in_flight'::public.source_request_attempt_state
      `;
      const windowBeforeExpiry = await measureCapacityRelations(
        runtime.database,
        runtime.organizationId,
      );
      const rawBytes = await runtime.database.$queryRaw<Array<{
        bytes: bigint;
      }>>`
        select coalesce(sum(octet_length(protected_raw_response)), 0)::bigint
          as bytes
        from public.import_pages
        where organization_id = ${runtime.organizationId}::uuid
          and payload_expired_at is null
      `;
      await expireCapacityEvidence(runtime.database, runtime.organizationId);
      const windowAfter = await measureCapacityRelations(
        runtime.database,
        runtime.organizationId,
      );
      const delta = capacityRelationDelta(
        windowBefore,
        windowAfter,
        true,
      );
      const inputRecords = capacityPagesPerWindow * 4;
      const physicalBytes = structuredPhysicalBytes(delta);
      const pageRows = delta.find(({ relation }) => relation === "import_pages")
        ?.rows ?? 0;
      if (pageRows !== capacityPagesPerWindow) {
        throw new Error("capacity page window row count mismatch");
      }
      windows.push({
        window: windowIndex + 1,
        inputRecords,
        structuredPhysicalBytes: physicalBytes,
        structuredPhysicalBytesPerRecord: Math.ceil(
          physicalBytes / inputRecords,
        ),
        normalizedPayloadPhysicalBytesPerRecord: Math.ceil(
          Math.max(
            1,
            relationPhysicalBytes(windowBeforeExpiry, "import_pages") -
              relationPhysicalBytes(windowAfter, "import_pages") -
              Number(rawBytes[0]?.bytes ?? 0n),
          ) / inputRecords,
        ),
        importPagePhysicalBytes: Math.ceil(
          relationPhysicalBytes(windowAfter, "import_pages") /
            (windowAfter.find(({ relation }) => relation === "import_pages")
              ?.rows ?? pageRows),
        ),
        quarantinePhysicalBytes: physicalBytesPerMeasuredRow(
          windowAfter,
          "quarantine_records",
        ),
        quarantineEvidencePhysicalBytes: Math.ceil(
          Math.max(
            1,
            relationPhysicalBytes(windowBeforeExpiry, "quarantine_records") -
              relationPhysicalBytes(windowAfter, "quarantine_records"),
          ) /
            (delta.find(({ relation }) => relation === "quarantine_records")
              ?.rows ?? 1),
        ),
        diagnosticPhysicalBytesPerPage: Math.ceil(
          relationPhysicalBytes(delta, "source_processor_diagnostic_events") /
            pageRows,
        ),
        terminalAttemptPhysicalBytes: physicalBytesPerMeasuredRow(
          delta,
          "source_request_attempts",
        ),
        compactAttemptPhysicalBytes: physicalBytesPerMeasuredRow(
          delta,
          "compact_source_request_attempts",
        ),
      });
    }
    assert.ok(pageStatementCount > 0);

    const after = await measureCapacityRelations(
      runtime.database,
      runtime.organizationId,
    );
    const relations = capacityRelationDelta(before, after);
    const pages = capacityWindowCount * capacityPagesPerWindow;
    const inputRecords = pages * 4;
    const conservativeWindowValue = (
      key:
        | "structuredPhysicalBytesPerRecord"
        | "normalizedPayloadPhysicalBytesPerRecord"
        | "importPagePhysicalBytes"
        | "quarantinePhysicalBytes"
        | "quarantineEvidencePhysicalBytes"
        | "diagnosticPhysicalBytesPerPage"
        | "terminalAttemptPhysicalBytes"
        | "compactAttemptPhysicalBytes",
      denominator: number,
      allocationPages = 1,
    ) => Math.max(...windows.map((window) => window[key])) + Math.ceil(
      allocationPages * postgresAllocationPageBytes / denominator,
    );
    const structuredPhysicalBytesPerRecord = conservativeWindowValue(
      "structuredPhysicalBytesPerRecord",
      capacityPagesPerWindow * 4,
      structuredCapacityRelations.size,
    );
    const measurement = {
      sample: {
        inputRecords,
        acceptedRecords: pages * 3,
        quarantinedRecords: pages,
        pages,
        windows: capacityWindowCount,
        pagesPerWindow: capacityPagesPerWindow,
      },
      pageDurationMilliseconds: Number(pageDurationMilliseconds.toFixed(3)),
      pageStatementCount,
      allocationPageBytes: postgresAllocationPageBytes,
      structuredPhysicalBytesPerRecord,
      normalizedPayloadPhysicalBytesPerRecord: conservativeWindowValue(
        "normalizedPayloadPhysicalBytesPerRecord",
        capacityPagesPerWindow * 4,
      ),
      importPagePhysicalBytes: conservativeWindowValue(
        "importPagePhysicalBytes",
        capacityPagesPerWindow,
      ),
      quarantinePhysicalBytes: conservativeWindowValue(
        "quarantinePhysicalBytes",
        capacityPagesPerWindow,
      ),
      quarantineEvidencePhysicalBytes: conservativeWindowValue(
        "quarantineEvidencePhysicalBytes",
        capacityPagesPerWindow,
      ),
      diagnosticPhysicalBytesPerPage: conservativeWindowValue(
        "diagnosticPhysicalBytesPerPage",
        capacityPagesPerWindow,
      ),
      terminalAttemptPhysicalBytes: conservativeWindowValue(
        "terminalAttemptPhysicalBytes",
        capacityPagesPerWindow,
      ),
      compactAttemptPhysicalBytes: conservativeWindowValue(
        "compactAttemptPhysicalBytes",
        capacityPagesPerWindow,
      ),
      windows,
      relations,
    };
    assert.equal(relations.length, capacityRelations.length);
    for (const relation of relations) {
      assert.ok(relation.rows > 0, `${relation.relation} has no measured rows`);
      assert.ok(
        relation.logicalRowBytes > 0,
        `${relation.relation} has no logical row bytes`,
      );
      assert.ok(relation.tableBytes >= 0);
      assert.ok(relation.indexBytes >= 0);
      assert.ok(relation.totalBytes >= relation.tableBytes + relation.indexBytes);
    }
    if (process.env.PACKSCOUT_PRINT_PROVIDER_SOURCE_CAPACITY === "1") {
      console.log(
        `PROVIDER_SOURCE_STORAGE_MEASUREMENT=${JSON.stringify(measurement)}`,
      );
    }
    const committedArtifact = await committedCapacityStorageArtifact();
    assert.deepEqual(
      measurement.sample,
      committedArtifact.storageMeasurement.sample,
    );
    // The committed artifact records the measured statement budget from before
    // page-level batching; the live count must never regress above it. Rerun
    // with PACKSCOUT_PRINT_PROVIDER_SOURCE_CAPACITY=1 to re-record the artifact.
    assert.ok(
      measurement.pageStatementCount <=
        committedArtifact.storageMeasurement.pageStatementCount,
      `page statement count ${measurement.pageStatementCount} exceeded the ` +
        `committed budget ${committedArtifact.storageMeasurement.pageStatementCount}`,
    );
    assert.equal(
      committedArtifact.storageMeasurement.allocationPageBytes,
      postgresAllocationPageBytes,
    );
    assert.ok(
      Math.max(...measurement.windows.map(
        (window) => window.structuredPhysicalBytesPerRecord,
      )) <=
        committedArtifact.storageMeasurement.structuredPhysicalBytesPerRecord,
      "measured structured physical bytes exceeded the committed conservative window",
    );
    for (const key of [
      "normalizedPayloadPhysicalBytesPerRecord",
      "importPagePhysicalBytes",
      "quarantinePhysicalBytes",
      "quarantineEvidencePhysicalBytes",
      "diagnosticPhysicalBytesPerPage",
      "terminalAttemptPhysicalBytes",
      "compactAttemptPhysicalBytes",
    ] as const) {
      assert.ok(
        Math.max(...measurement.windows.map((window) => window[key])) <=
          committedArtifact.storageMeasurement[key],
        `${key} exceeded the committed allocation-page bound`,
      );
    }
    for (const expected of committedArtifact.storageMeasurement.relations) {
      const measured = relations.find(
        ({ relation }) => relation === expected.relation,
      );
      if (!measured) assert.fail(`Missing measured relation ${expected.relation}`);
      assert.deepEqual(
        {
          rows: measured.rows,
        },
        {
          rows: expected.rows,
        },
      );
      // Random UUID text inside JSONB can change pglz compression by a few
      // bytes while representing the same schema/content volume.
      assert.ok(
        Math.abs(measured.logicalRowBytes - expected.logicalRowBytes) <= 128,
        `${expected.relation} logical bytes drifted outside the UUID bound`,
      );
    }
    assert.ok(
      committedArtifact.storageMeasurement.pageDurationMilliseconds > 0,
    );
  } finally {
    await runtime.close();
  }
});

test("incomplete source EV evidence commits the pack without derived work", async () => {
  const runtime = await createRuntime("incomplete-ev", { completeEv: false });
  try {
    const result = await service(runtime).importPage({
      pins: runtime.pins,
      adapterResult: runtime.adapterResult,
      committedAt: await databaseNow(runtime.database),
    });
    assert.equal(result.kind, "committed");
    assert.equal(result.counts.canonicalRevisions, 3);
    assert.equal(result.counts.evRequests, 0);
    assert.equal(
      await runtime.database.canonical_entities.count({
        where: {
          organization_id: runtime.organizationId,
          record_kind: "ev_input",
        },
      }),
      0,
    );
    assert.equal(
      await runtime.database.estimated_ev_recomputation_requests.count({
        where: { organization_id: runtime.organizationId },
      }),
      0,
    );
  } finally {
    await runtime.close();
  }
});

test("ready to unavailable to same-ready EV evidence invalidates and reactivates exactly", async () => {
  const runtime = await createRuntime("complete-to-incomplete-ev");
  try {
    await service(runtime).importPage({
      pins: runtime.pins,
      adapterResult: runtime.adapterResult,
      committedAt: await databaseNow(runtime.database),
    });
    const canonical = new IngestionPersistenceRepository(runtime.database, {
      retentionDays: 90,
      actorPseudonymKey: actorKey,
    });
    const estimatedEv = new PackScoutEstimatedEvService(
      new CanonicalEstimatedEvProjectionRepository(canonical),
    );
    let processorNow = await databaseNow(runtime.database);
    const processor = new EstimatedEvRecomputationProcessor(
      new PrismaEstimatedEvRecomputationRepository(runtime.database),
      estimatedEv,
      { now: () => processorNow },
      { workerId: "ev-readiness-cycle" },
    );
    const initialCycle = await processor.runCycle();
    assert.deepEqual(
      {
        claimed: initialCycle.claimed,
        completed: initialCycle.completed,
        estimated: initialCycle.estimated,
        unavailable: initialCycle.unavailable,
        failed: initialCycle.failed,
      },
      { claimed: 1, completed: 1, estimated: 1, unavailable: 0, failed: 0 },
    );
    assert.equal(
      (await estimatedEv.explain({
        organizationId: runtime.organizationId,
        platformKey: "courtyard",
        packExternalId: "pack-1",
      }))?.status,
      "estimated",
    );
    assert.equal(runtime.adapterResult.ok, true);
    if (!runtime.adapterResult.ok) assert.fail("captured pack unavailable");
    const firstOutcome = runtime.adapterResult.value.normalizedPage.outcomes[0];
    if (
      firstOutcome?.status !== "valid" ||
      firstOutcome.observation.kind !== "catalog" ||
      firstOutcome.observation.entity !== "pack" ||
      firstOutcome.observation.providerFacts.kind !== "pack"
    ) {
      assert.fail("captured pack unavailable");
    }
    const firstPack = firstOutcome.observation;
    const firstPackFacts = firstPack.providerFacts;
    if (
      firstPackFacts.kind !== "pack" ||
      firstPackFacts.evInput.state !== "present"
    ) {
      assert.fail("captured EV evidence unavailable");
    }
    const firstEvInput = await runtime.database.canonical_entities
      .findFirstOrThrow({
        where: {
          organization_id: runtime.organizationId,
          record_kind: "ev_input",
          external_id: "pack-1",
        },
      });
    const incompletePack = packObservation({
      ...firstPack,
      effectiveAt: "2026-08-21T13:00:00.000Z",
      collectedAt: "2026-08-21T13:00:01.000Z",
      providerFacts: {
        ...firstPackFacts,
        evInput: {
          state: "present",
          value: {
            ...firstPackFacts.evInput.value,
            approved: false,
          },
        },
      },
    });
    const input = await capturedPageTurn(runtime, {
      pageNumber: 2,
      requestedValue: "cursor-a",
      nextValue: "cursor-b",
      outcomes: [{
        status: "valid",
        recordIndex: 0,
        observation: incompletePack,
      }],
    });
    const result = await service(runtime).importPage(input);
    assert.equal(result.kind, "committed");
    assert.equal(result.counts.evRequests, 0);
    assert.equal(result.counts.canonicalRevisions, 1);
    assert.equal(
      await runtime.database.estimated_ev_recomputation_requests.count({
        where: { organization_id: runtime.organizationId },
      }),
      1,
    );
    const unavailablePack = await runtime.database.canonical_entities
      .findFirstOrThrow({
        where: {
          organization_id: runtime.organizationId,
          record_kind: "pack",
          external_id: "pack-1",
        },
      });
    const unavailableRevision = await runtime.database.canonical_revisions
      .findUniqueOrThrow({ where: { id: unavailablePack.current_revision_id! } });
    assert.equal(
      (unavailableRevision.content_json as Record<string, unknown>)
        .evInputStatus,
      "unavailable",
    );
    assert.equal(
      await estimatedEv.explain({
        organizationId: runtime.organizationId,
        platformKey: "courtyard",
        packExternalId: "pack-1",
      }),
      null,
    );
    const restoredPack = packObservation({
      ...firstPack,
      effectiveAt: "2026-08-21T14:00:00.000Z",
      collectedAt: "2026-08-21T14:00:01.000Z",
    });
    const restored = await service(runtime).importPage(
      await capturedPageTurn(runtime, {
        pageNumber: 3,
        requestedValue: "cursor-b",
        nextValue: "cursor-c",
        outcomes: [{
          status: "valid",
          recordIndex: 0,
          observation: restoredPack,
        }],
      }),
    );
    assert.deepEqual(
      {
        revised: restored.counts.revised,
        duplicate: restored.counts.duplicate,
        canonicalRevisions: restored.counts.canonicalRevisions,
        evRequests: restored.counts.evRequests,
      },
      { revised: 1, duplicate: 0, canonicalRevisions: 1, evRequests: 1 },
    );
    const restoredEvInput = await runtime.database.canonical_entities
      .findFirstOrThrow({
        where: {
          organization_id: runtime.organizationId,
          record_kind: "ev_input",
          external_id: "pack-1",
        },
      });
    assert.equal(
      restoredEvInput.current_revision_id,
      firstEvInput.current_revision_id,
    );
    processorNow = await databaseNow(runtime.database);
    assert.equal((await processor.runCycle()).estimated, 1);
    assert.equal(
      (await estimatedEv.explain({
        organizationId: runtime.organizationId,
        platformKey: "courtyard",
        packExternalId: "pack-1",
      }))?.status,
      "estimated",
    );
  } finally {
    await runtime.close();
  }
});

test("quarantine retry cannot reuse prior complete EV input after evidence becomes incomplete", async () => {
  const runtime = await createRuntime("quarantine-complete-to-incomplete-ev");
  try {
    await service(runtime).importPage({
      pins: runtime.pins,
      adapterResult: runtime.adapterResult,
      committedAt: await databaseNow(runtime.database),
    });
    await runtime.database.estimated_ev_recomputation_requests.deleteMany({
      where: { organization_id: runtime.organizationId },
    });
    const incompletePack = packObservation({
      effectiveAt: "2026-08-21T13:00:00.000Z",
      collectedAt: "2026-08-21T13:00:01.000Z",
      providerFacts: packFacts({
        price: { state: "present", value: { amount: 11, currency: "USD" } },
        drawCount: { state: "present", value: 1 },
        buybackPercent: { state: "present", value: 80 },
        evInput: {
          state: "present",
          value: {
            approved: false,
            currency: "USD",
            unitBasis: "per_pack",
            drawCount: 1,
            buybackPercent: 80,
            totalQuantity: 2,
            buckets: [{
              bucketId: "base",
              label: "Base",
              probability: 1,
              quantity: 2,
              lowerValue: 10,
              upperValue: 20,
            }],
          },
        },
      }),
    });
    const page = await capturedPageTurn(runtime, {
      pageNumber: 2,
      requestedValue: "cursor-a",
      nextValue: "cursor-b",
      outcomes: [{
        status: "valid",
        recordIndex: 0,
        observation: incompletePack,
      }],
    });
    const productionMappers = createProviderObservationMapperRegistryFromManifest();
    const quarantinePackResolver = {
      resolve(input: Parameters<typeof productionMappers.resolve>[0]) {
        const mapper = productionMappers.resolve(input);
        return {
          descriptor: mapper.descriptor,
          map(mappingInput: Parameters<typeof mapper.map>[0]) {
            return {
              status: "quarantined" as const,
              reasonCode: "mapper_input_incompatible" as const,
              warnings: [],
              protectedNativeEvidenceRef:
                mappingInput.observation.protectedNativeEvidenceRef,
            };
          },
        };
      },
    };
    const quarantined = await new ProviderSourcePageImportService(
      new ProviderSourcePagePlanner(quarantinePackResolver),
      runtime.guard,
      new ProviderSourcePageRepository(runtime.database, {
        actorPseudonymKey: actorKey,
      }),
    ).importPage(page);
    assert.equal(quarantined.counts.quarantined, 1);
    const entry = await runtime.database.quarantine_records.findFirstOrThrow({
      where: { page_id: page.pins.pageId },
    });
    const retry = new ProviderSourceQuarantineService({
      repository: new ProviderSourceQuarantineRepository(
        runtime.database,
        actorKey,
      ),
      mappers: productionMappers,
      actorKeyer: {
        keyFor: ({ organizationId, operatorId }) =>
          `actor:${organizationId}:${operatorId}`,
      },
      clock: { now: () => new Date("2099-01-01T00:00:00.000Z") },
      ids: { id: randomUUID },
    });
    const retried = await retry.retryOne({
      organizationId: runtime.organizationId,
      operatorId: randomUUID(),
      role: "data_operator",
    }, entry.id);
    assert.equal(retried.outcome, "resolved");
    assert.equal(
      await runtime.database.estimated_ev_recomputation_requests.count({
        where: { organization_id: runtime.organizationId },
      }),
      0,
    );
    const pack = await runtime.database.canonical_entities.findFirstOrThrow({
      where: {
        organization_id: runtime.organizationId,
        record_kind: "pack",
        external_id: "pack-1",
      },
    });
    assert.equal(
      await runtime.database.canonical_revisions.count({
        where: { entity_id: pack.id },
      }),
      2,
    );
  } finally {
    await runtime.close();
  }
});

test("occurrence-owned quarantine retry reprojects retained normalized evidence exactly once", async () => {
  const runtime = await createRuntime("source-quarantine-retry");
  try {
    const productionMappers = createProviderObservationMapperRegistryFromManifest();
    const quarantiningResolver = {
      resolve(input: Parameters<typeof productionMappers.resolve>[0]) {
        const mapper = productionMappers.resolve(input);
        return {
          descriptor: mapper.descriptor,
          map(mappingInput: Parameters<typeof mapper.map>[0]) {
            if (
              mappingInput.observation.kind === "catalog" &&
              mappingInput.observation.providerRecordIdentity.providerRecordId ===
                "pack-1"
            ) {
              return {
                status: "quarantined" as const,
                reasonCode: "mapper_input_incompatible" as const,
                warnings: [],
                protectedNativeEvidenceRef:
                  mappingInput.observation.protectedNativeEvidenceRef,
              };
            }
            return mapper.map(mappingInput);
          },
        };
      },
    };
    const initial = await new ProviderSourcePageImportService(
      new ProviderSourcePagePlanner(quarantiningResolver),
      runtime.guard,
      new ProviderSourcePageRepository(runtime.database, {
        actorPseudonymKey: actorKey,
      }),
    ).importPage({
      pins: runtime.pins,
      adapterResult: runtime.adapterResult,
      committedAt: await databaseNow(runtime.database),
    });
    assert.equal(initial.kind, "committed");
    assert.equal(initial.counts.quarantined, 2);
    assert.equal(initial.counts.canonicalRevisions, 2);
    assert.equal(initial.counts.evRequests, 0);

    const quarantine = await runtime.database.quarantine_records.findFirstOrThrow({
      where: {
        organization_id: runtime.organizationId,
        external_id: "pack-1",
      },
    });
    assert.equal(quarantine.source_record_id, null);
    assert.notEqual(quarantine.delivery_occurrence_id, null);
    const retainedQuarantineEvidence = JSON.stringify(quarantine.payload_json);
    assert.match(retainedQuarantineEvidence, /accepted-native-evidence/u);
    const pageBeforeRetention =
      await runtime.database.import_pages.findUniqueOrThrow({
        where: { id: runtime.pins.pageId },
      });
    assert.equal(
      pageBeforeRetention.expires_at.getTime() -
        pageBeforeRetention.committed_at.getTime(),
      PROVIDER_SOURCE_RAW_PAGE_RETENTION_DAYS * 86_400_000,
    );
    assert.equal(
      quarantine.expires_at.getTime() - quarantine.created_at.getTime(),
      PROVIDER_SOURCE_QUARANTINE_RETENTION_DAYS * 86_400_000,
    );
    const retentionAt = await databaseNow(runtime.database);
    const expiredCommittedAt = new Date(
      retentionAt.getTime() -
        (PROVIDER_SOURCE_RAW_PAGE_RETENTION_DAYS + 1) * 86_400_000,
    );
    await runtime.database.import_pages.update({
      where: { id: runtime.pins.pageId },
      data: {
        committed_at: expiredCommittedAt,
        expires_at: new Date(
          expiredCommittedAt.getTime() +
            PROVIDER_SOURCE_RAW_PAGE_RETENTION_DAYS * 86_400_000,
        ),
      },
    });
    const retention = await new ProviderSourceRetentionRepository(
      runtime.database,
    ).runBatch({
      organizationId: runtime.organizationId,
      batchSize: 100,
      now: retentionAt,
    });
    assert.equal(retention.pagesExpired, 1);
    assert.equal(retention.quarantinesExpired, 0);
    const pageAfterRetention =
      await runtime.database.import_pages.findUniqueOrThrow({
        where: { id: runtime.pins.pageId },
      });
    assert.equal(pageAfterRetention.payload_json, null);
    assert.equal(pageAfterRetention.protected_raw_response, null);
    assert.equal(
      pageAfterRetention.protected_raw_response_sha256,
      runtime.adapterResult.ok
        ? runtime.adapterResult.value.requestCapture.protectedRawResponseSha256
        : null,
    );
    assert.match(
      JSON.stringify(
        (await runtime.database.quarantine_records.findUniqueOrThrow({
          where: { id: quarantine.id },
        })).payload_json,
      ),
      /accepted-native-evidence/u,
    );
    const occurrenceCountBefore =
      await runtime.database.source_delivery_occurrences.count({
        where: { organization_id: runtime.organizationId },
      });
    const cursorBefore =
      await runtime.database.provider_source_cursors.findUniqueOrThrow({
        where: { source_instance_id: runtime.source.sourceInstanceId },
      });
    const retryAt = await databaseNow(runtime.database);
    let callerTime = new Date("2099-01-01T00:00:00.000Z");
    const retries = new ProviderSourceQuarantineService({
      repository: new ProviderSourceQuarantineRepository(
        runtime.database,
        actorKey,
      ),
      mappers: productionMappers,
      actorKeyer: {
        keyFor: ({ organizationId, operatorId }) =>
          `actor:${organizationId}:${operatorId}`,
      },
      clock: { now: () => callerTime },
      ids: { id: randomUUID },
    });
    const actor = {
      organizationId: runtime.organizationId,
      operatorId: randomUUID(),
      role: "data_operator" as const,
    };
    const resolved = await retries.retryOne(actor, quarantine.id);
    assert.equal(resolved.outcome, "resolved");
    assert.equal(resolved.entry?.state, "resolved");
    const successfulAttempt =
      await runtime.database.quarantine_attempts.findFirstOrThrow({
        where: { quarantine_id: quarantine.id },
      });
    assert.ok(successfulAttempt.started_at.getTime() >= retryAt.getTime());
    assert.ok(successfulAttempt.finished_at !== null);
    assert.ok(
      successfulAttempt.finished_at!.getTime() < callerTime.getTime(),
    );
    assert.equal(
      await runtime.database.canonical_revisions.count({
        where: {
          organization_id: runtime.organizationId,
          origin_semantic_observation_id: { not: null },
          source_record_id: null,
        },
      }),
      4,
    );
    assert.equal(
      await runtime.database.estimated_ev_recomputation_requests.count({
        where: { organization_id: runtime.organizationId },
      }),
      1,
    );
    assert.equal(
      await runtime.database.source_delivery_occurrences.count({
        where: { organization_id: runtime.organizationId },
      }),
      occurrenceCountBefore,
    );
    const cursorAfter =
      await runtime.database.provider_source_cursors.findUniqueOrThrow({
        where: { source_instance_id: runtime.source.sourceInstanceId },
      });
    assert.deepEqual(
      {
        generation: cursorAfter.cursor_generation,
        fingerprint: cursorAfter.cursor_fingerprint,
      },
      {
        generation: cursorBefore.cursor_generation,
        fingerprint: cursorBefore.cursor_fingerprint,
      },
    );
    assert.equal(
      (await retries.retryOne(actor, quarantine.id)).outcome,
      "already_resolved",
    );
    assert.equal(
      (await retries.retryOne(
        { ...actor, organizationId: randomUUID() },
        quarantine.id,
      )).outcome,
      "not_found",
    );
    assert.equal(
      await runtime.database.quarantine_attempts.count({
        where: {
          organization_id: runtime.organizationId,
          quarantine_id: quarantine.id,
        },
      }),
      1,
    );

    const expired = await runtime.database.quarantine_records.findFirstOrThrow({
      where: {
        organization_id: runtime.organizationId,
        external_id: null,
      },
    });
    const futureFailed = await retries.retryOne(actor, expired.id);
    assert.equal(futureFailed.outcome, "failed");
    assert.equal(futureFailed.entry?.state, "open");
    const quarantineRepository = new ProviderSourceQuarantineRepository(
      runtime.database,
      actorKey,
    );
    const mismatchedAttemptId = randomUUID();
    const mismatchedClaim = await quarantineRepository.claimRetry({
      organizationId: runtime.organizationId,
      quarantineId: expired.id,
      attemptId: mismatchedAttemptId,
      actorKey: "operator-admin",
      claimedAt: callerTime,
    });
    assert.equal(mismatchedClaim.kind, "claimed");
    const mismatchedCompletion = await quarantineRepository.completeRetry({
      organizationId: runtime.organizationId,
      quarantineId: expired.id,
      attemptId: mismatchedAttemptId,
      actorKey: "operator-admin",
      provider: "phygitals",
      projections: [],
      completedAt: callerTime,
    });
    assert.equal(mismatchedCompletion.kind, "failed");
    assert.equal(
      (
        await runtime.database.quarantine_attempts.findUniqueOrThrow({
          where: { id: mismatchedAttemptId },
        })
      ).failure_code,
      "PROVIDER_SCOPE_MISMATCH",
    );
    const attemptsBeforeExpiry =
      await runtime.database.quarantine_attempts.count({
        where: { quarantine_id: expired.id },
      });
    assert.equal(attemptsBeforeExpiry, 2);
    const databaseTimeBeforeExpiry = await databaseNow(runtime.database);
    await runtime.database.quarantine_records.update({
      where: { id: expired.id },
      data: { expires_at: new Date(databaseTimeBeforeExpiry.getTime() - 1) },
    });
    callerTime = new Date("2000-01-01T00:00:00.000Z");
    const expiredResult = await retries.retryOne(actor, expired.id);
    assert.equal(expiredResult.outcome, "expired");
    const expiredStored = await runtime.database.quarantine_records.findUniqueOrThrow({
      where: { id: expired.id },
    });
    assert.equal(expiredStored.state, "expired");
    assert.equal(expiredStored.payload_json, null);
    assert.equal(
      await runtime.database.quarantine_attempts.count({
        where: { quarantine_id: expired.id },
      }),
      attemptsBeforeExpiry,
    );

    const originalInvalid = runtime.adapterResult.ok
      ? runtime.adapterResult.value.normalizedPage.outcomes.find(
          ({ status }) => status === "invalid",
        )
      : null;
    if (!originalInvalid || originalInvalid.status !== "invalid") {
      assert.fail("Invalid normalized outcome fixture unavailable.");
    }
    const interleavingPage = await capturedPageTurn(runtime, {
      pageNumber: 2,
      requestedValue: "cursor-a",
      nextValue: "cursor-b",
      outcomes: [
        {
          ...originalInvalid,
          recordIndex: 0,
        },
      ],
    });
    assert.equal(
      (await service(runtime).importPage(interleavingPage)).kind,
      "committed",
    );
    const interleavingQuarantine =
      await runtime.database.quarantine_records.findFirstOrThrow({
        where: { page_id: interleavingPage.pins.pageId },
      });
    const runningAttemptId = randomUUID();
    assert.equal(
      (
        await quarantineRepository.claimRetry({
          organizationId: runtime.organizationId,
          quarantineId: interleavingQuarantine.id,
          attemptId: runningAttemptId,
          actorKey: "operator-admin",
          claimedAt: callerTime,
        })
      ).kind,
      "claimed",
    );
    const expiryAt = await databaseNow(runtime.database);
    await runtime.database.quarantine_records.update({
      where: { id: interleavingQuarantine.id },
      data: { expires_at: new Date(expiryAt.getTime() - 1) },
    });
    const rejectedAttemptId = randomUUID();
    assert.equal(
      (
        await quarantineRepository.claimRetry({
          organizationId: runtime.organizationId,
          quarantineId: interleavingQuarantine.id,
          attemptId: rejectedAttemptId,
          actorKey: "operator-admin",
          claimedAt: callerTime,
        })
      ).kind,
      "expired",
    );
    const terminalizedAttempt =
      await runtime.database.quarantine_attempts.findUniqueOrThrow({
        where: { id: runningAttemptId },
      });
    assert.equal(terminalizedAttempt.state, "failed");
    assert.equal(terminalizedAttempt.failure_code, "SOURCE_EVIDENCE_EXPIRED");
    assert.notEqual(terminalizedAttempt.finished_at, null);
    assert.equal(
      await runtime.database.quarantine_attempts.count({
        where: { id: rejectedAttemptId },
      }),
      0,
    );
    assert.equal(
      (
        await quarantineRepository.completeRetry({
          organizationId: runtime.organizationId,
          quarantineId: interleavingQuarantine.id,
          attemptId: runningAttemptId,
          actorKey: "operator-admin",
          provider: "courtyard",
          projections: [],
          completedAt: callerTime,
        })
      ).kind,
      "not_found",
    );
  } finally {
    await runtime.close();
  }
});

test("same-provider page and quarantine writers serialize newer-first and same-content canonical collisions", async () => {
  for (const mode of ["newer_content", "same_content"] as const) {
    const runtime = await createRuntime(`canonical-race-${mode}`);
    try {
      const productionMappers =
        createProviderObservationMapperRegistryFromManifest();
      const quarantinePackResolver = {
        resolve(input: Parameters<typeof productionMappers.resolve>[0]) {
          const mapper = productionMappers.resolve(input);
          return {
            descriptor: mapper.descriptor,
            map(mappingInput: Parameters<typeof mapper.map>[0]) {
              if (
                mappingInput.observation.kind === "catalog" &&
                mappingInput.observation.providerRecordIdentity
                    .providerRecordId === "pack-1"
              ) {
                return {
                  status: "quarantined" as const,
                  reasonCode: "mapper_input_incompatible" as const,
                  warnings: [],
                  protectedNativeEvidenceRef:
                    mappingInput.observation.protectedNativeEvidenceRef,
                };
              }
              return mapper.map(mappingInput);
            },
          };
        },
      };
      await new ProviderSourcePageImportService(
        new ProviderSourcePagePlanner(quarantinePackResolver),
        runtime.guard,
        new ProviderSourcePageRepository(runtime.database, {
          actorPseudonymKey: actorKey,
        }),
      ).importPage({
        pins: runtime.pins,
        adapterResult: runtime.adapterResult,
        committedAt: await databaseNow(runtime.database),
      });
      const quarantine =
        await runtime.database.quarantine_records.findFirstOrThrow({
          where: {
            organization_id: runtime.organizationId,
            external_id: "pack-1",
          },
        });
      assert.equal(
        await runtime.database.canonical_entities.count({
          where: {
            organization_id: runtime.organizationId,
            record_kind: "pack",
            external_id: "pack-1",
          },
        }),
        0,
      );
      assert.equal(runtime.adapterResult.ok, true);
      if (!runtime.adapterResult.ok) assert.fail("captured page unavailable");
      const initial = runtime.adapterResult.value.normalizedPage.outcomes[0];
      if (
        initial?.status !== "valid" ||
        initial.observation.kind !== "catalog" ||
        initial.observation.entity !== "pack"
      ) {
        assert.fail("pack observation unavailable");
      }
      const newerPack = packObservation({
        ...initial.observation,
        effectiveAt: "2026-08-21T13:00:00.000Z",
        collectedAt: "2026-08-21T13:00:01.000Z",
        providerFacts: mode === "newer_content"
          ? {
              ...initial.observation.providerFacts,
              price: {
                state: "present",
                value: { amount: 11, currency: "USD" },
              },
            }
          : initial.observation.providerFacts,
      });
      const pageInput = await capturedPageTurn(runtime, {
        pageNumber: 2,
        requestedValue: "cursor-a",
        nextValue: "cursor-b",
        outcomes: [{
          status: "valid",
          recordIndex: 0,
          observation: newerPack,
        }],
      });
      const pageLocked = deferred();
      const releasePage = deferred();
      const pageImport = new ProviderSourcePageImportService(
        new ProviderSourcePagePlanner(productionMappers),
        runtime.guard,
        new ProviderSourcePageRepository(runtime.database, {
          actorPseudonymKey: actorKey,
          afterCanonicalIdentityLock: () => {
            pageLocked.resolve();
            return releasePage.promise;
          },
        }),
      );
      const pagePromise = pageImport.importPage(pageInput);
      await pageLocked.promise;

      const retry = new ProviderSourceQuarantineService({
        repository: new ProviderSourceQuarantineRepository(
          runtime.database,
          actorKey,
        ),
        mappers: productionMappers,
        actorKeyer: {
          keyFor: ({ organizationId, operatorId }) =>
            `actor:${organizationId}:${operatorId}`,
        },
        clock: { now: () => new Date("2099-01-01T00:00:00.000Z") },
        ids: { id: randomUUID },
      });
      const retryPromise = retry.retryOne({
        organizationId: runtime.organizationId,
        operatorId: randomUUID(),
        role: "data_operator",
      }, quarantine.id);
      await assertPending(retryPromise);
      releasePage.resolve();
      const [pageResult, retryResult] = await Promise.all([
        pagePromise,
        retryPromise,
      ]);
      assert.equal(pageResult.kind, "committed");
      assert.equal(retryResult.outcome, "resolved");

      const entity =
        await runtime.database.canonical_entities.findFirstOrThrow({
          where: {
            organization_id: runtime.organizationId,
            record_kind: "pack",
            external_id: "pack-1",
          },
        });
      const revisions = await runtime.database.canonical_revisions.findMany({
        where: { entity_id: entity.id },
        orderBy: { revision_number: "asc" },
      });
      assert.equal(revisions.length, mode === "newer_content" ? 2 : 1);
      assert.equal(entity.current_revision_id, revisions[0]?.id);
      assert.equal(
        (revisions[0]?.content_json as Record<string, unknown>)
          .priceValueMinor,
        mode === "newer_content" ? 1_100 : 1_000,
      );
      if (mode === "newer_content") {
        assert.equal(
          (revisions[1]?.content_json as Record<string, unknown>)
            .priceValueMinor,
          1_000,
        );
      }
      assert.equal(
        await runtime.database.estimated_ev_recomputation_requests.count({
          where: { organization_id: runtime.organizationId },
        }),
        1,
      );
    } finally {
      await runtime.close();
    }
  }
});

test("relationship target identities serialize concurrent source and target commits in both orders", async () => {
  for (const firstWriter of ["target_page", "relationship_retry"] as const) {
    const runtime = await createRuntime(`relationship-race-${firstWriter}`);
    try {
      const productionMappers =
        createProviderObservationMapperRegistryFromManifest();
      const quarantinePullResolver = {
        resolve(input: Parameters<typeof productionMappers.resolve>[0]) {
          const mapper = productionMappers.resolve(input);
          return {
            descriptor: mapper.descriptor,
            map(mappingInput: Parameters<typeof mapper.map>[0]) {
              if (mappingInput.observation.kind === "pull") {
                return {
                  status: "quarantined" as const,
                  reasonCode: "mapper_input_incompatible" as const,
                  warnings: [],
                  protectedNativeEvidenceRef:
                    mappingInput.observation.protectedNativeEvidenceRef,
                };
              }
              return mapper.map(mappingInput);
            },
          };
        },
      };
      await new ProviderSourcePageImportService(
        new ProviderSourcePagePlanner(quarantinePullResolver),
        runtime.guard,
        new ProviderSourcePageRepository(runtime.database, {
          actorPseudonymKey: actorKey,
        }),
      ).importPage({
        pins: runtime.pins,
        adapterResult: runtime.adapterResult,
        committedAt: await databaseNow(runtime.database),
      });
      const quarantine =
        await runtime.database.quarantine_records.findFirstOrThrow({
          where: {
            organization_id: runtime.organizationId,
            external_id: "pull-1",
          },
        });
      const targetPageInput = await capturedPageTurn(runtime, {
        pageNumber: 2,
        requestedValue: "cursor-a",
        nextValue: "cursor-b",
        outcomes: [
          {
            status: "valid",
            recordIndex: 0,
            observation: packObservation({
              providerRecordIdentity: {
                recordIdScopeKey: "catalog-pack-v1",
                providerRecordId: "shared-raw-id",
              },
              protectedNativeEvidenceRef: "evidence:target-pack",
            }),
          },
          {
            status: "valid",
            recordIndex: 1,
            observation: cardObservation({
              providerRecordIdentity: {
                recordIdScopeKey: "catalog-card-v1",
                providerRecordId: "shared-raw-id",
              },
              protectedNativeEvidenceRef: "evidence:target-card",
            }),
          },
        ],
      });
      const firstLocked = deferred();
      const releaseFirst = deferred();
      const pageImport = new ProviderSourcePageImportService(
        new ProviderSourcePagePlanner(productionMappers),
        runtime.guard,
        new ProviderSourcePageRepository(runtime.database, {
          actorPseudonymKey: actorKey,
          ...(firstWriter === "target_page"
            ? {
                afterCanonicalIdentityLock: () => {
                  firstLocked.resolve();
                  return releaseFirst.promise;
                },
              }
            : {}),
        }),
      );
      const retry = new ProviderSourceQuarantineService({
        repository: new ProviderSourceQuarantineRepository(
          runtime.database,
          actorKey,
          firstWriter === "relationship_retry"
            ? {
                afterCanonicalIdentityLock: () => {
                  firstLocked.resolve();
                  return releaseFirst.promise;
                },
              }
            : {},
        ),
        mappers: productionMappers,
        actorKeyer: {
          keyFor: ({ organizationId, operatorId }) =>
            `actor:${organizationId}:${operatorId}`,
        },
        clock: { now: () => new Date("2099-01-01T00:00:00.000Z") },
        ids: { id: randomUUID },
      });
      const actor = {
        organizationId: runtime.organizationId,
        operatorId: randomUUID(),
        role: "data_operator" as const,
      };
      if (firstWriter === "target_page") {
        const pagePromise = pageImport.importPage(targetPageInput);
        await firstLocked.promise;
        const retryPromise = retry.retryOne(actor, quarantine.id);
        await assertPending(retryPromise);
        releaseFirst.resolve();
        const [pageResult, retryResult] = await Promise.all([
          pagePromise,
          retryPromise,
        ]);
        assert.equal(pageResult.kind, "committed");
        assert.equal(retryResult.outcome, "resolved");
      } else {
        const retryPromise = retry.retryOne(actor, quarantine.id);
        await firstLocked.promise;
        const pagePromise = pageImport.importPage(targetPageInput);
        await assertPending(pagePromise);
        releaseFirst.resolve();
        const [retryResult, pageResult] = await Promise.all([
          retryPromise,
          pagePromise,
        ]);
        assert.equal(retryResult.outcome, "resolved");
        assert.equal(pageResult.kind, "committed");
      }

      const pull = await runtime.database.canonical_entities.findFirstOrThrow({
        where: {
          organization_id: runtime.organizationId,
          record_kind: "pull",
          external_id: "pull-1",
        },
      });
      const relationships =
        await runtime.database.canonical_relationships.findMany({
          where: { source_entity_id: pull.id },
          orderBy: { relationship_kind: "asc" },
        });
      assert.equal(relationships.length, 2);
      assert.deepEqual(
        relationships.map(({ relationship_kind, target_entity_id }) => ({
          relationshipKind: relationship_kind,
          resolved: target_entity_id !== null,
        })),
        [
          { relationshipKind: "card", resolved: true },
          { relationshipKind: "pack", resolved: true },
        ],
      );
    } finally {
      await runtime.close();
    }
  }
});

test("one run commits page two from its mutable turn while run-start lineage stays immutable", async () => {
  const runtime = await createRuntime("two-pages");
  try {
    const first = await service(runtime).importPage({
      pins: runtime.pins,
      adapterResult: runtime.adapterResult,
      committedAt: await databaseNow(runtime.database),
    });
    assert.equal(first.kind, "committed");
    const secondInput = await capturedPageTurn(runtime, {
      pageNumber: 2,
      requestedValue: "cursor-a",
      nextValue: "cursor-b",
    });
    const second = await service(runtime).importPage(secondInput);
    assert.equal(second.kind, "committed");
    assert.deepEqual(
      {
        inserted: second.counts.inserted,
        revised: second.counts.revised,
        duplicate: second.counts.duplicate,
        quarantined: second.counts.quarantined,
        canonicalRevisions: second.counts.canonicalRevisions,
        evRequests: second.counts.evRequests,
      },
      {
        inserted: 0,
        revised: 0,
        duplicate: 3,
        quarantined: 1,
        canonicalRevisions: 0,
        evRequests: 0,
      },
    );
    const run = await runtime.database.import_runs.findUniqueOrThrow({
      where: { id: runtime.pins.runId },
    });
    assert.equal(run.requested_cursor, null);
    assert.equal(run.requested_cursor_fingerprint, null);
    assert.equal(run.requested_cursor_key, "initial");
    assert.equal(run.current_cursor, "cursor-b");
    assert.equal(run.current_cursor_fingerprint, second.cursorFingerprint);
    assert.equal(run.next_page_number, 3);
    assert.equal(
      await runtime.database.import_pages.count({
        where: { run_id: runtime.pins.runId },
      }),
      2,
    );
    assert.equal(
      await runtime.database.source_semantic_observations.count({
        where: { organization_id: runtime.organizationId },
      }),
      3,
    );
    assert.equal(
      await runtime.database.source_delivery_occurrences.count({
        where: { run_id: runtime.pins.runId },
      }),
      8,
    );
    assert.equal(
      await runtime.database.canonical_revisions.count({
        where: { organization_id: runtime.organizationId },
      }),
      4,
    );
    assert.equal(
      await runtime.database.estimated_ev_recomputation_requests.count({
        where: { organization_id: runtime.organizationId },
      }),
      1,
    );
    const cycle = await capturedPageTurn(runtime, {
      pageNumber: 3,
      requestedValue: "cursor-b",
      nextValue: "cursor-a",
    });
    await assert.rejects(
      service(runtime).importPage(cycle),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "CURSOR_CYCLE_DETECTED",
    );
    assert.equal(
      await runtime.database.import_pages.count({
        where: { run_id: runtime.pins.runId },
      }),
      2,
    );
  } finally {
    await runtime.close();
  }
});

test("atomic lifecycle covers correction, time-only replay, A-B-A, immutable conflicts, identity quarantine, and relationship recovery", async () => {
  const runtime = await createRuntime("atomic-lifecycle-matrix");
  try {
    assert.equal(runtime.adapterResult.ok, true);
    if (!runtime.adapterResult.ok) assert.fail("Expected captured page.");
    const initialOutcomes = runtime.adapterResult.value.normalizedPage.outcomes;
    const initialPack = initialOutcomes[0]?.status === "valid"
      ? initialOutcomes[0].observation
      : null;
    const initialPull = initialOutcomes[2]?.status === "valid"
      ? initialOutcomes[2].observation
      : null;
    const initialTrade = initialOutcomes[3]?.status === "valid"
      ? initialOutcomes[3].observation
      : null;
    if (
      initialPack?.kind !== "catalog" || initialPack.entity !== "pack" ||
      initialPull?.kind !== "pull" || initialTrade?.kind !== "trade"
    ) {
      assert.fail("Lifecycle observations unavailable.");
    }
    await service(runtime).importPage({
      pins: runtime.pins,
      adapterResult: runtime.adapterResult,
      committedAt: await databaseNow(runtime.database),
    });

    const correctedPack = packObservation({
      ...initialPack,
      effectiveAt: "2026-08-21T12:00:00.000Z",
      collectedAt: "2026-08-21T12:00:01.000Z",
      providerFacts: {
        ...initialPack.providerFacts,
        price: {
          state: "present",
          value: { amount: 12, currency: "USD" },
        },
      },
    });
    const correction = await service(runtime).importPage(
      await capturedPageTurn(runtime, {
        pageNumber: 2,
        requestedValue: "cursor-a",
        nextValue: "cursor-b",
        outcomes: [{
          status: "valid",
          recordIndex: 0,
          observation: correctedPack,
        }],
      }),
    );
    assert.deepEqual(
      {
        revised: correction.counts.revised,
        canonicalRevisions: correction.counts.canonicalRevisions,
        evRequests: correction.counts.evRequests,
      },
      { revised: 1, canonicalRevisions: 1, evRequests: 1 },
    );

    const timeOnlyPack = packObservation({
      ...correctedPack,
      effectiveAt: "2026-08-21T13:00:00.000Z",
      collectedAt: "2026-08-21T13:00:01.000Z",
    });
    const timeOnly = await service(runtime).importPage(
      await capturedPageTurn(runtime, {
        pageNumber: 3,
        requestedValue: "cursor-b",
        nextValue: "cursor-c",
        outcomes: [{
          status: "valid",
          recordIndex: 0,
          observation: timeOnlyPack,
        }],
      }),
    );
    assert.deepEqual(
      {
        duplicate: timeOnly.counts.duplicate,
        canonicalRevisions: timeOnly.counts.canonicalRevisions,
        evRequests: timeOnly.counts.evRequests,
      },
      { duplicate: 1, canonicalRevisions: 0, evRequests: 0 },
    );

    const returnedToOriginalPack = packObservation({
      ...initialPack,
      effectiveAt: "2026-08-21T14:00:00.000Z",
      collectedAt: "2026-08-21T14:00:01.000Z",
    });
    const returned = await service(runtime).importPage(
      await capturedPageTurn(runtime, {
        pageNumber: 4,
        requestedValue: "cursor-c",
        nextValue: "cursor-d",
        outcomes: [{
          status: "valid",
          recordIndex: 0,
          observation: returnedToOriginalPack,
        }],
      }),
    );
    assert.deepEqual(
      {
        revised: returned.counts.revised,
        canonicalRevisions: returned.counts.canonicalRevisions,
        evRequests: returned.counts.evRequests,
      },
      { revised: 1, canonicalRevisions: 1, evRequests: 1 },
    );

    const changedPull = pullObservation({
      ...initialPull,
      effectiveAt: "2026-08-21T15:00:00.000Z",
      collectedAt: "2026-08-21T15:00:01.000Z",
      providerFacts: {
        ...initialPull.providerFacts,
        value: {
          state: "present",
          value: { amount: 50, currency: "USD" },
        },
      },
    });
    const pullConflict = await service(runtime).importPage(
      await capturedPageTurn(runtime, {
        pageNumber: 5,
        requestedValue: "cursor-d",
        nextValue: "cursor-e",
        outcomes: [{
          status: "valid",
          recordIndex: 0,
          observation: changedPull,
        }],
      }),
    );
    assert.deepEqual(
      {
        quarantined: pullConflict.counts.quarantined,
        canonicalRevisions: pullConflict.counts.canonicalRevisions,
        evRequests: pullConflict.counts.evRequests,
      },
      { quarantined: 1, canonicalRevisions: 0, evRequests: 0 },
    );

    const changedTrade = tradeObservation({
      ...initialTrade,
      effectiveAt: "2026-08-21T16:00:00.000Z",
      collectedAt: "2026-08-21T16:00:01.000Z",
      amount: 25,
      currency: "USD",
      paymentMethod: "card",
    });
    const tradeConflict = await service(runtime).importPage(
      await capturedPageTurn(runtime, {
        pageNumber: 6,
        requestedValue: "cursor-e",
        nextValue: "cursor-f",
        outcomes: [{
          status: "valid",
          recordIndex: 0,
          observation: changedTrade,
        }],
      }),
    );
    assert.equal(tradeConflict.counts.quarantined, 1);
    assert.equal(tradeConflict.counts.canonicalRevisions, 0);

    const identityLocal = await service(runtime).importPage(
      await capturedPageTurn(runtime, {
        pageNumber: 7,
        requestedValue: "cursor-f",
        nextValue: "cursor-g",
        outcomes: [
          {
            status: "invalid",
            recordIndex: 0,
            reasonCode: "identity_kind_conflict",
            fieldPaths: ["provider_record_identity.record_id_scope_key"],
            protectedNativeEvidenceRef: "evidence:identity-conflict",
          },
          {
            status: "valid",
            recordIndex: 1,
            observation: returnedToOriginalPack,
          },
        ],
      }),
    );
    assert.equal(identityLocal.counts.quarantined, 1);
    assert.equal(identityLocal.counts.duplicate, 1);

    const recoveredDependencies = [
      packObservation({
        providerRecordIdentity: {
          recordIdScopeKey: "catalog-pack-v1",
          providerRecordId: "shared-raw-id",
        },
        protectedNativeEvidenceRef: "evidence:recovery-pack",
      }),
      cardObservation({
        providerRecordIdentity: {
          recordIdScopeKey: "catalog-card-v1",
          providerRecordId: "shared-raw-id",
        },
        protectedNativeEvidenceRef: "evidence:recovery-card-shared",
      }),
      cardObservation({
        providerRecordIdentity: {
          recordIdScopeKey: "catalog-card-v1",
          providerRecordId: "card-1",
        },
        protectedNativeEvidenceRef: "evidence:recovery-card-one",
      }),
    ] as const;
    const recovered = await service(runtime).importPage(
      await capturedPageTurn(runtime, {
        pageNumber: 8,
        requestedValue: "cursor-g",
        nextValue: "cursor-h",
        outcomes: recoveredDependencies.map((observation, recordIndex) => ({
          status: "valid" as const,
          recordIndex,
          observation,
        })),
      }),
    );
    assert.equal(recovered.counts.inserted, 3);
    assert.equal(
      await runtime.database.canonical_relationships.count({
        where: {
          organization_id: runtime.organizationId,
          target_entity_id: null,
        },
      }),
      0,
    );
    const relationshipCount = await runtime.database.canonical_relationships.count({
      where: { organization_id: runtime.organizationId },
    });

    const recoveryReplay = await service(runtime).importPage(
      await capturedPageTurn(runtime, {
        pageNumber: 9,
        requestedValue: "cursor-h",
        nextValue: "cursor-i",
        outcomes: recoveredDependencies.map((observation, recordIndex) => ({
          status: "valid" as const,
          recordIndex,
          observation,
        })),
      }),
    );
    assert.equal(recoveryReplay.counts.duplicate, 3);
    assert.equal(
      await runtime.database.canonical_relationships.count({
        where: { organization_id: runtime.organizationId },
      }),
      relationshipCount,
    );
    assert.equal(
      await runtime.database.source_semantic_observations.count({
        where: { organization_id: runtime.organizationId },
      }),
      11,
    );
    assert.equal(
      await runtime.database.estimated_ev_recomputation_requests.count({
        where: { organization_id: runtime.organizationId },
      }),
      3,
    );
    assert.deepEqual(
      (
        await runtime.database.quarantine_records.findMany({
          where: { organization_id: runtime.organizationId },
          select: { reason_code: true },
        })
      ).map(({ reason_code }) => reason_code).sort(),
      [
        "identity_kind_conflict",
        "immutable_content_conflict",
        "immutable_content_conflict",
        "missing_identity",
      ],
    );
  } finally {
    await runtime.close();
  }
});

test("alternate source pins commit null-to-bookmark resume and reject adapter or source crossing", async () => {
  const firstBookmark = "alternate-bookmark-001";
  const secondBookmark = "alternate-bookmark-002";
  const firstPayload = alternateBookmarkWrapper(firstBookmark);
  const runtime = await createRuntime("alternate-resume", {
    sourceManifest: alternateBookmarkSourceManifest,
    initialNextCursorValue: firstBookmark,
    protectedRawResponseText: JSON.stringify(firstPayload),
  });
  try {
    assert.equal(runtime.pins.sourceTypeKey, "alternate-bookmark-v1");
    assert.equal(
      runtime.pins.sourceAdapterVersion,
      "alternate-bookmark-adapter-v1",
    );
    assert.equal(runtime.pins.requestedCursor.value, null);
    const firstRead = await completeAlternatePageRead(
      runtime,
      runtime.pins,
      firstPayload,
    );
    const first = await service(runtime).importPage({
      pins: firstRead.pins,
      adapterResult: firstRead.adapterResult,
      committedAt: await databaseNow(runtime.database),
    });
    assert.equal(first.kind, "committed");
    assert.deepEqual(first.counts, {
      inserted: 1,
      revised: 0,
      duplicate: 0,
      quarantined: 0,
      canonicalRevisions: 1,
      evRequests: 0,
      warnings: 0,
      unresolvedRelationships: 0,
    });
    assert.equal(
      (await runtime.database.provider_source_cursors.findUniqueOrThrow({
        where: { source_instance_id: runtime.source.sourceInstanceId },
      })).cursor,
      firstBookmark,
    );

    const secondPayload = alternateBookmarkWrapper(secondBookmark);
    const secondInput = await capturedPageTurn(runtime, {
      pageNumber: 2,
      requestedValue: firstBookmark,
      nextValue: secondBookmark,
      protectedRawResponseText: JSON.stringify(secondPayload),
    });
    const secondRead = await completeAlternatePageRead(
      runtime,
      secondInput.pins,
      secondPayload,
    );
    const second = await service(runtime).importPage({
      ...secondInput,
      pins: secondRead.pins,
      adapterResult: secondRead.adapterResult,
    });
    assert.equal(second.kind, "committed");
    assert.equal(second.counts.duplicate, 1);
    assert.equal(second.counts.canonicalRevisions, 0);
    const storedPages = await runtime.database.import_pages.findMany({
      where: { run_id: runtime.pins.runId },
      orderBy: { page_number: "asc" },
    });
    assert.equal(storedPages.length, 2);
    assert.deepEqual(
      storedPages.map(({ source_type_key, source_adapter_version }) => ({
        sourceTypeKey: source_type_key,
        adapterVersion: source_adapter_version,
      })),
      [1, 2].map(() => ({
        sourceTypeKey: alternateBookmarkSourceManifest.sourceTypeKey,
        adapterVersion: alternateBookmarkSourceManifest.adapterVersion,
      })),
    );
    const run = await runtime.database.import_runs.findUniqueOrThrow({
      where: { id: runtime.pins.runId },
    });
    assert.equal(run.current_cursor, secondBookmark);
    assert.equal(run.next_page_number, 3);

    const thirdInput = await capturedPageTurn(runtime, {
      pageNumber: 3,
      requestedValue: secondBookmark,
      nextValue: "alternate-bookmark-003",
    });
    const foreignSourceInstanceId = randomUUID();
    const foreignRequestedCursor = {
      ...thirdInput.pins.requestedCursor,
      sourceInstanceId: foreignSourceInstanceId,
    };
    const foreignSourceResult = await completeAuthenticPageReadForTest(
      {
        manifest: alternateBookmarkSourceManifest,
        pins: {
          operationKind: "page_read",
          requestAttemptId: randomUUID(),
          requestLeaseId: randomUUID(),
          organizationId: runtime.organizationId,
          sourceTypeKey: alternateBookmarkSourceManifest.sourceTypeKey,
          adapterVersion: alternateBookmarkSourceManifest.adapterVersion,
          singletonFencingEpoch: runtime.pins.singletonFencingEpoch,
          connectionProfileId: runtime.pins.connectionProfileId,
          connectionProfileRevisionId: runtime.pins.connectionRevisionId,
          connectionHealthGeneration: Number(
            runtime.pins.connectionHealthGeneration,
          ),
          provider: runtime.pins.provider,
          sourceInstanceId: foreignSourceInstanceId,
          sourceRevisionId: runtime.pins.sourceRevisionId,
          normalizedContractVersion: runtime.pins.normalizedContractVersion,
          identityNamespaceKey: runtime.pins.identityNamespaceKey,
          importRunId: runtime.pins.runId,
          runClaimLeaseId: runtime.pins.runClaimLeaseId,
          pageAttemptId: randomUUID(),
          pageNumber: 3,
          pageLimit: 250,
          cursorGeneration: Number(runtime.pins.cursorGeneration),
          requestedCursorFingerprint:
            runtime.guard.fingerprint(foreignRequestedCursor),
        },
        requestedCursor: foreignRequestedCursor,
        connectionConfiguration: { channel: "fixture" },
        sourceConfiguration: { partition: "courtyard" },
      },
      new AlternateBookmarkSourceAdapter(
        alternateBookmarkWrapper("alternate-bookmark-003"),
      ),
    );
    await assert.rejects(
      service(runtime).importPage({ ...thirdInput, adapterResult: foreignSourceResult }),
      (error: unknown) =>
        error instanceof ProviderSourcePageImportError &&
        error.code === "operation_scope_mismatch",
    );

    assert.equal(thirdInput.adapterResult.ok, true);
    if (!thirdInput.adapterResult.ok) assert.fail("third page fixture unavailable");
    const dataforrestRequestedCursor = {
      ...thirdInput.pins.requestedCursor,
      sourceTypeKey: dataforrestEventsV1SourceAdapterManifest.sourceTypeKey,
      adapterVersion: dataforrestEventsV1SourceAdapterManifest.adapterVersion,
      cursorCodecKey:
        dataforrestEventsV1SourceAdapterManifest.cursorCodecKey,
    };
    const dataforrestNextCursor = {
      ...dataforrestRequestedCursor,
      value: "dataforrest-cursor-003",
    };
    const dataforrestPage = normalizedProviderObservationPageSchema.parse({
      ...thirdInput.adapterResult.value.normalizedPage,
      nextCursor: dataforrestNextCursor,
    });
    const dataforrestRaw = new TextEncoder().encode("isolated-dataforrest-page");
    const foreignAdapterResult = await completeAuthenticPageReadForTest(
      {
        manifest: dataforrestEventsV1SourceAdapterManifest,
        pins: {
          operationKind: "page_read",
          requestAttemptId: randomUUID(),
          requestLeaseId: randomUUID(),
          organizationId: runtime.organizationId,
          sourceTypeKey: dataforrestEventsV1SourceAdapterManifest.sourceTypeKey,
          adapterVersion: dataforrestEventsV1SourceAdapterManifest.adapterVersion,
          singletonFencingEpoch: runtime.pins.singletonFencingEpoch,
          connectionProfileId: runtime.pins.connectionProfileId,
          connectionProfileRevisionId: runtime.pins.connectionRevisionId,
          connectionHealthGeneration: Number(
            runtime.pins.connectionHealthGeneration,
          ),
          provider: runtime.pins.provider,
          sourceInstanceId: runtime.pins.sourceInstanceId,
          sourceRevisionId: runtime.pins.sourceRevisionId,
          normalizedContractVersion: runtime.pins.normalizedContractVersion,
          identityNamespaceKey: runtime.pins.identityNamespaceKey,
          importRunId: runtime.pins.runId,
          runClaimLeaseId: runtime.pins.runClaimLeaseId,
          pageAttemptId: randomUUID(),
          pageNumber: 3,
          pageLimit: 250,
          cursorGeneration: Number(runtime.pins.cursorGeneration),
          requestedCursorFingerprint:
            runtime.guard.fingerprint(dataforrestRequestedCursor),
        },
        requestedCursor: dataforrestRequestedCursor,
        connectionConfiguration: { fixture: "protected" },
        sourceConfiguration: { platform: "courtyard" },
      },
      new StaticCapturedPageSourceAdapter(
        dataforrestEventsV1SourceAdapterManifest,
        {
          rawResponse: dataforrestRaw,
          protectedNativeEvidence:
            thirdInput.adapterResult.value.protectedNativeEvidence,
          normalizedPage: {
            ...dataforrestPage,
            measurements: {
              ...dataforrestPage.measurements,
              responseBytes: dataforrestRaw.byteLength,
            },
          },
        },
      ),
    );
    await assert.rejects(
      service(runtime).importPage({
        ...thirdInput,
        adapterResult: foreignAdapterResult,
      }),
      (error: unknown) =>
        error instanceof ProviderSourcePageImportError &&
        error.code === "operation_scope_mismatch",
    );
    assert.equal(
      await runtime.database.import_pages.count({
        where: { run_id: runtime.pins.runId },
      }),
      2,
    );
  } finally {
    await runtime.close();
  }
});

test("late catalog history grows canonical history without scheduling EV against unchanged current inputs", async () => {
  const runtime = await createRuntime("late-history-no-ev");
  try {
    await service(runtime).importPage({
      pins: runtime.pins,
      adapterResult: runtime.adapterResult,
      committedAt: await databaseNow(runtime.database),
    });
    await runtime.database.estimated_ev_recomputation_requests.deleteMany({
      where: { organization_id: runtime.organizationId },
    });
    const before = await runtime.database.canonical_revisions.count({
      where: { organization_id: runtime.organizationId },
    });
    const late = await capturedPageTurn(runtime, {
      pageNumber: 2,
      requestedValue: "cursor-a",
      nextValue: "cursor-b",
      pack: packObservation({
        effectiveAt: "2026-08-19T12:00:00.000Z",
        providerFacts: packFacts({
          price: { state: "present", value: { amount: 9, currency: "USD" } },
        }),
      }),
    });
    const result = await service(runtime).importPage(late);
    assert.equal(result.kind, "committed");
    assert.equal(result.counts.revised, 1);
    assert.equal(result.counts.canonicalRevisions, 1);
    assert.equal(result.counts.evRequests, 0);
    assert.equal(await runtime.database.canonical_revisions.count({
      where: { organization_id: runtime.organizationId },
    }), before + 1);
    assert.equal(await runtime.database.estimated_ev_recomputation_requests.count({
      where: { organization_id: runtime.organizationId },
    }), 0);
  } finally {
    await runtime.close();
  }
});

test("a continuation run resumes from the durable source cursor at its own page one", async () => {
  const runtime = await createRuntime("run-rollover");
  try {
    await service(runtime).importPage({
      pins: runtime.pins,
      adapterResult: runtime.adapterResult,
      committedAt: await databaseNow(runtime.database),
    });
    await runtime.database.import_runs.update({
      where: { id: runtime.pins.runId },
      data: {
        state: "succeeded",
        finished_at: await databaseNow(runtime.database),
      },
    });
    const rotatedConnectionRevisionId = randomUUID();
    const rotatedAt = await databaseNow(runtime.database);
    await runtime.database.$transaction(async (transaction) => {
      await transaction.source_connection_revisions.update({
        where: { id: runtime.pins.connectionRevisionId },
        data: {
          state: "retired",
          retired_at: rotatedAt,
        },
      });
      await transaction.source_connection_revisions.create({
        data: {
          id: rotatedConnectionRevisionId,
          organization_id: runtime.organizationId,
          connection_profile_id: runtime.pins.connectionProfileId,
          revision_number: 2,
          source_type_key: runtime.pins.sourceTypeKey,
          source_adapter_version: runtime.pins.sourceAdapterVersion,
          configuration_ciphertext: new Uint8Array(32).fill(31),
          configuration_nonce: new Uint8Array(12).fill(32),
          configuration_auth_tag: new Uint8Array(16).fill(33),
          encryption_key_version: 1,
          configuration_fingerprint: "9".repeat(64),
          state: "active",
          created_by_actor_key: "operator-admin",
          created_at: rotatedAt,
          activated_at: rotatedAt,
        },
      });
      await transaction.source_connection_profiles.update({
        where: { id: runtime.pins.connectionProfileId },
        data: {
          active_revision_id: rotatedConnectionRevisionId,
          updated_at: rotatedAt,
        },
      });
    });
    const requested = await new ProviderSourceImportRunRepository(
      runtime.database,
    ).requestRun({
      organizationId: runtime.organizationId,
      providerId: runtime.providerId,
      runId: randomUUID(),
      trigger: "continuation",
      requestedByActorKey: null,
      requestedAt: await databaseNow(runtime.database),
      expectedSourceRevisionId: runtime.source.sourceRevisionId,
    });
    assert.equal(requested.kind, "created");
    if (requested.kind !== "created") assert.fail("Expected rollover run.");
    const rollover = await runtime.database.import_runs.findUniqueOrThrow({
      where: { id: requested.run.id },
    });
    assert.equal(rollover.requested_cursor, "cursor-a");
    assert.equal(rollover.current_cursor, "cursor-a");
    assert.equal(
      rollover.connection_revision_id,
      rotatedConnectionRevisionId,
    );
    assert.equal(rollover.next_page_number, 1);

    const runClaimLeaseId = randomUUID();
    await runtime.database.import_runs.update({
      where: { id: requested.run.id },
      data: {
        state: "running",
        started_at: await databaseNow(runtime.database),
        lease_owner: runtime.pins.runLeaseOwner,
        lease_token: runtime.pins.runLeaseToken,
        claim_lease_id: runClaimLeaseId,
        lease_expires_at: (
          await runtime.database.source_supervisor_epochs.findUniqueOrThrow({
            where: { id: runtime.pins.supervisorEpochId },
          })
        ).lease_expires_at,
      },
    });
    const resumedRuntime = {
      ...runtime,
      pins: {
        ...runtime.pins,
        runId: requested.run.id,
        runTrigger: "continuation" as const,
        runClaimLeaseId,
        connectionRevisionId: rotatedConnectionRevisionId,
        connectionHealthGeneration: 0n,
      },
    };
    const resumedPage = await capturedPageTurn(resumedRuntime, {
      pageNumber: 1,
      requestedValue: "cursor-a",
      nextValue: "cursor-b",
    });
    const committed = await service(resumedRuntime).importPage(resumedPage);
    assert.equal(committed.kind, "committed");
    assert.equal(committed.counts.duplicate, 3);
    assert.equal(committed.counts.canonicalRevisions, 0);
    assert.equal(
      await runtime.database.source_semantic_observations.count({
        where: { organization_id: runtime.organizationId },
      }),
      3,
    );
    assert.equal(
      await runtime.database.source_delivery_occurrences.count({
        where: { organization_id: runtime.organizationId },
      }),
      8,
    );
    assert.equal(
      await runtime.database.estimated_ev_recomputation_requests.count({
        where: { organization_id: runtime.organizationId },
      }),
      1,
    );
    assert.equal(
      (
        await runtime.database.provider_source_cursors.findUniqueOrThrow({
          where: { source_instance_id: runtime.source.sourceInstanceId },
        })
      ).cursor_fingerprint,
      committed.cursorFingerprint,
    );
  } finally {
    await runtime.close();
  }
});

test("explicit sold-out authority survives mapper, canonical row, and public handoff", async () => {
  const runtime = await createRuntime("sold-out", { soldOut: true });
  try {
    await service(runtime).importPage({
      pins: runtime.pins,
      adapterResult: runtime.adapterResult,
      committedAt: await databaseNow(runtime.database),
    });
    const entity = await runtime.database.canonical_entities.findFirstOrThrow({
      where: {
        organization_id: runtime.organizationId,
        platform_key: "courtyard",
        record_kind: "pack",
        external_id: "pack-1",
      },
    });
    const revision = await runtime.database.canonical_revisions.findUniqueOrThrow({
      where: { id: entity.current_revision_id! },
    });
    const content = revision.content_json as Record<string, unknown>;
    assert.equal(content.availability, "sold_out");
    assert.deepEqual(content.availabilityProvenance, {
      kind: "explicit_authoritative_sold_out",
      authority: "provider_explicit_sold_out",
    });
    assert.equal(
      projectCanonicalPackAvailabilityV1({
        schemaVersion: PUBLIC_PACK_AVAILABILITY_INPUT_VERSION,
        publicRepackId: "00000000-0000-5000-8000-000000000301",
        publicVendorId: "00000000-0000-5000-8000-000000000001",
        vendorKey: "courtyard",
        availability: content.availability,
        availabilityProvenance: content.availabilityProvenance,
        sourceUpdatedAt: revision.source_updated_at.toISOString(),
      }).availability,
      "sold_out",
    );
  } finally {
    await runtime.close();
  }
});

test("failure immediately before cursor advancement rolls the complete page back", async () => {
  const runtime = await createRuntime("rollback");
  try {
    const runBefore = await runtime.database.import_runs.findUniqueOrThrow({
      where: { id: runtime.pins.runId },
      select: { counters_json: true },
    });
    await assert.rejects(
      service(runtime, () => {
        throw new Error("forced-before-cursor");
      }).importPage({
        pins: runtime.pins,
        adapterResult: runtime.adapterResult,
        committedAt: await databaseNow(runtime.database),
      }),
      /forced-before-cursor/u,
    );
    const runAfter = await runtime.database.import_runs.findUniqueOrThrow({
      where: { id: runtime.pins.runId },
      select: { counters_json: true },
    });
    assert.deepEqual(runAfter.counters_json, runBefore.counters_json);
    for (const count of await Promise.all([
      runtime.database.import_pages.count({ where: { run_id: runtime.pins.runId } }),
      runtime.database.source_delivery_occurrences.count({ where: { run_id: runtime.pins.runId } }),
      runtime.database.canonical_revisions.count({ where: { organization_id: runtime.organizationId } }),
      runtime.database.estimated_ev_recomputation_requests.count({ where: { organization_id: runtime.organizationId } }),
      runtime.database.quarantine_records.count({ where: { run_id: runtime.pins.runId } }),
      runtime.database.source_processor_diagnostic_events.count({
        where: { page_id: runtime.pins.pageId, safe_code: "PAGE_COMMITTED" },
      }),
    ])) assert.equal(count, 0);
    const cursor = await runtime.database.provider_source_cursors.findUniqueOrThrow({
      where: { source_instance_id: runtime.source.sourceInstanceId },
    });
    assert.equal(cursor.cursor_fingerprint, null);
  } finally {
    await runtime.close();
  }
});

test("EV enqueue failure rolls back page, observations, canonical writes, diagnostics, and cursor", async () => {
  const runtime = await createRuntime("ev-enqueue-rollback");
  try {
    const diagnosticsBefore =
      await runtime.database.source_processor_diagnostic_events.count();
    const runBefore = await runtime.database.import_runs.findUniqueOrThrow({
      where: { id: runtime.pins.runId },
      select: {
        counters_json: true,
        current_cursor: true,
        current_cursor_fingerprint: true,
        next_page_number: true,
      },
    });
    await runtime.database.$executeRawUnsafe(`
      create function task006_reject_ev_enqueue() returns trigger
      language plpgsql as $$
      begin
        raise exception 'task006_forced_ev_enqueue_failure';
      end;
      $$
    `);
    await runtime.database.$executeRawUnsafe(`
      create trigger task006_reject_ev_enqueue
      before insert on public.estimated_ev_recomputation_requests
      for each row execute function task006_reject_ev_enqueue()
    `);

    await assert.rejects(
      service(runtime).importPage({
        pins: runtime.pins,
        adapterResult: runtime.adapterResult,
        committedAt: await databaseNow(runtime.database),
      }),
      /task006_forced_ev_enqueue_failure/u,
    );

    assert.deepEqual(
      await Promise.all([
        runtime.database.import_pages.count(),
        runtime.database.source_record_identities.count(),
        runtime.database.source_semantic_observations.count(),
        runtime.database.source_delivery_occurrences.count(),
        runtime.database.canonical_entities.count(),
        runtime.database.canonical_revisions.count(),
        runtime.database.canonical_relationships.count(),
        runtime.database.quarantine_records.count(),
        runtime.database.estimated_ev_recomputation_requests.count(),
      ]),
      [0, 0, 0, 0, 0, 0, 0, 0, 0],
    );
    assert.equal(
      await runtime.database.source_processor_diagnostic_events.count(),
      diagnosticsBefore,
    );
    assert.equal(
      await runtime.database.source_processor_diagnostic_events.count({
        where: { page_id: runtime.pins.pageId, safe_code: "PAGE_COMMITTED" },
      }),
      0,
    );
    const [runAfter, cursor] = await Promise.all([
      runtime.database.import_runs.findUniqueOrThrow({
        where: { id: runtime.pins.runId },
        select: {
          counters_json: true,
          current_cursor: true,
          current_cursor_fingerprint: true,
          next_page_number: true,
        },
      }),
      runtime.database.provider_source_cursors.findUniqueOrThrow({
        where: { source_instance_id: runtime.source.sourceInstanceId },
      }),
    ]);
    assert.deepEqual(runAfter, runBefore);
    assert.equal(cursor.cursor, null);
    assert.equal(cursor.cursor_fingerprint, null);
  } finally {
    await runtime.close();
  }
});

test("concurrent exact replay commits one page and returns one idempotent replay", async () => {
  const runtime = await createRuntime("concurrent-exact-replay");
  try {
    const input = {
      pins: runtime.pins,
      adapterResult: runtime.adapterResult,
      committedAt: await databaseNow(runtime.database),
    };
    const results = await Promise.all([
      service(runtime).importPage(input),
      service(runtime).importPage(input),
    ]);
    assert.deepEqual(
      results.map(({ kind }) => kind).sort(),
      ["already_committed", "committed"],
    );
    assert.deepEqual(
      await Promise.all([
        runtime.database.import_pages.count({
          where: { run_id: runtime.pins.runId },
        }),
        runtime.database.source_delivery_occurrences.count({
          where: { run_id: runtime.pins.runId },
        }),
        runtime.database.source_semantic_observations.count({
          where: { organization_id: runtime.organizationId },
        }),
        runtime.database.canonical_revisions.count({
          where: { organization_id: runtime.organizationId },
        }),
        runtime.database.estimated_ev_recomputation_requests.count({
          where: { organization_id: runtime.organizationId },
        }),
        runtime.database.source_processor_diagnostic_events.count({
          where: { page_id: runtime.pins.pageId, safe_code: "PAGE_COMMITTED" },
        }),
      ]),
      [1, 4, 3, 4, 1, 1],
    );
  } finally {
    await runtime.close();
  }
});

test("concurrent platform commits isolate a mapper-failing lane from a healthy lane", async () => {
  const courtyard = await createRuntime("parallel-courtyard");
  try {
    const phygitals = await createRuntime("parallel-phygitals", {
      fixture: courtyard,
      organizationId: courtyard.organizationId,
      provider: "phygitals",
    });
    const productionMappers =
      createProviderObservationMapperRegistryFromManifest();
    const failingMapperResolver = {
      resolve(input) {
        const mapper = productionMappers.resolve(input);
        return {
          descriptor: mapper.descriptor,
          map() {
            throw new Error("isolated_mapper_failure");
          },
        };
      },
    } satisfies ProviderObservationMapperResolver;

    const [failedLane, healthyLane] = await Promise.all([
      service(courtyard, undefined, failingMapperResolver).importPage({
        pins: courtyard.pins,
        adapterResult: courtyard.adapterResult,
        committedAt: await databaseNow(courtyard.database),
      }),
      service(phygitals).importPage({
        pins: phygitals.pins,
        adapterResult: phygitals.adapterResult,
        committedAt: await databaseNow(phygitals.database),
      }),
    ]);
    assert.equal(failedLane.kind, "committed");
    assert.equal(failedLane.counts.quarantined, 4);
    assert.equal(failedLane.counts.canonicalRevisions, 0);
    assert.equal(healthyLane.kind, "committed");
    assert.equal(healthyLane.counts.quarantined, 1);
    assert.equal(healthyLane.counts.canonicalRevisions, 4);

    assert.deepEqual(
      (
        await courtyard.database.canonical_entities.findMany({
          where: { organization_id: courtyard.organizationId },
          select: { platform_key: true },
          distinct: ["platform_key"],
        })
      ).map(({ platform_key }) => platform_key),
      ["phygitals"],
    );
    assert.deepEqual(
      await Promise.all([
        courtyard.database.quarantine_records.count({
          where: { provider_id: courtyard.providerId },
        }),
        courtyard.database.quarantine_records.count({
          where: { provider_id: phygitals.providerId },
        }),
        courtyard.database.import_pages.count({
          where: { run_id: courtyard.pins.runId },
        }),
        courtyard.database.import_pages.count({
          where: { run_id: phygitals.pins.runId },
        }),
      ]),
      [4, 1, 1, 1],
    );
    const [
      courtyardCursor,
      phygitalsCursor,
      courtyardRun,
      phygitalsRun,
      courtyardPage,
      phygitalsPage,
      courtyardOccurrences,
      phygitalsOccurrences,
      pageDiagnostics,
    ] = await Promise.all([
      courtyard.database.provider_source_cursors.findUniqueOrThrow({
        where: { source_instance_id: courtyard.source.sourceInstanceId },
      }),
      courtyard.database.provider_source_cursors.findUniqueOrThrow({
        where: { source_instance_id: phygitals.source.sourceInstanceId },
      }),
      courtyard.database.import_runs.findUniqueOrThrow({
        where: { id: courtyard.pins.runId },
      }),
      courtyard.database.import_runs.findUniqueOrThrow({
        where: { id: phygitals.pins.runId },
      }),
      courtyard.database.import_pages.findUniqueOrThrow({
        where: { id: courtyard.pins.pageId },
      }),
      courtyard.database.import_pages.findUniqueOrThrow({
        where: { id: phygitals.pins.pageId },
      }),
      courtyard.database.source_delivery_occurrences.findMany({
        where: { run_id: courtyard.pins.runId },
      }),
      courtyard.database.source_delivery_occurrences.findMany({
        where: { run_id: phygitals.pins.runId },
      }),
      courtyard.database.source_processor_diagnostic_events.findMany({
        where: {
          safe_code: "PAGE_COMMITTED",
          run_id: { in: [courtyard.pins.runId, phygitals.pins.runId] },
        },
      }),
    ]);
    assert.equal(
      courtyardCursor.cursor_fingerprint,
      failedLane.cursorFingerprint,
    );
    assert.equal(
      phygitalsCursor.cursor_fingerprint,
      healthyLane.cursorFingerprint,
    );
    const lanes = [
      {
        runtime: courtyard,
        result: failedLane,
        run: courtyardRun,
        page: courtyardPage,
        occurrences: courtyardOccurrences,
      },
      {
        runtime: phygitals,
        result: healthyLane,
        run: phygitalsRun,
        page: phygitalsPage,
        occurrences: phygitalsOccurrences,
      },
    ] as const;
    for (const lane of lanes) {
      const counters = lane.run.counters_json;
      if (typeof counters !== "object" || counters === null ||
          Array.isArray(counters)) {
        assert.fail("Run counters unavailable.");
      }
      assert.deepEqual(
        Object.fromEntries(
          [
            "pages",
            "records",
            "catalog",
            "pulls",
            "trades",
            "inserted",
            "revised",
            "duplicate",
            "quarantined",
            "warnings",
            "unresolvedRelationships",
            "canonicalRevisions",
            "evRequests",
          ].map((key) => [key, (counters as Record<string, unknown>)[key]]),
        ),
        {
          pages: 1,
          records: 4,
          catalog: 1,
          pulls: 1,
          trades: 1,
          ...lane.result.counts,
        },
      );
      assert.deepEqual(
        {
          providerId: lane.run.provider_id,
          sourceInstanceId: lane.run.source_instance_id,
          sourceRevisionId: lane.run.source_revision_id,
          sourceTypeKey: lane.run.source_type_key,
          adapterVersion: lane.run.source_adapter_version,
          mapperKey: lane.run.mapper_key,
          mapperVersion: lane.run.mapper_version,
          connectionProfileId: lane.run.connection_profile_id,
          connectionRevisionId: lane.run.connection_revision_id,
          leaseOwner: lane.run.lease_owner,
          leaseToken: lane.run.lease_token,
          claimLeaseId: lane.run.claim_lease_id,
        },
        {
          providerId: lane.runtime.providerId,
          sourceInstanceId: lane.runtime.source.sourceInstanceId,
          sourceRevisionId: lane.runtime.source.sourceRevisionId,
          sourceTypeKey: lane.runtime.pins.sourceTypeKey,
          adapterVersion: lane.runtime.pins.sourceAdapterVersion,
          mapperKey: lane.runtime.pins.mapperKey,
          mapperVersion: lane.runtime.pins.mapperVersion,
          connectionProfileId: lane.runtime.pins.connectionProfileId,
          connectionRevisionId: lane.runtime.pins.connectionRevisionId,
          leaseOwner: lane.runtime.pins.runLeaseOwner,
          leaseToken: lane.runtime.pins.runLeaseToken,
          claimLeaseId: lane.runtime.pins.runClaimLeaseId,
        },
      );
      assert.deepEqual(
        {
          providerId: lane.page.provider_id,
          runId: lane.page.run_id,
          pageNumber: lane.page.page_number,
          sourceInstanceId: lane.page.source_instance_id,
          sourceRevisionId: lane.page.source_revision_id,
          connectionProfileId: lane.page.connection_profile_id,
          connectionRevisionId: lane.page.connection_revision_id,
          requestAttemptId: lane.page.request_attempt_id,
          runClaimLeaseId: lane.page.run_claim_lease_id,
        },
        {
          providerId: lane.runtime.providerId,
          runId: lane.runtime.pins.runId,
          pageNumber: 1,
          sourceInstanceId: lane.runtime.source.sourceInstanceId,
          sourceRevisionId: lane.runtime.source.sourceRevisionId,
          connectionProfileId: lane.runtime.pins.connectionProfileId,
          connectionRevisionId: lane.runtime.pins.connectionRevisionId,
          requestAttemptId: lane.runtime.pins.requestAttemptId,
          runClaimLeaseId: lane.runtime.pins.runClaimLeaseId,
        },
      );
      assert.equal(lane.occurrences.length, 4);
      for (const occurrence of lane.occurrences) {
        assert.deepEqual(
          {
            providerId: occurrence.provider_id,
            sourceInstanceId: occurrence.source_instance_id,
            sourceRevisionId: occurrence.source_revision_id,
            runId: occurrence.run_id,
            pageId: occurrence.page_id,
            requestAttemptId: occurrence.request_attempt_id,
            connectionProfileId: occurrence.connection_profile_id,
            connectionRevisionId: occurrence.connection_revision_id,
          },
          {
            providerId: lane.runtime.providerId,
            sourceInstanceId: lane.runtime.source.sourceInstanceId,
            sourceRevisionId: lane.runtime.source.sourceRevisionId,
            runId: lane.runtime.pins.runId,
            pageId: lane.runtime.pins.pageId,
            requestAttemptId: lane.runtime.pins.requestAttemptId,
            connectionProfileId: lane.runtime.pins.connectionProfileId,
            connectionRevisionId: lane.runtime.pins.connectionRevisionId,
          },
        );
      }
      const diagnostic = pageDiagnostics.find(
        ({ run_id }) => run_id === lane.runtime.pins.runId,
      );
      if (!diagnostic) assert.fail("Page diagnostic unavailable.");
      assert.deepEqual(
        {
          providerId: diagnostic.provider_id,
          sourceInstanceId: diagnostic.source_instance_id,
          sourceRevisionId: diagnostic.source_revision_id,
          runId: diagnostic.run_id,
          pageId: diagnostic.page_id,
          requestAttemptId: diagnostic.request_attempt_id,
          connectionProfileId: diagnostic.connection_profile_id,
          connectionRevisionId: diagnostic.connection_revision_id,
        },
        {
          providerId: lane.runtime.providerId,
          sourceInstanceId: lane.runtime.source.sourceInstanceId,
          sourceRevisionId: lane.runtime.source.sourceRevisionId,
          runId: lane.runtime.pins.runId,
          pageId: lane.runtime.pins.pageId,
          requestAttemptId: lane.runtime.pins.requestAttemptId,
          connectionProfileId: lane.runtime.pins.connectionProfileId,
          connectionRevisionId: lane.runtime.pins.connectionRevisionId,
        },
      );
    }
    assert.equal(pageDiagnostics.length, 2);
  } finally {
    await courtyard.close();
  }
});

test("a captured attempt cannot authorize different protected response bytes", async () => {
  const runtime = await createRuntime("capture-binding");
  try {
    assert.equal(runtime.adapterResult.ok, true);
    if (!runtime.adapterResult.ok) assert.fail("Expected captured page.");
    const tampered = runtime.adapterResult.value.requestCapture
      .protectedRawResponse;
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
    await assert.rejects(
      service(runtime).importPage({
        pins: runtime.pins,
        adapterResult: runtime.adapterResult,
        committedAt: await databaseNow(runtime.database),
      }),
      (error: unknown) =>
        error instanceof ProviderSourcePageImportError &&
        error.code === "captured_page_invalid",
    );
    assert.equal(
      await runtime.database.import_pages.count({
        where: { run_id: runtime.pins.runId },
      }),
      0,
    );
  } finally {
    await runtime.close();
  }
});

test("exact replay rejects changed normalized effects or protected retry evidence for the same raw receipt", async () => {
  const runtime = await createRuntime("exact-commit-digest");
  try {
    assert.equal(runtime.adapterResult.ok, true);
    if (!runtime.adapterResult.ok) assert.fail("captured fixture unavailable");
    await service(runtime).importPage({
      pins: runtime.pins,
      adapterResult: runtime.adapterResult,
      committedAt: await databaseNow(runtime.database),
    });
    await assert.rejects(
      runtime.database.$executeRaw`
        UPDATE "import_pages"
        SET "normalized_commit_hash" = NULL
        WHERE "id" = ${runtime.pins.pageId}::uuid
      `,
      /import_pages_normalized_commit_hash_check/u,
    );
    const operationPins = {
      operationKind: "page_read" as const,
      requestAttemptId: runtime.pins.requestAttemptId,
      requestLeaseId: runtime.pins.requestLeaseId,
      organizationId: runtime.organizationId,
      sourceTypeKey: runtime.pins.sourceTypeKey,
      adapterVersion: runtime.pins.sourceAdapterVersion,
      singletonFencingEpoch: runtime.pins.singletonFencingEpoch,
      connectionProfileId: runtime.pins.connectionProfileId,
      connectionProfileRevisionId: runtime.pins.connectionRevisionId,
      connectionHealthGeneration: Number(runtime.pins.connectionHealthGeneration),
      provider: runtime.pins.provider,
      sourceInstanceId: runtime.pins.sourceInstanceId,
      sourceRevisionId: runtime.pins.sourceRevisionId,
      normalizedContractVersion: runtime.pins.normalizedContractVersion,
      identityNamespaceKey: runtime.pins.identityNamespaceKey,
      importRunId: runtime.pins.runId,
      runClaimLeaseId: runtime.pins.runClaimLeaseId,
      pageAttemptId: runtime.pins.pageId,
      pageNumber: runtime.pins.pageNumber,
      pageLimit: 250,
      cursorGeneration: Number(runtime.pins.cursorGeneration),
      requestedCursorFingerprint: runtime.pins.requestedCursorFingerprint,
    };
    const raw = runtime.adapterResult.value.requestCapture.protectedRawResponse;
    const changedPage = normalizedProviderObservationPageSchema.parse({
      ...runtime.adapterResult.value.normalizedPage,
      outcomes: runtime.adapterResult.value.normalizedPage.outcomes.map(
        (outcome, index) =>
          index === 0 && outcome.status === "valid"
            ? {
                ...outcome,
                observation: packObservation({
                  providerFacts: packFacts({
                    price: {
                      state: "present",
                      value: { amount: 99, currency: "USD" },
                    },
                  }),
                }),
              }
            : outcome,
      ),
    });
    const changedPlanResult = await completeAuthenticPageReadForTest(
      {
        manifest: runtime.manifest,
        pins: operationPins,
        requestedCursor: runtime.pins.requestedCursor,
        connectionConfiguration: { fixture: "protected" },
        sourceConfiguration: { platform: runtime.pins.provider },
      },
      new StaticCapturedPageSourceAdapter(runtime.manifest, {
        rawResponse: raw,
        protectedNativeEvidence:
          runtime.adapterResult.value.protectedNativeEvidence,
        normalizedPage: changedPage,
      }),
    );
    await assert.rejects(
      service(runtime).importPage({
        pins: runtime.pins,
        adapterResult: changedPlanResult,
        committedAt: await databaseNow(runtime.database),
      }),
      (error: unknown) =>
        error instanceof ProviderSourceAtomicPagePersistenceError &&
        error.code === "idempotency_conflict",
    );

    const changedEvidence = runtime.adapterResult.value.protectedNativeEvidence.map(
      (item, index) => index === 0
        ? { ...item, value: { ...item.value, retryEvidenceVersion: 2 } }
        : item,
    );
    const changedEvidenceResult = await completeAuthenticPageReadForTest(
      {
        manifest: runtime.manifest,
        pins: operationPins,
        requestedCursor: runtime.pins.requestedCursor,
        connectionConfiguration: { fixture: "protected" },
        sourceConfiguration: { platform: runtime.pins.provider },
      },
      new StaticCapturedPageSourceAdapter(runtime.manifest, {
        rawResponse: raw,
        protectedNativeEvidence: changedEvidence,
        normalizedPage: runtime.adapterResult.value.normalizedPage,
      }),
    );
    await assert.rejects(
      service(runtime).importPage({
        pins: runtime.pins,
        adapterResult: changedEvidenceResult,
        committedAt: await databaseNow(runtime.database),
      }),
      (error: unknown) =>
        error instanceof ProviderSourceAtomicPagePersistenceError &&
        error.code === "idempotency_conflict",
    );
  } finally {
    await runtime.close();
  }
});

test("nonterminal, failed, and wrong-page durable attempts cannot authorize a page commit", async () => {
  for (const requestProof of ["in_flight", "failed", "wrong_page"] as const) {
    const runtime = await createRuntime(`attempt-${requestProof}`, {
      requestProof,
    });
    try {
      await assert.rejects(
        service(runtime).importPage({
          pins: runtime.pins,
          adapterResult: runtime.adapterResult,
          committedAt: await databaseNow(runtime.database),
        }),
        (error: unknown) =>
          error instanceof PersistenceError && error.code === "SOURCE_FENCED",
      );
      assert.equal(await runtime.database.import_pages.count({
        where: { run_id: runtime.pins.runId },
      }), 0);
      assert.equal(await runtime.database.source_delivery_occurrences.count({
        where: { run_id: runtime.pins.runId },
      }), 0);
    } finally {
      await runtime.close();
    }
  }
});

test("pause requested during the captured page lets that page finish and pauses at its boundary", async () => {
  const runtime = await createRuntime("pause-boundary");
  try {
    const pause = await new ProviderSourceAdminLifecycleRepository(
      runtime.database,
    ).requestPause({
      organizationId: runtime.organizationId,
      providerId: runtime.providerId,
      sourceInstanceId: runtime.source.sourceInstanceId,
      expectedSourceRevisionId: runtime.source.sourceRevisionId,
      actorKey: "operator-admin",
      requestedAt: await databaseNow(runtime.database),
    });
    assert.equal(pause.state, "pause_requested");
    const result = await service(runtime).importPage({
      pins: runtime.pins,
      adapterResult: runtime.adapterResult,
      committedAt: await databaseNow(runtime.database),
    });
    assert.equal(result.kind, "committed");
    const source = await runtime.database.provider_source_instances.findUniqueOrThrow({
      where: { id: runtime.source.sourceInstanceId },
    });
    assert.equal(source.state, "paused");
    assert.equal(source.pause_requested_at, null);
  } finally {
    await runtime.close();
  }
});

test("epoch fencing that wins the DB barrier rejects the captured page atomically", async () => {
  const runtime = await createRuntime("epoch-barrier");
  const independent = await runtime.createIndependentClient();
  const locked = deferred();
  const release = deferred();
  try {
    const fencing = independent.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        select id from public.source_supervisor_epochs
        where id = ${runtime.pins.supervisorEpochId}::uuid
        for update
      `;
      await transaction.source_supervisor_epochs.update({
        where: { id: runtime.pins.supervisorEpochId },
        data: {
          state: "fenced_draining",
          fenced_at: await databaseNow(independent),
          safe_reason_code: "TEST_FENCE",
        },
      });
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const importing = service(runtime).importPage({
      pins: runtime.pins,
      adapterResult: runtime.adapterResult,
      committedAt: await databaseNow(runtime.database),
    });
    await assertPending(importing);
    release.resolve();
    await fencing;
    await assert.rejects(
      importing,
      (error: unknown) =>
        error instanceof PersistenceError && error.code === "SOURCE_FENCED",
    );
    assert.equal(
      await runtime.database.import_pages.count({
        where: { run_id: runtime.pins.runId },
      }),
      0,
    );
  } finally {
    release.resolve();
    await independent.$disconnect();
    await runtime.close();
  }
});

test("blocking health transition that wins the profile barrier rejects every page write", async () => {
  const runtime = await createRuntime("health-barrier");
  const independent = await runtime.createIndependentClient();
  const locked = deferred();
  const release = deferred();
  try {
    const blocking = independent.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        select id from public.source_connection_profiles
        where id = ${runtime.pins.connectionProfileId}::uuid
        for update
      `;
      await transaction.source_connection_revisions.update({
        where: { id: runtime.pins.connectionRevisionId },
        data: { health_generation: 1n },
      });
      const episode = await transaction.source_connection_health_episodes.create({
        data: {
          organization_id: runtime.organizationId,
          connection_profile_id: runtime.pins.connectionProfileId,
          connection_revision_id: runtime.pins.connectionRevisionId,
          opened_health_generation: 1n,
          failure_class: "authentication_failed",
          safe_code: "authentication_failed",
          opened_at: await databaseNow(independent),
        },
      });
      const failedAttemptId = randomUUID();
      await transaction.compact_source_request_attempts.create({
        data: {
          request_attempt_id: failedAttemptId,
          organization_id: runtime.organizationId,
          operation_kind: "page_read",
          terminal_state: "failed",
          outcome_class: "authentication_failed",
          safe_outcome_hash: "d".repeat(64),
          request_lease_id: randomUUID(),
          claim_owner: runtime.pins.runLeaseOwner,
          claim_token: runtime.pins.runLeaseToken,
          supervisor_epoch_id: runtime.pins.supervisorEpochId,
          connection_profile_id: runtime.pins.connectionProfileId,
          connection_revision_id: runtime.pins.connectionRevisionId,
          expected_health_generation: 0n,
          provider_id: runtime.providerId,
          source_instance_id: runtime.source.sourceInstanceId,
          source_revision_id: runtime.source.sourceRevisionId,
          run_id: runtime.pins.runId,
          page_number: 2,
          cursor_generation: 1n,
          requested_cursor_key: "initial",
          blocking_episode_id: episode.id,
          blocking_episode_connection_revision_id:
            runtime.pins.connectionRevisionId,
          started_at: await databaseNow(independent),
          terminal_at: await databaseNow(independent),
        },
      });
      await transaction.source_connection_health_episodes.update({
        where: { id: episode.id },
        data: { opened_by_request_attempt_id: failedAttemptId },
      });
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const importing = service(runtime).importPage({
      pins: runtime.pins,
      adapterResult: runtime.adapterResult,
      committedAt: await databaseNow(runtime.database),
    });
    await assertPending(importing);
    release.resolve();
    await blocking;
    await assert.rejects(
      importing,
      (error: unknown) =>
        error instanceof PersistenceError && error.code === "SOURCE_FENCED",
    );
    assert.equal(
      await runtime.database.import_pages.count({
        where: { run_id: runtime.pins.runId },
      }),
      0,
    );
  } finally {
    release.resolve();
    await independent.$disconnect();
    await runtime.close();
  }
});

test("an open profile episode fences every revision until explicit recovery closes it", async () => {
  const runtime = await createRuntime("revision-episode-isolation", {
    withRetiredConnectionPredecessor: true,
  });
  try {
    assert.ok(runtime.retiredConnectionRevisionId);
    assert.equal(runtime.adapterResult.ok, true);
    if (!runtime.adapterResult.ok || !runtime.retiredConnectionRevisionId) {
      throw new Error("revision-isolation fixture unavailable");
    }
    const oldJobId = randomUUID();
    const oldAttemptId = randomUUID();
    let oldEpisodeId = "";
    const supervisorRow =
      await runtime.database.source_supervisor_epochs.findUniqueOrThrow({
        where: { id: runtime.pins.supervisorEpochId },
      });
    await runtime.database.source_connection_test_jobs.create({
      data: {
        id: oldJobId,
        organization_id: runtime.organizationId,
        connection_profile_id: runtime.pins.connectionProfileId,
        connection_revision_id: runtime.retiredConnectionRevisionId,
        expected_health_generation: 0n,
        state: "failed",
        requested_by_actor_key: "operator-admin",
        claim_owner: runtime.pins.runLeaseOwner,
        claim_token: runtime.pins.runLeaseToken,
        claim_expires_at: supervisorRow.lease_expires_at,
        supervisor_epoch_id: runtime.pins.supervisorEpochId,
        started_at: await databaseNow(runtime.database),
        finished_at: await databaseNow(runtime.database),
      },
    });
    await runtime.database.$transaction(async (transaction) => {
      await transaction.source_connection_revisions.update({
        where: { id: runtime.retiredConnectionRevisionId! },
        data: { health_generation: 1n },
      });
      const episode = await transaction.source_connection_health_episodes.create({
        data: {
          organization_id: runtime.organizationId,
          connection_profile_id: runtime.pins.connectionProfileId,
          connection_revision_id: runtime.retiredConnectionRevisionId!,
          opened_health_generation: 1n,
          failure_class: "authentication_failed",
          safe_code: "authentication_failed",
          opened_at: await databaseNow(runtime.database),
        },
      });
      oldEpisodeId = episode.id;
      await transaction.compact_source_request_attempts.create({
        data: {
          request_attempt_id: oldAttemptId,
          organization_id: runtime.organizationId,
          operation_kind: "connection_test",
          terminal_state: "failed",
          outcome_class: "authentication_failed",
          safe_outcome_hash: "e".repeat(64),
          request_lease_id: randomUUID(),
          claim_owner: runtime.pins.runLeaseOwner,
          claim_token: runtime.pins.runLeaseToken,
          supervisor_epoch_id: runtime.pins.supervisorEpochId,
          connection_profile_id: runtime.pins.connectionProfileId,
          connection_revision_id: runtime.retiredConnectionRevisionId!,
          expected_health_generation: 0n,
          connection_test_job_id: oldJobId,
          blocking_episode_id: episode.id,
          blocking_episode_connection_revision_id:
            runtime.retiredConnectionRevisionId!,
          started_at: await databaseNow(runtime.database),
          terminal_at: await databaseNow(runtime.database),
        },
      });
      await transaction.source_connection_health_episodes.update({
        where: { id: episode.id },
        data: { opened_by_request_attempt_id: oldAttemptId },
      });
    });

    const requests = new ProviderSourceRequestRepository(runtime.database);
    await assert.rejects(
      requests.begin({
        organizationId: runtime.organizationId,
        requestLeaseId: randomUUID(),
        claimOwner: runtime.pins.runLeaseOwner,
        claimToken: runtime.pins.runLeaseToken,
        supervisorEpochId: runtime.pins.supervisorEpochId,
        supervisorOwnerKey: runtime.pins.supervisorOwnerKey,
        supervisorLeaseToken: runtime.pins.supervisorLeaseToken,
        connectionProfileId: runtime.pins.connectionProfileId,
        connectionRevisionId: runtime.pins.connectionRevisionId,
        expectedHealthGeneration: runtime.pins.connectionHealthGeneration,
        operation: {
          kind: "page_read",
          providerId: runtime.providerId,
          sourceInstanceId: runtime.source.sourceInstanceId,
          sourceRevisionId: runtime.source.sourceRevisionId,
          runId: runtime.pins.runId,
          pageNumber: runtime.pins.pageNumber,
          cursorGeneration: runtime.pins.cursorGeneration,
          requestedCursorFingerprint: null,
        },
        startedAt: await databaseNow(runtime.database),
      }),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === "CONNECTION_BLOCKED",
    );
    assert.equal(await runtime.database.import_pages.count({
      where: { run_id: runtime.pins.runId },
    }), 0);
    await assert.rejects(
      requests.begin({
        organizationId: runtime.organizationId,
        requestLeaseId: randomUUID(),
        claimOwner: runtime.pins.runLeaseOwner,
        claimToken: runtime.pins.runLeaseToken,
        supervisorEpochId: runtime.pins.supervisorEpochId,
        supervisorOwnerKey: runtime.pins.supervisorOwnerKey,
        supervisorLeaseToken: runtime.pins.supervisorLeaseToken,
        connectionProfileId: runtime.pins.connectionProfileId,
        connectionRevisionId: runtime.retiredConnectionRevisionId,
        expectedHealthGeneration: 1n,
        operation: {
          kind: "page_read",
          providerId: runtime.providerId,
          sourceInstanceId: runtime.source.sourceInstanceId,
          sourceRevisionId: runtime.source.sourceRevisionId,
          runId: randomUUID(),
          pageNumber: 1,
          cursorGeneration: runtime.pins.cursorGeneration,
          requestedCursorFingerprint: null,
        },
        startedAt: await databaseNow(runtime.database),
      }),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === "CONNECTION_BLOCKED",
    );

    const recovery = new SourceConnectionRecoveryRepository(runtime.database);
    const recoveryCandidateRevisionId = randomUUID();
    await recovery.addRecoveryConnectionRevision({
      organizationId: runtime.organizationId,
      connectionProfileId: runtime.pins.connectionProfileId,
      blockedRevisionId: runtime.retiredConnectionRevisionId,
      latestRevisionId: runtime.pins.connectionRevisionId,
      blockingEpisodeId: oldEpisodeId,
      revisionId: recoveryCandidateRevisionId,
      revisionNumber: 3,
      sourceTypeKey: runtime.pins.sourceTypeKey,
      sourceAdapterVersion: runtime.pins.sourceAdapterVersion,
      encryptedConfiguration: {
        ciphertext: new Uint8Array(32).fill(7),
        nonce: new Uint8Array(12).fill(8),
        authTag: new Uint8Array(16).fill(9),
        keyVersion: 1,
      },
      configurationFingerprint: "7".repeat(64),
      actorKey: "operator-admin",
      createdAt: await databaseNow(runtime.database),
    });
    const recoveryJob = await recovery.requestConnectionRecoveryTest({
      organizationId: runtime.organizationId,
      connectionProfileId: runtime.pins.connectionProfileId,
      connectionRevisionId: recoveryCandidateRevisionId,
      expectedHealthGeneration: 0n,
      blockedRevisionId: runtime.retiredConnectionRevisionId,
      blockingEpisodeId: oldEpisodeId,
      requestedByActorKey: "operator-admin",
      requestedAt: await databaseNow(runtime.database),
    });
    const recoveryClaimToken = randomUUID();
    await runtime.database.source_connection_test_jobs.update({
      where: { id: recoveryJob.jobId },
      data: {
        state: "running",
        claim_owner: runtime.pins.runLeaseOwner,
        claim_token: recoveryClaimToken,
        claim_expires_at: supervisorRow.lease_expires_at,
        supervisor_epoch_id: runtime.pins.supervisorEpochId,
        started_at: await databaseNow(runtime.database),
      },
    });
    const recoveryAttemptId = await requests.begin({
      organizationId: runtime.organizationId,
      requestLeaseId: randomUUID(),
      claimOwner: runtime.pins.runLeaseOwner,
      claimToken: recoveryClaimToken,
      supervisorEpochId: runtime.pins.supervisorEpochId,
      supervisorOwnerKey: runtime.pins.supervisorOwnerKey,
      supervisorLeaseToken: runtime.pins.supervisorLeaseToken,
      connectionProfileId: runtime.pins.connectionProfileId,
      connectionRevisionId: recoveryCandidateRevisionId,
      expectedHealthGeneration: 0n,
      operation: {
        kind: "connection_test",
        connectionTestJobId: recoveryJob.jobId,
        blockingEpisodeId: oldEpisodeId,
      },
      startedAt: await databaseNow(runtime.database),
    });
    await requests.terminalize({
      organizationId: runtime.organizationId,
      requestAttemptId: recoveryAttemptId,
      supervisorEpochId: runtime.pins.supervisorEpochId,
      supervisorOwnerKey: runtime.pins.supervisorOwnerKey,
      supervisorLeaseToken: runtime.pins.supervisorLeaseToken,
      state: "captured",
      outcomeClass: "response_captured",
      safeCode: "request_captured",
      safeOutcomeHash: "f".repeat(64),
      terminalAt: await databaseNow(runtime.database),
    });
    await new ProviderSourceTestResultRepository(
      runtime.database,
    ).completeConnectionTest({
      organizationId: runtime.organizationId,
      jobId: recoveryJob.jobId,
      requestAttemptId: recoveryAttemptId,
      claimOwner: runtime.pins.runLeaseOwner,
      claimToken: recoveryClaimToken,
      supervisorEpochId: runtime.pins.supervisorEpochId,
      supervisorOwnerKey: runtime.pins.supervisorOwnerKey,
      supervisorLeaseToken: runtime.pins.supervisorLeaseToken,
      outcome: "success",
      safeCode: "new_revision_healthy",
      completedAt: await databaseNow(runtime.database),
    });
    await runtime.database.import_runs.update({
      where: { id: runtime.pins.runId },
      data: {
        state: "succeeded",
        finished_at: await databaseNow(runtime.database),
      },
    });
    const activation = {
      organizationId: runtime.organizationId,
      connectionProfileId: runtime.pins.connectionProfileId,
      connectionRevisionId: recoveryCandidateRevisionId,
      expectedHealthGeneration: 0n,
      blockedRevisionId: runtime.retiredConnectionRevisionId,
      blockingEpisodeId: oldEpisodeId,
      actorKey: "operator-admin",
      activatedAt: await databaseNow(runtime.database),
    } as const;
    const [stillOpen, stillActiveProfile, recoveryRunCount] = await Promise.all([
      runtime.database.source_connection_health_episodes.findUniqueOrThrow({
        where: { id: oldEpisodeId },
      }),
      runtime.database.source_connection_profiles.findUniqueOrThrow({
        where: { id: runtime.pins.connectionProfileId },
      }),
      runtime.database.import_runs.count({
        where: {
          organization_id: runtime.organizationId,
          source_instance_id: runtime.source.sourceInstanceId,
          trigger: "recovery",
        },
      }),
    ]);
    assert.equal(stillOpen.closed_at, null);
    assert.equal(
      stillActiveProfile.active_revision_id,
      runtime.pins.connectionRevisionId,
    );
    assert.equal(recoveryRunCount, 0);
    await recovery.activateTestedConnectionRecovery({
      ...activation,
      activatedAt: await databaseNow(runtime.database),
    });
    const [closedEpisode, retiredRevision, profile, cursor, recoveryRuns] =
      await Promise.all([
      runtime.database.source_connection_health_episodes.findUniqueOrThrow({
        where: { id: oldEpisodeId },
      }),
      runtime.database.source_connection_revisions.findUniqueOrThrow({
        where: { id: runtime.retiredConnectionRevisionId },
      }),
      runtime.database.source_connection_profiles.findUniqueOrThrow({
        where: { id: runtime.pins.connectionProfileId },
      }),
      runtime.database.provider_source_cursors.findUniqueOrThrow({
        where: { source_instance_id: runtime.source.sourceInstanceId },
      }),
      runtime.database.import_runs.findMany({
        where: {
          organization_id: runtime.organizationId,
          source_instance_id: runtime.source.sourceInstanceId,
          trigger: "recovery",
        },
      }),
    ]);
    assert.ok(closedEpisode.closed_at);
    assert.equal(retiredRevision.health_generation, 2n);
    assert.equal(profile.state, "active");
    assert.equal(profile.active_revision_id, recoveryCandidateRevisionId);
    assert.equal(recoveryRuns.length, 1);
    assert.equal(recoveryRuns[0]!.connection_revision_id, recoveryCandidateRevisionId);
    assert.equal(recoveryRuns[0]!.cursor_generation, cursor.cursor_generation);
    assert.equal(
      recoveryRuns[0]!.requested_cursor_fingerprint,
      cursor.cursor_fingerprint,
    );
    assert.deepEqual(
      recoveryRuns[0]!.requested_cursor,
      cursor.cursor,
    );
  } finally {
    await runtime.close();
  }
});

test("pause request that wins the source barrier still commits the captured page boundary", async () => {
  const runtime = await createRuntime("pause-barrier");
  const independent = await runtime.createIndependentClient();
  const locked = deferred();
  const release = deferred();
  try {
    const pausing = independent.$transaction(async (transaction) => {
      await transaction.$queryRaw`
        select id from public.provider_source_instances
        where id = ${runtime.source.sourceInstanceId}::uuid
        for update
      `;
      await transaction.provider_source_instances.update({
        where: { id: runtime.source.sourceInstanceId },
        data: { pause_requested_at: await databaseNow(independent) },
      });
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const importing = service(runtime).importPage({
      pins: runtime.pins,
      adapterResult: runtime.adapterResult,
      committedAt: await databaseNow(runtime.database),
    });
    await assertPending(importing);
    release.resolve();
    await pausing;
    const result = await importing;
    assert.equal(result.kind, "committed");
    const source = await runtime.database.provider_source_instances.findUniqueOrThrow({
      where: { id: runtime.source.sourceInstanceId },
    });
    assert.equal(source.state, "paused");
    assert.equal(source.pause_requested_at, null);
  } finally {
    release.resolve();
    await independent.$disconnect();
    await runtime.close();
  }
});
