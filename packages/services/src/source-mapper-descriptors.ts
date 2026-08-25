import {
  PROVIDER_OBSERVATION_CONTRACT_VERSION,
  PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
  launchProviderKeys,
  providerIdentityNamespaceByLaunchProvider,
  type LaunchProviderKey,
} from "@packscout/contracts";

export type SourceMapperNormalizedContractVersion =
  | typeof PROVIDER_OBSERVATION_CONTRACT_VERSION
  | typeof PROVIDER_OBSERVATION_CONTRACT_VERSION_V2;

export interface SourceMapperContractPin {
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly normalizedContractVersion: SourceMapperNormalizedContractVersion;
}

export interface SourceMapperContractPinInput {
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly normalizedContractVersion: string;
}

export interface SourceMapperCompatibilityDescriptor {
  readonly mapperKey: string;
  readonly mapperVersion: string;
  readonly provider: LaunchProviderKey;
  readonly normalizedContractVersion: SourceMapperNormalizedContractVersion;
  readonly identityNamespaceKey: string;
  /** Exact older mapper/contract pins this descriptor may replace. */
  readonly compatiblePredecessors: readonly SourceMapperContractPin[];
}

const launchMapperKeys = Object.freeze({
  courtyard: "courtyard-provider-observation",
  collector_crypt: "collector-crypt-provider-observation",
  phygitals: "phygitals-provider-observation",
  clutchpacks: "clutchpacks-provider-observation",
} as const satisfies Readonly<Record<LaunchProviderKey, string>>);

export const launchSourceMapperDescriptors = Object.freeze(
  launchProviderKeys.flatMap((provider): SourceMapperCompatibilityDescriptor[] => {
    const mapperKey = launchMapperKeys[provider];
    const identityNamespaceKey =
      providerIdentityNamespaceByLaunchProvider[provider];
    const v1: SourceMapperCompatibilityDescriptor = Object.freeze({
      mapperKey,
      mapperVersion: "1",
      provider,
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
      identityNamespaceKey,
      compatiblePredecessors: Object.freeze([]),
    });
    const v2: SourceMapperCompatibilityDescriptor = Object.freeze({
      mapperKey,
      mapperVersion: "2",
      provider,
      normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION_V2,
      identityNamespaceKey,
      compatiblePredecessors: Object.freeze([Object.freeze({
        mapperKey,
        mapperVersion: "1",
        normalizedContractVersion: PROVIDER_OBSERVATION_CONTRACT_VERSION,
      })]),
    });
    return [v1, v2];
  }),
);

export type SourceMapperCompatibilityErrorCode =
  | "duplicate_mapper_descriptor"
  | "mapper_identity_conflicts_with_source_type"
  | "normalized_contract_mismatch"
  | "provider_mismatch"
  | "replacement_contract_mismatch"
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

function contractPinMatches(
  left: SourceMapperContractPin,
  right: SourceMapperContractPinInput,
): boolean {
  return left.mapperKey === right.mapperKey &&
    left.mapperVersion === right.mapperVersion &&
    left.normalizedContractVersion === right.normalizedContractVersion;
}

function freezeDescriptor(
  descriptor: SourceMapperCompatibilityDescriptor,
): SourceMapperCompatibilityDescriptor {
  return Object.freeze({
    ...descriptor,
    compatiblePredecessors: Object.freeze(
      descriptor.compatiblePredecessors.map((pin) => Object.freeze({ ...pin })),
    ),
  });
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

  requireReplacementCompatible(input: Readonly<{
    replacement: SourceMapperCompatibilityDescriptor;
    predecessor: SourceMapperContractPinInput;
  }>): SourceMapperCompatibilityDescriptor {
    const descriptor = this.#descriptors.get(
      descriptorIdentity(input.replacement),
    );
    if (!descriptor) {
      throw new SourceMapperCompatibilityError("unknown_mapper_descriptor");
    }
    if (
      descriptor.provider !== input.replacement.provider ||
      descriptor.normalizedContractVersion !==
        input.replacement.normalizedContractVersion ||
      descriptor.identityNamespaceKey !==
        input.replacement.identityNamespaceKey
    ) {
      throw new SourceMapperCompatibilityError(
        "replacement_contract_mismatch",
      );
    }
    const currentPin: SourceMapperContractPin = descriptor;
    if (
      !contractPinMatches(currentPin, input.predecessor) &&
      !descriptor.compatiblePredecessors.some((pin) =>
        contractPinMatches(pin, input.predecessor)
      )
    ) {
      throw new SourceMapperCompatibilityError(
        "replacement_contract_mismatch",
      );
    }
    return descriptor;
  }

  descriptors(): readonly SourceMapperCompatibilityDescriptor[] {
    return Object.freeze([...this.#descriptors.values()]);
  }
}
