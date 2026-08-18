import { createHash } from "node:crypto";
import {
  MAX_PRODUCTION_HEAT_BATCH_COUNT,
  canonicalJson,
  productionHeatReceiptHash,
} from "@packscout/contracts";
import { CatalogPublicationClientError } from "./convex-catalog-publication-client.ts";
import {
  HeatPromotionPreparationError,
  heatPromotionContentIdentity,
  prepareHeatPromotion,
  validateHeatBatchProgressReceipt,
  validateHeatPromotionOperation,
  validateHeatPromotionOperationSet,
  validateHeatPromotionReceipt,
  validateHeatTerminalReceipt,
} from "./heat-promotion-operations.ts";
import type {
  ActiveCatalogHeatManifest,
  HeatPromotionAlertSink,
  HeatPromotionBootstrapPort,
  HeatPromotionClaim,
  HeatPromotionClock,
  HeatPromotionHealthSink,
  HeatPromotionLedgerPort,
  HeatPromotionObservationPort,
  HeatPromotionManifestProofPort,
  HeatPromotionOperation,
  HeatPromotionSettlementPort,
  HeatPublicationTransport,
} from "./heat-promotion-types.ts";
import { promotionRetryDelay } from "./promotion-retry-policy.ts";

export type HeatPromotionCycleResult = Readonly<{
  outcome:
    | "idle" | "progressed" | "retry_scheduled" | "published"
    | "failed" | "lease_lost" | "stopped";
  attemptId: string | null;
  frameSequence: bigint | null;
  operationsAcknowledged: number;
  reusedSignalSet: boolean;
  failureCode: string | null;
}>;

export interface HeatPromotionRunnerOptions {
  readonly workerId: string;
  readonly ledger: HeatPromotionLedgerPort;
  readonly settlement: HeatPromotionSettlementPort;
  readonly manifests: HeatPromotionManifestProofPort;
  readonly observations: HeatPromotionObservationPort;
  readonly transport: HeatPublicationTransport;
  readonly bootstrap: HeatPromotionBootstrapPort;
  readonly clock: HeatPromotionClock;
  readonly alerts: HeatPromotionAlertSink;
  readonly health?: HeatPromotionHealthSink;
  readonly random?: { fraction(): number };
  readonly leaseMilliseconds?: number;
  readonly maximumOperationsPerCycle?: number;
  readonly maximumRetries?: number;
  readonly initialRetryMilliseconds?: number;
  readonly maximumRetryMilliseconds?: number;
}

const workerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const reconciliationTerminalCodes = new Set([
  "PUBLICATION_PREDECESSOR_CONFLICT",
  "PUBLICATION_RECONCILIATION_FAILED",
  "PUBLICATION_STATE_CONFLICT",
]);

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new RangeError("Heat promotion runner limit is invalid.");
  }
  return resolved;
}

function cycleResult(
  outcome: HeatPromotionCycleResult["outcome"],
  claim: HeatPromotionClaim | null,
  operationsAcknowledged = 0,
  reusedSignalSet = false,
  failureCode: string | null = null,
): HeatPromotionCycleResult {
  return {
    outcome,
    attemptId: claim?.attemptId ?? null,
    frameSequence: claim?.targetWatermark ?? null,
    operationsAcknowledged,
    reusedSignalSet,
    failureCode,
  };
}

function cancelled(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function heatFrameSequence(frameEndedAt: Date): bigint {
  const milliseconds = frameEndedAt.getTime();
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds <= 0 ||
    milliseconds % 60_000 !== 0
  ) throw new RangeError("Heat frame boundary is invalid.");
  const sequence = milliseconds / 60_000;
  if (!Number.isSafeInteger(sequence) || sequence <= 0) {
    throw new RangeError("Heat frame sequence is invalid.");
  }
  return BigInt(sequence);
}

function frameEndedAt(sequence: bigint): Date {
  const numeric = Number(sequence);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new HeatPromotionPreparationError("HEAT_FRAME_SEQUENCE_INVALID");
  }
  const value = new Date(numeric * 60_000);
  if (!Number.isFinite(value.getTime())) {
    throw new HeatPromotionPreparationError("HEAT_FRAME_SEQUENCE_INVALID");
  }
  return value;
}

