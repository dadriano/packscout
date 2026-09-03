import {
  createHash,
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";
import type { PromotionJobAuthority } from "@packscout/database";
import type {
  DistributedPromotionManualCommandVerifier,
} from "./distributed-promotion-job-runtime.ts";

export const DISTRIBUTED_PROMOTION_MANUAL_COMMAND_SCHEMA =
  "packscout.distributed-promotion-manual-command";
export const DISTRIBUTED_PROMOTION_MANUAL_COMMAND_VERSION = 1;
export const DISTRIBUTED_PROMOTION_MANUAL_COMMAND_MAXIMUM_LIFETIME_MS =
  5 * 60 * 1_000;
export const DISTRIBUTED_PROMOTION_MANUAL_COMMAND_CLOCK_SKEW_MS = 30_000;
export const DISTRIBUTED_PROMOTION_MANUAL_COMMAND_MAXIMUM_COMPACT_BYTES = 512;
export const DISTRIBUTED_PROMOTION_MANUAL_COMMAND_REJECTION_CODE =
  "DISTRIBUTED_PROMOTION_MANUAL_COMMAND_REJECTED";

const AUTHORITY_VALUES = new Set<PromotionJobAuthority>([
  "provider_publication",
  "manifest_reconciliation",
]);
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const COMMAND_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const PUBLIC_KEY_BEGIN = "-----BEGIN PUBLIC KEY-----";
const PUBLIC_KEY_END = "-----END PUBLIC KEY-----";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const SIGNATURE_BYTES = 64;
const MAXIMUM_PAYLOAD_BYTES = 384;
const MAXIMUM_PUBLIC_KEY_PEM_BYTES = 2_048;
const PAYLOAD_KEYS = ["a", "c", "e", "h", "i", "r", "s", "v"] as const;

type ManualCommandWirePayload = Readonly<{
  a: PromotionJobAuthority;
  c: string;
  e: number;
  h: typeof DISTRIBUTED_PROMOTION_MANUAL_COMMAND_SCHEMA;
  i: number;
  r: number;
  s: string;
  v: typeof DISTRIBUTED_PROMOTION_MANUAL_COMMAND_VERSION;
}>;

export interface DistributedPromotionManualCommandClaims {
  readonly authority: PromotionJobAuthority;
  readonly commandId: string;
  readonly expiresAtMilliseconds: number;
  readonly issuedAtMilliseconds: number;
  readonly requestedAtMilliseconds: number;
  readonly scopeIdentitySha256: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null &&
    !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function strictBase64UrlDecode(value: string, maximumBytes: number): Buffer {
  if (!BASE64URL_PATTERN.test(value)) throw new TypeError("invalid");
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.length < 1 || decoded.length > maximumBytes ||
    decoded.toString("base64url") !== value
  ) throw new TypeError("invalid");
  return decoded;
}

function validCommandId(value: unknown): value is string {
  if (typeof value !== "string" || !COMMAND_ID_PATTERN.test(value)) {
    return false;
  }
  try {
    return strictBase64UrlDecode(value, 16).length === 16;
  } catch {
    return false;
  }
}

function validInstantMilliseconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 &&
    (value as number) <= 8_640_000_000_000_000;
}

function wirePayload(
  claims: DistributedPromotionManualCommandClaims,
): ManualCommandWirePayload {
  if (
    !AUTHORITY_VALUES.has(claims.authority) ||
    !validCommandId(claims.commandId) ||
    !validInstantMilliseconds(claims.expiresAtMilliseconds) ||
    !validInstantMilliseconds(claims.issuedAtMilliseconds) ||
    !validInstantMilliseconds(claims.requestedAtMilliseconds) ||
    !SHA256_PATTERN.test(claims.scopeIdentitySha256)
  ) throw new TypeError("Manual command claims are invalid.");
  return {
    a: claims.authority,
    c: claims.commandId,
    e: claims.expiresAtMilliseconds,
    h: DISTRIBUTED_PROMOTION_MANUAL_COMMAND_SCHEMA,
    i: claims.issuedAtMilliseconds,
    r: claims.requestedAtMilliseconds,
    s: claims.scopeIdentitySha256,
    v: DISTRIBUTED_PROMOTION_MANUAL_COMMAND_VERSION,
  };
}

/** Canonical bytes shared by the offline issuer and the public-key verifier. */
export function canonicalDistributedPromotionManualCommandPayload(
  claims: DistributedPromotionManualCommandClaims,
): Buffer {
  return Buffer.from(JSON.stringify(wirePayload(claims)), "utf8");
}

/** Joins already-canonical payload bytes and an Ed25519 signature. */
export function compactDistributedPromotionManualCommandAttestation(
  payload: Uint8Array,
  signature: Uint8Array,
): string {
  const payloadBytes = Buffer.from(payload);
  const signatureBytes = Buffer.from(signature);
  if (
    payloadBytes.length < 1 || payloadBytes.length > MAXIMUM_PAYLOAD_BYTES ||
    signatureBytes.length !== SIGNATURE_BYTES
  ) throw new TypeError("Manual command attestation is invalid.");
  const compact = `${payloadBytes.toString("base64url")}.${
    signatureBytes.toString("base64url")
  }`;
  if (
    Buffer.byteLength(compact, "utf8") >
      DISTRIBUTED_PROMOTION_MANUAL_COMMAND_MAXIMUM_COMPACT_BYTES
  ) throw new TypeError("Manual command attestation is invalid.");
  return compact;
}

