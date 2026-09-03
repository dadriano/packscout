import { createLaunchProviderObservationMapper } from "../../provider-observation-mapper.ts";
import { launchSourceMapperDescriptors } from "../../source-mapper-descriptors.ts";

export const PHYGITALS_PLATFORM_KEY = "phygitals" as const;

export const phygitalsProviderObservationMapper =
  createLaunchProviderObservationMapper(
    launchSourceMapperDescriptors.find(
      ({ provider }) => provider === PHYGITALS_PLATFORM_KEY,
    )!,
  );
