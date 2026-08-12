const HASH_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/u;

/**
 * Serialize JSON data with recursively sorted object keys. Arrays retain their
 * order because order is part of their governed value.
 */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();

  const serialize = (candidate: unknown): string => {
    if (candidate === null) return "null";
    if (
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return JSON.stringify(candidate);
    }
    if (typeof candidate === "number") {
      if (!Number.isFinite(candidate)) {
        throw new TypeError("Canonical JSON cannot contain non-finite numbers.");
      }
      return JSON.stringify(candidate);
    }
    if (typeof candidate !== "object") {
      throw new TypeError(`Canonical JSON cannot contain ${typeof candidate}.`);
    }
    if (ancestors.has(candidate)) {
      throw new TypeError("Canonical JSON cannot contain cycles.");
    }
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return `[${candidate.map(serialize).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Canonical JSON accepts only plain objects.");
      }
      const record = candidate as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${serialize(record[key])}`)
        .join(",")}}`;
    } finally {
      ancestors.delete(candidate);
    }
  };

  return serialize(value);
}

/** Hash one explicitly scoped canonical JSON value with SHA-256. */
export async function sha256CanonicalJson(
  domain: string,
  value: unknown,
): Promise<string> {
  if (!HASH_DOMAIN_PATTERN.test(domain)) {
    throw new TypeError("Canonical hash domain is invalid.");
  }
  const bytes = new TextEncoder().encode(
    canonicalJson({ domain, value }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
