import type { FunctionReference } from "convex/server";
import { ConvexError, v } from "convex/values";
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

const AUTH_VERSION = "v1" as const;
const AUTH_WINDOW_MILLISECONDS = 5 * 60 * 1_000;
const NONCE_RETENTION_MILLISECONDS = 10 * 60 * 1_000;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const KEY_ID_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,54})[._-]v[1-9][0-9]*$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/u;

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
  if (!SHA256_PATTERN.test(value)) return null;
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

function configuredKeySecret(keyId: string): string | null {
  if (!KEY_ID_PATTERN.test(keyId)) return null;
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
    const secret = (parsed as Record<string, unknown>)[keyId];
    return typeof secret === "string" &&
        new TextEncoder().encode(secret).byteLength >= 32 &&
        new TextEncoder().encode(secret).byteLength <= 256
      ? secret
      : null;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function authenticateRequest(
  ctx: ActionCtx,
  request: Request,
): Promise<AuthenticatedRequest> {
  const version = request.headers.get("x-packscout-signature-version");
  const keyId = request.headers.get("x-packscout-key-id");
  const timestamp = request.headers.get("x-packscout-timestamp");
  const nonce = request.headers.get("x-packscout-nonce");
  const declaredDigest = request.headers.get("x-packscout-content-sha256");
  const signature = request.headers.get("x-packscout-signature");
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
    version !== AUTH_VERSION ||
    !/^\d{13}$/u.test(timestamp) ||
    !Number.isSafeInteger(timestampMilliseconds) ||
    Math.abs(Date.now() - timestampMilliseconds) > AUTH_WINDOW_MILLISECONDS
  ) {
    throw new HttpRefusal("PUBLICATION_AUTH_STALE", 401);
  }
  if (!NONCE_PATTERN.test(nonce)) {
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
  const signedValue = [
    AUTH_VERSION,
    request.method.toUpperCase(),
    new URL(request.url).pathname,
    bodyDigest,
    timestamp,
    nonce,
  ].join("\n");
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
    "packscout.data-release.auth-nonce.v1",
    { keyId, nonce },
  );
  await ctx.runMutation(internal.productionDataReleaseAuth.consumeNonce, {
    keyId,
    nonceHash,
    requestDigest: bodyDigest,
    expiresAt: new Date(
      Date.now() + NONCE_RETENTION_MILLISECONDS,
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
  return typeof data.code === "string"
    ? (data.code as ProductionDataReleaseErrorCode)
    : null;
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
        new TextEncoder().encode(`${AUTH_VERSION}\nreceipt\n${receiptDigest}`),
      ),
    ),
  );
  return {
    ok: true,
    receipt,
    responseAuth: {
      signatureVersion: AUTH_VERSION,
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
      !KEY_ID_PATTERN.test(args.keyId) ||
      !SHA256_PATTERN.test(args.nonceHash) ||
      !SHA256_PATTERN.test(args.requestDigest) ||
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
