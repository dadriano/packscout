import { createLaunchProviderObservationMapper } from "../../provider-observation-mapper.ts";
import { launchSourceMapperDescriptors } from "../../source-mapper-descriptors.ts";

export const COLLECTOR_CRYPT_PLATFORM_KEY = "collector_crypt" as const;

export const collectorCryptProviderObservationMapper =
  createLaunchProviderObservationMapper(
    launchSourceMapperDescriptors.find(
      ({ provider }) => provider === COLLECTOR_CRYPT_PLATFORM_KEY,
    )!,
  );
