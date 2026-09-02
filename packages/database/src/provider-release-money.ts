import {
  normalizeExactDecimal,
  publicConfidenceSchema,
  publicCurrencyKeySchema,
  type PublicCollectible,
  type PublicRepackDetail,
} from "@packscout/contracts";

export class ProviderReleaseValueError extends Error {
  readonly code = "PROVIDER_PUBLIC_VALUE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "ProviderReleaseValueError";
  }
}

export const PROVIDER_RELEASE_CURRENCY_EXPONENTS = Object.freeze({
  AUD: 2,
  CAD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  KRW: 0,
  USD: 2,
  USDC: 6,
  USDT: 6,
} satisfies Readonly<Record<string, number>>);

const TOKEN_ADDRESS_CURRENCY_PATTERN = /^0x[0-9A-Fa-f]{40}$/u;
const ISO_DISPLAY_CURRENCY_PATTERN = /^[A-Z]{3}$/u;

function normalizedReason(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]+/gu, "_");
}

function priceUnavailableReason(
  value: string | null,
  fallback: "PRICE_UNAVAILABLE" | "CURRENCY_UNSUPPORTED",
): "PRICE_UNAVAILABLE" | "CURRENCY_UNSUPPORTED" {
  if (value === null) return fallback;
  switch (normalizedReason(value)) {
    case "PRICE_UNAVAILABLE":
    case "SOURCE_UNAVAILABLE":
    case "UNAVAILABLE":
      return "PRICE_UNAVAILABLE";
    case "CURRENCY_UNSUPPORTED":
      return "CURRENCY_UNSUPPORTED";
    default:
      throw new ProviderReleaseValueError("A public price unavailable reason is invalid.");
  }
}

function vendorUnavailableReason(
  value: string | null,
  fallback: "NOT_REPORTED" | "PRICE_UNAVAILABLE" | "CURRENCY_UNSUPPORTED",
): "NOT_REPORTED" | "PRICE_UNAVAILABLE" | "CURRENCY_UNSUPPORTED" {
  if (value === null) return fallback;
  switch (normalizedReason(value)) {
    case "NOT_REPORTED":
    case "SOURCE_UNAVAILABLE":
    case "UNAVAILABLE":
      return "NOT_REPORTED";
    case "PRICE_UNAVAILABLE":
      return "PRICE_UNAVAILABLE";
    case "CURRENCY_UNSUPPORTED":
      return "CURRENCY_UNSUPPORTED";
    default:
      throw new ProviderReleaseValueError("A vendor EV unavailable reason is invalid.");
  }
}

function roundedScaledInteger(value: string, exponent: number): number {
  const normalized = normalizeExactDecimal(value);
  const [integer = "0", fraction = ""] = normalized.split(".");
  const kept = fraction.slice(0, exponent).padEnd(exponent, "0");
  const discarded = fraction.slice(exponent);
  let scaled = BigInt(`${integer}${kept}` || "0");
  if (discarded.length > 0 && discarded[0]! >= "5") scaled += 1n;
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProviderReleaseValueError("A public money value exceeds safe integer bounds.");
  }
  return Number(scaled);
}

export function currencyMinorUnits(value: string, currency: string): number | null {
  const isPublicCurrencyKey = publicCurrencyKeySchema.safeParse(currency).success;
  if (!isPublicCurrencyKey && !TOKEN_ADDRESS_CURRENCY_PATTERN.test(currency)) {
    throw new ProviderReleaseValueError("A source currency is invalid.");
  }
  const exponent = PROVIDER_RELEASE_CURRENCY_EXPONENTS[
    currency as keyof typeof PROVIDER_RELEASE_CURRENCY_EXPONENTS
  ];
  return exponent === undefined ? null : roundedScaledInteger(value, exponent);
}

export function decimalBasisPoints(value: string): number {
  const result = roundedScaledInteger(value, 4);
  if (result < 0 || result > 10_000) {
    throw new ProviderReleaseValueError("A public rate is outside basis-point bounds.");
  }
  return result;
}

function roundedRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    throw new ProviderReleaseValueError("Comparable price must be positive for EV metrics.");
  }
  const top = BigInt(numerator) * 10_000n;
  const bottom = BigInt(denominator);
  const rounded = (top + bottom / 2n) / bottom;
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ProviderReleaseValueError("A public EV ratio exceeds safe integer bounds.");
  }
  return Number(rounded);
}

function metrics(grossEvMinor: number, priceMinor: number) {
  const grossReturnBasisPoints = roundedRatio(grossEvMinor, priceMinor);
  const evDollarsMinor = grossEvMinor - priceMinor;
  if (!Number.isSafeInteger(evDollarsMinor)) {
    throw new ProviderReleaseValueError("A public EV delta exceeds safe integer bounds.");
  }
  return {
    grossEv: { minorUnits: grossEvMinor, currency: "USD" as const },
    grossReturnBasisPoints,
    evDollars: { minorUnits: evDollarsMinor, currency: "USD" as const },
    evPercentBasisPoints: grossReturnBasisPoints - 10_000,
  };
}

export function publicPrice(input: {
  readonly amount: string | null;
  readonly currency: string | null;
  readonly usdAmount: string | null;
  readonly unavailableReason: string | null;
}): PublicRepackDetail["price"] {
  if (input.amount === null || input.currency === null) {
    if (input.amount !== input.currency) {
      throw new ProviderReleaseValueError("A source price amount and currency must be paired.");
    }
    if (input.usdAmount !== null) {
      throw new ProviderReleaseValueError("A USD price cannot exist without its source price.");
    }
    return {
      displayMoney: null,
      usdComparison: {
        status: "unavailable",
        value: null,
        reason: priceUnavailableReason(input.unavailableReason, "PRICE_UNAVAILABLE"),
      },
    };
  }
  const sourceMinor = currencyMinorUnits(input.amount, input.currency);
  const displayMoney = ISO_DISPLAY_CURRENCY_PATTERN.test(input.currency) &&
      sourceMinor !== null
    ? { minorUnits: sourceMinor, currency: input.currency }
    : null;
  const usdMinor = input.usdAmount === null
    ? input.currency === "USD" ? currencyMinorUnits(input.amount, "USD") : null
    : currencyMinorUnits(input.usdAmount, "USD");
  if (usdMinor !== null && input.unavailableReason !== null) {
    throw new ProviderReleaseValueError("An available USD price has an unavailable reason.");
  }
  return {
    displayMoney,
    usdComparison: usdMinor === null
      ? {
          status: "unavailable",
          value: null,
          reason: priceUnavailableReason(
            input.unavailableReason,
            "CURRENCY_UNSUPPORTED",
          ),
        }
      : { status: "available", value: { minorUnits: usdMinor, currency: "USD" } },
  };
}

export function publicBuyback(input: {
  readonly rate: string | null;
  readonly sourceKind: string | null;
}): PublicRepackDetail["buyback"] {
  if (input.rate === null || input.sourceKind === null) {
    if (input.rate !== input.sourceKind) {
      throw new ProviderReleaseValueError("A buyback rate and source must be paired.");
    }
    return { status: "unavailable", value: null, reason: "BUYBACK_UNAVAILABLE" };
  }
  const normalizedSourceKind = normalizedReason(input.sourceKind);
  const sourceKind = [
    "PROVIDER",
    "PROVIDER_STATEMENT",
    "VENDOR",
    "VENDOR_REPORTED",
  ].includes(normalizedSourceKind)
    ? "vendor_reported" as const
    : ["PACKSCOUT", "PACKSCOUT_DERIVED", "DERIVED"].includes(
        normalizedSourceKind,
      )
      ? "packscout_derived" as const
      : null;
  if (sourceKind === null) {
    throw new ProviderReleaseValueError("A buyback source kind is invalid.");
  }
  return {
    status: "available",
    value: {
      basisPoints: decimalBasisPoints(input.rate),
      sourceKind,
    },
  };
}

