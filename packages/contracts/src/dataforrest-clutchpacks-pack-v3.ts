import {
  emptyNormalizedProviderFacts,
  type NormalizedEvBucket,
  type NormalizedPackProviderFacts,
} from "./provider-source-facts-v1.ts";
import { parseClutchpacksPackMembershipV1 } from "./clutchpacks-pack-membership-v1.ts";

function packMembershipFact(nativeData: NativeJsonObject): NormalizedPackProviderFacts["packMembership"] {
  try {
    const parsed = parseClutchpacksPackMembershipV1(nativeData);
    return parsed === null ? undefined : { state: "present", value: parsed.membership };
  } catch {
    return { state: "malformed" };
  }
}

type NativeJsonObject = Readonly<Record<string, unknown>>;

const plainUsdPattern =
  /^(?:(?:0|[1-9]\d*)|(?:[1-9]\d{0,2}(?:,\d{3})+))(?:\.\d{1,2})?$/u;
const formattedUsdPattern =
  /^\$(?:(?:0|[1-9]\d*)|(?:[1-9]\d{0,2}(?:,\d{3})+))(?:\.\d{1,2})?$/u;
const exactNinetyPercentBuybackStatement =
  "Instant buyback offer of 90%. One graded or authenticated card per pack.";

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

function categoryFact(collectionTypeValue: unknown, categoryValue: unknown) {
  if (collectionTypeValue !== undefined && collectionTypeValue !== null) {
    const collectionType = nativeObject(collectionTypeValue);
    return collectionType === null ||
        collectionType.type === undefined ||
        collectionType.type === null
      ? { state: "malformed" as const }
      : normalizedTextFact(collectionType.type);
  }
  if (categoryValue === undefined || categoryValue === null) {
    return { state: "absent" as const };
  }
  const category = nativeObject(categoryValue);
  return category === null || category.name === undefined || category.name === null
    ? { state: "malformed" as const }
    : normalizedTextFact(category.name);
}

function imageReferencesFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  if (typeof value !== "string") {
    return { state: "malformed" as const };
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 2_048) {
    return { state: "malformed" as const };
  }
  try {
    const url = new URL(normalized);
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hostname.length === 0
    ) {
      return { state: "malformed" as const };
    }
  } catch {
    return { state: "malformed" as const };
  }
  return { state: "present" as const, value: [normalized] };
}

function usdAmount(value: unknown, formatted: boolean): number | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const pattern = formatted ? formattedUsdPattern : plainUsdPattern;
  if (!pattern.test(normalized)) return null;
  const decimal = normalized.replace("$", "").replaceAll(",", "");
  const [whole = "", fraction = ""] = decimal.split(".");
  const wholeAmount = Number(whole);
  const fractionalMinor = Number(fraction.padEnd(2, "0"));
  const minor = wholeAmount * 100 + fractionalMinor;
  if (!Number.isSafeInteger(wholeAmount) || !Number.isSafeInteger(minor)) {
    return null;
  }
  return minor / 100;
}

function priceFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  const price = nativeObject(value);
  const currency = nativeObject(price?.currency);
  const amount = usdAmount(price?.price_amount, false);
  if (
    price === null ||
    currency === null ||
    currency.code !== "USD" ||
    currency.decimals !== 2 ||
    amount === null
  ) {
    return { state: "malformed" as const };
  }
  return {
    state: "present" as const,
    value: { amount, currency: "USD" as const },
  };
}

function providerReportedEvFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  const amount = usdAmount(value, false);
  return amount === null
    ? { state: "malformed" as const }
    : {
        state: "present" as const,
        value: { amount, currency: "USD" as const },
      };
}

function authoritativeAvailabilityFact(value: unknown) {
  if (value === undefined || value === null || value === false) {
    return { state: "absent" as const };
  }
  if (value !== true) return { state: "malformed" as const };
  return {
    state: "present" as const,
    value: {
      state: "sold_out" as const,
      authority: "provider_explicit_sold_out" as const,
    },
  };
}

