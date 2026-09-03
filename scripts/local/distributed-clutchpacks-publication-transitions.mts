import {
  canonicalJson,
  type ActiveCatalogManifestStateV1,
  type GlobalCatalogAggregateObservationV1,
  type GlobalCatalogManifestV1,
  type ProviderReleaseCompletedHeadStateV1,
  type ProviderReleaseImmutableProofV1,
} from "@packscout/contracts";
import type {
  DataReleaseV3ActiveState,
  DataReleaseV3PublicationPort,
} from "@packscout/services";
import {
  DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
  DistributedClutchpacksPublicationError,
  LOCAL_PUBLIC_CONFIGURATION_KEY,
} from "./distributed-clutchpacks-publication-plan.mts";

function refuse(code: string): never {
  throw new DistributedClutchpacksPublicationError(code);
}

/** Existing local releases may advance only along real, increasing checkpoints. */
export function localClutchpacksProviderTransition(input: {
  readonly before: ProviderReleaseCompletedHeadStateV1;
  readonly expectedProof: ProviderReleaseImmutableProofV1;
  readonly providerCheckpoint: Exclude<ProviderReleaseCompletedHeadStateV1,
    { readonly release: null }>["providerCheckpoint"];
  readonly observation: Exclude<ProviderReleaseCompletedHeadStateV1,
    { readonly release: null }>["observation"];
}): "replay" | "publish" | "confirmReuse" {
  const { before, expectedProof, providerCheckpoint, observation } = input;
  if (
    before.platformKey !== DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY ||
    expectedProof.platformKey !== DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY ||
    expectedProof.sharedConfigurationEpoch.configurationKey !==
      LOCAL_PUBLIC_CONFIGURATION_KEY
  ) return refuse("LOCAL_CONVEX_PROVIDER_SCOPE_CONFLICT");
  if (before.release === null) return "publish";
  const previousEpoch = before.release.sharedConfigurationEpoch;
  const nextEpoch = expectedProof.sharedConfigurationEpoch;
  if (
    before.release.platformKey !== DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY ||
    previousEpoch.configurationKey !== LOCAL_PUBLIC_CONFIGURATION_KEY
  ) return refuse("LOCAL_CONVEX_PROVIDER_SCOPE_CONFLICT");
  if (
    canonicalJson(before.release) === canonicalJson(expectedProof) &&
    canonicalJson(before.providerCheckpoint) === canonicalJson(providerCheckpoint) &&
    canonicalJson(before.observation) === canonicalJson(observation)
  ) return "replay";
  if (
    BigInt(providerCheckpoint.settledSequence) <=
      BigInt(before.providerCheckpoint.settledSequence)
  ) return refuse("LOCAL_CONVEX_PROVIDER_CHECKPOINT_CONFLICT");
  if (expectedProof.publicProviderReleaseId === before.release.publicProviderReleaseId) {
    if (canonicalJson(before.release) !== canonicalJson(expectedProof)) {
      return refuse("LOCAL_CONVEX_PROVIDER_IDENTITY_CONFLICT");
    }
    return "confirmReuse";
  }
  if (
    canonicalJson(previousEpoch) !== canonicalJson(nextEpoch) &&
    (nextEpoch.revision <= previousEpoch.revision ||
      BigInt(nextEpoch.publicChangeSequence) <=
        BigInt(previousEpoch.publicChangeSequence))
  ) return refuse("LOCAL_CONVEX_PROVIDER_EPOCH_CONFLICT");
  return "publish";
}

