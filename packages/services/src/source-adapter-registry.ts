import {
  sourceAdapterManifestV1Schema,
  type LaunchProviderKey,
} from "@packscout/contracts";
import type { SourceAdapter } from "./source-adapter.ts";

export type SourceAdapterRegistryErrorCode =
  | "adapter_version_mismatch"
  | "duplicate_adapter_registration"
  | "invalid_adapter_capability"
  | "invalid_adapter_manifest"
  | "unknown_source_type"
  | "unsupported_provider";

export class SourceAdapterRegistryError extends Error {
  readonly code: SourceAdapterRegistryErrorCode;

  constructor(code: SourceAdapterRegistryErrorCode) {
    super(`source_adapter_registry.${code}`);
    this.name = "SourceAdapterRegistryError";
    this.code = code;
  }
}

export class SourceAdapterRegistry {
  readonly #adapters = new Map<string, SourceAdapter>();
  readonly #currentVersions = new Map<string, string>();

  static #registrationKey(sourceTypeKey: string, adapterVersion: string): string {
    return JSON.stringify([sourceTypeKey, adapterVersion]);
  }

  constructor(
    adapters: Iterable<SourceAdapter> = [],
    currentVersions: Readonly<Record<string, string>> = {},
  ) {
    for (const adapter of adapters) this.register(adapter);
    for (const [sourceTypeKey, adapterVersion] of Object.entries(
      currentVersions,
    )) {
      this.resolveSourceType(sourceTypeKey, adapterVersion);
      this.#currentVersions.set(sourceTypeKey, adapterVersion);
    }
  }

  register(adapter: SourceAdapter): this {
    const parsed = sourceAdapterManifestV1Schema.safeParse(adapter.manifest);
    if (!parsed.success) {
      throw new SourceAdapterRegistryError("invalid_adapter_manifest");
    }
    const manifest = parsed.data;
    for (const capability of [
      "validateConnectionConfiguration",
      "validateSourceConfiguration",
      "captureUnboundRequest",
      "interpretConnectionTest",
      "interpretSourceTest",
      "interpretPage",
      "cancelRequest",
    ] as const) {
      if (typeof adapter[capability] !== "function") {
        throw new SourceAdapterRegistryError("invalid_adapter_capability");
      }
    }
    const registrationKey = SourceAdapterRegistry.#registrationKey(
      manifest.sourceTypeKey,
      manifest.adapterVersion,
    );
    if (this.#adapters.has(registrationKey)) {
      throw new SourceAdapterRegistryError("duplicate_adapter_registration");
    }
    const frozenManifest = deepFreeze(manifest);
    this.#adapters.set(
      registrationKey,
      Object.freeze({
        manifest: frozenManifest,
        validateConnectionConfiguration:
          adapter.validateConnectionConfiguration.bind(adapter),
        validateSourceConfiguration:
          adapter.validateSourceConfiguration.bind(adapter),
        captureUnboundRequest: adapter.captureUnboundRequest.bind(adapter),
        interpretConnectionTest: adapter.interpretConnectionTest.bind(adapter),
        interpretSourceTest: adapter.interpretSourceTest.bind(adapter),
        interpretPage: adapter.interpretPage.bind(adapter),
        cancelRequest: adapter.cancelRequest.bind(adapter),
      }),
    );
    return this;
  }

  resolve(
    sourceTypeKey: string,
    adapterVersion: string,
    provider: LaunchProviderKey,
  ): SourceAdapter {
    const adapter = this.resolveSourceType(sourceTypeKey, adapterVersion);
    if (
      !adapter.manifest.supportedProviders.some(
        (declaration) => declaration.provider === provider,
      )
    ) {
      throw new SourceAdapterRegistryError("unsupported_provider");
    }
    return adapter;
  }

  resolveSourceType(
    sourceTypeKey: string,
    adapterVersion: string,
  ): SourceAdapter {
    const adapter = this.#adapters.get(
      SourceAdapterRegistry.#registrationKey(sourceTypeKey, adapterVersion),
    );
    if (adapter) return adapter;
    const sourceTypeExists = [...this.#adapters.values()].some(
      (candidate) => candidate.manifest.sourceTypeKey === sourceTypeKey,
    );
    if (!sourceTypeExists) {
      throw new SourceAdapterRegistryError("unknown_source_type");
    }
    throw new SourceAdapterRegistryError("adapter_version_mismatch");
  }

  resolveOnlyVersion(sourceTypeKey: string): SourceAdapter {
    const adapters = [...this.#adapters.values()].filter(
      (candidate) => candidate.manifest.sourceTypeKey === sourceTypeKey,
    );
    if (adapters.length === 0) {
      throw new SourceAdapterRegistryError("unknown_source_type");
    }
    if (adapters.length !== 1) {
      throw new SourceAdapterRegistryError("adapter_version_mismatch");
    }
    return adapters[0]!;
  }

  resolveCurrentVersion(sourceTypeKey: string): SourceAdapter {
    const currentVersion = this.#currentVersions.get(sourceTypeKey);
    return currentVersion === undefined
      ? this.resolveOnlyVersion(sourceTypeKey)
      : this.resolveSourceType(sourceTypeKey, currentVersion);
  }

  keys(): readonly string[] {
    return Object.freeze(
      [...new Set(
        [...this.#adapters.values()].map(
          (adapter) => adapter.manifest.sourceTypeKey,
        ),
      )].sort(),
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}
