import { createHash, createHmac } from "node:crypto";
import { PersistenceError } from "./persistence-error.ts";

type JsonScalar = boolean | number | string | null;
type CanonicalJson = JsonScalar | CanonicalJson[] | { [key: string]: CanonicalJson };

function normalizeJson(value: unknown, path = "$", seen = new Set<object>()): CanonicalJson {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object") throw new TypeError(`Value at ${path} is not JSON serializable.`);
  if (seen.has(value)) throw new TypeError(`Value at ${path} contains a circular reference.`);

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item, index) => normalizeJson(item, `${path}[${index}]`, seen));
    }
    const result: Record<string, CanonicalJson> = {};
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) throw new TypeError(`Value at ${path}.${key} is undefined.`);
      result[key] = normalizeJson(child, `${path}.${key}`, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(normalizeJson(value))).digest("hex");
}

const prohibitedActorKeys = new Set([
  "actoraddress",
  "actorusername",
  "ownerwallet",
  "sourceusername",
  "sourcewallet",
  "username",
  "wallet",
  "walletaddress",
]);

export function assertCanonicalActorDataSafe(value: unknown, path = "$", seen = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertCanonicalActorDataSafe(item, `${path}[${index}]`, seen));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
      if (prohibitedActorKeys.has(normalizedKey)) {
        throw new PersistenceError(
          "UNSAFE_CANONICAL_ACTOR_DATA",
          `Canonical content contains prohibited source actor data at ${path}.${key}.`,
        );
      }
      assertCanonicalActorDataSafe(child, `${path}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

export function pseudonymizeProviderActor(input: {
  key: Uint8Array | string;
  platformKey: string;
  sourceIdentifier: string;
}): string {
  if (input.sourceIdentifier.trim().length === 0) {
    throw new TypeError("Source actor identifier must not be blank.");
  }
  return `actor:v1:${createHmac("sha256", input.key)
    .update(`${input.platformKey}\u0000${input.sourceIdentifier}`)
    .digest("hex")}`;
}

const safeAuditMetadataKeys = new Set(["fields", "reason", "role"]);

export function sanitizeAuthAuditMetadata(
  metadata: Readonly<Record<string, string | boolean | readonly string[]>>,
): Record<string, string | boolean | readonly string[]> {
  const sanitized: Record<string, string | boolean | readonly string[]> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!safeAuditMetadataKeys.has(key)) {
      throw new PersistenceError(
        "UNSAFE_AUDIT_METADATA",
        `Audit metadata field ${key} is not allowlisted.`,
      );
    }
    sanitized[key] = Array.isArray(value) ? [...value] : value;
  }
  return sanitized;
}
