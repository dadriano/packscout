import { randomUUID } from "node:crypto";
import { Prisma as CentralPrisma } from "../prisma/generated/central/index.js";
import type { CentralPrismaClient, CentralQueryClient } from "./central-database.ts";
import {
  GlobalCatalogConflictError,
  GlobalCatalogInputError,
  normalizeGlobalCollectiblePublicIdentity,
  requireCatalogUuid,
  type GlobalCollectiblePublicIdentity,
  type GlobalCollectibleType,
} from "./global-catalog-contract.ts";
import {
  type CatalogDecisionDraft,
  type CatalogPromotionDraft,
  writeCatalogPlan,
} from "./global-catalog-ledger.ts";
import {
  affectedProvidersForCollectibles,
  resolveStoredCollectible,
} from "./global-catalog-resolution.ts";

const TRANSACTION_OPTIONS = Object.freeze({
  maxWait: 5_000,
  timeout: 30_000,
  isolationLevel: CentralPrisma.TransactionIsolationLevel.Serializable,
});
const COLLECTIBLE_TYPES = new Set<GlobalCollectibleType>([
  "card",
  "watch",
  "art",
  "coin",
  "sealed_product",
  "memorabilia",
  "other",
]);
const CATEGORY_KINDS = new Set<UpsertGlobalCategoryInput["categoryKind"]>([
  "vertical",
  "sport",
  "league",
  "franchise",
  "brand",
  "set",
  "other",
]);

export interface CatalogMaintenanceActor {
  readonly actorType: "catalog_maintenance" | "test_fixture";
  readonly actorId: string;
  readonly reason: string;
  readonly occurredAt?: Date;
}

export interface UpsertCanonicalCollectibleInput extends CatalogMaintenanceActor {
  readonly collectibleId: string;
  readonly primaryCategoryId: string | null;
  readonly collectibleType: GlobalCollectibleType;
  readonly publicIdentity: GlobalCollectiblePublicIdentity;
  readonly expectedRowVersion?: bigint;
}

export interface CanonicalCollectibleWriteResult {
  readonly collectibleId: string;
  readonly rowVersion: bigint;
  readonly materialChange: boolean;
  readonly catalogEventSequence: bigint | null;
}

export interface MergeCollectiblesInput extends CatalogMaintenanceActor {
  readonly aliasCollectibleId: string;
  readonly canonicalCollectibleId: string;
  readonly expectedAliasRowVersion?: bigint;
}

export interface MergeCollectiblesResult {
  readonly aliasCollectibleId: string;
  readonly canonicalCollectibleId: string;
  readonly materialChange: boolean;
  readonly catalogEventSequence: bigint | null;
}

export interface UpsertGlobalCategoryInput extends CatalogMaintenanceActor {
  readonly categoryId: string;
  readonly parentCategoryId: string | null;
  readonly categoryKey: string;
  readonly displayName: string;
  readonly categoryKind:
    | "vertical"
    | "sport"
    | "league"
    | "franchise"
    | "brand"
    | "set"
    | "other";
  readonly displayOrder: number;
  readonly expectedRowVersion?: bigint;
}

export interface GlobalCategoryWriteResult {
  readonly categoryId: string;
  readonly rowVersion: bigint;
  readonly materialChange: boolean;
  readonly catalogEventSequence: bigint | null;
}

