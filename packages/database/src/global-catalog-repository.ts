import { randomUUID } from "node:crypto";
import { Prisma as CentralPrisma } from "../prisma/generated/central/index.js";
import type {
  CentralPrismaClient,
  CentralQueryClient,
  CentralTransactionClient,
} from "./central-database.ts";
import {
  confidenceDecimal,
  correlationRequestDigest,
  normalizeCorrelationRequest,
  provisionalCollectibleId,
  type CorrelationRejectedResult,
  type CorrelationRejectionCode,
  type CorrelationResult,
  type CorrelationSuccessOutcome,
  type CorrelateProviderCollectibleRequest,
  type DeterministicCollectibleEvidence,
  type NormalizedCorrelationRequest,
} from "./global-catalog-contract.ts";
import {
  type CatalogDecisionDraft,
  type CatalogPromotionDraft,
  writeCatalogPlan,
} from "./global-catalog-ledger.ts";
import { resolveStoredCollectible } from "./global-catalog-resolution.ts";

interface ActiveCorrelation {
  readonly id: string;
  readonly local_entity_version: bigint;
  readonly global_collectible_id: string;
  readonly correlation_version: bigint;
  readonly method: "deterministic" | "manual" | "provisional";
  readonly confidence: { toFixed(fractionDigits?: number): string };
  readonly row_version: bigint;
  readonly updated_at: Date;
  readonly global_collectible: {
    readonly identity_state: "provisional" | "canonical" | "retired";
    readonly collectible_type: NormalizedCorrelationRequest["collectibleType"];
    readonly row_version: bigint;
    readonly updated_at: Date;
  };
}

interface CandidateTarget {
  readonly globalCollectibleId: string;
  readonly confidenceBasisPoints: number;
}

type CandidateResolution =
  | { readonly kind: "resolved"; readonly targets: readonly CandidateTarget[] }
  | { readonly kind: "rejected"; readonly code: CorrelationRejectionCode };

const TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 30_000,
  isolationLevel: CentralPrisma.TransactionIsolationLevel.Serializable,
});

function requestActorId(request: NormalizedCorrelationRequest): string {
  return `provider:${request.providerId}:change:${request.providerChangeSequence}`;
}

function actionActorId(request: NormalizedCorrelationRequest, action: string): string {
  return `${requestActorId(request)}:${action}`;
}

function nextTimestamp(now: Date, ...prior: Date[]): Date {
  return new Date(Math.max(now.getTime(), Date.now(), ...prior.map((date) => date.getTime() + 1)));
}

function identityData(request: NormalizedCorrelationRequest) {
  const identity = request.publicIdentity;
  return {
    collectible_type: request.collectibleType,
    display_name: identity.displayName,
    normalized_name: identity.normalizedName,
    year: identity.year,
    brand: identity.brand,
    set_or_series: identity.setOrSeries,
    card_number: identity.cardNumber,
    reference_number: identity.referenceNumber,
    subject: identity.subject,
    grade: identity.grade,
    grader: identity.grader,
    primary_image_url: identity.primaryImageUrl,
    primary_image_alt: identity.primaryImageAlt,
    valuation_amount: identity.valuationAmount,
    valuation_currency: identity.valuationCurrency,
    valuation_usd_amount: identity.valuationUsdAmount,
    valuation_unavailable_reason: identity.valuationUnavailableReason,
    valuation_type: identity.valuationType,
    valuation_observed_at: identity.valuationObservedAt,
    data_as_of: identity.dataAsOf,
  };
}

function provisionalIdentityMatches(
  current: {
    collectible_type: string;
    display_name: string;
    normalized_name: string;
    year: number | null;
    brand: string | null;
    set_or_series: string | null;
    card_number: string | null;
    reference_number: string | null;
    subject: string | null;
    grade: string | null;
    grader: string | null;
    primary_image_url: string | null;
    primary_image_alt: string | null;
    valuation_amount: { toFixed(fractionDigits?: number): string } | null;
    valuation_currency: string | null;
    valuation_usd_amount: { toFixed(fractionDigits?: number): string } | null;
    valuation_unavailable_reason: string | null;
    valuation_type: string | null;
    valuation_observed_at: Date | null;
    data_as_of: Date;
  },
  desired: ReturnType<typeof identityData>,
): boolean {
  return current.collectible_type === desired.collectible_type
    && current.display_name === desired.display_name
    && current.normalized_name === desired.normalized_name
    && current.year === desired.year
    && current.brand === desired.brand
    && current.set_or_series === desired.set_or_series
    && current.card_number === desired.card_number
    && current.reference_number === desired.reference_number
    && current.subject === desired.subject
    && current.grade === desired.grade
    && current.grader === desired.grader
    && current.primary_image_url === desired.primary_image_url
    && current.primary_image_alt === desired.primary_image_alt
    && (current.valuation_amount?.toFixed() ?? null) === desired.valuation_amount
    && current.valuation_currency === desired.valuation_currency
    && (current.valuation_usd_amount?.toFixed() ?? null) === desired.valuation_usd_amount
    && current.valuation_unavailable_reason === desired.valuation_unavailable_reason
    && current.valuation_type === desired.valuation_type
    && current.valuation_observed_at?.getTime()
      === desired.valuation_observed_at?.getTime()
    && current.data_as_of.getTime() === desired.data_as_of.getTime();
}

