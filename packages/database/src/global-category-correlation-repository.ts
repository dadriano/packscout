import { createHash, randomUUID } from "node:crypto";
import { Prisma as CentralPrisma } from "../prisma/generated/central/index.js";
import type { CentralPrismaClient, CentralQueryClient } from "./central-database.ts";
import {
  confidenceDecimal,
  GlobalCatalogInputError,
  requireCatalogUuid,
} from "./global-catalog-contract.ts";
import {
  type CatalogDecisionDraft,
  type CatalogPromotionDraft,
  writeCatalogPlan,
} from "./global-catalog-ledger.ts";

export interface CorrelateProviderCategoryRequest {
  readonly providerId: string;
  readonly localCategoryId: string;
  readonly localEntityVersion: bigint;
  readonly globalCategoryId: string;
  readonly ruleVersion: string;
  readonly confidenceBasisPoints: number;
  readonly providerChangeSequence: bigint;
  readonly observedAt?: Date;
}

export type CategoryCorrelationResult =
  | {
    readonly outcome: "linked" | "unchanged";
    readonly currentGlobalCategoryId: string;
    readonly confirmedProviderSequence: bigint;
    readonly catalogEventSequence: bigint;
  }
  | {
    readonly outcome: "rejected";
    readonly currentGlobalCategoryId: string | null;
    readonly confirmedProviderSequence: null;
    readonly catalogEventSequence: bigint;
    readonly failureCode:
      | "PROVIDER_NOT_FOUND"
      | "GLOBAL_CATEGORY_NOT_FOUND"
      | "STALE_LOCAL_VERSION"
      | "DETERMINISTIC_OUTCOME_CONFLICT"
      | "SOURCE_REPLAY_CONFLICT";
  };

interface NormalizedRequest {
  readonly providerId: string;
  readonly localCategoryId: string;
  readonly localEntityVersion: bigint;
  readonly globalCategoryId: string;
  readonly ruleVersion: string;
  readonly confidenceBasisPoints: number;
  readonly providerChangeSequence: bigint;
  readonly observedAt: Date;
}

const TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 30_000,
  isolationLevel: CentralPrisma.TransactionIsolationLevel.Serializable,
});

function boundedText(value: string, field: string, maximum = 64): string {
  if (typeof value !== "string") throw new GlobalCatalogInputError(`${field} must be text.`);
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new GlobalCatalogInputError(`${field} is outside its bounds.`);
  }
  return normalized;
}

function positive(value: bigint, field: string): bigint {
  if (typeof value !== "bigint" || value <= 0n) {
    throw new GlobalCatalogInputError(`${field} must be a positive bigint.`);
  }
  return value;
}

function normalize(input: CorrelateProviderCategoryRequest): NormalizedRequest {
  if (!Number.isInteger(input.confidenceBasisPoints)
      || input.confidenceBasisPoints < 0
      || input.confidenceBasisPoints > 10_000) {
    throw new GlobalCatalogInputError("confidenceBasisPoints is invalid.");
  }
  const observedAt = input.observedAt ?? new Date();
  if (!(observedAt instanceof Date) || !Number.isFinite(observedAt.getTime())) {
    throw new GlobalCatalogInputError("observedAt is invalid.");
  }
  return {
    providerId: requireCatalogUuid(input.providerId, "providerId"),
    localCategoryId: requireCatalogUuid(input.localCategoryId, "localCategoryId"),
    localEntityVersion: positive(input.localEntityVersion, "localEntityVersion"),
    globalCategoryId: requireCatalogUuid(input.globalCategoryId, "globalCategoryId"),
    ruleVersion: boundedText(input.ruleVersion, "ruleVersion"),
    confidenceBasisPoints: input.confidenceBasisPoints,
    providerChangeSequence: positive(
      input.providerChangeSequence,
      "providerChangeSequence",
    ),
    observedAt: new Date(observedAt),
  };
}

function actorId(request: NormalizedRequest): string {
  return `provider:${request.providerId}:category-change:${request.providerChangeSequence}`;
}

function digest(request: NormalizedRequest): string {
  return createHash("sha256").update(JSON.stringify({
    providerId: request.providerId,
    localCategoryId: request.localCategoryId,
    localEntityVersion: request.localEntityVersion.toString(),
    globalCategoryId: request.globalCategoryId,
    ruleVersion: request.ruleVersion,
    confidenceBasisPoints: request.confidenceBasisPoints,
    providerChangeSequence: request.providerChangeSequence.toString(),
  })).digest("hex");
}

