import {
  emptyNormalizedProviderFacts,
  type NormalizedCardProviderFacts,
} from "./provider-source-facts-v1.ts";

type NativeJsonObject = Readonly<Record<string, unknown>>;

const imageFields = Object.freeze([
  "front_image_url",
  "front_image_medium_url",
  "front_image_thumbnail_url",
  "back_image_url",
  "back_image_medium_url",
  "back_image_thumbnail_url",
] as const);

const formattedUsdPattern =
  /^\$?(?:(?:0|[1-9]\d*)|(?:[1-9]\d{0,2}(?:,\d{3})+))(?:\.\d+)?$/u;

function nativeObject(value: unknown): NativeJsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as NativeJsonObject
    : null;
}

function normalizedTextFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  if (typeof value !== "string") {
    return { state: "malformed" as const };
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 10_000
    ? { state: "present" as const, value: normalized }
    : { state: "malformed" as const };
}

function imageReferences(asset: NativeJsonObject) {
  const values: string[] = [];
  for (const field of imageFields) {
    const value = asset[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") {
      return { state: "malformed" as const };
    }
    const normalized = value.trim();
    if (normalized.length === 0 || normalized.length > 2_048) {
      return { state: "malformed" as const };
    }
    if (!values.includes(normalized)) values.push(normalized);
  }
  return values.length === 0
    ? { state: "absent" as const }
    : { state: "present" as const, value: values };
}

function estimatedValue(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  if (typeof value !== "string") {
    return { state: "malformed" as const };
  }
  const normalized = value.trim();
  if (!formattedUsdPattern.test(normalized)) {
    return { state: "malformed" as const };
  }
  const amount = Number(normalized.replace("$", "").replaceAll(",", ""));
  return Number.isFinite(amount) && amount >= 0
    ? { state: "present" as const, value: { amount, currency: "USD" as const } }
    : { state: "malformed" as const };
}

/** Exact allowlist for the evidenced ClutchPacks V1 catalog-card shape. */
export function clutchpacksCardProviderFacts(
  nativeData: NativeJsonObject,
): NormalizedCardProviderFacts {
  const empty = emptyNormalizedProviderFacts(
    "card",
  ) as NormalizedCardProviderFacts;
  const asset = nativeObject(nativeData.asset);
  if (asset === null) {
    if (nativeData.asset === undefined || nativeData.asset === null) return empty;
    const malformed = { state: "malformed" as const };
    return {
      ...empty,
      displayName: malformed,
      description: malformed,
      category: malformed,
      imageReferences: malformed,
      estimatedValue: malformed,
    };
  }
  const value = estimatedValue(asset.formatted_current_price);
  return {
    ...empty,
    // `title` is the provider's complete card display title; `name` is only
    // the subject name and remains protected native provenance.
    displayName: normalizedTextFact(asset.title),
    description: normalizedTextFact(asset.description),
    category: normalizedTextFact(asset.subtype),
    imageReferences: imageReferences(asset),
    estimatedValue: value,
    valueSource: value.state === "present"
      ? {
          state: "present",
          value: "clutchpacks_formatted_current_price",
        }
      : empty.valueSource,
  };
}