function markerDecision(input: {
  readonly request: NormalizedCorrelationRequest;
  readonly digest: string;
  readonly outcome: CorrelationSuccessOutcome | "rejected";
  readonly currentGlobalCollectibleId: string | null;
  readonly failureCode?: CorrelationRejectionCode;
}): CatalogDecisionDraft {
  return {
    key: "request",
    eventType: input.outcome === "rejected"
      ? "correlation_rejected"
      : "correlation_processed",
    actorType: "provider_correlation_request",
    actorId: requestActorId(input.request),
    reason: input.failureCode ?? input.outcome,
    afterState: {
      requestDigest: input.digest,
      outcome: input.outcome,
      currentGlobalCollectibleId: input.currentGlobalCollectibleId,
      confirmedProviderSequence: input.outcome === "rejected"
        ? null
        : input.request.providerChangeSequence.toString(),
      failureCode: input.failureCode ?? null,
    },
    occurredAt: input.request.observedAt,
  };
}

function actionDecision(
  request: NormalizedCorrelationRequest,
  key: string,
  eventType: string,
  afterState: Readonly<Record<string, unknown>>,
): CatalogDecisionDraft {
  return {
    key,
    eventType,
    actorType: "catalog_correlator",
    actorId: actionActorId(request, key),
    reason: eventType,
    afterState,
    occurredAt: request.observedAt,
  };
}

async function activeCorrelation(
  client: CentralQueryClient,
  request: NormalizedCorrelationRequest,
): Promise<ActiveCorrelation | null> {
  return client.provider_collectible_correlations.findFirst({
    where: {
      provider_id: request.providerId,
      local_collectible_id: request.localCollectibleId,
      valid_to_event_sequence: null,
    },
    select: {
      id: true,
      local_entity_version: true,
      global_collectible_id: true,
      correlation_version: true,
      method: true,
      confidence: true,
      row_version: true,
      updated_at: true,
      global_collectible: {
        select: {
          identity_state: true,
          collectible_type: true,
          row_version: true,
          updated_at: true,
        },
      },
    },
    orderBy: [{ correlation_version: "desc" }, { id: "asc" }],
  });
}

async function resolveCandidates(
  client: CentralQueryClient,
  request: NormalizedCorrelationRequest,
): Promise<CandidateResolution> {
  for (const evidence of request.deterministicEvidence) {
    if (
      evidence.providerId !== request.providerId
      || evidence.localCollectibleId !== request.localCollectibleId
      || evidence.localEntityVersion !== request.localEntityVersion
    ) {
      return { kind: "rejected", code: "CROSS_PROVIDER_EVIDENCE" };
    }
    if (evidence.collectibleType !== request.collectibleType) {
      return { kind: "rejected", code: "GLOBAL_TYPE_INCOMPATIBLE" };
    }
  }
  const grouped = new Map<string, number>();
  for (const evidence of request.deterministicEvidence) {
    const resolution = await resolveStoredCollectible(
      client,
      evidence.globalCollectibleId,
    );
    if (resolution.canonical === null) {
      return { kind: "rejected", code: "GLOBAL_TARGET_NOT_FOUND" };
    }
    if (resolution.canonical.identityState === "retired") {
      return { kind: "rejected", code: "GLOBAL_TARGET_RETIRED" };
    }
    if (resolution.canonical.identityState !== "canonical") {
      return { kind: "rejected", code: "GLOBAL_TARGET_NOT_CANONICAL" };
    }
    if (resolution.canonical.collectibleType !== request.collectibleType) {
      return { kind: "rejected", code: "GLOBAL_TYPE_INCOMPATIBLE" };
    }
    grouped.set(
      resolution.canonical.id,
      Math.max(
        grouped.get(resolution.canonical.id) ?? 0,
        evidence.confidenceBasisPoints,
      ),
    );
  }
  return {
    kind: "resolved",
    targets: [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([globalCollectibleId, confidenceBasisPoints]) => ({
        globalCollectibleId,
        confidenceBasisPoints,
      })),
  };
}

function promotion(input: {
  readonly decisionKey: string;
  readonly providerId: string | null;
  readonly entityType: CatalogPromotionDraft["entityType"];
  readonly entityId: string;
  readonly entityVersion: bigint;
  readonly operation: "upsert" | "retire";
  readonly affectedProviderIds: readonly string[];
  readonly changedAt: Date;
}): CatalogPromotionDraft {
  return {
    ...input,
    invalidationReason: input.entityType,
  };
}

