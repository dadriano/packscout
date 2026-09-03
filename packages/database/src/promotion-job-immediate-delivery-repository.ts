import { Prisma as CentralPrisma } from
  "../prisma/generated/central/index.js";
import { Prisma as ProviderPrisma } from
  "../prisma/generated/provider/index.js";
import type { CentralPrismaClient } from "./central-database.ts";
import type { ProviderPrismaClient } from "./provider-database.ts";

export const PROMOTION_JOB_IMMEDIATE_DELIVERY_CHANNEL =
  "packscout_promotion_job_immediate_v1";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAXIMUM_GENERATION = 9_223_372_036_854_775_807n;
const PROVIDER_NOTIFY_TRANSACTION = Object.freeze({
  maxWait: 250,
  timeout: 500,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.ReadCommitted,
});
const CENTRAL_NOTIFY_TRANSACTION = Object.freeze({
  maxWait: 250,
  timeout: 500,
  isolationLevel: CentralPrisma.TransactionIsolationLevel.ReadCommitted,
});

export type ProviderPromotionImmediateDeliveryRequest = Readonly<{
  authority: "provider_publication";
  cause: "canonical_settlement" | "central_invalidation";
  scopeId: string;
  sourceGeneration: bigint;
  sourceEvidenceDigest: string;
  requestedAt: Date;
}>;

export type ManifestPromotionImmediateDeliveryRequest = Readonly<{
  authority: "manifest_reconciliation";
  cause: "provider_completion";
  scopeId: string;
  sourceGeneration: bigint;
  sourceEvidenceDigest: string;
  requestedAt: Date;
}>;

export type PromotionJobImmediateDeliveryRequest =
  | ProviderPromotionImmediateDeliveryRequest
  | ManifestPromotionImmediateDeliveryRequest;

export interface ProviderPromotionImmediateDeliveryPort {
  request(input: ProviderPromotionImmediateDeliveryRequest): Promise<void>;
}

export interface ManifestPromotionImmediateDeliveryPort {
  request(input: ManifestPromotionImmediateDeliveryRequest): Promise<void>;
}

function assertRequest(
  input: PromotionJobImmediateDeliveryRequest,
): void {
  if (
    !UUID_PATTERN.test(input.scopeId) ||
    input.sourceGeneration < 1n ||
    input.sourceGeneration > MAXIMUM_GENERATION ||
    !SHA256_PATTERN.test(input.sourceEvidenceDigest) ||
    !(input.requestedAt instanceof Date) ||
    !Number.isFinite(input.requestedAt.getTime()) ||
    (input.authority === "provider_publication"
      ? !["canonical_settlement", "central_invalidation"].includes(
          input.cause,
        )
      : input.cause !== "provider_completion")
  ) throw new TypeError("Promotion job immediate delivery is invalid.");
}

export function encodePromotionJobImmediateDelivery(
  input: PromotionJobImmediateDeliveryRequest,
): string {
  assertRequest(input);
  return JSON.stringify({
    authority: input.authority,
    cause: input.cause,
    scopeId: input.scopeId.toLowerCase(),
    sourceGeneration: input.sourceGeneration.toString(),
    sourceEvidenceDigest: input.sourceEvidenceDigest,
    requestedAt: input.requestedAt.toISOString(),
  });
}

export function decodePromotionJobImmediateDelivery(
  payload: string | undefined,
): PromotionJobImmediateDeliveryRequest | null {
  if (
    payload === undefined || payload.length < 1 || payload.length > 1_024 ||
    /[\r\n\0]/u.test(payload)
  ) return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) return null;
    const value = parsed as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !== [
        "authority",
        "cause",
        "requestedAt",
        "scopeId",
        "sourceEvidenceDigest",
        "sourceGeneration",
      ].join(",") ||
      (value.authority !== "provider_publication" &&
        value.authority !== "manifest_reconciliation") ||
      typeof value.cause !== "string" ||
      typeof value.scopeId !== "string" ||
      typeof value.sourceGeneration !== "string" ||
      !/^[1-9][0-9]{0,18}$/u.test(value.sourceGeneration) ||
      typeof value.sourceEvidenceDigest !== "string" ||
      typeof value.requestedAt !== "string"
    ) return null;
    const requestedAt = new Date(value.requestedAt);
    if (
      !Number.isFinite(requestedAt.getTime()) ||
      requestedAt.toISOString() !== value.requestedAt
    ) return null;
    const request = {
      authority: value.authority,
      cause: value.cause,
      scopeId: value.scopeId,
      sourceGeneration: BigInt(value.sourceGeneration),
      sourceEvidenceDigest: value.sourceEvidenceDigest,
      requestedAt,
    } as PromotionJobImmediateDeliveryRequest;
    assertRequest(request);
    return request;
  } catch {
    return null;
  }
}

/**
 * Best-effort provider-local nudge. The durable wake row remains authoritative;
 * PostgreSQL only fans the already-committed generation out to resident hosts.
 */
export class PrismaProviderPromotionImmediateDeliveryRepository
implements ProviderPromotionImmediateDeliveryPort {
  constructor(private readonly provider: ProviderPrismaClient) {}

  async request(input: ProviderPromotionImmediateDeliveryRequest): Promise<void> {
    const payload = encodePromotionJobImmediateDelivery(input);
    await this.provider.$transaction(
      (transaction) => transaction.$queryRaw(ProviderPrisma.sql`
        SELECT pg_notify(${PROMOTION_JOB_IMMEDIATE_DELIVERY_CHANNEL}, ${payload})
      `),
      PROVIDER_NOTIFY_TRANSACTION,
    );
  }
}

/** Central counterpart used only after a durable provider gate is accepted. */
export class PrismaManifestPromotionImmediateDeliveryRepository
implements ManifestPromotionImmediateDeliveryPort {
  constructor(private readonly central: CentralPrismaClient) {}

  async request(input: ManifestPromotionImmediateDeliveryRequest): Promise<void> {
    const payload = encodePromotionJobImmediateDelivery(input);
    await this.central.$transaction(
      (transaction) => transaction.$queryRaw(CentralPrisma.sql`
        SELECT pg_notify(${PROMOTION_JOB_IMMEDIATE_DELIVERY_CHANNEL}, ${payload})
      `),
      CENTRAL_NOTIFY_TRANSACTION,
    );
  }
}
