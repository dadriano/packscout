import type { LaunchProviderKey } from "@packscout/contracts";
import type {
  ProviderObservationMapper,
  ProviderObservationMapperInput,
} from "./provider-observation-mapper.ts";
import {
  launchSourceMapperDescriptors,
  type SourceMapperDescriptor,
} from "./source-mapper-descriptors.ts";

export type ProviderObservationMapperRegistryErrorCode =
  | "duplicate_mapper_registration"
  | "extra_mapper_registration"
  | "incompatible_mapper_registration"
  | "missing_mapper_registration"
  | "unknown_mapper_registration";

export class ProviderObservationMapperRegistryError extends Error {
  constructor(readonly code: ProviderObservationMapperRegistryErrorCode) {
    super(`provider_observation_mapper_registry.${code}`);
    this.name = "ProviderObservationMapperRegistryError";
  }
}

function identity(
  descriptor: Pick<
    SourceMapperDescriptor,
    "mapperKey" | "mapperVersion"
  >,
): string {
  return `${descriptor.mapperKey}@${descriptor.mapperVersion}`;
}

function descriptorMatches(
  actual: SourceMapperDescriptor,
  expected: SourceMapperDescriptor,
): boolean {
  return (
    actual.mapperKey === expected.mapperKey &&
    actual.mapperVersion === expected.mapperVersion &&
    actual.provider === expected.provider &&
    actual.normalizedContractVersion === expected.normalizedContractVersion &&
    actual.identityNamespaceKey === expected.identityNamespaceKey
  );
}

/** Closed launch registry. Deferred provider mappers cannot be selected here. */
export class ProductionProviderObservationMapperRegistry {
  readonly #mappers = new Map<string, ProviderObservationMapper>();

  constructor(mappers: Iterable<ProviderObservationMapper>) {
    const expected = new Map(
      launchSourceMapperDescriptors.map((descriptor) => [
        identity(descriptor),
        descriptor,
      ]),
    );
    for (const mapper of mappers) {
      const key = identity(mapper.descriptor);
      if (this.#mappers.has(key)) {
        throw new ProviderObservationMapperRegistryError(
          "duplicate_mapper_registration",
        );
      }
      const expectedDescriptor = expected.get(key);
      if (!expectedDescriptor) {
        throw new ProviderObservationMapperRegistryError(
          "extra_mapper_registration",
        );
      }
      if (!descriptorMatches(mapper.descriptor, expectedDescriptor)) {
        throw new ProviderObservationMapperRegistryError(
          "incompatible_mapper_registration",
        );
      }
      this.#mappers.set(key, mapper);
    }
    if (this.#mappers.size !== expected.size) {
      throw new ProviderObservationMapperRegistryError(
        "missing_mapper_registration",
      );
    }
  }

  resolve(input: {
    readonly mapperKey: string;
    readonly mapperVersion: string;
    readonly provider: LaunchProviderKey;
    readonly normalizedContractVersion: string;
    readonly identityNamespaceKey: string;
  }): ProviderObservationMapper {
    const mapper = this.#mappers.get(identity(input));
    if (!mapper) {
      throw new ProviderObservationMapperRegistryError(
        "unknown_mapper_registration",
      );
    }
    if (
      mapper.descriptor.provider !== input.provider ||
      mapper.descriptor.normalizedContractVersion !==
        input.normalizedContractVersion ||
      mapper.descriptor.identityNamespaceKey !== input.identityNamespaceKey
    ) {
      throw new ProviderObservationMapperRegistryError(
        "incompatible_mapper_registration",
      );
    }
    return mapper;
  }

  map(input: ProviderObservationMapperInput) {
    return this.resolve(input).map(input);
  }

  descriptors(): readonly SourceMapperDescriptor[] {
    return Object.freeze(
      [...this.#mappers.values()].map(({ descriptor }) => descriptor),
    );
  }
}
