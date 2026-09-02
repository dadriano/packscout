import { randomUUID } from "node:crypto";
import { Prisma as CentralPrisma } from "../prisma/generated/central/index.js";
import {
  CENTRAL_TRANSACTION_OPTIONS,
  type CentralPrismaClient,
  type CentralQueryClient,
} from "./central-database.ts";
import {
  assertProviderActivityEvent,
  assertProviderHealthObservation,
  assertProviderReleaseCompletedActivity,
  providerActivityEventDigest,
  sanitizeProviderActivityEvidence,
  type ProviderActivityEvidenceValue,
  type ProviderActivityEvent,
  type ProviderLocalHealthObservation,
} from "./provider-activity-contract.ts";
import { PrismaManifestGateIntentRepository } from
  "./manifest-gate-intent-repository.ts";
import { PrismaManifestReconciliationJobRepository } from
  "./manifest-reconciliation-job-repository.ts";
import {
  verifyProviderCompletedPublishPlanRelayProof,
  type ProviderCompletedPublishPlanRelayProof,
  type VerifiedProviderCompletedPublishPlanRelayProof,
} from "./provider-completion-plan-contract.ts";
import { PrismaProviderCompletionPublishPlanRepository } from
  "./provider-completion-publish-plan-repository.ts";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const safeCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;
const protectedTextPattern =
  /(?:authorization|bearer\s+|cookie|credential|cursor|database[_-]?url|password|payload|secret|(?:api|access|refresh|auth)[_-]?token|api[_-]?key|postgres(?:ql)?:\/\/)/i;

export interface ProviderActivityRelayTarget {
  readonly organizationId: string;
  readonly providerId: string;
  readonly providerKey: string;
}

export interface ProviderActivityRelayCursor {
  readonly organizationId: string;
  readonly providerKey: string;
  readonly providerId: string;
}

export interface ProviderActivityRelayTargetPage {
  readonly targets: readonly ProviderActivityRelayTarget[];
  readonly nextCursor: ProviderActivityRelayCursor | null;
}

export interface ProviderActivityObservationReceipt {
  readonly state: "accepted" | "deduplicated";
  readonly eventId: string;
  readonly alertIds: readonly string[];
  readonly receivedAt: Date;
  readonly completionGate: Readonly<{
    readonly providerId: string;
    readonly observedCompletionGeneration: bigint;
    readonly requestedGeneration: bigint;
    readonly acknowledgedGeneration: bigint;
    readonly manifestWakeGeneration: bigint;
    readonly evidenceDigest: string;
    readonly pending: boolean;
  }> | null;
}

export type ProviderLocalReferenceResolution =
  | Readonly<{ status: "resolved"; providerId: string }>
  | Readonly<{ status: "missing" | "ambiguous"; providerId: null }>;

function requireUuid(value: string, field: string): string {
  if (!uuidPattern.test(value)) throw new TypeError(`${field} must be a UUID.`);
  return value;
}

