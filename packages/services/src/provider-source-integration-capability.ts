import {
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  dataforrestCollectorCryptCatalogV2SourceAdapterManifest,
  dataforrestCollectorCryptCatalogV3SourceAdapterManifest,
  dataforrestCollectorCryptDistributedSourceAdapterManifest,
  dataforrestCollectorCryptDistributedV2SourceAdapterManifest,
  dataforrestCollectorCryptDistributedV3SourceAdapterManifest,
  dataforrestCollectorCryptDistributedV4SourceAdapterManifest,
  dataforrestCourtyardCatalogSourceAdapterManifest,
  dataforrestCourtyardCatalogV2SourceAdapterManifest,
  dataforrestCourtyardDistributedV2SourceAdapterManifest,
  dataforrestCourtyardDistributedV3SourceAdapterManifest,
  dataforrestCourtyardDistributedV4SourceAdapterManifest,
  dataforrestPhygitalsCatalogSourceAdapterManifest,
  dataforrestPhygitalsCatalogV2SourceAdapterManifest,
  dataforrestPhygitalsDistributedV2SourceAdapterManifest,
  dataforrestPhygitalsDistributedV3SourceAdapterManifest,
  dataforrestPhygitalsDistributedV4SourceAdapterManifest,
  type LaunchProviderKey,
} from "@packscout/contracts";
import {
  launchSourceMapperDescriptors,
  type SourceMapperDescriptor,
} from "./source-mapper-descriptors.ts";

const sourceIntegrationKeyPattern =
  /^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/;

export const CLUTCHPACKS_CAPTURE_ADAPTER_KEY =
  "local-capture-clutchpacks-v1" as const;

export interface ProviderSourceIntegrationCapability {
  readonly providerKey: LaunchProviderKey;
  readonly adapterKey: string;
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly normalizedContractVersion:
    SourceMapperDescriptor["normalizedContractVersion"];
  readonly identityNamespaceKey: string;
  readonly sourceNeutralPageExecution: true;
}

/**
 * Explicit registry of source integrations that can execute a distributed
 * provider page. Transport and mapping adapters do not register themselves:
 * an integration opts in only after the complete execution seam is installed.
 */
export class ProviderSourceIntegrationCapabilityRegistry {
  readonly #capabilities = new Map<
    string,
    ProviderSourceIntegrationCapability
  >();

  constructor(
    capabilities: Iterable<ProviderSourceIntegrationCapability> = [],
  ) {
    for (const capability of capabilities) {
      const mapper = launchSourceMapperDescriptors.find(
        ({ provider }) => provider === capability.providerKey,
      );
      if (
        capability.sourceNeutralPageExecution !== true
        || !sourceIntegrationKeyPattern.test(capability.adapterKey)
        || mapper === undefined
        || capability.mapperKey !== mapper.mapperKey
        || capability.mapperVersion !== mapper.mapperVersion
        || capability.normalizedContractVersion !==
          mapper.normalizedContractVersion
        || capability.identityNamespaceKey !== mapper.identityNamespaceKey
      ) {
        throw new TypeError("Provider source integration capability is invalid.");
      }
      const key = this.#key(capability.providerKey, capability.adapterKey);
      if (this.#capabilities.has(key)) {
        throw new TypeError("Provider source integration capability is duplicated.");
      }
      this.#capabilities.set(key, Object.freeze({ ...capability }));
    }
  }

  has(providerKey: string, adapterKey: string): boolean {
    return sourceIntegrationKeyPattern.test(adapterKey)
      && this.#capabilities.has(this.#key(providerKey, adapterKey));
  }

  resolve(
    providerKey: string,
    adapterKey: string,
  ): ProviderSourceIntegrationCapability | null {
    if (!sourceIntegrationKeyPattern.test(adapterKey)) return null;
    return this.#capabilities.get(this.#key(providerKey, adapterKey)) ?? null;
  }

