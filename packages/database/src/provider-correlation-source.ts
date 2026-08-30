import {
  Prisma as ProviderPrisma,
  type PrismaClient as ProviderPrismaClient,
} from "../prisma/generated/provider/index.js";
import type {
  CorrelateProviderCategoryRequest,
  CategoryCorrelationResult,
} from "./global-category-correlation-repository.ts";
import type {
  CorrelateProviderCollectibleRequest,
  CorrelationResult,
  DeterministicCollectibleEvidence,
  GlobalCollectiblePublicIdentity,
  GlobalCollectibleType,
} from "./global-catalog-contract.ts";

export interface ProviderCollectibleCorrelationSourceRecord {
  readonly kind: "collectible";
  readonly sequence: bigint;
  readonly providerId: string;
  readonly localCollectibleId: string;
  readonly localEntityVersion: bigint;
  readonly sourceEntityVersion: bigint;
  readonly collectibleType: GlobalCollectibleType;
  readonly publicIdentity: GlobalCollectiblePublicIdentity;
}

export interface ProviderCategoryCorrelationSourceRecord {
  readonly kind: "category";
  readonly sequence: bigint;
  readonly providerId: string;
  readonly localCategoryId: string;
  readonly localEntityVersion: bigint;
  readonly sourceEntityVersion: bigint;
  readonly categoryKey: string;
  readonly displayName: string;
  readonly parentLocalCategoryId: string | null;
}

export interface IgnoredProviderChangeSourceRecord {
  readonly kind: "ignored";
  readonly sequence: bigint;
  readonly providerId: string;
  readonly safeReason: "not_correlatable" | "entity_retired";
}

export interface SupersededProviderChangeSourceRecord {
  readonly kind: "superseded";
  readonly sequence: bigint;
  readonly providerId: string;
  readonly sourceEntityVersion: bigint;
  readonly currentEntityVersion: bigint;
  readonly safeReason: "local_entity_advanced";
}

export type ProviderCorrelationSourceRecord =
  | ProviderCollectibleCorrelationSourceRecord
  | ProviderCategoryCorrelationSourceRecord
  | IgnoredProviderChangeSourceRecord
  | SupersededProviderChangeSourceRecord;

export interface ProviderCorrelationChangeBatch {
  readonly providerId: string;
  readonly headSequence: bigint;
  readonly records: readonly ProviderCorrelationSourceRecord[];
}

export interface ProviderCorrelationChangeSource {
  readAfter(input: {
    readonly afterSequence: bigint;
    readonly limit: number;
  }): Promise<ProviderCorrelationChangeBatch>;
}

export interface ProviderConsumerPositions {
  readonly catalogCorrelation: bigint;
  readonly providerRelease: bigint;
}

export interface ProviderCorrelationLease {
  readonly leaseOwner: string;
  readonly leaseFence: bigint;
  readonly leaseExpiresAt: Date;
}

export type ProviderCorrelationConfirmationKind =
  | "catalog_decision_event"
  | "local_change_ignored"
  | "local_change_superseded";

/**
 * Adapter seam owned by the provider runtime/checkpoint implementation. Task
 * 006 consumes it but intentionally does not create a second checkpoint store.
 */
export interface ProviderCorrelationCheckpointPort {
  acquireCatalogCorrelationLease(input: {
    readonly leaseOwner: string;
    readonly ttlMs: number;
  }): Promise<ProviderCorrelationLease | null>;
  renewCatalogCorrelationLease(input: {
    readonly lease: ProviderCorrelationLease;
    readonly ttlMs: number;
  }): Promise<ProviderCorrelationLease | null>;
  releaseCatalogCorrelationLease(lease: ProviderCorrelationLease): Promise<void>;
  readConsumerPositions(): Promise<ProviderConsumerPositions>;
  confirmCatalogCorrelation(input: {
    readonly lease: ProviderCorrelationLease;
    readonly expectedPreviousSequence: bigint;
    readonly confirmedSequence: bigint;
    readonly confirmationKind: ProviderCorrelationConfirmationKind;
    readonly confirmationId: string;
  }): Promise<"confirmed" | "conflict">;
}

