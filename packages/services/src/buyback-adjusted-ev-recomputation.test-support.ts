import { randomUUID } from "node:crypto";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
  PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
  canonicalizePackScoutBuybackEvInternalReasonsV1,
  packScoutBuybackEvEvidenceOutcomeV1Schema,
  packScoutBuybackEvPublicReasonForInternalReasonsV1,
  type PackScoutBuybackEvEvidenceOutcomeV1,
  type PackScoutBuybackEvInputV1,
  type PackScoutBuybackEvInternalReasonCodeV1,
} from "@packscout/contracts";
import { buildBuybackEvInput } from "./buyback-adjusted-ev-calculator.test-support.ts";
import type {
  PackScoutBuybackEvRecomputationCommandV1,
} from "./buyback-adjusted-ev-recomputation-contracts.ts";
import type {
  BuybackAdjustedEvRecomputationClaim,
  BuybackAdjustedEvRecomputationQueue,
} from "./buyback-adjusted-ev-recomputation-processor.ts";
import type { PackScoutBuybackEvRevisionRecordV1 } from "./buyback-adjusted-ev-revision-contracts.ts";
import type {
  PackScoutBuybackEvRevisionPersistencePortV1,
  PersistBuybackEvRevisionPortInput,
} from "./buyback-adjusted-ev-revision-store.ts";

/**
 * Deterministic builders, an in-memory revision persistence port with the
 * task-005 replay semantics, and an in-memory work queue for the
 * recomputation tests. No wall clock is ever consulted.
 */

export const RECOMPUTATION_TEST_IDS = {
  organization: "41000000-0000-4000-8000-000000000001",
  provider: "41000000-0000-4000-8000-000000000002",
  configuration: "41000000-0000-4000-8000-000000000003",
} as const;

export function completeEvidenceOutcome(
  overrides: Partial<PackScoutBuybackEvInputV1> = {},
): PackScoutBuybackEvEvidenceOutcomeV1 {
  return packScoutBuybackEvEvidenceOutcomeV1Schema.parse({
    status: "complete",
    input: buildBuybackEvInput(overrides),
  });
}

export function unavailableEvidenceOutcome(input: {
  readonly internalReasons: readonly PackScoutBuybackEvInternalReasonCodeV1[];
  readonly sourceRevisionId?: string;
  readonly observedAt?: string | null;
  readonly productState?: "known" | "unknown";
  readonly observationPresent?: boolean;
  readonly evaluatedAt?: string;
}): Extract<PackScoutBuybackEvEvidenceOutcomeV1, { status: "unavailable" }> {
  const observedAt =
    input.observedAt === undefined
      ? "2026-08-19T18:00:00.000Z"
      : input.observedAt;
  const observationPresent = input.observationPresent ?? true;
  const productState = input.productState ?? "known";
  const internalReasons = canonicalizePackScoutBuybackEvInternalReasonsV1(
    input.internalReasons,
  );
  const outcome = packScoutBuybackEvEvidenceOutcomeV1Schema.parse({
    schemaVersion: PACKSCOUT_BUYBACK_EV_SCHEMA_VERSION,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    visibility: PACKSCOUT_BUYBACK_EV_PROTECTED_VISIBILITY,
    status: "unavailable",
    product:
      productState === "known"
        ? {
          state: "known",
          reference: {
            productKey: "courtyard-ironman-repack",
            productRevisionId: "product-revision-42",
          },
        }
        : { state: "unknown", reference: null },
    evaluatedAt: input.evaluatedAt ?? "2026-08-19T18:00:30.000Z",
    dataAsOf:
      observedAt === null
        ? { state: "unknown_source_time", observedAt: null }
        : { state: "known", observedAt },
    observation: observationPresent
      ? {
        coherenceKind: "provider_revision",
        providerKey: "courtyard",
        sourceRevisionId: input.sourceRevisionId ?? "catalog-revision-101",
        sourceManifestSha256: null,
        observedAt: observedAt ?? "2026-08-19T18:00:00.000Z",
      }
      : null,
    internalReasons: [...internalReasons],
    publicPrimaryReason:
      packScoutBuybackEvPublicReasonForInternalReasonsV1(internalReasons),
  });
  if (outcome.status !== "unavailable") {
    throw new Error("Expected an unavailable evidence outcome.");
  }
  return outcome;
}