function marker(input: {
  readonly request: NormalizedRequest;
  readonly requestDigest: string;
  readonly outcome: "linked" | "unchanged" | "rejected";
  readonly current: string | null;
  readonly failureCode?: string;
}): CatalogDecisionDraft {
  return {
    key: "request",
    eventType: input.outcome === "rejected"
      ? "category_correlation_rejected"
      : "category_correlation_processed",
    actorType: "provider_category_correlation_request",
    actorId: actorId(input.request),
    reason: input.failureCode ?? input.outcome,
    afterState: {
      requestDigest: input.requestDigest,
      outcome: input.outcome,
      currentGlobalCategoryId: input.current,
      failureCode: input.failureCode ?? null,
    },
    occurredAt: input.request.observedAt,
  };
}

async function rejection(
  client: CentralQueryClient,
  request: NormalizedRequest,
  requestDigest: string,
  failureCode: Extract<CategoryCorrelationResult, { outcome: "rejected" }>["failureCode"],
  current: string | null,
): Promise<CategoryCorrelationResult> {
  const plan = await writeCatalogPlan(client, {
    decisions: [marker({
      request,
      requestDigest,
      outcome: "rejected",
      current,
      failureCode,
    })],
    promotions: [],
  });
  return {
    outcome: "rejected",
    currentGlobalCategoryId: current,
    confirmedProviderSequence: null,
    catalogEventSequence: plan.decisionSequences.get("request")!,
    failureCode,
  };
}

function correlationPromotion(input: {
  readonly decisionKey: string;
  readonly request: NormalizedRequest;
  readonly correlationId: string;
  readonly correlationVersion: bigint;
  readonly operation: "upsert" | "retire";
}): CatalogPromotionDraft {
  return {
    decisionKey: input.decisionKey,
    providerId: input.request.providerId,
    entityType: "provider_category_correlation",
    entityId: input.correlationId,
    entityVersion: input.correlationVersion,
    operation: input.operation,
    changedAt: input.request.observedAt,
    affectedProviderIds: [input.request.providerId],
    invalidationReason: "provider_category_correlation",
  };
}