export interface CollectibleCorrelationEvidenceResolver {
  resolve(
    source: ProviderCollectibleCorrelationSourceRecord,
  ): Promise<readonly DeterministicCollectibleEvidence[]>;
}

export interface CategoryCorrelationTargetResolver {
  resolve(source: ProviderCategoryCorrelationSourceRecord): Promise<{
    readonly globalCategoryId: string;
    readonly confidenceBasisPoints: number;
    readonly ruleVersion: string;
  } | null>;
}

export interface CollectibleCorrelatorPort {
  correlateCollectible(input: CorrelateProviderCollectibleRequest): Promise<CorrelationResult>;
}

export interface CategoryCorrelatorPort {
  correlateCategory(input: CorrelateProviderCategoryRequest): Promise<CategoryCorrelationResult>;
}

export type CorrelationWorkerFailureCode =
  | "CENTRAL_UNAVAILABLE"
  | "PROVIDER_SOURCE_UNAVAILABLE"
  | "PROVIDER_CHANGE_GAP"
  | "CHECKPOINT_LEASE_UNAVAILABLE"
  | "CHECKPOINT_CONFLICT"
  | "COLLECTIBLE_CORRELATION_REJECTED"
  | "CATEGORY_CORRELATION_REJECTED"
  | "CATEGORY_CORRELATION_RESOLVER_UNAVAILABLE";

export interface ProviderCorrelationRunResult {
  readonly providerId: string;
  readonly lastConfirmedSequence: bigint;
  readonly headSequence: bigint;
  readonly processedCount: number;
  readonly failureCode: CorrelationWorkerFailureCode | null;
  readonly observedAt: Date;
}

export interface ProviderCorrelationStatus {
  readonly providerId: string;
  readonly correlationLag: bigint;
  readonly lastConfirmedSequence: bigint;
  readonly headSequence: bigint;
  readonly safeFailureCode: CorrelationWorkerFailureCode | null;
  readonly observedAt: Date;
}

export function providerPromotionRetentionBoundary(
  positions: ProviderConsumerPositions,
): bigint {
  if (positions.catalogCorrelation < 0n || positions.providerRelease < 0n) {
    throw new TypeError("Provider consumer positions cannot be negative.");
  }
  return positions.catalogCorrelation < positions.providerRelease
    ? positions.catalogCorrelation
    : positions.providerRelease;
}

export function assertProviderChangeWindow(input: {
  readonly afterSequence: bigint;
  readonly headSequence: bigint;
  readonly returnedSequences: readonly bigint[];
}): void {
  if (input.headSequence < input.afterSequence) {
    throw new Error("PROVIDER_CHANGE_GAP");
  }
  if (input.headSequence > input.afterSequence
      && input.returnedSequences.length === 0) {
    throw new Error("PROVIDER_CHANGE_GAP");
  }
  if (input.returnedSequences[0] !== undefined
      && input.returnedSequences[0] !== input.afterSequence + 1n) {
    throw new Error("PROVIDER_CHANGE_GAP");
  }
  for (let index = 1; index < input.returnedSequences.length; index += 1) {
    if (input.returnedSequences[index] !== input.returnedSequences[index - 1]! + 1n) {
      throw new Error("PROVIDER_CHANGE_GAP");
    }
  }
  const last = input.returnedSequences.at(-1);
  if (last !== undefined && last > input.headSequence) {
    throw new Error("PROVIDER_CHANGE_GAP");
  }
}

export function classifyProviderSourceVersion(
  sourceEntityVersion: bigint,
  currentEntityVersion: bigint | null,
): "exact" | "superseded" {
  if (sourceEntityVersion < 1n) {
    throw new TypeError("Provider source entity version must be positive.");
  }
  if (currentEntityVersion === null || currentEntityVersion < sourceEntityVersion) {
    throw new Error("PROVIDER_CHANGE_GAP");
  }
  return currentEntityVersion === sourceEntityVersion ? "exact" : "superseded";
}

