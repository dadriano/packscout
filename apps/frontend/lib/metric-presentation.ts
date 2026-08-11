import type {
  PublicAvailabilityReason,
  PublicBuyback,
  PublicEstimatedEv,
  PublicMoney,
  PublicPrice,
  PublicSignedUsdMoney,
  PublicTopChaseSummary,
  PublicUsdMoney,
} from "@packscout/contracts";
import {
  getPublicReasonCopy,
  METRIC_TRUST_COPY,
  type GlossaryFieldKey,
} from "./metric-vocabulary";

const PRESENTATION_LOCALE = "en-US" as const;

export type MetricSemanticState =
  | "positive"
  | "neutral"
  | "negative"
  | "unavailable";

export type AvailableMetricValue = Readonly<{
  availability: "available";
  label: string;
  displayValue: string;
  accessibleLabel: string;
  glossaryKey: GlossaryFieldKey;
  semanticState?: Exclude<MetricSemanticState, "unavailable">;
  semanticLabel?: "Positive" | "Neutral" | "Negative";
}>;

export type UnavailableMetricValue = Readonly<{
  availability: "unavailable";
  label: string;
  displayValue: "Unavailable";
  accessibleLabel: string;
  glossaryKey: GlossaryFieldKey;
  semanticState: "unavailable";
  semanticLabel: "Unavailable";
  reason: PublicAvailabilityReason;
  reasonCopy: string;
}>;

export type MetricValuePresentation =
  | AvailableMetricValue
  | UnavailableMetricValue;

export type EstimatedEvPresentation = Readonly<{
  availability: "available" | "unavailable";
  semanticState: MetricSemanticState;
  semanticLabel: "Positive" | "Neutral" | "Negative" | "Unavailable";
  accessibleLabel: string;
  reasonCopy?: string;
  evDollars: MetricValuePresentation;
  evPercent: MetricValuePresentation;
  grossEv: MetricValuePresentation;
  packPrice: MetricValuePresentation;
}>;

export type EstimatedEvPresentationInput = Readonly<{
  packPrice: PublicPrice["usdComparison"];
  estimatedEv: Pick<
    PublicEstimatedEv,
    "grossEv" | "evDollars" | "evPercent"
  >;
}>;

type EstimateUnavailableReason = Extract<
  PublicAvailabilityReason,
  "ESTIMATE_INPUT_INCOMPLETE" | "PRICE_UNAVAILABLE" | "CURRENCY_UNSUPPORTED"
>;

