import {
  SourceAdapterContractError,
  canonicalizeConfiguration,
  hasExactKeys,
  isRecord,
} from "./source-adapter-contract-primitives.ts";

export type ProtectedNativeEvidence = readonly Readonly<{
  reference: string;
  value: Readonly<Record<string, unknown>>;
}>[];

const trustedProtectedNativeEvidence = new WeakSet<object>();

function invalidEvidence(): never {
  throw new TypeError("source_adapter.trusted_evidence_invalid");
}

function validateJsonArrayShape(value: readonly unknown[]): void {
  if (Object.getPrototypeOf(value) !== Array.prototype) invalidEvidence();
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== value.length + 1 ||
    ownKeys.some((key) => typeof key !== "string")
  ) {
    invalidEvidence();
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined ||
    lengthDescriptor.enumerable ||
    !("value" in lengthDescriptor) ||
    lengthDescriptor.value !== value.length
  ) {
    invalidEvidence();
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      invalidEvidence();
    }
  }
}

function freezeJsonValue(
  value: unknown,
  ancestors: Set<object>,
): void {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || ancestors.has(value)) {
    invalidEvidence();
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    validateJsonArrayShape(value);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !("value" in descriptor)) {
        invalidEvidence();
      }
      freezeJsonValue(descriptor.value, ancestors);
    }
  } else {
    if (!isRecord(value)) {
      invalidEvidence();
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        invalidEvidence();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        invalidEvidence();
      }
      freezeJsonValue(descriptor.value, ancestors);
    }
  }
  ancestors.delete(value);
  Object.freeze(value);
}

/**
 * Seals evidence assembled from the fixed in-package interpreter without a
 * second full object-tree copy. External adapters cannot forge the WeakSet
 * capability and continue through generic defensive canonicalization.
 */
export function sealTrustedProtectedNativeEvidence<T extends ProtectedNativeEvidence>(
  evidence: T,
): T {
  if (!Array.isArray(evidence)) {
    invalidEvidence();
  }
  freezeJsonValue(evidence, new Set());
  for (const item of evidence) {
    if (
      !hasExactKeys(item, ["reference", "value"]) ||
      typeof item.reference !== "string" ||
      !isRecord(item.value)
    ) {
      invalidEvidence();
    }
  }
  trustedProtectedNativeEvidence.add(evidence);
  return evidence;
}

export function isTrustedProtectedNativeEvidence(
  evidence: unknown,
): boolean {
  return typeof evidence === "object" &&
    evidence !== null &&
    trustedProtectedNativeEvidence.has(evidence);
}

/**
 * Preserves evidence sealed by the fixed interpreter and defensively
 * canonicalizes every other adapter-owned evidence tree.
 */
export function canonicalizeProtectedNativeEvidence(
  evidence: unknown,
): ProtectedNativeEvidence {
  if (isTrustedProtectedNativeEvidence(evidence)) {
    return evidence as ProtectedNativeEvidence;
  }
  if (!Array.isArray(evidence)) {
    throw new SourceAdapterContractError("invalid_interpretation_shape");
  }
  try {
    return Object.freeze(evidence.map((item) => {
      if (
        !hasExactKeys(item, ["reference", "value"]) ||
        typeof item.reference !== "string" ||
        !isRecord(item.value)
      ) {
        throw new SourceAdapterContractError("invalid_interpretation_shape");
      }
      return Object.freeze({
        reference: item.reference,
        value: canonicalizeConfiguration(item.value),
      });
    }));
  } catch (error) {
    if (error instanceof SourceAdapterContractError) throw error;
    throw new SourceAdapterContractError("invalid_interpretation_shape");
  }
}
