import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
} from "@packscout/contracts";
import { createLaunchProviderObservationMapper } from "../../provider-observation-mapper.ts";
import { launchSourceMapperDescriptors } from "../../source-mapper-descriptors.ts";

export const COURTYARD_PLATFORM_KEY = "courtyard" as const;

export const courtyardProviderObservationMappers = Object.freeze(
  launchSourceMapperDescriptors
    .filter(({ provider }) => provider === COURTYARD_PLATFORM_KEY)
    .map(createLaunchProviderObservationMapper),
);

export const courtyardProviderObservationMapper =
  courtyardProviderObservationMappers.find(
    ({ descriptor }) => descriptor.normalizedContractVersion ===
      PROVIDER_OBSERVATION_CONTRACT_VERSION,
  )!;

export const courtyardProviderObservationMapperV2 =
  courtyardProviderObservationMappers.find(
    ({ descriptor }) => descriptor.normalizedContractVersion ===
      PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
  )!;
