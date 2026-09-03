import { isIP } from "node:net";

const MIN_PORT = 1;
const MAX_PORT = 65_535;
const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

export function readServiceHost(
  value: string | undefined,
  fallback: string,
  variableName: string,
  loopbackOnly = true,
): string {
  const candidate = value ?? fallback;
  if (
    (loopbackOnly && !loopbackHosts.has(candidate)) ||
    (!loopbackOnly && candidate !== "localhost" && isIP(candidate) === 0)
  ) {
    throw new Error(
      loopbackOnly
        ? `${variableName} must be 127.0.0.1, ::1, or localhost for local service binding.`
        : `${variableName} must be a valid IP address or localhost.`,
    );
  }
  return candidate;
}

export function adminDevelopmentServerNetwork(
  host: string,
  hmrPort: number,
) {
  return {
    middlewareMode: true as const,
    hmr: { host, port: hmrPort },
  };
}

export function serviceHttpOrigin(host: string, port: number): string {
  return `http://${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

export function adminDevelopmentAllowedOrigins(
  host: string,
  port: number,
): string[] {
  return [
    ...new Set([
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      serviceHttpOrigin(host, port),
    ]),
  ];
}

export function readPort(
  value: string | undefined,
  fallback: number,
  variableName: string,
): number {
  const candidate = value === undefined ? fallback : Number(value);

  if (
    !Number.isInteger(candidate) ||
    candidate < MIN_PORT ||
    candidate > MAX_PORT
  ) {
    throw new Error(
      `${variableName} must be an integer between ${MIN_PORT} and ${MAX_PORT}.`,
    );
  }

  return candidate;
}

export function readRequiredSecret(
  value: string | undefined,
  variableName: string,
  minimumBytes = 1,
): string {
  if (!value || Buffer.byteLength(value, "utf8") < minimumBytes) {
    throw new Error(
      `${variableName} must contain at least ${minimumBytes} bytes.`,
    );
  }
  return value;
}

export function readBase64Key(
  value: string | undefined,
  variableName: string,
): Uint8Array {
  const encoded = readRequiredSecret(value, variableName);
  const normalized = encoded.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error(`${variableName} must contain a base64-encoded 32-byte key.`);
  }
  const decoded = Buffer.from(normalized, "base64");
  const canonicalInput = normalized.replace(/=+$/, "");
  const canonicalDecoded = decoded.toString("base64").replace(/=+$/, "");
  if (decoded.byteLength !== 32 || canonicalDecoded !== canonicalInput) {
    throw new Error(`${variableName} must contain a base64-encoded 32-byte key.`);
  }
  return decoded;
}

export interface SourceAdministrationSettings {
  /** Key encrypting stored source-connection configuration. */
  readonly connectionConfigurationKey: Uint8Array;
  /** Active encryption revision for that key. */
  readonly connectionConfigurationKeyVersion: number;
}

/**
 * Reads the source-administration key pair.
 *
 * Both values absent is a supported deployment shape: source administration
 * stays unconfigured and its routes answer with a stable error instead of
 * stopping the admin. Setting only one of the pair is a misconfiguration
 * rather than a decision, so it still fails startup, as does an invalid value.
 */
export function readSourceAdministrationSettings(input: {
  key: string | undefined;
  keyVersion: string | undefined;
}): SourceAdministrationSettings | null {
  if (!input.key?.trim() && !input.keyVersion?.trim()) return null;
  return {
    connectionConfigurationKey: readBase64Key(
      input.key,
      "PACKSCOUT_SOURCE_CONNECTION_KEY_BASE64",
    ),
    connectionConfigurationKeyVersion: readPositiveInteger(
      input.keyVersion,
      "PACKSCOUT_SOURCE_CONNECTION_KEY_VERSION",
    ),
  };
}

/** Shortest accepted product-backend integration secret. */
const MINIMUM_DIRECTORY_TOKEN_LENGTH = 32;

export interface ProductUserDirectoryConfig {
  /** Origin of the product backend's server-to-server admin surface. */
  readonly baseUrl: string;
  /** Bearer secret for that surface. Server-side only, never serialized. */
  readonly token: string;
}

/**
 * Development origins that may be reached over cleartext. A request to any of
 * these never leaves the machine, so it cannot be observed on a network.
 */
const CLEARTEXT_DIRECTORY_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function isLoopbackDevelopmentOrigin(parsed: URL): boolean {
  return CLEARTEXT_DIRECTORY_HOSTS.has(parsed.hostname.toLowerCase());
}

/**
 * Reads the product-user directory integration configuration.
 *
 * Unlike the admin's own secrets, this pair is deliberately optional and never
 * throws: the admin must stay operable for every pipeline workflow when the
 * product-backend integration is absent or mis-set. An unusable pair yields
 * `null`, and the directory route degrades to a bounded "unconfigured" state
 * instead of taking the service down. The token is only ever compared and
 * forwarded as a header; it is never returned in an error message.
 *
 * A remote origin must be HTTPS. Every call on this integration carries the
 * bearer secret, and subject keys and search terms besides, so a mistyped
 * `http://` origin would put a credential and personal data on the wire in
 * cleartext. Only an explicit loopback origin — the local product backend a
 * developer runs — is allowed to be cleartext, because it never reaches a
 * network. Anything else yields `null` and the directory reads as unconfigured
 * rather than silently disclosing.
 */
export function readProductUserDirectoryConfig(input: {
  baseUrl: string | undefined;
  token: string | undefined;
}): ProductUserDirectoryConfig | null {
  const token = input.token?.trim() ?? "";
  const candidate = input.baseUrl?.trim() ?? "";
  if (token.length < MINIMUM_DIRECTORY_TOKEN_LENGTH || candidate.length === 0) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol === "https:") return { baseUrl: parsed.origin, token };
  if (parsed.protocol === "http:" && isLoopbackDevelopmentOrigin(parsed)) {
    return { baseUrl: parsed.origin, token };
  }
  return null;
}

