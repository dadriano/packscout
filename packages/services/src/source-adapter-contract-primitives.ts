import {
  opaqueCheckpointEnvelopeSchema,
  providerSourceRequestBoundsSchema,
  recordIdScopeDeclarationSchema,
  type OpaqueCheckpointEnvelope,
  type ProviderSourceRequestBounds,
  type RecordIdScopeDeclaration,
} from "@packscout/contracts";

export type SourceAdapterContractErrorCode =
  | "abort_signal_mismatch"
  | "invalid_interpretation_shape"
  | "invalid_operation_shape"
  | "invalid_request_capture"
  | "invalid_terminalization_receipt";

export class SourceAdapterContractError extends Error {
  readonly code: SourceAdapterContractErrorCode;

  constructor(code: SourceAdapterContractErrorCode) {
    super(`source_adapter_contract.${code}`);
    this.name = "SourceAdapterContractError";
    this.code = code;
  }
}

interface CapturableSourceAdapterOperation {
  readonly requestLease: Readonly<{ state: string }>;
}

export function createSourceAdapterCaptureInvocationCapability<
  Operation extends CapturableSourceAdapterOperation,
>() {
  const issueAuthority = Symbol("source-adapter-capture-invocation-authority");

  class CaptureInvocation {
    readonly #operation: Operation;
    #consumed = false;

    constructor(authority: symbol, operation: Operation) {
      if (authority !== issueAuthority) {
        throw new SourceAdapterContractError("invalid_request_capture");
      }
      this.#operation = operation;
    }

    consume(operation: Operation): void {
      if (
        this.#consumed ||
        operation !== this.#operation ||
        operation.requestLease.state !== "consumed"
      ) {
        throw new SourceAdapterContractError("invalid_request_capture");
      }
      this.#consumed = true;
    }
  }

  return Object.freeze({
    CaptureInvocation,
    issue: (operation: Operation) => new CaptureInvocation(issueAuthority, operation),
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  const actual = (keys as string[]).sort();
  const expected = [...expectedKeys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

export function isDeepFrozenJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    return Object.isFrozen(value) &&
      keys.length === value.length &&
      keys.every((key, index) => key === String(index)) &&
      value.every(isDeepFrozenJsonValue);
  }
  if (!isRecord(value) || !Object.isFrozen(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.every((key) => {
    if (typeof key !== "string") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined &&
      descriptor.enumerable &&
      "value" in descriptor &&
      isDeepFrozenJsonValue(descriptor.value);
  });
}

export function canonicalizeJsonValue(
  value: unknown,
  ancestors: ReadonlySet<object>,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null) {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
  if (ancestors.has(value)) {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    const keys = Object.keys(value);
    if (
      keys.length !== value.length ||
      keys.some((key, index) => key !== String(index))
    ) {
      throw new SourceAdapterContractError("invalid_operation_shape");
    }
    return Object.freeze(
      value.map((item) => canonicalizeJsonValue(item, nextAncestors)),
    );
  }
  if (!isRecord(value)) {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
  const output: Record<string, unknown> = {};
  for (const key of (ownKeys as string[]).sort()) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    ) {
      throw new SourceAdapterContractError("invalid_operation_shape");
    }
    Object.defineProperty(output, key, {
      configurable: false,
      enumerable: true,
      value: canonicalizeJsonValue(descriptor.value, nextAncestors),
      writable: false,
    });
  }
  return Object.freeze(output);
}

export function canonicalizeConfiguration(
  configuration: unknown,
): Readonly<Record<string, unknown>> {
  const value = canonicalizeJsonValue(configuration, new Set());
  if (!isRecord(value)) {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
  return value;
}

export function canonicalizeRecordIdScopes(
  scopes: unknown,
): readonly RecordIdScopeDeclaration[] {
  if (!Array.isArray(scopes)) {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
  try {
    const canonical = scopes
      .map((scope) =>
        canonicalizeJsonValue(
          recordIdScopeDeclarationSchema.parse(scope),
          new Set(),
        ) as RecordIdScopeDeclaration
      )
      .sort((left, right) =>
        left.recordIdScopeKey.localeCompare(right.recordIdScopeKey)
      );
    if (
      new Set(canonical.map(({ recordIdScopeKey }) => recordIdScopeKey)).size !==
        canonical.length
    ) {
      throw new SourceAdapterContractError("invalid_operation_shape");
    }
    return Object.freeze(canonical);
  } catch (error) {
    if (error instanceof SourceAdapterContractError) throw error;
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
}

export function canonicalizeBounds(
  bounds: unknown,
): ProviderSourceRequestBounds {
  try {
    return Object.freeze(providerSourceRequestBoundsSchema.parse(bounds));
  } catch {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
}

export function canonicalizeCheckpoint(
  checkpoint: unknown,
): OpaqueCheckpointEnvelope {
  try {
    return Object.freeze(opaqueCheckpointEnvelopeSchema.parse(checkpoint));
  } catch {
    throw new SourceAdapterContractError("invalid_operation_shape");
  }
}
