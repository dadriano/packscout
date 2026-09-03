/**
 * Prisma 6's native engine understands disable/prefer/require, not libpq's
 * verify-full. Unknown modes otherwise silently become prefer, and certificate
 * acceptance defaults to accept_invalid_certs. Keep policy-level verify-full
 * outside this boundary; encode its strict native equivalent only for Prisma.
 */
export function normalizeNativePrismaTlsUrl(databaseUrl: URL): URL {
  const normalized = new URL(databaseUrl);
  for (const parameter of ["sslmode", "sslaccept", "sslcert"]) {
    if (normalized.searchParams.getAll(parameter).length > 1) {
      throw new TypeError("Native Prisma TLS parameters must be unambiguous.");
    }
  }
  if (normalized.searchParams.has("sslrootcert")) {
    throw new TypeError("Native Prisma TLS requires sslcert instead of sslrootcert.");
  }
  const mode = normalized.searchParams.get("sslmode");
  const acceptance = normalized.searchParams.get("sslaccept");
  if (
    acceptance !== null
    && acceptance !== "strict"
    && acceptance !== "accept_invalid_certs"
  ) {
    throw new TypeError("Native Prisma TLS certificate acceptance is invalid.");
  }
  if (mode === "verify-full") {
    if (acceptance === "accept_invalid_certs") {
      throw new TypeError("Verified TLS cannot accept invalid certificates.");
    }
    normalized.searchParams.set("sslmode", "require");
    normalized.searchParams.set("sslaccept", "strict");
  } else if (
    mode !== null
    && mode !== "disable"
    && mode !== "prefer"
    && mode !== "require"
  ) {
    // CA-only verification has no equivalent native Prisma setting. Reject it
    // (and every unknown mode) rather than silently changing its guarantees.
    throw new TypeError("Native Prisma TLS mode is unsupported.");
  }
  return normalized;
}
