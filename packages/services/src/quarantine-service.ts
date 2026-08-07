import {
  catalogEnvelopeV1Schema,
  pullEnvelopeV1Schema,
  quarantineIdSchema,
  quarantineListQuerySchema,
  quarantineRetryBulkRequestSchema,
  saleEnvelopeV1Schema,
  type CatalogEnvelopeV1,
  type NormalizedQuarantineListQuery,
  type ProviderFeedEnvelopeV1,
  type ProviderFeedPageV1,
  type PullEnvelopeV1,
  type QuarantineAttemptSummary,
  type QuarantineCounts,
  type QuarantineEntryDetail,
  type QuarantineEntrySummary,
  type QuarantineListQuery,
  type QuarantineRetryBulkRequest,
  type QuarantineRetryOutcome,
  type QuarantineServiceErrorCode,
  type SaleEnvelopeV1,
} from "@packscout/contracts";
import {
  ProviderAdapterRegistryError,
  ProviderMappingAdapterRegistry,
} from "./provider-adapter-registry.ts";
import type {
  ProviderConfigurationIdentity,
  ProviderRecordKind,
  ProviderRecordMappingOutcome,
  ProviderSourceIdentity,
} from "./provider-adapter.ts";
import type {
  ProviderActor,
  ProviderActorKeyer,
  ProviderClock,
  ProviderIdSource,
} from "./provider-configuration-service.ts";
import type {
  ProviderCanonicalProjectionCommand,
  ProviderProjectionPort,
} from "./provider-import-types.ts";
import type {
  OperationalEventService,
  PipelineOperationalReporter,
} from "./operational-events.ts";

const MAX_EXTERNAL_ID_LENGTH = 256;
const MAX_SUMMARY_LENGTH = 500;
const MAX_FIELD_PATH_LENGTH = 256;
const safeCodePattern = /^[A-Z][A-Z0-9_]{0,127}$/;