function requireReadBounds(afterSequence: bigint, limit: number): void {
  if (typeof afterSequence !== "bigint" || afterSequence < 0n) {
    throw new TypeError("afterSequence must be a non-negative bigint.");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError("Provider correlation batch limit must be between 1 and 100.");
  }
}

function publicIdentity(row: {
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
}): GlobalCollectiblePublicIdentity {
  return {
    displayName: row.display_name,
    normalizedName: row.normalized_name,
    year: row.year,
    brand: row.brand,
    setOrSeries: row.set_or_series,
    cardNumber: row.card_number,
    referenceNumber: row.reference_number,
    subject: row.subject,
    grade: row.grade,
    grader: row.grader,
    primaryImageUrl: row.primary_image_url,
    primaryImageAlt: row.primary_image_alt,
    valuationAmount: row.valuation_amount?.toFixed() ?? null,
    valuationCurrency: row.valuation_currency,
    valuationUsdAmount: row.valuation_usd_amount?.toFixed() ?? null,
    valuationUnavailableReason: row.valuation_unavailable_reason as
      GlobalCollectiblePublicIdentity["valuationUnavailableReason"],
    valuationType: row.valuation_type as GlobalCollectiblePublicIdentity["valuationType"],
    valuationObservedAt: row.valuation_observed_at,
    dataAsOf: row.data_as_of,
  };
}

/** Reads promotion order from one already role-verified provider client. */
export class PrismaProviderCorrelationChangeSource
implements ProviderCorrelationChangeSource {
  constructor(
    private readonly client: ProviderPrismaClient,
    private readonly expectedProviderId: string,
  ) {}

  async readAfter(input: {
    readonly afterSequence: bigint;
    readonly limit: number;
  }): Promise<ProviderCorrelationChangeBatch> {
    requireReadBounds(input.afterSequence, input.limit);
    return this.client.$transaction(async (snapshot) => {
    const [identity, ledger, changes] = await Promise.all([
      snapshot.database_identity.findUnique({
        where: { singleton_key: true },
        select: { database_role: true, provider_id: true },
      }),
      snapshot.promotion_ledger.findUnique({
        where: { singleton_key: true },
        select: { last_sequence: true },
      }),
      snapshot.promotion_changes.findMany({
        where: { sequence: { gt: input.afterSequence } },
        orderBy: { sequence: "asc" },
        take: input.limit,
      }),
    ]);
    if (!identity
        || identity.database_role !== "provider"
        || identity.provider_id !== this.expectedProviderId) {
      throw new Error("PROVIDER_SOURCE_UNAVAILABLE");
    }
    if (!ledger) throw new Error("PROVIDER_SOURCE_UNAVAILABLE");
    assertProviderChangeWindow({
      afterSequence: input.afterSequence,
      headSequence: ledger.last_sequence,
      returnedSequences: changes.map((change) => change.sequence),
    });
    const collectibleIds = changes
      .filter((change) => change.entity_type === "collectible" && change.operation === "upsert")
      .map((change) => change.entity_id);
    const categoryIds = changes
      .filter((change) => change.entity_type === "category" && change.operation === "upsert")
      .map((change) => change.entity_id);
    const [collectibles, categories] = await Promise.all([
      snapshot.collectibles.findMany({
        where: { id: { in: collectibleIds } },
      }),
      snapshot.categories.findMany({
        where: { id: { in: categoryIds } },
      }),
    ]);
    const collectiblesById = new Map(collectibles.map((row) => [row.id, row]));
    const categoriesById = new Map(categories.map((row) => [row.id, row]));
    const records: ProviderCorrelationSourceRecord[] = changes.map((change) => {
      if (change.entity_type === "collectible" && change.operation === "upsert") {
        const row = collectiblesById.get(change.entity_id);
        if (!row) throw new Error("PROVIDER_CHANGE_GAP");
        const versionState = classifyProviderSourceVersion(
          change.entity_version,
          row.row_version,
        );
        if (versionState === "superseded") {
          return {
            kind: "superseded",
            sequence: change.sequence,
            providerId: this.expectedProviderId,
            sourceEntityVersion: change.entity_version,
            currentEntityVersion: row.row_version,
            safeReason: "local_entity_advanced",
          };
        }
        if (row.lifecycle === "active") {
          return {
            kind: "collectible",
            sequence: change.sequence,
            providerId: this.expectedProviderId,
            localCollectibleId: row.id,
            localEntityVersion: row.row_version,
            sourceEntityVersion: change.entity_version,
            collectibleType: row.collectible_type,
            publicIdentity: publicIdentity(row),
          };
        }
        return {
          kind: "ignored",
          sequence: change.sequence,
          providerId: this.expectedProviderId,
          safeReason: "entity_retired",
        };
      }
      if (change.entity_type === "category" && change.operation === "upsert") {
        const row = categoriesById.get(change.entity_id);
        if (!row) throw new Error("PROVIDER_CHANGE_GAP");
        const versionState = classifyProviderSourceVersion(
          change.entity_version,
          row.row_version,
        );
        if (versionState === "superseded") {
          return {
            kind: "superseded",
            sequence: change.sequence,
            providerId: this.expectedProviderId,
            sourceEntityVersion: change.entity_version,
            currentEntityVersion: row.row_version,
            safeReason: "local_entity_advanced",
          };
        }
        if (row.lifecycle === "active") {
          return {
            kind: "category",
            sequence: change.sequence,
            providerId: this.expectedProviderId,
            localCategoryId: row.id,
            localEntityVersion: row.row_version,
            sourceEntityVersion: change.entity_version,
            categoryKey: row.category_key,
            displayName: row.display_name,
            parentLocalCategoryId: row.parent_category_id,
          };
        }
        return {
          kind: "ignored",
          sequence: change.sequence,
          providerId: this.expectedProviderId,
          safeReason: "entity_retired",
        };
      }
      return {
        kind: "ignored",
        sequence: change.sequence,
        providerId: this.expectedProviderId,
        safeReason: "not_correlatable",
      };
    });
    return {
      providerId: this.expectedProviderId,
      headSequence: ledger.last_sequence,
      records,
    };
    }, {
      maxWait: 5_000,
      timeout: 30_000,
      isolationLevel: ProviderPrisma.TransactionIsolationLevel.RepeatableRead,
    });
  }
}

