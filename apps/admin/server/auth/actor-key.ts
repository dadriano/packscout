import { createHmac } from "node:crypto";
import type { ProviderActorKeyer } from "@packscout/services";

/**
 * Pseudonymous operator identity for audit records. Operator identifiers never
 * reach durable pipeline history directly; they are keyed through the
 * workspace's actor secret so audit trails stay linkable without carrying an
 * account identity.
 */
export function createProviderActorKeyer(key: Uint8Array): ProviderActorKeyer {
  const secret = Buffer.from(key);
  if (secret.byteLength < 32) {
    throw new Error("Provider actor key must be at least 32 bytes.");
  }
  return {
    keyFor({ organizationId, operatorId }) {
      return `actor:v1:${createHmac("sha256", secret)
        .update(
          `packscout-provider-request:v1\u0000${organizationId}\u0000${operatorId}`,
        )
        .digest("hex")}`;
    },
  };
}

/**
 * Stable, non-reversible handle for a provider-scoped record identity. Keyed
 * with the same workspace secret so the admin can correlate rows without
 * exporting provider external identifiers to the browser.
 */
export function createRecordReferencer(
  key: Uint8Array,
  prefix: string,
): (parts: readonly string[]) => string {
  const secret = Buffer.from(key);
  if (secret.byteLength < 32) {
    throw new Error("Provider actor key must be at least 32 bytes.");
  }
  return (parts) =>
    `${prefix}:${createHmac("sha256", secret)
      .update(`packscout-record-reference:v1\u0000${parts.join("\u0000")}`)
      .digest("hex")
      .slice(0, 12)}`;
}
