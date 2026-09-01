import { createHmac, timingSafeEqual } from "node:crypto";
import type { PromotionJobHistoryQuery } from "@packscout/contracts";

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MONITORING_ID_PATTERN = /^pj_[A-Za-z0-9_-]{24,120}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface PromotionJobMonitoringCursorPayload {
  readonly version: 1;
  readonly scopeDigest: string;
  readonly rosterDigest: string;
  readonly filter: string | null;
  readonly trigger: string | null;
  readonly outcome: string | null;
  readonly limit: number;
  readonly startedAt: string;
  readonly monitoringId: string;
}

export interface PromotionJobMonitoringCursorScope {
  readonly organizationId: string;
  readonly deployment: string;
  readonly rosterDigest: string;
  readonly query: PromotionJobHistoryQuery;
}

export interface PromotionJobMonitoringCursorPosition {
  readonly startedAt: Date;
  readonly monitoringId: string;
}

export class InvalidPromotionJobMonitoringCursorError extends Error {
  readonly code = "INVALID_PROMOTION_JOB_CURSOR";

  constructor() {
    super("Promotion job history cursor is invalid.");
    this.name = "InvalidPromotionJobMonitoringCursorError";
  }
}

function invalid(): never {
  throw new InvalidPromotionJobMonitoringCursorError();
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

export class PromotionJobMonitoringCursorCodec {
  readonly #key: Buffer;

  constructor(secret: Uint8Array) {
    if (!(secret instanceof Uint8Array) || secret.byteLength < 32) {
      throw new TypeError("Promotion job monitoring cursor key is invalid.");
    }
    this.#key = Buffer.from(secret);
  }

  encode(
    scope: PromotionJobMonitoringCursorScope,
    position: PromotionJobMonitoringCursorPosition,
  ): string {
    this.assertScope(scope);
    if (
      !validDate(position.startedAt)
      || !MONITORING_ID_PATTERN.test(position.monitoringId)
    ) invalid();
    const payload: PromotionJobMonitoringCursorPayload = {
      version: 1,
      scopeDigest: this.scopeDigest(scope),
      rosterDigest: scope.rosterDigest,
      filter: scope.query.filter ?? null,
      trigger: scope.query.trigger ?? null,
      outcome: scope.query.outcome ?? null,
      limit: scope.query.limit,
      startedAt: position.startedAt.toISOString(),
      monitoringId: position.monitoringId,
    };
    const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    return `${body}.${this.sign(body)}`;
  }

  decode(
    cursor: string,
    scope: PromotionJobMonitoringCursorScope,
  ): PromotionJobMonitoringCursorPosition {
    this.assertScope(scope);
    if (typeof cursor !== "string" || cursor.length < 16 || cursor.length > 1_024) {
      invalid();
    }
    const parts = cursor.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) invalid();
    const expectedSignature = Buffer.from(this.sign(parts[0]), "base64url");
    let actualSignature: Buffer;
    try {
      actualSignature = Buffer.from(parts[1], "base64url");
    } catch {
      invalid();
    }
    if (
      expectedSignature.byteLength !== actualSignature.byteLength
      || !timingSafeEqual(expectedSignature, actualSignature)
    ) invalid();
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    } catch {
      invalid();
    }
    if (
      typeof parsed !== "object"
      || parsed === null
      || Array.isArray(parsed)
      || !exactKeys(parsed, [
        "version",
        "scopeDigest",
        "rosterDigest",
        "filter",
        "trigger",
        "outcome",
        "limit",
        "startedAt",
        "monitoringId",
      ])
    ) invalid();
    const payload = parsed as Partial<PromotionJobMonitoringCursorPayload>;
    if (
      payload.version !== 1
      || payload.scopeDigest !== this.scopeDigest(scope)
      || payload.rosterDigest !== scope.rosterDigest
      || payload.filter !== (scope.query.filter ?? null)
      || payload.trigger !== (scope.query.trigger ?? null)
      || payload.outcome !== (scope.query.outcome ?? null)
      || payload.limit !== scope.query.limit
      || typeof payload.startedAt !== "string"
      || typeof payload.monitoringId !== "string"
      || !MONITORING_ID_PATTERN.test(payload.monitoringId)
    ) invalid();
    const startedAt = new Date(payload.startedAt);
    if (!validDate(startedAt) || startedAt.toISOString() !== payload.startedAt) {
      invalid();
    }
    return { startedAt, monitoringId: payload.monitoringId };
  }

  private assertScope(scope: PromotionJobMonitoringCursorScope): void {
    if (
      !UUID_PATTERN.test(scope.organizationId)
      || typeof scope.deployment !== "string"
      || scope.deployment.length < 1
      || scope.deployment.length > 128
      || !SHA256_PATTERN.test(scope.rosterDigest)
      || !Number.isInteger(scope.query.limit)
      || scope.query.limit < 1
      || scope.query.limit > 100
    ) invalid();
  }

  private scopeDigest(scope: PromotionJobMonitoringCursorScope): string {
    return createHmac("sha256", this.#key)
      .update("promotion-job-monitoring-scope-v1\0")
      .update(scope.organizationId.toLowerCase())
      .update("\0")
      .update(scope.deployment)
      .digest("hex");
  }

  private sign(body: string): string {
    return createHmac("sha256", this.#key)
      .update("promotion-job-monitoring-cursor-v1\0")
      .update(body)
      .digest("base64url");
  }
}