function validInstant(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

async function assertProviderOwnership(
  transaction: CentralQueryClient,
  organizationId: string,
  providerId: string,
): Promise<void> {
  const provider = await transaction.providers.findFirst({
    where: { id: providerId, organization_id: organizationId },
    select: { id: true },
  });
  if (provider === null) {
    throw new Error("Provider activity target is not registered.");
  }
}

async function assertCompletionGenerationConsistent(
  transaction: CentralQueryClient,
  input: Readonly<{
    organizationId: string;
    providerId: string;
    eventId: string;
    eventDigest: string;
    completedThroughChangeSequence: string;
  }>,
): Promise<void> {
  const [lockedProvider] = await transaction.$queryRaw<readonly {
    id: string;
  }[]>(CentralPrisma.sql`
    select id::text as id
    from providers
    where id = ${input.providerId}::uuid
      and organization_id = ${input.organizationId}::uuid
    for update
  `);
  if (!lockedProvider) {
    throw new Error("Provider activity target is not registered.");
  }
  const [existing] = await transaction.$queryRaw<readonly {
    id: string;
    event_digest: string;
  }[]>(CentralPrisma.sql`
    select id::text as id, event_digest
    from provider_activity_events
    where provider_id = ${input.providerId}::uuid
      and event_type = 'provider_release_completed'
      and evidence ->> 'completedThroughChangeSequence' =
        ${input.completedThroughChangeSequence}
    order by received_at, id
    limit 1
  `);
  if (
    existing
    && (
      existing.id !== input.eventId
      || existing.event_digest !== input.eventDigest
    )
  ) {
    throw new Error("Provider completion generation is inconsistent.");
  }
}

function completionProofMatchesEvent(input: Readonly<{
  providerId: string;
  completion: ReturnType<typeof assertProviderReleaseCompletedActivity>;
  proof: VerifiedProviderCompletedPublishPlanRelayProof;
}>): boolean {
  const { completion, proof } = input;
  return proof.providerId === input.providerId.toLowerCase() &&
    proof.providerReleaseId === completion.providerReleaseId.toLowerCase() &&
    proof.publicProviderReleaseId ===
      completion.publicProviderReleaseId.toLowerCase() &&
    proof.providerReleaseFingerprint ===
      completion.providerReleaseFingerprint &&
    proof.catalogVersionId === completion.catalogVersionId.toLowerCase() &&
    proof.catalogContentHash === completion.catalogContentHash &&
    proof.providerReleaseContentHash ===
      completion.providerReleaseContentHash &&
    proof.completedThroughChangeSequence ===
      BigInt(completion.completedThroughChangeSequence) &&
    proof.terminalReceiptSha256 === completion.terminalReceiptSha256 &&
    proof.terminalOperationKind ===
      (completion.state === "complete" ? "finalize" : "confirmReuse");
}

async function observeHealth(
  transaction: CentralQueryClient,
  input: Readonly<{
    organizationId: string;
    providerId: string;
    health: ProviderLocalHealthObservation;
    lastActivityEventId: string | null;
    lastActivityAt: Date | null;
  }>,
): Promise<void> {
  const health = assertProviderHealthObservation(input.health);
  if (health.providerId !== input.providerId) {
    throw new Error("Provider health identity is inconsistent.");
  }
  await transaction.$executeRaw(CentralPrisma.sql`
    insert into provider_health (
      provider_id, organization_id, last_activity_event_id, last_activity_at,
      observed_state, freshness_state, quality_state, consecutive_failures,
      open_quarantine_count, last_attempted_at, last_head_reached_at,
      recovered_at, last_runner_heartbeat_at, latest_failure_code,
      recovery_hint, publication_lag, observed_at, updated_at
    ) values (
      ${input.providerId}::uuid, ${input.organizationId}::uuid,
      ${input.lastActivityEventId}::uuid, ${input.lastActivityAt},
      ${health.observedState}, ${health.freshnessState}, ${health.qualityState},
      ${health.consecutiveFailures}, ${health.openQuarantineCount},
      ${health.lastAttemptedAt}, ${health.lastHeadReachedAt},
      ${health.recoveredAt}, ${health.lastRunnerHeartbeatAt},
      ${health.latestFailureCode}, ${health.recoveryHint},
      ${health.publicationLag}, ${health.observedAt}, clock_timestamp()
    )
    on conflict (provider_id) do update set
      last_activity_event_id = case
        when excluded.last_activity_at is not null and (
          provider_health.last_activity_at is null
          or excluded.last_activity_at > provider_health.last_activity_at
          or (
            excluded.last_activity_at = provider_health.last_activity_at
            and excluded.last_activity_event_id::text
              > provider_health.last_activity_event_id::text
          )
        ) then excluded.last_activity_event_id
        else provider_health.last_activity_event_id
      end,
      last_activity_at = case
        when excluded.last_activity_at is not null and (
          provider_health.last_activity_at is null
          or excluded.last_activity_at > provider_health.last_activity_at
          or (
            excluded.last_activity_at = provider_health.last_activity_at
            and excluded.last_activity_event_id::text
              > provider_health.last_activity_event_id::text
          )
        ) then excluded.last_activity_at
        else provider_health.last_activity_at
      end,
      observed_state = excluded.observed_state,
      freshness_state = excluded.freshness_state,
      quality_state = excluded.quality_state,
      consecutive_failures = excluded.consecutive_failures,
      open_quarantine_count = excluded.open_quarantine_count,
      last_attempted_at = excluded.last_attempted_at,
      last_head_reached_at = excluded.last_head_reached_at,
      recovered_at = excluded.recovered_at,
      last_runner_heartbeat_at = excluded.last_runner_heartbeat_at,
      latest_failure_code = excluded.latest_failure_code,
      recovery_hint = excluded.recovery_hint,
      publication_lag = excluded.publication_lag,
      observed_at = excluded.observed_at,
      row_version = provider_health.row_version + 1,
      updated_at = greatest(
        clock_timestamp(),
        provider_health.updated_at + interval '1 microsecond'
      )
    where excluded.observed_at > provider_health.observed_at
       or (
         excluded.last_activity_at is not null
         and (
           provider_health.last_activity_at is null
           or excluded.last_activity_at > provider_health.last_activity_at
           or (
             excluded.last_activity_at = provider_health.last_activity_at
             and excluded.last_activity_event_id::text
               > provider_health.last_activity_event_id::text
           )
         )
       )
  `);
}

function eventMatches(
  row: Readonly<{
    organization_id: string;
    provider_id: string;
    origin: "provider" | "central";
    event_digest: string;
    event_type: string;
    severity: "info" | "warning" | "critical";
    dedupe_key: string;
    recovery_key: string;
    local_run_id: string | null;
    local_quarantine_id: string | null;
    title: string;
    summary: string;
    evidence: CentralPrisma.JsonValue;
    event_at: Date;
  }>,
  input: Readonly<{
    organizationId: string;
    providerId: string;
    event: ProviderActivityEvent;
  }>,
): boolean {
  const event = input.event;
  return row.organization_id === input.organizationId &&
    row.provider_id === input.providerId &&
    row.origin === "provider" &&
    row.event_digest === event.eventDigest &&
    row.event_type === event.eventType &&
    row.severity === event.severity &&
    row.dedupe_key === event.dedupeKey &&
    row.recovery_key === event.recoveryKey &&
    row.local_run_id === event.localRunId &&
    row.local_quarantine_id === event.localQuarantineId &&
    row.title === event.title &&
    row.summary === event.summary &&
    row.event_at.getTime() === event.eventAt.getTime() &&
    JSON.stringify(sanitizeProviderActivityEvidence(row.evidence)) ===
      JSON.stringify(event.evidence);
}

async function appendDirectProbeEvent(
  transaction: CentralQueryClient,
  input: Readonly<{
    organizationId: string;
    providerId: string;
    state: "reachable" | "unreachable";
    failureCode: string | null;
    observedAt: Date;
  }>,
): Promise<void> {
  const id = randomUUID();
  const eventWithoutDigest = {
    id,
    eventType: input.state === "unreachable"
      ? "provider.database.unreachable"
      : "provider.database.recovered",
    severity: input.state === "unreachable" ? "critical" : "info",
    dedupeKey: "database-reachability",
    recoveryKey: "database-reachability",
    localRunId: null,
    localQuarantineId: null,
    title: input.state === "unreachable"
      ? "Provider database is unreachable"
      : "Provider database recovered",
    summary: input.state === "unreachable"
      ? "A bounded direct probe could not reach the provider database."
      : "A bounded direct probe reached the provider database again.",
    evidence: (input.failureCode === null
      ? { state: input.state }
      : { state: input.state, failureCode: input.failureCode }) as
        Readonly<Record<string, ProviderActivityEvidenceValue>>,
    eventAt: input.observedAt,
  } as const;
  await transaction.provider_activity_events.create({
    data: {
      id,
      organization_id: input.organizationId,
      provider_id: input.providerId,
      origin: "central",
      event_digest: providerActivityEventDigest(eventWithoutDigest),
      event_type: eventWithoutDigest.eventType,
      severity: eventWithoutDigest.severity,
      dedupe_key: eventWithoutDigest.dedupeKey,
      recovery_key: eventWithoutDigest.recoveryKey,
      local_run_id: null,
      local_quarantine_id: null,
      title: eventWithoutDigest.title,
      summary: eventWithoutDigest.summary,
      evidence: eventWithoutDigest.evidence,
      event_at: input.observedAt,
      received_at: input.observedAt,
      created_at: input.observedAt,
    },
  });
}

/**
 * Central observer repository used by the best-effort provider activity relay.
 * It never selects a provider database; provider-local identity is copied as a
 * soft reference and later resolves to one registered provider here.
 */
export class CentralProviderObservationRepository {
  constructor(private readonly central: CentralPrismaClient) {}

  async listRelayTargets(
    input: Readonly<{
      limit: number;
      after: ProviderActivityRelayCursor | null;
      providerId?: string;
    }>,
  ): Promise<ProviderActivityRelayTargetPage> {
    const { limit, after, providerId } = input;
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError("Provider relay target limit is invalid.");
    }
    if (after !== null) {
      requireUuid(after.organizationId, "Relay cursor organization ID");
      requireUuid(after.providerId, "Relay cursor provider ID");
      if (!/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(after.providerKey)) {
        throw new TypeError("Relay cursor provider key is invalid.");
      }
    }
    if (providerId !== undefined) requireUuid(providerId, "Provider ID");
    const rows = await this.central.providers.findMany({
      where: {
        lifecycle: { in: ["active", "disabled"] },
        ...(providerId === undefined ? {} : { id: providerId }),
        ...(after === null ? {} : {
          OR: [
            { organization_id: { gt: after.organizationId } },
            {
              organization_id: after.organizationId,
              provider_key: { gt: after.providerKey },
            },
            {
              organization_id: after.organizationId,
              provider_key: after.providerKey,
              id: { gt: after.providerId },
            },
          ],
        }),
      },
      orderBy: [
        { organization_id: "asc" },
        { provider_key: "asc" },
        { id: "asc" },
      ],
      take: limit,
      select: { organization_id: true, id: true, provider_key: true },
    });
    const targets = rows.map((row) => ({
      organizationId: row.organization_id,
      providerId: row.id,
      providerKey: row.provider_key,
    }));
    const last = targets.at(-1);
    return {
      targets,
      nextCursor: rows.length < limit || last === undefined
        ? null
        : {
            organizationId: last.organizationId,
            providerKey: last.providerKey,
            providerId: last.providerId,
          },
    };
  }

  async observeReachableHealth(input: Readonly<{
    organizationId: string;
    providerId: string;
    health: ProviderLocalHealthObservation;
  }>): Promise<void> {
    requireUuid(input.organizationId, "Organization ID");
    requireUuid(input.providerId, "Provider ID");
    const health = assertProviderHealthObservation(input.health);
    await this.central.$transaction(async (transaction) => {
      await assertProviderOwnership(
        transaction,
        input.organizationId,
        input.providerId,
      );
      const [clock] = await transaction.$queryRaw<readonly {
        probed_at: Date;
      }[]>(CentralPrisma.sql`select clock_timestamp() as probed_at`);
      if (!clock || !validInstant(clock.probed_at)) {
        throw new Error("Central observation clock is unavailable.");
      }
      const [current] = await transaction.$queryRaw<readonly {
        observed_state: string;
        last_direct_probe_at: Date | null;
      }[]>(CentralPrisma.sql`
        select observed_state, last_direct_probe_at
        from provider_health
        where provider_id = ${input.providerId}::uuid
        for update
      `);
      const directProbeIsNewer =
        current?.last_direct_probe_at === null
        || current?.last_direct_probe_at === undefined
        || clock.probed_at > current.last_direct_probe_at;
      if (!directProbeIsNewer) {
        await observeHealth(transaction, {
          ...input,
          health,
          lastActivityEventId: null,
          lastActivityAt: null,
        });
        return;
      }
      if (current?.observed_state === "unreachable") {
        await transaction.$executeRaw(CentralPrisma.sql`
          update provider_health
          set observed_state = ${health.observedState},
              freshness_state = ${health.freshnessState},
              quality_state = ${health.qualityState},
              consecutive_failures = ${health.consecutiveFailures},
              open_quarantine_count = ${health.openQuarantineCount},
              last_attempted_at = ${health.lastAttemptedAt},
              last_head_reached_at = ${health.lastHeadReachedAt},
              recovered_at = ${health.recoveredAt},
              last_runner_heartbeat_at = ${health.lastRunnerHeartbeatAt},
              latest_failure_code = ${health.latestFailureCode},
              recovery_hint = ${health.recoveryHint},
              publication_lag = ${health.publicationLag},
              last_direct_probe_at = ${clock.probed_at},
              observed_at = greatest(
                provider_health.observed_at,
                ${health.observedAt},
                ${clock.probed_at}
              ),
              row_version = row_version + 1,
              updated_at = greatest(
                clock_timestamp(),
                updated_at + interval '1 microsecond'
              )
          where provider_id = ${input.providerId}::uuid
        `);
        await appendDirectProbeEvent(transaction, {
          organizationId: input.organizationId,
          providerId: input.providerId,
          state: "reachable",
          failureCode: null,
          observedAt: clock.probed_at,
        });
        return;
      }
      await observeHealth(transaction, {
        ...input,
        health,
        lastActivityEventId: null,
        lastActivityAt: null,
      });
      await transaction.$executeRaw(CentralPrisma.sql`
        update provider_health
        set last_direct_probe_at = ${clock.probed_at},
            row_version = row_version + 1,
            updated_at = greatest(
              clock_timestamp(),
              updated_at + interval '1 microsecond'
            )
        where provider_id = ${input.providerId}::uuid
          and (
            last_direct_probe_at is null
            or ${clock.probed_at} > last_direct_probe_at
          )
      `);
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  async observeHealth(input: Readonly<{
    organizationId: string;
    providerId: string;
    health: ProviderLocalHealthObservation;
  }>): Promise<void> {
    requireUuid(input.organizationId, "Organization ID");
    requireUuid(input.providerId, "Provider ID");
    await this.central.$transaction(async (transaction) => {
      await assertProviderOwnership(
        transaction,
        input.organizationId,
        input.providerId,
      );
      await observeHealth(transaction, {
        ...input,
        lastActivityEventId: null,
        lastActivityAt: null,
      });
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  async acceptProviderActivity(input: Readonly<{
    organizationId: string;
    providerId: string;
    event: ProviderActivityEvent;
    health: ProviderLocalHealthObservation;
    receivedAt: Date;
    completionProof?: ProviderCompletedPublishPlanRelayProof;
  }>): Promise<ProviderActivityObservationReceipt> {
    requireUuid(input.organizationId, "Organization ID");
    requireUuid(input.providerId, "Provider ID");
    if (!validInstant(input.receivedAt)) {
      throw new TypeError("Provider activity receipt time is invalid.");
    }
    const event = assertProviderActivityEvent(input.event);
    const health = assertProviderHealthObservation(input.health);
    const completion = event.eventType === "provider_release_completed"
      ? assertProviderReleaseCompletedActivity(event)
      : null;
    const completionGeneration = completion === null
      ? null
      : BigInt(completion.completedThroughChangeSequence);
    if ((completion === null) !== (input.completionProof === undefined)) {
      throw new Error("Provider completion publish-plan proof is required exactly once.");
    }
    const completionProof = input.completionProof === undefined
      ? null
      : await verifyProviderCompletedPublishPlanRelayProof(
          input.completionProof,
        );
    if (
      completion !== null && completionProof !== null &&
      !completionProofMatchesEvent({
        providerId: input.providerId,
        completion,
        proof: completionProof,
      })
    ) throw new Error("Provider completion publish-plan proof is inconsistent.");
    const gateRepository = new PrismaManifestGateIntentRepository(this.central);
    const manifestJobs = new PrismaManifestReconciliationJobRepository(
      this.central,
    );
    const planRepository = new PrismaProviderCompletionPublishPlanRepository(
      this.central,
    );
    return this.central.$transaction(async (transaction) => {
      await assertProviderOwnership(
        transaction,
        input.organizationId,
        input.providerId,
      );
      if (completion !== null) {
        await assertCompletionGenerationConsistent(transaction, {
          organizationId: input.organizationId,
          providerId: input.providerId,
          eventId: event.id,
          eventDigest: event.eventDigest,
          completedThroughChangeSequence:
            completion.completedThroughChangeSequence,
        });
      }
      const storedAt = new Date(
        Math.max(input.receivedAt.getTime(), event.eventAt.getTime()),
      );
      const inserted = await transaction.provider_activity_events.createMany({
        data: [{
          id: event.id,
          organization_id: input.organizationId,
          provider_id: input.providerId,
          origin: "provider",
          event_digest: event.eventDigest,
          event_type: event.eventType,
          severity: event.severity,
          dedupe_key: event.dedupeKey,
          recovery_key: event.recoveryKey,
          local_run_id: event.localRunId,
          local_quarantine_id: event.localQuarantineId,
          title: event.title,
          summary: event.summary,
          evidence: event.evidence as CentralPrisma.InputJsonObject,
          event_at: event.eventAt,
          received_at: storedAt,
          created_at: storedAt,
        }],
        skipDuplicates: true,
      });
      const isNew = inserted.count === 1;
      if (!isNew) {
        const existing = await transaction.provider_activity_events.findUnique({
          where: { id: event.id },
        });
        if (
          existing === null ||
          !eventMatches(existing, { ...input, event })
        ) {
          throw new Error("Provider activity immutable identity conflict.");
        }
      }
      if (completionProof !== null) {
        await planRepository.persistAcceptedCompletion({
          eventId: event.id,
          evidenceDigest: event.eventDigest,
          verifiedAt: storedAt,
          proof: completionProof,
        }, transaction);
      }
      await observeHealth(transaction, {
        organizationId: input.organizationId,
        providerId: input.providerId,
        health,
        lastActivityEventId: event.id,
        lastActivityAt: event.eventAt,
      });
      const gateCoalescing = completion === null
        ? null
        : await gateRepository.coalesceProviderSource({
            providerId: input.providerId,
            sourceGeneration: completionGeneration!,
            cause: "provider_completion",
            evidenceDigest: event.eventDigest,
            requestedAt: event.eventAt,
          }, transaction);
      const manifestWake = gateCoalescing === null
        ? null
        : gateCoalescing.advanced
          ? await manifestJobs.requestNextWake({
              cause: "provider_completion",
              requestedAt: event.eventAt,
            }, transaction)
          : await manifestJobs.loadWakeIntent(transaction);
      let completionGate: ProviderActivityObservationReceipt["completionGate"] =
        null;
      if (gateCoalescing !== null) {
        const retainedGate = gateCoalescing.intent;
        if (
          manifestWake === null || completionGeneration === null ||
          retainedGate.requestedGeneration <
            gateCoalescing.sourceGateGeneration ||
          gateCoalescing.sourceEvidenceDigest.length !== 64
        ) throw new Error(
          "Provider completion gate did not retain its evidence.",
        );
        completionGate = {
          providerId: retainedGate.providerId,
          observedCompletionGeneration: completionGeneration,
          requestedGeneration: retainedGate.requestedGeneration,
          acknowledgedGeneration: retainedGate.acknowledgedGeneration,
          manifestWakeGeneration: manifestWake.requestedGeneration,
          evidenceDigest: gateCoalescing.sourceEvidenceDigest,
          pending: retainedGate.pending,
        };
      }
      return {
        state: isNew ? "accepted" : "deduplicated",
        eventId: event.id,
        alertIds: [],
        receivedAt: storedAt,
        completionGate,
      };
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  async recordDirectProbe(input: Readonly<{
    organizationId: string;
    providerId: string;
    state: "reachable" | "unreachable";
    failureCode: string | null;
    retryHint: string | null;
    observedAt: Date;
  }>): Promise<void> {
    requireUuid(input.organizationId, "Organization ID");
    requireUuid(input.providerId, "Provider ID");
    if (
      !validInstant(input.observedAt) ||
      (input.failureCode !== null && !safeCodePattern.test(input.failureCode)) ||
      (input.retryHint !== null && (
        input.retryHint !== input.retryHint.trim() ||
        input.retryHint.length < 1 ||
        input.retryHint.length > 256
      ))
    ) {
      throw new TypeError("Provider direct-probe observation is invalid.");
    }
    const recoveryHint = input.retryHint === null
      ? null
      : protectedTextPattern.test(input.retryHint)
        ? "Review the provider connection and retry."
        : input.retryHint;
    await this.central.$transaction(async (transaction) => {
      await assertProviderOwnership(
        transaction,
        input.organizationId,
        input.providerId,
      );
      const [current] = await transaction.$queryRaw<readonly {
        observed_state: string;
        last_direct_probe_at: Date | null;
      }[]>(CentralPrisma.sql`
        select observed_state, last_direct_probe_at
        from provider_health
        where provider_id = ${input.providerId}::uuid
        for update
      `);
      if (
        current?.last_direct_probe_at !== null &&
        current?.last_direct_probe_at !== undefined &&
        input.observedAt <= current.last_direct_probe_at
      ) {
        return;
      }
      await transaction.$executeRaw(CentralPrisma.sql`
        insert into provider_health (
          provider_id, organization_id, observed_state, freshness_state,
          quality_state, latest_failure_code, recovery_hint,
          last_direct_probe_at, observed_at, updated_at
        ) values (
          ${input.providerId}::uuid, ${input.organizationId}::uuid,
          ${input.state}, 'unknown', 'unknown', ${input.failureCode},
          ${recoveryHint}, ${input.observedAt}, ${input.observedAt},
          clock_timestamp()
        )
        on conflict (provider_id) do update set
          observed_state = excluded.observed_state,
          latest_failure_code = excluded.latest_failure_code,
          recovery_hint = excluded.recovery_hint,
          last_direct_probe_at = excluded.last_direct_probe_at,
          observed_at = greatest(
            provider_health.observed_at,
            excluded.observed_at
          ),
          row_version = provider_health.row_version + 1,
          updated_at = greatest(
            clock_timestamp(),
            provider_health.updated_at + interval '1 microsecond'
          )
        where provider_health.last_direct_probe_at is null
           or excluded.last_direct_probe_at > provider_health.last_direct_probe_at
      `);
      if (current?.observed_state === input.state) return;

      await appendDirectProbeEvent(transaction, input);
    }, CENTRAL_TRANSACTION_OPTIONS);
  }

  resolveRunProvider(input: Readonly<{
    organizationId: string;
    localRunId: string;
  }>): Promise<ProviderLocalReferenceResolution> {
    return this.resolveLocalReference({
      organizationId: input.organizationId,
      column: "local_run_id",
      localId: input.localRunId,
    });
  }

  resolveQuarantineProvider(input: Readonly<{
    organizationId: string;
    localQuarantineId: string;
  }>): Promise<ProviderLocalReferenceResolution> {
    return this.resolveLocalReference({
      organizationId: input.organizationId,
      column: "local_quarantine_id",
      localId: input.localQuarantineId,
    });
  }

  private async resolveLocalReference(input: Readonly<{
    organizationId: string;
    column: "local_run_id" | "local_quarantine_id";
    localId: string;
  }>): Promise<ProviderLocalReferenceResolution> {
    requireUuid(input.organizationId, "Organization ID");
    requireUuid(input.localId, "Provider local reference");
    const localColumn = input.column === "local_run_id"
      ? CentralPrisma.sql`local_run_id`
      : CentralPrisma.sql`local_quarantine_id`;
    const rows = await this.central.$queryRaw<readonly { provider_id: string }[]>(
      CentralPrisma.sql`
        select distinct provider_id
        from provider_activity_events
        where organization_id = ${input.organizationId}::uuid
          and ${localColumn} = ${input.localId}::uuid
        limit 2
      `,
    );
    if (rows.length === 0) return { status: "missing", providerId: null };
    if (rows.length > 1) return { status: "ambiguous", providerId: null };
    return { status: "resolved", providerId: rows[0]!.provider_id };
  }
}
