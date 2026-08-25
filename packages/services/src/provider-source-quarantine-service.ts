import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
  normalizedObservationSemanticCanonicalJson,
  normalizedObservationSemanticCanonicalJsonV2,
  normalizedObservationSemanticContent,
  normalizedObservationSemanticContentV2,
  normalizedProviderObservationSchema,
  normalizedProviderObservationV2Schema,
  quarantineIdSchema,
  quarantineRetryBulkRequestSchema,
  type LaunchProviderKey,
  type ProviderSourceCanonicalProjectionPlan,
  type QuarantineAttemptSummary,
  type QuarantineEntryDetail,
  type QuarantineEntrySummary,
  type QuarantineRetryBulkRequest,
  type QuarantineRetryOutcome,
  type VersionedNormalizedObservationSemanticContent,
  type VersionedNormalizedProviderObservation,
} from "@packscout/contracts";
import type {
  ProviderActor,
  ProviderActorKeyer,
  ProviderClock,
  ProviderIdSource,
} from "./provider-configuration-service.ts";
import type {
  ProviderObservationMapperResolver,
} from "./provider-source-page-planner.ts";
import {
  providerObservationMappingOutcomeFromRuntime,
  providerSourceCanonicalProjectionsForValidatedMapping,
} from "./provider-source-page-planner.ts";
import { QuarantineServiceError } from "./quarantine-service.ts";

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