  keys(): readonly string[] {
    return Object.freeze([...this.#capabilities.keys()].sort());
  }

  #key(providerKey: string, adapterKey: string): string {
    return `${providerKey}:${adapterKey}`;
  }
}

export function providerSourceIntegrationCapability(
  providerKey: LaunchProviderKey,
  adapterKey: string,
): ProviderSourceIntegrationCapability {
  const mapper = launchSourceMapperDescriptors.find(
    ({ provider }) => provider === providerKey,
  );
  if (mapper === undefined) {
    throw new TypeError("Provider source mapper descriptor is unavailable.");
  }
  return Object.freeze({
    providerKey,
    adapterKey,
    mapperKey: mapper.mapperKey,
    mapperVersion: mapper.mapperVersion,
    normalizedContractVersion: mapper.normalizedContractVersion,
    identityNamespaceKey: mapper.identityNamespaceKey,
    sourceNeutralPageExecution: true,
  });
}

/** The intentionally narrow first-provider capture and live capability set. */
export function createClutchpacksSourceIntegrationCapabilities():
ProviderSourceIntegrationCapabilityRegistry {
  return new ProviderSourceIntegrationCapabilityRegistry([
    providerSourceIntegrationCapability(
      "clutchpacks",
      CLUTCHPACKS_CAPTURE_ADAPTER_KEY,
    ),
    providerSourceIntegrationCapability(
      "clutchpacks",
      dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion,
    ),
  ]);
}

/** Installed execution tuples for the current distributed review slice. */
export function createLaunchSourceIntegrationCapabilities():
ProviderSourceIntegrationCapabilityRegistry {
  return new ProviderSourceIntegrationCapabilityRegistry([
    providerSourceIntegrationCapability(
      "courtyard", dataforrestCourtyardDistributedV4SourceAdapterManifest.adapterVersion,
    ),
    providerSourceIntegrationCapability(
      "collector_crypt", dataforrestCollectorCryptDistributedV4SourceAdapterManifest.adapterVersion,
    ),
    providerSourceIntegrationCapability(
      "clutchpacks",
      CLUTCHPACKS_CAPTURE_ADAPTER_KEY,
    ),
    providerSourceIntegrationCapability(
      "clutchpacks",
      dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion,
    ),
    providerSourceIntegrationCapability(
      "courtyard",
      dataforrestCourtyardDistributedV2SourceAdapterManifest.adapterVersion,
    ),
    providerSourceIntegrationCapability(
      "courtyard",
      dataforrestCourtyardCatalogSourceAdapterManifest.adapterVersion,
    ),
    providerSourceIntegrationCapability(
      "collector_crypt",
      dataforrestCollectorCryptDistributedSourceAdapterManifest.adapterVersion,
    ),
    providerSourceIntegrationCapability(
      "collector_crypt",
      dataforrestCollectorCryptDistributedV2SourceAdapterManifest.adapterVersion,
    ),
    providerSourceIntegrationCapability(
      "collector_crypt",
      dataforrestCollectorCryptCatalogV2SourceAdapterManifest.adapterVersion,
    ),
    providerSourceIntegrationCapability(
      "phygitals",
      dataforrestPhygitalsDistributedV2SourceAdapterManifest.adapterVersion,
    ),
    providerSourceIntegrationCapability(
      "phygitals",
      dataforrestPhygitalsCatalogSourceAdapterManifest.adapterVersion,
    ),
    // The pack-reading catalog versions. Without these tuples the admin
    // admission gate refuses a run on an activated source with
    // PROVIDER_SOURCE_ADAPTER_UNAVAILABLE, so they are admitted alongside the
    // predecessors rather than after activation.
    providerSourceIntegrationCapability(
      "courtyard",
      dataforrestCourtyardCatalogV2SourceAdapterManifest.adapterVersion,
    ),
    providerSourceIntegrationCapability(
      "collector_crypt",
      dataforrestCollectorCryptCatalogV3SourceAdapterManifest.adapterVersion,
    ),
    providerSourceIntegrationCapability(
      "phygitals",
      dataforrestPhygitalsCatalogV2SourceAdapterManifest.adapterVersion,
    ),
    // The pack-reading DISTRIBUTED versions. Production runs all-stream sources
    // for these three providers, so the catalog-scoped identities above cannot
    // carry their packs without stopping pull and trade ingestion. Admitted
    // before activation for the same admission-gate reason as the catalog ones.
    providerSourceIntegrationCapability(
      "courtyard",
      dataforrestCourtyardDistributedV3SourceAdapterManifest.adapterVersion,
    ),
    providerSourceIntegrationCapability(
      "collector_crypt",
      dataforrestCollectorCryptDistributedV3SourceAdapterManifest.adapterVersion,
    ),
    providerSourceIntegrationCapability(
      "phygitals",
      dataforrestPhygitalsDistributedV3SourceAdapterManifest.adapterVersion,
    ),
    // Distributed-v4 binds the Phygitals rarity distribution as a
    // probability-only EV input; admitted before activation for the same
    // admission-gate reason as the versions above.
    providerSourceIntegrationCapability(
      "phygitals",
      dataforrestPhygitalsDistributedV4SourceAdapterManifest.adapterVersion,
    ),
  ]);
}