function buybackPercentFact(value: unknown) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  const series = nativeObject(value);
  if (series === null) return { state: "malformed" as const };
  const description = series.description;
  if (description === undefined || description === null) {
    return { state: "absent" as const };
  }
  if (typeof description !== "string") {
    return { state: "malformed" as const };
  }
  return description.trim() === exactNinetyPercentBuybackStatement
    ? { state: "present" as const, value: 90 }
    : { state: "absent" as const };
}

function evInputFact(
  value: unknown,
  buybackPercent: ReturnType<typeof buybackPercentFact>,
) {
  if (value === undefined || value === null) {
    return { state: "absent" as const };
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 10_000) {
    return { state: "malformed" as const };
  }

  const buckets: Array<Omit<NormalizedEvBucket, "probability">> = [];
  const bucketIds = new Set<string>();
  for (const candidate of value) {
    const bucket = nativeObject(candidate);
    const bucketId = typeof bucket?.bucket_id === "string"
      ? bucket.bucket_id.trim()
      : "";
    const labelValue = bucket?.name;
    const label = labelValue === undefined || labelValue === null
      ? null
      : typeof labelValue === "string" && labelValue.trim().length > 0 &&
          labelValue.trim().length <= 500
        ? labelValue.trim()
        : undefined;
    const quantity = bucket?.drawable_count;
    const lowerValue = usdAmount(bucket?.min_price, true);
    const upperValue = usdAmount(bucket?.max_price, true);
    if (
      bucket === null ||
      bucketId.length === 0 ||
      bucketId.length > 256 ||
      bucketIds.has(bucketId) ||
      label === undefined ||
      !Number.isSafeInteger(quantity) ||
      (quantity as number) < 0 ||
      lowerValue === null ||
      upperValue === null ||
      lowerValue > upperValue
    ) {
      return { state: "malformed" as const };
    }
    bucketIds.add(bucketId);
    if (quantity === 0) continue;
    buckets.push({
      bucketId,
      label,
      quantity: quantity as number,
      lowerValue,
      upperValue,
    });
  }

  const totalQuantity = buckets.reduce(
    (sum, bucket) => sum + (bucket.quantity ?? 0),
    0,
  );
  if (!Number.isSafeInteger(totalQuantity) || totalQuantity <= 0) {
    return { state: "malformed" as const };
  }
  return {
    state: "present" as const,
    value: {
      approved: true,
      currency: "USD" as const,
      unitBasis: "per_pack" as const,
      drawCount: 1,
      buybackPercent: buybackPercent.state === "present"
        ? buybackPercent.value
        : null,
      totalQuantity,
      buckets: buckets.map((bucket) => ({
        ...bucket,
        probability: (bucket.quantity ?? 0) / totalQuantity,
      })),
    },
  };
}

/** Exact allowlist for the evidenced ClutchPacks V1 catalog-pack shape. */
export function clutchpacksPackProviderFacts(
  nativeData: NativeJsonObject,
): NormalizedPackProviderFacts {
  const empty = emptyNormalizedProviderFacts(
    "pack",
  ) as NormalizedPackProviderFacts;
  const buybackPercent = buybackPercentFact(nativeData.series);
  const packMembership = packMembershipFact(nativeData);
  return {
    ...empty,
    displayName: normalizedTextFact(nativeData.name),
    description: normalizedTextFact(nativeData.description),
    category: categoryFact(nativeData.collection_type, nativeData.category),
    imageReferences: imageReferencesFact(nativeData.image_url),
    price: priceFact(nativeData.price),
    // The official checkout labels this exact raw field as `Average Value`.
    providerReportedEv: providerReportedEvFact(nativeData.average_value),
    buybackPercent,
    drawCount: { state: "present", value: 1 },
    evInput: evInputFact(nativeData.price_bucket_odds, buybackPercent),
    ...(packMembership === undefined ? {} : { packMembership }),
    authoritativeAvailability: authoritativeAvailabilityFact(
      nativeData.sold_out,
    ),
  };
}
