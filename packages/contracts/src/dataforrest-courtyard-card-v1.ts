import {
  emptyNormalizedProviderFacts,
  type NormalizedCardProviderFacts,
} from "./provider-source-facts-v1.ts";

type NativeObject = Readonly<Record<string, unknown>>;

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
 * Reviewed Courtyard catalog-card labels: supplied asset.title takes precedence
 * over reveal.title. A malformed selected wrapper never falls through, and an
 * image is read only from that same wrapper. Envelope record_id alone remains
 * identity; native IDs, prices/history, owners and financial hints stay opaque.
 */
export function courtyardCardProviderFactsV1(nativeData: NativeObject): NormalizedCardProviderFacts {
  const empty = emptyNormalizedProviderFacts("card") as NormalizedCardProviderFacts;
  const wrapper = Object.hasOwn(nativeData, "asset") ? "asset"
    : Object.hasOwn(nativeData, "reveal") ? "reveal" : null;
  if (wrapper === null) return empty;
  const native = nativeData[wrapper];
  if (native === null || typeof native !== "object" || Array.isArray(native)) {
    return { ...empty, displayName: { state: "malformed" } };
  }
  const selected = native as NativeObject;
  return {
    ...empty,
    displayName: displayName(selected.title),
    imageReferences: imageReferences(selected[wrapper === "asset" ? "imageUrl" : "image"]),
  };
}
