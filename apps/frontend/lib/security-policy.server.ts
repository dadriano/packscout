import { createHash, randomBytes } from "node:crypto";

export type SecurityPolicyEnvironment = "development" | "production";

export type PublicSecurityConfiguration = Readonly<{
  environment: SecurityPolicyEnvironment;
  convexHttpOrigin: string | null;
  convexWebSocketOrigin: string | null;
  imageOrigins: readonly string[];
  imageOriginSetHash: string;
  privyAuthenticationEnabled: boolean;
}>;

type SecurityEnvironment = Readonly<{
  NODE_ENV?: string;
  NEXT_PUBLIC_CONVEX_URL?: string;
  NEXT_PUBLIC_PRIVY_APP_ID?: string;
  PACKSCOUT_PUBLIC_IMAGE_ORIGINS?: string;
  PACKSCOUT_PUBLIC_ORIGIN_SET_HASH?: string;
}>;

type ConvexSecurityEnvironment = Pick<
  SecurityEnvironment,
  "NODE_ENV" | "NEXT_PUBLIC_CONVEX_URL"
>;

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CONVEX_HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.convex\.cloud$/;
const NONCE_PATTERN = /^[A-Za-z0-9+/_=-]{16,128}$/;
const PRIVY_APP_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const PRIVY_AUTH_ORIGIN = "https://auth.privy.io";
const PRIVY_TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";

function configuredValue(value: string | undefined): string | null {
  if (value === undefined || value === "") return null;
  if (value !== value.trim()) {
    throw new Error("Public security configuration contains outer whitespace.");
  }
  return value;
}

function exactOrigin(value: string, protocol: "http:" | "https:"): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Public security configuration contains an invalid URL.");
  }
  const canonicalInput = value.endsWith("/") ? value.slice(0, -1) : value;
  if (
    value.includes("*") ||
    parsed.protocol !== protocol ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.origin !== canonicalInput
  ) {
    throw new Error("Public security configuration must contain exact origins.");
  }
  return parsed;
}

function parseConvexOrigins(
  value: string | null,
  environment: SecurityPolicyEnvironment,
): Pick<
  PublicSecurityConfiguration,
  "convexHttpOrigin" | "convexWebSocketOrigin"
> {
  if (value === null) {
    return { convexHttpOrigin: null, convexWebSocketOrigin: null };
  }
  const parsedUrl = (() => {
    try {
      return new URL(value);
    } catch {
      throw new Error("Public security configuration contains an invalid URL.");
    }
  })();
  if (parsedUrl.protocol === "https:") {
    const parsed = exactOrigin(value, "https:");
    if (parsed.port !== "" || !CONVEX_HOST_PATTERN.test(parsed.hostname)) {
      throw new Error(
        `${environment === "production" ? "Production" : "Development"} Convex URL must be one exact cloud deployment origin.`,
      );
    }
    return {
      convexHttpOrigin: parsed.origin,
      convexWebSocketOrigin: `wss://${parsed.host}`,
    };
  }

  const parsed = exactOrigin(value, "http:");
  if (environment === "production") {
    throw new Error("Production Convex URL must use HTTPS.");
  }
  if (
    (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") ||
    parsed.port === ""
  ) {
    throw new Error(
      "Development Convex URL must be an exact loopback origin with a port.",
    );
  }
  return {
    convexHttpOrigin: parsed.origin,
    convexWebSocketOrigin: `ws://${parsed.host}`,
  };
}

export function readPublicConvexOrigin(
  environment: ConvexSecurityEnvironment = process.env,
): string | null {
  const mode = resolveEnvironment(environment.NODE_ENV);
  const value = configuredValue(environment.NEXT_PUBLIC_CONVEX_URL);
  return parseConvexOrigins(value, mode).convexHttpOrigin;
}

function parseImageOrigins(value: string | null): readonly string[] {
  if (value === null) return Object.freeze([]);
  const entries = value.split(",");
  if (entries.length > 64 || entries.some((entry) => entry.trim() === "")) {
    throw new Error(
      "Public image origins must be a bounded comma-separated set.",
    );
  }
  const origins = entries.map(
    (entry) => exactOrigin(entry.trim(), "https:").origin,
  );
  const unique = new Set(origins);
  if (unique.size !== origins.length) {
    throw new Error("Public image origins must be unique.");
  }
  return Object.freeze([...unique].sort());
}

function parsePrivyAuthenticationEnabled(value: string | null): boolean {
  if (value === null) return false;
  if (!PRIVY_APP_ID_PATTERN.test(value)) {
    throw new Error(
      "Privy app ID must be a bounded 8-128 character public identifier.",
    );
  }
  return true;
}

export function hashImageOriginSet(origins: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify([...origins].sort()))
    .digest("hex");
}

