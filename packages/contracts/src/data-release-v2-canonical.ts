const HASH_DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{0,127})$/u;

export const DATA_RELEASE_BATCH_HASH_DOMAIN =
  "packscout.data-release.batch.v2" as const;
export const REPACK_SEARCH_SHARD_HASH_DOMAIN =
  "packscout.data-release.repack-search-shard.v2" as const;
export const REPACK_SEARCH_INDEX_HASH_DOMAIN =
  "packscout.data-release.repack-search-index.v2" as const;
export const PRODUCTION_BATCH_CHAIN_HASH_DOMAIN =
  "packscout.data-release.batch-chain.v2" as const;
export const PRODUCTION_MANIFEST_HASH_DOMAIN =
  "packscout.data-release.manifest.v2" as const;
export const PRODUCTION_ORIGIN_SET_HASH_DOMAIN =
  "packscout.data-release.origin-set.v2" as const;
export const PRODUCTION_RECEIPT_HASH_DOMAIN =
  "packscout.data-release.receipt.v2" as const;
export const EMPTY_BATCH_CHAIN_HASH = "0".repeat(64);

/** Recursively sorts object keys while retaining governed array order. */
export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();
  const serialize = (candidate: unknown): string => {
    if (candidate === null) return "null";
    if (typeof candidate === "string" || typeof candidate === "boolean") {
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
      return `{${Object.keys(record).sort().map((key) =>
        `${JSON.stringify(key)}:${serialize(record[key])}`
      ).join(",")}}`;
    } finally {
      ancestors.delete(candidate);
    }
  };
  return serialize(value);
}

export function canonicalJsonByteCount(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

export async function sha256CanonicalJson(
  domain: string,
  value: unknown,
): Promise<string> {
  if (!HASH_DOMAIN_PATTERN.test(domain)) {
    throw new TypeError("Canonical hash domain is invalid.");
  }
  const bytes = new TextEncoder().encode(canonicalJson({ domain, value }));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
