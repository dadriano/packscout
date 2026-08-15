import type { FunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
import {
  MAX_PRODUCTION_AUTH_SECRET_BYTES,
  MIN_PRODUCTION_AUTH_SECRET_BYTES,
  PRODUCTION_AUTH_HEADER_NAMES,
  PRODUCTION_AUTH_KEY_ID_PATTERN,
  PRODUCTION_AUTH_NONCE_HASH_DOMAIN,
  PRODUCTION_AUTH_NONCE_PATTERN,
  PRODUCTION_AUTH_NONCE_RETENTION_MILLISECONDS,
  PRODUCTION_AUTH_SHA256_PATTERN,
  PRODUCTION_AUTH_SIGNATURE_VERSION,
  PRODUCTION_AUTH_TIMESTAMP_PATTERN,
  PRODUCTION_AUTH_WINDOW_MILLISECONDS,
  decodeProductionAuthSecretBase64,
  productionDataReleaseErrorCodeSchema,
  productionPublicationPathSchema,
  productionPublicationReceiptSigningValue,
  productionPublicationRequestSigningValue,
} from "@packscout/contracts";
import { internal } from "./_generated/api";
import {
  env,
  internalMutation,
  type ActionCtx,
} from "./_generated/server";
import { sha256CanonicalJson } from "./dataReleaseCanonicalHash";
import {
  refuseProductionDataRelease,
  safeProductionDataReleaseMessage,
  type ProductionDataReleaseErrorCode,
} from "./productionDataReleaseErrors";
import {
  MAX_PRODUCTION_HTTP_BODY_BYTES,
  productionReceiptHash,
} from "./productionDataReleaseProtocol";

type ExecutionReference = FunctionReference<
  "mutation",
  "internal",
  { bodyJson: string; requestDigest: string },
  unknown
>;

type AuthenticatedRequest = Readonly<{
  bodyJson: string;
  bodyDigest: string;
  keyId: string;
  key: CryptoKey;
}>;

class HttpRefusal extends Error {
  constructor(
    readonly code: ProductionDataReleaseErrorCode,
    readonly status: number,
  ) {
    super(code);
  }
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

function configuredKeySecret(keyId: string): Uint8Array | null {
  if (!PRODUCTION_AUTH_KEY_ID_PATTERN.test(keyId)) return null;
  const raw = env.PACKSCOUT_DATA_RELEASE_PUBLISHING_KEYS;
  if (raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype
    ) {
      return null;
    }
    const encoded = (parsed as Record<string, unknown>)[keyId];
    if (typeof encoded !== "string") return null;
    const secret = decodeProductionAuthSecretBase64(encoded);
    return secret !== null &&
        secret.byteLength >= MIN_PRODUCTION_AUTH_SECRET_BYTES &&
        secret.byteLength <= MAX_PRODUCTION_AUTH_SECRET_BYTES
      ? secret : null;
  } catch {
    return null;
  }
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
    throw new HttpRefusal("PUBLICATION_AUTH_MISSING", 401);
  }
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    Number.parseInt(contentLength, 10) > MAX_PRODUCTION_HTTP_BODY_BYTES
  ) {
    throw new HttpRefusal("PUBLICATION_BODY_TOO_LARGE", 413);
  }
  const bodyBytes = new Uint8Array(await request.arrayBuffer());
  if (bodyBytes.byteLength > MAX_PRODUCTION_HTTP_BODY_BYTES) {
    throw new HttpRefusal("PUBLICATION_BODY_TOO_LARGE", 413);
  }
  const secret = configuredKeySecret(keyId);
  if (secret === null) {
    throw new HttpRefusal("PUBLICATION_AUTH_KEY_UNKNOWN", 401);
  }
  const timestampMilliseconds = Number(timestamp);
  if (
    version !== PRODUCTION_AUTH_SIGNATURE_VERSION ||
    !PRODUCTION_AUTH_TIMESTAMP_PATTERN.test(timestamp) ||
    !Number.isSafeInteger(timestampMilliseconds) ||
    Math.abs(Date.now() - timestampMilliseconds) > PRODUCTION_AUTH_WINDOW_MILLISECONDS
  ) {
    throw new HttpRefusal("PUBLICATION_AUTH_STALE", 401);
  }
  if (!PRODUCTION_AUTH_NONCE_PATTERN.test(nonce)) {
    throw new HttpRefusal("PUBLICATION_AUTH_INVALID", 401);
  }
  const bodyDigest = await sha256Bytes(bodyBytes);
  const signatureBytes = hexToBytes(signature);
  if (
    bodyDigest !== declaredDigest ||
    signatureBytes === null
  ) {
    throw new HttpRefusal("PUBLICATION_AUTH_INVALID", 401);
  }
  const key = await hmacKey(secret);
  const path = productionPublicationPathSchema.safeParse(
    new URL(request.url).pathname,
  );
  if (request.method.toUpperCase() !== "POST" || !path.success) {
    throw new HttpRefusal("PUBLICATION_AUTH_INVALID", 401);
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
    throw new HttpRefusal("PUBLICATION_AUTH_INVALID", 401);
  }
  const nonceHash = await sha256CanonicalJson(
    PRODUCTION_AUTH_NONCE_HASH_DOMAIN,
    { keyId, nonce },
  );
  await ctx.runMutation(internal.productionDataReleaseAuth.consumeNonce, {
    keyId,
    nonceHash,
    requestDigest: bodyDigest,
    expiresAt: new Date(
      Date.now() + PRODUCTION_AUTH_NONCE_RETENTION_MILLISECONDS,
    ).toISOString(),
  });
  let bodyJson: string;
  try {
    bodyJson = new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes);
  } catch {
    throw new HttpRefusal("PUBLICATION_REQUEST_INVALID", 400);
  }
  return { bodyJson, bodyDigest, keyId, key };
}

