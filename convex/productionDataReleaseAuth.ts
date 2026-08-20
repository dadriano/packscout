import type { FunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import {
  MAX_PRODUCTION_HTTP_BODY_BYTES,
  MAX_CATALOG_MANIFEST_PUBLICATION_BODY_BYTES,
  MAX_CATALOG_RETENTION_HTTP_BODY_BYTES,
  MAX_DATA_RELEASE_V3_HTTP_BODY_BYTES,
  PRODUCTION_AUTH_HEADER_NAMES,
  PRODUCTION_AUTH_KEY_ID_PATTERN,
  PRODUCTION_AUTH_NONCE_HASH_DOMAIN,
  PRODUCTION_AUTH_NONCE_PATTERN,
  PRODUCTION_AUTH_NONCE_RETENTION_MILLISECONDS,
  PRODUCTION_AUTH_SHA256_PATTERN,
  PRODUCTION_AUTH_SIGNATURE_VERSION,
  PRODUCTION_AUTH_TIMESTAMP_PATTERN,
  PRODUCTION_AUTH_WINDOW_MILLISECONDS,
  catalogManifestErrorCodeSchema,
  catalogManifestReceiptDigest,
  catalogRetentionErrorCodeSchema,
  catalogRetentionReceiptDigest,
  providerReleaseErrorCodeSchema,
  providerReleaseReceiptDigest,
  productionDataReleaseErrorCodeSchema,
  productionPublicationPathSchema,
  productionPublicationReceiptSigningValue,
  productionPublicationRequestSigningValue,
  productionReceiptHash,
} from "@packscout/contracts";
import { internal } from "./_generated/api";
import {
  internalMutation,
  type ActionCtx,
  type MutationCtx,
} from "./_generated/server";
import { sha256CanonicalJson } from "./dataReleaseCanonicalHash";
import {
  refuseProductionDataRelease,
  safeProductionDataReleaseMessage,
  type ProductionDataReleaseErrorCode,
} from "./productionDataReleaseErrors";
import {
  refuseProviderRelease,
  safeProviderReleaseMessage,
  type ProviderReleaseErrorCode,
} from "./providerReleaseErrors";
import {
  catalogRetentionKeyIsAuthorized,
  configuredPublicationKeySecret,
  dataReleaseV3PublicationKeyIsAuthorized,
  heatPublicationKeyIsAuthorized,
  publicationAuthorityConfigurationIsIsolated,
} from "./productionPublicationKeyConfig";
import {
  safeCatalogManifestMessage,
  type CatalogManifestErrorCode,
} from "./catalogManifestErrors";
import {
  safeCatalogRetentionMessage,
  type CatalogRetentionErrorCode,
} from "./catalogRetentionErrors";

type LegacyExecutionReference = FunctionReference<
  "mutation",
  "internal",
  { bodyJson: string; requestDigest: string },
  unknown
>;

type ProviderExecutionReference = FunctionReference<
  "mutation",
  "internal",
  {
    bodyJson: string;
    requestDigest: string;
    authenticatedKeyId: string;
  },
  unknown
>;

type ManifestExecutionReference = ProviderExecutionReference;
type RetentionExecutionReference = ProviderExecutionReference;

type AuthenticatedRequest = Readonly<{
  bodyJson: string;
  bodyDigest: string;
  keyId: string;
  key: CryptoKey;
}>;

class HttpRefusal extends Error {
  constructor(
    readonly code: PublicationErrorCode,
    readonly status: number,
  ) {
    super(code);
  }
}

type PublicationErrorCode =
  | ProductionDataReleaseErrorCode
  | ProviderReleaseErrorCode
  | CatalogManifestErrorCode
  | CatalogRetentionErrorCode;
type PublicationSurface =
  | "legacy"
  | "dataReleaseV3"
  | "provider"
  | "manifest"
  | "retention";

/**
 * data_release_v3 shares the legacy PUBLICATION_* error codes, the legacy
 * `{bodyJson, requestDigest}` execution arguments, and the legacy
 * whole-receipt response hash; it differs only in its key authority and its
 * larger deterministic-batch body limit.
 */
function usesLegacyProtocol(surface: PublicationSurface): boolean {
  return surface === "legacy" || surface === "dataReleaseV3";
}

function surfaceCode(
  surface: PublicationSurface,
  legacyCode: ProductionDataReleaseErrorCode,
): PublicationErrorCode {
  if (usesLegacyProtocol(surface)) return legacyCode;
  const prefix = surface === "provider"
    ? "PROVIDER_RELEASE_"
    : surface === "manifest"
    ? "CATALOG_MANIFEST_"
    : "CATALOG_RETENTION_";
  const mappedCode = legacyCode.replace(/^PUBLICATION_/u, prefix);
  const parsed = surface === "provider"
    ? providerReleaseErrorCodeSchema.safeParse(mappedCode)
    : surface === "manifest"
    ? catalogManifestErrorCodeSchema.safeParse(mappedCode)
    : catalogRetentionErrorCodeSchema.safeParse(mappedCode);
  return parsed.success
    ? parsed.data
    : surface === "provider"
    ? "PROVIDER_RELEASE_INTERNAL_ERROR"
    : surface === "manifest"
    ? "CATALOG_MANIFEST_INTERNAL_ERROR"
    : "CATALOG_RETENTION_INTERNAL_ERROR";
}

function maximumBodyBytes(surface: PublicationSurface): number {
  if (surface === "manifest") return MAX_CATALOG_MANIFEST_PUBLICATION_BODY_BYTES;
  if (surface === "retention") return MAX_CATALOG_RETENTION_HTTP_BODY_BYTES;
  if (surface === "dataReleaseV3") return MAX_DATA_RELEASE_V3_HTTP_BODY_BYTES;
  return MAX_PRODUCTION_HTTP_BODY_BYTES;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(value: string): Uint8Array | null {
  if (!PRODUCTION_AUTH_SHA256_PATTERN.test(value)) return null;
  return Uint8Array.from(
    value.match(/.{2}/gu)!.map((pair) => Number.parseInt(pair, 16)),
  );
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  return bytesToHex(
    new Uint8Array(await crypto.subtle.digest("SHA-256", toArrayBuffer(bytes))),
  );
}

async function hmacKey(secret: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function authenticateRequest(
  ctx: ActionCtx,
  request: Request,
  surface: PublicationSurface,
  authorizeKeyId?: (keyId: string) => boolean,
): Promise<AuthenticatedRequest> {
  const version = request.headers.get(PRODUCTION_AUTH_HEADER_NAMES.signatureVersion);
  const keyId = request.headers.get(PRODUCTION_AUTH_HEADER_NAMES.keyId);
  const timestamp = request.headers.get(PRODUCTION_AUTH_HEADER_NAMES.timestamp);
  const nonce = request.headers.get(PRODUCTION_AUTH_HEADER_NAMES.nonce);
  const declaredDigest = request.headers.get(PRODUCTION_AUTH_HEADER_NAMES.contentSha256);
  const signature = request.headers.get(PRODUCTION_AUTH_HEADER_NAMES.signature);
  if (
    version === null ||
    keyId === null ||
    timestamp === null ||
    nonce === null ||
    declaredDigest === null ||
    signature === null
  ) {
    throw new HttpRefusal(surfaceCode(surface, "PUBLICATION_AUTH_MISSING"), 401);
  }
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    Number.parseInt(contentLength, 10) > maximumBodyBytes(surface)
  ) {
    throw new HttpRefusal(surfaceCode(surface, "PUBLICATION_BODY_TOO_LARGE"), 413);
  }
  const bodyBytes = new Uint8Array(await request.arrayBuffer());
  if (bodyBytes.byteLength > maximumBodyBytes(surface)) {
    throw new HttpRefusal(surfaceCode(surface, "PUBLICATION_BODY_TOO_LARGE"), 413);
  }
  const secret = configuredPublicationKeySecret(keyId);
  if (secret === null) {
    throw new HttpRefusal(surfaceCode(surface, "PUBLICATION_AUTH_KEY_UNKNOWN"), 401);
  }
  if (authorizeKeyId !== undefined && !authorizeKeyId(keyId)) {
    throw new HttpRefusal(surfaceCode(surface, "PUBLICATION_AUTH_KEY_UNKNOWN"), 401);
  }
  const timestampMilliseconds = Number(timestamp);
  if (
    version !== PRODUCTION_AUTH_SIGNATURE_VERSION ||
    !PRODUCTION_AUTH_TIMESTAMP_PATTERN.test(timestamp) ||
    !Number.isSafeInteger(timestampMilliseconds) ||
    Math.abs(Date.now() - timestampMilliseconds) > PRODUCTION_AUTH_WINDOW_MILLISECONDS
  ) {
    throw new HttpRefusal(surfaceCode(surface, "PUBLICATION_AUTH_STALE"), 401);
  }
  if (!PRODUCTION_AUTH_NONCE_PATTERN.test(nonce)) {
    throw new HttpRefusal(surfaceCode(surface, "PUBLICATION_AUTH_INVALID"), 401);
  }
  const bodyDigest = await sha256Bytes(bodyBytes);
  const signatureBytes = hexToBytes(signature);
  if (
    bodyDigest !== declaredDigest ||
    signatureBytes === null
  ) {
    throw new HttpRefusal(surfaceCode(surface, "PUBLICATION_AUTH_INVALID"), 401);
  }
  const key = await hmacKey(secret);
  const path = productionPublicationPathSchema.safeParse(
    new URL(request.url).pathname,
  );
  if (request.method.toUpperCase() !== "POST" || !path.success) {
    throw new HttpRefusal(surfaceCode(surface, "PUBLICATION_AUTH_INVALID"), 401);
  }
  const signedValue = productionPublicationRequestSigningValue({
    method: "POST",
    path: path.data,
    bodyDigest,
    timestamp,
    nonce,
  });
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    toArrayBuffer(signatureBytes),
    new TextEncoder().encode(signedValue),
  );
  if (!valid) {
    throw new HttpRefusal(surfaceCode(surface, "PUBLICATION_AUTH_INVALID"), 401);
  }
  const nonceHash = await sha256CanonicalJson(
    PRODUCTION_AUTH_NONCE_HASH_DOMAIN,
    { keyId, nonce },
  );
  await ctx.runMutation(
    surface === "provider"
      ? internal.productionDataReleaseAuth.consumeProviderNonce
      : surface === "manifest"
      ? internal.productionDataReleaseAuth.consumeCatalogManifestNonce
      : surface === "retention"
      ? internal.productionDataReleaseAuth.consumeCatalogRetentionNonce
      : internal.productionDataReleaseAuth.consumeNonce,
    {
    keyId,
    nonceHash,
    requestDigest: bodyDigest,
    expiresAt: new Date(
      Date.now() + PRODUCTION_AUTH_NONCE_RETENTION_MILLISECONDS,
    ).toISOString(),
    },
  );
  let bodyJson: string;
  try {
    bodyJson = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
  } catch {
    throw new HttpRefusal(surfaceCode(surface, "PUBLICATION_REQUEST_INVALID"), 400);
  }
  return { bodyJson, bodyDigest, keyId, key };
}

function errorStatus(code: PublicationErrorCode): number {
  if (code.endsWith("_INTERNAL_ERROR")) return 500;
  if (code.endsWith("_BODY_TOO_LARGE")) return 413;
  if (code.endsWith("_AUTH_FORBIDDEN")) return 403;
  if (code.includes("_AUTH_")) return 401;
  if (
    code.endsWith("_REQUEST_INVALID") ||
    code.endsWith("_SCHEMA_UNSUPPORTED") ||
    code.endsWith("_PROTECTED_FIELD") ||
    code.endsWith("_ENTITY_INVALID") ||
    code.endsWith("_REFERENCE_INVALID")
  ) {
    return 400;
  }
  return 409;
}

function errorCode(error: unknown): PublicationErrorCode | null {
  if (error instanceof HttpRefusal) return error.code;
  if (!(error instanceof ConvexError)) return null;
  const data = error.data as { code?: unknown };
  const parsed = productionDataReleaseErrorCodeSchema.safeParse(data.code);
  if (parsed.success) return parsed.data;
  const provider = providerReleaseErrorCodeSchema.safeParse(data.code);
  if (provider.success) return provider.data;
  const manifest = catalogManifestErrorCodeSchema.safeParse(data.code);
  if (manifest.success) return manifest.data;
  const retention = catalogRetentionErrorCodeSchema.safeParse(data.code);
  return retention.success ? retention.data : null;
}

async function signReceipt(
  key: CryptoKey,
  keyId: string,
  receipt: unknown,
  surface: PublicationSurface,
): Promise<Record<string, unknown>> {
  const exactDigestField = typeof receipt === "object" &&
      receipt !== null &&
      "receiptDigest" in receipt
    ? receipt.receiptDigest
    : undefined;
  if (
    !usesLegacyProtocol(surface) &&
    (exactDigestField === undefined ||
      (exactDigestField !== null &&
        typeof exactDigestField !== "string"))
  ) {
    if (surface === "provider") {
      refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
    }
    throw new HttpRefusal(
      surface === "manifest"
        ? "CATALOG_MANIFEST_STATE_CONFLICT"
        : "CATALOG_RETENTION_STATE_CONFLICT",
      409,
    );
  }
  const storedExactDigest = typeof exactDigestField === "string"
    ? exactDigestField
    : null;
  const computedExactDigest = surface === "provider"
    ? await providerReleaseReceiptDigest(receipt)
    : surface === "manifest"
    ? await catalogManifestReceiptDigest(receipt)
    : surface === "retention"
    ? await catalogRetentionReceiptDigest(receipt)
    : null;
  if (!usesLegacyProtocol(surface)) {
    if (
      storedExactDigest !== null &&
      storedExactDigest !== computedExactDigest
    ) {
      if (surface === "provider") {
        refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT");
      }
      throw new HttpRefusal(
        surface === "manifest"
          ? "CATALOG_MANIFEST_STATE_CONFLICT"
          : "CATALOG_RETENTION_STATE_CONFLICT",
        409,
      );
    }
  }
  const receiptDigest = !usesLegacyProtocol(surface)
    ? computedExactDigest ??
      (surface === "provider"
        ? refuseProviderRelease("PROVIDER_RELEASE_STATE_CONFLICT")
        : (() => {
            throw new HttpRefusal(
              surface === "manifest"
                ? "CATALOG_MANIFEST_STATE_CONFLICT"
                : "CATALOG_RETENTION_STATE_CONFLICT",
              409,
            );
          })())
    : await productionReceiptHash(receipt);
  const signature = bytesToHex(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(
          productionPublicationReceiptSigningValue(receiptDigest),
        ),
      ),
    ),
  );
  return {
    ok: true,
    receipt,
    responseAuth: {
      signatureVersion: PRODUCTION_AUTH_SIGNATURE_VERSION,
      keyId,
      receiptDigest,
      signature,
    },
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function handleAuthenticatedRequest(
  ctx: ActionCtx,
  request: Request,
  operation: LegacyExecutionReference | ProviderExecutionReference,
  surface: PublicationSurface,
  authorizeKeyId?: (keyId: string) => boolean,
): Promise<Response> {
  try {
    const authenticated = await authenticateRequest(
      ctx,
      request,
      surface,
      authorizeKeyId,
    );
    const receipt = !usesLegacyProtocol(surface)
      ? await ctx.runMutation(operation as ProviderExecutionReference, {
        bodyJson: authenticated.bodyJson,
        requestDigest: authenticated.bodyDigest,
        authenticatedKeyId: authenticated.keyId,
      })
      : await ctx.runMutation(operation as LegacyExecutionReference, {
        bodyJson: authenticated.bodyJson,
        requestDigest: authenticated.bodyDigest,
      });
    return jsonResponse(
      await signReceipt(
        authenticated.key,
        authenticated.keyId,
        receipt,
        surface,
      ),
      200,
    );
  } catch (error) {
    const code = errorCode(error);
    if (code === null) {
      const internalCode = surface === "provider"
        ? "PROVIDER_RELEASE_INTERNAL_ERROR"
        : surface === "manifest"
        ? "CATALOG_MANIFEST_INTERNAL_ERROR"
        : surface === "retention"
        ? "CATALOG_RETENTION_INTERNAL_ERROR"
        : "PUBLICATION_INTERNAL_ERROR";
      return jsonResponse(
        { error: "The publication request failed safely.", code: internalCode },
        500,
      );
    }
    const status = error instanceof HttpRefusal
      ? error.status
      : errorStatus(code);
    return jsonResponse(
      {
        error: providerReleaseErrorCodeSchema.safeParse(code).success
          ? safeProviderReleaseMessage(code as ProviderReleaseErrorCode)
          : catalogManifestErrorCodeSchema.safeParse(code).success
          ? safeCatalogManifestMessage(code as CatalogManifestErrorCode)
          : catalogRetentionErrorCodeSchema.safeParse(code).success
          ? safeCatalogRetentionMessage(code as CatalogRetentionErrorCode)
          : safeProductionDataReleaseMessage(code as ProductionDataReleaseErrorCode),
        code,
      },
      status,
    );
  }
}

export function handleAuthenticatedPublicationRequest(
  ctx: ActionCtx,
  request: Request,
  operation: LegacyExecutionReference,
): Promise<Response> {
  return handleAuthenticatedRequest(ctx, request, operation, "legacy");
}

export function handleAuthenticatedHeatPublicationRequest(
  ctx: ActionCtx,
  request: Request,
  operation: LegacyExecutionReference,
): Promise<Response> {
  return handleAuthenticatedRequest(
    ctx,
    request,
    operation,
    "legacy",
    heatPublicationKeyIsAuthorized,
  );
}

export function handleAuthenticatedDataReleaseV3Request(
  ctx: ActionCtx,
  request: Request,
  operation: LegacyExecutionReference,
): Promise<Response> {
  return handleAuthenticatedRequest(
    ctx,
    request,
    operation,
    "dataReleaseV3",
    dataReleaseV3PublicationKeyIsAuthorized,
  );
}

export function handleAuthenticatedProviderReleaseRequest(
  ctx: ActionCtx,
  request: Request,
  operation: ProviderExecutionReference,
): Promise<Response> {
  return handleAuthenticatedRequest(
    ctx,
    request,
    operation,
    "provider",
    publicationAuthorityConfigurationIsIsolated,
  );
}

export function handleAuthenticatedCatalogManifestRequest(
  ctx: ActionCtx,
  request: Request,
  operation: ManifestExecutionReference,
): Promise<Response> {
  return handleAuthenticatedRequest(
    ctx,
    request,
    operation,
    "manifest",
    publicationAuthorityConfigurationIsIsolated,
  );
}

export function handleAuthenticatedCatalogRetentionRequest(
  ctx: ActionCtx,
  request: Request,
  operation: RetentionExecutionReference,
): Promise<Response> {
  return handleAuthenticatedRequest(
    ctx,
    request,
    operation,
    "retention",
    catalogRetentionKeyIsAuthorized,
  );
}

const NONCE_ARGS = {
  keyId: v.string(),
  nonceHash: v.string(),
  requestDigest: v.string(),
  expiresAt: v.string(),
} as const;

async function consumeNonceForSurface(
  ctx: MutationCtx,
  args: {
    keyId: string;
    nonceHash: string;
    requestDigest: string;
    expiresAt: string;
  },
  surface: PublicationSurface,
): Promise<null> {
  const refuse = (code: ProductionDataReleaseErrorCode): never => {
    if (surface === "provider") {
      refuseProviderRelease(
        surfaceCode(surface, code) as ProviderReleaseErrorCode,
      );
    }
    if (surface === "manifest") {
      throw new ConvexError({
        code: surfaceCode(surface, code) as CatalogManifestErrorCode,
      });
    }
    if (surface === "retention") {
      throw new ConvexError({
        code: surfaceCode(surface, code) as CatalogRetentionErrorCode,
      });
    }
    return refuseProductionDataRelease(code);
  };
  if (
    !PRODUCTION_AUTH_KEY_ID_PATTERN.test(args.keyId) ||
    !PRODUCTION_AUTH_SHA256_PATTERN.test(args.nonceHash) ||
    !PRODUCTION_AUTH_SHA256_PATTERN.test(args.requestDigest) ||
    !Number.isFinite(Date.parse(args.expiresAt))
  ) {
    refuse("PUBLICATION_AUTH_INVALID");
  }
  const matches = await ctx.db
    .query("dataReleaseAuthNonces")
    .withIndex("by_key_id_and_nonce_hash", (index) =>
      index.eq("keyId", args.keyId).eq("nonceHash", args.nonceHash),
    )
    .take(2);
  if (matches.length !== 0) {
    refuse("PUBLICATION_AUTH_REPLAYED");
  }
  const now = new Date().toISOString();
  await ctx.db.insert("dataReleaseAuthNonces", {
    keyId: args.keyId,
    nonceHash: args.nonceHash,
    requestDigest: args.requestDigest,
    acceptedAt: now,
    expiresAt: args.expiresAt,
  });
  return null;
}

export const consumeNonce = internalMutation({
  args: NONCE_ARGS,
  returns: v.null(),
  handler: (ctx, args) => consumeNonceForSurface(ctx, args, "legacy"),
});

export const consumeProviderNonce = internalMutation({
  args: NONCE_ARGS,
  returns: v.null(),
  handler: (ctx, args) => consumeNonceForSurface(ctx, args, "provider"),
});

export const consumeCatalogManifestNonce = internalMutation({
  args: NONCE_ARGS,
  returns: v.null(),
  handler: (ctx, args) => consumeNonceForSurface(ctx, args, "manifest"),
});

export const consumeCatalogRetentionNonce = internalMutation({
  args: NONCE_ARGS,
  returns: v.null(),
  handler: (ctx, args) => consumeNonceForSurface(ctx, args, "retention"),
});
