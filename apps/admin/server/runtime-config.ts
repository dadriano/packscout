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