export interface StoredQuarantineAttempt {
  readonly id: string;
  readonly state: "running" | "succeeded" | "failed";
  readonly failureCode: string | null;
  readonly fieldPath: string | null;
  readonly sanitizedSummary: string | null;
  readonly canonicalRevisionCount: number | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

export interface StoredQuarantineEntry {
  readonly id: string;
  readonly providerId: string;
  readonly configurationRevisionId: string;
  readonly platformKey: string;
  readonly adapterKey: string;
  readonly runId: string;
  readonly pageId: string;
  readonly sourceRecordId: string | null;
  readonly recordKind: ProviderRecordKind;
  readonly recordIndex: number;
  readonly externalId: string | null;
  readonly reasonCode: string;
  readonly fieldPath: string | null;
  readonly sanitizedSummary: string;
  readonly state: "open" | "retrying" | "resolved" | "expired";
  readonly retryCount: number;
  readonly createdAt: Date;
  readonly lastRetryAt: Date | null;
  readonly expiresAt: Date;
  readonly resolvedAt: Date | null;
  readonly resolutionSummary: string | null;
}

export interface ProtectedQuarantineEvidence {
  /** Server-only retained evidence. This value must never enter a DTO or error. */
  readonly rawRecord: unknown;
  readonly organizationId: string;
  readonly sourceRecordId: string | null;
  readonly source: ProviderSourceIdentity | null;
  readonly runId: string;
  readonly pageId: string;
  readonly recordKind: ProviderRecordKind;
  readonly recordIndex: number;
  readonly expiresAt: Date;
  readonly configuration: ProviderConfigurationIdentity;
}

export type QuarantineClaimResult =
  | {
      readonly kind: "claimed";
      readonly attemptId: string;
      readonly entry: StoredQuarantineEntry;
      readonly evidence: ProtectedQuarantineEvidence;
    }
  | {
      readonly kind: "already_retrying" | "already_resolved" | "expired";
      readonly entry: StoredQuarantineEntry;
    }
  | { readonly kind: "not_found" };

export interface QuarantineRepository {
  listEntries(
    organizationId: string,
    query: NormalizedQuarantineListQuery,
    now: Date,
  ): Promise<readonly StoredQuarantineEntry[]>;
  getEntry(
    organizationId: string,
    quarantineId: string,
    now: Date,
  ): Promise<StoredQuarantineEntry | null>;
  listAttempts(
    organizationId: string,
    quarantineId: string,
  ): Promise<readonly StoredQuarantineAttempt[]>;
  countEntries(organizationId: string, now: Date): Promise<QuarantineCounts>;
  claimRetry(input: {
    organizationId: string;
    quarantineId: string;
    attemptId: string;
    actorKey: string;
    claimedAt: Date;
  }): Promise<QuarantineClaimResult>;
  completeRetry(input: {
    organizationId: string;
    quarantineId: string;
    attemptId: string;
    actorKey: string;
    completedAt: Date;
    canonicalRevisionCount: number;
  }): Promise<StoredQuarantineEntry | null>;
  failRetry(input: {
    organizationId: string;
    quarantineId: string;
    attemptId: string;
    actorKey: string;
    failedAt: Date;
    failureCode: string;
    fieldPath: string | null;
    sanitizedSummary: string;
  }): Promise<StoredQuarantineEntry | null>;
  expireEvidence(input: {
    organizationId: string;
    before: Date;
    expiredAt: Date;
    batchSize: number;
  }): Promise<number>;
}

export interface QuarantineProjectionRepository {
  projectSourceRecord(input: {
    organizationId: string;
    providerId: string;
    configurationRevisionId: string;
    quarantineId: string;
    attemptId: string;
    sourceRecordId: string;
    projections: readonly ProviderCanonicalProjectionCommand[];
    acceptedAt: Date;
  }): Promise<{ readonly canonicalRevisionCount: number }>;
  materializeAndProjectSourceRecord(input: {
    organizationId: string;
    providerId: string;
    configurationRevisionId: string;
    quarantineId: string;
    attemptId: string;
    runId: string;
    pageId: string;
    recordKind: ProviderRecordKind;
    recordIndex: number;
    externalId: string;
    sourceTime: Date;
    collectedAt: Date;
    payload: Record<string, unknown>;
    expiresAt: Date;
    projections: readonly ProviderCanonicalProjectionCommand[];
    acceptedAt: Date;
  }): Promise<{
    readonly sourceRecordId: string;
    readonly canonicalRevisionCount: number;
  }>;
}

export interface QuarantineServiceDependencies {
  readonly repository: QuarantineRepository;
  readonly projectionRepository: QuarantineProjectionRepository;
  readonly mappings: ProviderMappingAdapterRegistry;
  readonly projections: ProviderProjectionPort;
  readonly actorKeyer: ProviderActorKeyer;
  readonly clock: ProviderClock;
  readonly ids: ProviderIdSource;
  readonly operational?: QuarantineOperationalHooks;
}

export interface QuarantineOperationalHooks {
  readonly events: Pick<
    OperationalEventService,
    "quarantineExpired" | "quarantineResolved"
  >;
  readonly reporter: Pick<PipelineOperationalReporter, "retry">;
}

export class QuarantineServiceError extends Error {
  constructor(
    readonly code: QuarantineServiceErrorCode,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "QuarantineServiceError";
  }
}

function bounded(value: string | null, maximum: number): string | null {
  return value === null ? null : value.slice(0, maximum);
}

function safeCode(value: string, fallback: string): string {
  return safeCodePattern.test(value) ? value : fallback;
}

function toSummary(entry: StoredQuarantineEntry): QuarantineEntrySummary {
  return {
    id: entry.id,
    providerId: entry.providerId,
    configurationRevisionId: entry.configurationRevisionId,
    platformKey: bounded(entry.platformKey, 128)!,
    runId: entry.runId,
    pageId: entry.pageId,
    recordKind: entry.recordKind,
    recordIndex: entry.recordIndex,
    externalId: bounded(entry.externalId, MAX_EXTERNAL_ID_LENGTH),
    reasonCode: safeCode(entry.reasonCode, "QUARANTINE_REASON_UNAVAILABLE"),
    fieldPath: bounded(entry.fieldPath, MAX_FIELD_PATH_LENGTH),
    sanitizedSummary:
      bounded(entry.sanitizedSummary, MAX_SUMMARY_LENGTH) ??
      "A provider record is quarantined.",
    state: entry.state,
    attemptCount: entry.retryCount,
    firstFailureAt: entry.createdAt.toISOString(),
    latestFailureAt: (entry.lastRetryAt ?? entry.createdAt).toISOString(),
    rawExpiresAt: entry.expiresAt.toISOString(),
    resolvedAt: entry.resolvedAt?.toISOString() ?? null,
    resolutionSummary: bounded(entry.resolutionSummary, MAX_SUMMARY_LENGTH),
  };
}

function toAttempt(attempt: StoredQuarantineAttempt): QuarantineAttemptSummary {
  return {
    id: attempt.id,
    state: attempt.state,
    failureCode:
      attempt.failureCode === null
        ? null
        : safeCode(attempt.failureCode, "RETRY_FAILURE_UNAVAILABLE"),
    fieldPath: bounded(attempt.fieldPath, MAX_FIELD_PATH_LENGTH),
    sanitizedSummary: bounded(attempt.sanitizedSummary, MAX_SUMMARY_LENGTH),
    canonicalRevisionCount: attempt.canonicalRevisionCount,
    startedAt: attempt.startedAt.toISOString(),
    finishedAt: attempt.finishedAt?.toISOString() ?? null,
  };
}

function actorKey(actor: ProviderActor, keyer: ProviderActorKeyer): string {
  if (actor.role !== "admin" && actor.role !== "data_operator") {
    throw new QuarantineServiceError(
      "FORBIDDEN",
      "You do not have permission to operate quarantine records.",
      403,
    );
  }
  return keyer.keyFor({
    organizationId: actor.organizationId,
    operatorId: actor.operatorId,
  });
}

function issuePath(error: { issues: readonly { path: readonly PropertyKey[] }[] }): string | null {
  const path = error.issues[0]?.path;
  if (!path || path.length === 0) return null;
  return bounded(path.map(String).join("."), MAX_FIELD_PATH_LENGTH);
}

function sourceMatches(
  expected: ProviderSourceIdentity,
  actual: ProviderSourceIdentity,
): boolean {
  return (
    expected.platform === actual.platform &&
    expected.recordKind === actual.recordKind &&
    expected.recordIndex === actual.recordIndex &&
    expected.externalId === actual.externalId &&
    Date.parse(expected.collectedAt) === Date.parse(actual.collectedAt) &&
    Date.parse(expected.sourceTimestamp) === Date.parse(actual.sourceTimestamp)
  );
}

interface ValidatedRetryEvidence {
  readonly rawRecord: ProviderFeedEnvelopeV1;
  readonly source: ProviderSourceIdentity;
}

interface RetryFailure {
  readonly code: string;
  readonly fieldPath: string | null;
  readonly summary: string;
}

function retryPage(
  recordKind: ProviderRecordKind,
  rawRecord: ProviderFeedEnvelopeV1,
): ProviderFeedPageV1 {
  return {
    catalog:
      recordKind === "catalog" ? [rawRecord as CatalogEnvelopeV1] : [],
    pulls: recordKind === "pull" ? [rawRecord as PullEnvelopeV1] : [],
    sales: recordKind === "sale" ? [rawRecord as SaleEnvelopeV1] : [],
    next_cursor: "quarantine-retry",
    has_more: false,
  };
}

export class QuarantineService {
  constructor(private readonly dependencies: QuarantineServiceDependencies) {}