export function readPositiveDuration(
  value: string | undefined,
  fallbackMs: number,
  variableName: string,
): number {
  const candidate = value === undefined ? fallbackMs : Number(value);
  if (!Number.isSafeInteger(candidate) || candidate <= 0) {
    throw new Error(`${variableName} must be a positive integer in milliseconds.`);
  }
  return candidate;
}

export function readPositiveInteger(
  value: string | undefined,
  variableName: string,
): number {
  if (!value || !/^[1-9][0-9]*$/u.test(value)) {
    throw new Error(`${variableName} must be a positive integer.`);
  }
  const candidate = Number(value);
  if (!Number.isSafeInteger(candidate) || candidate > 2_147_483_647) {
    throw new Error(`${variableName} must be a positive integer.`);
  }
  return candidate;
}

/**
 * A bounded whole-number setting, such as a queue-depth alert threshold. The
 * upper bound keeps a mistyped value from disabling a condition outright.
 */
export function readPositiveCount(
  value: string | undefined,
  fallback: number,
  variableName: string,
  maximum = 1_000_000,
): number {
  const candidate = value === undefined ? fallback : Number(value);
  if (
    !Number.isSafeInteger(candidate) ||
    candidate <= 0 ||
    candidate > maximum
  ) {
    throw new Error(
      `${variableName} must be an integer between 1 and ${maximum}.`,
    );
  }
  return candidate;
}

export function readAllowedOrigins(
  value: string | undefined,
  fallback: readonly string[],
  variableName: string,
): string[] {
  const candidates = value?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [
    ...fallback,
  ];
  if (candidates.length === 0) {
    throw new Error(`${variableName} must contain at least one origin.`);
  }
  try {
    return [...new Set(candidates.map((candidate) => new URL(candidate).origin))];
  } catch {
    throw new Error(`${variableName} must contain valid comma-separated origins.`);
  }
}

export function readTrustedProxies(
  value: string | undefined,
  variableName: string,
): string[] {
  if (!value?.trim()) return [];

  const candidates = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  const invalidMessage =
    `${variableName} must contain comma-separated IP addresses or CIDR ranges; ` +
    "trust-all ranges are not allowed.";
  const normalized = candidates.map((candidate) => {
    const parts = candidate.split("/");
    if (parts.length > 2) throw new Error(invalidMessage);

    const address = parts[0] ?? "";
    const family = isIP(address);
    if (family === 0) throw new Error(invalidMessage);

    const prefixValue = parts[1];
    if (prefixValue === undefined) return address;
    if (!/^\d+$/.test(prefixValue)) throw new Error(invalidMessage);

    const prefix = Number(prefixValue);
    const maximumPrefix = family === 4 ? 32 : 128;
    if (prefix < 1 || prefix > maximumPrefix) {
      throw new Error(invalidMessage);
    }
    return `${address}/${prefix}`;
  });

  if (normalized.length === 0) throw new Error(invalidMessage);
  return [...new Set(normalized)];
}

/**
 * The deployment the admin reads promotion state for.
 *
 * Promotion lanes and manifest selections are keyed by deployment, so the admin
 * must name the same deployment its workers promote into or it would read
 * another deployment's lane as this one's. The pattern matches the worker's own
 * validation; an unset or malformed value yields null, and the comparison
 * surface then reports itself unconfigured rather than reading a wrong lane.
 */
const catalogDeploymentKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;

export function readCatalogDeploymentKey(
  environment: NodeJS.ProcessEnv,
): string | null {
  const value = environment.PACKSCOUT_CATALOG_DEPLOYMENT_KEY?.trim();
  if (!value || !catalogDeploymentKeyPattern.test(value)) return null;
  return value;
}
