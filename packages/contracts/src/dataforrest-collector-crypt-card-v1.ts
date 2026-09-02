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

function safeImageUrl(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" || url.username.length > 0 ||
      url.password.length > 0 || url.hash.length > 0
    ) return false;
    return url.toString();
  } catch {
    return false;
  }
}

function imageReferences(value: unknown) {
  if (value === undefined || value === null) return { state: "absent" as const };
  const images = object(value);
  if (images === null) return { state: "malformed" as const };
  const references: string[] = [];
  for (const field of ["frontImage", "backImage"] as const) {
    const reference = safeImageUrl(images[field]);
    if (reference === false) return { state: "malformed" as const };
    if (reference !== null && !references.includes(reference)) references.push(reference);
  }
  return references.length === 0
    ? { state: "absent" as const }
    : { state: "present" as const, value: references };
}

/**
 * Exact reviewed Collector Crypt catalog-card shape. Only asset.itemName and
 * asset.images front/back URLs become facts. Detail labels, category, value,
 * native IDs, ownership, and other native metadata remain opaque.
 */
export function collectorCryptCardProviderFactsV1(
  nativeData: NativeObject,
): NormalizedCardProviderFacts {
  const empty = emptyNormalizedProviderFacts("card") as NormalizedCardProviderFacts;
  if (!Object.hasOwn(nativeData, "asset")) return empty;
  const asset = object(nativeData.asset);
  if (asset === null) {
    return {
      ...empty,
      displayName: { state: "malformed" },
      imageReferences: { state: "malformed" },
    };
  }
  return {
    ...empty,
    displayName: displayName(asset.itemName),
    imageReferences: imageReferences(asset.images),
  };
}
