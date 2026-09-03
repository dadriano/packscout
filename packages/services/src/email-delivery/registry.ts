import {
  EMAIL_DELIVERY_ERROR_MESSAGE_MAX_LENGTH,
  emailDeliveryErrorCodeSchema,
  emailProviderNameSchema,
} from "@packscout/contracts";
import type { EmailDeliveryAdapter } from "./adapter.ts";

/**
 * Resolves delivery adapters by their registered name with exactly one
 * default: the first adapter registered. Registering an adapter is the only
 * step needed to make it selectable; no caller changes when one is added.
 */

export type EmailDeliveryRegistryErrorCode =
  | "duplicate_adapter_name"
  | "invalid_adapter_capability"
  | "invalid_adapter_name"
  | "reserved_adapter_name"
  | "unknown_adapter_name";

const registryErrorMessages: Readonly<
  Record<EmailDeliveryRegistryErrorCode, string>
> = {
  duplicate_adapter_name: "Email delivery adapter name is already registered.",
  invalid_adapter_capability:
    "Email delivery adapter is missing a required capability.",
  invalid_adapter_name: "Email delivery adapter name is invalid.",
  reserved_adapter_name:
    "Email delivery adapter name collides with a delivery mode.",
  unknown_adapter_name: "Email delivery adapter name is not registered.",
};

export class EmailDeliveryRegistryError extends Error {
  readonly code: EmailDeliveryRegistryErrorCode;

  constructor(code: EmailDeliveryRegistryErrorCode) {
    super(registryErrorMessages[code]);
    this.name = "EmailDeliveryRegistryError";
    this.code = code;
  }
}

/** Mode words can never be adapter names, or a named mode would be ambiguous. */
const reservedAdapterNames: ReadonlySet<string> = new Set([
  "auto",
  "disabled",
  "console",
]);

function assertAdapterCapability(adapter: EmailDeliveryAdapter): void {
  const description = adapter?.missingConfiguration;
  if (
    typeof adapter?.isConfigured !== "function" ||
    typeof adapter?.send !== "function" ||
    !emailDeliveryErrorCodeSchema.safeParse(description?.errorCode).success ||
    typeof description?.message !== "string" ||
    description.message.trim() === "" ||
    description.message.length > EMAIL_DELIVERY_ERROR_MESSAGE_MAX_LENGTH
  ) {
    throw new EmailDeliveryRegistryError("invalid_adapter_capability");
  }
}

export class EmailDeliveryAdapterRegistry {
  readonly #adapters = new Map<string, EmailDeliveryAdapter>();
  #defaultName: string | null = null;

  constructor(adapters: Iterable<EmailDeliveryAdapter> = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: EmailDeliveryAdapter): this {
    assertAdapterCapability(adapter);
    if (!emailProviderNameSchema.safeParse(adapter.name).success) {
      throw new EmailDeliveryRegistryError("invalid_adapter_name");
    }
    if (reservedAdapterNames.has(adapter.name)) {
      throw new EmailDeliveryRegistryError("reserved_adapter_name");
    }
    if (this.#adapters.has(adapter.name)) {
      throw new EmailDeliveryRegistryError("duplicate_adapter_name");
    }
    this.#adapters.set(adapter.name, adapter);
    this.#defaultName ??= adapter.name;
    return this;
  }

  has(name: string): boolean {
    return (
      emailProviderNameSchema.safeParse(name).success &&
      this.#adapters.has(name)
    );
  }

  resolve(name: string): EmailDeliveryAdapter {
    if (!emailProviderNameSchema.safeParse(name).success) {
      throw new EmailDeliveryRegistryError("invalid_adapter_name");
    }
    const adapter = this.#adapters.get(name);
    if (!adapter) {
      throw new EmailDeliveryRegistryError("unknown_adapter_name");
    }
    return adapter;
  }

  /** The single default adapter, or null while nothing is registered. */
  defaultAdapter(): EmailDeliveryAdapter | null {
    return this.#defaultName === null
      ? null
      : (this.#adapters.get(this.#defaultName) ?? null);
  }

  names(): readonly string[] {
    return Object.freeze([...this.#adapters.keys()].sort());
  }
}