function replayResult(
  request: NormalizedCorrelationRequest,
  digest: string,
  marker: { sequence: bigint; after_state: unknown },
): CorrelationResult | "conflict" | null {
  const state = marker.after_state;
  if (state === null || typeof state !== "object" || Array.isArray(state)) return null;
  const value = state as Record<string, unknown>;
  if (value.requestDigest !== digest) return "conflict";
  const current = typeof value.currentGlobalCollectibleId === "string"
    ? value.currentGlobalCollectibleId
    : null;
  if (value.outcome === "rejected") {
    return {
      outcome: "rejected",
      currentGlobalCollectibleId: current,
      confirmedProviderSequence: null,
      catalogEventSequence: marker.sequence,
      failureCode: value.failureCode as CorrelationRejectionCode,
    };
  }
  if (current === null) return null;
  return {
    outcome: "unchanged",
    currentGlobalCollectibleId: current,
    confirmedProviderSequence: request.providerChangeSequence,
    catalogEventSequence: marker.sequence,
  };
}

async function existingMarker(
  client: CentralQueryClient,
  request: NormalizedCorrelationRequest,
) {
  return client.catalog_decision_events.findFirst({
    where: {
      actor_type: "provider_correlation_request",
      actor_id: requestActorId(request),
      event_type: { in: ["correlation_processed", "correlation_rejected"] },
    },
    select: { sequence: true, after_state: true },
    orderBy: { sequence: "asc" },
  });
}

async function rejected(
  client: CentralQueryClient,
  request: NormalizedCorrelationRequest,
  digest: string,
  code: CorrelationRejectionCode,
  currentGlobalCollectibleId: string | null,
): Promise<CorrelationRejectedResult> {
  const plan = await writeCatalogPlan(client, {
    decisions: [markerDecision({
      request,
      digest,
      outcome: "rejected",
      currentGlobalCollectibleId,
      failureCode: code,
    })],
    promotions: [],
  });
  return {
    outcome: "rejected",
    currentGlobalCollectibleId,
    confirmedProviderSequence: null,
    catalogEventSequence: plan.decisionSequences.get("request")!,
    failureCode: code,
  };
}

async function replayConflict(
  client: CentralQueryClient,
  request: NormalizedCorrelationRequest,
  originalMarker: { sequence: bigint; after_state: unknown },
  conflictingDigest: string,
): Promise<CorrelationRejectedResult> {
  const prior = await client.catalog_decision_events.findFirst({
    where: {
      actor_type: "provider_correlation_conflict",
      actor_id: requestActorId(request),
      event_type: "source_replay_conflict",
    },
    select: { sequence: true },
    orderBy: { sequence: "asc" },
  });
  if (prior) {
    return {
      outcome: "rejected",
      currentGlobalCollectibleId: null,
      confirmedProviderSequence: null,
      catalogEventSequence: prior.sequence,
      failureCode: "SOURCE_REPLAY_CONFLICT",
    };
  }
  const originalState = originalMarker.after_state;
  const originalDigest = originalState !== null
      && typeof originalState === "object"
      && !Array.isArray(originalState)
      && typeof (originalState as Record<string, unknown>).requestDigest === "string"
    ? (originalState as Record<string, unknown>).requestDigest as string
    : "unavailable";
  const plan = await writeCatalogPlan(client, {
    decisions: [{
      key: "replay_conflict",
      eventType: "source_replay_conflict",
      actorType: "provider_correlation_conflict",
      actorId: requestActorId(request),
      reason: "SOURCE_REPLAY_CONFLICT",
      beforeState: {
        originalCatalogEventSequence: originalMarker.sequence.toString(),
        originalRequestDigest: originalDigest,
      },
      afterState: { conflictingRequestDigest: conflictingDigest },
      occurredAt: request.observedAt,
    }],
    promotions: [],
  });
  return {
    outcome: "rejected",
    currentGlobalCollectibleId: null,
    confirmedProviderSequence: null,
    catalogEventSequence: plan.decisionSequences.get("replay_conflict")!,
    failureCode: "SOURCE_REPLAY_CONFLICT",
  };
}

async function markerOnly(
  client: CentralQueryClient,
  request: NormalizedCorrelationRequest,
  digest: string,
  currentGlobalCollectibleId: string,
): Promise<CorrelationResult> {
  const plan = await writeCatalogPlan(client, {
    decisions: [markerDecision({
      request,
      digest,
      outcome: "unchanged",
      currentGlobalCollectibleId,
    })],
    promotions: [],
  });
  return {
    outcome: "unchanged",
    currentGlobalCollectibleId,
    confirmedProviderSequence: request.providerChangeSequence,
    catalogEventSequence: plan.decisionSequences.get("request")!,
  };
}

async function nextCorrelationVersion(
  client: CentralQueryClient,
  request: NormalizedCorrelationRequest,
): Promise<bigint> {
  const latest = await client.provider_collectible_correlations.findFirst({
    where: {
      provider_id: request.providerId,
      local_collectible_id: request.localCollectibleId,
    },
    select: { correlation_version: true },
    orderBy: { correlation_version: "desc" },
  });
  return (latest?.correlation_version ?? 0n) + 1n;
}

