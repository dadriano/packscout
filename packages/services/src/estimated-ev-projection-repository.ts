import type { ProviderCanonicalProjectionCommand } from "./provider-import-types.ts";
import type { EstimatedEvRecomputationOrigin } from "./estimated-ev-projection-contracts.ts";

export interface EstimatedEvCanonicalIdentity {
  readonly platformKey: string;
  readonly recordKind: "catalog_asset" | "estimated_ev" | "ev_input" | "market_event" | "pack" | "platform" | "pull";
  readonly externalId: string;
}

export interface EstimatedEvCanonicalProjectionSnapshot {
  readonly identity: EstimatedEvCanonicalIdentity;
  readonly entityId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly sourceRecordId: string | null;
  readonly originSemanticObservationId: string | null;
  readonly originEvRecomputationRequestId: string | null;
  readonly content: Record<string, unknown>;
  readonly provenance: Record<string, unknown>;
  readonly sourceUpdatedAt: Date;
  readonly sourceCollectedAt: Date;
  readonly acceptedAt: Date;
}

interface CurrentCanonicalProjectionSnapshot {
  readonly identity: EstimatedEvCanonicalIdentity;
  readonly entityId: string;
  readonly revisionId: string;
  readonly revisionNumber: number;
  readonly content: Record<string, unknown>;
  readonly provenance: Record<string, unknown>;
  readonly sourceUpdatedAt: Date;
  readonly sourceCollectedAt: Date;
  readonly acceptedAt: Date;
}

interface CanonicalProjectionRevisionSnapshot
  extends CurrentCanonicalProjectionSnapshot {
  readonly sourceRecordId: string | null;
  readonly originSemanticObservationId: string | null;
  readonly originEvRecomputationRequestId: string | null;
}

export interface EstimatedEvCanonicalHistoryPort {
  getCurrentProjection(
    organizationId: string,
    identity: EstimatedEvCanonicalIdentity,
  ): Promise<CurrentCanonicalProjectionSnapshot | null>;
  listCanonicalRevisions(
    organizationId: string,
    identity: EstimatedEvCanonicalIdentity,
  ): Promise<readonly CanonicalProjectionRevisionSnapshot[]>;
  projectDerivedSourceRecord(input: {
    organizationId: string;
    providerId: string;
    origin: EstimatedEvRecomputationOrigin;
    sourceRecordId: string | null;
    projections: readonly ProviderCanonicalProjectionCommand[];
    acceptedAt: Date;
    recomputation?: Readonly<{
      requestId: string;
      claimToken: string;
      originatingPublicChangeSequence: bigint;
      resultStatus: "estimated" | "unavailable";
      outcomeReasonCode?: string;
    }>;
  }): Promise<{
    canonicalRevisionCount: number;
    derivationAcknowledged?: boolean;
  }>;
}

export interface EstimatedEvCalculationInputSet {
  readonly pack: EstimatedEvCanonicalProjectionSnapshot | null;
  readonly evInput: EstimatedEvCanonicalProjectionSnapshot | null;
  readonly calculation: EstimatedEvCanonicalProjectionSnapshot | null;
}

export interface PersistEstimatedEvProjectionInput {
  readonly organizationId: string;
  readonly providerId: string;
  readonly origin: EstimatedEvRecomputationOrigin;
  readonly sourceRecordId: string | null;
  readonly projection: ProviderCanonicalProjectionCommand;
  readonly acceptedAt: Date;
  readonly recomputation?: Readonly<{
    requestId: string;
    claimToken: string;
    originatingPublicChangeSequence: bigint;
    resultStatus: "estimated" | "unavailable";
    outcomeReasonCode?: string;
  }>;
}

