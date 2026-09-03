import { createHash } from "node:crypto";
import {
  canonicalJson,
  type ActiveCatalogManifestStateV1,
  type ProviderCatalogReleasePublishPlanV1,
  type ProviderReleaseCompletedHeadV1,
  type ProviderReleaseExpectedCompletedHeadV1,
} from "@packscout/contracts";
import {
  prepareProviderPromotion,
  providerPromotionStatusRequest,
  validateProviderPromotionReceipt,
  type SignedConvexProviderReleasePublicationClient,
} from "@packscout/services";
import {
  DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
  DistributedClutchpacksPublicationError,
  LOCAL_PUBLIC_CONFIGURATION_KEY,
} from "./distributed-clutchpacks-publication-plan.mts";

export interface LocalClutchpacksProviderTerminal {
  readonly terminalOperationKind: "finalize" | "confirmReuse";
  readonly terminalOperationId: string;
  readonly terminalReceiptSha256: string;
}

function refuse(): never {
  throw new DistributedClutchpacksPublicationError("LOCAL_CONVEX_PROVIDER_TERMINAL_NOT_OBSERVED");
}

/** Recover the actual terminal receipt without reissuing a completed write. */
export async function resolveLocalClutchpacksProviderTerminal(input: {
  readonly head: ProviderReleaseCompletedHeadV1;
  readonly plan: ProviderCatalogReleasePublishPlanV1;
  readonly manifestState: ActiveCatalogManifestStateV1;
  readonly client: Pick<SignedConvexProviderReleasePublicationClient, "status">;
}): Promise<LocalClutchpacksProviderTerminal> {
  const { head, manifestState } = input;
  if (
    head.platformKey !== DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY ||
    head.release.platformKey !== DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY ||
    head.release.sharedConfigurationEpoch.configurationKey !== LOCAL_PUBLIC_CONFIGURATION_KEY ||
    input.plan.publicProviderReleaseId !== head.release.publicProviderReleaseId ||
    canonicalJson(input.plan.providerCheckpoint) !== canonicalJson(head.providerCheckpoint) ||
    canonicalJson(input.plan.observation) !== canonicalJson(head.observation)
  ) return refuse();
  let predecessor: ProviderReleaseExpectedCompletedHeadV1 = {
    platformKey: DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
    publicProviderReleaseId: null,
    sharedConfigurationEpoch: null,
    providerCheckpoint: { settledSequence: "0", settledAt: null },
    observation: null,
    terminalReceiptSha256: null,
  };
  if (manifestState.activeManifest !== null) {
    const selections = manifestState.observation.providerSelections;
    if (
      manifestState.activeManifest.sharedConfigurationEpoch.configurationKey !==
        LOCAL_PUBLIC_CONFIGURATION_KEY || selections.length !== 1 ||
      selections[0]!.platformKey !== DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY
    ) return refuse();
    const selection = selections[0]!;
    if (
      selection.publicProviderReleaseId === head.release.publicProviderReleaseId &&
      selection.terminalReceiptSha256 === head.terminalReceiptSha256 &&
      canonicalJson(selection.selectedProviderCheckpoint) === canonicalJson(head.providerCheckpoint) &&
      canonicalJson(manifestState.activeManifest.sharedConfigurationEpoch) ===
        canonicalJson(head.release.sharedConfigurationEpoch)
    ) {
      return {
        terminalOperationKind: selection.terminalOperationKind,
        terminalOperationId: selection.terminalOperationId,
        terminalReceiptSha256: selection.terminalReceiptSha256,
      };
    }
    if (
      BigInt(selection.selectedProviderCheckpoint.settledSequence) >=
        BigInt(head.providerCheckpoint.settledSequence) ||
      selection.latestAffectedSourceHeadSequence !== selection.selectedProviderCheckpoint.settledSequence
    ) return refuse();
    // This local publisher always sets sourceHeadAt and its successful
    // observation clock to the same genuine source-head run finish. Queued
    // work can delay the manifest selection, but never changes that provider
    // observation's freshness. Reconstruct its exact signed predecessor.
    predecessor = {
      platformKey: DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
      publicProviderReleaseId: selection.publicProviderReleaseId,
      sharedConfigurationEpoch: manifestState.activeManifest.sharedConfigurationEpoch,
      providerCheckpoint: selection.selectedProviderCheckpoint,
      observation: {
        sourceHeadSequence: selection.selectedProviderCheckpoint.settledSequence,
        lastSuccessfulObservationAt: selection.lastSuccessfulObservationAt,
        staleAt: selection.staleAt,
        freshness: "fresh",
      },
      terminalReceiptSha256: selection.terminalReceiptSha256,
    };
  }
  const plan = predecessor.publicProviderReleaseId === head.release.publicProviderReleaseId
    ? { ...input.plan, classification: "reuse" as const, batches: [],
        reuseProof: { state: "complete" as const, ...head.release } }
    : input.plan;
  const prepared = prepareProviderPromotion({
    plan,
    expectedCompletedHead: predecessor,
    checkpointSha256: createHash("sha256")
      .update(canonicalJson(head.providerCheckpoint), "utf8").digest("hex"),
  });
  const terminal = prepared.operations.at(-1);
  if (terminal === undefined ||
    (terminal.operationKind !== "finalize" && terminal.operationKind !== "confirmReuse")) {
    return refuse();
  }
  const observed = await input.client.status(providerPromotionStatusRequest(terminal));
  const receipt = validateProviderPromotionReceipt({
    operation: terminal,
    receipt: observed.receipt,
    canonicalReceiptBody: observed.canonicalReceiptBody,
    receiptSha256: observed.receiptSha256,
  });
  if (
    (receipt.operationKind !== "finalize" && receipt.operationKind !== "confirmReuse") ||
    observed.receiptSha256 !== head.terminalReceiptSha256
  ) return refuse();
  return {
    terminalOperationKind: receipt.operationKind,
    terminalOperationId: receipt.operationId,
    terminalReceiptSha256: observed.receiptSha256,
  };
}
