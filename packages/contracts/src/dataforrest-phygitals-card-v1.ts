import {
  emptyNormalizedProviderFacts,
  type NormalizedCardProviderFacts,
} from "./provider-source-facts-v1.ts";

type NativeObject = Readonly<Record<string, unknown>>;

function object(value: unknown): NativeObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as NativeObject
    : null;
}

function displayName(value: unknown) {
  if (value === undefined || value === null) return { state: "absent" as const };
  if (typeof value !== "string") return { state: "malformed" as const };
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 10_000
    ? { state: "present" as const, value: normalized }
    : { state: "malformed" as const };
}

function imageReferences(value: unknown) {
  if (value === undefined || value === null) return { state: "absent" as const };
  if (typeof value !== "string" || value.length > 2_048) {
    return { state: "malformed" as const };
  }
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" || url.username.length > 0 ||
      url.password.length > 0 || url.hash.length > 0
    ) return { state: "malformed" as const };
    return { state: "present" as const, value: [url.toString()] };
  } catch {
    return { state: "malformed" as const };
  }
}

/**
 * Exact Phygitals catalog-card wrappers observed through Events v1. Envelope
 * record_id remains identity. Nested IDs, owners, metadata, FMV, and prices
 * without a reviewed currency contract never become canonical facts.
 */
export function phygitalsCardProviderFactsV1(
  nativeData: NativeObject,
): NormalizedCardProviderFacts {
  const empty = emptyNormalizedProviderFacts("card") as NormalizedCardProviderFacts;
  const wrappers = ["chase", "asset"].filter((key) => Object.hasOwn(nativeData, key));
  if (wrappers.length === 0) return empty;
  const native = wrappers.length === 1 ? object(nativeData[wrappers[0]!]) : null;
  if (native === null) {
    return { ...empty, displayName: { state: "malformed" } };
  }
  return {
    ...empty,
    displayName: displayName(native.name),
    imageReferences: imageReferences(native.image),
  };
}