function correlationCreateData(input: {
  readonly id: string;
  readonly request: NormalizedCorrelationRequest;
  readonly globalCollectibleId: string;
  readonly correlationVersion: bigint;
  readonly eventSequence: bigint;
  readonly method: "deterministic" | "provisional";
  readonly confidenceBasisPoints: number;
}) {
  return {
    id: input.id,
    provider_id: input.request.providerId,
    local_collectible_id: input.request.localCollectibleId,
    local_entity_version: input.request.localEntityVersion,
    global_collectible_id: input.globalCollectibleId,
    correlation_version: input.correlationVersion,
    rule_version: input.request.ruleVersion,
    method: input.method,
    confidence: confidenceDecimal(input.confidenceBasisPoints),
    valid_from_event_sequence: input.eventSequence,
    valid_from: input.request.observedAt,
  };
}

async function applySuggestions(input: {
  readonly client: CentralQueryClient;
  readonly request: NormalizedCorrelationRequest;
  readonly provisionalId: string;
  readonly candidates: readonly CandidateTarget[];
  readonly decisionSequence: bigint;
}): Promise<void> {
  const pending = await input.client.correlation_suggestions.findMany({
    where: {
      provider_id: input.request.providerId,
      local_collectible_id: input.request.localCollectibleId,
      review_state: "pending",
    },
    select: { id: true, updated_at: true },
  });
  if (pending.length > 0) {
    const updatedAt = nextTimestamp(
      input.request.observedAt,
      ...pending.map((suggestion) => suggestion.updated_at),
    );
    await input.client.correlation_suggestions.updateMany({
      where: { id: { in: pending.map((suggestion) => suggestion.id) } },
      data: {
        review_state: "superseded",
        row_version: { increment: 1n },
        updated_at: updatedAt,
      },
    });
  }
  await input.client.correlation_suggestions.createMany({
    data: input.candidates.map((candidate) => ({
      id: randomUUID(),
      provider_id: input.request.providerId,
      local_collectible_id: input.request.localCollectibleId,
      local_entity_version: input.request.localEntityVersion,
      provisional_collectible_id: input.provisionalId,
      candidate_collectible_id: candidate.globalCollectibleId,
      rule_version: input.request.ruleVersion,
      confidence: confidenceDecimal(candidate.confidenceBasisPoints),
      decision_event_sequence: input.decisionSequence,
      rationale: {
        kind: "deterministic_candidate",
        confidenceBasisPoints: candidate.confidenceBasisPoints,
      },
    })),
  });
}

async function createInitialCorrelation(input: {
  readonly client: CentralQueryClient;
  readonly request: NormalizedCorrelationRequest;
  readonly digest: string;
  readonly candidates: readonly CandidateTarget[];
}): Promise<CorrelationResult> {
  const provisionalId = provisionalCollectibleId(input.request);
  const uniqueTarget = input.candidates.length === 1 ? input.candidates[0]! : null;
  const globalId = uniqueTarget?.globalCollectibleId ?? provisionalId;
  const outcome: CorrelationSuccessOutcome = uniqueTarget
    ? "linked"
    : input.candidates.length > 1
      ? "suggested"
      : "provisional_created";
  const existingProvisional = uniqueTarget ? null : await input.client.global_collectibles.findUnique({
    where: { id: provisionalId },
    select: { identity_state: true, collectible_type: true },
  });
  if (existingProvisional && (
    existingProvisional.identity_state !== "provisional"
    || existingProvisional.collectible_type !== input.request.collectibleType
  )) {
    return rejected(
      input.client,
      input.request,
      input.digest,
      "MISSING_PROVISIONAL",
      null,
    );
  }
  const correlationId = randomUUID();
  const correlationVersion = await nextCorrelationVersion(input.client, input.request);
  const decisions: CatalogDecisionDraft[] = [
    markerDecision({
      request: input.request,
      digest: input.digest,
      outcome,
      currentGlobalCollectibleId: globalId,
    }),
  ];
  if (!uniqueTarget && existingProvisional === null) {
    decisions.push(actionDecision(input.request, "provisional", "provisional_creation", {
      globalCollectibleId: provisionalId,
    }));
  }
  decisions.push(actionDecision(
    input.request,
    "link",
    uniqueTarget ? "deterministic_link" : "provisional_link",
    { globalCollectibleId: globalId, localEntityVersion: input.request.localEntityVersion.toString() },
  ));
  if (input.candidates.length > 1) {
    decisions.push(actionDecision(input.request, "suggestion", "suggestion", {
      provisionalCollectibleId: provisionalId,
      candidateCollectibleIds: input.candidates.map((candidate) => candidate.globalCollectibleId),
    }));
  }
  const promotions: CatalogPromotionDraft[] = [];
  if (!uniqueTarget && existingProvisional === null) {
    promotions.push(promotion({
      decisionKey: "provisional",
      providerId: null,
      entityType: "global_collectible",
      entityId: provisionalId,
      entityVersion: 1n,
      operation: "upsert",
      affectedProviderIds: [input.request.providerId],
      changedAt: input.request.observedAt,
    }));
  }
  promotions.push(promotion({
    decisionKey: "link",
    providerId: input.request.providerId,
    entityType: "provider_collectible_correlation",
    entityId: correlationId,
    entityVersion: correlationVersion,
    operation: "upsert",
    affectedProviderIds: [input.request.providerId],
    changedAt: input.request.observedAt,
  }));
  const plan = await writeCatalogPlan(input.client, { decisions, promotions });
  if (!uniqueTarget && existingProvisional === null) {
    await input.client.global_collectibles.create({
      data: {
        id: provisionalId,
        identity_state: "provisional",
        ...identityData(input.request),
      },
    });
  }
  await input.client.provider_collectible_correlations.create({
    data: correlationCreateData({
      id: correlationId,
      request: input.request,
      globalCollectibleId: globalId,
      correlationVersion,
      eventSequence: plan.decisionSequences.get("link")!,
      method: uniqueTarget ? "deterministic" : "provisional",
      confidenceBasisPoints: uniqueTarget?.confidenceBasisPoints ?? 0,
    }),
  });
  if (input.candidates.length > 1) {
    await applySuggestions({
      client: input.client,
      request: input.request,
      provisionalId,
      candidates: input.candidates,
      decisionSequence: plan.decisionSequences.get("suggestion")!,
    });
  }
  return {
    outcome,
    currentGlobalCollectibleId: globalId,
    confirmedProviderSequence: input.request.providerChangeSequence,
    catalogEventSequence: plan.decisionSequences.get("request")!,
  };
}

