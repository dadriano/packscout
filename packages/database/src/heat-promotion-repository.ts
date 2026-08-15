import {
  PRODUCTION_REPACK_HEAT_PATHS,
  type ProductionRepackHeatPath,
} from "@packscout/contracts";
import type { PackscoutPrismaClient } from "./database.ts";
import {
  PrismaCatalogPromotionRepository,
  PromotionLedgerError,
  type PromotionAttemptClaim,
  type PromotionBootstrapState,
  type PromotionFailureClass,
  type PromotionHealthSnapshot,
  type PromotionOperationInput,
  type PromotionOperationRecord,
  type PromotionTerminalState,
} from "./catalog-promotion-repository.ts";

export type HeatPromotionOperationKind =
  | "start" | "applyBatch" | "finalize" | "refreshFrame";

export interface HeatPromotionOperationRecord
  extends Omit<PromotionOperationRecord, "operationKind" | "requestPath"> {
  readonly operationKind: HeatPromotionOperationKind;
  readonly requestPath: ProductionRepackHeatPath;
}

const pathByKind = Object.freeze({
  start: PRODUCTION_REPACK_HEAT_PATHS.start,
  applyBatch: PRODUCTION_REPACK_HEAT_PATHS.applyBatch,
  finalize: PRODUCTION_REPACK_HEAT_PATHS.finalize,
  refreshFrame: PRODUCTION_REPACK_HEAT_PATHS.refreshFrame,
});

function heatOperation(
  operation: PromotionOperationRecord,
): HeatPromotionOperationRecord {
  if (!(operation.operationKind in pathByKind)) {
    throw new PromotionLedgerError("PROMOTION_OPERATION_CONFLICT");
  }
  const operationKind = operation.operationKind as HeatPromotionOperationKind;
  if (operation.requestPath !== pathByKind[operationKind]) {
    throw new PromotionLedgerError("PROMOTION_OPERATION_CONFLICT");
  }
  return {
    ...operation,
    operationKind,
    requestPath: operation.requestPath as ProductionRepackHeatPath,
  };
}

/** Heat-specific type adapter over the shared promotion ledger implementation. */
export class PrismaHeatPromotionRepository {
  readonly #shared: PrismaCatalogPromotionRepository;

  constructor(
    database: PackscoutPrismaClient,
    binding: Readonly<{ organizationId: string; deploymentKey: string }>,
  ) {
    this.#shared = new PrismaCatalogPromotionRepository(database, binding);
  }

  loadBootstrapState(laneKey: "heat"): Promise<PromotionBootstrapState> {
    return this.#shared.loadBootstrapState(laneKey);
  }

  verifyBootstrap(input: {
    laneKey: "heat";
    observedPublicationIdentity: string | null;
    observedWatermark: bigint;
    observedReceiptSha256: string | null;
    verifiedAt: Date;
  }): Promise<void> {
    return this.#shared.verifyBootstrap(input);
  }

  coalesceSettledWatermark(input: {
    laneKey: "heat";
    settledWatermark: bigint;
    settledAt: Date;
    delayedVendorCount: 0;
  }): Promise<Readonly<{ settledWatermark: bigint; requestedWatermark: bigint }>> {
    return this.#shared.coalesceSettledWatermark(input);
  }

  claimAttempt(input: {
    laneKey: "heat";
    claimOwner: string;
    now: Date;
    claimExpiresAt: Date;
  }): Promise<PromotionAttemptClaim | null> {
    return this.#shared.claimAttempt(input);
  }

  heartbeat(input: {
    attemptId: string;
    claimToken: string;
    heartbeatAt: Date;
    claimExpiresAt: Date;
  }): Promise<boolean> {
    return this.#shared.heartbeat(input);
  }

  async persistAssembledOperations(input: {
    attemptId: string;
    claimToken: string;
    now: Date;
    contentIdentity: string;
    publicationIdentity: string;
    preparedClassification: "publish" | "refresh_unchanged";
    operations: readonly PromotionOperationInput[];
  }): Promise<readonly HeatPromotionOperationRecord[] | null> {
    for (const operation of input.operations) {
      if (
        !(operation.operationKind in pathByKind) ||
        operation.requestPath !== pathByKind[
          operation.operationKind as HeatPromotionOperationKind
        ]
      ) throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
    }
    const persisted = await this.#shared.persistAssembledOperations(input);
    return persisted?.map(heatOperation) ?? null;
  }

  async listAttemptOperations(input: {
    attemptId: string;
  }): Promise<readonly HeatPromotionOperationRecord[]> {
    return (await this.#shared.listAttemptOperations(input)).map(heatOperation);
  }

  async firstUnacknowledgedOperation(input: {
    attemptId: string;
    claimToken: string;
    now: Date;
  }): Promise<HeatPromotionOperationRecord | null> {
    const operation = await this.#shared.firstUnacknowledgedOperation(input);
    return operation === null ? null : heatOperation(operation);
  }

  markOperationSent(input: {
    attemptId: string;
    operationId: string;
    claimToken: string;
    sentAt: Date;
  }): Promise<boolean> {
    return this.#shared.markOperationSent(input);
  }

  acknowledgeOperation(input: {
    attemptId: string;
    operationId: string;
    claimToken: string;
    acknowledgedAt: Date;
    receiptBody: string;
  }): Promise<boolean> {
    return this.#shared.acknowledgeOperation(input);
  }

  scheduleRetry(input: {
    attemptId: string;
    claimToken: string;
    failedAt: Date;
    retryAt: Date;
    failureClass: "technical" | "reconciliation";
    failureCode: string;
  }): Promise<boolean> {
    return this.#shared.scheduleRetry(input);
  }

  completeAttempt(input: {
    attemptId: string;
    claimToken: string;
    terminalState: PromotionTerminalState;
    completedAt: Date;
    receiptBody: string | null;
    failureClass: PromotionFailureClass | null;
    failureCode: string | null;
  }): Promise<boolean> {
    return this.#shared.completeAttempt(input);
  }

  loadHealthSnapshot(input: {
    laneKey: "heat";
    now: Date;
  }): Promise<PromotionHealthSnapshot | null> {
    return this.#shared.loadHealthSnapshot(input);
  }
}