  async list(
    actor: ProviderActor,
    input: QuarantineListQuery,
  ): Promise<readonly QuarantineEntrySummary[]> {
    actorKey(actor, this.dependencies.actorKeyer);
    const parsed = quarantineListQuerySchema.safeParse(input);
    if (!parsed.success) this.throwInvalidRequest();
    const entries = await this.dependencies.repository.listEntries(
      actor.organizationId,
      parsed.data,
      this.dependencies.clock.now(),
    );
    return entries.map(toSummary);
  }

  async detail(
    actor: ProviderActor,
    quarantineId: string,
  ): Promise<QuarantineEntryDetail> {
    actorKey(actor, this.dependencies.actorKeyer);
    if (!quarantineIdSchema.safeParse(quarantineId).success) {
      this.throwInvalidRequest();
    }
    const entry = await this.dependencies.repository.getEntry(
      actor.organizationId,
      quarantineId,
      this.dependencies.clock.now(),
    );
    if (!entry) {
      throw new QuarantineServiceError(
        "QUARANTINE_NOT_FOUND",
        "Quarantine entry not found.",
        404,
      );
    }
    const attempts = await this.dependencies.repository.listAttempts(
      actor.organizationId,
      quarantineId,
    );
    return { ...toSummary(entry), attempts: attempts.map(toAttempt) };
  }