async function replaceCorrelation(input: {
  readonly client: CentralQueryClient;
  readonly request: NormalizedCorrelationRequest;
  readonly digest: string;
  readonly active: ActiveCorrelation;
  readonly target: CandidateTarget | null;
  readonly suggestions: readonly CandidateTarget[];
}): Promise<CorrelationResult> {
  const targetId = input.target?.globalCollectibleId ?? input.active.global_collectible_id;
  const provisional = input.active.method === "provisional"
    ? await input.client.global_collectibles.findUnique({
      where: { id: input.active.global_collectible_id },
    })
    : null;
  const desiredProvisionalIdentity = identityData(input.request);
  const refreshProvisional = provisional?.identity_state === "provisional"
    && !provisionalIdentityMatches(provisional, desiredProvisionalIdentity);
  const outcome: CorrelationSuccessOutcome = input.suggestions.length > 1
    ? "suggested"
    : input.target
      ? "linked"
      : "unchanged";
  const nextId = randomUUID();
  const nextVersion = input.active.correlation_version + 1n;
  const pendingSuggestions = await input.client.correlation_suggestions.findMany({
    where: {
      provider_id: input.request.providerId,
      local_collectible_id: input.request.localCollectibleId,
      review_state: "pending",
    },
    select: { id: true, updated_at: true },
  });
  const decisions: CatalogDecisionDraft[] = [
    markerDecision({
      request: input.request,
      digest: input.digest,
      outcome,
      currentGlobalCollectibleId: targetId,
    }),
    actionDecision(input.request, "replacement", "correlation_replacement", {
      previousCorrelationId: input.active.id,
      nextCorrelationId: nextId,
    }),
    actionDecision(
      input.request,
      "link",
      input.target ? "deterministic_link" : "provisional_link",
      { globalCollectibleId: targetId, localEntityVersion: input.request.localEntityVersion.toString() },
    ),
  ];
  if (input.suggestions.length > 1) {
    decisions.push(actionDecision(input.request, "suggestion", "suggestion", {
      provisionalCollectibleId: targetId,
      candidateCollectibleIds: input.suggestions.map((candidate) => candidate.globalCollectibleId),
    }));
  }
  if (refreshProvisional) {
    decisions.push(actionDecision(
      input.request,
      "provisional_refresh",
      "provisional_identity_update",
      {
        globalCollectibleId: provisional.id,
        rowVersion: (provisional.row_version + 1n).toString(),
      },
    ));
  }
  const promotions = [
    promotion({
      decisionKey: "replacement",
      providerId: input.request.providerId,
      entityType: "provider_collectible_correlation",
      entityId: input.active.id,
      entityVersion: input.active.correlation_version,
      operation: "retire",
      affectedProviderIds: [input.request.providerId],
      changedAt: input.request.observedAt,
    }),
    promotion({
      decisionKey: "link",
      providerId: input.request.providerId,
      entityType: "provider_collectible_correlation",
      entityId: nextId,
      entityVersion: nextVersion,
      operation: "upsert",
      affectedProviderIds: [input.request.providerId],
      changedAt: input.request.observedAt,
    }),
  ];
  if (pendingSuggestions.length > 0) {
    decisions.push(actionDecision(
      input.request,
      "suggestion_resolution",
      "suggestion_superseded",
      { suggestionCount: pendingSuggestions.length },
    ));
  }
  if (refreshProvisional) {
    promotions.push(promotion({
      decisionKey: "provisional_refresh",
      providerId: null,
      entityType: "global_collectible",
      entityId: provisional.id,
      entityVersion: provisional.row_version + 1n,
      operation: "upsert",
      affectedProviderIds: [input.request.providerId],
      changedAt: input.request.observedAt,
    }));
  }
  const plan = await writeCatalogPlan(input.client, { decisions, promotions });
  await input.client.provider_collectible_correlations.update({
    where: { id: input.active.id },
    data: {
      valid_to_event_sequence: plan.decisionSequences.get("replacement")!,
      valid_to: input.request.observedAt,
      row_version: input.active.row_version + 1n,
      updated_at: nextTimestamp(input.request.observedAt, input.active.updated_at),
    },
  });
  await input.client.provider_collectible_correlations.create({
    data: correlationCreateData({
      id: nextId,
      request: input.request,
      globalCollectibleId: targetId,
      correlationVersion: nextVersion,
      eventSequence: plan.decisionSequences.get("link")!,
      method: input.target ? "deterministic" : "provisional",
      confidenceBasisPoints: input.target?.confidenceBasisPoints ?? 0,
    }),
  });
  if (refreshProvisional) {
    await input.client.global_collectibles.update({
      where: { id: provisional.id },
      data: {
        ...desiredProvisionalIdentity,
        row_version: provisional.row_version + 1n,
        updated_at: nextTimestamp(input.request.observedAt, provisional.updated_at),
      },
    });
  }
  if (input.suggestions.length > 1) {
    await applySuggestions({
      client: input.client,
      request: input.request,
      provisionalId: targetId,
      candidates: input.suggestions,
      decisionSequence: plan.decisionSequences.get("suggestion")!,
    });
  } else if (pendingSuggestions.length > 0) {
    await input.client.correlation_suggestions.updateMany({
      where: { id: { in: pendingSuggestions.map((suggestion) => suggestion.id) } },
      data: {
        review_state: "superseded",
        row_version: { increment: 1n },
        updated_at: nextTimestamp(
          input.request.observedAt,
          ...pendingSuggestions.map((suggestion) => suggestion.updated_at),
        ),
      },
    });
  }
  return {
    outcome,
    currentGlobalCollectibleId: targetId,
    confirmedProviderSequence: input.request.providerChangeSequence,
    catalogEventSequence: plan.decisionSequences.get("request")!,
  };
}

