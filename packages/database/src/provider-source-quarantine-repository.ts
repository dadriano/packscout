import {
  decideProviderSourceCanonicalLifecycle,
  type LaunchProviderKey,
  type NormalizedObservationSemanticContent,
  type ProviderSourceCanonicalProjectionPlan,
} from "@packscout/contracts";
import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
  type PackscoutQueryClient,
  type PackscoutTransactionClient,
} from "./database.ts";
import {
  enqueueSourceEstimatedEvRecomputationInTransaction,
} from "./estimated-ev-recomputation-repository.ts";
import { writeCanonicalProjectionBatch } from "./ingestion-page-batch-writer.ts";
import {
  hasProviderSourceCanonicalKindConflict,
  loadCompleteProviderSourceEvInput,
  loadProviderSourceCanonicalHistory,
  lockProviderSourceCanonicalProjectionIdentities,
  providerSourceProjectionCommand,
} from "./provider-source-canonical-page-queries.ts";
import { providerSourceTransactionTime } from
  "./provider-source-database-clock.ts";
import { validateProviderSourceCanonicalProjections } from
  "./provider-source-page-validation.ts";
import { advanceSettledPublicWatermark } from
  "./public-change-settlement-repository.ts";

type SourceQuarantineState = "open" | "retrying" | "resolved" | "expired";
type SourceQuarantineRecordKind = "catalog" | "pull" | "trade" | "unknown";

export interface ProviderSourceQuarantineEntry {
  readonly id: string;
  readonly organizationId: string;
  readonly providerId: string;
  readonly sourceRevisionId: string;
  readonly platformKey: LaunchProviderKey;
  readonly runId: string;
  readonly pageId: string;
  readonly recordKind: SourceQuarantineRecordKind;
  readonly recordIndex: number;
  readonly externalId: string | null;
  readonly reasonCode: string;
  readonly fieldPath: string | null;
  readonly sanitizedSummary: string;
  readonly state: SourceQuarantineState;
  readonly retryCount: number;
  readonly createdAt: Date;
  readonly lastRetryAt: Date | null;
  readonly expiresAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolutionSummary: string | null;
}