function safeText(value: string, field: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new GlobalCatalogInputError(`${field} must be text.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new GlobalCatalogInputError(`${field} is outside its text bounds.`);
  }
  return normalized;
}

function event(input: {
  readonly key: string;
  readonly type: string;
  readonly actor: CatalogMaintenanceActor;
  readonly afterState: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
}): CatalogDecisionDraft {
  return {
    key: input.key,
    eventType: input.type,
    actorType: input.actor.actorType,
    actorId: safeText(input.actor.actorId, "actorId", 160),
    reason: safeText(input.actor.reason, "reason", 160),
    afterState: input.afterState,
    occurredAt: input.occurredAt,
  };
}

function promotion(input: Omit<CatalogPromotionDraft, "invalidationReason">): CatalogPromotionDraft {
  return { ...input, invalidationReason: input.entityType };
}

function materialTimestamp(now: Date, prior: Date): Date {
  return new Date(Math.max(Date.now(), now.getTime(), prior.getTime() + 1));
}

function normalizedComparable(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (CentralPrisma.Decimal.isDecimal(value)) return value.toFixed();
  if (Array.isArray(value)) return value.map(normalizedComparable);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, normalizedComparable(child)]));
  }
  return value;
}

function sameFields(
  current: Readonly<Record<string, unknown>>,
  desired: Readonly<Record<string, unknown>>,
): boolean {
  return Object.entries(desired).every(([key, value]) => (
    JSON.stringify(normalizedComparable(current[key]))
      === JSON.stringify(normalizedComparable(value))
  ));
}

function identityData(input: UpsertCanonicalCollectibleInput) {
  const identity = normalizeGlobalCollectiblePublicIdentity(input.publicIdentity);
  return {
    primary_category_id: input.primaryCategoryId === null
      ? null
      : requireCatalogUuid(input.primaryCategoryId, "primaryCategoryId"),
    collectible_type: input.collectibleType,
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

async function upsertCollectible(
  client: CentralQueryClient,
  input: UpsertCanonicalCollectibleInput,
): Promise<CanonicalCollectibleWriteResult> {
  const collectibleId = requireCatalogUuid(input.collectibleId, "collectibleId");
  if (!COLLECTIBLE_TYPES.has(input.collectibleType)) {
    throw new GlobalCatalogInputError("collectibleType is invalid.");
  }
  const desired = identityData(input);
  const current = await client.global_collectibles.findUnique({ where: { id: collectibleId } });
  const primaryCategory = desired.primary_category_id === null
    ? null
    : await client.global_categories.findUnique({
      where: { id: desired.primary_category_id },
      select: { lifecycle: true },
    });
  if (desired.primary_category_id !== null && primaryCategory?.lifecycle !== "active") {
    throw new GlobalCatalogConflictError(
      "CATALOG_WRITE_CONFLICT",
      "The primary global category does not exist or is retired.",
    );
  }
  if (input.expectedRowVersion !== undefined
      && input.expectedRowVersion !== (current?.row_version ?? 0n)) {
    throw new GlobalCatalogConflictError(
      "CATALOG_WRITE_CONFLICT",
      "The global collectible changed before this write committed.",
    );
  }
  if (current?.identity_state === "retired") {
    throw new GlobalCatalogConflictError(
      "CATALOG_WRITE_CONFLICT",
      "A retired global collectible is immutable.",
    );
  }
  if (current && current.identity_state !== "canonical") {
    throw new GlobalCatalogConflictError(
      "CATALOG_WRITE_CONFLICT",
      "Provisional identities are changed only by correlation decisions.",
    );
  }
  const existingPrimaryLink = desired.primary_category_id === null
    ? null
    : await client.global_collectible_categories.findFirst({
      where: {
        global_collectible_id: collectibleId,
        global_category_id: desired.primary_category_id,
        lifecycle: "active",
      },
      select: { id: true },
    });
  if (current
      && sameFields(current, desired)
      && (desired.primary_category_id === null || existingPrimaryLink !== null)) {
    return {
      collectibleId,
      rowVersion: current.row_version,
      materialChange: false,
      catalogEventSequence: null,
    };
  }
  const occurredAt = input.occurredAt ?? new Date();
  const nextVersion = (current?.row_version ?? 0n) + 1n;
  const primaryLinkId = desired.primary_category_id !== null
      && existingPrimaryLink === null
    ? randomUUID()
    : null;
  const affectedProviders = current
    ? await affectedProvidersForCollectibles(client, [collectibleId])
    : [];
  const decisions: CatalogDecisionDraft[] = [event({
    key: "collectible",
    type: current ? "collectible_update" : "canonical_creation",
    actor: input,
    afterState: {
      collectibleId,
      primaryCategoryId: desired.primary_category_id,
      rowVersion: nextVersion.toString(),
    },
    occurredAt,
  })];
  if (primaryLinkId !== null) {
    decisions.push(event({
      key: "primary_category_link",
      type: "collectible_category_link",
      actor: input,
      afterState: {
        linkId: primaryLinkId,
        collectibleId,
        categoryId: desired.primary_category_id,
      },
      occurredAt,
    }));
  }
  const promotions: CatalogPromotionDraft[] = [promotion({
    decisionKey: "collectible",
    providerId: null,
    entityType: "global_collectible",
    entityId: collectibleId,
    entityVersion: nextVersion,
    operation: "upsert",
    affectedProviderIds: affectedProviders,
    changedAt: occurredAt,
  })];
  if (primaryLinkId !== null) {
    promotions.push(promotion({
      decisionKey: "primary_category_link",
      providerId: null,
      entityType: "global_collectible_category",
      entityId: primaryLinkId,
      entityVersion: 1n,
      operation: "upsert",
      affectedProviderIds: affectedProviders,
      changedAt: occurredAt,
    }));
  }
  const plan = await writeCatalogPlan(client, {
    decisions,
    promotions,
  });
  if (!current) {
    await client.global_collectibles.create({
      data: { id: collectibleId, identity_state: "canonical", ...desired },
    });
  } else {
    await client.global_collectibles.update({
      where: { id: collectibleId },
      data: {
        ...desired,
        row_version: nextVersion,
        updated_at: materialTimestamp(occurredAt, current.updated_at),
      },
    });
  }
  if (primaryLinkId !== null) {
    await client.global_collectible_categories.create({
      data: {
        id: primaryLinkId,
        global_collectible_id: collectibleId,
        global_category_id: desired.primary_category_id!,
      },
    });
  }
  return {
    collectibleId,
    rowVersion: nextVersion,
    materialChange: true,
    catalogEventSequence: plan.decisionSequences.get("collectible")!,
  };
}

async function merge(
  client: CentralQueryClient,
  input: MergeCollectiblesInput,
): Promise<MergeCollectiblesResult> {
  const aliasId = requireCatalogUuid(input.aliasCollectibleId, "aliasCollectibleId");
  const requestedTargetId = requireCatalogUuid(
    input.canonicalCollectibleId,
    "canonicalCollectibleId",
  );
  if (aliasId === requestedTargetId) {
    throw new GlobalCatalogConflictError("ALIAS_CYCLE", "A collectible cannot alias itself.");
  }
  const existingAlias = await client.collectible_aliases.findUnique({
    where: { alias_collectible_id: aliasId },
  });
  const target = await resolveStoredCollectible(client, requestedTargetId);
  if (!target.canonical || target.canonical.identityState === "retired") {
    throw new GlobalCatalogConflictError(
      "ALIAS_CONFLICT",
      "The surviving global collectible does not exist.",
    );
  }
  if (existingAlias) {
    const existing = await resolveStoredCollectible(client, aliasId);
    if (existing.canonical?.id === target.canonical.id) {
      return {
        aliasCollectibleId: aliasId,
        canonicalCollectibleId: target.canonical.id,
        materialChange: false,
        catalogEventSequence: null,
      };
    }
    throw new GlobalCatalogConflictError(
      "ALIAS_CONFLICT",
      "A permanent collectible alias cannot be redirected.",
    );
  }
  if (target.path.includes(aliasId)) {
    throw new GlobalCatalogConflictError("ALIAS_CYCLE", "The merge would create an alias cycle.");
  }
  const source = await client.global_collectibles.findUnique({
    where: { id: aliasId },
    select: {
      collectible_type: true,
      identity_state: true,
      row_version: true,
      updated_at: true,
    },
  });
  if (!source || source.identity_state === "retired") {
    throw new GlobalCatalogConflictError(
      "ALIAS_CONFLICT",
      "The retiring global collectible does not exist.",
    );
  }
  if (input.expectedAliasRowVersion !== undefined
      && input.expectedAliasRowVersion !== source.row_version) {
    throw new GlobalCatalogConflictError(
      "CATALOG_WRITE_CONFLICT",
      "The global collectible changed before this merge committed.",
    );
  }
  if (source.collectible_type !== target.canonical.collectibleType) {
    throw new GlobalCatalogConflictError(
      "ALIAS_CONFLICT",
      "Global collectible aliases must preserve collectible type.",
    );
  }
  const occurredAt = input.occurredAt ?? new Date();
  const affectedProviders = await affectedProvidersForCollectibles(
    client,
    [aliasId, target.canonical.id],
  );
  const decisions = [
    event({
      key: "retirement",
      type: "retirement",
      actor: input,
      afterState: { retiredCollectibleId: aliasId },
      occurredAt,
    }),
    event({
      key: "alias",
      type: "alias_creation",
      actor: input,
      afterState: {
        aliasCollectibleId: aliasId,
        canonicalCollectibleId: target.canonical.id,
      },
      occurredAt,
    }),
  ];
  const plan = await writeCatalogPlan(client, {
    decisions,
    promotions: [
      promotion({
        decisionKey: "retirement",
        providerId: null,
        entityType: "global_collectible",
        entityId: aliasId,
        entityVersion: source.row_version + 1n,
        operation: "retire",
        affectedProviderIds: affectedProviders,
        changedAt: occurredAt,
      }),
      promotion({
        decisionKey: "alias",
        providerId: null,
        entityType: "collectible_alias",
        entityId: aliasId,
        entityVersion: 1n,
        operation: "upsert",
        affectedProviderIds: affectedProviders,
        changedAt: occurredAt,
      }),
    ],
  });
  await client.global_collectibles.update({
    where: { id: aliasId },
    data: {
      identity_state: "retired",
      retired_at: occurredAt,
      row_version: source.row_version + 1n,
      updated_at: materialTimestamp(occurredAt, source.updated_at),
    },
  });
  await client.collectible_aliases.create({
    data: {
      alias_collectible_id: aliasId,
      canonical_collectible_id: target.canonical.id,
      decision_event_sequence: plan.decisionSequences.get("alias")!,
    },
  });
  return {
    aliasCollectibleId: aliasId,
    canonicalCollectibleId: target.canonical.id,
    materialChange: true,
    catalogEventSequence: plan.decisionSequences.get("alias")!,
  };
}

async function upsertCategory(
  client: CentralQueryClient,
  input: UpsertGlobalCategoryInput,
): Promise<GlobalCategoryWriteResult> {
  const categoryId = requireCatalogUuid(input.categoryId, "categoryId");
  const parentCategoryId = input.parentCategoryId === null
    ? null
    : requireCatalogUuid(input.parentCategoryId, "parentCategoryId");
  if (!Number.isSafeInteger(input.displayOrder) || input.displayOrder < 0) {
    throw new GlobalCatalogInputError("displayOrder must be non-negative.");
  }
  if (!CATEGORY_KINDS.has(input.categoryKind)) {
    throw new GlobalCatalogInputError("categoryKind is invalid.");
  }
  const desired = {
    parent_category_id: parentCategoryId,
    category_key: safeText(input.categoryKey, "categoryKey", 120),
    display_name: safeText(input.displayName, "displayName", 100),
    category_kind: input.categoryKind,
    display_order: input.displayOrder,
  };
  const current = await client.global_categories.findUnique({ where: { id: categoryId } });
  if (input.expectedRowVersion !== undefined
      && input.expectedRowVersion !== (current?.row_version ?? 0n)) {
    throw new GlobalCatalogConflictError(
      "CATALOG_WRITE_CONFLICT",
      "The global category changed before this write committed.",
    );
  }
  if (current?.lifecycle === "retired") {
    throw new GlobalCatalogConflictError(
      "CATALOG_WRITE_CONFLICT",
      "A retired global category is immutable.",
    );
  }
  if (current && sameFields(current, desired)) {
    return {
      categoryId,
      rowVersion: current.row_version,
      materialChange: false,
      catalogEventSequence: null,
    };
  }
  const occurredAt = input.occurredAt ?? new Date();
  const nextVersion = (current?.row_version ?? 0n) + 1n;
  const correlated = current ? await client.provider_category_correlations.findMany({
    where: { global_category_id: categoryId, valid_to_event_sequence: null },
    select: { provider_id: true },
    distinct: ["provider_id"],
    orderBy: { provider_id: "asc" },
  }) : [];
  const plan = await writeCatalogPlan(client, {
    decisions: [event({
      key: "category",
      type: current ? "category_update" : "category_creation",
      actor: input,
      afterState: { categoryId, rowVersion: nextVersion.toString() },
      occurredAt,
    })],
    promotions: [promotion({
      decisionKey: "category",
      providerId: null,
      entityType: "global_category",
      entityId: categoryId,
      entityVersion: nextVersion,
      operation: "upsert",
      affectedProviderIds: correlated.map((row) => row.provider_id),
      changedAt: occurredAt,
    })],
  });
  if (!current) {
    await client.global_categories.create({ data: { id: categoryId, ...desired } });
  } else {
    await client.global_categories.update({
      where: { id: categoryId },
      data: {
        ...desired,
        row_version: nextVersion,
        updated_at: materialTimestamp(occurredAt, current.updated_at),
      },
    });
  }
  return {
    categoryId,
    rowVersion: nextVersion,
    materialChange: true,
    catalogEventSequence: plan.decisionSequences.get("category")!,
  };
}

export class GlobalCatalogMaintenanceRepository {
  constructor(private readonly client: CentralPrismaClient) {}

  upsertCanonicalCollectible(
    input: UpsertCanonicalCollectibleInput,
  ): Promise<CanonicalCollectibleWriteResult> {
    return this.client.$transaction(
      (transaction) => upsertCollectible(transaction, input),
      TRANSACTION_OPTIONS,
    );
  }

  mergeCollectibles(input: MergeCollectiblesInput): Promise<MergeCollectiblesResult> {
    return this.client.$transaction(
      (transaction) => merge(transaction, input),
      TRANSACTION_OPTIONS,
    );
  }

  upsertGlobalCategory(input: UpsertGlobalCategoryInput): Promise<GlobalCategoryWriteResult> {
    return this.client.$transaction(
      (transaction) => upsertCategory(transaction, input),
      TRANSACTION_OPTIONS,
    );
  }

  async resolveCollectibleId(collectibleId: string): Promise<string | null> {
    const resolution = await resolveStoredCollectible(this.client, collectibleId);
    return resolution.canonical?.id ?? null;
  }
}

export function randomCanonicalCollectibleId(): string {
  return randomUUID();
}