export interface EstimatedEvProjectionRepository {
  loadCalculationInputs(input: {
    organizationId: string;
    platformKey: string;
    packExternalId: string;
    evInputExternalId: string;
  }): Promise<EstimatedEvCalculationInputSet>;
  getCurrentExplanationInput(input: {
    organizationId: string;
    platformKey: string;
    packExternalId: string;
  }): Promise<Readonly<{
    pack: EstimatedEvCanonicalProjectionSnapshot | null;
    calculation: EstimatedEvCanonicalProjectionSnapshot | null;
  }>>;
  persistCalculation(
    input: PersistEstimatedEvProjectionInput,
  ): Promise<Readonly<{
    created: boolean;
    calculation: EstimatedEvCanonicalProjectionSnapshot;
    derivationAcknowledged?: boolean;
  }>>;
}

async function currentRevision(
  canonical: EstimatedEvCanonicalHistoryPort,
  organizationId: string,
  identity: EstimatedEvCanonicalIdentity,
): Promise<EstimatedEvCanonicalProjectionSnapshot | null> {
  const current = await canonical.getCurrentProjection(organizationId, identity);
  if (!current) return null;
  const revisions = await canonical.listCanonicalRevisions(organizationId, identity);
  const revision = revisions.find(({ revisionId }) => revisionId === current.revisionId);
  if (!revision) {
    throw new Error("Current canonical projection has no immutable revision evidence.");
  }
  return {
    ...current,
    sourceRecordId: revision.sourceRecordId,
    originSemanticObservationId: revision.originSemanticObservationId,
    originEvRecomputationRequestId: revision.originEvRecomputationRequestId,
  };
}

export class CanonicalEstimatedEvProjectionRepository
  implements EstimatedEvProjectionRepository
{
  constructor(private readonly canonical: EstimatedEvCanonicalHistoryPort) {}

  async loadCalculationInputs(input: {
    organizationId: string;
    platformKey: string;
    packExternalId: string;
    evInputExternalId: string;
  }): Promise<EstimatedEvCalculationInputSet> {
    const identity = (recordKind: "estimated_ev" | "ev_input" | "pack", externalId: string) => ({
      platformKey: input.platformKey,
      recordKind,
      externalId,
    }) as const;
    const [pack, evInput, calculation] = await Promise.all([
      currentRevision(
        this.canonical,
        input.organizationId,
        identity("pack", input.packExternalId),
      ),
      currentRevision(
        this.canonical,
        input.organizationId,
        identity("ev_input", input.evInputExternalId),
      ),
      currentRevision(
        this.canonical,
        input.organizationId,
        identity("estimated_ev", input.packExternalId),
      ),
    ]);
    return { pack, evInput, calculation };
  }

  async getCurrentExplanationInput(input: {
    organizationId: string;
    platformKey: string;
    packExternalId: string;
  }) {
    const [pack, calculation] = await Promise.all([
      currentRevision(this.canonical, input.organizationId, {
        platformKey: input.platformKey,
        recordKind: "pack",
        externalId: input.packExternalId,
      }),
      currentRevision(this.canonical, input.organizationId, {
        platformKey: input.platformKey,
        recordKind: "estimated_ev",
        externalId: input.packExternalId,
      }),
    ]);
    const packContent = pack?.content as Readonly<Record<string, unknown>> | undefined;
    const calculationIsEligible = pack?.originSemanticObservationId === null
      ? pack?.sourceRecordId !== null
      : packContent?.evInputStatus === "ready";
    return {
      pack,
      calculation: calculationIsEligible ? calculation : null,
    };
  }

  async persistCalculation(input: PersistEstimatedEvProjectionInput) {
    const result = await this.canonical.projectDerivedSourceRecord({
      organizationId: input.organizationId,
      providerId: input.providerId,
      origin: input.origin,
      sourceRecordId: input.sourceRecordId,
      projections: [input.projection],
      acceptedAt: input.acceptedAt,
      recomputation: input.recomputation,
    });
    const calculation = await currentRevision(this.canonical, input.organizationId, {
      platformKey: input.projection.platformKey,
      recordKind: "estimated_ev",
      externalId: input.projection.externalId,
    });
    if (!calculation) {
      throw new Error("Estimated EV projection was not persisted.");
    }
    return {
      created: result.canonicalRevisionCount > 0,
      calculation,
      derivationAcknowledged: result.derivationAcknowledged,
    };
  }
}
