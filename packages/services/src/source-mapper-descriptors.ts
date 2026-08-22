import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  launchProviderKeys,
  providerIdentityNamespaceByLaunchProvider,
  type LaunchProviderKey,
} from "@packscout/contracts";

export interface SourceMapperCompatibilityDescriptor {
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly provider: LaunchProviderKey;
  readonly normalizedContractVersion: typeof PROVIDER_OBSERVATION_CONTRACT_VERSION;
  readonly identityNamespaceKey: string;
}

const launchMapperKeys = Object.freeze({
  courtyard: "courtyard-provider-observation",
  collector_crypt: "collector-crypt-provider-observation",
  phygitals: "phygitals-provider-observation",
  clutchpacks: "clutchpacks-provider-observation",
} as const satisfies Readonly<Record<LaunchProviderKey, string>>);

export const launchSourceMapperDescriptors = Object.freeze(
  launchProviderKeys.map((provider): SourceMapperCompatibilityDescriptor =>
    Object.freeze({
      mapperKey: launchMapperKeys[provider],
      mapperVersion: "1",
      provider,
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
      identityNamespaceKey: providerIdentityNamespaceByLaunchProvider[provider],
    }),
  ),
);

export type SourceMapperCompatibilityErrorCode =
  | "duplicate_mapper_descriptor"
  | "mapper_identity_conflicts_with_source_type"
  | "normalized_contract_mismatch"
  | "provider_mismatch"
  | "replacement_namespace_mismatch"
  | "unknown_mapper_descriptor";

export class SourceMapperCompatibilityError extends Error {
  readonly code: SourceMapperCompatibilityErrorCode;

  constructor(code: SourceMapperCompatibilityErrorCode) {
    super(`source_mapper.${code}`);
    this.name = "SourceMapperCompatibilityError";
    this.code = code;
  }
}

function descriptorIdentity(
  descriptor: Pick<SourceMapperCompatibilityDescriptor, "mapperKey" | "mapperVersion">,
): string {
  return `${descriptor.mapperKey}@${descriptor.mapperVersion}`;
}

export class SourceMapperDescriptorRegistry {
  readonly #descriptors = new Map<string, SourceMapperCompatibilityDescriptor>();

  constructor(
    descriptors: Iterable<SourceMapperCompatibilityDescriptor> =
      launchSourceMapperDescriptors,
  ) {
    for (const descriptor of descriptors) this.register(descriptor);
  }

  register(descriptor: SourceMapperCompatibilityDescriptor): this {
    const identity = descriptorIdentity(descriptor);
    if (this.#descriptors.has(identity)) {
      throw new SourceMapperCompatibilityError("duplicate_mapper_descriptor");
    }
    this.#descriptors.set(identity, Object.freeze({ ...descriptor }));
    return this;
  }

  requireCompatible(input: {
    readonly mapperKey: string;
    readonly mapperVersion: string;
    readonly provider: LaunchProviderKey;
    readonly normalizedContractVersion: string;
    readonly identityNamespaceKey: string;
    readonly sourceTypeKey: string;
  }): SourceMapperCompatibilityDescriptor {
    if (input.mapperKey === input.sourceTypeKey) {
      throw new SourceMapperCompatibilityError(
        "mapper_identity_conflicts_with_source_type",
      );
    }
    const descriptor = this.#descriptors.get(descriptorIdentity(input));
    if (!descriptor) {
      throw new SourceMapperCompatibilityError("unknown_mapper_descriptor");
    }
    if (descriptor.provider !== input.provider) {
      throw new SourceMapperCompatibilityError("provider_mismatch");
    }
    if (descriptor.normalizedContractVersion !== input.normalizedContractVersion) {
      throw new SourceMapperCompatibilityError("normalized_contract_mismatch");
    }
    if (descriptor.identityNamespaceKey !== input.identityNamespaceKey) {
      throw new SourceMapperCompatibilityError("replacement_namespace_mismatch");
    }
    return descriptor;
  }

  descriptors(): readonly SourceMapperCompatibilityDescriptor[] {
    return Object.freeze([...this.#descriptors.values()]);
  }
}
