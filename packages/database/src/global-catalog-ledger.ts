import { Prisma as CentralPrisma } from "../prisma/generated/central/index.js";
import type { CentralQueryClient } from "./central-database.ts";
import { GlobalCatalogInputError } from "./global-catalog-contract.ts";

export type CatalogPromotionEntityType =
  | "global_category"
  | "global_collectible"
  | "global_collectible_category"
  | "global_collectible_name_alias"
  | "collectible_alias"
  | "provider_category_correlation"
  | "provider_collectible_correlation";

export interface CatalogDecisionDraft {
  readonly key: string;
  readonly eventType: string;
  readonly actorType: string;
  readonly actorId: string;
  readonly reason: string;
  readonly beforeState?: Readonly<Record<string, unknown>> | null;
  readonly afterState?: Readonly<Record<string, unknown>> | null;
  readonly occurredAt: Date;
}

export interface CatalogPromotionDraft {
  readonly decisionKey: string;
  readonly providerId: string | null;
  readonly entityType: CatalogPromotionEntityType;
  readonly entityId: string;
  readonly entityVersion: bigint;
  readonly operation: "upsert" | "retire";
  readonly changedAt: Date;
  readonly affectedProviderIds: readonly string[];
  readonly invalidationReason: string;
}

export interface WrittenCatalogPlan {
  readonly decisionSequences: ReadonlyMap<string, bigint>;
  readonly promotionSequences: readonly bigint[];
  readonly lastCatalogSequence: bigint;
}

function safeText(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new GlobalCatalogInputError(`${field} is outside its durable evidence bounds.`);
  }
  return normalized;
}

function toJson(
  value: Readonly<Record<string, unknown>> | null | undefined,
): CentralPrisma.InputJsonObject | typeof CentralPrisma.DbNull {
  if (value === null || value === undefined) return CentralPrisma.DbNull;
  const serialized = JSON.stringify(value, (_key, child: unknown) => (
    typeof child === "bigint" ? child.toString() : child
  ));
  if (Buffer.byteLength(serialized, "utf8") > 4_096) {
    throw new GlobalCatalogInputError("Catalog decision state exceeds 4096 bytes.");
  }
  return JSON.parse(serialized) as CentralPrisma.InputJsonObject;
}

async function allocateCatalogRange(
  client: CentralQueryClient,
  count: number,
): Promise<{ readonly first: bigint; readonly last: bigint }> {
  if (!Number.isInteger(count) || count < 1 || count > 128) {
    throw new GlobalCatalogInputError("Catalog ledger allocation is invalid.");
  }
  const rows = await client.$queryRaw<readonly { last_sequence: bigint }[]>(
    CentralPrisma.sql`
      UPDATE "catalog_ledger"
      SET "last_sequence" = "last_sequence" + ${BigInt(count)},
          "updated_at" = GREATEST(
            "updated_at" + interval '1 microsecond',
            clock_timestamp()
          )
      WHERE "singleton_key" = true
      RETURNING "last_sequence"
    `,
  );
  const last = rows[0]?.last_sequence;
  if (last === undefined) {
    throw new Error("The catalog ledger singleton is unavailable.");
  }
  return { first: last - BigInt(count) + 1n, last };
}

