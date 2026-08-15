import type {
  CatalogPromotionBootstrapPort,
  CatalogPublicationActiveStateTransport,
  CatalogPromotionScope,
} from "./catalog-promotion-types.ts";

export type CatalogPromotionBootstrapState =
  | "unverified"
  | "verified_empty"
  | "verified_local";

export interface CatalogPromotionBootstrapLedgerPort {
  loadBootstrapState(laneKey: string): Promise<CatalogPromotionBootstrapState>;
  verifyBootstrap(input: Readonly<{
    laneKey: string;
    observedPublicationIdentity: string | null;
    observedWatermark: bigint;
    observedReceiptSha256: string | null;
    verifiedAt: Date;
  }>): Promise<void>;
}

/** Proves the deployment pointer before the first promotion claim. */
export class CatalogPromotionBootstrapCoordinator
  implements CatalogPromotionBootstrapPort
{
  constructor(
    private readonly ledger: CatalogPromotionBootstrapLedgerPort,
    private readonly remote: CatalogPublicationActiveStateTransport,
  ) {}

  async ensureVerified(
    input: CatalogPromotionScope & {
      verifiedAt: Date;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    if (await this.ledger.loadBootstrapState(input.lane) !== "unverified") {
      return;
    }
    const observed = await this.remote.activeState(input.signal);
    await this.ledger.verifyBootstrap({
      laneKey: input.lane,
      observedPublicationIdentity: observed.activePublicReleaseId,
      observedWatermark: BigInt(observed.observationSequence),
      observedReceiptSha256: observed.terminalReceiptSha256,
      verifiedAt: input.verifiedAt,
    });
  }
}
