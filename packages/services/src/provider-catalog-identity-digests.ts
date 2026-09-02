import { createHash } from "node:crypto";
import { canonicalJson } from "@packscout/contracts";

const sha256Pattern = /^[a-f0-9]{64}$/u;

function sha256(value: string): string {
  if (!sha256Pattern.test(value)) {
    throw new TypeError("Catalog identity digest is invalid.");
  }
  return value;
}

function catalogIdentityDigest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`packscout.provider-catalog-${domain}.v1\u0000`)
    .update(canonicalJson(value))
    .digest("hex");
}

/** Hashes the exact normalized source scope and provider identity; raw IDs never leave the worker. */
export function providerCatalogSourceIdentityDigest(input: Readonly<{
  recordIdScopeKey: "catalog-card-v1" | "catalog-pack-v1";
  providerRecordId: string;
}>): string {
  const providerRecordId = input.providerRecordId.trim();
  if (providerRecordId.length < 1 || providerRecordId.length > 4_096) {
    throw new TypeError("Catalog source identity is invalid.");
  }
  return catalogIdentityDigest("source-identity", [
    input.recordIdScopeKey,
    providerRecordId,
  ]);
}

/** Order-independent digest of one bounded identity multiset, including duplicates. */
export function providerCatalogIdentityMultisetDigest(
  identityDigests: readonly string[],
): string {
  const parsed = identityDigests.map(sha256).sort();
  return catalogIdentityDigest("identity-multiset", parsed);
}

/** Final cumulative multiset digest. Sorting happens once at head and retains only unique keys. */
export function providerCatalogIdentityCountMapDigest(
  identityCounts: ReadonlyMap<string, number>,
): string {
  const keys = [...identityCounts.keys()].map(sha256).sort();
  const digest = createHash("sha256")
    .update("packscout.provider-catalog-identity-count-map.v1\u0000")
    .update(`${keys.length}\n`);
  for (const key of keys) {
    const count = identityCounts.get(key);
    if (count === undefined || !Number.isSafeInteger(count) || count < 1) {
      throw new TypeError("Catalog identity occurrence count is invalid.");
    }
    digest.update(canonicalJson([key, count])).update("\n");
  }
  return digest.digest("hex");
}

/** Ordered chain binding each translated response to its page identity multiset. */
export function providerCatalogIdentityChainDigest(input: Readonly<{
  previousChainDigest: string | null;
  pageNumber: number;
  pageResponseDigest: string;
  pageIdentityMultisetDigest: string;
}>): string {
  if (!Number.isSafeInteger(input.pageNumber) || input.pageNumber < 1) {
    throw new TypeError("Catalog census page number is invalid.");
  }
  return catalogIdentityDigest("identity-page-chain", {
    previousChainDigest: input.previousChainDigest === null
      ? null
      : sha256(input.previousChainDigest),
    pageNumber: input.pageNumber,
    pageResponseDigest: sha256(input.pageResponseDigest),
    pageIdentityMultisetDigest: sha256(input.pageIdentityMultisetDigest),
  });
}