function errorStatus(code: ProductionDataReleaseErrorCode): number {
  if (code === "PUBLICATION_INTERNAL_ERROR") return 500;
  if (code === "PUBLICATION_BODY_TOO_LARGE") return 413;
  if (code.startsWith("PUBLICATION_AUTH_")) return 401;
  if (
    code === "PUBLICATION_REQUEST_INVALID" ||
    code === "PUBLICATION_SCHEMA_UNSUPPORTED" ||
    code === "PUBLICATION_PROTECTED_FIELD" ||
    code === "PUBLICATION_ENTITY_INVALID" ||
    code === "PUBLICATION_REFERENCE_INVALID"
  ) {
    return 400;
  }
  return 409;
}

function errorCode(error: unknown): ProductionDataReleaseErrorCode | null {
  if (error instanceof HttpRefusal) return error.code;
  if (!(error instanceof ConvexError)) return null;
  const data = error.data as { code?: unknown };
  const parsed = productionDataReleaseErrorCodeSchema.safeParse(data.code);
  return parsed.success ? parsed.data : null;
}

async function signReceipt(
  key: CryptoKey,
  keyId: string,
  receipt: unknown,
): Promise<Record<string, unknown>> {
  const receiptDigest = await productionReceiptHash(receipt);
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

export async function handleAuthenticatedPublicationRequest(
  ctx: ActionCtx,
  request: Request,
  operation: ExecutionReference,
): Promise<Response> {
  try {
    const authenticated = await authenticateRequest(ctx, request);
    const receipt = await ctx.runMutation(operation, {
      bodyJson: authenticated.bodyJson,
      requestDigest: authenticated.bodyDigest,
    });
    return jsonResponse(
      await signReceipt(
        authenticated.key,
        authenticated.keyId,
        receipt,
      ),
      200,
    );
  } catch (error) {
    const code = errorCode(error);
    if (code === null) {
      return jsonResponse(
        { error: "The publication request failed safely.", code: "PUBLICATION_INTERNAL_ERROR" },
        500,
      );
    }
    const status = error instanceof HttpRefusal
      ? error.status
      : errorStatus(code);
    return jsonResponse(
      { error: safeProductionDataReleaseMessage(code), code },
      status,
    );
  }
}

export const consumeNonce = internalMutation({
  args: {
    keyId: v.string(),
    nonceHash: v.string(),
    requestDigest: v.string(),
    expiresAt: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    if (
      !PRODUCTION_AUTH_KEY_ID_PATTERN.test(args.keyId) ||
      !PRODUCTION_AUTH_SHA256_PATTERN.test(args.nonceHash) ||
      !PRODUCTION_AUTH_SHA256_PATTERN.test(args.requestDigest) ||
      !Number.isFinite(Date.parse(args.expiresAt))
    ) {
      refuseProductionDataRelease("PUBLICATION_AUTH_INVALID");
    }
    const matches = await ctx.db
      .query("dataReleaseAuthNonces")
      .withIndex("by_key_id_and_nonce_hash", (index) =>
        index.eq("keyId", args.keyId).eq("nonceHash", args.nonceHash),
      )
      .take(2);
    if (matches.length !== 0) {
      refuseProductionDataRelease("PUBLICATION_AUTH_REPLAYED");
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
  },
});
