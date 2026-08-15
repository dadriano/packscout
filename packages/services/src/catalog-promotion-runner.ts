import {
  CatalogPromotionPreparationError,
  prepareCatalogPromotion,
  validateCatalogPromotionOperation,
  validateCatalogPromotionReceipt,
} from "./catalog-promotion-operations.ts";
import {
  CatalogPublicationClientError,
} from "./convex-catalog-publication-client.ts";
import type {
  CatalogPromotionAlertSink,
  CatalogPromotionBootstrapPort,
  CatalogPromotionClaim,
  CatalogPromotionClock,
  CatalogPromotionHealthSink,
  CatalogPromotionLedgerPort,
  CatalogPromotionOperation,
  CatalogPromotionPreparedSummary,
  CatalogPromotionRandom,
  CatalogPromotionScope,
  CatalogPromotionSettlementPort,
  CatalogPublicationTransport,
  CatalogReleaseAssemblerPort,
} from "./catalog-promotion-types.ts";
import { promotionRetryDelay } from "./promotion-retry-policy.ts";
import { CATALOG_PROMOTION_PATH_BY_KIND } from "./catalog-promotion-types.ts";
import type { ProductionReceipt } from "@packscout/contracts";

export type CatalogPromotionCycleResult = Readonly<{
  outcome:
    | "idle"
    | "progressed"
    | "retry_scheduled"
    | "published"
    | "unchanged"
    | "failed"
    | "lease_lost"
    | "stopped";
  attemptId: string | null;
  requestedWatermark: bigint | null;
  operationsAcknowledged: number;
  failureCode: string | null;
}>;

export interface CatalogPromotionRunnerOptions {
  readonly organizationId: string;
  readonly deploymentKey: string;
  readonly workerId: string;
  readonly ledger: CatalogPromotionLedgerPort;
  readonly settlement: CatalogPromotionSettlementPort;
  readonly assembler: CatalogReleaseAssemblerPort;
  readonly transport: CatalogPublicationTransport;
  readonly bootstrap?: CatalogPromotionBootstrapPort;
  readonly clock: CatalogPromotionClock;
  readonly alerts: CatalogPromotionAlertSink;
  readonly health?: CatalogPromotionHealthSink;
  readonly random?: CatalogPromotionRandom;
  readonly leaseMilliseconds?: number;
  readonly maximumOperationsPerCycle?: number;
  readonly maximumRetries?: number;
  readonly initialRetryMilliseconds?: number;
  readonly maximumRetryMilliseconds?: number;
}

const safeIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const safeUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError("Catalog promotion runner limit is invalid.");
  }
  return resolved;
}

function result(
  outcome: CatalogPromotionCycleResult["outcome"],
  claim: CatalogPromotionClaim | null,
  operationsAcknowledged = 0,
  failureCode: string | null = null,
): CatalogPromotionCycleResult {
  return {
    outcome,
    attemptId: claim?.attemptId ?? null,
    requestedWatermark: claim?.requestedWatermark ?? null,
    operationsAcknowledged,
    failureCode,
  };
}

function isCancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export class CatalogPromotionRunner {
  readonly #initialRetryMilliseconds: number;
  readonly #leaseMilliseconds: number;
  readonly #maximumOperationsPerCycle: number;
  readonly #maximumRetries: number;
  readonly #maximumRetryMilliseconds: number;
  readonly #random: CatalogPromotionRandom;
  readonly #scope: CatalogPromotionScope;
  #cycleInProgress = false;

  constructor(private readonly options: CatalogPromotionRunnerOptions) {
    if (!safeUuidPattern.test(options.organizationId) ||
        !safeIdPattern.test(options.deploymentKey) ||
        !safeIdPattern.test(options.workerId)) {
      throw new RangeError("Catalog promotion runner identity is invalid.");
    }
    this.#scope = {
      organizationId: options.organizationId.toLowerCase(),
      deploymentKey: options.deploymentKey,
      lane: "catalog",
    };
    this.#leaseMilliseconds = boundedInteger(
      options.leaseMilliseconds, 30_000, 5_000, 300_000,
    );
    this.#maximumOperationsPerCycle = boundedInteger(
      options.maximumOperationsPerCycle, 32, 1, 100,
    );
    this.#maximumRetries = boundedInteger(options.maximumRetries, 8, 1, 20);
    this.#initialRetryMilliseconds = boundedInteger(
      options.initialRetryMilliseconds, 500, 100, 60_000,
    );
    this.#maximumRetryMilliseconds = boundedInteger(
      options.maximumRetryMilliseconds, 30_000,
      this.#initialRetryMilliseconds, 300_000,
    );
    this.#random = options.random ?? { fraction: () => Math.random() };
  }

  async runCycle(signal?: AbortSignal): Promise<CatalogPromotionCycleResult> {
    if (this.#cycleInProgress) {
      throw new Error("Catalog promotion cycle is already running.");
    }
    this.#cycleInProgress = true;
    try {
      return await this.executeCycle(signal);
    } finally {
      try {
        if (!isCancelled(signal)) await this.reportHealth();
      } finally {
        this.#cycleInProgress = false;
      }
    }
  }

  private async executeCycle(
    signal: AbortSignal | undefined,
  ): Promise<CatalogPromotionCycleResult> {
    if (isCancelled(signal)) return result("stopped", null);
    const checkpoint = await this.options.settlement.getCheckpoint();
    if (isCancelled(signal)) return result("stopped", null);
    if (checkpoint.settledSequence <= 0n || checkpoint.settledAt === null) {
      return result("idle", null);
    }
    const now = this.options.clock.now();
    await this.options.ledger.coalesce({
      ...this.#scope,
      settledWatermark: checkpoint.settledSequence,
      requestedAt: now,
    });
    if (isCancelled(signal)) return result("stopped", null);
    try {
      await this.options.bootstrap?.ensureVerified({
        ...this.#scope,
        verifiedAt: now,
        signal,
      });
    } catch (error) {
      if (isCancelled(signal)) return result("stopped", null);
      throw error;
    }
    if (isCancelled(signal)) return result("stopped", null);
    const claim = await this.options.ledger.claim({
      ...this.#scope,
      workerId: this.options.workerId,
      now,
      leaseExpiresAt: this.leaseExpiresAt(now),
    });
    if (claim === null) return result("idle", null);
    if (isCancelled(signal)) return result("stopped", claim);
    const baseline = await this.options.ledger.loadBaseline(this.#scope);
    if (isCancelled(signal)) return result("stopped", claim);
    if (baseline !== null &&
        claim.requestedWatermark <= BigInt(baseline.observationSequence)) {
      return await this.failTerminal(claim, "CATALOG_WATERMARK_REGRESSED", null);
    }
    if (claim.requestedWatermark > checkpoint.settledSequence) {
      return await this.failTerminal(claim, "CATALOG_WATERMARK_UNSETTLED", null);
    }
    if (!(await this.heartbeat(claim))) return result("lease_lost", claim);
    if (isCancelled(signal)) return result("stopped", claim);

    let prepared = claim.prepared;
    let operations = claim.operations;
    if (prepared === null) {
      let plan;
      try {
        plan = await this.options.assembler.assemble({
          requestedWatermark: claim.requestedWatermark,
          baseline,
          trigger: baseline === null ? "full_rebuild" : "settled_change",
        });
      } catch {
        if (isCancelled(signal)) return result("stopped", claim);
        return await this.retry(claim, "CATALOG_ASSEMBLY_UNAVAILABLE", null);
      }
      if (isCancelled(signal)) return result("stopped", claim);
      if (plan.classification === "blocked") {
        return await this.failTerminal(
          claim,
          `CATALOG_ASSEMBLY_${plan.reason}`,
          null,
        );
      }
      const expectedPredecessor = baseline?.activePublicReleaseId ?? null;
      if (plan.requestedWatermark !== claim.requestedWatermark ||
          plan.expectedPredecessorPublicReleaseId !== expectedPredecessor ||
          plan.expectedActivePublicReleaseId !== expectedPredecessor) {
        return await this.failTerminal(claim, "CATALOG_ASSEMBLY_BASELINE_CONFLICT", null);
      }
      try {
        ({ prepared, operations } = prepareCatalogPromotion({ plan, baseline }));
      } catch (error) {
        const code = error instanceof CatalogPromotionPreparationError
          ? error.code
          : "PUBLICATION_REQUEST_INVALID";
        return await this.failTerminal(claim, code, null);
      }
      const persisted = await this.options.ledger.persistPreparedOperations({
        attemptId: claim.attemptId,
        claimToken: claim.claimToken,
        prepared,
        operations,
        preparedAt: this.options.clock.now(),
      });
      if (!persisted) return result("lease_lost", claim);
      if (isCancelled(signal)) return result("stopped", claim);
    }
    if (!this.validOperations(claim, prepared, operations)) {
      return await this.failTerminal(
        claim, "CATALOG_LEDGER_INVALID", null, prepared,
      );
    }
    return await this.executeOperations(claim, prepared, operations, signal);
  }

  private async executeOperations(
    claim: CatalogPromotionClaim,
    prepared: CatalogPromotionPreparedSummary,
    operations: readonly CatalogPromotionOperation[],
    signal: AbortSignal | undefined,
  ): Promise<CatalogPromotionCycleResult> {
    let acknowledged = 0;
    const receiptByOrdinal = new Map(
      operations.flatMap((operation) => operation.receipt === null
        ? [] : [[operation.ordinal, operation.receipt] as const]),
    );
    for (const operation of operations) {
      if (operation.receipt !== null) continue;
      if (isCancelled(signal)) {
        return result("stopped", claim, acknowledged);
      }
      if (acknowledged === this.#maximumOperationsPerCycle) {
        const continued = await this.options.ledger.scheduleRetry({
          attemptId: claim.attemptId,
          claimToken: claim.claimToken,
          failureCode: "CATALOG_CYCLE_BOUNDED",
          retryCount: claim.retryCount,
          retryAt: new Date(this.options.clock.now().getTime() + 1),
          acknowledgedAt: this.options.clock.now(),
        });
        return continued
          ? result("progressed", claim, acknowledged)
          : result("lease_lost", claim, acknowledged);
      }
      if (!(await this.heartbeat(claim))) {
        return result("lease_lost", claim, acknowledged);
      }
      if (isCancelled(signal)) {
        return result("stopped", claim, acknowledged);
      }
      try {
        let receipt: ProductionReceipt | null = null;
        if (operation.dispatchCount > 0) {
          receipt = await this.options.transport.status({
            operationId: operation.operationId,
            publicationId: operation.publicationId,
            expectedRequestDigest: operation.bodyDigest,
            expectedKind: operation.kind,
          }, signal);
          if (isCancelled(signal)) {
            return result("stopped", claim, acknowledged);
          }
          if (receipt !== null) {
            receipt = validateCatalogPromotionReceipt(receipt, {
              operationId: operation.operationId,
              publicationId: operation.publicationId,
              requestDigest: operation.bodyDigest,
              kind: operation.kind,
              bodyJson: operation.bodyJson,
            });
          }
        }
        if (receipt === null) {
          if (isCancelled(signal)) {
            return result("stopped", claim, acknowledged);
          }
          const dispatched = await this.options.ledger.markOperationDispatched({
            attemptId: claim.attemptId,
            claimToken: claim.claimToken,
            ordinal: operation.ordinal,
            dispatchedAt: this.options.clock.now(),
          });
          if (!dispatched) return result("lease_lost", claim, acknowledged);
          if (isCancelled(signal)) {
            return result("stopped", claim, acknowledged);
          }
          receipt = validateCatalogPromotionReceipt(
            await this.options.transport.send(operation, signal),
            {
              operationId: operation.operationId,
              publicationId: operation.publicationId,
              requestDigest: operation.bodyDigest,
              kind: operation.kind,
              bodyJson: operation.bodyJson,
            },
          );
        }
        if (isCancelled(signal)) {
          return result("stopped", claim, acknowledged);
        }
        const accepted = await this.options.ledger.acknowledgeOperation({
          attemptId: claim.attemptId,
          claimToken: claim.claimToken,
          ordinal: operation.ordinal,
          receipt,
          acknowledgedAt: this.options.clock.now(),
        });
        if (!accepted) return result("lease_lost", claim, acknowledged);
        receiptByOrdinal.set(operation.ordinal, receipt);
        acknowledged += 1;
      } catch (error) {
        if (isCancelled(signal)) {
          return result("stopped", claim, acknowledged);
        }
        if (error instanceof CatalogPublicationClientError &&
            error.disposition === "terminal" && !error.ambiguous) {
          return await this.failTerminal(claim, error.code, null, prepared);
        }
        if (error instanceof CatalogPromotionPreparationError) {
          return await this.retry(
            claim,
            "PUBLICATION_RESPONSE_INVALID",
            null,
            prepared,
          );
        }
        const retryAfter = error instanceof CatalogPublicationClientError
          ? error.retryAfterMilliseconds
          : null;
        const code = error instanceof CatalogPublicationClientError
          ? error.code
          : "PUBLICATION_NETWORK_ERROR";
        return await this.retry(claim, code, retryAfter, prepared);
      }
    }
    if (isCancelled(signal)) {
      return result("stopped", claim, acknowledged);
    }
    const finalReceipt = receiptByOrdinal.get(operations.at(-1)!.ordinal) ?? null;
    if (finalReceipt === null) {
      return await this.failTerminal(
        claim, "CATALOG_LEDGER_INVALID", null, prepared,
      );
    }
    const outcome = prepared.classification === "publish" ? "published" : "unchanged";
    const completed = await this.options.ledger.acknowledgeTerminal({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      outcome,
      failureCode: null,
      receipt: finalReceipt,
      completedAt: this.options.clock.now(),
      prepared,
    });
    return completed
      ? result(outcome, claim, acknowledged)
      : result("lease_lost", claim, acknowledged);
  }

  private validOperations(
    claim: CatalogPromotionClaim,
    prepared: CatalogPromotionPreparedSummary,
    operations: readonly CatalogPromotionOperation[],
  ): boolean {
    const isRefresh = prepared.classification === "refresh_unchanged";
    if (prepared.requestedWatermark !== claim.requestedWatermark ||
        operations.length === 0 ||
        (isRefresh &&
          (operations.length !== 1 || operations[0]?.kind !== "refreshObservation")) ||
        (!isRefresh &&
          (operations.length < 2 || operations[0]?.kind !== "start" ||
            operations.at(-1)?.kind !== "finalize" ||
            operations.slice(1, -1).some((operation) =>
              operation.kind !== "applyBatch")))) {
      return false;
    }
    let foundUnacknowledged = false;
    for (const [index, operation] of operations.entries()) {
      if (operation.ordinal !== index ||
          operation.publicationId !== prepared.publicReleaseId ||
          operation.path !== CATALOG_PROMOTION_PATH_BY_KIND[operation.kind] ||
          ((operation.acknowledgedAt === null) !== (operation.receipt === null)) ||
          operation.dispatchCount < 0 ||
          !Number.isSafeInteger(operation.dispatchCount)) {
        return false;
      }
      if (operation.receipt === null) {
        foundUnacknowledged = true;
      } else if (foundUnacknowledged) {
        return false;
      }
      try {
        validateCatalogPromotionOperation(operation);
        if (operation.receipt !== null) {
          validateCatalogPromotionReceipt(operation.receipt, {
            operationId: operation.operationId,
            publicationId: operation.publicationId,
            requestDigest: operation.bodyDigest,
            kind: operation.kind,
            bodyJson: operation.bodyJson,
          });
        }
      } catch {
        return false;
      }
    }
    return true;
  }

  private async retry(
    claim: CatalogPromotionClaim,
    failureCode: string,
    retryAfterMilliseconds: number | null,
    prepared: CatalogPromotionPreparedSummary | null = claim.prepared,
  ): Promise<CatalogPromotionCycleResult> {
    const retryCount = claim.retryCount + 1;
    if (retryCount > this.#maximumRetries) {
      return await this.failTerminal(
        claim, "CATALOG_RETRY_EXHAUSTED", null, prepared,
      );
    }
    const delay = promotionRetryDelay({
      currentRetryCount: claim.retryCount,
      initialRetryMilliseconds: this.#initialRetryMilliseconds,
      maximumRetryMilliseconds: this.#maximumRetryMilliseconds,
      retryAfterMilliseconds,
      randomFraction: this.#random.fraction(),
    });
    const now = this.options.clock.now();
    const scheduled = await this.options.ledger.scheduleRetry({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      failureCode,
      retryCount,
      retryAt: new Date(now.getTime() + delay),
      acknowledgedAt: now,
    });
    return scheduled
      ? result("retry_scheduled", claim, 0, failureCode)
      : result("lease_lost", claim, 0, failureCode);
  }

  private async failTerminal(
    claim: CatalogPromotionClaim,
    failureCode: string,
    receipt: ProductionReceipt | null,
    prepared: CatalogPromotionPreparedSummary | null = claim.prepared,
  ): Promise<CatalogPromotionCycleResult> {
    const now = this.options.clock.now();
    const completed = await this.options.ledger.acknowledgeTerminal({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      outcome: "failed",
      failureCode,
      receipt,
      completedAt: now,
      prepared,
    });
    if (!completed) return result("lease_lost", claim, 0, failureCode);
    try {
      await this.options.alerts.notify({
        attemptId: claim.attemptId,
        requestedWatermark: claim.requestedWatermark,
        failureCode,
        occurredAt: now,
      });
    } catch {
      // The durable terminal result remains authoritative if alert delivery fails.
    }
    return result("failed", claim, 0, failureCode);
  }

  private heartbeat(claim: CatalogPromotionClaim): Promise<boolean> {
    const now = this.options.clock.now();
    return this.options.ledger.heartbeat({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      now,
      leaseExpiresAt: this.leaseExpiresAt(now),
    });
  }

  private leaseExpiresAt(now: Date): Date {
    return new Date(now.getTime() + this.#leaseMilliseconds);
  }

  private async reportHealth(): Promise<void> {
    if (this.options.health === undefined) return;
    try {
      await this.options.health.report(
        await this.options.ledger.loadHealth(this.#scope),
      );
    } catch {
      // Health projection failure cannot mutate or retry a publication attempt.
    }
  }
}
