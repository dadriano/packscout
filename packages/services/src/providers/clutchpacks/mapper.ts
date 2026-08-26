import { createLaunchProviderObservationMapper } from "../../provider-observation-mapper.ts";
import { launchSourceMapperDescriptors } from "../../source-mapper-descriptors.ts";

export const CLUTCHPACKS_PLATFORM_KEY = "clutchpacks" as const;

export const clutchpacksProviderObservationMapper =
  createLaunchProviderObservationMapper(
    launchSourceMapperDescriptors.find(
      ({ provider }) => provider === CLUTCHPACKS_PLATFORM_KEY,
    )!,
  );