export interface StoredProviderSourceQuarantineEntry {
  readonly id: string;
  readonly organizationId: string;
  readonly providerId: string;
  readonly sourceRevisionId: string;
  readonly platformKey: LaunchProviderKey;
  readonly runId: string;
  readonly pageId: string;
  readonly recordKind: "catalog" | "pull" | "trade" | "unknown";
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

export interface StoredProviderSourceQuarantineAttempt {
  readonly id: string;
  readonly state: "running" | "succeeded" | "failed";
  readonly failureCode: string | null;
  readonly fieldPath: string | null;
  readonly sanitizedSummary: string | null;
  readonly canonicalRevisionCount: number | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

interface ProtectedProviderSourceQuarantineEvidence {
  readonly normalizedObservation: unknown;
  readonly evidence: unknown;
  readonly semanticContent:
    VersionedNormalizedObservationSemanticContent | null;
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

type SourceClaimResult =
  | Readonly<{
      kind: "claimed";
      attemptId: string;
      entry: StoredProviderSourceQuarantineEntry;
      evidence: ProtectedProviderSourceQuarantineEvidence;
    }>
  | Readonly<{
      kind: "already_retrying" | "already_resolved" | "expired";
      entry: StoredProviderSourceQuarantineEntry;
    }>
  | Readonly<{ kind: "not_found" }>;

interface SourceCompletionResult {
  readonly kind: "resolved" | "failed" | "expired" | "not_found";
  readonly entry: StoredProviderSourceQuarantineEntry | null;
  readonly canonicalRevisionCount: number;
}

export interface ProviderSourceQuarantineServiceRepository {
  getEntry(
    organizationId: string,
    quarantineId: string,
    now: Date,
  ): Promise<StoredProviderSourceQuarantineEntry | null>;
  listAttempts(
    organizationId: string,
    quarantineId: string,
  ): Promise<readonly StoredProviderSourceQuarantineAttempt[]>;
  claimRetry(input: Readonly<{
    organizationId: string;
    quarantineId: string;
    attemptId: string;
    actorKey: string;
    claimedAt: Date;
  }>): Promise<SourceClaimResult>;
  completeRetry(input: Readonly<{
    organizationId: string;
    quarantineId: string;
    attemptId: string;
    actorKey: string;
    provider: LaunchProviderKey;
    projections: readonly ProviderSourceCanonicalProjectionPlan[];
    completedAt: Date;
  }>): Promise<SourceCompletionResult>;
  failRetry(input: Readonly<{
    organizationId: string;
    quarantineId: string;
    attemptId: string;
    actorKey: string;
    failedAt: Date;
    failureCode: string;
    sanitizedSummary: string;
  }>): Promise<SourceCompletionResult>;
}

function bounded(value: string | null, limit: number): string | null {
  return value === null ? null : value.slice(0, limit);
}

function safeCode(value: string | null, fallback: string): string | null {
  if (value === null) return null;
  const normalized = value.toUpperCase().replaceAll(/[^A-Z0-9_]/gu, "_");
  return SAFE_CODE.test(normalized) ? normalized : fallback;
}

export function providerSourceQuarantineSummary(
  entry: StoredProviderSourceQuarantineEntry,
): QuarantineEntrySummary {
  return {
    id: entry.id,
    providerId: entry.providerId,
    // The legacy browser DTO is replaced in task 008. Until then this slot is
    // populated from the authoritative source revision, never a config row.
    configurationRevisionId: entry.sourceRevisionId,
    platformKey: bounded(entry.platformKey, 128)!,
    runId: entry.runId,
    pageId: entry.pageId,
    recordKind: entry.recordKind,
    recordIndex: entry.recordIndex,
    externalId: bounded(entry.externalId, 256),
    reasonCode: safeCode(entry.reasonCode, "QUARANTINE_REASON_UNAVAILABLE")!,
    fieldPath: bounded(entry.fieldPath, 256),
    sanitizedSummary: bounded(entry.sanitizedSummary, 500) ??
      "A normalized source observation is quarantined.",
    state: entry.state,
    attemptCount: entry.retryCount,
    firstFailureAt: entry.createdAt.toISOString(),
    latestFailureAt: (entry.lastRetryAt ?? entry.createdAt).toISOString(),
    rawExpiresAt: entry.expiresAt.toISOString(),
    resolvedAt: entry.resolvedAt?.toISOString() ?? null,
    resolutionSummary: bounded(entry.resolutionSummary, 500),
  };
}

function attemptSummary(
  attempt: StoredProviderSourceQuarantineAttempt,
): QuarantineAttemptSummary {
  return {
    id: attempt.id,
    state: attempt.state,
    failureCode: safeCode(attempt.failureCode, "RETRY_FAILURE_UNAVAILABLE"),
    fieldPath: bounded(attempt.fieldPath, 256),
    sanitizedSummary: bounded(attempt.sanitizedSummary, 500),
    canonicalRevisionCount: attempt.canonicalRevisionCount,
    startedAt: attempt.startedAt.toISOString(),
    finishedAt: attempt.finishedAt?.toISOString() ?? null,
  };
}

function requireActor(actor: ProviderActor, keyer: ProviderActorKeyer): string {
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

function retainedEvidenceMatches(
  evidence: ProtectedProviderSourceQuarantineEvidence,
): Readonly<
  | { success: true; data: VersionedNormalizedProviderObservation }
  | { success: false }
> {
  const contractVersion = evidence.mapper.normalizedContractVersion;
  const parsed = contractVersion === PROVIDER_OBSERVATION_CONTRACT_VERSION
    ? normalizedProviderObservationSchema.safeParse(
        evidence.normalizedObservation,
      )
    : contractVersion === PROVIDER_OBSERVATION_CONTRACT_VERSION_V2
      ? normalizedProviderObservationV2Schema.safeParse(
          evidence.normalizedObservation,
        )
      : null;
  if (parsed === null || !parsed.success || evidence.semanticContent === null) {
    return { success: false };
  }
  const semanticMatches = contractVersion ===
      PROVIDER_OBSERVATION_CONTRACT_VERSION
    ? normalizedObservationSemanticCanonicalJson(
        normalizedObservationSemanticContent(
          normalizedProviderObservationSchema.parse(parsed.data),
        ),
      ) === normalizedObservationSemanticCanonicalJson(
        evidence.semanticContent,
      )
    : normalizedObservationSemanticCanonicalJsonV2(
        normalizedObservationSemanticContentV2(parsed.data),
      ) === normalizedObservationSemanticCanonicalJsonV2(
        evidence.semanticContent,
      );
  if (!semanticMatches) return { success: false };
  const protectedReferences = Array.isArray(evidence.evidence)
    ? new Set(evidence.evidence.flatMap((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
        const reference = (item as Record<string, unknown>).reference;
        return typeof reference === "string" ? [reference] : [];
      }))
    : new Set<string>();
  if (
    !protectedReferences.has(parsed.data.protectedNativeEvidenceRef) ||
    (parsed.data.kind === "trade" &&
      parsed.data.protectedTransactionEvidenceRef !== null &&
      !protectedReferences.has(parsed.data.protectedTransactionEvidenceRef))
  ) {
    return { success: false };
  }
  return { success: true, data: parsed.data };
}

/** Source-only retry path; it never reconstructs a legacy feed page or cursor. */
export class ProviderSourceQuarantineService {
  constructor(private readonly dependencies: Readonly<{
    repository: ProviderSourceQuarantineServiceRepository;
    mappers: ProviderObservationMapperResolver;
    actorKeyer: ProviderActorKeyer;
    clock: ProviderClock;
    ids: ProviderIdSource;
  }>) {}

  async detail(
    actor: ProviderActor,
    quarantineId: string,
  ): Promise<QuarantineEntryDetail> {
    requireActor(actor, this.dependencies.actorKeyer);
    if (!quarantineIdSchema.safeParse(quarantineId).success) {
      throw new QuarantineServiceError(
        "INVALID_QUARANTINE_REQUEST",
        "The quarantine request is invalid.",
        422,
      );
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
    return {
      ...providerSourceQuarantineSummary(entry),
      attempts: (await this.dependencies.repository.listAttempts(
        actor.organizationId,
        quarantineId,
      )).map(attemptSummary),
    };
  }

  async retryOne(
    actor: ProviderActor,
    quarantineId: string,
  ): Promise<QuarantineRetryOutcome> {
    const actorKey = requireActor(actor, this.dependencies.actorKeyer);
    if (!quarantineIdSchema.safeParse(quarantineId).success) {
      throw new QuarantineServiceError(
        "INVALID_QUARANTINE_REQUEST",
        "The quarantine request is invalid.",
        422,
      );
    }
    const attemptId = this.dependencies.ids.id();
    const claim = await this.dependencies.repository.claimRetry({
      organizationId: actor.organizationId,
      quarantineId,
      attemptId,
      actorKey,
      claimedAt: this.dependencies.clock.now(),
    });
    if (claim.kind !== "claimed") {
      return {
        quarantineId,
        outcome: claim.kind,
        entry: claim.kind === "not_found"
          ? null
          : providerSourceQuarantineSummary(claim.entry),
      };
    }
    const parsed = retainedEvidenceMatches(claim.evidence);
    if (!parsed.success) {
      return this.failed(actor, claim, actorKey, {
        code: "SOURCE_REFERENCE_UNAVAILABLE",
        summary: "Retained normalized evidence is unavailable or no longer matches its semantic observation.",
      });
    }
    let mapperOutput: unknown;
    try {
      const mapper = this.dependencies.mappers.resolve({
        ...claim.evidence.mapper,
        provider: claim.entry.platformKey,
      });
      mapperOutput = mapper.map({
        organizationId: actor.organizationId,
        providerId: claim.entry.providerId,
        provider: claim.entry.platformKey,
        ...claim.evidence.mapper,
        observation: parsed.data,
      });
    } catch {
      return this.failed(actor, claim, actorKey, {
        code: "MAPPER_UNAVAILABLE",
        summary: "The pinned source mapper could not reproject retained evidence.",
      });
    }
    let mapped;
    try {
      mapped = providerObservationMappingOutcomeFromRuntime(mapperOutput);
    } catch {
      return this.failed(actor, claim, actorKey, {
        code: "MAPPING_OUTPUT_INVALID",
        summary: "The pinned source mapper returned an invalid result.",
      });
    }
    if (mapped.status !== "mapped") {
      return this.failed(actor, claim, actorKey, {
        code: "MAPPING_STILL_INVALID",
        summary: "Retained normalized evidence still does not map safely.",
      });
    }
    let projections: readonly ProviderSourceCanonicalProjectionPlan[];
    try {
      projections = providerSourceCanonicalProjectionsForValidatedMapping(
        mapped,
        {
          organizationId: actor.organizationId,
          providerId: claim.entry.providerId,
          provider: claim.entry.platformKey,
          normalizedContractVersion:
            claim.evidence.mapper.normalizedContractVersion,
          observation: parsed.data,
        },
      );
    } catch {
      return this.failed(actor, claim, actorKey, {
        code: "MAPPING_OUTPUT_INVALID",
        summary: "The pinned source mapper returned an invalid result.",
      });
    }
    const completed = await this.dependencies.repository.completeRetry({
      organizationId: actor.organizationId,
      quarantineId,
      attemptId,
      actorKey,
      provider: claim.entry.platformKey,
      projections,
      completedAt: this.dependencies.clock.now(),
    });
    return {
      quarantineId,
      outcome: completed.kind,
      entry: completed.entry
        ? providerSourceQuarantineSummary(completed.entry)
        : null,
    };
  }

  async retryMany(
    actor: ProviderActor,
    input: QuarantineRetryBulkRequest,
  ): Promise<readonly QuarantineRetryOutcome[]> {
    requireActor(actor, this.dependencies.actorKeyer);
    const parsed = quarantineRetryBulkRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new QuarantineServiceError(
        "INVALID_QUARANTINE_REQUEST",
        "The quarantine request is invalid.",
        422,
      );
    }
    const outcomes: QuarantineRetryOutcome[] = [];
    for (const quarantineId of parsed.data.quarantineIds) {
      outcomes.push(await this.retryOne(actor, quarantineId));
    }
    return outcomes;
  }

  private async failed(
    actor: ProviderActor,
    claim: Extract<SourceClaimResult, { kind: "claimed" }>,
    actorKey: string,
    failure: Readonly<{ code: string; summary: string }>,
  ): Promise<QuarantineRetryOutcome> {
    const result = await this.dependencies.repository.failRetry({
      organizationId: actor.organizationId,
      quarantineId: claim.entry.id,
      attemptId: claim.attemptId,
      actorKey,
      failedAt: this.dependencies.clock.now(),
      failureCode: failure.code,
      sanitizedSummary: failure.summary,
    });
    return {
      quarantineId: claim.entry.id,
      outcome: result.kind,
      entry: result.entry
        ? providerSourceQuarantineSummary(result.entry)
        : null,
    };
  }
}