export function publicVendorEv(input: {
  readonly amount: string | null;
  readonly currency: string | null;
  readonly observedAt: Date | null;
  readonly unavailableReason: string | null;
  readonly priceUsdMinor: number | null;
}): PublicRepackDetail["evEstimates"]["vendorReported"] {
  if (input.amount === null || input.currency === null) {
    if (input.amount !== input.currency) {
      throw new ProviderReleaseValueError("Vendor EV amount and currency must be paired.");
    }
    return {
      status: "unavailable",
      displayMoney: null,
      metrics: null,
      observedAt: input.observedAt?.toISOString() ?? null,
      reason: vendorUnavailableReason(input.unavailableReason, "NOT_REPORTED"),
    };
  }
  const reportedMinor = currencyMinorUnits(input.amount, input.currency);
  const displayMoney = reportedMinor === null ||
      !ISO_DISPLAY_CURRENCY_PATTERN.test(input.currency)
    ? null
    : { minorUnits: reportedMinor, currency: input.currency };
  if (input.currency === "USD" && reportedMinor !== null && input.priceUsdMinor !== null) {
    if (input.unavailableReason !== null) {
      throw new ProviderReleaseValueError("Available vendor EV has an unavailable reason.");
    }
    if (input.observedAt === null) {
      throw new ProviderReleaseValueError("Available vendor EV requires an observation time.");
    }
    return {
      status: "available",
      displayMoney: { minorUnits: reportedMinor, currency: "USD" },
      metrics: metrics(reportedMinor, input.priceUsdMinor),
      observedAt: input.observedAt.toISOString(),
    };
  }
  const reason = vendorUnavailableReason(
    input.unavailableReason,
    displayMoney === null || input.priceUsdMinor !== null
      ? "CURRENCY_UNSUPPORTED"
      : "PRICE_UNAVAILABLE",
  );
  if (reason === "NOT_REPORTED" && displayMoney !== null) {
    throw new ProviderReleaseValueError("Reported vendor EV cannot be marked not reported.");
  }
  return {
    status: "unavailable",
    displayMoney,
    metrics: null,
    observedAt: input.observedAt?.toISOString() ?? null,
    reason,
  };
}

function unavailablePackScoutReason(value: string | null):
  "PRICE_UNAVAILABLE" | "CURRENCY_UNSUPPORTED" | "ESTIMATE_INPUT_INCOMPLETE" {
  if (value === "PRICE_UNAVAILABLE" || value === "price_unavailable") return "PRICE_UNAVAILABLE";
  if (value === "CURRENCY_UNSUPPORTED" || value === "currency_unsupported") return "CURRENCY_UNSUPPORTED";
  return "ESTIMATE_INPUT_INCOMPLETE";
}

export function publicPackScoutEv(input: {
  readonly amount: string | null;
  readonly currency: string | null;
  readonly modelVersion: string;
  readonly confidencePolicyVersion: string;
  readonly confidence: unknown;
  readonly dataAsOf: Date | null;
  readonly calculatedAt: Date | null;
  readonly unavailableReason: string | null;
  readonly priceUsdMinor: number | null;
}): PublicRepackDetail["evEstimates"]["packScout"] {
  if ((input.amount === null) !== (input.currency === null)) {
    throw new ProviderReleaseValueError("PackScout EV amount and currency must be paired.");
  }
  const base = {
    modelVersion: input.modelVersion,
    confidencePolicyVersion: input.confidencePolicyVersion,
  };
  const confidence = input.confidence === null
    ? null
    : publicConfidenceSchema.parse(input.confidence);
  if (
    input.amount !== null
    && input.currency === "USD"
    && input.priceUsdMinor !== null
    && confidence !== null
    && input.dataAsOf !== null
    && input.calculatedAt !== null
  ) {
    if (input.unavailableReason !== null) {
      throw new ProviderReleaseValueError("Available PackScout EV has an unavailable reason.");
    }
    const grossMinor = currencyMinorUnits(input.amount, "USD");
    if (grossMinor === null) throw new ProviderReleaseValueError("USD exponent is unavailable.");
    return {
      status: "available",
      metrics: metrics(grossMinor, input.priceUsdMinor),
      confidence,
      ...base,
      dataAsOf: input.dataAsOf.toISOString(),
      calculatedAt: input.calculatedAt.toISOString(),
    };
  }
  return {
    status: "unavailable",
    metrics: null,
    confidence: null,
    ...base,
    dataAsOf: input.dataAsOf?.toISOString() ?? null,
    calculatedAt: input.calculatedAt?.toISOString() ?? null,
    reason: input.priceUsdMinor === null
      ? "PRICE_UNAVAILABLE"
      : input.amount !== null && input.currency !== "USD"
        ? "CURRENCY_UNSUPPORTED"
        : unavailablePackScoutReason(input.unavailableReason),
  };
}