async function appendInvalidations(
  client: CentralQueryClient,
  promotions: readonly CatalogPromotionDraft[],
  promotionSequences: readonly bigint[],
): Promise<void> {
  const rows = promotions.flatMap((promotion, promotionIndex) => (
    [...new Set(promotion.affectedProviderIds)].sort().map((providerId) => ({
      providerId,
      catalogChangeSequence: promotionSequences[promotionIndex]!,
      reason: safeText(promotion.invalidationReason, "invalidationReason", 160),
    }))
  ));
  if (rows.length === 0) return;
  if (rows.length > 256) {
    throw new GlobalCatalogInputError("Provider invalidation fanout exceeds its bound.");
  }
  const allocation = await client.$queryRaw<readonly { last_sequence: bigint }[]>(
    CentralPrisma.sql`
      UPDATE "provider_release_invalidation_ledger"
      SET "last_sequence" = "last_sequence" + ${BigInt(rows.length)},
          "updated_at" = GREATEST(
            "updated_at" + interval '1 microsecond',
            clock_timestamp()
          )
      WHERE "singleton_key" = true
      RETURNING "last_sequence"
    `,
  );
  const last = allocation[0]?.last_sequence;
  if (last === undefined) {
    throw new Error("The provider invalidation ledger singleton is unavailable.");
  }
  const first = last - BigInt(rows.length) + 1n;
  await client.provider_invalidation_checkpoints.createMany({
    data: [...new Set(rows.map((row) => row.providerId))]
      .sort()
      .map((providerId) => ({ provider_id: providerId })),
    skipDuplicates: true,
  });
  await client.provider_release_invalidations.createMany({
    data: rows.map((row, index) => ({
      sequence: first + BigInt(index),
      provider_id: row.providerId,
      catalog_change_sequence: row.catalogChangeSequence,
      reason: row.reason,
    })),
  });
}

/**
 * Allocates and materializes decision, promotion, and affected-provider
 * invalidation rows inside the caller's central transaction.
 */
export async function writeCatalogPlan(
  client: CentralQueryClient,
  input: {
    readonly decisions: readonly CatalogDecisionDraft[];
    readonly promotions: readonly CatalogPromotionDraft[];
  },
): Promise<WrittenCatalogPlan> {
  if (input.decisions.length === 0) {
    throw new GlobalCatalogInputError("A catalog plan requires a decision event.");
  }
  const keys = new Set(input.decisions.map((decision) => decision.key));
  if (keys.size !== input.decisions.length) {
    throw new GlobalCatalogInputError("Catalog decision keys must be unique.");
  }
  for (const promotion of input.promotions) {
    if (!keys.has(promotion.decisionKey)) {
      throw new GlobalCatalogInputError("A catalog promotion lacks its decision event.");
    }
    if (promotion.entityVersion <= 0n) {
      throw new GlobalCatalogInputError("Catalog promotion versions must be positive.");
    }
    if (promotion.entityType.startsWith("provider_")
        && promotion.providerId === null) {
      throw new GlobalCatalogInputError("Provider correlation promotions require a provider ID.");
    }
    if (promotion.providerId !== null
        && !promotion.affectedProviderIds.includes(promotion.providerId)) {
      throw new GlobalCatalogInputError("Provider correlation promotion lacks its invalidation.");
    }
  }
  const allocation = await allocateCatalogRange(
    client,
    input.decisions.length + input.promotions.length,
  );
  const decisionSequences = new Map<string, bigint>();
  input.decisions.forEach((decision, index) => {
    decisionSequences.set(decision.key, allocation.first + BigInt(index));
  });
  const promotionSequences = input.promotions.map((_, index) => (
    allocation.first + BigInt(input.decisions.length + index)
  ));

  await client.catalog_decision_events.createMany({
    data: input.decisions.map((decision) => ({
      sequence: decisionSequences.get(decision.key)!,
      event_type: safeText(decision.eventType, "eventType", 80),
      actor_type: safeText(decision.actorType, "actorType", 80),
      actor_id: safeText(decision.actorId, "actorId", 180),
      reason: safeText(decision.reason, "reason", 160),
      before_state: toJson(decision.beforeState),
      after_state: toJson(decision.afterState),
      occurred_at: decision.occurredAt,
    })),
  });
  if (input.promotions.length > 0) {
    await client.catalog_promotion_changes.createMany({
      data: input.promotions.map((promotion, index) => ({
        sequence: promotionSequences[index]!,
        decision_event_sequence: decisionSequences.get(promotion.decisionKey)!,
        provider_id: promotion.providerId,
        entity_type: promotion.entityType,
        entity_id: promotion.entityId,
        entity_version: promotion.entityVersion,
        operation: promotion.operation,
        changed_at: promotion.changedAt,
      })),
    });
    await appendInvalidations(client, input.promotions, promotionSequences);
  }
  return {
    decisionSequences,
    promotionSequences,
    lastCatalogSequence: allocation.last,
  };
}
