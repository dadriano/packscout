import {
  SourceAdapterContractError,
  canonicalizeJsonValue,
} from "./source-adapter-contract-primitives.ts";

/**
 * Creates one runtime-private registry for completed operation results. A
 * separately-created registry cannot mint values accepted by the caller's
 * assertion closure.
 */
export function createSourceAdapterOperationResultCapability() {
  const registeredResults = new WeakSet<object>();

  return Object.freeze({
    register<TValue extends object>(result: TValue): TValue {
      registeredResults.add(result);
      return result;
    },
    has(result: object): boolean {
      return registeredResults.has(result);
    },
  });
}

/** Copies adapter-owned JSON before runtime registration and freezes it deeply. */
export function canonicalizeSourceAdapterResultValue<TValue>(
  value: TValue,
): TValue {
  try {
    return canonicalizeJsonValue(value, new Set()) as TValue;
  } catch {
    throw new SourceAdapterContractError("invalid_interpretation_shape");
  }
}
