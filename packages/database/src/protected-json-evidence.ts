const maximumExternalIdLength = 512;
const maximumPostgresJsonDepth = 64;
const maximumInspectedJsonNodes = 100_000;
const unpairedSurrogate = /[\ud800-\udfff]/u;
const serializedUnsupportedPostgresEscape =
  /\\u(?:0000|d[89a-f][0-9a-f]{2})/iu;
const protectedJsonEnvelopeKey = "__packscout_protected_json_v1";
const unavailableEvidence = {
  encoding: "json-unavailable-v1",
  reason: "protected_evidence_unavailable",
} as const;

/**
 * PostgreSQL JSONB cannot represent U+0000, unpaired UTF-16 surrogates, or
 * arbitrarily deep JSON. Preserve invalid provider evidence as exact JSON text
 * inside a tagged JSON-safe envelope instead of rejecting valid siblings in
 * the same page transaction.
 */
export function databaseSafeProtectedJsonEvidence(value: unknown): unknown {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return protectedJsonEnvelope({
      kind: "unavailable",
      reason: "serialization_failed",
    });
  }
  if (serialized === undefined) {
    return protectedJsonEnvelope({
      kind: "unavailable",
      reason: "serialization_failed",
    });
  }
  if (
    serializedUnsupportedPostgresEscape.test(serialized) ||
    exceedsSafePostgresJsonShape(value)
  ) {
    return protectedJsonEnvelope({ kind: "text", json: serialized });
  }
  return protectedJsonEnvelope({ kind: "value", value });
}

export function decodeDatabaseSafeProtectedJsonEvidence(value: unknown): unknown {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !(protectedJsonEnvelopeKey in value)
  ) {
    return value;
  }
  const envelope = value[protectedJsonEnvelopeKey];
  if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
    return unavailableEvidence;
  }
  if (
    "kind" in envelope &&
    envelope.kind === "value" &&
    Object.keys(envelope).length === 2 &&
    "value" in envelope
  ) {
    return envelope.value;
  }
  if (
    "kind" in envelope &&
    envelope.kind === "text" &&
    Object.keys(envelope).length === 2 &&
    "json" in envelope &&
    typeof envelope.json === "string"
  ) {
    try {
      return JSON.parse(envelope.json) as unknown;
    } catch {
      return unavailableEvidence;
    }
  }
  if (
    "kind" in envelope &&
    envelope.kind === "unavailable" &&
    Object.keys(envelope).length === 2 &&
    "reason" in envelope &&
    envelope.reason === "serialization_failed"
  ) {
    return unavailableEvidence;
  }
  return unavailableEvidence;
}

export function databaseSafeQuarantineExternalId(
  value: string | null,
): string | null {
  if (
    value === null ||
    value.length === 0 ||
    value.length > maximumExternalIdLength ||
    containsUnsafeExternalIdControl(value) ||
    unpairedSurrogate.test(value)
  ) {
    return null;
  }
  return value;
}

function containsUnsafeExternalIdControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function exceedsSafePostgresJsonShape(value: unknown): boolean {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value, depth: 0 },
  ];
  let inspectedNodes = 0;

  try {
    while (pending.length > 0) {
      const current = pending.pop()!;
      inspectedNodes += 1;
      if (
        current.depth > maximumPostgresJsonDepth ||
        inspectedNodes > maximumInspectedJsonNodes
      ) {
        return true;
      }
      if (typeof current.value !== "object" || current.value === null) {
        continue;
      }
      const nextDepth = current.depth + 1;
      for (const nested of Array.isArray(current.value)
        ? current.value
        : Object.values(current.value)) {
        pending.push({ value: nested, depth: nextDepth });
      }
    }
  } catch {
    return true;
  }

  return false;
}

function protectedJsonEnvelope(value: Readonly<Record<string, unknown>>): unknown {
  return { [protectedJsonEnvelopeKey]: value };
}
