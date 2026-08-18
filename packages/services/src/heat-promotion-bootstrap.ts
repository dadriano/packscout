import { canonicalJson } from "@packscout/contracts";
import type {
  HeatPromotionBootstrapPort,
  HeatPromotionLedgerPort,
  HeatPromotionManifestProofPort,
  HeatPublicationActiveStateTransport,
} from "./heat-promotion-types.ts";

export class HeatPromotionBootstrapError extends Error {
  readonly code = "HEAT_BOOTSTRAP_UNPROVEN" as const;

  constructor() {
    super("Heat promotion bootstrap proof is incomplete.");
    this.name = "HeatPromotionBootstrapError";
  }
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Proves the remote Heat pointer from an exact local terminal receipt. */
export class HeatPromotionBootstrapCoordinator
  implements HeatPromotionBootstrapPort
{
  constructor(
    private readonly ledger: Pick<
      HeatPromotionLedgerPort,
      "loadBootstrapState" | "verifyBootstrap"
    >,
    private readonly manifests: Pick<
      HeatPromotionManifestProofPort,
      "loadActiveHeatFrame"
    >,
    private readonly remote: HeatPublicationActiveStateTransport,
  ) {}

  async ensureVerified(input: {
    verifiedAt: Date;
    signal?: AbortSignal;
  }): Promise<void> {
    if (await this.ledger.loadBootstrapState("heat") !== "unverified") return;
    const observed = await this.remote.activeState(input.signal);
    if (aborted(input.signal)) return;
    const local = await this.manifests.loadActiveHeatFrame();
    if (aborted(input.signal)) return;
    if (
      (observed.activePublicHeatFrameId === null) !== (local === null) ||
      (local !== null && (
        observed.activePublicHeatFrameId !== local.publicHeatFrameId ||
        observed.manifestAlignment === null ||
        canonicalJson(observed.manifestAlignment) !==
          canonicalJson(local.manifestAlignment) ||
        observed.sourceWatermark !== local.sourceWatermark ||
        observed.frameSequence !== local.frameSequence ||
        observed.terminalReceiptSha256 !== local.terminalReceiptSha256
      ))
    ) throw new HeatPromotionBootstrapError();
    await this.ledger.verifyBootstrap({
      laneKey: "heat",
      observedPublicationIdentity: observed.activePublicHeatFrameId,
      observedWatermark: BigInt(observed.frameSequence),
      observedReceiptSha256: observed.terminalReceiptSha256,
      verifiedAt: input.verifiedAt,
    });
  }
}
