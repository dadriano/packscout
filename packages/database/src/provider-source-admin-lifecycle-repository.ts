import { Prisma } from "@prisma/client";
import {
  PACKSCOUT_TRANSACTION_OPTIONS,
  type PackscoutPrismaClient,
} from "./database.ts";
import { PersistenceError } from "./persistence-error.ts";
import { ProviderSourceAdminReadRepository } from "./provider-source-admin-read-repository.ts";
import { ProviderSourceCursorRepository } from "./provider-source-cursor-repository.ts";
import { ProviderSourceDiagnosticRepository } from
  "./provider-source-diagnostic-repository.ts";
import { ProviderSourceLifecycleRepository } from "./provider-source-lifecycle-repository.ts";
import { providerSourceTransactionTime } from "./provider-source-database-clock.ts";
import {
  advanceSettledPublicWatermark,
  allocatePublicChangeCauses,
  providerPublicEntityKey,
} from "./public-change-settlement-repository.ts";

export class ProviderSourceAdminLifecycleRepository
  extends ProviderSourceAdminReadRepository {
  readonly #lifecycle: ProviderSourceLifecycleRepository;
  readonly #cursors: ProviderSourceCursorRepository;
  readonly #diagnostics: ProviderSourceDiagnosticRepository;

  constructor(database: PackscoutPrismaClient) {
    super(database);
    this.#lifecycle = new ProviderSourceLifecycleRepository(database);
    this.#cursors = new ProviderSourceCursorRepository(database);
    this.#diagnostics = new ProviderSourceDiagnosticRepository(database);
  }

  createSource(input: Readonly<{
    organizationId: string;
    providerId: string;
    connectionProfileId: string;
    sourceTypeKey: string;
    sourceAdapterVersion: string;
    normalizedContractVersion: string;
    mapperKey: string;
    mapperVersion: string;
    identityNamespaceKey: string;
    cursorCodecVersion: string;
    configuration: Readonly<Record<string, unknown>>;
    configurationHash: string;
    recordIdScopes: readonly string[];
    intervalSeconds: number;
    actorKey: string;
    createdAt: Date;
  }>) {
    return this.#lifecycle.createSourceInstanceRevision({
      ...input,
      revisionNumber: 1,
      scheduleRevisionNumber: 1,
    });
  }

  async loadSource(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
  }>) {
    const source = await this.database.provider_source_instances.findFirst({
      where: {
        id: input.sourceInstanceId,
        organization_id: input.organizationId,
        provider_id: input.providerId,
        active_revision_id: { not: null },
      },
    });
    if (!source?.active_revision_id) return null;
    const [provider, revision, profile, schedule, cursor, activeRun] =
      await Promise.all([
        this.database.provider_sources.findFirst({
          where: {
            id: input.providerId,
            organization_id: input.organizationId,
          },
          select: { platform_key: true },
        }),
        this.database.provider_source_revisions.findFirst({
          where: {
            id: source.active_revision_id,
            organization_id: input.organizationId,
            source_instance_id: source.id,
          },
        }),
        this.database.source_connection_profiles.findFirst({
          where: {
            id: source.connection_profile_id,
            organization_id: input.organizationId,
          },
          select: { active_revision_id: true },
        }),
        this.database.provider_source_schedules.findFirst({
          where: {
            source_instance_id: source.id,
            organization_id: input.organizationId,
          },
        }),
        this.database.provider_source_cursors.findFirst({
          where: {
            source_instance_id: source.id,
            organization_id: input.organizationId,
          },
        }),
        this.database.import_runs.findFirst({
          where: {
            organization_id: input.organizationId,
            source_instance_id: source.id,
            state: { in: ["queued", "running"] },
          },
          select: { id: true },
        }),
      ]);
    if (!provider || !revision || !schedule || !cursor) return null;
    const scheduleRevision =
      await this.database.provider_source_schedule_revisions.findFirst({
        where: {
          id: schedule.active_schedule_revision_id,
          organization_id: input.organizationId,
          source_instance_id: source.id,
        },
      });
    if (!scheduleRevision) return null;
    const scopes = Array.isArray(revision.record_id_scopes_json)
      ? revision.record_id_scopes_json.filter(
          (scope): scope is string => typeof scope === "string",
        )
      : [];
    return {
      organizationId: source.organization_id,
      providerId: source.provider_id,
      provider: provider.platform_key,
      sourceInstanceId: source.id,
      sourceRevisionId: revision.id,
      connectionProfileId: source.connection_profile_id,
      connectionRevisionId: profile?.active_revision_id ?? null,
      sourceTypeKey: revision.source_type_key,
      sourceAdapterVersion: revision.source_adapter_version,
      state: source.state,
      pauseRequested: source.pause_requested_at !== null,
      mapperKey: revision.mapper_key,
      mapperVersion: revision.mapper_version,
      normalizedContractVersion: revision.normalized_contract_version,
      identityNamespaceKey: revision.identity_namespace_key,
      recordIdScopes: scopes,
      scheduleRevisionId: schedule.active_schedule_revision_id,
      intervalSeconds: scheduleRevision.interval_seconds,
      cursorGeneration: cursor.cursor_generation,
      cursorFingerprint: cursor.cursor_fingerprint,
      hasActiveRun: activeRun !== null,
    };
  }

  async requestSourceTest(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    sourceRevisionId: string;
    connectionProfileId: string;
    connectionRevisionId: string;
    requestedByActorKey: string;
    requestedAt: Date;
  }>): Promise<{ readonly jobId: string }> {
    return this.database.$transaction(async (transaction) => {
      await transaction.$queryRaw(Prisma.sql`
        select id from public.provider_sources
        where id = cast(${input.providerId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
        for share
      `);
      const sources = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select id from public.provider_source_instances
        where id = cast(${input.sourceInstanceId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and provider_id = cast(${input.providerId} as uuid)
          and active_revision_id = cast(${input.sourceRevisionId} as uuid)
          and state in ('draft', 'disabled')
        for update
      `);
      const profiles = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        select id from public.source_connection_profiles
        where id = cast(${input.connectionProfileId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and active_revision_id = cast(${input.connectionRevisionId} as uuid)
          and state = 'active'
        for update
      `);
      const revision = await transaction.source_connection_revisions.findFirst({
        where: {
          id: input.connectionRevisionId,
          organization_id: input.organizationId,
          connection_profile_id: input.connectionProfileId,
          state: "active",
          revoked_at: null,
        },
        select: { health_generation: true },
      });
      if (!sources[0] || !profiles[0] || !revision) {
        this.#fenced("Source test pins changed.");
      }
      const existing = await transaction.provider_source_test_jobs.findFirst({
        where: {
          organization_id: input.organizationId,
          source_instance_id: input.sourceInstanceId,
          source_revision_id: input.sourceRevisionId,
          connection_revision_id: input.connectionRevisionId,
          expected_health_generation: revision.health_generation,
          state: { in: ["queued", "running"] },
        },
        select: { id: true },
      });
      if (existing) {
        await this.#audit(
          transaction,
          input,
          "provider_source.request_test_coalesced",
        );
        return { jobId: existing.id };
      }
      const job = await transaction.provider_source_test_jobs.create({
        data: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          source_instance_id: input.sourceInstanceId,
          source_revision_id: input.sourceRevisionId,
          connection_profile_id: input.connectionProfileId,
          connection_revision_id: input.connectionRevisionId,
          expected_health_generation: revision.health_generation,
          requested_by_actor_key: input.requestedByActorKey,
          created_at: input.requestedAt,
        },
        select: { id: true },
      });
      await this.#audit(transaction, input, "provider_source.request_test");
      return { jobId: job.id };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async reviseInterval(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    expectedSourceRevisionId: string;
    expectedScheduleRevisionId: string;
    intervalSeconds: number;
    actorKey: string;
    effectiveAt: Date;
  }>): Promise<{ readonly scheduleRevisionId: string }> {
    return this.database.$transaction(async (transaction) => {
      const locked = await this.#lockSource(transaction, input);
      const schedule = await transaction.provider_source_schedules.findFirst({
        where: {
          source_instance_id: input.sourceInstanceId,
          organization_id: input.organizationId,
          active_schedule_revision_id: input.expectedScheduleRevisionId,
        },
      });
      if (
        !locked ||
        !["draft", "paused", "active"].includes(locked.state) ||
        !schedule
      ) this.#fenced("Source timing changed or is no longer configurable.");
      const previous =
        await transaction.provider_source_schedule_revisions.findFirst({
          where: {
            id: schedule.active_schedule_revision_id,
            organization_id: input.organizationId,
            source_instance_id: input.sourceInstanceId,
          },
          select: { revision_number: true },
        });
      if (!previous) this.#fenced("Source timing revision is missing.");
      const created = await transaction.provider_source_schedule_revisions.create({
        data: {
          organization_id: input.organizationId,
          provider_id: input.providerId,
          source_instance_id: input.sourceInstanceId,
          revision_number: previous.revision_number + 1,
          interval_seconds: input.intervalSeconds,
          freshness_grace_seconds: 900,
          created_by_actor_key: input.actorKey,
          effective_at: input.effectiveAt,
          created_at: input.effectiveAt,
        },
        select: { id: true },
      });
      const activeWork = locked.state === "active"
        ? await transaction.import_runs.findFirst({
            where: {
              organization_id: input.organizationId,
              source_instance_id: input.sourceInstanceId,
              state: { in: ["queued", "running"] },
            },
            select: { id: true },
          })
        : null;
      await transaction.provider_source_schedules.update({
        where: { source_instance_id: input.sourceInstanceId },
        data: {
          active_schedule_revision_id: created.id,
          ...(locked.state === "active" && activeWork === null
            ? {
                next_due_at: new Date(
                  input.effectiveAt.getTime() + input.intervalSeconds * 1_000,
                ),
              }
            : {}),
          updated_at: input.effectiveAt,
        },
      });
      await this.#audit(transaction, input, "provider_source.revise_interval");
      return { scheduleRevisionId: created.id };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async requestPause(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    expectedSourceRevisionId: string;
    actorKey: string;
    requestedAt: Date;
  }>): Promise<{ readonly state: "paused" | "pause_requested" }> {
    return this.database.$transaction(async (transaction) => {
      const source = await this.#lockSource(transaction, input);
      if (source?.state === "paused") {
        await this.#audit(transaction, input, "provider_source.pause_coalesced");
        return { state: "paused" };
      }
      if (source?.state === "active" && source.pauseRequestedAt !== null) {
        await this.#audit(
          transaction,
          input,
          "provider_source.request_pause_coalesced",
        );
        return { state: "pause_requested" };
      }
      if (!source || source.state !== "active") {
        this.#fenced("Only an active source can pause.");
      }
      const running = await transaction.import_runs.findFirst({
        where: {
          organization_id: input.organizationId,
          source_instance_id: input.sourceInstanceId,
          state: "running",
        },
        select: { id: true },
      });
      const databaseNow = await providerSourceTransactionTime(transaction);
      await transaction.import_runs.updateMany({
        where: {
          organization_id: input.organizationId,
          source_instance_id: input.sourceInstanceId,
          state: "queued",
        },
        data: {
          state: "incomplete",
          failure_code: "SOURCE_PAUSED",
          failure_summary: "Source paused before queued work began.",
          finished_at: databaseNow,
        },
      });
      await transaction.provider_source_instances.update({
        where: { id: input.sourceInstanceId },
        data: running
          ? { pause_requested_at: input.requestedAt, updated_at: input.requestedAt }
          : {
              state: "paused",
              pause_requested_at: null,
              paused_at: input.requestedAt,
              updated_at: input.requestedAt,
            },
      });
      const auditEventId = await this.#audit(
        transaction,
        input,
        running ? "provider_source.request_pause" : "provider_source.pause",
      );
      await this.#appendLifecycleDiagnostic(transaction, {
        source,
        auditEventId,
        occurredAt: databaseNow,
        phase: running ? "pause_requested" : "pause_completed",
        safeCode: running ? "PAUSE_REQUESTED" : "SOURCE_PAUSED",
        lifecycleState: running ? "active" : "paused",
      });
      return { state: running ? "pause_requested" : "paused" };
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async resume(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    expectedSourceRevisionId: string;
    actorKey: string;
    resumedAt: Date;
  }>): Promise<void> {
    await this.#transition(input, "resume");
  }

  async disable(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    expectedSourceRevisionId: string;
    actorKey: string;
    disabledAt: Date;
  }>): Promise<void> {
    await this.#transition(input, "disable");
  }

  async resetCursor(input: Readonly<{
    organizationId: string;
    providerId: string;
    sourceInstanceId: string;
    expectedSourceRevisionId: string;
    expectedGeneration: bigint;
    expectedFingerprint: string | null;
    actorKey: string;
    resetAt: Date;
  }>): Promise<bigint> {
    return this.#cursors.reset(input);
  }

  async #transition(
    input: Readonly<{
      organizationId: string;
      providerId: string;
      sourceInstanceId: string;
      expectedSourceRevisionId: string;
      actorKey: string;
      resumedAt?: Date;
      disabledAt?: Date;
    }>,
    command: "resume" | "disable",
  ): Promise<void> {
    await this.database.$transaction(async (transaction) => {
      const provider = await transaction.$queryRaw<Array<{
        platformKey: string;
      }>>(Prisma.sql`
        select platform_key as "platformKey"
        from public.provider_sources
        where id = cast(${input.providerId} as uuid)
          and organization_id = cast(${input.organizationId} as uuid)
          and state = 'active'::public.provider_state
        for update
      `);
      if (!provider[0]) this.#fenced("Provider lifecycle changed.");
      const source = await this.#lockSource(transaction, input);
      const occurredAt = input.resumedAt ?? input.disabledAt;
      if (!source || !occurredAt) this.#fenced("Source lifecycle changed.");
      if (command === "resume") {
        const runtime = await transaction.provider_source_runtime_states.findFirst({
          where: {
            source_instance_id: source.id,
            organization_id: source.organizationId,
            provider_id: source.providerId,
          },
          select: { activity: true },
        });
        if (runtime?.activity === "action_required") {
          this.#fenced("Action-required source must be disabled and tested before resume.");
        }
      }
      if (
        command === "resume" &&
        source.state === "active" &&
        source.pauseRequestedAt === null
      ) {
        await this.#audit(transaction, input, "provider_source.resume_coalesced");
        await this.#publishProviderLifecycle(transaction, {
          source: { ...source, platformKey: provider[0].platformKey },
          state: "active",
          occurredAt,
        });
        return;
      }
      if (command === "disable" && source.state === "disabled") {
        await this.#audit(transaction, input, "provider_source.disable_coalesced");
        return;
      }
      if (command === "resume" && !["paused", "active"].includes(source.state)) {
        this.#fenced("Only a paused source can resume.");
      }
      if (command === "disable" && source.state === "replaced") {
        this.#fenced("A replaced source cannot be disabled again.");
      }
      if (command === "disable") {
        await transaction.import_runs.updateMany({
          where: {
            organization_id: input.organizationId,
            source_instance_id: input.sourceInstanceId,
            state: "queued",
          },
          data: {
            state: "failed",
            failure_code: "SOURCE_DISABLED",
            failure_summary: "Source disabled by an administrator.",
            finished_at: occurredAt,
            lease_owner: null,
            lease_token: null,
            lease_expires_at: null,
          },
        });
        await transaction.$executeRaw(Prisma.sql`
          update public.import_runs run
          set state = 'failed'::public.import_run_state,
              failure_code = 'SOURCE_DISABLED',
              failure_summary = 'Source disabled by an administrator.',
              finished_at = ${occurredAt},
              lease_owner = null,
              lease_token = null,
              lease_expires_at = null
          where run.organization_id = cast(${input.organizationId} as uuid)
            and run.source_instance_id = cast(${input.sourceInstanceId} as uuid)
            and run.state = 'running'::public.import_run_state
            and not exists (
              select 1 from public.source_request_attempts attempt
              where attempt.organization_id = run.organization_id
                and attempt.run_id = run.id
                and attempt.state = 'in_flight'::public.source_request_attempt_state
            )
        `);
      }
      await transaction.provider_source_instances.update({
        where: { id: input.sourceInstanceId },
        data: command === "resume"
          ? {
              state: "active",
              pause_requested_at: null,
              paused_at: null,
              updated_at: occurredAt,
            }
          : {
              state: "disabled",
              pause_requested_at: null,
              disabled_at: occurredAt,
              updated_at: occurredAt,
            },
      });
      if (command === "resume") {
        await transaction.provider_source_schedules.update({
          where: { source_instance_id: input.sourceInstanceId },
          data: { next_due_at: occurredAt, updated_at: occurredAt },
        });
      }
      const auditEventId = await this.#audit(
        transaction,
        input,
        `provider_source.${command}`,
      );
      await this.#appendLifecycleDiagnostic(transaction, {
        source,
        auditEventId,
        occurredAt: await providerSourceTransactionTime(transaction),
        phase: command,
        safeCode: command === "resume" ? "SOURCE_RESUMED" : "SOURCE_DISABLED",
        lifecycleState: command === "resume" ? "active" : "disabled",
      });
      await this.#publishProviderLifecycle(transaction, {
        source: { ...source, platformKey: provider[0].platformKey },
        state: command === "resume" ? "active" : "disabled",
        occurredAt,
      });
    }, PACKSCOUT_TRANSACTION_OPTIONS);
  }

  async #publishProviderLifecycle(
    transaction: Prisma.TransactionClient,
    input: Readonly<{
      source: Readonly<{
        id: string;
        organizationId: string;
        providerId: string;
        sourceRevisionId: string;
        platformKey: string;
        state: "draft" | "paused" | "active" | "disabled" | "replaced";
      }>;
      state: "active" | "disabled";
      occurredAt: Date;
    }>,
  ): Promise<void> {
    const latest = (await transaction.$queryRaw<Array<{
      state: "active" | "disabled" | "archived";
      sourceInstanceId: string | null;
      sourceRevisionId: string | null;
    }>>(Prisma.sql`
      select impact.lifecycle_state::text as state,
             cause.metadata_json->>'sourceInstanceId' as "sourceInstanceId",
             cause.metadata_json->>'sourceRevisionId' as "sourceRevisionId"
      from public.public_change_catalog_impacts as impact
      join public.public_change_causes as cause
        on cause.organization_id = impact.organization_id
       and cause.sequence = impact.cause_sequence
      where impact.organization_id = cast(${input.source.organizationId} as uuid)
        and impact.lifecycle_platform_key = ${input.source.platformKey}
      order by impact.cause_sequence desc
      limit 1
    `))[0];
    const sameSource = latest?.sourceInstanceId === input.source.id &&
      latest.sourceRevisionId === input.source.sourceRevisionId;
    const currentUnattributedLegacySource =
      ["active", "paused"].includes(input.source.state) &&
      latest?.sourceInstanceId === null && latest.sourceRevisionId === null;
    if (input.state === "active" && latest?.state === "active" && sameSource) {
      return;
    }
    if (input.state === "disabled" &&
        (latest?.state !== "active" ||
          (!sameSource && !currentUnattributedLegacySource))) {
      return;
    }
    await allocatePublicChangeCauses(transaction, {
      organizationId: input.source.organizationId,
      changes: [{
        changeKind: input.state === "active" && latest?.state === "active"
          ? "public_configuration"
          : "provider_lifecycle",
        entityKey: providerPublicEntityKey(input.source.providerId),
        sourceKey: input.source.platformKey,
        sourceRevisionKey: input.source.sourceRevisionId,
        metadata: {
          providerId: input.source.providerId,
          platformKey: input.source.platformKey,
          state: input.state,
          sourceInstanceId: input.source.id,
          sourceRevisionId: input.source.sourceRevisionId,
        },
        occurredAt: input.occurredAt,
        catalogImpact: {
          kind: "catalog",
          providerPlatformKeys: input.state === "active"
            ? [input.source.platformKey]
            : [],
          manifestLifecycle: {
            platformKey: input.source.platformKey,
            state: input.state,
          },
        },
      }],
    });
    await advanceSettledPublicWatermark(transaction, {
      organizationId: input.source.organizationId,
      settledAt: input.occurredAt,
    });
  }

  async #lockSource(
    transaction: Prisma.TransactionClient,
    input: Readonly<{
      organizationId: string;
      providerId: string;
      sourceInstanceId: string;
      expectedSourceRevisionId: string;
    }>,
  ) {
    const rows = await transaction.$queryRaw<Array<{
      id: string;
      state: "draft" | "paused" | "active" | "disabled" | "replaced";
      pauseRequestedAt: Date | null;
      sourceTypeKey: string;
      sourceAdapterVersion: string;
      normalizedContractVersion: string;
      organizationId: string;
      providerId: string;
      sourceRevisionId: string;
      connectionProfileId: string;
      connectionRevisionId: string;
    }>>(Prisma.sql`
      select source.id,
             source.state,
             source.pause_requested_at as "pauseRequestedAt",
             revision.source_type_key as "sourceTypeKey",
             revision.source_adapter_version as "sourceAdapterVersion",
             revision.normalized_contract_version as "normalizedContractVersion",
             source.organization_id as "organizationId",
             source.provider_id as "providerId",
             source.active_revision_id as "sourceRevisionId",
             source.connection_profile_id as "connectionProfileId",
             connection_pin.id as "connectionRevisionId"
      from public.provider_source_instances as source
      join public.provider_source_revisions as revision
        on revision.id = source.active_revision_id
       and revision.organization_id = source.organization_id
       and revision.provider_id = source.provider_id
       and revision.source_instance_id = source.id
      join public.source_connection_profiles as profile
        on profile.id = source.connection_profile_id
       and profile.organization_id = source.organization_id
      join lateral (
        select connection_revision.id
        from public.source_connection_revisions as connection_revision
        where connection_revision.organization_id = source.organization_id
          and connection_revision.connection_profile_id = source.connection_profile_id
          and connection_revision.source_type_key = revision.source_type_key
          and connection_revision.source_adapter_version =
            revision.source_adapter_version
        order by
          (connection_revision.id = profile.active_revision_id) desc,
          connection_revision.revision_number desc,
          connection_revision.id
        limit 1
      ) as connection_pin on true
      where source.id = cast(${input.sourceInstanceId} as uuid)
        and source.organization_id = cast(${input.organizationId} as uuid)
        and source.provider_id = cast(${input.providerId} as uuid)
        and source.active_revision_id = cast(${input.expectedSourceRevisionId} as uuid)
      for update of source
    `);
    return rows[0] ?? null;
  }

  async #audit(
    transaction: Prisma.TransactionClient,
    input: Readonly<{
      organizationId: string;
      providerId: string;
      sourceInstanceId: string;
      actorKey?: string;
      requestedByActorKey?: string;
      expectedSourceRevisionId?: string;
      sourceRevisionId?: string;
      requestedAt?: Date;
      effectiveAt?: Date;
      resumedAt?: Date;
      disabledAt?: Date;
    }>,
    action: string,
  ): Promise<string> {
    const actorKey = input.actorKey ?? input.requestedByActorKey;
    const revisionId = input.expectedSourceRevisionId ?? input.sourceRevisionId;
    const occurredAt = input.requestedAt ?? input.effectiveAt ??
      input.resumedAt ?? input.disabledAt;
    if (!actorKey || !revisionId || !occurredAt) {
      throw new PersistenceError("UNSAFE_AUDIT_METADATA", "Audit context is incomplete.");
    }
    const audit = await transaction.audit_events.create({
      data: {
        organization_id: input.organizationId,
        actor_key: actorKey,
        action,
        subject_type: "provider_source",
        subject_id: input.sourceInstanceId,
        outcome: "success",
        metadata_json: { sourceRevisionId: revisionId },
        occurred_at: occurredAt,
      },
      select: { id: true },
    });
    return audit.id;
  }

  async #appendLifecycleDiagnostic(
    transaction: Prisma.TransactionClient,
    input: Readonly<{
      source: Readonly<{
        id: string;
        sourceTypeKey: string;
        sourceAdapterVersion: string;
        normalizedContractVersion: string;
        organizationId: string;
        providerId: string;
        sourceRevisionId: string;
        connectionProfileId: string;
        connectionRevisionId: string;
      }>;
      auditEventId: string;
      occurredAt: Date;
      phase: "pause_requested" | "pause_completed" | "resume" | "disable";
      safeCode: "PAUSE_REQUESTED" | "SOURCE_PAUSED" | "SOURCE_RESUMED" |
        "SOURCE_DISABLED";
      lifecycleState: "active" | "paused" | "disabled";
    }>,
  ): Promise<void> {
    await this.#diagnostics.appendInTransaction(transaction, {
      organizationId: input.source.organizationId,
      scope: "source",
      correlationKind: "lifecycle",
      eventKind: "source_lifecycle",
      severity: input.phase === "disable" ? "warning" : "info",
      phase: input.phase,
      safeCode: input.safeCode,
      occurredAt: input.occurredAt,
      sourceTypeKey: input.source.sourceTypeKey,
      sourceAdapterVersion: input.source.sourceAdapterVersion,
      normalizedContractVersion: input.source.normalizedContractVersion,
      providerId: input.source.providerId,
      sourceInstanceId: input.source.id,
      sourceRevisionId: input.source.sourceRevisionId,
      connectionProfileId: input.source.connectionProfileId,
      connectionRevisionId: input.source.connectionRevisionId,
      auditEventId: input.auditEventId,
      evidence: { lifecycle_state: input.lifecycleState },
    });
  }

  #fenced(message: string): never {
    throw new PersistenceError("SOURCE_FENCED", message);
  }
}
