import { createHash } from "node:crypto";
import { parseClutchpacksPackMembershipV1, type ClutchpacksPackMembershipV1 } from "@packscout/contracts";
import {
  captureHardenedProviderResponse, type HardenedProviderRequestDependencies,
} from "../../hardened-provider-request.ts";

export const CLUTCHPACKS_PUBLIC_MEMBERSHIP_ADAPTER_VERSION_V1 = "clutchpacks-public-pack-membership-v1" as const;
export const MAX_CLUTCHPACKS_PUBLIC_MEMBERSHIP_PACKS_V1 = 100;
export const MAX_CLUTCHPACKS_PUBLIC_MEMBERSHIP_RESPONSE_BYTES_V1 = 2 * 1_024 * 1_024;
export const MAX_CLUTCHPACKS_PUBLIC_MEMBERSHIP_CAPTURE_BYTES_V1 = 32 * 1_024 * 1_024;
export const CLUTCHPACKS_PUBLIC_MEMBERSHIP_TIMEOUT_MS_V1 = 20_000;
const publicHost = "api.clutchpacks.io";
const nativeIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export interface ClutchpacksPublicPackMembershipSnapshotV1 extends ClutchpacksPackMembershipV1 {
  readonly providerRecordId: string;
  readonly sourceAdapterVersion: typeof CLUTCHPACKS_PUBLIC_MEMBERSHIP_ADAPTER_VERSION_V1;
  readonly sourceUrl: string;
  readonly observedAt: string;
  readonly timeBasis: "response_observed_at";
  readonly sourceUpdatedAt: null;
  readonly sourceRevision: null;
  readonly responseSha256: string;
  readonly responseBytes: number;
  readonly availability: NonNullable<ClutchpacksPackMembershipV1["availability"]>;
}

export interface ClutchpacksPublicPackMembershipSourceDependenciesV1 {
  readonly capture?: typeof captureHardenedProviderResponse;
  readonly requestDependencies?: HardenedProviderRequestDependencies;
  readonly now?: () => number;
}

function refuse(code: "invalid_scope" | "invalid_response" | "identity_mismatch" | "capture_too_large"): never {
  throw new Error(`clutchpacks_public_pack_membership.${code}`);
}

/**
 * One unauthenticated, DNS-pinned request per explicit pack. No retries, paging,
 * event cursor, credentials, database writes, or inferred source timestamps.
 * A partial preview can display featured cards but cannot retire absent members.
 */
export async function captureClutchpacksPublicPackMembershipV1(input: {
  readonly nativePackIds: readonly string[];
  readonly signal?: AbortSignal;
}, dependencies: ClutchpacksPublicPackMembershipSourceDependenciesV1 = {}): Promise<readonly ClutchpacksPublicPackMembershipSnapshotV1[]> {
  if (input.nativePackIds.length === 0 || input.nativePackIds.length > MAX_CLUTCHPACKS_PUBLIC_MEMBERSHIP_PACKS_V1 ||
      input.nativePackIds.some((id) => !nativeIdPattern.test(id)) ||
      new Set(input.nativePackIds).size !== input.nativePackIds.length) return refuse("invalid_scope");
  const capture = dependencies.capture ?? captureHardenedProviderResponse;
  const now = dependencies.now ?? Date.now;
  const signal = input.signal ?? new AbortController().signal;
  const snapshots: ClutchpacksPublicPackMembershipSnapshotV1[] = [];
  let responseBytesTotal = 0;
  for (const providerRecordId of input.nativePackIds) {
    const url = new URL(`https://${publicHost}/v1/collections/${providerRecordId}`);
    const response = await capture({ url, allowedHosts: [publicHost],
      headers: { Accept: "application/json", "User-Agent": "PackScout/1.0 public-catalog-reader" },
      timeoutMilliseconds: CLUTCHPACKS_PUBLIC_MEMBERSHIP_TIMEOUT_MS_V1,
      maximumResponseBytes: MAX_CLUTCHPACKS_PUBLIC_MEMBERSHIP_RESPONSE_BYTES_V1, signal,
    }, dependencies.requestDependencies);
    try {
      responseBytesTotal += response.protectedBody.byteLength;
      if (responseBytesTotal > MAX_CLUTCHPACKS_PUBLIC_MEMBERSHIP_CAPTURE_BYTES_V1) return refuse("capture_too_large");
      const observedMillis = now();
      if (!Number.isSafeInteger(observedMillis) || observedMillis < 0 || observedMillis > 8.64e15) return refuse("invalid_response");
      let parsed: ClutchpacksPackMembershipV1 | null;
      try {
        const native: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.protectedBody));
        parsed = parseClutchpacksPackMembershipV1(native);
      } catch { return refuse("invalid_response"); }
      if (parsed === null || parsed.availability === null) return refuse("invalid_response");
      if (parsed.providerRecordId !== providerRecordId) return refuse("identity_mismatch");
      snapshots.push({ ...parsed, providerRecordId, availability: parsed.availability,
        sourceAdapterVersion: CLUTCHPACKS_PUBLIC_MEMBERSHIP_ADAPTER_VERSION_V1,
        sourceUrl: url.toString(), observedAt: new Date(observedMillis).toISOString(),
        timeBasis: "response_observed_at", sourceUpdatedAt: null, sourceRevision: null,
        responseSha256: createHash("sha256").update(response.protectedBody).digest("hex"),
        responseBytes: response.protectedBody.byteLength,
      });
    } finally { response.protectedBody.fill(0); }
  }
  return snapshots;
}