async function promoteProvisional(input: {
  readonly client: CentralQueryClient;
  readonly request: NormalizedCorrelationRequest;
  readonly digest: string;
  readonly active: ActiveCorrelation;
  readonly target: CandidateTarget;
}): Promise<CorrelationResult> {
  const provisionalId = provisionalCollectibleId(input.request);
  if (
    input.active.global_collectible_id !== provisionalId
    || input.active.global_collectible.identity_state !== "provisional"
    || input.active.global_collectible.collectible_type !== input.request.collectibleType
  ) {
    return rejected(
      input.client,
      input.request,
      input.digest,
      "MISSING_PROVISIONAL",
      input.active.global_collectible_id,
    );
  }
  const nextId = randomUUID();
  const nextVersion = input.active.correlation_version + 1n;
  const pendingSuggestions = await input.client.correlation_suggestions.findMany({
    where: {
      provider_id: input.request.providerId,
      local_collectible_id: input.request.localCollectibleId,
      review_state: "pending",
    },
    select: { id: true, updated_at: true },
  });
  const decisions: CatalogDecisionDraft[] = [
    markerDecision({
      request: input.request,
      digest: input.digest,
      outcome: "linked",
      currentGlobalCollectibleId: input.target.globalCollectibleId,
    }),
    actionDecision(input.request, "replacement", "correlation_replacement", {
      previousCorrelationId: input.active.id,
      nextCorrelationId: nextId,
    }),
    actionDecision(input.request, "link", "deterministic_link", {
      globalCollectibleId: input.target.globalCollectibleId,
    }),
    actionDecision(input.request, "retirement", "retirement", {
      retiredCollectibleId: provisionalId,
    }),
    actionDecision(input.request, "alias", "alias_creation", {
      aliasCollectibleId: provisionalId,
      canonicalCollectibleId: input.target.globalCollectibleId,
    }),
  ];
  if (pendingSuggestions.length > 0) {
    decisions.push(actionDecision(
      input.request,
      "suggestion_resolution",
      "suggestion_superseded",
      { suggestionCount: pendingSuggestions.length },
    ));
  }
  const promotions = [
    promotion({
      decisionKey: "replacement",
      providerId: input.request.providerId,
      entityType: "provider_collectible_correlation",
      entityId: input.active.id,
      entityVersion: input.active.correlation_version,
      operation: "retire",
      affectedProviderIds: [input.request.providerId],
      changedAt: input.request.observedAt,
    }),
    promotion({
      decisionKey: "link",
      providerId: input.request.providerId,
      entityType: "provider_collectible_correlation",
      entityId: nextId,
      entityVersion: nextVersion,
      operation: "upsert",
      affectedProviderIds: [input.request.providerId],
      changedAt: input.request.observedAt,
    }),
    promotion({
      decisionKey: "retirement",
      providerId: null,
      entityType: "global_collectible",
      entityId: provisionalId,
      entityVersion: input.active.global_collectible.row_version + 1n,
      operation: "retire",
      affectedProviderIds: [input.request.providerId],
      changedAt: input.request.observedAt,
    }),
    promotion({
      decisionKey: "alias",
      providerId: null,
      entityType: "collectible_alias",
      entityId: provisionalId,
      entityVersion: 1n,
      operation: "upsert",
      affectedProviderIds: [input.request.providerId],
      changedAt: input.request.observedAt,
    }),
  ];
  const plan = await writeCatalogPlan(input.client, { decisions, promotions });
  await input.client.provider_collectible_correlations.update({
    where: { id: input.active.id },
    data: {
      valid_to_event_sequence: plan.decisionSequences.get("replacement")!,
      valid_to: input.request.observedAt,
      row_version: input.active.row_version + 1n,
      updated_at: nextTimestamp(input.request.observedAt, input.active.updated_at),
    },
  });
  await input.client.provider_collectible_correlations.create({
    data: correlationCreateData({
      id: nextId,
      request: input.request,
      globalCollectibleId: input.target.globalCollectibleId,
      correlationVersion: nextVersion,
      eventSequence: plan.decisionSequences.get("link")!,
      method: "deterministic",
      confidenceBasisPoints: input.target.confidenceBasisPoints,
    }),
  });
  await input.client.global_collectibles.update({
    where: { id: provisionalId },
    data: {
      identity_state: "retired",
      retired_at: input.request.observedAt,
      row_version: input.active.global_collectible.row_version + 1n,
      updated_at: nextTimestamp(
        input.request.observedAt,
        input.active.global_collectible.updated_at,
      ),
    },
  });
  await input.client.collectible_aliases.create({
    data: {
      alias_collectible_id: provisionalId,
      canonical_collectible_id: input.target.globalCollectibleId,
      decision_event_sequence: plan.decisionSequences.get("alias")!,
    },
  });
  if (pendingSuggestions.length > 0) {
    await input.client.correlation_suggestions.updateMany({
      where: { id: { in: pendingSuggestions.map((suggestion) => suggestion.id) } },
      data: {
        review_state: "superseded",
        row_version: { increment: 1n },
        updated_at: nextTimestamp(
          input.request.observedAt,
          ...pendingSuggestions.map((suggestion) => suggestion.updated_at),
        ),
      },
    });
  }
  return {
    outcome: "linked",
    currentGlobalCollectibleId: input.target.globalCollectibleId,
    confirmedProviderSequence: input.request.providerChangeSequence,
    catalogEventSequence: plan.decisionSequences.get("request")!,
  };
}

