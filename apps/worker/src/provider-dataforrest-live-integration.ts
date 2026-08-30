import {
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  dataforrestLaunchDistributedSourceAdapterManifest,
  dataforrestPhygitalsDistributedV2SourceAdapterManifest,
  launchProviderKeySchema,
  sourceAdapterManifestV1Schema,
  type LaunchProviderKey,
  type SourceAdapterManifestV1,
} from "@packscout/contracts";
import {
  launchSourceMapperDescriptors,
  type SourceMapperDescriptor,
} from "@packscout/services";

export interface ProviderDataforrestLiveIntegration {
  readonly providerKey: LaunchProviderKey;
  readonly manifest: SourceAdapterManifestV1;
  readonly mapper: SourceMapperDescriptor;
  readonly declaration: SourceAdapterManifestV1["supportedProviders"][number];
}

function tupleKey(providerKey: string, adapterKey: string): string {
  return JSON.stringify([providerKey, adapterKey]);
}

export function createProviderDataforrestLiveIntegration(
  providerKey: LaunchProviderKey,
  candidateManifest: SourceAdapterManifestV1,
): ProviderDataforrestLiveIntegration {
  const manifest = sourceAdapterManifestV1Schema.parse(candidateManifest);
  const mapper = launchSourceMapperDescriptors.find(
    (candidate) => candidate.provider === providerKey,
  );
  const declaration = manifest.supportedProviders.find(
    (candidate) => candidate.provider === providerKey,
  );
  if (
    mapper === undefined
    || declaration === undefined
    || manifest.normalizedContractVersion !== mapper.normalizedContractVersion
    || declaration.identityNamespaceKey !== mapper.identityNamespaceKey
  ) {
    throw new TypeError("Provider DataForrest live integration is invalid.");
  }
  return Object.freeze({
    providerKey,
    manifest: Object.freeze(manifest),
    mapper: Object.freeze({ ...mapper }),
    declaration: Object.freeze({ ...declaration }),
  });
}

/** Closed worker registry. A source manifest alone never installs execution. */
export class ProviderDataforrestLiveIntegrationRegistry {
  readonly #integrations = new Map<string, ProviderDataforrestLiveIntegration>();

  constructor(integrations: Iterable<ProviderDataforrestLiveIntegration>) {
    for (const integration of integrations) {
      const key = tupleKey(
        integration.providerKey,
        integration.manifest.adapterVersion,
      );
      if (this.#integrations.has(key)) {
        throw new TypeError("Provider DataForrest live integration is duplicated.");
      }
      this.#integrations.set(key, integration);
    }
  }

  resolve(
    providerKey: string,
    adapterKey: string,
  ): ProviderDataforrestLiveIntegration | null {
    if (!launchProviderKeySchema.safeParse(providerKey).success) return null;
    return this.#integrations.get(tupleKey(providerKey, adapterKey)) ?? null;
  }

  resolveProvider(providerKey: string): ProviderDataforrestLiveIntegration | null {
    if (!launchProviderKeySchema.safeParse(providerKey).success) return null;
    const matches = [...this.#integrations.values()].filter(
      (integration) => integration.providerKey === providerKey,
    );
    return matches.length === 1 ? matches[0]! : null;
  }

  entries(): readonly ProviderDataforrestLiveIntegration[] {
    return Object.freeze([...this.#integrations.values()]);
  }
}

export const providerDataforrestLiveIntegrationRegistry =
  new ProviderDataforrestLiveIntegrationRegistry([
    createProviderDataforrestLiveIntegration(
      "clutchpacks",
      dataforrestClutchpacksDistributedSourceAdapterManifest,
    ),
    createProviderDataforrestLiveIntegration(
      "courtyard",
      dataforrestLaunchDistributedSourceAdapterManifest,
    ),
    createProviderDataforrestLiveIntegration(
      "collector_crypt",
      dataforrestLaunchDistributedSourceAdapterManifest,
    ),
    createProviderDataforrestLiveIntegration(
      "phygitals",
      dataforrestPhygitalsDistributedV2SourceAdapterManifest,
    ),
  ]);
