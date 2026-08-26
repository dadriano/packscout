import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  launchProviderKeys,
  providerIdentityNamespaceByLaunchProvider,
  type LaunchProviderKey,
} from "@packscout/contracts";

export type SourceMapperNormalizedContractVersion =
  typeof PROVIDER_OBSERVATION_CONTRACT_VERSION;

export interface SourceMapperDescriptor {
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly provider: LaunchProviderKey;
  readonly normalizedContractVersion: SourceMapperNormalizedContractVersion;
  readonly identityNamespaceKey: string;
}

const launchMapperKeys = Object.freeze({
  courtyard: "courtyard-provider-observation",
  collector_crypt: "collector-crypt-provider-observation",
  phygitals: "phygitals-provider-observation",
  clutchpacks: "clutchpacks-provider-observation",
} as const satisfies Readonly<Record<LaunchProviderKey, string>>);

export const launchSourceMapperDescriptors = Object.freeze(
  launchProviderKeys.map((provider): SourceMapperDescriptor => {
    const mapperKey = launchMapperKeys[provider];
    const identityNamespaceKey =
      providerIdentityNamespaceByLaunchProvider[provider];
    return Object.freeze({
      mapperKey,
      mapperVersion: "1",
      provider,
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
      identityNamespaceKey,
    });
  }),
);

export type SourceMapperDescriptorErrorCode =
  | "duplicate_mapper_descriptor"
  | "mapper_identity_conflicts_with_source_type"
  | "normalized_contract_mismatch"
  | "provider_mismatch"
  | "identity_namespace_mismatch"
  | "unknown_mapper_descriptor";

export class SourceMapperDescriptorError extends Error {
  readonly code: SourceMapperDescriptorErrorCode;

  constructor(code: SourceMapperDescriptorErrorCode) {
    super(`source_mapper.${code}`);
    this.name = "SourceMapperDescriptorError";
    this.code = code;
  }
}

function descriptorIdentity(
  descriptor: Pick<SourceMapperDescriptor, "mapperKey" | "mapperVersion">,
): string {
  return `${descriptor.mapperKey}@${descriptor.mapperVersion}`;
}

function freezeDescriptor(
  descriptor: SourceMapperDescriptor,
): SourceMapperDescriptor {
  return Object.freeze({ ...descriptor });
}

export class SourceMapperDescriptorRegistry {
  readonly #descriptors = new Map<string, SourceMapperDescriptor>();

  constructor(
    descriptors: Iterable<SourceMapperDescriptor> =
      launchSourceMapperDescriptors,
  ) {
    for (const descriptor of descriptors) this.register(descriptor);
  }

  register(descriptor: SourceMapperDescriptor): this {
    const identity = descriptorIdentity(descriptor);
    if (this.#descriptors.has(identity)) {
      throw new SourceMapperDescriptorError("duplicate_mapper_descriptor");
    }
    this.#descriptors.set(identity, freezeDescriptor(descriptor));
    return this;
  }

  requireCompatible(input: {
    readonly mapperKey: string;
    readonly mapperVersion: string;
    readonly provider: LaunchProviderKey;
    readonly normalizedContractVersion: string;
    readonly identityNamespaceKey: string;
    readonly sourceTypeKey: string;
  }): SourceMapperDescriptor {
    if (input.mapperKey === input.sourceTypeKey) {
      throw new SourceMapperDescriptorError(
        "mapper_identity_conflicts_with_source_type",
      );
    }
    const descriptor = this.#descriptors.get(descriptorIdentity(input));
    if (!descriptor) {
      throw new SourceMapperDescriptorError("unknown_mapper_descriptor");
    }
    if (descriptor.provider !== input.provider) {
      throw new SourceMapperDescriptorError("provider_mismatch");
    }
    if (descriptor.normalizedContractVersion !== input.normalizedContractVersion) {
      throw new SourceMapperDescriptorError("normalized_contract_mismatch");
    }
    if (descriptor.identityNamespaceKey !== input.identityNamespaceKey) {
      throw new SourceMapperDescriptorError("identity_namespace_mismatch");
    }
    return descriptor;
  }

  descriptors(): readonly SourceMapperDescriptor[] {
    return Object.freeze([...this.#descriptors.values()]);
  }
}
