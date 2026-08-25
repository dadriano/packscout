import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
} from "@packscout/contracts";
import { createLaunchProviderObservationMapper } from "../../provider-observation-mapper.ts";
import { launchSourceMapperDescriptors } from "../../source-mapper-descriptors.ts";

export const COLLECTOR_CRYPT_PLATFORM_KEY = "collector_crypt" as const;

export const collectorCryptProviderObservationMappers = Object.freeze(
  launchSourceMapperDescriptors
    .filter(({ provider }) => provider === COLLECTOR_CRYPT_PLATFORM_KEY)
    .map(createLaunchProviderObservationMapper),
);

export const collectorCryptProviderObservationMapper =
  collectorCryptProviderObservationMappers.find(
    ({ descriptor }) => descriptor.normalizedContractVersion ===
      PROVIDER_OBSERVATION_CONTRACT_VERSION,
  )!;

export const collectorCryptProviderObservationMapperV2 =
  collectorCryptProviderObservationMappers.find(
    ({ descriptor }) => descriptor.normalizedContractVersion ===
      PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
  )!;