async function correlateInTransaction(
  client: CentralTransactionClient,
  request: NormalizedCorrelationRequest,
  digest: string,
): Promise<CorrelationResult> {
  const marker = await existingMarker(client, request);
  if (marker) {
    const replay = replayResult(request, digest, marker);
    if (replay === "conflict") {
      return replayConflict(client, request, marker, digest);
    }
    if (replay) return replay;
  }
  const provider = await client.providers.findUnique({
    where: { id: request.providerId },
    select: { id: true },
  });
  const active = await activeCorrelation(client, request);
  if (!provider) {
    return rejected(client, request, digest, "PROVIDER_NOT_FOUND", null);
  }
  if (active && active.local_entity_version > request.localEntityVersion) {
    return rejected(
      client,
      request,
      digest,
      "STALE_LOCAL_VERSION",
      active.global_collectible_id,
    );
  }
  if (active && active.global_collectible.collectible_type !== request.collectibleType) {
    return rejected(
      client,
      request,
      digest,
      "GLOBAL_TYPE_INCOMPATIBLE",
      active.global_collectible_id,
    );
  }
  if (active?.method === "provisional" && (
    active.global_collectible_id !== provisionalCollectibleId(request)
    || active.global_collectible.identity_state !== "provisional"
  )) {
    return rejected(
      client,
      request,
      digest,
      "MISSING_PROVISIONAL",
      active.global_collectible_id,
    );
  }
  const candidateResolution = await resolveCandidates(client, request);
  if (candidateResolution.kind === "rejected") {
    return rejected(
      client,
      request,
      digest,
      candidateResolution.code,
      active?.global_collectible_id ?? null,
    );
  }
  const candidates = candidateResolution.targets;
  if (!active) {
    const latest = await client.provider_collectible_correlations.findFirst({
      where: {
        provider_id: request.providerId,
        local_collectible_id: request.localCollectibleId,
      },
      select: { local_entity_version: true },
      orderBy: { correlation_version: "desc" },
    });
    if (latest && latest.local_entity_version >= request.localEntityVersion) {
      return rejected(client, request, digest, "STALE_LOCAL_VERSION", null);
    }
    if (latest) {
      return rejected(client, request, digest, "MISSING_PROVISIONAL", null);
    }
    return createInitialCorrelation({ client, request, digest, candidates });
  }

  const sameVersion = active.local_entity_version === request.localEntityVersion;
  if (sameVersion && active.method === "provisional") {
    const provisional = await client.global_collectibles.findUnique({
      where: { id: active.global_collectible_id },
    });
    if (provisional === null
        || !provisionalIdentityMatches(provisional, identityData(request))) {
      return rejected(
        client,
        request,
        digest,
        "DETERMINISTIC_OUTCOME_CONFLICT",
        active.global_collectible_id,
      );
    }
  }
  if (candidates.length === 0) {
    if (active.method !== "provisional") {
      return rejected(
        client,
        request,
        digest,
        "DETERMINISTIC_OUTCOME_CONFLICT",
        active.global_collectible_id,
      );
    }
    return sameVersion
      ? markerOnly(client, request, digest, active.global_collectible_id)
      : replaceCorrelation({
        client,
        request,
        digest,
        active,
        target: null,
        suggestions: [],
      });
  }
  if (candidates.length > 1) {
    if (active.method !== "provisional"
        || active.global_collectible.identity_state !== "provisional") {
      return rejected(
        client,
        request,
        digest,
        "MISSING_PROVISIONAL",
        active.global_collectible_id,
      );
    }
    if (sameVersion) {
      const pending = await client.correlation_suggestions.findMany({
        where: {
          provider_id: request.providerId,
          local_collectible_id: request.localCollectibleId,
          local_entity_version: request.localEntityVersion,
          rule_version: request.ruleVersion,
          review_state: "pending",
        },
        select: { candidate_collectible_id: true },
        orderBy: { candidate_collectible_id: "asc" },
      });
      const expected = candidates.map((candidate) => candidate.globalCollectibleId);
      if (JSON.stringify(pending.map((item) => item.candidate_collectible_id))
          === JSON.stringify(expected)) {
        return markerOnly(client, request, digest, active.global_collectible_id);
      }
    }
    return replaceCorrelation({
      client,
      request,
      digest,
      active,
      target: null,
      suggestions: candidates,
    });
  }
  const target = candidates[0]!;
  if (active.method === "provisional") {
    return promoteProvisional({ client, request, digest, active, target });
  }
  const resolvedActive = await resolveStoredCollectible(
    client,
    active.global_collectible_id,
  );
  if (resolvedActive.canonical === null) {
    return rejected(
      client,
      request,
      digest,
      "GLOBAL_TARGET_NOT_FOUND",
      active.global_collectible_id,
    );
  }
  if (resolvedActive.canonical.identityState === "retired") {
    return rejected(
      client,
      request,
      digest,
      "GLOBAL_TARGET_RETIRED",
      active.global_collectible_id,
    );
  }
  if (resolvedActive.canonical.id !== target.globalCollectibleId) {
    return rejected(
      client,
      request,
      digest,
      "DETERMINISTIC_OUTCOME_CONFLICT",
      active.global_collectible_id,
    );
  }
  if (active.global_collectible_id !== target.globalCollectibleId) {
    return replaceCorrelation({
      client,
      request,
      digest,
      active,
      target,
      suggestions: [],
    });
  }
  return sameVersion
    ? markerOnly(client, request, digest, active.global_collectible_id)
    : replaceCorrelation({
      client,
      request,
      digest,
      active,
      target,
      suggestions: [],
    });
}