export class MetricPresentationConsistencyError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Metric presentation received inconsistent values: ${issues.join("; ")}`);
    this.name = "MetricPresentationConsistencyError";
    this.issues = Object.freeze([...issues]);
  }
}

function currencyFormatter(currency: string, signed: boolean, isZero: boolean) {
  return new Intl.NumberFormat(PRESENTATION_LOCALE, {
    style: "currency",
    currency,
    currencyDisplay: "symbol",
    signDisplay: signed && !isZero ? "always" : "auto",
  });
}

export function formatMoneyMinorUnits(
  money: Pick<PublicMoney, "minorUnits" | "currency">,
  options: Readonly<{ signed?: boolean }> = {},
): string {
  const formatter = currencyFormatter(
    money.currency,
    options.signed === true,
    money.minorUnits === 0,
  );
  const fractionDigits =
    formatter.resolvedOptions().maximumFractionDigits ?? 2;
  return formatter.format(money.minorUnits / 10 ** fractionDigits);
}

export function formatBasisPoints(
  basisPoints: number,
  options: Readonly<{
    signed?: boolean;
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
  }> = {},
): string {
  const minimumFractionDigits = options.minimumFractionDigits ?? 0;
  const maximumFractionDigits =
    options.maximumFractionDigits ?? Math.max(2, minimumFractionDigits);
  return new Intl.NumberFormat(PRESENTATION_LOCALE, {
    style: "percent",
    signDisplay: options.signed === true && basisPoints !== 0 ? "always" : "auto",
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(basisPoints / 10_000);
}

export function formatSignedEvPercent(basisPoints: number): string {
  return formatBasisPoints(basisPoints, {
    signed: true,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function semanticStateForSignedBasisPoints(
  basisPoints: number,
): Exclude<MetricSemanticState, "unavailable"> {
  if (basisPoints > 0) return "positive";
  if (basisPoints < 0) return "negative";
  return "neutral";
}

function semanticLabel(
  state: Exclude<MetricSemanticState, "unavailable">,
): "Positive" | "Neutral" | "Negative" {
  if (state === "positive") return "Positive";
  if (state === "negative") return "Negative";
  return "Neutral";
}

function availableMetric(
  label: string,
  displayValue: string,
  glossaryKey: GlossaryFieldKey,
  state?: Exclude<MetricSemanticState, "unavailable">,
): AvailableMetricValue {
  const stateLabel = state ? semanticLabel(state) : undefined;
  return Object.freeze({
    availability: "available" as const,
    label,
    displayValue,
    glossaryKey,
    accessibleLabel: stateLabel
      ? `${label}: ${displayValue}. ${stateLabel}.`
      : `${label}: ${displayValue}.`,
    ...(state
      ? { semanticState: state, semanticLabel: stateLabel }
      : {}),
  });
}

function unavailableMetric(
  label: string,
  glossaryKey: GlossaryFieldKey,
  reason: PublicAvailabilityReason,
): UnavailableMetricValue {
  const reasonCopy = getPublicReasonCopy(reason);
  return Object.freeze({
    availability: "unavailable" as const,
    label,
    displayValue: "Unavailable" as const,
    glossaryKey,
    semanticState: "unavailable" as const,
    semanticLabel: "Unavailable" as const,
    reason,
    reasonCopy,
    accessibleLabel: `${label}: Unavailable. ${reasonCopy}`,
  });
}

function expectedEstimateUnavailableReason(
  input: EstimatedEvPresentationInput,
): EstimateUnavailableReason | null {
  const { packPrice, estimatedEv } = input;
  if (
    packPrice.status === "unavailable" &&
    packPrice.reason === "PRICE_UNAVAILABLE"
  ) {
    return "PRICE_UNAVAILABLE";
  }
  if (
    (packPrice.status === "unavailable" &&
      packPrice.reason === "CURRENCY_UNSUPPORTED") ||
    (estimatedEv.grossEv.status === "unavailable" &&
      estimatedEv.grossEv.reason === "CURRENCY_UNSUPPORTED")
  ) {
    return "CURRENCY_UNSUPPORTED";
  }
  if (estimatedEv.grossEv.status === "unavailable") {
    return "ESTIMATE_INPUT_INCOMPLETE";
  }
  return null;
}

export function metricPresentationConsistencyIssues(
  input: EstimatedEvPresentationInput,
): readonly string[] {
  const { packPrice, estimatedEv } = input;
  const { grossEv, evDollars, evPercent } = estimatedEv;
  const issues: string[] = [];

  for (const [field, value] of [
    ["packPrice", packPrice],
    ["grossEv", grossEv],
    ["evDollars", evDollars],
  ] as const) {
    if (value.status === "available") {
      if (!Number.isSafeInteger(value.value.minorUnits)) {
        issues.push(`${field} must use safe integer minor units`);
      }
      if (value.value.currency !== "USD") {
        issues.push(`${field} must use canonical USD comparison money`);
      }
    }
  }
  if (
    evPercent.status === "available" &&
    !Number.isSafeInteger(evPercent.value.basisPoints)
  ) {
    issues.push("evPercent must use safe integer basis points");
  }

  const expectedReason = expectedEstimateUnavailableReason(input);
  if (expectedReason === null) {
    if (
      packPrice.status !== "available" ||
      grossEv.status !== "available" ||
      evDollars.status !== "available" ||
      evPercent.status !== "available"
    ) {
      issues.push("the available estimate bundle is incomplete");
    } else {
      const expectedMinorUnits =
        grossEv.value.minorUnits - packPrice.value.minorUnits;
      if (evDollars.value.minorUnits !== expectedMinorUnits) {
        issues.push("EV $ must equal Gross EV minus Pack Price");
      }
    }
  } else {
    if (
      evDollars.status !== "unavailable" ||
      evDollars.reason !== expectedReason
    ) {
      issues.push("EV $ availability reason does not match source evidence");
    }
    if (
      evPercent.status !== "unavailable" ||
      evPercent.reason !== expectedReason
    ) {
      issues.push("EV % availability reason does not match source evidence");
    }
  }

  return Object.freeze(issues);
}

function shouldThrowForConsistencyIssue(): boolean {
  return process.env.NODE_ENV !== "production";
}

function availableMoneyMetric(
  label: string,
  glossaryKey: GlossaryFieldKey,
  money: PublicUsdMoney | PublicSignedUsdMoney,
  options: Readonly<{
    signed?: boolean;
    state?: Exclude<MetricSemanticState, "unavailable">;
  }> = {},
): AvailableMetricValue {
  return availableMetric(
    label,
    formatMoneyMinorUnits(money, { signed: options.signed }),
    glossaryKey,
    options.state,
  );
}

function unavailablePresentation(
  reason: EstimateUnavailableReason,
): EstimatedEvPresentation {
  const reasonCopy = getPublicReasonCopy(reason);
  const evDollars = unavailableMetric("EV $", "evDollars", reason);
  const evPercent = unavailableMetric("EV %", "evPercent", reason);
  const grossEv = unavailableMetric("Gross EV", "grossEv", reason);
  const packPrice = unavailableMetric("Pack Price", "packPrice", reason);
  return Object.freeze({
    availability: "unavailable" as const,
    semanticState: "unavailable" as const,
    semanticLabel: "Unavailable" as const,
    reasonCopy,
    evDollars,
    evPercent,
    grossEv,
    packPrice,
    accessibleLabel: `${METRIC_TRUST_COPY.estimateLabel}: Unavailable. ${reasonCopy}`,
  });
}

export function presentEstimatedEv(
  input: EstimatedEvPresentationInput,
): EstimatedEvPresentation {
  const issues = metricPresentationConsistencyIssues(input);
  if (issues.length > 0) {
    if (shouldThrowForConsistencyIssue()) {
      throw new MetricPresentationConsistencyError(issues);
    }
    return unavailablePresentation("ESTIMATE_INPUT_INCOMPLETE");
  }

  const expectedReason = expectedEstimateUnavailableReason(input);
  const { packPrice, estimatedEv } = input;
  if (expectedReason !== null) {
    const evDollars = unavailableMetric("EV $", "evDollars", expectedReason);
    const evPercent = unavailableMetric("EV %", "evPercent", expectedReason);
    const grossEv =
      estimatedEv.grossEv.status === "available"
        ? availableMoneyMetric("Gross EV", "grossEv", estimatedEv.grossEv.value)
        : unavailableMetric(
            "Gross EV",
            "grossEv",
            estimatedEv.grossEv.reason,
          );
    const presentedPackPrice =
      packPrice.status === "available"
        ? availableMoneyMetric("Pack Price", "packPrice", packPrice.value)
        : unavailableMetric("Pack Price", "packPrice", packPrice.reason);
    const reasonCopy = getPublicReasonCopy(expectedReason);
    return Object.freeze({
      availability: "unavailable" as const,
      semanticState: "unavailable" as const,
      semanticLabel: "Unavailable" as const,
      reasonCopy,
      evDollars,
      evPercent,
      grossEv,
      packPrice: presentedPackPrice,
      accessibleLabel: `${METRIC_TRUST_COPY.estimateLabel}: Unavailable. ${reasonCopy}`,
    });
  }

  if (
    packPrice.status !== "available" ||
    estimatedEv.grossEv.status !== "available" ||
    estimatedEv.evDollars.status !== "available" ||
    estimatedEv.evPercent.status !== "available"
  ) {
    return unavailablePresentation("ESTIMATE_INPUT_INCOMPLETE");
  }

  const state = semanticStateForSignedBasisPoints(
    estimatedEv.evPercent.value.basisPoints,
  );
  const stateLabel = semanticLabel(state);
  const evDollars = availableMoneyMetric(
    "EV $",
    "evDollars",
    estimatedEv.evDollars.value,
    { signed: true, state },
  );
  const evPercent = availableMetric(
    "EV %",
    formatSignedEvPercent(estimatedEv.evPercent.value.basisPoints),
    "evPercent",
    state,
  );
  const grossEv = availableMoneyMetric(
    "Gross EV",
    "grossEv",
    estimatedEv.grossEv.value,
  );
  const presentedPackPrice = availableMoneyMetric(
    "Pack Price",
    "packPrice",
    packPrice.value,
  );

  return Object.freeze({
    availability: "available" as const,
    semanticState: state,
    semanticLabel: stateLabel,
    evDollars,
    evPercent,
    grossEv,
    packPrice: presentedPackPrice,
    accessibleLabel: [
      METRIC_TRUST_COPY.estimateLabel,
      stateLabel,
      evPercent.accessibleLabel,
      evDollars.accessibleLabel,
      grossEv.accessibleLabel,
      presentedPackPrice.accessibleLabel,
    ].join(" "),
  });
}

export function presentSignedEvPercent(
  value: PublicEstimatedEv["evPercent"],
): MetricValuePresentation {
  if (value.status === "unavailable") {
    return unavailableMetric("EV %", "evPercent", value.reason);
  }
  const state = semanticStateForSignedBasisPoints(value.value.basisPoints);
  return availableMetric(
    "EV %",
    formatSignedEvPercent(value.value.basisPoints),
    "evPercent",
    state,
  );
}

export function presentBuyback(
  buyback: PublicBuyback,
): MetricValuePresentation {
  if (buyback.status === "unavailable") {
    return unavailableMetric("Buyback %", "buybackPercent", buyback.reason);
  }
  return availableMetric(
    "Buyback %",
    formatBasisPoints(buyback.value.basisPoints, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }),
    "buybackPercent",
  );
}

export function presentTopChaseValue(
  topChase: PublicTopChaseSummary,
): MetricValuePresentation {
  if (topChase.status === "unavailable") {
    return unavailableMetric(
      "Top Chase Value",
      "topChaseValue",
      topChase.reason,
    );
  }
  if (topChase.value.usdComparison.status === "unavailable") {
    return unavailableMetric(
      "Top Chase Value",
      "topChaseValue",
      topChase.value.usdComparison.reason,
    );
  }
  return availableMoneyMetric(
    "Top Chase Value",
    "topChaseValue",
    topChase.value.usdComparison.value,
  );
}