  async counts(actor: ProviderActor): Promise<QuarantineCounts> {
    actorKey(actor, this.dependencies.actorKeyer);
    return this.dependencies.repository.countEntries(
      actor.organizationId,
      this.dependencies.clock.now(),
    );
  }

  async retryOne(
    actor: ProviderActor,
    quarantineId: string,
  ): Promise<QuarantineRetryOutcome> {
    const requestedByActorKey = actorKey(actor, this.dependencies.actorKeyer);
    if (!quarantineIdSchema.safeParse(quarantineId).success) {
      this.throwInvalidRequest();
    }
    const attemptId = this.dependencies.ids.id();
    const claim = await this.dependencies.repository.claimRetry({
      organizationId: actor.organizationId,
      quarantineId,
      attemptId,
      actorKey: requestedByActorKey,
      claimedAt: this.dependencies.clock.now(),
    });
    if (claim.kind !== "claimed") {
      return this.withOperationalOutcome(actor.organizationId, {
        quarantineId,
        outcome: claim.kind,
        entry: claim.kind === "not_found" ? null : toSummary(claim.entry),
      }, claim.kind === "expired" ? "expired" : null);
    }
    const validation = this.retryEvidence(claim.evidence);
    if ("failure" in validation) {
      const entry = await this.dependencies.repository.failRetry({
        organizationId: actor.organizationId,
        quarantineId,
        attemptId,
        actorKey: requestedByActorKey,
        failedAt: this.dependencies.clock.now(),
        failureCode: validation.failure.code,
        fieldPath: validation.failure.fieldPath,
        sanitizedSummary: validation.failure.summary,
      });
      return this.withOperationalOutcome(actor.organizationId, {
        quarantineId,
        outcome: entry?.state === "expired" ? "expired" : "failed",
        entry: entry ? toSummary(entry) : null,
      }, entry?.state === "expired" ? "expired" : null);
    }
    const projected = await this.projectClaimedEvidence(
      claim.evidence,
      validation.validated,
      quarantineId,
      attemptId,
    );
    if ("failure" in projected) {
      const entry = await this.dependencies.repository.failRetry({
        organizationId: actor.organizationId,
        quarantineId,
        attemptId,
        actorKey: requestedByActorKey,
        failedAt: this.dependencies.clock.now(),
        failureCode: projected.failure.code,
        fieldPath: projected.failure.fieldPath,
        sanitizedSummary: projected.failure.summary,
      });
      return this.withOperationalOutcome(actor.organizationId, {
        quarantineId,
        outcome: entry?.state === "expired" ? "expired" : "failed",
        entry: entry ? toSummary(entry) : null,
      }, entry?.state === "expired" ? "expired" : null);
    }
    const entry = await this.dependencies.repository.completeRetry({
      organizationId: actor.organizationId,
      quarantineId,
      attemptId,
      actorKey: requestedByActorKey,
      completedAt: this.dependencies.clock.now(),
      canonicalRevisionCount: projected.canonicalRevisionCount,
    });
    return this.withOperationalOutcome(actor.organizationId, {
      quarantineId,
      outcome:
        entry?.state === "resolved"
          ? "resolved"
          : entry?.state === "expired"
            ? "expired"
            : "failed",
      entry: entry ? toSummary(entry) : null,
    }, entry?.state === "resolved" ? "resolved" : entry?.state === "expired" ? "expired" : null);
  }

  async retryMany(
    actor: ProviderActor,
    input: QuarantineRetryBulkRequest,
  ): Promise<readonly QuarantineRetryOutcome[]> {
    actorKey(actor, this.dependencies.actorKeyer);
    const parsed = quarantineRetryBulkRequestSchema.safeParse(input);
    if (!parsed.success) this.throwInvalidRequest();
    const outcomes: QuarantineRetryOutcome[] = [];
    for (const quarantineId of parsed.data.quarantineIds) {
      outcomes.push(await this.retryOne(actor, quarantineId));
    }
    return outcomes;
  }