export interface ProviderCorrelationProcessorOptions {
  readonly source: ProviderCorrelationChangeSource;
  readonly checkpoint: ProviderCorrelationCheckpointPort;
  readonly collectibleCorrelator: CollectibleCorrelatorPort;
  readonly collectibleEvidence: CollectibleCorrelationEvidenceResolver;
  readonly categoryCorrelator?: CategoryCorrelatorPort;
  readonly categoryTarget?: CategoryCorrelationTargetResolver;
  readonly collectibleRuleVersion: string;
  readonly leaseOwner: string;
  readonly leaseTtlMs?: number;
  readonly now?: () => Date;
}

export class ProviderCorrelationProcessor {
  #activeRun: Promise<ProviderCorrelationRunResult> | null = null;

  constructor(private readonly options: ProviderCorrelationProcessorOptions) {}

  runBatch(limit = 50): Promise<ProviderCorrelationRunResult> {
    if (this.#activeRun) return this.#activeRun;
    const run = this.runLeasedBatch(limit).finally(() => {
      if (this.#activeRun === run) this.#activeRun = null;
    });
    this.#activeRun = run;
    return run;
  }

  private async runLeasedBatch(limit: number): Promise<ProviderCorrelationRunResult> {
    const observedAt = this.options.now?.() ?? new Date();
    const leaseTtlMs = this.options.leaseTtlMs ?? 30_000;
    if (!Number.isInteger(leaseTtlMs) || leaseTtlMs < 1_000 || leaseTtlMs > 120_000) {
      throw new TypeError("Correlation lease TTL must be between 1 and 120 seconds.");
    }
    if (typeof this.options.leaseOwner !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(this.options.leaseOwner)) {
      throw new TypeError("A unique scoped correlation lease owner is required.");
    }
    let lease: ProviderCorrelationLease | null;
    try {
      lease = await this.options.checkpoint.acquireCatalogCorrelationLease({
        leaseOwner: this.options.leaseOwner,
        ttlMs: leaseTtlMs,
      });
    } catch {
      return {
        providerId: "unavailable",
        lastConfirmedSequence: 0n,
        headSequence: 0n,
        processedCount: 0,
        failureCode: "PROVIDER_SOURCE_UNAVAILABLE",
        observedAt,
      };
    }
    if (lease === null) {
      return {
        providerId: "unavailable",
        lastConfirmedSequence: 0n,
        headSequence: 0n,
        processedCount: 0,
        failureCode: "CHECKPOINT_LEASE_UNAVAILABLE",
        observedAt,
      };
    }
    try {
    let positions: ProviderConsumerPositions;
    try {
      positions = await this.options.checkpoint.readConsumerPositions();
    } catch {
      return {
        providerId: "unavailable",
        lastConfirmedSequence: 0n,
        headSequence: 0n,
        processedCount: 0,
        failureCode: "PROVIDER_SOURCE_UNAVAILABLE",
        observedAt,
      };
    }
    let batch: ProviderCorrelationChangeBatch;
    try {
      batch = await this.options.source.readAfter({
        afterSequence: positions.catalogCorrelation,
        limit,
      });
    } catch (error) {
      const code = error instanceof Error && error.message === "PROVIDER_CHANGE_GAP"
        ? "PROVIDER_CHANGE_GAP"
        : "PROVIDER_SOURCE_UNAVAILABLE";
      return {
        providerId: "unavailable",
        lastConfirmedSequence: positions.catalogCorrelation,
        headSequence: positions.catalogCorrelation,
        processedCount: 0,
        failureCode: code,
        observedAt,
      };
    }
    let confirmed = positions.catalogCorrelation;
    let processedCount = 0;
    for (const record of batch.records) {
      let confirmationId = `catalog-correlation:skip:${record.sequence}`;
      let confirmationKind: ProviderCorrelationConfirmationKind = record.kind === "superseded"
        ? "local_change_superseded"
        : "local_change_ignored";
      let renewed: ProviderCorrelationLease | null;
      try {
        renewed = await this.options.checkpoint.renewCatalogCorrelationLease({
          lease,
          ttlMs: leaseTtlMs,
        });
      } catch {
        return {
          providerId: batch.providerId,
          lastConfirmedSequence: confirmed,
          headSequence: batch.headSequence,
          processedCount,
          failureCode: "PROVIDER_SOURCE_UNAVAILABLE",
          observedAt,
        };
      }
      if (renewed === null) {
        return {
          providerId: batch.providerId,
          lastConfirmedSequence: confirmed,
          headSequence: batch.headSequence,
          processedCount,
          failureCode: "CHECKPOINT_LEASE_UNAVAILABLE",
          observedAt,
        };
      }
      lease = renewed;
      try {
        if (record.kind === "collectible") {
          const evidence = await this.options.collectibleEvidence.resolve(record);
          const result = await this.options.collectibleCorrelator.correlateCollectible({
            providerId: record.providerId,
            localCollectibleId: record.localCollectibleId,
            localEntityVersion: record.localEntityVersion,
            collectibleType: record.collectibleType,
            publicIdentity: record.publicIdentity,
            deterministicEvidence: evidence,
            ruleVersion: this.options.collectibleRuleVersion,
            providerChangeSequence: record.sequence,
            observedAt,
          });
          if (result.outcome === "rejected") {
            return {
              providerId: batch.providerId,
              lastConfirmedSequence: confirmed,
              headSequence: batch.headSequence,
              processedCount,
              failureCode: "COLLECTIBLE_CORRELATION_REJECTED",
              observedAt,
            };
          }
          confirmationId = `catalog-event:${result.catalogEventSequence}`;
          confirmationKind = "catalog_decision_event";
        } else if (record.kind === "category") {
          if (!this.options.categoryCorrelator || !this.options.categoryTarget) {
            return {
              providerId: batch.providerId,
              lastConfirmedSequence: confirmed,
              headSequence: batch.headSequence,
              processedCount,
              failureCode: "CATEGORY_CORRELATION_RESOLVER_UNAVAILABLE",
              observedAt,
            };
          }
          const target = await this.options.categoryTarget.resolve(record);
          if (target === null) {
            return {
              providerId: batch.providerId,
              lastConfirmedSequence: confirmed,
              headSequence: batch.headSequence,
              processedCount,
              failureCode: "CATEGORY_CORRELATION_REJECTED",
              observedAt,
            };
          }
          const result = await this.options.categoryCorrelator.correlateCategory({
            providerId: record.providerId,
            localCategoryId: record.localCategoryId,
            localEntityVersion: record.localEntityVersion,
            globalCategoryId: target.globalCategoryId,
            ruleVersion: target.ruleVersion,
            confidenceBasisPoints: target.confidenceBasisPoints,
            providerChangeSequence: record.sequence,
            observedAt,
          });
          if (result.outcome === "rejected") {
            return {
              providerId: batch.providerId,
              lastConfirmedSequence: confirmed,
              headSequence: batch.headSequence,
              processedCount,
              failureCode: "CATEGORY_CORRELATION_REJECTED",
              observedAt,
            };
          }
          confirmationId = `catalog-event:${result.catalogEventSequence}`;
          confirmationKind = "catalog_decision_event";
        }
      } catch {
        return {
          providerId: batch.providerId,
          lastConfirmedSequence: confirmed,
          headSequence: batch.headSequence,
          processedCount,
          failureCode: "CENTRAL_UNAVAILABLE",
          observedAt,
        };
      }
      let confirmationLease: ProviderCorrelationLease | null;
      try {
        confirmationLease = await this.options.checkpoint.renewCatalogCorrelationLease({
          lease,
          ttlMs: leaseTtlMs,
        });
      } catch {
        return {
          providerId: batch.providerId,
          lastConfirmedSequence: confirmed,
          headSequence: batch.headSequence,
          processedCount,
          failureCode: "PROVIDER_SOURCE_UNAVAILABLE",
          observedAt,
        };
      }
      if (confirmationLease === null) {
        return {
          providerId: batch.providerId,
          lastConfirmedSequence: confirmed,
          headSequence: batch.headSequence,
          processedCount,
          failureCode: "CHECKPOINT_LEASE_UNAVAILABLE",
          observedAt,
        };
      }
      lease = confirmationLease;
      let checkpoint: "confirmed" | "conflict";
      try {
        checkpoint = await this.options.checkpoint.confirmCatalogCorrelation({
          lease,
          expectedPreviousSequence: confirmed,
          confirmedSequence: record.sequence,
          confirmationKind,
          confirmationId,
        });
      } catch {
        return {
          providerId: batch.providerId,
          lastConfirmedSequence: confirmed,
          headSequence: batch.headSequence,
          processedCount,
          failureCode: "PROVIDER_SOURCE_UNAVAILABLE",
          observedAt,
        };
      }
      if (checkpoint === "conflict") {
        return {
          providerId: batch.providerId,
          lastConfirmedSequence: confirmed,
          headSequence: batch.headSequence,
          processedCount,
          failureCode: "CHECKPOINT_CONFLICT",
          observedAt,
        };
      }
      confirmed = record.sequence;
      processedCount += 1;
    }
    return {
      providerId: batch.providerId,
      lastConfirmedSequence: confirmed,
      headSequence: batch.headSequence,
      processedCount,
      failureCode: null,
      observedAt,
    };
    } finally {
      await this.options.checkpoint.releaseCatalogCorrelationLease(lease).catch(() => undefined);
    }
  }

  async status(
    safeFailureCode: CorrelationWorkerFailureCode | null = null,
  ): Promise<ProviderCorrelationStatus> {
    const positions = await this.options.checkpoint.readConsumerPositions();
    const batch = await this.options.source.readAfter({
      afterSequence: positions.catalogCorrelation,
      limit: 1,
    });
    return {
      providerId: batch.providerId,
      correlationLag: batch.headSequence - positions.catalogCorrelation,
      lastConfirmedSequence: positions.catalogCorrelation,
      headSequence: batch.headSequence,
      safeFailureCode,
      observedAt: this.options.now?.() ?? new Date(),
    };
  }
}
