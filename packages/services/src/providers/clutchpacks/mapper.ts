import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
} from "@packscout/contracts";
import { createLaunchProviderObservationMapper } from "../../provider-observation-mapper.ts";
import { launchSourceMapperDescriptors } from "../../source-mapper-descriptors.ts";

export const CLUTCHPACKS_PLATFORM_KEY = "clutchpacks" as const;

export const clutchpacksProviderObservationMappers = Object.freeze(
  launchSourceMapperDescriptors
    .filter(({ provider }) => provider === CLUTCHPACKS_PLATFORM_KEY)
    .map(createLaunchProviderObservationMapper),
);

export const clutchpacksProviderObservationMapper =
  clutchpacksProviderObservationMappers.find(
    ({ descriptor }) => descriptor.normalizedContractVersion ===
      PROVIDER_OBSERVATION_CONTRACT_VERSION,
  )!;

export const clutchpacksProviderObservationMapperV2 =
  clutchpacksProviderObservationMappers.find(
    ({ descriptor }) => descriptor.normalizedContractVersion ===
      PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
  )!;