  async expireEvidence(actor: ProviderActor, before: Date, batchSize: number): Promise<number> {
    actorKey(actor, this.dependencies.actorKeyer);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) {
      this.throwInvalidRequest();
    }
    return this.dependencies.repository.expireEvidence({
      organizationId: actor.organizationId,
      before,
      expiredAt: this.dependencies.clock.now(),
      batchSize,
    });
  }

  private retryEvidence(evidence: ProtectedQuarantineEvidence):
    | { validated: ValidatedRetryEvidence }
    | { failure: RetryFailure } {
    const schema =
      evidence.recordKind === "catalog"
          ? catalogEnvelopeV1Schema
          : evidence.recordKind === "pull"
            ? pullEnvelopeV1Schema
            : evidence.recordKind === "sale"
              ? saleEnvelopeV1Schema
              : null;
    if (!schema) {
      return {
        failure: {
          code: "SOURCE_REFERENCE_UNAVAILABLE",
          fieldPath: null,
          summary: "Retained evidence does not have a retryable record kind.",
        },
      };
    }
    const parsed = schema.safeParse(evidence.rawRecord);
    if (!parsed.success || parsed.data.platform !== evidence.configuration.platform) {
      return {
        failure: {
          code: "ENVELOPE_VALIDATION_FAILED",
          fieldPath: parsed.success ? "platform" : issuePath(parsed.error),
          summary: "Retained evidence still fails envelope validation.",
        },
      };
    }
    const source: ProviderSourceIdentity = {
      platform: parsed.data.platform,
      recordKind: evidence.recordKind,
      recordIndex: evidence.recordIndex,
      externalId: parsed.data.external_id,
      collectedAt: parsed.data.collected_at,
      sourceTimestamp:
        "updated_at" in parsed.data
          ? parsed.data.updated_at
          : parsed.data.occurred_at,
    };
    if (evidence.source && !sourceMatches(evidence.source, source)) {
      return {
        failure: {
          code: "SOURCE_IDENTITY_MISMATCH",
          fieldPath: null,
          summary: "Retained evidence does not match its protected source identity.",
        },
      };
    }
    return { validated: { rawRecord: parsed.data, source } };
  }