function parseCanonicalPayload(payloadBytes: Buffer): ManualCommandWirePayload {
  const parsed: unknown = JSON.parse(payloadBytes.toString("utf8"));
  if (!isPlainRecord(parsed)) throw new TypeError("invalid");
  const keys = Object.keys(parsed);
  if (
    keys.length !== PAYLOAD_KEYS.length ||
    keys.some((key, index) => key !== PAYLOAD_KEYS[index]) ||
    !AUTHORITY_VALUES.has(parsed.a as PromotionJobAuthority) ||
    !validCommandId(parsed.c) ||
    !validInstantMilliseconds(parsed.e) ||
    parsed.h !== DISTRIBUTED_PROMOTION_MANUAL_COMMAND_SCHEMA ||
    !validInstantMilliseconds(parsed.i) ||
    !validInstantMilliseconds(parsed.r) ||
    typeof parsed.s !== "string" || !SHA256_PATTERN.test(parsed.s) ||
    parsed.v !== DISTRIBUTED_PROMOTION_MANUAL_COMMAND_VERSION
  ) throw new TypeError("invalid");
  const canonical = JSON.stringify(parsed);
  if (!payloadBytes.equals(Buffer.from(canonical, "utf8"))) {
    throw new TypeError("invalid");
  }
  return parsed as ManualCommandWirePayload;
}

function loadPublicKey(publicKeyPem: string): KeyObject {
  const trimmed = publicKeyPem.trim();
  if (
    Buffer.byteLength(publicKeyPem, "utf8") > MAXIMUM_PUBLIC_KEY_PEM_BYTES ||
    !trimmed.startsWith(`${PUBLIC_KEY_BEGIN}\n`) ||
    !trimmed.endsWith(`\n${PUBLIC_KEY_END}`) ||
    trimmed.includes("PRIVATE KEY") || /[\0\r]/u.test(trimmed)
  ) throw new TypeError("Manual command verifier configuration is invalid.");
  try {
    const key = createPublicKey(trimmed);
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      throw new TypeError("invalid");
    }
    return key;
  } catch {
    throw new TypeError("Manual command verifier configuration is invalid.");
  }
}

function rejected(): Readonly<{
  state: "rejected";
  failureCode: typeof DISTRIBUTED_PROMOTION_MANUAL_COMMAND_REJECTION_CODE;
}> {
  return {
    state: "rejected",
    failureCode: DISTRIBUTED_PROMOTION_MANUAL_COMMAND_REJECTION_CODE,
  };
}

/**
 * Local, fail-closed verifier for short-lived offline-issued manual commands.
 * Replays intentionally return the same delivery identity so the existing
 * invocation/tombstone idempotency boundary converges them.
 */
export class Ed25519DistributedPromotionManualCommandVerifier
implements DistributedPromotionManualCommandVerifier {
  readonly #publicKey: KeyObject;

  constructor(input: Readonly<{ publicKeyPem: string }>) {
    this.#publicKey = loadPublicKey(input.publicKeyPem);
  }

  async verify(input: Parameters<
    DistributedPromotionManualCommandVerifier["verify"]
  >[0]): ReturnType<DistributedPromotionManualCommandVerifier["verify"]> {
    try {
      const compact = input.protectedCommandIdentity;
      if (
        typeof compact !== "string" || compact.length < 1 ||
        Buffer.byteLength(compact, "utf8") >
          DISTRIBUTED_PROMOTION_MANUAL_COMMAND_MAXIMUM_COMPACT_BYTES ||
        /[^A-Za-z0-9_.-]/u.test(compact)
      ) return rejected();
      const segments = compact.split(".");
      if (segments.length !== 2) return rejected();
      const payloadBytes = strictBase64UrlDecode(
        segments[0] ?? "",
        MAXIMUM_PAYLOAD_BYTES,
      );
      const signatureBytes = strictBase64UrlDecode(
        segments[1] ?? "",
        SIGNATURE_BYTES,
      );
      if (signatureBytes.length !== SIGNATURE_BYTES) return rejected();
      const payload = parseCanonicalPayload(payloadBytes);
      if (!verifySignature(null, payloadBytes, this.#publicKey, signatureBytes)) {
        return rejected();
      }
      const requestedAt = input.requestedAt.getTime();
      if (
        !validInstantMilliseconds(requestedAt) ||
        payload.a !== input.authority ||
        payload.s !== input.scopeIdentitySha256 ||
        payload.e <= payload.i ||
        payload.e - payload.i >
          DISTRIBUTED_PROMOTION_MANUAL_COMMAND_MAXIMUM_LIFETIME_MS ||
        payload.r < payload.i || payload.r > payload.e ||
        requestedAt < payload.i -
          DISTRIBUTED_PROMOTION_MANUAL_COMMAND_CLOCK_SKEW_MS ||
        requestedAt < payload.r -
          DISTRIBUTED_PROMOTION_MANUAL_COMMAND_CLOCK_SKEW_MS ||
        requestedAt > payload.e +
          DISTRIBUTED_PROMOTION_MANUAL_COMMAND_CLOCK_SKEW_MS
      ) return rejected();
      const identityDigest = createHash("sha256")
        .update("packscout-distributed-promotion-manual-delivery-v1\0", "utf8")
        .update(payloadBytes)
        .digest("hex");
      return {
        state: "verified",
        deliveryIdentity:
          `distributed-promotion-manual-v1:${identityDigest}`,
      };
    } catch {
      return rejected();
    }
  }
}
