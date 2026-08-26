import {
  normalizedProviderObservationPageSchema,
  type NormalizedProviderObservationPage,
} from "@packscout/contracts";
import { SourceAdapterContractError } from
  "./source-adapter-contract-primitives.ts";

const completedNormalizedProviderObservationPages = new WeakSet<object>();

function freezeValidatedJsonValue<T>(value: T): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    for (const nested of value) freezeValidatedJsonValue(nested);
  } else {
    for (const nested of Object.values(value)) freezeValidatedJsonValue(nested);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

/**
 * Produces and marks the exact detached page accepted by the generic adapter
 * completion boundary. The marker cannot be attached to an unvalidated page.
 */
export function completeNormalizedProviderObservationPage(
  candidate: unknown,
): NormalizedProviderObservationPage {
  try {
    const parsed = normalizedProviderObservationPageSchema.parse(candidate);
    const completed = freezeValidatedJsonValue(parsed);
    completedNormalizedProviderObservationPages.add(completed);
    return completed;
  } catch {
    throw new SourceAdapterContractError("invalid_interpretation_shape");
  }
}

/** Deep-frozen lookalikes cannot forge the completion capability. */
export function isCompletedNormalizedProviderObservationPage(
  value: unknown,
): value is NormalizedProviderObservationPage {
  return typeof value === "object" && value !== null &&
    completedNormalizedProviderObservationPages.has(value);
}