  private async projectClaimedEvidence(
    evidence: ProtectedQuarantineEvidence,
    validated: ValidatedRetryEvidence,
    quarantineId: string,
    attemptId: string,
  ): Promise<
    | { canonicalRevisionCount: number }
    | { failure: { code: string; fieldPath: string | null; summary: string } }
  > {
    const source = validated.source;
    let mapper;
    try {
      mapper = this.dependencies.mappings.resolveForPlatform(
        evidence.configuration.platform,
      );
    } catch (error) {
      if (!(error instanceof ProviderAdapterRegistryError)) throw error;
      return {
        failure: {
          code: "MAPPER_UNAVAILABLE",
          fieldPath: null,
          summary: "The current provider mapper is unavailable.",
        },
      };
    }
    const page = retryPage(source.recordKind, validated.rawRecord);
    const mappingConfiguration = {
      ...evidence.configuration,
      adapterKey: mapper.key,
    };
    let mapping: { readonly outcomes: readonly ProviderRecordMappingOutcome[] };
    try {
      mapping = await mapper.mapPage({
        configuration: mappingConfiguration,
        page,
        recordIndexes: {
          catalog: source.recordKind === "catalog" ? [source.recordIndex] : [],
          pulls: source.recordKind === "pull" ? [source.recordIndex] : [],
          sales: source.recordKind === "sale" ? [source.recordIndex] : [],
        },
      });
    } catch {
      return {
        failure: {
          code: "MAPPING_FAILED",
          fieldPath: null,
          summary: "The current provider mapper could not process retained evidence.",
        },
      };
    }
    const outcome = mapping.outcomes[0];
    if (
      mapping.outcomes.length !== 1 ||
      !outcome ||
      !sourceMatches(source, outcome.source)
    ) {
      return {
        failure: {
          code: "MAPPING_OUTPUT_INVALID",
          fieldPath: null,
          summary: "The current provider mapper returned an invalid outcome.",
        },
      };
    }
    if (outcome.status === "invalid") {
      return {
        failure: {
          code: safeCode(outcome.failure.reasonCode, "MAPPING_REJECTED"),
          fieldPath: bounded(outcome.failure.fieldPath, MAX_FIELD_PATH_LENGTH),
          summary: "Retained evidence still fails provider mapping.",
        },
      };
    }
    if (outcome.candidates.some((candidate) => !sourceMatches(source, candidate.source))) {
      return {
        failure: {
          code: "MAPPING_OUTPUT_INVALID",
          fieldPath: null,
          summary: "The current provider mapper returned an invalid source reference.",
        },
      };
    }
    let projected;
    try {
      projected = await this.dependencies.projections.project({
        configuration: mappingConfiguration,
        source,
        candidates: outcome.candidates,
      });
    } catch {
      return {
        failure: {
          code: "PROJECTION_FAILED",
          fieldPath: null,
          summary: "Retained evidence could not be projected.",
        },
      };
    }
    if (projected.status === "invalid") {
      return {
        failure: {
          code: safeCode(projected.reasonCode, "PROJECTION_REJECTED"),
          fieldPath: bounded(projected.fieldPath ?? null, MAX_FIELD_PATH_LENGTH),
          summary: "Retained evidence still fails canonical projection.",
        },
      };
    }
    try {
      const acceptedAt = this.dependencies.clock.now();
      if (evidence.sourceRecordId) {
        return await this.dependencies.projectionRepository.projectSourceRecord({
          organizationId: evidence.organizationId,
          providerId: evidence.configuration.providerId,
          configurationRevisionId: evidence.configuration.configurationRevisionId,
          quarantineId,
          attemptId,
          sourceRecordId: evidence.sourceRecordId,
          projections: projected.projections,
          acceptedAt,
        });
      }
      return await this.dependencies.projectionRepository.materializeAndProjectSourceRecord({
        organizationId: evidence.organizationId,
        providerId: evidence.configuration.providerId,
        configurationRevisionId: evidence.configuration.configurationRevisionId,
        quarantineId,
        attemptId,
        runId: evidence.runId,
        pageId: evidence.pageId,
        recordKind: evidence.recordKind,
        recordIndex: evidence.recordIndex,
        externalId: source.externalId,
        sourceTime: new Date(source.sourceTimestamp),
        collectedAt: new Date(source.collectedAt),
        payload: validated.rawRecord,
        expiresAt: evidence.expiresAt,
        projections: projected.projections,
        acceptedAt,
      });
    } catch {
      return {
        failure: {
          code: "PROJECTION_PERSISTENCE_FAILED",
          fieldPath: null,
          summary: "Canonical projection could not be durably committed.",
        },
      };
    }
  }

  private async withOperationalOutcome(
    organizationId: string,
    outcome: QuarantineRetryOutcome,
    transition: "expired" | "resolved" | null,
  ): Promise<QuarantineRetryOutcome> {
    const operational = this.dependencies.operational;
    const entry = outcome.entry;
    if (!operational || !entry) return outcome;
    const metricOutcome =
      outcome.outcome === "resolved" || outcome.outcome === "already_resolved"
        ? "RESOLVED"
        : outcome.outcome === "expired"
          ? "EXPIRED"
          : outcome.outcome === "already_retrying"
            ? "CONFLICT"
            : "FAILED";
    try {
      operational.reporter.retry({
        organizationId,
        providerId: entry.providerId,
        outcome: metricOutcome,
      });
    } catch {
      // Retry state is authoritative even when metrics are unavailable.
    }
    if (transition === "resolved" && outcome.outcome === "resolved") {
      try {
        await operational.events.quarantineResolved({
          organizationId,
          providerId: entry.providerId,
          quarantineId: outcome.quarantineId,
        });
      } catch {
        // A committed retry resolution must not be rolled back by delivery.
      }
    } else if (transition === "expired" && outcome.outcome === "expired") {
      try {
        await operational.events.quarantineExpired({
          organizationId,
          providerId: entry.providerId,
          quarantineId: outcome.quarantineId,
          reasonCode: "SOURCE_RETENTION_EXPIRED",
        });
      } catch {
        // Expiry remains final when operational delivery is unavailable.
      }
    }
    return outcome;
  }

  private throwInvalidRequest(): never {
    throw new QuarantineServiceError(
      "INVALID_QUARANTINE_REQUEST",
      "Quarantine request is invalid.",
      422,
    );
  }
}
