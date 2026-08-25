import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
} from "@packscout/contracts";
import { createLaunchProviderObservationMapper } from "../../provider-observation-mapper.ts";
import { launchSourceMapperDescriptors } from "../../source-mapper-descriptors.ts";

export const PHYGITALS_PLATFORM_KEY = "phygitals" as const;

export const phygitalsProviderObservationMappers = Object.freeze(
  launchSourceMapperDescriptors
    .filter(({ provider }) => provider === PHYGITALS_PLATFORM_KEY)
    .map(createLaunchProviderObservationMapper),
);

export const phygitalsProviderObservationMapper =
  phygitalsProviderObservationMappers.find(
    ({ descriptor }) => descriptor.normalizedContractVersion ===
      PROVIDER_OBSERVATION_CONTRACT_VERSION,
  )!;

export const phygitalsProviderObservationMapperV2 =
  phygitalsProviderObservationMappers.find(
    ({ descriptor }) => descriptor.normalizedContractVersion ===
      PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
  )!;
