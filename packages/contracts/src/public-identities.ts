import { v5 as uuidV5 } from "uuid";

/**
 * Derived once from the URL-namespace name
 * `https://packscout.app/public-identities/v1` and frozen for public IDs.
 */
export const PACKSCOUT_PUBLIC_IDENTITY_NAMESPACE =
  "a35fca42-e6b2-54be-8425-c662e41b8543" as const;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizedUuid(value: string, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

export function packscoutPublicIdentityUuid(name: string): string {
  if (typeof name !== "string" || name.length === 0 || name.length > 512) {
    throw new TypeError("Public identity name is invalid.");
  }
  return uuidV5(name, PACKSCOUT_PUBLIC_IDENTITY_NAMESPACE);
}

export function provisionalCollectiblePublicIdentityName(input: {
  readonly providerId: string;
  readonly localCollectibleId: string;
}): string {
  return `provider:${normalizedUuid(input.providerId, "providerId")}`
    + `:collectible:${normalizedUuid(input.localCollectibleId, "localCollectibleId")}`;
}

export function provisionalCollectiblePublicId(input: {
  readonly providerId: string;
  readonly localCollectibleId: string;
}): string {
  return packscoutPublicIdentityUuid(
    provisionalCollectiblePublicIdentityName(input),
  );
}

export function globalCategoryPublicId(globalCategoryId: string): string {
  return packscoutPublicIdentityUuid(
    `global-category:${normalizedUuid(globalCategoryId, "globalCategoryId")}`,
  );
}