export function recomputationCommand(
  evidence: PackScoutBuybackEvEvidenceOutcomeV1,
  calculatedAt: string,
  overrides: Partial<PackScoutBuybackEvRecomputationCommandV1> = {},
): PackScoutBuybackEvRecomputationCommandV1 {
  return {
    organizationId: RECOMPUTATION_TEST_IDS.organization,
    providerId: RECOMPUTATION_TEST_IDS.provider,
    configurationRevisionId: RECOMPUTATION_TEST_IDS.configuration,
    evidence,
    calculatedAt,
    ...overrides,
  };
}

/**
 * In-memory persistence port implementing the task-005 replay semantics:
 * one revision per calculation identity and per fingerprint, replay
 * unchanged, identity/result conflicts, deduplicated failure ledger, and
 * deterministic completed-current selection by revision number.
 */
export class InMemoryBuybackEvRevisionPort
implements PackScoutBuybackEvRevisionPersistencePortV1 {
  readonly rows: PackScoutBuybackEvRevisionRecordV1[] = [];
  readonly failures = new Map<
    string,
    { reasonCode: string; occurrenceCount: number }
  >();
  #revisionSequence = 0;

  async persistCompletedRevision(input: PersistBuybackEvRevisionPortInput) {
    const existing = this.rows.find(
      (row) =>
        row.organizationId === input.organizationId &&
        row.calculationKey === input.calculationKey,
    );
    if (existing) {
      if (existing.effectiveFingerprint !== input.effectiveFingerprint) {
        return { outcome: "identity_conflict" as const };
      }
      if (existing.resultHash !== input.resultHash) {
        return { outcome: "result_conflict" as const };
      }
      return { outcome: "unchanged" as const, row: existing };
    }
    const fingerprintOwner = this.rows.some(
      (row) =>
        row.organizationId === input.organizationId &&
        row.effectiveFingerprint === input.effectiveFingerprint,
    );
    if (fingerprintOwner) {
      return { outcome: "identity_conflict" as const };
    }
    const revisionNumber =
      this.rows
        .filter(
          (row) =>
            row.organizationId === input.organizationId &&
            row.platformKey === input.platformKey &&
            row.productKey === input.productKey,
        )
        .reduce((maximum, row) => Math.max(maximum, row.revisionNumber), 0) + 1;
    this.#revisionSequence += 1;
    const row: PackScoutBuybackEvRevisionRecordV1 = {
      revisionId: `41000000-0000-4000-8000-${String(this.#revisionSequence).padStart(12, "0")}`,
      organizationId: input.organizationId,
      providerId: input.providerId,
      configurationRevisionId: input.configurationRevisionId,
      platformKey: input.platformKey,
      productKey: input.productKey,
      productRevisionId: input.productRevisionId,
      methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
      confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      lifecycle: "completed",
      status: input.status,
      revisionNumber,
      calculationKey: input.calculationKey,
      effectiveFingerprint: input.effectiveFingerprint,
      resultHash: input.resultHash,
      sourceRevisionId: input.sourceRevisionId,
      sourceManifestSha256: input.sourceManifestSha256,
      observationCoherence: input.observationCoherence,
      oddsSource: input.oddsSource,
      usedClosedRangeMidpoint: input.usedClosedRangeMidpoint,
      calculatedAt: input.calculatedAt,
      dataAsOf: input.dataAsOf,
      metrics: input.metrics,
      confidence: input.confidence,
      freshness: input.freshness,
      internalReasons: input.internalReasons,
      publicPrimaryReason: input.publicPrimaryReason,
      createdAt: input.calculatedAt,
    };
    this.rows.push(row);
    return { outcome: "created" as const, row };
  }

  async recordPersistenceFailure(input: {
    organizationId: string;
    failureKey: string;
    reasonCode:
      | "CONTRACT_VIOLATION"
      | "IDENTITY_REUSE_CONFLICT"
      | "RESULT_CONFLICT"
      | "UNBINDABLE_RESULT";
    providerId: string | null;
    platformKey: string | null;
    productKey: string | null;
    seenAt: string;
  }) {
    const existing = this.failures.get(input.failureKey);
    if (existing) {
      if (existing.reasonCode !== input.reasonCode) {
        throw new Error(
          "A persistence failure key cannot change its bounded reason.",
        );
      }
      existing.occurrenceCount += 1;
      return { occurrenceCount: existing.occurrenceCount, created: false };
    }
    this.failures.set(input.failureKey, {
      reasonCode: input.reasonCode,
      occurrenceCount: 1,
    });
    return { occurrenceCount: 1, created: true };
  }

  async getCurrentCompletedRevision(input: {
    organizationId: string;
    platformKey: string;
    productKey: string;
    methodVersion: string;
  }) {
    const candidates = this.rows
      .filter(
        (row) =>
          row.organizationId === input.organizationId &&
          row.platformKey === input.platformKey &&
          row.productKey === input.productKey &&
          row.lifecycle === "completed" &&
          row.methodVersion === input.methodVersion,
      )
      .sort((left, right) => right.revisionNumber - left.revisionNumber);
    return candidates[0] ?? null;
  }

  async getRevisionTrace() {
    return null;
  }
}