async function correlate(
  client: CentralQueryClient,
  request: NormalizedRequest,
  requestDigest: string,
): Promise<CategoryCorrelationResult> {
  const priorMarker = await client.catalog_decision_events.findFirst({
    where: {
      actor_type: "provider_category_correlation_request",
      actor_id: actorId(request),
      event_type: { in: [
        "category_correlation_processed",
        "category_correlation_rejected",
      ] },
    },
    select: { sequence: true, after_state: true },
    orderBy: { sequence: "asc" },
  });
  if (priorMarker) {
    const state = priorMarker.after_state as Record<string, unknown> | null;
    if (state?.requestDigest !== requestDigest) {
      const conflict = await client.catalog_decision_events.findFirst({
        where: {
          actor_type: "provider_category_correlation_conflict",
          actor_id: actorId(request),
          event_type: "source_replay_conflict",
        },
        select: { sequence: true },
      });
      if (conflict) {
        return {
          outcome: "rejected",
          currentGlobalCategoryId: null,
          confirmedProviderSequence: null,
          catalogEventSequence: conflict.sequence,
          failureCode: "SOURCE_REPLAY_CONFLICT",
        };
      }
      const conflictPlan = await writeCatalogPlan(client, {
        decisions: [{
          key: "conflict",
          eventType: "source_replay_conflict",
          actorType: "provider_category_correlation_conflict",
          actorId: actorId(request),
          reason: "SOURCE_REPLAY_CONFLICT",
          beforeState: { originalRequestDigest: state?.requestDigest ?? null },
          afterState: { conflictingRequestDigest: requestDigest },
          occurredAt: request.observedAt,
        }],
        promotions: [],
      });
      return {
        outcome: "rejected",
        currentGlobalCategoryId: null,
        confirmedProviderSequence: null,
        catalogEventSequence: conflictPlan.decisionSequences.get("conflict")!,
        failureCode: "SOURCE_REPLAY_CONFLICT",
      };
    }
    const current = typeof state.currentGlobalCategoryId === "string"
      ? state.currentGlobalCategoryId
      : null;
    if (state.outcome === "rejected") {
      return {
        outcome: "rejected",
        currentGlobalCategoryId: current,
        confirmedProviderSequence: null,
        catalogEventSequence: priorMarker.sequence,
        failureCode: state.failureCode as Extract<
          CategoryCorrelationResult,
          { outcome: "rejected" }
        >["failureCode"],
      };
    }
    if (current !== null) {
      return {
        outcome: "unchanged",
        currentGlobalCategoryId: current,
        confirmedProviderSequence: request.providerChangeSequence,
        catalogEventSequence: priorMarker.sequence,
      };
    }
  }
  const [provider, category, active] = await Promise.all([
    client.providers.findUnique({ where: { id: request.providerId }, select: { id: true } }),
    client.global_categories.findUnique({
      where: { id: request.globalCategoryId },
      select: { id: true, lifecycle: true },
    }),
    client.provider_category_correlations.findFirst({
      where: {
        provider_id: request.providerId,
        local_category_id: request.localCategoryId,
        valid_to_event_sequence: null,
      },
      orderBy: { correlation_version: "desc" },
    }),
  ]);
  if (!provider) return rejection(client, request, requestDigest, "PROVIDER_NOT_FOUND", null);
  if (!category || category.lifecycle !== "active") {
    return rejection(
      client,
      request,
      requestDigest,
      "GLOBAL_CATEGORY_NOT_FOUND",
      active?.global_category_id ?? null,
    );
  }
  if (active && active.local_entity_version > request.localEntityVersion) {
    return rejection(
      client,
      request,
      requestDigest,
      "STALE_LOCAL_VERSION",
      active.global_category_id,
    );
  }
  if (active && active.global_category_id !== request.globalCategoryId) {
    return rejection(
      client,
      request,
      requestDigest,
      "DETERMINISTIC_OUTCOME_CONFLICT",
      active.global_category_id,
    );
  }
  const sameVersion = active?.local_entity_version === request.localEntityVersion;
  const outcome = sameVersion ? "unchanged" : "linked";
  const nextId = randomUUID();
  const nextVersion = (active?.correlation_version ?? 0n) + 1n;
  const decisions: CatalogDecisionDraft[] = [marker({
    request,
    requestDigest,
    outcome,
    current: request.globalCategoryId,
  })];
  const promotions: CatalogPromotionDraft[] = [];
  if (!sameVersion) {
    if (active) {
      decisions.push({
        key: "replacement",
        eventType: "correlation_replacement",
        actorType: "catalog_correlator",
        actorId: `${actorId(request)}:replacement`,
        reason: "correlation_replacement",
        afterState: { previousCorrelationId: active.id, nextCorrelationId: nextId },
        occurredAt: request.observedAt,
      });
      promotions.push(correlationPromotion({
        decisionKey: "replacement",
        request,
        correlationId: active.id,
        correlationVersion: active.correlation_version,
        operation: "retire",
      }));
    }
    decisions.push({
      key: "link",
      eventType: "deterministic_category_link",
      actorType: "catalog_correlator",
      actorId: `${actorId(request)}:link`,
      reason: "deterministic_category_link",
      afterState: { globalCategoryId: request.globalCategoryId },
      occurredAt: request.observedAt,
    });
    promotions.push(correlationPromotion({
      decisionKey: "link",
      request,
      correlationId: nextId,
      correlationVersion: nextVersion,
      operation: "upsert",
    }));
  }
  const plan = await writeCatalogPlan(client, { decisions, promotions });
  if (active && !sameVersion) {
    await client.provider_category_correlations.update({
      where: { id: active.id },
      data: {
        valid_to_event_sequence: plan.decisionSequences.get("replacement")!,
        valid_to: request.observedAt,
        row_version: active.row_version + 1n,
        updated_at: new Date(Math.max(
          Date.now(),
          request.observedAt.getTime(),
          active.updated_at.getTime() + 1,
        )),
      },
    });
  }
  if (!sameVersion) {
    await client.provider_category_correlations.create({
      data: {
        id: nextId,
        provider_id: request.providerId,
        local_category_id: request.localCategoryId,
        local_entity_version: request.localEntityVersion,
        global_category_id: request.globalCategoryId,
        correlation_version: nextVersion,
        rule_version: request.ruleVersion,
        method: "deterministic",
        confidence: confidenceDecimal(request.confidenceBasisPoints),
        valid_from_event_sequence: plan.decisionSequences.get("link")!,
        valid_from: request.observedAt,
      },
    });
  }
  return {
    outcome,
    currentGlobalCategoryId: request.globalCategoryId,
    confirmedProviderSequence: request.providerChangeSequence,
    catalogEventSequence: plan.decisionSequences.get("request")!,
  };
}

export class GlobalCategoryCorrelationRepository {
  constructor(private readonly client: CentralPrismaClient) {}

  correlateCategory(
    input: CorrelateProviderCategoryRequest,
  ): Promise<CategoryCorrelationResult> {
    const request = normalize(input);
    const requestDigest = digest(request);
    return this.correlateWithRetry(request, requestDigest);
  }

  private async correlateWithRetry(
    request: NormalizedRequest,
    requestDigest: string,
  ): Promise<CategoryCorrelationResult> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.client.$transaction(
          (transaction) => correlate(transaction, request, requestDigest),
          TRANSACTION_OPTIONS,
        );
      } catch (error) {
        const retryable = error !== null
          && typeof error === "object"
          && "code" in error
          && (
            error.code === "P2002"
            || error.code === "P2034"
            || (
              error.code === "P2010"
              && "meta" in error
              && error.meta !== null
              && typeof error.meta === "object"
              && "code" in error.meta
              && error.meta.code === "40001"
            )
          );
        if (attempt >= 3 || !retryable) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5 * (2 ** attempt)));
      }
    }
  }
}
