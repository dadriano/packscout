import type { ProviderStreamRecordV2 } from "@packscout/contracts";
import {
  sourceIdentityForRecord,
  type ProviderAdapterCandidate,
  type ProviderDataQualityEvidence,
  type ProviderRecordMappingOutcome,
  type ProviderSourceIdentity,
  type PseudonymousActorInput,
} from "../provider-adapter.ts";

export type JsonObject = Readonly<Record<string, unknown>>;

export function optionalObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

export function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

/** Collapse provider-authored display text to a database-safe single line. */
export function optionalSingleLineString(value: unknown): string | null {
  const input = optionalString(value);
  if (input === null) return null;

  let normalized = "";
  let previousWasSeparator = false;
  for (const character of input) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isSeparator = codePoint <= 0x20 || codePoint === 0x7f;
    if (isSeparator) {
      if (!previousWasSeparator) normalized += " ";
      previousWasSeparator = true;
      continue;
    }
    normalized += character;
    previousWasSeparator = false;
  }

  return optionalString(normalized);
}

/** Parse a provider decimal without accepting exponents or non-finite values. */
export function optionalFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (
    typeof value !== "string" ||
    !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value.trim())
  ) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function nonNegativeNumber(value: unknown): number | null {
  const parsed = optionalFiniteNumber(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

export function uniqueStrings(values: readonly unknown[]): readonly string[] {
  return Object.freeze(
    [...new Set(values.map(optionalString).filter((value): value is string => value !== null))],
  );
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

export function uniqueActors(
  values: readonly (PseudonymousActorInput | null)[],
): readonly PseudonymousActorInput[] {
  const seen = new Set<string>();
  return Object.freeze(
    values.filter((value): value is PseudonymousActorInput => {
      if (value === null) return false;
      const key = `${value.role}\u0000${value.namespace}\u0000${value.sourceIdentifier}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

export function warning(
  code: string,
  fieldPath?: string,
): ProviderDataQualityEvidence {
  return { code, severity: "warning", ...(fieldPath ? { fieldPath } : {}) };
}

export function information(
  code: string,
  fieldPath?: string,
): ProviderDataQualityEvidence {
  return { code, severity: "info", ...(fieldPath ? { fieldPath } : {}) };
}

export function sourceForRecord(
  record: ProviderStreamRecordV2,
  recordIndex: number,
): ProviderSourceIdentity {
  return sourceIdentityForRecord({ record, recordIndex });
}

export function invalidOutcome(
  source: ProviderSourceIdentity,
  reasonCode: string,
  fieldPath: string,
): ProviderRecordMappingOutcome {
  return { status: "invalid", source, failure: { reasonCode, fieldPath } };
}

export function mappedOutcome(
  source: ProviderSourceIdentity,
  candidates: readonly ProviderAdapterCandidate[],
): ProviderRecordMappingOutcome {
  return {
    status: "mapped",
    source,
    candidates: Object.freeze([...candidates]),
  };
}
