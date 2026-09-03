import { createHash } from "node:crypto";
import type { SourceAdapterManifestV1 } from "@packscout/contracts";
import {
  captureHardenedProviderResponse,
  DataforrestEventsSourceAdapter,
  type DataforrestRawResponseInspectionResult,
  type HardenedProviderResponseCapture,
} from "@packscout/services";
import type { ResolvedDataforrestSourceAuthority } from
  "../../apps/worker/src/dataforrest-source-authority-resolver.ts";
import {
  CatalogBridgeError,
  catalogBridgeDigest,
  refuseCatalogBridge,
} from "./dataforrest-catalog-bridge-plan.mts";

type SuccessfulInspection = Extract<DataforrestRawResponseInspectionResult, { ok: true }>;

export interface CatalogBridgeSourceInspection {
  readonly inspection: SuccessfulInspection;
  readonly checkedAt: string;
  readonly status: 200;
  readonly responseBytes: number;
  readonly durationMilliseconds: number;
  readonly responseSha256: string;
  /** Private traversal capability. It must never be logged or persisted. */
  readonly nextCursor: string;
  readonly nextCursorHash: string;
}

export function catalogBridgeSourceCredentialDigest(
  authority: ResolvedDataforrestSourceAuthority,
): string {
  return catalogBridgeDigest({
    sourceCredentialVersionId: authority.sourceCredentialVersionId,
    sourceCredentialVersionNumber: authority.sourceCredentialVersionNumber,
    endpoint: authority.connectionConfiguration.endpoint,
    bearerTokenSha256: createHash("sha256")
      .update(authority.connectionConfiguration.bearerToken, "utf8")
      .digest("hex"),
  });
}

export function catalogBridgeSourceRequestUrl(input: Readonly<{
  authority: ResolvedDataforrestSourceAuthority;
  manifest: SourceAdapterManifestV1;
  stream: "catalog" | "event";
  cursor: string | null;
}>): URL {
  const url = new URL(input.authority.connectionConfiguration.endpoint);
  url.searchParams.set("platform", input.authority.providerKey);
  if (input.stream === "catalog") url.searchParams.set("stream", "catalog");
  url.searchParams.set("limit", String(input.manifest.requestBounds.pageLimit));
  if (input.cursor !== null) url.searchParams.set("cursor", input.cursor);
  return url;
}

function privateNextCursor(body: Uint8Array): string {
  try {
    const value = JSON.parse(Buffer.from(body).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value) ||
      !("next_cursor" in value) || typeof value.next_cursor !== "string" ||
      value.next_cursor.length === 0) {
      refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CURSOR_INVALID");
    }
    return value.next_cursor;
  } catch (error) {
    if (error instanceof CatalogBridgeError) throw error;
    return refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_CURSOR_INVALID");
  }
}

/**
 * Performs one bounded source read and returns only normalized observations,
 * digests, measurements, and the in-memory cursor needed for the next read.
 * The protected response bytes are zeroed on every path.
 */
export async function inspectCatalogBridgeSourcePage(input: Readonly<{
  authority: ResolvedDataforrestSourceAuthority;
  manifest: SourceAdapterManifestV1;
  stream: "catalog" | "event";
  cursor: string | null;
  signal: AbortSignal;
  captureResponse?: typeof captureHardenedProviderResponse;
  now?: () => Date;
}>): Promise<CatalogBridgeSourceInspection> {
  const url = catalogBridgeSourceRequestUrl(input);
  const captureResponse = input.captureResponse ?? captureHardenedProviderResponse;
  const response: HardenedProviderResponseCapture = await captureResponse({
    url,
    allowedHosts: [url.hostname],
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${input.authority.connectionConfiguration.bearerToken}`,
    },
    timeoutMilliseconds: input.manifest.requestBounds.timeoutMilliseconds,
    maximumResponseBytes: input.manifest.requestBounds.maximumResponseBytes,
    signal: input.signal,
  });
  try {
    const inspection = new DataforrestEventsSourceAdapter({}, input.manifest)
      .inspectRawResponse({
        provider: input.authority.providerKey,
        sourceTypeKey: input.manifest.sourceTypeKey,
        adapterVersion: input.manifest.adapterVersion,
        pageLimit: input.manifest.requestBounds.pageLimit,
        protectedRawResponse: response.protectedBody,
      });
    const checkedAt = (input.now ?? (() => new Date()))();
    if (response.status !== 200 || !inspection.ok ||
      !(checkedAt instanceof Date) || !Number.isFinite(checkedAt.getTime()) ||
      !Number.isSafeInteger(response.responseBytes) || response.responseBytes < 1 ||
      response.responseBytes !== response.protectedBody.byteLength ||
      response.responseBytes > input.manifest.requestBounds.maximumResponseBytes ||
      !Number.isFinite(response.durationMilliseconds) || response.durationMilliseconds < 0) {
      refuseCatalogBridge("CATALOG_BRIDGE_SOURCE_RESPONSE_INVALID");
    }
    const nextCursor = privateNextCursor(response.protectedBody);
    const result = {
      checkedAt: checkedAt.toISOString(),
      status: 200 as const,
      responseBytes: response.responseBytes,
      durationMilliseconds: response.durationMilliseconds,
      responseSha256: createHash("sha256").update(response.protectedBody).digest("hex"),
      nextCursorHash: createHash("sha256").update(nextCursor, "utf8").digest("hex"),
    } as unknown as CatalogBridgeSourceInspection;
    // Normalized observations still contain provider record identities. Keep both
    // traversal-only values out of accidental JSON/log serialization.
    Object.defineProperties(result, {
      inspection: { value: inspection, enumerable: false, writable: false, configurable: false },
      nextCursor: { value: nextCursor, enumerable: false, writable: false, configurable: false },
    });
    return Object.freeze(result);
  } finally {
    response.protectedBody.fill(0);
  }
}
