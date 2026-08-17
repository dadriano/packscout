import {
  MAX_PROVIDER_RELEASE_PUBLICATION_BODY_BYTES,
  MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES,
  PRODUCTION_AUTH_KEY_ID_PATTERN,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  containsProtectedProviderReleasePublicationField,
  providerCatalogPlatformKeyV1Schema,
  type ProviderReleaseApplyBatchRequest,
  type ProviderReleaseBlockRequest,
  type ProviderReleaseConfirmReuseRequest,
  type ProviderReleaseFinalizeRequest,
  type ProviderReleaseStartRequest,
} from "@packscout/contracts";
import type { z } from "zod";
import type { Doc } from "./_generated/dataModel";
import { env, type MutationCtx } from "./_generated/server";
import { refuseProviderRelease } from "./providerReleaseErrors";
import {
  providerReleaseProofIsValid,
  providerReleaseProofMatches,
} from "./providerReleaseProof";
import {
  expectedHeadFromPublication,
  expectedHeadMatchesStored,
} from "./providerReleaseState";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;

export type ProviderReleaseContextRequest =
  | ProviderReleaseStartRequest
  | ProviderReleaseApplyBatchRequest
  | ProviderReleaseFinalizeRequest
  | ProviderReleaseConfirmReuseRequest
  | ProviderReleaseBlockRequest;

export function assertProviderRequestDigest(requestDigest: string): void {
  if (!SHA256_PATTERN.test(requestDigest)) {
    refuseProviderRelease("PROVIDER_RELEASE_REQUEST_INVALID");
  }
}

function providerPlatformForKey(keyId: string): string | null {
  if (!PRODUCTION_AUTH_KEY_ID_PATTERN.test(keyId)) return null;
  const value = configuredProviderReleasePlatformMap();
  if (value === null || !Object.prototype.hasOwnProperty.call(value, keyId)) {
    return null;
  }
  return value[keyId] ?? null;
}

function configuredProviderReleasePlatformMap():
  Readonly<Record<string, string>> | null {
  const raw = env.PACKSCOUT_PROVIDER_RELEASE_KEY_PLATFORMS;
  if (raw === undefined) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return null;
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([candidateKeyId, platformKey]) =>
      !PRODUCTION_AUTH_KEY_ID_PATTERN.test(candidateKeyId) ||
      !providerCatalogPlatformKeyV1Schema.safeParse(platformKey).success
    )) {
      return null;
    }
    return value as Record<string, string>;
  } catch {
    return null;
  }
}

export function configuredProviderReleasePlatforms(): readonly string[] | null {
  const value = configuredProviderReleasePlatformMap();
  if (value === null) return null;
  const platforms = [...new Set(Object.values(value))].sort();
  return platforms.length > 0 &&
      platforms.length <= MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES
    ? platforms
    : null;
}

export function assertProviderPlatformAuthority(
  authenticatedKeyId: string,
  platformKey: string,
): void {
  const authorizedPlatform = providerPlatformForKey(authenticatedKeyId);
  if (authorizedPlatform === null) {
    refuseProviderRelease("PROVIDER_RELEASE_AUTH_KEY_UNKNOWN");
  }
  if (authorizedPlatform !== platformKey) {
    refuseProviderRelease("PROVIDER_RELEASE_PLATFORM_MISMATCH");
  }
}

export function parseProviderReleaseRequest<T>(
  bodyJson: string,
  schema: z.ZodType<T>,
): T {
  if (
    new TextEncoder().encode(bodyJson).byteLength >
      MAX_PROVIDER_RELEASE_PUBLICATION_BODY_BYTES
  ) {
    refuseProviderRelease("PROVIDER_RELEASE_BODY_TOO_LARGE");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(bodyJson) as unknown;
  } catch {
    return refuseProviderRelease("PROVIDER_RELEASE_REQUEST_INVALID");
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    (raw as { schemaVersion?: unknown }).schemaVersion !==
      PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION
  ) {
    refuseProviderRelease("PROVIDER_RELEASE_SCHEMA_UNSUPPORTED");
  }
  if (containsProtectedProviderReleasePublicationField(raw)) {
    refuseProviderRelease("PROVIDER_RELEASE_PROTECTED_FIELD");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success || bodyJson !== canonicalJson(parsed.data)) {
    refuseProviderRelease("PROVIDER_RELEASE_REQUEST_INVALID");
  }
  return parsed.data;
}

export async function assertProviderReleaseProof(
  request: ProviderReleaseContextRequest,
): Promise<void> {
  if (request.release.platformKey !== request.expectedCompletedHead.platformKey) {
    refuseProviderRelease("PROVIDER_RELEASE_PLATFORM_MISMATCH");
  }
  if (!(await providerReleaseProofIsValid(request.release))) {
    refuseProviderRelease("PROVIDER_RELEASE_IDENTITY_MISMATCH");
  }
  const approvedOriginSetHash = env.PACKSCOUT_PUBLIC_ORIGIN_SET_HASH ?? "";
  if (
    !SHA256_PATTERN.test(approvedOriginSetHash) ||
    request.release.governingHashes.originSetHash !== approvedOriginSetHash
  ) {
    refuseProviderRelease("PROVIDER_RELEASE_HASH_MISMATCH");
  }
}

export async function assertProviderReleaseNotBlocked(
  ctx: MutationCtx,
  platformKey: string,
  providerReleaseFingerprint: string,
): Promise<void> {
  const blocks = await ctx.db
    .query("providerCatalogReleaseBlocks")
    .withIndex("by_platform_key_and_provider_release_fingerprint", (index) =>
      index
        .eq("platformKey", platformKey)
        .eq("providerReleaseFingerprint", providerReleaseFingerprint),
    )
    .take(2);
  if (blocks.length > 1) {
    refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
  }
  if (blocks.length === 1) {
    refuseProviderRelease("PROVIDER_RELEASE_FINGERPRINT_BLOCKED");
  }
}

export async function assertExpectedProviderHead(
  ctx: MutationCtx,
  request: ProviderReleaseContextRequest,
): Promise<void> {
  if (!(await expectedHeadMatchesStored(ctx, request.expectedCompletedHead))) {
    refuseProviderRelease("PROVIDER_RELEASE_PREDECESSOR_CONFLICT");
  }
}

export function providerRequestMatchesStaging(
  request: ProviderReleaseContextRequest,
  release: Doc<"providerCatalogReleases">,
  publication: Doc<"providerCatalogPublications">,
): boolean {
  return release._id === publication.releaseId &&
    release.lifecycle === "staging" &&
    publication.state === "staging" &&
    publication.platformKey === request.release.platformKey &&
    publication.publicProviderReleaseId ===
      request.release.publicProviderReleaseId &&
    providerReleaseProofMatches(release, request.release) &&
    publication.sourceWatermark === request.sourceWatermark &&
    canonicalJson(publication.providerCheckpoint) ===
      canonicalJson(request.providerCheckpoint) &&
    canonicalJson(publication.observation) ===
      canonicalJson(request.observation) &&
    canonicalJson(expectedHeadFromPublication(publication)) ===
      canonicalJson(request.expectedCompletedHead);
}