function operationPublicationId(operation: HeatPromotionOperation): string {
  try {
    const value = JSON.parse(operation.canonicalRequestBody) as {
      publicationId?: unknown;
    };
    if (typeof value.publicationId === "string") return value.publicationId;
  } catch {
    // The stable validation error below owns malformed persisted bytes.
  }
  throw new HeatPromotionPreparationError("HEAT_OPERATION_INVALID");
}

function reusedSignalSet(operations: readonly HeatPromotionOperation[]): boolean {
  return operations.length === 1 && operations[0]?.operationKind === "refreshFrame";
}

function validManifestSourceProof(
  proof: ActiveCatalogHeatManifest,
  input: Readonly<{
    manifestAlignment: ActiveCatalogHeatManifest["manifestAlignment"];
    publicRepackIds: readonly string[] | null;
    signalCount: number;
  }>,
): boolean {
  if (
    canonicalJson(proof.manifestAlignment) !==
      canonicalJson(input.manifestAlignment) ||
    proof.confirmedManifestWatermark < 0n ||
    !/^[0-9a-f]{64}$/u.test(proof.terminalReceiptSha256) ||
    proof.publicRepackIds.length !== input.signalCount ||
    proof.publicRepackOwnership.length !== proof.publicRepackIds.length
  ) return false;
  let previousOwnershipKey: string | null = null;
  const ownershipIds: string[] = [];
  for (const ownership of proof.publicRepackOwnership) {
    const ownershipKey = `${ownership.platformKey}\n${ownership.publicRepackId}`;
    if (
      previousOwnershipKey !== null && ownershipKey <= previousOwnershipKey
    ) return false;
    previousOwnershipKey = ownershipKey;
    ownershipIds.push(ownership.publicRepackId);
  }
  ownershipIds.sort();
  if (canonicalJson(ownershipIds) !== canonicalJson(proof.publicRepackIds)) {
    return false;
  }
  return input.publicRepackIds === null ||
    canonicalJson(proof.publicRepackIds) === canonicalJson(input.publicRepackIds);
}

async function validPersistedOperations(
  claim: HeatPromotionClaim,
  operations: readonly HeatPromotionOperation[],
): Promise<boolean> {
  if (
    claim.contentIdentity === null ||
    claim.publicationIdentity === null ||
    claim.manifestSourceProof === null ||
    operations.length === 0 ||
    !(
      reusedSignalSet(operations) ||
      (operations.length >= 2 &&
        operations[0]?.operationKind === "start" &&
        operations.at(-1)?.operationKind === "finalize" &&
        operations.slice(1, -1).every(({ operationKind }) =>
          operationKind === "applyBatch"))
    )
  ) return false;
  try {
    const validatedSet = await validateHeatPromotionOperationSet(operations);
    if (
      claim.expectedPredecessorIdentity !==
        validatedSet.expectedPreviousPublicHeatFrameId ||
      !validManifestSourceProof(claim.manifestSourceProof, {
        manifestAlignment: validatedSet.frame.manifestAlignment,
        publicRepackIds: validatedSet.publicRepackIds,
        signalCount: validatedSet.frame.signalCount,
      }) ||
      claim.contentIdentity !== await heatPromotionContentIdentity({
        manifestAlignment: validatedSet.frame.manifestAlignment,
        signalSetHash: validatedSet.frame.signalSetHash,
      })
    ) return false;
  } catch {
    return false;
  }
  let sawPending = false;
  for (const [index, operation] of operations.entries()) {
    if (
      operation.operationIndex !== index ||
      operationPublicationId(operation) !== claim.publicationIdentity ||
      (operation.receiptBody === null) !== (operation.acknowledgedAt === null) ||
      (operation.receiptBody === null) !== (operation.receiptSha256 === null) ||
      (operation.state === "acknowledged") !== (operation.receiptBody !== null) ||
      operation.sendCount < 0 ||
      !Number.isSafeInteger(operation.sendCount)
    ) return false;
    if (operation.state !== "acknowledged") sawPending = true;
    else if (sawPending) return false;
    try {
      validateHeatPromotionOperation(operation);
      if (operation.receiptBody !== null) {
        if (sha256(operation.receiptBody) !== operation.receiptSha256) {
          return false;
        }
        const receiptInput = JSON.parse(operation.receiptBody) as unknown;
        const receipt = operation.operationIndex === operations.length - 1
          ? validateHeatTerminalReceipt(receiptInput, operations)
          : validateHeatPromotionReceipt(receiptInput, { operation });
        if (canonicalJson(receipt) !== operation.receiptBody) return false;
        const { receiptDigest, ...receiptWithoutDigest } = receipt;
        if (
          await productionHeatReceiptHash(receiptWithoutDigest) !==
            receiptDigest
        ) return false;
        await validateHeatBatchProgressReceipt(receipt, operation, operations);
      }
    } catch {
      return false;
    }
  }
  return true;
}