function retryable(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  if (error.code === "P2002" || error.code === "P2034") return true;
  if (error.code !== "P2010" || !("meta" in error)
      || error.meta === null || typeof error.meta !== "object") return false;
  return "code" in error.meta && error.meta.code === "40001";
}

export class GlobalCatalogCorrelationRepository {
  constructor(private readonly client: CentralPrismaClient) {}

  async correlateCollectible(
    input: CorrelateProviderCollectibleRequest,
  ): Promise<CorrelationResult> {
    const request = normalizeCorrelationRequest(input);
    const digest = correlationRequestDigest(request);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.client.$transaction(
          (transaction) => correlateInTransaction(transaction, request, digest),
          TRANSACTION_OPTIONS,
        );
      } catch (error) {
        if (attempt >= 3 || !retryable(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5 * (2 ** attempt)));
      }
    }
  }
}

export function evidenceForTarget(input: {
  readonly request: Pick<
    CorrelateProviderCollectibleRequest,
    "providerId" | "localCollectibleId" | "localEntityVersion" | "collectibleType"
  >;
  readonly globalCollectibleId: string;
  readonly confidenceBasisPoints?: number;
}): DeterministicCollectibleEvidence {
  return {
    providerId: input.request.providerId,
    localCollectibleId: input.request.localCollectibleId,
    localEntityVersion: input.request.localEntityVersion,
    globalCollectibleId: input.globalCollectibleId,
    collectibleType: input.request.collectibleType,
    confidenceBasisPoints: input.confidenceBasisPoints ?? 10_000,
  };
}
