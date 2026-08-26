import { createLaunchProviderObservationMapper } from "../../provider-observation-mapper.ts";
import { launchSourceMapperDescriptors } from "../../source-mapper-descriptors.ts";

export const COURTYARD_PLATFORM_KEY = "courtyard" as const;

export const courtyardProviderObservationMapper =
  createLaunchProviderObservationMapper(
    launchSourceMapperDescriptors.find(
      ({ provider }) => provider === COURTYARD_PLATFORM_KEY,
    )!,
  );
