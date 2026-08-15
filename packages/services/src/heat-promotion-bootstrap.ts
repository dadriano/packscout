import type {
  HeatPromotionBootstrapPort,
  HeatPromotionLedgerPort,
  HeatPublicationActiveStateTransport,
} from "./heat-promotion-types.ts";

/** Proves the remote Heat pointer from an exact local terminal receipt. */
export class HeatPromotionBootstrapCoordinator
  implements HeatPromotionBootstrapPort
{
  constructor(
    private readonly ledger: Pick<
      HeatPromotionLedgerPort,
      "loadBootstrapState" | "verifyBootstrap"
    >,
    private readonly remote: HeatPublicationActiveStateTransport,
  ) {}

  async ensureVerified(input: {
    verifiedAt: Date;
    signal?: AbortSignal;
  }): Promise<void> {
    if (await this.ledger.loadBootstrapState("heat") !== "unverified") return;
    const observed = await this.remote.activeState(input.signal);
    if (input.signal?.aborted === true) return;
    await this.ledger.verifyBootstrap({
      laneKey: "heat",
      observedPublicationIdentity: observed.activePublicHeatFrameId,
      observedWatermark: BigInt(observed.frameSequence),
      observedReceiptSha256: observed.terminalReceiptSha256,
      verifiedAt: input.verifiedAt,
    });
  }
}
