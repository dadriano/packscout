import type {
  ProviderAdapterIdentity,
  ProviderMappingAdapter,
  ProviderTransportAdapter,
} from "./provider-adapter.ts";

const registrationKeyPattern = /^[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?$/;

export type ProviderAdapterRegistryErrorCode =
  | "duplicate_adapter_key"
  | "duplicate_mapping_platform"
  | "invalid_adapter_capability"
  | "invalid_adapter_key"
  | "invalid_platform_key"
  | "unknown_adapter_key"
  | "unsupported_adapter_platform";

const registryErrorMessages: Readonly<
  Record<ProviderAdapterRegistryErrorCode, string>
> = {
  duplicate_adapter_key: "Provider adapter key is already registered.",
  duplicate_mapping_platform: "Provider platform already has a mapping adapter.",
  invalid_adapter_capability: "Provider adapter capability is invalid.",
  invalid_adapter_key: "Provider adapter key is invalid.",
  invalid_platform_key: "Provider platform key is invalid.",
  unknown_adapter_key: "Provider adapter key is not registered.",
  unsupported_adapter_platform: "Provider adapter does not support the platform.",
};

export class ProviderAdapterRegistryError extends Error {
  readonly code: ProviderAdapterRegistryErrorCode;

  constructor(code: ProviderAdapterRegistryErrorCode) {
    super(registryErrorMessages[code]);
    this.name = "ProviderAdapterRegistryError";
    this.code = code;
  }
}

function assertRegistrationKey(key: string): void {
  if (!registrationKeyPattern.test(key)) {
    throw new ProviderAdapterRegistryError("invalid_adapter_key");
  }
}

function assertPlatformKey(platform: string): void {
  if (!registrationKeyPattern.test(platform)) {
    throw new ProviderAdapterRegistryError("invalid_platform_key");
  }
}

function registerAdapter<TAdapter extends ProviderAdapterIdentity>(
  adapters: Map<string, TAdapter>,
  adapter: TAdapter,
): void {
  assertRegistrationKey(adapter.key);
  if (adapters.has(adapter.key)) {
    throw new ProviderAdapterRegistryError("duplicate_adapter_key");
  }
  adapters.set(adapter.key, adapter);
}

function resolveAdapter<TAdapter extends ProviderAdapterIdentity>(
  adapters: ReadonlyMap<string, TAdapter>,
  key: string,
): TAdapter {
  assertRegistrationKey(key);
  const adapter = adapters.get(key);
  if (!adapter) {
    throw new ProviderAdapterRegistryError("unknown_adapter_key");
  }
  return adapter;
}

function registryKeys(adapters: ReadonlyMap<string, ProviderAdapterIdentity>) {
  return Object.freeze([...adapters.keys()].sort());
}

export class ProviderMappingAdapterRegistry {
  readonly #adapters = new Map<string, ProviderMappingAdapter>();
  readonly #platformAdapters = new Map<string, ProviderMappingAdapter>();

  constructor(adapters: Iterable<ProviderMappingAdapter> = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ProviderMappingAdapter): this {
    if (
      typeof adapter.mapRecord !== "function" ||
      typeof adapter.platformKey !== "string"
    ) {
      throw new ProviderAdapterRegistryError("invalid_adapter_capability");
    }
    assertPlatformKey(adapter.platformKey);
    const current = this.#platformAdapters.get(adapter.platformKey);
    if (current && current.key !== adapter.key) {
      throw new ProviderAdapterRegistryError("duplicate_mapping_platform");
    }
    registerAdapter(this.#adapters, adapter);
    this.#platformAdapters.set(adapter.platformKey, adapter);
    return this;
  }

  resolve(key: string, platform: string): ProviderMappingAdapter {
    assertPlatformKey(platform);
    const adapter = resolveAdapter(this.#adapters, key);
    if (adapter.platformKey !== platform) {
      throw new ProviderAdapterRegistryError("unsupported_adapter_platform");
    }
    return adapter;
  }

  resolveForPlatform(platform: string): ProviderMappingAdapter {
    assertPlatformKey(platform);
    const adapter = this.#platformAdapters.get(platform);
    if (!adapter) {
      throw new ProviderAdapterRegistryError("unknown_adapter_key");
    }
    return adapter;
  }

  has(key: string, platform: string): boolean {
    if (
      !registrationKeyPattern.test(key) ||
      !registrationKeyPattern.test(platform)
    ) {
      return false;
    }
    return this.#adapters.get(key)?.platformKey === platform;
  }

  keys(): readonly string[] {
    return registryKeys(this.#adapters);
  }
}

export class ProviderTransportAdapterRegistry {
  readonly #adapters = new Map<string, ProviderTransportAdapter>();

  constructor(adapters: Iterable<ProviderTransportAdapter> = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ProviderTransportAdapter): this {
    if (
      typeof adapter.supportsPlatform !== "function" ||
      typeof adapter.testConnection !== "function" ||
      typeof adapter.fetchPage !== "function"
    ) {
      throw new ProviderAdapterRegistryError("invalid_adapter_capability");
    }
    registerAdapter(this.#adapters, adapter);
    return this;
  }

  resolve(key: string, platform: string): ProviderTransportAdapter {
    assertPlatformKey(platform);
    const adapter = resolveAdapter(this.#adapters, key);
    let supportsPlatform = false;
    try {
      supportsPlatform = adapter.supportsPlatform(platform) === true;
    } catch {
      supportsPlatform = false;
    }
    if (!supportsPlatform) {
      throw new ProviderAdapterRegistryError("unsupported_adapter_platform");
    }
    return adapter;
  }

  has(key: string, platform: string): boolean {
    if (
      !registrationKeyPattern.test(key) ||
      !registrationKeyPattern.test(platform)
    ) {
      return false;
    }
    const adapter = this.#adapters.get(key);
    if (!adapter) return false;
    try {
      return adapter.supportsPlatform(platform) === true;
    } catch {
      return false;
    }
  }

  keys(): readonly string[] {
    return registryKeys(this.#adapters);
  }
}