export interface ProviderSourceQuarantineAttempt {
  readonly id: string;
  readonly state: "running" | "succeeded" | "failed";
  readonly failureCode: string | null;
  readonly fieldPath: string | null;
  readonly sanitizedSummary: string | null;
  readonly canonicalRevisionCount: number | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

export interface ProviderSourceQuarantinePageQuery {
  readonly providerId?: string;
  readonly runId?: string;
  readonly state?: SourceQuarantineState;
  readonly recordKind?: Exclude<SourceQuarantineRecordKind, "unknown">;
  readonly reasonCode?: string;
  readonly before?: Readonly<{ createdAt: Date; id: string }>;
  readonly limit: number;
}

export interface ProviderSourceProtectedQuarantineEvidence {
  readonly normalizedObservation: unknown;
  readonly evidence: unknown;
  readonly semanticContent: NormalizedObservationSemanticContent | null;
  readonly sourceRecordId: string | null;
  readonly semanticObservationId: string | null;
  readonly collectedAt: Date;
  readonly mapper: Readonly<{
    mapperKey: string;
    mapperVersion: string;
    normalizedContractVersion: string;
    identityNamespaceKey: string;
  }>;
}

export type ProviderSourceQuarantineClaimResult =
  | Readonly<{
      kind: "claimed";
      attemptId: string;
      entry: ProviderSourceQuarantineEntry;
      evidence: ProviderSourceProtectedQuarantineEvidence;
    }>
  | Readonly<{
      kind: "already_retrying" | "already_resolved" | "expired";
      entry: ProviderSourceQuarantineEntry;
    }>
  | Readonly<{ kind: "not_found" }>;

export type ProviderSourceQuarantineCompletionResult = Readonly<{
  kind: "resolved" | "failed" | "expired" | "not_found";
  entry: ProviderSourceQuarantineEntry | null;
  canonicalRevisionCount: number;
}>;

interface QuarantineIdRow {
  readonly id: string;
}

function uuid(value: string): Prisma.Sql {
  return Prisma.sql`${value}::uuid`;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizedEvidence(value: unknown): Readonly<{
  normalizedObservation: unknown;
  evidence: unknown;
}> {
  const object = jsonObject(value);
  return {
    normalizedObservation: object?.normalizedObservation ?? null,
    evidence: object?.evidence ?? null,
  };
}

export class ProviderSourceQuarantineRepository {
  constructor(
    private readonly database: PackscoutPrismaClient,
    private readonly actorPseudonymKey: Uint8Array | string,
    private readonly options: Readonly<{
      /** Test-only barrier after exact canonical identities are serialized. */
      afterCanonicalIdentityLock?: () => void | Promise<void>;
    }> = {},
  ) {}

  async listEntriesPage(
    organizationId: string,
    query: ProviderSourceQuarantinePageQuery,
    now: Date,
  ): Promise<Readonly<{
    items: readonly ProviderSourceQuarantineEntry[];
    hasMore: boolean;
  }>> {
    void now;
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 100) {
      throw new RangeError("Provider source quarantine page limit is invalid.");
    }
    const authoritativeNow = await providerSourceTransactionTime(this.database);
    const filters: Prisma.Sql[] = [
      Prisma.sql`quarantine.organization_id = ${uuid(organizationId)}`,
      Prisma.sql`quarantine.delivery_occurrence_id is not null`,
    ];
    if (query.providerId) {
      filters.push(Prisma.sql`quarantine.provider_id = ${uuid(query.providerId)}`);
    }
    if (query.runId) {
      filters.push(Prisma.sql`quarantine.run_id = ${uuid(query.runId)}`);
    }
    if (query.recordKind) {
      filters.push(Prisma.sql`
        quarantine.record_kind = ${query.recordKind}::public.source_record_kind
      `);
    }
    if (query.reasonCode) {
      filters.push(Prisma.sql`quarantine.reason_code = ${query.reasonCode}`);
    }
    if (query.before) {
      filters.push(Prisma.sql`
        (quarantine.created_at, quarantine.id) <
        (${query.before.createdAt}, ${uuid(query.before.id)})
      `);
    }
    const running = Prisma.sql`
      exists (
        select 1 from public.quarantine_attempts as attempt
        where attempt.organization_id = quarantine.organization_id
          and attempt.quarantine_id = quarantine.id
          and attempt.state = 'running'::public.quarantine_attempt_state
      )
    `;
    if (query.state === "retrying") {
      filters.push(Prisma.sql`
        quarantine.state = 'open'::public.quarantine_state
        and quarantine.expires_at > ${authoritativeNow}
        and ${running}
      `);
    } else if (query.state === "open") {
      filters.push(Prisma.sql`
        quarantine.state = 'open'::public.quarantine_state
        and quarantine.expires_at > ${authoritativeNow}
        and not ${running}
      `);
    } else if (query.state === "resolved") {
      filters.push(Prisma.sql`quarantine.state = 'resolved'::public.quarantine_state`);
    } else if (query.state === "expired") {
      filters.push(Prisma.sql`
        (quarantine.state = 'expired'::public.quarantine_state
          or quarantine.expires_at <= ${authoritativeNow})
      `);
    }
    const rows = await this.database.$queryRaw<QuarantineIdRow[]>(Prisma.sql`
      select quarantine.id
      from public.quarantine_records as quarantine
      where ${Prisma.join(filters, " and ")}
      order by quarantine.created_at desc, quarantine.id desc
      limit ${query.limit + 1}
    `);
    const items = await Promise.all(
      rows.slice(0, query.limit).map(({ id }) =>
        this.loadEntry(this.database, organizationId, id, authoritativeNow)),
    );
    return {
      items: items.filter(
        (entry): entry is ProviderSourceQuarantineEntry => entry !== null,
      ),
      hasMore: rows.length > query.limit,
    };
  }

  async getEntry(
    organizationId: string,
    quarantineId: string,
    now: Date,
  ): Promise<ProviderSourceQuarantineEntry | null> {
    void now;
    return this.loadEntry(
      this.database,
      organizationId,
      quarantineId,
      await providerSourceTransactionTime(this.database),
    );
  }

  async listAttempts(
    organizationId: string,
    quarantineId: string,
  ): Promise<readonly ProviderSourceQuarantineAttempt[]> {
    const rows = await this.database.quarantine_attempts.findMany({
      where: { organization_id: organizationId, quarantine_id: quarantineId },
      orderBy: [{ started_at: "asc" }, { id: "asc" }],
    });
    return rows.map((row) => ({
      id: row.id,
      state: row.state,
      failureCode: row.failure_code,
      fieldPath: row.field_path,
      sanitizedSummary: row.sanitized_summary,
      canonicalRevisionCount: row.canonical_revision_count,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
    }));
  }

  async claimRetry(input: Readonly<{
    organizationId: string;
    quarantineId: string;
    attemptId: string;
    actorKey: string;
    claimedAt: Date;
  }>): Promise<ProviderSourceQuarantineClaimResult> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        select id from public.quarantine_records
        where id = ${uuid(input.quarantineId)}
          and organization_id = ${uuid(input.organizationId)}
          and delivery_occurrence_id is not null
        for update
      `);
      const authoritativeNow = await providerSourceTransactionTime(transaction);
      const entry = await this.loadEntry(
        transaction,
        input.organizationId,
        input.quarantineId,
        authoritativeNow,
      );
      if (!entry) return { kind: "not_found" };
      if (entry.state === "resolved") {
        return { kind: "already_resolved", entry };
      }
      if (entry.state === "expired") {
        await this.expireLocked(
          transaction,
          input.organizationId,
          input.quarantineId,
          authoritativeNow,
        );
        return {
          kind: "expired",
          entry: (await this.loadEntry(
            transaction,
            input.organizationId,
            input.quarantineId,
            authoritativeNow,
          ))!,
        };
      }
      if (entry.state === "retrying") {
        return { kind: "already_retrying", entry };
      }
      const evidence = await this.loadProtectedEvidence(
        transaction,
        input.organizationId,
        input.quarantineId,
      );
      if (!evidence) {
        await this.expireLocked(
          transaction,
          input.organizationId,
          input.quarantineId,
          authoritativeNow,
        );
        return {
          kind: "expired",
          entry: (await this.loadEntry(
            transaction,
            input.organizationId,
            input.quarantineId,
            authoritativeNow,
          ))!,
        };
      }
      await transaction.quarantine_attempts.create({
        data: {
          id: input.attemptId,
          organization_id: input.organizationId,
          quarantine_id: input.quarantineId,
          source_record_id: null,
          state: "running",
          requested_by_actor_key: input.actorKey,
          started_at: authoritativeNow,
        },
      });
      await transaction.quarantine_records.update({
        where: { id: input.quarantineId },
        data: {
          retry_count: { increment: 1 },
          last_retry_at: authoritativeNow,
        },
      });
      return {
        kind: "claimed",
        attemptId: input.attemptId,
        entry: (await this.loadEntry(
          transaction,
          input.organizationId,
          input.quarantineId,
          authoritativeNow,
        ))!,
        evidence,
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async completeRetry(input: Readonly<{
    organizationId: string;
    quarantineId: string;
    attemptId: string;
    actorKey: string;
    provider: LaunchProviderKey;
    projections: readonly ProviderSourceCanonicalProjectionPlan[];
    completedAt: Date;
  }>): Promise<ProviderSourceQuarantineCompletionResult> {
    return this.database.$transaction(async (transaction) => {
      const locked = await this.lockRetry(
        transaction,
        input.organizationId,
        input.quarantineId,
        input.attemptId,
      );
      if (!locked) {
        return { kind: "not_found", entry: null, canonicalRevisionCount: 0 };
      }
      const authoritativeNow = await providerSourceTransactionTime(transaction);
      if (locked.quarantine.expires_at <= authoritativeNow) {
        await this.expireLocked(
          transaction,
          input.organizationId,
          input.quarantineId,
          authoritativeNow,
        );
        await this.failAttempt(transaction, input, {
          code: "SOURCE_EVIDENCE_EXPIRED",
          summary: "Retained normalized evidence expired before retry completion.",
        }, authoritativeNow);
        return {
          kind: "expired",
          entry: await this.loadEntry(
            transaction,
            input.organizationId,
            input.quarantineId,
            authoritativeNow,
          ),
          canonicalRevisionCount: 0,
        };
      }
      const provider = await transaction.provider_sources.findFirst({
        where: {
          id: locked.quarantine.provider_id,
          organization_id: input.organizationId,
        },
        select: { platform_key: true },
      });
      if (!provider || provider.platform_key !== input.provider) {
        return this.failCompletion(transaction, input, {
          code: "PROVIDER_SCOPE_MISMATCH",
          summary: "The retry provider does not match durable source lineage.",
        }, authoritativeNow);
      }
      const occurrence = await transaction.source_delivery_occurrences.findFirst({
        where: {
          id: locked.quarantine.delivery_occurrence_id!,
          organization_id: input.organizationId,
          provider_id: locked.quarantine.provider_id,
          run_id: locked.quarantine.run_id,
          page_id: locked.quarantine.page_id,
          record_index: locked.quarantine.record_index,
        },
      });
      const semantic = occurrence?.semantic_observation_id
        ? await transaction.source_semantic_observations.findFirst({
            where: {
              id: occurrence.semantic_observation_id,
              organization_id: input.organizationId,
              source_record_id: occurrence.source_record_id!,
            },
          })
        : null;
      const semanticContent = jsonObject(semantic?.normalized_content_json) as
        NormalizedObservationSemanticContent | null;
      if (!occurrence || !semantic || !semanticContent) {
        return this.failCompletion(transaction, input, {
          code: "SOURCE_REFERENCE_UNAVAILABLE",
          summary: "The retained occurrence has no retryable semantic observation.",
        }, authoritativeNow);
      }
      try {
        validateProviderSourceCanonicalProjections({
          provider: input.provider,
          semanticContent,
          projections: input.projections,
        });
      } catch {
        return this.failCompletion(transaction, input, {
          code: "MAPPING_OUTPUT_INVALID",
          summary: "The source mapper returned an invalid canonical projection.",
        }, authoritativeNow);
      }
      if (
        occurrence.source_record_id === null ||
        await hasProviderSourceCanonicalKindConflict(
          transaction,
          input.organizationId,
          occurrence.source_record_id,
          input.projections,
        )
      ) {
        return this.failCompletion(transaction, input, {
          code: "IDENTITY_KIND_CONFLICT",
          summary: "The retained source identity conflicts with canonical history.",
        }, authoritativeNow);
      }
      await lockProviderSourceCanonicalProjectionIdentities(
        transaction,
        input.organizationId,
        input.projections,
      );
      await this.options.afterCanonicalIdentityLock?.();
      const decisions = [] as Array<{
        projection: ProviderSourceCanonicalProjectionPlan;
        becomesCurrent: boolean;
        disposition: "inserted" | "revised" | "duplicate";
      }>;
      for (const projection of input.projections) {
        const history = await loadProviderSourceCanonicalHistory(
          transaction,
          { organizationId: input.organizationId, provider: input.provider },
          projection,
        );
        const decision = decideProviderSourceCanonicalLifecycle({
          recordIdScopeKey: projection.recordIdScopeKey,
          canonicalKind: projection.recordKind,
          contentFingerprint: projection.contentFingerprint,
          effectiveAt: projection.effectiveAt,
          existingBinding: null,
          revisions: history.map((revision) => ({
            contentFingerprint: revision.contentFingerprint,
            effectiveAt: revision.effectiveAt.toISOString(),
          })),
        });
        if (decision.disposition === "quarantined") {
          return this.failCompletion(transaction, input, {
            code: decision.reasonCode.toUpperCase(),
            summary: "The retained source observation conflicts with immutable canonical history.",
          }, authoritativeNow);
        }
        decisions.push({
          projection,
          becomesCurrent: decision.becomesCurrent,
          disposition: decision.disposition,
        });
      }
      const changes = decisions.filter(
        ({ disposition }) => disposition !== "duplicate",
      );
      const writes = await writeCanonicalProjectionBatch(
        transaction,
        { retentionDays: 90, actorPseudonymKey: this.actorPseudonymKey },
        changes.map((change, projectionIndex) => ({
          organizationId: input.organizationId,
          providerId: occurrence.provider_id,
          origin: {
            kind: "semantic_observation" as const,
            sourceRevisionId: occurrence.source_revision_id,
            semanticObservationId: semantic.id,
          },
          projection: providerSourceProjectionCommand(
            change.projection,
            occurrence.collected_at.toISOString(),
          ),
          projectionIndex,
          becomesCurrent: change.becomesCurrent,
          acceptedAt: authoritativeNow,
          publicChangeKind: "provider_projection" as const,
        })),
      );
      const causes = writes.flatMap((write, index) =>
        write.created &&
          changes[index]?.becomesCurrent &&
          changes[index]?.projection.evInputStatus === "ready"
          ? [write.publicChangeSequence]
          : []);
      const packExternalId = input.projections.find(
        ({ evInputStatus, recordKind }) =>
          evInputStatus === "ready" &&
          (recordKind === "pack" || recordKind === "ev_input"),
      )?.affectedPackProviderRecordId ?? null;
      if (packExternalId && causes.length > 0) {
        const current = await loadCompleteProviderSourceEvInput(
          transaction,
          { organizationId: input.organizationId, provider: input.provider },
          packExternalId,
        );
        if (current) {
          await enqueueSourceEstimatedEvRecomputationInTransaction(transaction, {
            organizationId: input.organizationId,
            providerId: occurrence.provider_id,
            sourceInstanceId: occurrence.source_instance_id,
            sourceRevisionId: occurrence.source_revision_id,
            platformKey: input.provider,
            packExternalId,
            evInputExternalId: current.evInputExternalId,
            packRevisionId: current.packRevisionId,
            evInputRevisionId: current.evInputRevisionId,
            causeSequences: causes,
            createdAt: authoritativeNow,
          });
        }
      }
      await transaction.quarantine_attempts.update({
        where: { id: input.attemptId },
        data: {
          state: "succeeded",
          canonical_revision_count: writes.filter(({ created }) => created).length,
          sanitized_summary: "Retained normalized source evidence was reprojected.",
          finished_at: authoritativeNow,
        },
      });
      await transaction.quarantine_records.update({
        where: { id: input.quarantineId },
        data: { state: "resolved", resolved_at: authoritativeNow },
      });
      await transaction.audit_events.create({
        data: {
          organization_id: input.organizationId,
          actor_key: input.actorKey,
          action: "provider_source.quarantine.retry",
          subject_type: "quarantine_record",
          subject_id: input.quarantineId,
          outcome: "success",
          metadata_json: {
            sourceInstanceId: occurrence.source_instance_id,
            sourceRevisionId: occurrence.source_revision_id,
            canonicalRevisionCount: writes.filter(({ created }) => created).length,
          },
          occurred_at: authoritativeNow,
        },
      });
      await advanceSettledPublicWatermark(transaction, {
        organizationId: input.organizationId,
        settledAt: authoritativeNow,
      });
      return {
        kind: "resolved",
        entry: await this.loadEntry(
          transaction,
          input.organizationId,
          input.quarantineId,
          authoritativeNow,
        ),
        canonicalRevisionCount: writes.filter(({ created }) => created).length,
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async failRetry(input: Readonly<{
    organizationId: string;
    quarantineId: string;
    attemptId: string;
    actorKey: string;
    failedAt: Date;
    failureCode: string;
    sanitizedSummary: string;
  }>): Promise<ProviderSourceQuarantineCompletionResult> {
    return this.database.$transaction(async (transaction) => {
      const locked = await this.lockRetry(
        transaction,
        input.organizationId,
        input.quarantineId,
        input.attemptId,
      );
      if (!locked) {
        return { kind: "not_found", entry: null, canonicalRevisionCount: 0 };
      }
      const authoritativeNow = await providerSourceTransactionTime(transaction);
      if (locked.quarantine.expires_at <= authoritativeNow) {
        await this.expireLocked(
          transaction,
          input.organizationId,
          input.quarantineId,
          authoritativeNow,
        );
      }
      await this.failAttempt(transaction, input, {
        code: input.failureCode,
        summary: input.sanitizedSummary,
      }, authoritativeNow);
      return {
        kind: locked.quarantine.expires_at <= authoritativeNow
          ? "expired"
          : "failed",
        entry: await this.loadEntry(
          transaction,
          input.organizationId,
          input.quarantineId,
          authoritativeNow,
        ),
        canonicalRevisionCount: 0,
      };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  private async failCompletion(
    transaction: PackscoutTransactionClient,
    input: Readonly<{
      organizationId: string;
      quarantineId: string;
      attemptId: string;
      actorKey: string;
      completedAt: Date;
    }>,
    failure: Readonly<{ code: string; summary: string }>,
    authoritativeNow: Date,
  ): Promise<ProviderSourceQuarantineCompletionResult> {
    await this.failAttempt(transaction, input, failure, authoritativeNow);
    return {
      kind: "failed",
      entry: await this.loadEntry(
        transaction,
        input.organizationId,
        input.quarantineId,
        authoritativeNow,
      ),
      canonicalRevisionCount: 0,
    };
  }

  private async failAttempt(
    transaction: PackscoutTransactionClient,
    input: Readonly<{
      organizationId: string;
      quarantineId: string;
      attemptId: string;
      actorKey: string;
      completedAt?: Date;
      failedAt?: Date;
    }>,
    failure: Readonly<{ code: string; summary: string }>,
    authoritativeNow: Date,
  ): Promise<void> {
    await transaction.quarantine_attempts.update({
      where: { id: input.attemptId },
      data: {
        state: "failed",
        failure_code: failure.code,
        sanitized_summary: failure.summary,
        canonical_revision_count: 0,
        finished_at: authoritativeNow,
      },
    });
    await transaction.audit_events.create({
      data: {
        organization_id: input.organizationId,
        actor_key: input.actorKey,
        action: "provider_source.quarantine.retry",
        subject_type: "quarantine_record",
        subject_id: input.quarantineId,
        outcome: "failure",
        metadata_json: { safeCode: failure.code },
        occurred_at: authoritativeNow,
      },
    });
  }

  private async lockRetry(
    transaction: PackscoutTransactionClient,
    organizationId: string,
    quarantineId: string,
    attemptId: string,
  ) {
    const quarantineRows = await transaction.$queryRaw<QuarantineIdRow[]>(Prisma.sql`
      select quarantine.id
      from public.quarantine_records as quarantine
      where quarantine.id = ${uuid(quarantineId)}
        and quarantine.organization_id = ${uuid(organizationId)}
        and quarantine.delivery_occurrence_id is not null
        and quarantine.state = 'open'::public.quarantine_state
      for update of quarantine
    `);
    if (quarantineRows.length !== 1) return null;
    const attemptRows = await transaction.$queryRaw<QuarantineIdRow[]>(Prisma.sql`
      select attempt.id
      from public.quarantine_attempts as attempt
      where attempt.id = ${uuid(attemptId)}
        and attempt.organization_id = ${uuid(organizationId)}
        and attempt.quarantine_id = ${uuid(quarantineId)}
        and attempt.state = 'running'::public.quarantine_attempt_state
      for update of attempt
    `);
    if (attemptRows.length !== 1) return null;
    const [quarantine, attempt] = await Promise.all([
      transaction.quarantine_records.findFirst({
        where: {
          id: quarantineId,
          organization_id: organizationId,
          delivery_occurrence_id: { not: null },
          state: "open",
        },
      }),
      transaction.quarantine_attempts.findFirst({
        where: {
          id: attemptId,
          organization_id: organizationId,
          quarantine_id: quarantineId,
          state: "running",
        },
      }),
    ]);
    return quarantine && attempt ? { quarantine, attempt } : null;
  }

  private async loadProtectedEvidence(
    database: PackscoutQueryClient,
    organizationId: string,
    quarantineId: string,
  ): Promise<ProviderSourceProtectedQuarantineEvidence | null> {
    const quarantine = await database.quarantine_records.findFirst({
      where: {
        id: quarantineId,
        organization_id: organizationId,
        delivery_occurrence_id: { not: null },
      },
    });
    if (!quarantine?.payload_json || quarantine.payload_expired_at) return null;
    const occurrence = await database.source_delivery_occurrences.findFirst({
      where: {
        id: quarantine.delivery_occurrence_id!,
        organization_id: organizationId,
        run_id: quarantine.run_id,
        page_id: quarantine.page_id,
        record_index: quarantine.record_index,
      },
    });
    if (!occurrence) return null;
    const semantic = occurrence.semantic_observation_id
      ? await database.source_semantic_observations.findFirst({
          where: {
            id: occurrence.semantic_observation_id,
            organization_id: organizationId,
          },
        })
      : null;
    const payload = normalizedEvidence(quarantine.payload_json);
    return {
      ...payload,
      semanticContent: jsonObject(semantic?.normalized_content_json) as
        NormalizedObservationSemanticContent | null,
      sourceRecordId: occurrence.source_record_id,
      semanticObservationId: occurrence.semantic_observation_id,
      collectedAt: occurrence.collected_at,
      mapper: {
        mapperKey: occurrence.mapper_key,
        mapperVersion: occurrence.mapper_version,
        normalizedContractVersion: occurrence.normalized_contract_version,
        identityNamespaceKey: occurrence.identity_namespace_key,
      },
    };
  }

  private async loadEntry(
    database: PackscoutQueryClient,
    organizationId: string,
    quarantineId: string,
    now: Date,
  ): Promise<ProviderSourceQuarantineEntry | null> {
    const quarantine = await database.quarantine_records.findFirst({
      where: {
        id: quarantineId,
        organization_id: organizationId,
        delivery_occurrence_id: { not: null },
      },
    });
    if (!quarantine) return null;
    const [occurrence, provider, running, resolvedAttempt] = await Promise.all([
      database.source_delivery_occurrences.findFirst({
        where: {
          id: quarantine.delivery_occurrence_id!,
          organization_id: organizationId,
          provider_id: quarantine.provider_id,
          run_id: quarantine.run_id,
          page_id: quarantine.page_id,
          record_index: quarantine.record_index,
        },
      }),
      database.provider_sources.findFirst({
        where: { id: quarantine.provider_id, organization_id: organizationId },
        select: { platform_key: true },
      }),
      database.quarantine_attempts.findFirst({
        where: {
          organization_id: organizationId,
          quarantine_id: quarantineId,
          state: "running",
        },
        select: { id: true },
      }),
      database.quarantine_attempts.findFirst({
        where: {
          organization_id: organizationId,
          quarantine_id: quarantineId,
          state: "succeeded",
        },
        orderBy: [{ finished_at: "desc" }, { id: "desc" }],
        select: { sanitized_summary: true },
      }),
    ]);
    if (!occurrence || !provider) return null;
    const state: SourceQuarantineState = quarantine.state === "resolved"
      ? "resolved"
      : quarantine.state === "expired" || quarantine.expires_at <= now
        ? "expired"
        : running
          ? "retrying"
          : "open";
    return {
      id: quarantine.id,
      organizationId,
      providerId: quarantine.provider_id,
      sourceRevisionId: occurrence.source_revision_id,
      platformKey: provider.platform_key as LaunchProviderKey,
      runId: quarantine.run_id,
      pageId: quarantine.page_id,
      recordKind: quarantine.record_kind ?? "unknown",
      recordIndex: quarantine.record_index,
      externalId: quarantine.external_id,
      reasonCode: quarantine.reason_code,
      fieldPath: quarantine.field_path,
      sanitizedSummary: quarantine.sanitized_summary,
      state,
      retryCount: quarantine.retry_count,
      createdAt: quarantine.created_at,
      lastRetryAt: quarantine.last_retry_at,
      expiresAt: quarantine.expires_at,
      resolvedAt: quarantine.resolved_at,
      resolutionSummary: resolvedAttempt?.sanitized_summary ?? null,
    };
  }

  private async expireLocked(
    transaction: PackscoutTransactionClient,
    organizationId: string,
    quarantineId: string,
    expiredAt: Date,
  ): Promise<void> {
    await transaction.quarantine_attempts.updateMany({
      where: {
        organization_id: organizationId,
        quarantine_id: quarantineId,
        state: "running",
      },
      data: {
        state: "failed",
        failure_code: "SOURCE_EVIDENCE_EXPIRED",
        sanitized_summary:
          "Retained normalized evidence expired while the retry was running.",
        canonical_revision_count: 0,
        finished_at: expiredAt,
      },
    });
    await transaction.quarantine_records.updateMany({
      where: {
        id: quarantineId,
        organization_id: organizationId,
        state: "open",
      },
      data: {
        state: "expired",
        payload_json: Prisma.DbNull,
        payload_expired_at: expiredAt,
      },
    });
  }
}
