import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  timingSafeEqual,
} from "node:crypto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEPLOYMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/u;
const MONITORING_ID_PATTERN = /^pj_[A-Za-z0-9_-]{24,120}$/u;
const ENVELOPE_LENGTH = 46;

export type PromotionJobMonitoringRecordKind = "manifest" | "provider";

export interface PromotionJobMonitoringIdScope {
  readonly organizationId: string;
  readonly deployment: string;
}

export interface PromotionJobMonitoringRecordReference {
  readonly kind: PromotionJobMonitoringRecordKind;
  readonly centralId: string;
}

/** Missing, forged, and cross-scope identities intentionally share one code. */
export class PromotionJobMonitoringNotFoundError extends Error {
  readonly code = "PROMOTION_JOB_MONITORING_NOT_FOUND";

  constructor() {
    super("The promotion job monitoring record was not found.");
    this.name = "PromotionJobMonitoringNotFoundError";
  }
}

function notFound(): never {
  throw new PromotionJobMonitoringNotFoundError();
}

function scopeBytes(scope: PromotionJobMonitoringIdScope): Buffer {
  if (
    !UUID_PATTERN.test(scope.organizationId)
    || !DEPLOYMENT_PATTERN.test(scope.deployment)
  ) notFound();
  return Buffer.from(
    `promotion-job-monitoring-id-v1\0${scope.organizationId.toLowerCase()}\0${scope.deployment}`,
    "utf8",
  );
}

function uuidBytes(value: string): Buffer {
  if (!UUID_PATTERN.test(value)) notFound();
  return Buffer.from(value.replaceAll("-", "").toLowerCase(), "hex");
}

function uuidFromBytes(value: Buffer): string {
  if (value.byteLength !== 16) notFound();
  const hex = value.toString("hex");
  const result = [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
  if (!UUID_PATTERN.test(result)) notFound();
  return result;
}

/**
 * Stable authenticated encryption for persisted central IDs. Provider-local
 * run IDs never enter the token, and organization/deployment scope is AAD.
 */
export class PromotionJobMonitoringIdCodec {
  readonly #rootKey: Buffer;
  readonly #encryptionKey: Buffer;

  constructor(secret: Uint8Array) {
    if (!(secret instanceof Uint8Array) || secret.byteLength < 32) {
      throw new TypeError("Promotion job monitoring identity key is invalid.");
    }
    this.#rootKey = Buffer.from(secret);
    this.#encryptionKey = createHmac("sha256", this.#rootKey)
      .update("promotion-job-monitoring-id-encryption-v1\0")
      .digest();
  }

  encode(
    scope: PromotionJobMonitoringIdScope,
    reference: PromotionJobMonitoringRecordReference,
  ): string {
    const aad = scopeBytes(scope);
    const id = uuidBytes(reference.centralId);
    const kind = reference.kind === "manifest"
      ? 1
      : reference.kind === "provider"
        ? 2
        : notFound();
    const plaintext = Buffer.concat([Buffer.from([kind]), id]);
    const nonce = createHmac("sha256", this.#rootKey)
      .update("promotion-job-monitoring-id-nonce-v1\0")
      .update(aad)
      .update(plaintext)
      .digest()
      .subarray(0, 12);
    const cipher = createCipheriv("aes-256-gcm", this.#encryptionKey, nonce);
    cipher.setAAD(aad);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const envelope = Buffer.concat([
      Buffer.from([1]),
      nonce,
      encrypted,
      cipher.getAuthTag(),
    ]);
    return `pj_${envelope.toString("base64url")}`;
  }

  decode(
    scope: PromotionJobMonitoringIdScope,
    monitoringId: string,
  ): PromotionJobMonitoringRecordReference {
    if (!MONITORING_ID_PATTERN.test(monitoringId)) notFound();
    const aad = scopeBytes(scope);
    let envelope: Buffer;
    try {
      envelope = Buffer.from(monitoringId.slice(3), "base64url");
    } catch {
      return notFound();
    }
    if (envelope.byteLength !== ENVELOPE_LENGTH || envelope[0] !== 1) {
      return notFound();
    }
    const nonce = envelope.subarray(1, 13);
    const encrypted = envelope.subarray(13, 30);
    const tag = envelope.subarray(30);
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#encryptionKey,
        nonce,
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      plaintext = Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]);
    } catch {
      return notFound();
    }
    if (plaintext.byteLength !== 17) return notFound();
    const kind = plaintext[0] === 1
      ? "manifest" as const
      : plaintext[0] === 2
        ? "provider" as const
        : notFound();
    const reference = {
      kind,
      centralId: uuidFromBytes(plaintext.subarray(1)),
    };
    const canonical = Buffer.from(this.encode(scope, reference));
    const supplied = Buffer.from(monitoringId);
    if (
      canonical.byteLength !== supplied.byteLength
      || !timingSafeEqual(canonical, supplied)
    ) return notFound();
    return reference;
  }
}