export class HeatPromotionRunner {
  readonly #initialRetryMilliseconds: number;
  readonly #leaseMilliseconds: number;
  readonly #maximumOperationsPerCycle: number;
  readonly #maximumRetries: number;
  readonly #maximumRetryMilliseconds: number;
  readonly #random: { fraction(): number };
  #cycleInProgress = false;

  constructor(private readonly options: HeatPromotionRunnerOptions) {
    if (!workerIdPattern.test(options.workerId)) {
      throw new RangeError("Heat promotion runner identity is invalid.");
    }
    this.#leaseMilliseconds = boundedInteger(
      options.leaseMilliseconds, 30_000, 5_000, 300_000,
    );
    this.#maximumOperationsPerCycle = boundedInteger(
      options.maximumOperationsPerCycle,
      MAX_PRODUCTION_HEAT_BATCH_COUNT + 2,
      1,
      MAX_PRODUCTION_HEAT_BATCH_COUNT + 2,
    );
    this.#maximumRetries = boundedInteger(options.maximumRetries, 8, 1, 20);
    this.#initialRetryMilliseconds = boundedInteger(
      options.initialRetryMilliseconds, 500, 100, 60_000,
    );
    this.#maximumRetryMilliseconds = boundedInteger(
      options.maximumRetryMilliseconds,
      30_000,
      this.#initialRetryMilliseconds,
      300_000,
    );
    this.#random = options.random ?? { fraction: () => Math.random() };
  }

  async runCycle(
    requestedFrameEndedAt: Date,
    signal?: AbortSignal,
  ): Promise<HeatPromotionCycleResult> {
    if (this.#cycleInProgress) {
      throw new Error("Heat promotion cycle is already running.");
    }
    this.#cycleInProgress = true;
    try {
      return await this.executeCycle(requestedFrameEndedAt, signal);
    } finally {
      if (!cancelled(signal)) await this.reportHealth();
      this.#cycleInProgress = false;
    }
  }

  private async executeCycle(
    requestedFrameEndedAt: Date,
    signal: AbortSignal | undefined,
  ): Promise<HeatPromotionCycleResult> {
    const requestedSequence = heatFrameSequence(requestedFrameEndedAt);
    if (cancelled(signal)) return cycleResult("stopped", null);
    const checkpoint = await this.options.settlement.getCheckpoint();
    if (cancelled(signal)) return cycleResult("stopped", null);
    if (checkpoint.settledSequence <= 0n || checkpoint.settledAt === null) {
      return cycleResult("idle", null);
    }
    const now = this.options.clock.now();
    await this.options.ledger.coalesceSettledWatermark({
      laneKey: "heat",
      settledWatermark: requestedSequence,
      settledAt: requestedFrameEndedAt,
      delayedVendorCount: 0,
    });
    if (cancelled(signal)) return cycleResult("stopped", null);
    try {
      await this.options.bootstrap.ensureVerified({ verifiedAt: now, signal });
    } catch (error) {
      if (cancelled(signal)) return cycleResult("stopped", null);
      throw error;
    }
    if (cancelled(signal)) return cycleResult("stopped", null);
    const claim = await this.options.ledger.claimAttempt({
      laneKey: "heat",
      claimOwner: this.options.workerId,
      now,
      claimExpiresAt: this.leaseExpiresAt(now),
    });
    if (claim === null) return cycleResult("idle", null);
    if (cancelled(signal)) return cycleResult("stopped", claim);
    if (!(await this.heartbeat(claim))) return cycleResult("lease_lost", claim);
    let operations = await this.options.ledger.listAttemptOperations({
      attemptId: claim.attemptId,
    });
    let contentIdentity = claim.contentIdentity;
    let publicationIdentity = claim.publicationIdentity;
    let manifestSourceProof = claim.manifestSourceProof;
    if (cancelled(signal)) return cycleResult("stopped", claim);
    if (claim.contentIdentity === null) {
      let catalog;
      try {
        catalog = await this.options.manifests.loadActiveCatalogManifest();
      } catch {
        if (cancelled(signal)) return cycleResult("stopped", claim);
        return await this.retry(
          claim, "HEAT_SOURCE_UNAVAILABLE", null, false,
        );
      }
      if (cancelled(signal)) return cycleResult("stopped", claim);
      if (catalog === null) {
        return await this.failTerminal(claim, "HEAT_CATALOG_UNAVAILABLE");
      }
      let baseline;
      try {
        baseline = await this.options.manifests.loadActiveHeatFrame();
      } catch {
        if (cancelled(signal)) return cycleResult("stopped", claim);
        return await this.retry(
          claim, "HEAT_SOURCE_UNAVAILABLE", null, false,
        );
      }
      if (cancelled(signal)) return cycleResult("stopped", claim);
      if (
        claim.expectedPredecessorIdentity !==
          (baseline?.publicHeatFrameId ?? null) ||
        (baseline !== null && checkpoint.settledSequence < baseline.sourceWatermark)
      ) {
        return await this.failTerminal(
          claim, "HEAT_BASELINE_CONFLICT", "reconciliation",
        );
      }
      let prepared;
      try {
        prepared = await prepareHeatPromotion({
          targetFrameSequence: claim.targetWatermark,
          frameEndedAt: frameEndedAt(claim.targetWatermark),
          calculatedAt: this.options.clock.now(),
          sourceWatermark: checkpoint.settledSequence,
          catalog,
          baseline,
          observations: this.options.observations,
          canReuseSignalSet: (candidate) =>
            this.options.manifests.hasReusableHeatSignalSet(candidate),
        });
      } catch (error) {
        if (cancelled(signal)) return cycleResult("stopped", claim);
        if (error instanceof HeatPromotionPreparationError) {
          return await this.failTerminal(claim, error.code);
        }
        return await this.retry(
          claim, "HEAT_SOURCE_UNAVAILABLE", null, false,
        );
      }
      operations = await this.options.ledger.persistAssembledOperations({
        attemptId: claim.attemptId,
        claimToken: claim.claimToken,
        now: this.options.clock.now(),
        contentIdentity: prepared.contentIdentity,
        publicationIdentity: prepared.publicHeatFrameId,
        preparedClassification: prepared.classification,
        manifestSourceProof: catalog,
        operations: prepared.operations,
      }) ?? [];
      if (operations.length === 0) return cycleResult("lease_lost", claim);
      contentIdentity = prepared.contentIdentity;
      publicationIdentity = prepared.publicHeatFrameId;
      manifestSourceProof = catalog;
    }
    // A freshly persisted claim object does not yet carry its identities. Load
    // them from immutable bytes only for validation and terminal accounting.
    const executableClaim: HeatPromotionClaim = {
      ...claim,
      publicationIdentity: publicationIdentity ??
        (operations[0] ? operationPublicationId(operations[0]) : null),
      contentIdentity,
      manifestSourceProof,
    };
    if (!(await validPersistedOperations(executableClaim, operations))) {
      return await this.failTerminal(
        claim, "HEAT_LEDGER_INVALID", "reconciliation",
      );
    }
    return await this.executeOperations(
      executableClaim,
      operations,
      signal,
    );
  }

  private async executeOperations(
    claim: HeatPromotionClaim,
    operations: readonly HeatPromotionOperation[],
    signal: AbortSignal | undefined,
  ): Promise<HeatPromotionCycleResult> {
    let acknowledged = 0;
    const reused = reusedSignalSet(operations);
    while (acknowledged < this.#maximumOperationsPerCycle) {
      if (cancelled(signal)) {
        return cycleResult("stopped", claim, acknowledged, reused);
      }
      const current = await this.options.ledger.firstUnacknowledgedOperation({
        attemptId: claim.attemptId,
        claimToken: claim.claimToken,
        now: this.options.clock.now(),
      });
      if (current === null) {
        const persisted = await this.options.ledger.listAttemptOperations({
          attemptId: claim.attemptId,
        });
        if (!(await validPersistedOperations(claim, persisted))) {
          return await this.failTerminal(
            claim, "HEAT_LEDGER_INVALID", "reconciliation",
          );
        }
        const terminal = persisted.at(-1)!;
        if (terminal.receiptBody === null) {
          return await this.failTerminal(
            claim, "HEAT_LEDGER_INVALID", "reconciliation",
          );
        }
        const completed = await this.options.ledger.completeAttempt({
          attemptId: claim.attemptId,
          claimToken: claim.claimToken,
          // refreshFrame activates a new frame identity even when signal cores
          // are unchanged, so it is a publication in the generic ledger.
          terminalState: "published",
          completedAt: this.options.clock.now(),
          receiptBody: terminal.receiptBody,
          failureClass: null,
          failureCode: null,
        });
        return completed
          ? cycleResult("published", claim, acknowledged, reused)
          : cycleResult("lease_lost", claim, acknowledged, reused);
      }
      if (!(await this.heartbeat(claim))) {
        return cycleResult("lease_lost", claim, acknowledged, reused);
      }
      try {
        let receipt = current.state === "sent"
          ? await this.options.transport.status({
              operationId: current.operationId,
              publicationId: operationPublicationId(current),
              expectedRequestDigest: current.requestSha256,
              expectedKind: current.operationKind,
            }, signal)
          : null;
        if (cancelled(signal)) {
          return cycleResult("stopped", claim, acknowledged, reused);
        }
        if (receipt !== null) {
          receipt = current.operationKind === "finalize" ||
              current.operationKind === "refreshFrame"
            ? validateHeatTerminalReceipt(receipt, operations)
            : validateHeatPromotionReceipt(receipt, { operation: current });
          await validateHeatBatchProgressReceipt(receipt, current, operations);
        } else {
          const marked = await this.options.ledger.markOperationSent({
            attemptId: claim.attemptId,
            operationId: current.operationId,
            claimToken: claim.claimToken,
            sentAt: this.options.clock.now(),
          });
          if (!marked) {
            return cycleResult("lease_lost", claim, acknowledged, reused);
          }
          if (cancelled(signal)) {
            return cycleResult("stopped", claim, acknowledged, reused);
          }
          const response = validateHeatPromotionReceipt(
            await this.options.transport.send(current, signal),
            { operation: current },
          );
          await validateHeatBatchProgressReceipt(
            response, current, operations,
          );
          receipt = current.operationKind === "finalize" ||
              current.operationKind === "refreshFrame"
            ? validateHeatTerminalReceipt(response, operations)
            : response;
        }
        if (cancelled(signal)) {
          return cycleResult("stopped", claim, acknowledged, reused);
        }
        const accepted = await this.options.ledger.acknowledgeOperation({
          attemptId: claim.attemptId,
          operationId: current.operationId,
          claimToken: claim.claimToken,
          acknowledgedAt: this.options.clock.now(),
          receiptBody: canonicalJson(receipt),
        });
        if (!accepted) {
          return cycleResult("lease_lost", claim, acknowledged, reused);
        }
        acknowledged += 1;
      } catch (error) {
        if (cancelled(signal)) {
          return cycleResult("stopped", claim, acknowledged, reused);
        }
        if (
          error instanceof CatalogPublicationClientError &&
          error.disposition === "terminal" &&
          !error.ambiguous
        ) {
          return await this.failTerminal(
            claim,
            error.code,
            reconciliationTerminalCodes.has(error.code)
              ? "reconciliation" : "deterministic",
          );
        }
        const failureCode = error instanceof CatalogPublicationClientError
          ? error.code : error instanceof HeatPromotionPreparationError
            ? "HEAT_RESPONSE_INVALID" : "HEAT_NETWORK_ERROR";
        const retryAfter = error instanceof CatalogPublicationClientError
          ? error.retryAfterMilliseconds : null;
        const failureClass = failureCode.includes("RESPONSE")
          ? "reconciliation" as const : "technical" as const;
        return await this.retry(
          claim, failureCode, retryAfter, reused, failureClass,
        );
      }
    }
    const now = this.options.clock.now();
    const continued = await this.options.ledger.scheduleRetry({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      failedAt: now,
      retryAt: new Date(now.getTime() + 1),
      failureClass: "technical",
      failureCode: "HEAT_CYCLE_BOUNDED",
    });
    return continued
      ? cycleResult("progressed", claim, acknowledged, reused)
      : cycleResult("lease_lost", claim, acknowledged, reused);
  }

  private async retry(
    claim: HeatPromotionClaim,
    failureCode: string,
    retryAfterMilliseconds: number | null,
    reused: boolean,
    failureClass: "technical" | "reconciliation" = "technical",
  ): Promise<HeatPromotionCycleResult> {
    if (claim.retryCount + 1 > this.#maximumRetries) {
      return await this.failTerminal(
        claim,
        failureClass === "reconciliation"
          ? "HEAT_RECONCILIATION_EXHAUSTED"
          : "HEAT_RETRY_EXHAUSTED",
        failureClass,
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
      failedAt: now,
      retryAt: new Date(now.getTime() + delay),
      failureClass,
      failureCode,
    });
    return scheduled
      ? cycleResult("retry_scheduled", claim, 0, reused, failureCode)
      : cycleResult("lease_lost", claim, 0, reused, failureCode);
  }

  private async failTerminal(
    claim: HeatPromotionClaim,
    failureCode: string,
    failureClass: "technical" | "deterministic" | "reconciliation" =
      "deterministic",
  ): Promise<HeatPromotionCycleResult> {
    const now = this.options.clock.now();
    const completed = await this.options.ledger.completeAttempt({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      terminalState: "failed",
      completedAt: now,
      receiptBody: null,
      failureClass,
      failureCode,
    });
    if (!completed) return cycleResult("lease_lost", claim, 0, false, failureCode);
    try {
      await this.options.alerts.notify({
        attemptId: claim.attemptId,
        frameSequence: claim.targetWatermark,
        failureCode,
        occurredAt: now,
      });
    } catch {
      // The terminal ledger record remains authoritative if alerting fails.
    }
    return cycleResult("failed", claim, 0, false, failureCode);
  }

  private heartbeat(claim: HeatPromotionClaim): Promise<boolean> {
    const now = this.options.clock.now();
    return this.options.ledger.heartbeat({
      attemptId: claim.attemptId,
      claimToken: claim.claimToken,
      heartbeatAt: now,
      claimExpiresAt: this.leaseExpiresAt(now),
    });
  }

  private leaseExpiresAt(now: Date): Date {
    return new Date(now.getTime() + this.#leaseMilliseconds);
  }

  private async reportHealth(): Promise<void> {
    if (this.options.health === undefined) return;
    try {
      const health = await this.options.ledger.loadHealthSnapshot({
        laneKey: "heat",
        now: this.options.clock.now(),
      });
      if (health !== null) await this.options.health.report(health);
    } catch {
      // Health reporting never mutates a promotion attempt.
    }
  }
}