function resolveEnvironment(nodeEnvironment: string | undefined) {
  return nodeEnvironment === "production" ? "production" : "development";
}

export function readPublicSecurityConfiguration(
  environment: SecurityEnvironment = process.env,
): PublicSecurityConfiguration {
  const mode = resolveEnvironment(environment.NODE_ENV);
  const convexValue = configuredValue(environment.NEXT_PUBLIC_CONVEX_URL);
  const imageValue = configuredValue(
    environment.PACKSCOUT_PUBLIC_IMAGE_ORIGINS,
  );
  const expectedHash = configuredValue(
    environment.PACKSCOUT_PUBLIC_ORIGIN_SET_HASH,
  );
  const privyAppId = configuredValue(environment.NEXT_PUBLIC_PRIVY_APP_ID);
  const convex = parseConvexOrigins(convexValue, mode);
  const imageOrigins = parseImageOrigins(imageValue);
  const imageOriginSetHash = hashImageOriginSet(imageOrigins);
  const privyAuthenticationEnabled =
    parsePrivyAuthenticationEnabled(privyAppId);

  const hasProductionConfiguration =
    convexValue !== null || imageValue !== null || expectedHash !== null;
  if (
    mode === "production" &&
    hasProductionConfiguration &&
    convexValue === null
  ) {
    throw new Error(
      "Configured production catalog access requires an exact Convex origin.",
    );
  }

  if (expectedHash !== null) {
    if (
      !SHA256_PATTERN.test(expectedHash) ||
      expectedHash !== imageOriginSetHash
    ) {
      throw new Error("Public image origin-set hash does not match its origins.");
    }
  } else if (
    mode === "production" &&
    (convexValue !== null || imageValue !== null)
  ) {
    throw new Error(
      "Configured production catalog access requires an image origin-set hash.",
    );
  }

  return Object.freeze({
    environment: mode,
    ...convex,
    imageOrigins,
    imageOriginSetHash,
    privyAuthenticationEnabled,
  });
}

export function createCspNonce(): string {
  return randomBytes(18).toString("base64");
}

export function buildContentSecurityPolicy(input: Readonly<{
  nonce: string;
  configuration: PublicSecurityConfiguration;
}>): string {
  if (!NONCE_PATTERN.test(input.nonce)) {
    throw new Error("CSP nonce is invalid.");
  }
  const connectSources = [
    "'self'",
    input.configuration.convexHttpOrigin,
    input.configuration.convexWebSocketOrigin,
    ...(input.configuration.privyAuthenticationEnabled
      ? [PRIVY_AUTH_ORIGIN]
      : []),
  ].filter((source): source is string => source !== null);
  const scriptSources = [
    "'self'",
    `'nonce-${input.nonce}'`,
    "'strict-dynamic'",
    ...(input.configuration.environment === "development"
      ? ["'unsafe-eval'"]
      : []),
    ...(input.configuration.privyAuthenticationEnabled
      ? [PRIVY_TURNSTILE_ORIGIN]
      : []),
  ];
  const directives = [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${
      input.configuration.imageOrigins.length === 0
        ? ""
        : ` ${input.configuration.imageOrigins.join(" ")}`
    }`,
    "font-src 'self' data:",
    `connect-src ${connectSources.join(" ")}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (input.configuration.privyAuthenticationEnabled) {
    directives.push(
      `child-src 'self' ${PRIVY_AUTH_ORIGIN}`,
      `frame-src 'self' ${PRIVY_AUTH_ORIGIN} ${PRIVY_TURNSTILE_ORIGIN}`,
    );
  }
  return directives.join("; ");
}
