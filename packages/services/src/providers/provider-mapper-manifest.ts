import { ProductionProviderObservationMapperRegistry } from "../provider-observation-mapper-registry.ts";
import type { ProviderObservationMapper } from "../provider-observation-mapper.ts";
import { clutchpacksProviderObservationMappers } from "./clutchpacks/mapper.ts";
import { collectorCryptProviderObservationMappers } from "./collector-crypt/mapper.ts";
import { courtyardProviderObservationMappers } from "./courtyard/mapper.ts";
import { phygitalsProviderObservationMappers } from "./phygitals/mapper.ts";

/**
 * The production registry is deliberately closed to the four source-contract
 * descriptors approved for launch. Beezie, GameStop, Trove, and Stadium Vault
 * remain reference implementations only and are not activation-selectable.
 */
export const providerMapperManifest: readonly ProviderObservationMapper[] =
  Object.freeze([
    ...courtyardProviderObservationMappers,
    ...collectorCryptProviderObservationMappers,
    ...phygitalsProviderObservationMappers,
    ...clutchpacksProviderObservationMappers,
  ]);

export function createProviderObservationMapperRegistryFromManifest() {
  return new ProductionProviderObservationMapperRegistry(
    providerMapperManifest,
  );
}
