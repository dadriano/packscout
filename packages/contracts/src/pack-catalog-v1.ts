import { z } from "zod";
import { containsNormalizedProtectedPublicationField } from "./protected-publication-fields.ts";

export const PACK_CATALOG_V1 = "pack_catalog_v1" as const;
export const PACK_SNAPSHOT_HASH_DOMAIN =
  "packscout.public-pack-snapshot.v1" as const;
export const PROFILE_SNAPSHOT_HASH_DOMAIN =
  "packscout.public-profile-snapshot.v1" as const;

export const PACK_SNAPSHOT_BATCH_MAX_ITEMS = 250 as const;
export const PACK_SNAPSHOT_BATCH_MAX_BYTES = 480_000 as const;
export const PACK_SNAPSHOT_MAX_CONTENTS = 8_000 as const;
export const PACK_CATALOG_LIST_MAX_ITEMS = 50 as const;
export const PACK_CONTENT_PAGE_MAX_ITEMS = 100 as const;
export const PACK_CATALOG_CURSOR_LIFETIME_MS = 15 * 60 * 1_000;
export const PACK_PUBLICATION_REPLAY_LIFETIME_MS = 30 * 24 * 60 * 60 * 1_000;
export const SAVED_CATALOG_ITEM_LIMIT = 250 as const;

export const packCatalogSha256Schema = z.string().regex(/^[0-9a-f]{64}$/u);
export const packCatalogUuidSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
export const packCatalogTimestampSchema = z.iso.datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
export const packCatalogSequenceSchema = z.string().regex(/^[1-9][0-9]{0,29}$/u);

export function packCatalogTextSchema(maximum: number) {
  return z.string().trim().min(1).max(maximum)
    .transform((value) => value.normalize("NFC"));
}

export function normalizePackCatalogSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("en-US").replace(/\s+/gu, " ");
}

function serializeCanonical(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    if (value !== value.normalize("NFC")) {
      throw new TypeError("Canonical JSON strings must use NFC normalization.");
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new TypeError("Canonical JSON numbers must be safe integers.");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`Canonical JSON cannot contain ${typeof value}.`);
  }
  if (ancestors.has(value)) throw new TypeError("Canonical JSON cannot contain cycles.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => serializeCanonical(entry, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical JSON accepts only plain objects.");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort(compareCanonicalStrings).map((key) =>
      `${JSON.stringify(key)}:${serializeCanonical(record[key], ancestors)}`
    ).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function packCatalogCanonicalJson(value: unknown): string {
  return serializeCanonical(value, new Set());
}

export function packCatalogCanonicalByteCount(value: unknown): number {
  return new TextEncoder().encode(packCatalogCanonicalJson(value)).byteLength;
}

export function assertPublicPackCatalogBytes(value: unknown): void {
  if (containsNormalizedProtectedPublicationField(value, new Set())) {
    throw new TypeError("Public pack catalog bytes contain a protected field.");
  }
  packCatalogCanonicalJson(value);
}

export async function hashPackCatalogValue(
  domain: string,
  value: unknown,
): Promise<string> {
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,127})$/u.test(domain)) {
    throw new TypeError("Pack catalog hash domain is invalid.");
  }
  const bytes = new TextEncoder().encode(
    packCatalogCanonicalJson({ domain, value }),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function derivePublicPackSnapshotId(contentSha256: string): string {
  return `pps_${packCatalogSha256Schema.parse(contentSha256)}`;
}

export function derivePublicProfileSnapshotId(contentSha256: string): string {
  return `ppfs_${packCatalogSha256Schema.parse(contentSha256)}`;
}

export function compareCanonicalStrings(left: string, right: string): number {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

export function isCanonicalAscending(
  values: readonly string[],
): boolean {
  return values.every((value, index) =>
    index === 0 || compareCanonicalStrings(values[index - 1]!, value) < 0
  );
}
