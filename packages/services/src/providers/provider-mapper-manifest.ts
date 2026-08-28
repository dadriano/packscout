import { ProductionProviderObservationMapperRegistry } from "../provider-observation-mapper-registry.ts";
import type { ProviderObservationMapper } from "../provider-observation-mapper.ts";
import { clutchpacksProviderObservationMapper } from "./clutchpacks/mapper.ts";
import { collectorCryptProviderObservationMapper } from "./collector-crypt/mapper.ts";
import { courtyardProviderObservationMapper } from "./courtyard/mapper.ts";
import { phygitalsProviderObservationMapper } from "./phygitals/mapper.ts";

/**
 * The production registry is deliberately closed to the four source-contract
 * descriptors approved for launch. Beezie, GameStop, Trove, and Stadium Vault
 * remain reference implementations only and are not activation-selectable.
 */
export const providerMapperManifest: readonly ProviderObservationMapper[] =
  Object.freeze([
    courtyardProviderObservationMapper,
    collectorCryptProviderObservationMapper,
    phygitalsProviderObservationMapper,
    clutchpacksProviderObservationMapper,
  ]);

export function createProviderObservationMapperRegistryFromManifest() {
  return new ProductionProviderObservationMapperRegistry(
    providerMapperManifest,
  );
}