interface QueueRequest {
  readonly id: string;
  readonly command: PackScoutBuybackEvRecomputationCommandV1;
  readonly scheduledAt: string;
  state: "queued" | "claimed" | "completed" | "failed";
  attemptCount: number;
  claimToken: string | null;
  leaseExpiresAtMillis: number;
  retryAtMillis: number;
  resultStatus: string | null;
  revisionId: string | null;
  outcomeReasonCode: string | null;
  failureCode: string | null;
}

/**
 * Durable-in-test work queue with the estimated-EV claim semantics: leased
 * claims, idempotent completion by claim token, bounded retries, and lost
 * results for stale tokens. One claim per product is leased at a time.
 */
export class InMemoryBuybackEvRecomputationQueue
implements BuybackAdjustedEvRecomputationQueue {
  readonly requests: QueueRequest[] = [];

  enqueue(
    command: PackScoutBuybackEvRecomputationCommandV1,
    scheduledAt: string,
  ): string {
    const id = randomUUID();
    this.requests.push({
      id,
      command,
      scheduledAt,
      state: "queued",
      attemptCount: 0,
      claimToken: null,
      leaseExpiresAtMillis: 0,
      retryAtMillis: 0,
      resultStatus: null,
      revisionId: null,
      outcomeReasonCode: null,
      failureCode: null,
    });
    return id;
  }

  async claimBatch(input: {
    workerId: string;
    now: Date;
    limit: number;
    leaseMilliseconds: number;
  }): Promise<readonly BuybackAdjustedEvRecomputationClaim[]> {
    const nowMillis = input.now.getTime();
    const claims: BuybackAdjustedEvRecomputationClaim[] = [];
    for (const request of this.requests) {
      if (claims.length >= input.limit) break;
      const claimable =
        (request.state === "queued" && request.retryAtMillis <= nowMillis) ||
        (request.state === "claimed" &&
          request.leaseExpiresAtMillis <= nowMillis);
      if (!claimable) continue;
      request.state = "claimed";
      request.attemptCount += 1;
      request.claimToken = randomUUID();
      request.leaseExpiresAtMillis = nowMillis + input.leaseMilliseconds;
      claims.push({
        id: request.id,
        claimToken: request.claimToken,
        attemptCount: request.attemptCount,
        scheduledAt: request.scheduledAt,
        command: request.command,
      });
    }
    return claims;
  }

  async complete(input: {
    requestId: string;
    claimToken: string;
    completedAt: Date;
    resultStatus: string;
    revisionId: string | null;
    outcomeReasonCode?: string;
  }): Promise<boolean> {
    const request = this.requests.find(({ id }) => id === input.requestId);
    if (
      !request ||
      request.state !== "claimed" ||
      request.claimToken !== input.claimToken
    ) {
      return false;
    }
    request.state = "completed";
    request.resultStatus = input.resultStatus;
    request.revisionId = input.revisionId;
    request.outcomeReasonCode = input.outcomeReasonCode ?? null;
    return true;
  }

  async recordFailure(input: {
    requestId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureCode: string;
    maximumAttempts: number;
  }): Promise<"failed" | "lost" | "retrying"> {
    const request = this.requests.find(({ id }) => id === input.requestId);
    if (
      !request ||
      request.state !== "claimed" ||
      request.claimToken !== input.claimToken
    ) {
      return "lost";
    }
    request.failureCode = input.failureCode;
    if (request.attemptCount >= input.maximumAttempts) {
      request.state = "failed";
      return "failed";
    }
    request.state = "queued";
    request.retryAtMillis = input.retryAt.getTime();
    return "retrying";
  }
}
