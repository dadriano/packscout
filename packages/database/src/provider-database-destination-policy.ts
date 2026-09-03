export interface ProviderDatabaseDestinationPolicyOptions {
  readonly allowedHosts: readonly string[];
  readonly allowedPorts?: readonly number[];
  readonly allowedSslModes?: readonly (
    "disable" | "require" | "verify-ca" | "verify-full"
  )[];
}

export class ProviderDatabaseDestinationPolicyError extends Error {
  readonly code = "destination_not_allowed" as const;

  constructor() {
    super("Provider database destination is not allowed.");
    this.name = "ProviderDatabaseDestinationPolicyError";
  }
}

function canonicalHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function matchesHost(host: string, rule: string): boolean {
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  return host === rule;
}

/** Explicit server configuration controls the only destinations the gateway opens. */
export class ProviderDatabaseDestinationPolicy {
  readonly #hostRules: readonly string[];
  readonly #ports: ReadonlySet<number>;
  readonly #sslModes: ReadonlySet<string>;

  constructor(options: ProviderDatabaseDestinationPolicyOptions) {
    const hostRules = options.allowedHosts.map(canonicalHost);
    if (
      hostRules.length === 0
      || hostRules.some((host) =>
        host.length === 0
        || /\s/.test(host)
        || ["/", "@", "?", "#", "[", "]"].some((character) =>
          host.includes(character)
        )
        || (host.includes("*") && !/^\*\.[a-z0-9.-]+$/.test(host))
      )
    ) {
      throw new TypeError("Provider database destination policy is invalid.");
    }
    const ports = options.allowedPorts ?? [5432];
    if (
      ports.length === 0
      || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)
    ) {
      throw new TypeError("Provider database destination policy is invalid.");
    }
    const sslModes = options.allowedSslModes ?? ["verify-full"];
    if (sslModes.length === 0) {
      throw new TypeError("Provider database destination policy is invalid.");
    }
    this.#hostRules = Object.freeze([...new Set(hostRules)]);
    this.#ports = new Set(ports);
    this.#sslModes = new Set(sslModes);
  }

  assertAllowed(input: {
    readonly host: string;
    readonly port: number;
    readonly sslMode: string;
  }): void {
    const host = canonicalHost(input.host);
    if (
      !this.#hostRules.some((rule) => matchesHost(host, rule))
      || !this.#ports.has(input.port)
      || !this.#sslModes.has(input.sslMode)
    ) {
      throw new ProviderDatabaseDestinationPolicyError();
    }
  }
}