export function publicValuation(
  collectible: {
    readonly valuationAmount: string | null;
    readonly valuationCurrency: string | null;
    readonly valuationUsdAmount: string | null;
    readonly valuationUnavailableReason:
      | "VALUATION_UNAVAILABLE"
      | "CURRENCY_UNSUPPORTED"
      | null;
    readonly valuationType: string | null;
    readonly valuationObservedAt: string | null;
  },
): PublicCollectible["valuation"] {
  if ((collectible.valuationAmount === null) !== (collectible.valuationCurrency === null)) {
    throw new ProviderReleaseValueError("A valuation amount and currency must be paired.");
  }
  if ((collectible.valuationType === null) !== (collectible.valuationObservedAt === null)) {
    throw new ProviderReleaseValueError("A valuation type and observation must be paired.");
  }
  if (collectible.valuationUnavailableReason !== null && ![
    "VALUATION_UNAVAILABLE",
    "CURRENCY_UNSUPPORTED",
  ].includes(collectible.valuationUnavailableReason)) {
    throw new ProviderReleaseValueError("A valuation unavailable reason is invalid.");
  }
  if (collectible.valuationType === null || collectible.valuationObservedAt === null) {
    if (
      collectible.valuationAmount !== null
      || collectible.valuationCurrency !== null
      || collectible.valuationUsdAmount !== null
      || collectible.valuationUnavailableReason !== null
    ) {
      throw new ProviderReleaseValueError("Valuation evidence requires a public descriptor.");
    }
    return null;
  }
  const sourceMinor = collectible.valuationAmount === null
    ? null
    : currencyMinorUnits(
        collectible.valuationAmount,
        collectible.valuationCurrency!,
      );
  const displayMoney = collectible.valuationCurrency !== null
      && ISO_DISPLAY_CURRENCY_PATTERN.test(collectible.valuationCurrency)
      && sourceMinor !== null
    ? { minorUnits: sourceMinor, currency: collectible.valuationCurrency }
    : null;
  const usdMinor = collectible.valuationUsdAmount === null
    ? collectible.valuationCurrency === "USD" ? sourceMinor : null
    : currencyMinorUnits(collectible.valuationUsdAmount, "USD");
  if (usdMinor !== null && collectible.valuationUnavailableReason !== null) {
    throw new ProviderReleaseValueError("An available USD valuation has an unavailable reason.");
  }
  if (
    usdMinor === null
    && collectible.valuationAmount === null
    && collectible.valuationUnavailableReason === null
  ) {
    throw new ProviderReleaseValueError("An unavailable valuation requires an explicit reason.");
  }
  const unavailableReason: "VALUATION_UNAVAILABLE" | "CURRENCY_UNSUPPORTED" =
    collectible.valuationUnavailableReason ?? "CURRENCY_UNSUPPORTED";
  return {
    displayMoney,
    usdComparison: usdMinor === null
      ? { status: "unavailable", value: null, reason: unavailableReason }
      : { status: "available", value: { minorUnits: usdMinor, currency: "USD" } },
    valuationType: collectible.valuationType as NonNullable<PublicCollectible["valuation"]>["valuationType"],
    observedAt: new Date(collectible.valuationObservedAt).toISOString(),
  };
}
