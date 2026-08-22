#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  TASK010_SAFETY_VERSION,
  TASK010_PAGE_RECORD_COUNT_SQL,
  Task010SafetyError,
  assessTask010ProviderReconciliation,
  assertNoTask010Arguments,
  loadTask010EnvironmentFile,
  readTask010Environment,
  safeTask010Failure,
} from "./provider-source-task010-safety.mjs";
import {
  createTask010CapacityReceipt,
  openTask010Database,
  verifyTask010Bootstrap,
  verifyTask010DatabaseIdentity,
  verifyTask010MigratedSchema,
  verifyTask010SourceTopology,
} from "./provider-source-task010-runtime.mts";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
function integer(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Task010SafetyError("RECONCILIATION_COUNT_INVALID");
  }
  return parsed;
}

async function main(): Promise<void> {
  assertNoTask010Arguments(process.argv.slice(2));
  const task010Environment = await loadTask010EnvironmentFile(workspaceRoot);
  const environment = readTask010Environment(task010Environment);
  if (!environment.expectedDatabaseIdentity) {
    throw new Task010SafetyError("DATABASE_IDENTITY_FINGERPRINT_REQUIRED");
  }
  const client = await openTask010Database(environment);
  try {
    const target = await verifyTask010DatabaseIdentity(client, environment);
    await verifyTask010MigratedSchema(client);
    const capacity = await createTask010CapacityReceipt({
      client,
      environment,
      databaseIdentity: target.fingerprint,
      databaseDataDirectory: target.identity.dataDirectory,
      schemaReady: true,
    });
    await verifyTask010Bootstrap(
      client,
      environment,
      target.fingerprint,
      capacity,
    );
    await verifyTask010SourceTopology(client, environment, {
      requireBackfillReady: true,
    });

    const providers = await client.query<{
      providerId: string;
      platformKey: string;
      sourceInstanceId: string | null;
      sourceRevisionId: string | null;
      sourceState: string | null;
      mapperKey: string | null;
      mapperVersion: string | null;
      identityNamespaceKey: string | null;
      checkpointGeneration: string | null;
      checkpointFingerprint: string | null;
      headTime: Date | null;
      intervalSeconds: number | null;
      nextDueAt: Date | null;
    }>(
      `
      select provider.id::text as "providerId",
             provider.platform_key as "platformKey",
             source.id::text as "sourceInstanceId",
             revision.id::text as "sourceRevisionId",
             source.state::text as "sourceState",
             revision.mapper_key as "mapperKey",
             revision.mapper_version as "mapperVersion",
             revision.identity_namespace_key as "identityNamespaceKey",
             checkpoint.checkpoint_generation::text as "checkpointGeneration",
             checkpoint.checkpoint_fingerprint as "checkpointFingerprint",
             health.last_head_reached_at as "headTime",
             schedule_revision.interval_seconds as "intervalSeconds",
             schedule.next_due_at as "nextDueAt"
      from public.provider_sources as provider
      left join public.provider_source_instances as source
        on source.organization_id = provider.organization_id
       and source.provider_id = provider.id
       and source.state <> 'replaced'
      left join public.provider_source_revisions as revision
        on revision.id = source.active_revision_id
      left join public.provider_source_checkpoints as checkpoint
        on checkpoint.source_instance_id = source.id
      left join public.provider_source_health_states as health
        on health.source_instance_id = source.id
      left join public.provider_source_schedules as schedule
        on schedule.source_instance_id = source.id
      left join public.provider_source_schedule_revisions as schedule_revision
        on schedule_revision.id = schedule.active_schedule_revision_id
      where provider.organization_id = $1::uuid
      order by provider.platform_key
    `,
      [environment.organizationId],
    );

    const providerResults = [];
    for (const provider of providers.rows) {
      const sourceInstanceId = provider.sourceInstanceId;
      const counts =
        sourceInstanceId === null
          ? null
          : await client.query<Record<string, unknown>>(
              `
          with page_counts as (
            select count(*)::text as pages,
                   coalesce(sum(
                     ${TASK010_PAGE_RECORD_COUNT_SQL}
                   ), 0)::text
                     as page_records,
                   coalesce(sum(coalesce(
                     attempt.response_bytes,
                     compact_attempt.response_bytes,
                     0
                   )), 0)::text as raw_bytes,
                   count(*) filter (
                     where attempt.response_bytes is null
                       and compact_attempt.response_bytes is null
                   )::text as missing_response_byte_evidence
            from public.import_pages as page
            left join public.source_request_attempts as attempt
              on attempt.id = page.request_attempt_id
             and attempt.organization_id = page.organization_id
            left join public.compact_source_request_attempts as compact_attempt
              on compact_attempt.request_attempt_id = page.request_attempt_id
             and compact_attempt.organization_id = page.organization_id
            where page.organization_id = $1::uuid
              and page.source_instance_id = $2::uuid
          ), disposition_counts as (
            select count(*)::text as dispositions,
                   count(*) filter (where disposition = 'inserted')::text as inserted,
                   count(*) filter (where disposition = 'revised')::text as revised,
                   count(*) filter (where disposition = 'duplicate')::text as duplicate,
                   count(*) filter (where disposition = 'quarantined')::text as quarantined
            from public.source_delivery_occurrences
            where organization_id = $1::uuid and source_instance_id = $2::uuid
          ), observation_counts as (
            select count(distinct observation.id)::text as semantics
            from public.source_record_identities as identity
            join public.source_semantic_observations as observation
              on observation.organization_id = identity.organization_id
             and observation.source_record_id = identity.id
            where identity.organization_id = $1::uuid
              and identity.source_instance_id = $2::uuid
          ), canonical_counts as (
            select count(distinct revision.entity_id)::text as canonical_entities,
                   count(distinct revision.id)::text as canonical_revisions,
                   count(distinct entity.id) filter (
                     where entity.record_kind = 'pack'
                   )::text as canonical_packs,
                   count(distinct entity.id) filter (
                     where entity.record_kind = 'catalog_asset'
                   )::text as canonical_assets,
                   count(distinct entity.id) filter (
                     where entity.record_kind = 'pull'
                   )::text as canonical_pulls,
                   count(distinct entity.id) filter (
                     where entity.record_kind = 'market_event'
                   )::text as canonical_market_events,
                   count(distinct entity.id) filter (
                     where entity.record_kind = 'ev_input'
                   )::text as canonical_ev_inputs,
                   count(distinct entity.id) filter (
                     where entity.record_kind = 'pack'
                       and current_revision.content_json->>'availability' = 'available'
                   )::text as available_packs,
                   count(distinct entity.id) filter (
                     where entity.record_kind = 'pack'
                       and current_revision.content_json->>'availability' = 'unavailable'
                   )::text as unavailable_packs,
                   count(distinct entity.id) filter (
                     where entity.record_kind = 'pack'
                       and current_revision.content_json->>'availability' = 'unknown'
                   )::text as unknown_availability_packs,
                   count(distinct entity.id) filter (
                     where entity.record_kind = 'pack'
                       and current_revision.content_json->>'availability' = 'sold_out'
                   )::text as sold_out_packs
            from public.source_record_identities as identity
            join public.source_semantic_observations as observation
              on observation.organization_id = identity.organization_id
             and observation.source_record_id = identity.id
            join public.canonical_revisions as revision
              on revision.organization_id = observation.organization_id
             and revision.origin_semantic_observation_id = observation.id
            join public.canonical_entities as entity
              on entity.id = revision.entity_id
             and entity.organization_id = revision.organization_id
            join public.canonical_revisions as current_revision
              on current_revision.id = entity.current_revision_id
            where identity.organization_id = $1::uuid
              and identity.source_instance_id = $2::uuid
          ), relationship_counts as (
            select count(distinct relationship.id)::text as relationships,
                   count(distinct relationship.id) filter (
                     where relationship.target_entity_id is null
                   )::text as unresolved_relationships
            from public.canonical_relationships as relationship
            where relationship.organization_id = $1::uuid
              and exists (
                select 1
                from public.canonical_revisions as revision
                join public.source_semantic_observations as observation
                  on observation.id = revision.origin_semantic_observation_id
                 and observation.organization_id = revision.organization_id
                join public.source_record_identities as identity
                  on identity.id = observation.source_record_id
                 and identity.organization_id = observation.organization_id
                where revision.entity_id = relationship.source_entity_id
                  and identity.source_instance_id = $2::uuid
              )
          ), quarantine_counts as (
            select count(*)::text as quarantine,
                   count(*) filter (where quarantine.state = 'open')::text
                     as open_quarantine,
                   count(*) filter (
                     where quarantine.state = 'open' and (
                       quarantine.reason_code ilike '%platform%' or
                       quarantine.reason_code ilike '%identity%' or
                       quarantine.reason_code ilike '%immutable%' or
                       quarantine.reason_code ilike '%relationship%' or
                       quarantine.reason_code ilike '%malformed%'
                     )
                   )::text as launch_blocking_quarantine
            from public.quarantine_records as quarantine
            join public.source_delivery_occurrences as occurrence
              on occurrence.id = quarantine.delivery_occurrence_id
             and occurrence.organization_id = quarantine.organization_id
            where occurrence.organization_id = $1::uuid
              and occurrence.source_instance_id = $2::uuid
          ), ev_counts as (
            select count(*)::text as ev_requests,
                   count(*) filter (where state = 'completed')::text as ev_completed,
                   count(*) filter (
                     where state = 'completed' and result_status = 'estimated'
                   )::text as ev_estimated,
                   count(*) filter (
                     where state = 'completed' and result_status = 'unavailable'
                   )::text as ev_unavailable,
                   count(*) filter (where state = 'failed')::text as ev_failed,
                   count(*) filter (where state in ('queued', 'running'))::text
                     as ev_pending,
                   count(distinct calculation.entity_id) filter (
                     where request.result_status = 'estimated'
                   )::text as estimated_ev_entities,
                   count(*) filter (
                     where (request.result_status = 'estimated' and
                            request.calculation_revision_id is null)
                        or (request.result_status = 'unavailable' and
                            request.calculation_revision_id is not null)
                   )::text as ev_calculation_mismatches
            from public.estimated_ev_recomputation_requests as request
            left join public.canonical_revisions as calculation
              on calculation.id = request.calculation_revision_id
             and calculation.organization_id = request.organization_id
            where request.organization_id = $1::uuid
              and request.source_instance_id = $2::uuid
          ), run_counts as (
            select count(*)::text as runs,
                   count(*) filter (where trigger = 'manual')::text as manual_runs,
                   count(*) filter (where trigger = 'recovery')::text as recovery_runs,
                   bool_or(reached_provider_head) as reached_head,
                   min(committed.created_at) filter (
                     where committed.created_at > first_head.first_head_at
                       and committed.trigger = 'scheduled'
                   ) as first_incremental_started_at,
                   (max(extract(epoch from (
                     committed.finished_at - committed.created_at
                   )) * 1000) filter (
                     where committed.created_at > first_head.first_head_at
                       and committed.trigger = 'scheduled'
                       and committed.finished_at is not null
                   ))::bigint::text as incremental_latency_ms
            from public.import_runs as committed
            cross join lateral (
              select min(finished_at) as first_head_at
              from public.import_runs as head
              where head.organization_id = $1::uuid
                and head.source_instance_id = $2::uuid
                and head.reached_provider_head = true
                and head.finished_at is not null
            ) as first_head
            where committed.organization_id = $1::uuid
              and committed.source_instance_id = $2::uuid
          ), retry_counts as (
            select count(*)::text as retries
            from public.source_processor_diagnostic_events
            where organization_id = $1::uuid
              and source_instance_id = $2::uuid
              and phase = 'retry_scheduled'
          ), page_times as (
            select min(committed_at) as first_committed_at,
                   max(committed_at) as last_committed_at
            from public.import_pages
            where organization_id = $1::uuid and source_instance_id = $2::uuid
          ), attempt_counts as (
            select count(*) filter (where state = 'in_flight')::text
                     as nonterminal_attempts
            from public.source_request_attempts
            where organization_id = $1::uuid and source_instance_id = $2::uuid
          )
          select * from page_counts cross join disposition_counts
            cross join observation_counts cross join canonical_counts
            cross join relationship_counts cross join quarantine_counts
            cross join ev_counts cross join run_counts cross join retry_counts
            cross join page_times cross join attempt_counts
        `,
              [environment.organizationId, sourceInstanceId],
            );
      const row = counts?.rows[0] ?? {};
      const reconciliation = assessTask010ProviderReconciliation({
        reachedHead: row.reached_head === true,
        sourceState: provider.sourceState,
        pageRecordCount: integer(row.page_records),
        dispositionCount: integer(row.dispositions),
        quarantinedDispositionCount: integer(row.quarantined),
        quarantineCount: integer(row.quarantine),
        openQuarantineCount: integer(row.open_quarantine),
        launchBlockingQuarantineCount: integer(row.launch_blocking_quarantine),
        unresolvedRelationshipCount: integer(row.unresolved_relationships),
        failedEvCount: integer(row.ev_failed),
        pendingEvCount: integer(row.ev_pending),
        nonterminalRequestAttemptCount: integer(row.nonterminal_attempts),
        missingResponseByteEvidenceCount: integer(
          row.missing_response_byte_evidence,
        ),
        canonicalPackCount: integer(row.canonical_packs),
        availabilityCount:
          integer(row.available_packs) +
          integer(row.unavailable_packs) +
          integer(row.unknown_availability_packs) +
          integer(row.sold_out_packs),
        evCalculationMismatchCount: integer(row.ev_calculation_mismatches),
      });
      providerResults.push({
        providerId: provider.providerId,
        platformKey: provider.platformKey,
        sourceInstanceId,
        sourceRevisionId: provider.sourceRevisionId,
        sourceState: provider.sourceState,
        mapperKey: provider.mapperKey,
        mapperVersion: provider.mapperVersion,
        identityNamespaceKey: provider.identityNamespaceKey,
        checkpoint: {
          generation: provider.checkpointGeneration,
          fingerprint: provider.checkpointFingerprint,
        },
        headTime: provider.headTime?.toISOString() ?? null,
        firstCommittedAt:
          row.first_committed_at instanceof Date
            ? row.first_committed_at.toISOString()
            : null,
        lastCommittedAt:
          row.last_committed_at instanceof Date
            ? row.last_committed_at.toISOString()
            : null,
        elapsedMilliseconds:
          row.first_committed_at instanceof Date &&
          row.last_committed_at instanceof Date
            ? Math.max(
                0,
                row.last_committed_at.getTime() -
                  row.first_committed_at.getTime(),
              )
            : null,
        recordsPerSecond:
          row.first_committed_at instanceof Date &&
          row.last_committed_at instanceof Date &&
          row.last_committed_at.getTime() > row.first_committed_at.getTime()
            ? integer(row.page_records) /
              ((row.last_committed_at.getTime() -
                row.first_committed_at.getTime()) /
                1_000)
            : null,
        intervalSeconds: provider.intervalSeconds,
        nextDueAt: provider.nextDueAt?.toISOString() ?? null,
        pages: integer(row.pages),
        sourceRecords: integer(row.page_records),
        receivedResponseBytes: integer(row.raw_bytes),
        dispositions: {
          total: integer(row.dispositions),
          inserted: integer(row.inserted),
          revised: integer(row.revised),
          duplicate: integer(row.duplicate),
          quarantined: integer(row.quarantined),
        },
        semanticObservations: integer(row.semantics),
        canonical: {
          entities: integer(row.canonical_entities),
          revisions: integer(row.canonical_revisions),
          packs: integer(row.canonical_packs),
          assets: integer(row.canonical_assets),
          pulls: integer(row.canonical_pulls),
          marketEvents: integer(row.canonical_market_events),
          evInputs: integer(row.canonical_ev_inputs),
          estimatedEvEntities: integer(row.estimated_ev_entities),
          relationships: integer(row.relationships),
          unresolvedRelationships: integer(row.unresolved_relationships),
          availability: {
            available: integer(row.available_packs),
            unavailable: integer(row.unavailable_packs),
            unknown: integer(row.unknown_availability_packs),
            soldOut: integer(row.sold_out_packs),
          },
        },
        estimatedEv: {
          requests: integer(row.ev_requests),
          completed: integer(row.ev_completed),
          estimated: integer(row.ev_estimated),
          unavailable: integer(row.ev_unavailable),
          failed: integer(row.ev_failed),
          pending: integer(row.ev_pending),
          calculationMismatches: integer(row.ev_calculation_mismatches),
        },
        quarantine: {
          total: integer(row.quarantine),
          open: integer(row.open_quarantine),
          launchBlocking: integer(row.launch_blocking_quarantine),
        },
        runtime: {
          runs: integer(row.runs),
          manualRuns: integer(row.manual_runs),
          recoveryRuns: integer(row.recovery_runs),
          retries: integer(row.retries),
          retryEvidenceRetentionDays: 30,
          nonterminalRequestAttempts: integer(row.nonterminal_attempts),
          missingResponseByteEvidence: integer(
            row.missing_response_byte_evidence,
          ),
          incrementalLatencyMilliseconds:
            row.incremental_latency_ms === null
              ? null
              : integer(row.incremental_latency_ms),
          incrementalLatencyBlocker:
            row.incremental_latency_ms === null
              ? "incremental_due_window_not_observed"
              : null,
        },
        ...reconciliation,
      });
    }

    const resources = await client.query<{
      relation: string;
      rows: string;
      tableBytes: string;
      indexBytes: string;
      totalBytes: string;
    }>(`
      select relation.relname as relation,
             greatest(relation.reltuples, 0)::bigint::text as rows,
             pg_table_size(relation.oid)::text as "tableBytes",
             pg_indexes_size(relation.oid)::text as "indexBytes",
             pg_total_relation_size(relation.oid)::text as "totalBytes"
      from pg_class as relation
      join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relkind in ('r', 'p')
        and relation.relname in (
          'import_runs', 'import_pages', 'source_record_identities',
          'source_semantic_observations', 'source_delivery_occurrences',
          'canonical_entities', 'canonical_revisions',
          'canonical_relationships', 'estimated_ev_recomputation_requests',
          'quarantine_records', 'source_processor_diagnostic_events',
          'source_request_attempts', 'compact_source_request_attempts'
        )
      order by relation.relname
    `);
    const globalFailures: string[] = [];
    if (providerResults.length !== 4)
      globalFailures.push("provider_count_invalid");
    if (providerResults.some(({ status }) => status !== "PASS")) {
      globalFailures.push("provider_reconciliation_blocked");
    }
    if (capacity.decision.decision !== "approved") {
      globalFailures.push("capacity_preflight_rejected");
    }
    if (capacity.input.unreconciledNonterminalAttemptCount !== 0) {
      globalFailures.push("global_nonterminal_request_attempts");
    }
    const dataReconciliationStatus =
      globalFailures.length === 0 ? "PASS" : "BLOCKED";
    globalFailures.push("operational_resource_evidence_not_supplied");
    const status = "BLOCKED" as const;
    process.stdout.write(
      `${JSON.stringify({
        version: "packscout.provider-source-task010-reconciliation.v1",
        generatedAt: new Date().toISOString(),
        status,
        dataReconciliationStatus,
        target: { ...target.identity, fingerprint: target.fingerprint },
        capacity,
        failures: globalFailures,
        providers: providerResults,
        resources: resources.rows.map((resource) => ({
          relation: resource.relation,
          estimatedRows: integer(resource.rows),
          tableBytes: integer(resource.tableBytes),
          indexBytes: integer(resource.indexBytes),
          totalBytes: integer(resource.totalBytes),
        })),
        runtimeEvidence: {
          parallelOverlap: null,
          fairness: null,
          interruptionRecovery: null,
          pauseResumeIsolation: null,
          manualCoalescing: null,
          independentIntervals: null,
          blocker: "real_backfill_and_operational_proof_not_complete",
        },
        resourceEvidence: {
          memoryPeakBytes: null,
          memoryPeakBlocker:
            "capture supervisor process peak RSS during the admitted real backfill",
          relationAndIndexSizesRecorded: true,
        },
        completionRule:
          "All four providers must be PASS; BLOCKED never certifies completion.",
      })}\n`,
    );
    if (status !== "PASS") process.exitCode = 1;
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      ...safeTask010Failure(error),
      version: TASK010_SAFETY_VERSION,
    })}\n`,
  );
  process.exitCode = 1;
});
