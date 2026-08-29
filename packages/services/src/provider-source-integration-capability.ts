const sourceIntegrationKeyPattern =
  /^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/;

export const CLUTCHPACKS_CAPTURE_ADAPTER_KEY =
  "local-capture-clutchpacks-v1" as const;

export interface ProviderSourceIntegrationCapability {
  readonly adapterKey: string;
  readonly sourceNeutralPageExecution: true;
}

/**
 * Explicit registry of source integrations that can execute a distributed
 * provider page. Transport and mapping adapters do not register themselves:
 * an integration opts in only after the complete execution seam is installed.
 */
export class ProviderSourceIntegrationCapabilityRegistry {
  readonly #adapterKeys = new Set<string>();

  constructor(
    capabilities: Iterable<ProviderSourceIntegrationCapability> = [],
  ) {
    for (const capability of capabilities) {
      if (
        capability.sourceNeutralPageExecution !== true
        || !sourceIntegrationKeyPattern.test(capability.adapterKey)
      ) {
        throw new TypeError("Provider source integration capability is invalid.");
      }
      if (this.#adapterKeys.has(capability.adapterKey)) {
        throw new TypeError("Provider source integration capability is duplicated.");
      }
      this.#adapterKeys.add(capability.adapterKey);
    }
  }

  has(adapterKey: string): boolean {
    return sourceIntegrationKeyPattern.test(adapterKey)
      && this.#adapterKeys.has(adapterKey);
  }

  keys(): readonly string[] {
    return Object.freeze([...this.#adapterKeys].sort());
  }
}

/** The intentionally narrow first-provider capability set. */
export function createClutchpacksSourceIntegrationCapabilities():
ProviderSourceIntegrationCapabilityRegistry {
  return new ProviderSourceIntegrationCapabilityRegistry([{
    adapterKey: CLUTCHPACKS_CAPTURE_ADAPTER_KEY,
    sourceNeutralPageExecution: true,
  }]);
}
