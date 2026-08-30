import {
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  dataforrestLaunchDistributedSourceAdapterManifest,
  dataforrestPhygitalsDistributedV2SourceAdapterManifest,
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
      "clutchpacks",
      CLUTCHPACKS_CAPTURE_ADAPTER_KEY,
    ),
    providerSourceIntegrationCapability(
      "clutchpacks",
      dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion,
    ),
    providerSourceIntegrationCapability(
      "courtyard",
      dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion,
    ),
    providerSourceIntegrationCapability(
      "collector_crypt",
      dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion,
    ),
    providerSourceIntegrationCapability(
      "phygitals",
      dataforrestPhygitalsDistributedV2SourceAdapterManifest.adapterVersion,
    ),
  ]);
}