/** Never replace another provider's manifest, including a mixed-provider one. */
export function localClutchpacksManifestTransition(input: {
  readonly before: ActiveCatalogManifestStateV1;
  readonly manifest: GlobalCatalogManifestV1;
  readonly observation: GlobalCatalogAggregateObservationV1;
}): "replay" | "activateManifest" | "refreshActiveState" {
  const { before, manifest, observation } = input;
  const localSelections = (value: GlobalCatalogAggregateObservationV1) =>
    value.providerSelections.length === 1 &&
    value.providerSelections[0]!.platformKey === DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY;
  if (
    manifest.sharedConfigurationEpoch.configurationKey !== LOCAL_PUBLIC_CONFIGURATION_KEY ||
    !localSelections(observation)
  ) return refuse("LOCAL_CONVEX_MANIFEST_SCOPE_CONFLICT");
  if (before.activeManifest === null) return "activateManifest";
  if (
    before.activeManifest.sharedConfigurationEpoch.configurationKey !==
      LOCAL_PUBLIC_CONFIGURATION_KEY || !localSelections(before.observation)
  ) return refuse("LOCAL_CONVEX_MANIFEST_SCOPE_CONFLICT");
  const sameManifest =
    before.activeManifest.publicReleaseId === manifest.publicReleaseId &&
    before.activeManifest.manifestFingerprint === manifest.manifestFingerprint;
  if (sameManifest && canonicalJson(before.observation) === canonicalJson(observation)) {
    return "replay";
  }
  if (observation.observationSequence <= before.observation.observationSequence) {
    return refuse("LOCAL_CONVEX_MANIFEST_OBSERVATION_CONFLICT");
  }
  if (
    before.activeManifest.publicReleaseId === manifest.publicReleaseId && !sameManifest
  ) return refuse("LOCAL_CONVEX_ACTIVE_MANIFEST_CONFLICT");
  return sameManifest ? "refreshActiveState" : "activateManifest";
}

/** A bounded public read proves this predecessor is the same local pack set. */
export function assertLocalClutchpacksV3Predecessor(input: {
  readonly state: DataReleaseV3ActiveState;
  readonly publicReleaseId: string;
  readonly total: number;
  readonly rows: readonly {
    readonly publicRepackId: string;
    readonly publicVendorId: string;
    readonly vendorKey: string;
  }[];
  readonly expectedPublicRepackIds: readonly string[];
  readonly expectedPublicVendorId: string;
}): void {
  if (
    input.state.activeRelease === null ||
    input.state.activeRelease.publicReleaseId !== input.publicReleaseId ||
    input.state.activeRelease.counts.repacks !== input.total ||
    input.total !== input.rows.length ||
    input.total !== input.expectedPublicRepackIds.length ||
    input.rows.some((row) => row.vendorKey !== DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY ||
      row.publicVendorId !== input.expectedPublicVendorId) ||
    canonicalJson(input.rows.map(({ publicRepackId }) => publicRepackId).sort()) !==
      canonicalJson([...input.expectedPublicRepackIds].sort())
  ) return refuse("LOCAL_CONVEX_DATA_RELEASE_V3_SCOPE_CONFLICT");
}

/** Bind staging and activation to the state whose provider identity was proved. */
export function bindLocalClutchpacksV3Predecessor(
  port: DataReleaseV3PublicationPort,
  expectedState: DataReleaseV3ActiveState,
): DataReleaseV3PublicationPort {
  let initialRead = true;
  return {
    async activeState() {
      const current = await port.activeState();
      if (initialRead && canonicalJson(current) !== canonicalJson(expectedState)) {
        return refuse("LOCAL_CONVEX_DATA_RELEASE_V3_CONFLICT");
      }
      initialRead = false;
      return current;
    },
    status: (id) => port.status(id),
    start: (request) => port.start(request),
    applyBatch: (request) => port.applyBatch(request),
    finalize: (request) => port.finalize(request),
    activate: (request) => {
      if (request.expectedActivePublicReleaseId !==
        (expectedState.activeRelease?.publicReleaseId ?? null)) {
        return refuse("LOCAL_CONVEX_DATA_RELEASE_V3_CONFLICT");
      }
      return port.activate(request);
    },
    rollback: (request) => port.rollback(request),
  };
}
