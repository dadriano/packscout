import {
  PRODUCTION_REPACK_HEAT_PATHS,
  canonicalJson,
  productionHeatFinalizeRequestSchema,
  productionHeatRefreshFrameRequestSchema,
  productionHeatStartRequestSchema,
  type ProductionRepackHeatPath,
} from "@packscout/contracts";
import {
  parseHeatManifestSourceProof,
  serializeHeatManifestSourceProof,
  type ActiveCatalogHeatManifest,
} from "./active-catalog-heat-manifest.ts";
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
import {
  PrismaHeatPromotionManifestRepository,
} from "./heat-promotion-manifest-repository.ts";

export type HeatPromotionOperationKind =
  | "start" | "applyBatch" | "finalize" | "refreshFrame";

export interface HeatPromotionOperationRecord
  extends Omit<PromotionOperationRecord, "operationKind" | "requestPath"> {
  readonly operationKind: HeatPromotionOperationKind;
  readonly requestPath: ProductionRepackHeatPath;
}

export interface HeatPromotionAttemptClaim extends Omit<
  PromotionAttemptClaim,
  "manifestSourceProofBody" | "manifestSourceProofSha256"
> {
  readonly manifestSourceProof: ActiveCatalogHeatManifest | null;
}

export interface HeatPromotionHealthSnapshot extends PromotionHealthSnapshot {
  readonly manifestAlignment: ActiveCatalogHeatManifest["manifestAlignment"] | null;
  readonly alignmentMatchesActiveManifest: boolean;
  readonly frameCalculatedAt: Date | null;
  readonly frameExpiresAt: Date | null;
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
  readonly #manifestProofs: PrismaHeatPromotionManifestRepository;

  constructor(
    database: PackscoutPrismaClient,
    binding: Readonly<{ organizationId: string; deploymentKey: string }>,
  ) {
    this.#shared = new PrismaCatalogPromotionRepository(database, binding);
    this.#manifestProofs = new PrismaHeatPromotionManifestRepository(
      database,
      binding,
    );
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

  async claimAttempt(input: {
    laneKey: "heat";
    claimOwner: string;
    now: Date;
    claimExpiresAt: Date;
  }): Promise<HeatPromotionAttemptClaim | null> {
    const claim = await this.#shared.claimAttempt(input);
    if (claim === null) return null;
    if ((claim.manifestSourceProofBody === null) !==
      (claim.manifestSourceProofSha256 === null)) {
      throw new PromotionLedgerError("PROMOTION_ATTEMPT_CONFLICT");
    }
    let manifestSourceProof: ActiveCatalogHeatManifest | null = null;
    if (claim.manifestSourceProofBody !== null &&
      claim.manifestSourceProofSha256 !== null) {
      try {
        manifestSourceProof = await parseHeatManifestSourceProof(
          claim.manifestSourceProofBody,
          claim.manifestSourceProofSha256,
        );
      } catch {
        throw new PromotionLedgerError("PROMOTION_ATTEMPT_CONFLICT");
      }
    }
    const {
      manifestSourceProofBody: _manifestSourceProofBody,
      manifestSourceProofSha256: _manifestSourceProofSha256,
      ...publicClaim
    } = claim;
    void _manifestSourceProofBody;
    void _manifestSourceProofSha256;
    return Object.freeze({ ...publicClaim, manifestSourceProof });
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
    manifestSourceProof: ActiveCatalogHeatManifest;
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
    const expectedAlignment = canonicalJson(
      input.manifestSourceProof.manifestAlignment,
    );
    try {
      if (input.preparedClassification === "publish") {
        if (
          input.operations.length < 2 ||
          input.operations[0]?.operationKind !== "start" ||
          input.operations.at(-1)?.operationKind !== "finalize" ||
          input.operations.slice(1, -1).some(({ operationKind }) =>
            operationKind !== "applyBatch")
        ) throw new Error("invalid Heat publish graph");
        const start = productionHeatStartRequestSchema.parse(
          JSON.parse(input.operations[0].canonicalRequestBody) as unknown,
        );
        const finalize = productionHeatFinalizeRequestSchema.parse(
          JSON.parse(input.operations.at(-1)!.canonicalRequestBody) as unknown,
        );
        if (
          canonicalJson(start) !== input.operations[0].canonicalRequestBody ||
          canonicalJson(finalize) !==
            input.operations.at(-1)!.canonicalRequestBody ||
          canonicalJson(start.frame.manifestAlignment) !== expectedAlignment ||
          canonicalJson(finalize.expectedManifestAlignment) !== expectedAlignment
        ) throw new Error("mixed Heat manifest alignment");
      } else {
        if (
          input.operations.length !== 1 ||
          input.operations[0]?.operationKind !== "refreshFrame"
        ) throw new Error("invalid Heat refresh graph");
        const refresh = productionHeatRefreshFrameRequestSchema.parse(
          JSON.parse(input.operations[0].canonicalRequestBody) as unknown,
        );
        if (
          canonicalJson(refresh) !== input.operations[0].canonicalRequestBody ||
          canonicalJson(refresh.frame.manifestAlignment) !== expectedAlignment
        ) throw new Error("mixed Heat manifest alignment");
      }
    } catch {
      throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
    }
    let manifestSourceProof;
    try {
      manifestSourceProof = await serializeHeatManifestSourceProof(
        input.manifestSourceProof,
      );
    } catch {
      throw new PromotionLedgerError("PROMOTION_INPUT_INVALID");
    }
    const persisted = await this.#shared.persistAssembledOperations({
      ...input,
      manifestSourceProof,
    });
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

  async loadHealthSnapshot(input: {
    laneKey: "heat";
    now: Date;
  }): Promise<HeatPromotionHealthSnapshot | null> {
    const health = await this.#shared.loadHealthSnapshot(input);
    if (health === null) return null;
    if (health.confirmedWatermark === 0n) {
      return {
        ...health,
        manifestAlignment: null,
        alignmentMatchesActiveManifest: true,
        frameCalculatedAt: null,
        frameExpiresAt: null,
      };
    }
    const [frame, activeManifest] = await Promise.all([
      this.#manifestProofs.loadActiveHeatFrame(),
      this.#manifestProofs.loadActiveCatalogManifest(),
    ]);
    if (frame === null) {
      throw new PromotionLedgerError("PROMOTION_ATTEMPT_CONFLICT");
    }
    return {
      ...health,
      manifestAlignment: frame.manifestAlignment,
      alignmentMatchesActiveManifest: activeManifest !== null &&
        canonicalJson(frame.manifestAlignment) ===
          canonicalJson(activeManifest.manifestAlignment),
      frameCalculatedAt: frame.calculatedAt,
      frameExpiresAt: frame.expiresAt,
    };
  }
}
