import type {
  CatalogEnvelopeV1,
  PullEnvelopeV1,
  TradeEnvelopeV1,
} from "@packscout/contracts";
import {
  sourceIdentityForEnvelope,
  type ProviderDataQualityEvidence,
  type ProviderRecordKind,
  type ProviderRecordMappingOutcome,
  type ProviderSourceIdentity,
  type PseudonymousActorInput,
} from "../provider-adapter.ts";

export type JsonObject = Readonly<Record<string, unknown>>;

export class ProviderMappingFieldError extends Error {
  constructor(
    readonly reasonCode: string,
    readonly fieldPath: string,
  ) {
    super(`${reasonCode}: ${fieldPath}`);
    this.name = "ProviderMappingFieldError";
  }
}

export function asObject(
  value: unknown,
  fieldPath: string,
): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderMappingFieldError("INVALID_OBJECT", fieldPath);
  }
  return value as JsonObject;
}

export function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function optionalObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

export function requiredString(value: unknown, fieldPath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProviderMappingFieldError("INVALID_REQUIRED_STRING", fieldPath);
  }
  return value.trim();
}

export function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function requiredFiniteNumber(
  value: unknown,
  fieldPath: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ProviderMappingFieldError("INVALID_REQUIRED_NUMBER", fieldPath);
  }
  return value;
}

export function optionalFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function actorInput(
  role: PseudonymousActorInput["role"],
  namespace: string,
  sourceIdentifier: unknown,
): PseudonymousActorInput | null {
  const identifier = optionalString(sourceIdentifier);
  return identifier === null
    ? null
    : { role, namespace, sourceIdentifier: identifier };
}

export function compact<T>(values: readonly (T | null)[]): readonly T[] {
  return values.filter((value): value is T => value !== null);
}

export function relationship(
  platform: string,
  entityKind: "catalog_asset" | "pack",
  externalId: string | null,
  kind: "asset" | "parent" | "source" | "subject",
) {
  return externalId === null
    ? []
    : [{ entityKind, platform, externalId, relationship: kind } as const];
}

export function warning(
  code: string,
  fieldPath?: string,
): ProviderDataQualityEvidence {
  return { code, severity: "warning", ...(fieldPath ? { fieldPath } : {}) };
}

export function sourceFor(
  recordKind: "catalog",
  recordIndex: number,
  envelope: CatalogEnvelopeV1,
): ProviderSourceIdentity;
export function sourceFor(
  recordKind: "pull",
  recordIndex: number,
  envelope: PullEnvelopeV1,
): ProviderSourceIdentity;
export function sourceFor(
  recordKind: "trade",
  recordIndex: number,
  envelope: TradeEnvelopeV1,
): ProviderSourceIdentity;
export function sourceFor(
  recordKind: ProviderRecordKind,
  recordIndex: number,
  envelope: CatalogEnvelopeV1 | PullEnvelopeV1 | TradeEnvelopeV1,
): ProviderSourceIdentity {
  return sourceIdentityForEnvelope({
    recordKind,
    recordIndex,
    envelope,
  } as Parameters<typeof sourceIdentityForEnvelope>[0]);
}

export function invalidOutcome(
  source: ProviderSourceIdentity,
  error: unknown,
): ProviderRecordMappingOutcome {
  const failure =
    error instanceof ProviderMappingFieldError
      ? { reasonCode: error.reasonCode, fieldPath: error.fieldPath }
      : { reasonCode: "PROVIDER_MAPPING_FAILED", fieldPath: "data" };
  return { status: "invalid", source, failure };
}

/** Parse a provider-formatted decimal without accepting signs or exponents. */
export function parseDecimal(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== "string") return null;
  const formatted = value.trim().replace(/^\$/, "");
  const plain = /^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/;
  const commaGrouped = /^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d{1,2})?$/;
  if (!plain.test(formatted) && !commaGrouped.test(formatted)) return null;
  const result = Number(formatted.replaceAll(",", ""));
  return Number.isFinite(result) ? result : null;
}

export function stringId(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }
  return optionalString(value);
}
