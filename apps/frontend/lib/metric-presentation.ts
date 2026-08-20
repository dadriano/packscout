import type {
  PackScoutEv,
  PublicRepackChase,
  PublicRepackSummary,
  VendorReportedEv,
} from "@packscout/contracts";
import {
  getPublicReasonCopy,
  METRIC_TRUST_COPY,
  type GlossaryFieldKey,
  type PublicMetricReason,
} from "./metric-vocabulary";
import { presentConfidenceLimitations } from "./confidence-limitations";

const PRESENTATION_LOCALE = "en-US" as const;

type PublicMoney = Readonly<{ minorUnits: number; currency: string }>;
type PublicPrice = PublicRepackSummary["price"];
type PublicBuyback = PublicRepackSummary["buyback"];

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
  reason: PublicMetricReason;
  reasonCopy: string;
}>;

export type MetricValuePresentation =
  | AvailableMetricValue
  | UnavailableMetricValue;

export type PackScoutEvPresentation = Readonly<{
  availability: "available" | "unavailable";
  semanticState: MetricSemanticState;
  semanticLabel: "Positive" | "Neutral" | "Negative" | "Unavailable";
  accessibleLabel: string;
  reasonCopy?: string;
  evDollars: MetricValuePresentation;
  evPercent: MetricValuePresentation;
  grossEv: MetricValuePresentation;
  repackPrice: MetricValuePresentation;
  confidence: ConfidencePresentation;
}>;

export type VendorReportedEvPresentation = Readonly<{
  availability: "available" | "unavailable";
  accessibleLabel: string;
  reasonCopy?: string;
  evPercent: MetricValuePresentation;
  reportedGrossEv: MetricValuePresentation;
  observedAt: string | null;
}>;

export type ConfidencePresentation = Readonly<{
  availability: "available" | "unavailable";
  band: "low" | "medium" | "high" | null;
  displayValue: string;
  accessibleLabel: string;
  limitations: readonly string[];
}>;

export type PackScoutEvPresentationInput = Readonly<{
  repackPrice: PublicPrice["usdComparison"];
  estimate: PackScoutEv;
}>;

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
  try {
    const formatter = currencyFormatter(
      money.currency,
      options.signed === true,
      money.minorUnits === 0,
    );
    const fractionDigits =
      formatter.resolvedOptions().maximumFractionDigits ?? 2;
    return formatter.format(money.minorUnits / 10 ** fractionDigits);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    const sign = money.minorUnits < 0
      ? "-"
      : options.signed === true && money.minorUnits > 0
        ? "+"
        : "";
    const amount = new Intl.NumberFormat(PRESENTATION_LOCALE, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(Math.abs(money.minorUnits) / 100);
    return `${sign}${money.currency} ${amount}`;
  }
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
    ...(state ? { semanticState: state, semanticLabel: stateLabel } : {}),
  });
}

function unavailableMetric(
  label: string,
  glossaryKey: GlossaryFieldKey,
  reason: PublicMetricReason,
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

function availableMoneyMetric(
  label: string,
  glossaryKey: GlossaryFieldKey,
  money: PublicMoney,
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

function packScoutReason(estimate: PackScoutEv): PublicMetricReason {
  return estimate.status === "unavailable"
    ? estimate.reason
    : "ESTIMATE_UNAVAILABLE";
}

export function packScoutMetricConsistencyIssues(
  input: PackScoutEvPresentationInput,
): readonly string[] {
  if (input.estimate.status === "unavailable") return Object.freeze([]);
  const { metrics } = input.estimate;
  const issues: string[] = [];
  for (const [field, value] of [
    ["grossEv", metrics.grossEv.minorUnits],
    ["evDollars", metrics.evDollars.minorUnits],
    ["grossReturnBasisPoints", metrics.grossReturnBasisPoints],
    ["evPercentBasisPoints", metrics.evPercentBasisPoints],
  ] as const) {
    if (!Number.isSafeInteger(value)) issues.push(`${field} must be a safe integer`);
  }
  if (
    metrics.evPercentBasisPoints !== metrics.grossReturnBasisPoints - 10_000
  ) {
    issues.push("PackScout EV percent must equal gross return minus 100%");
  }
  if (input.repackPrice.status === "available") {
    const expected =
      metrics.grossEv.minorUnits - input.repackPrice.value.minorUnits;
    if (metrics.evDollars.minorUnits !== expected) {
      issues.push("PackScout EV $ must equal Gross EV minus Repack Price");
    }
  }
  return Object.freeze(issues);
}

function unavailablePackScoutPresentation(
  reason: PublicMetricReason,
  repackPrice: PublicPrice["usdComparison"],
): PackScoutEvPresentation {
  const reasonCopy = getPublicReasonCopy(reason);
  const metricReason = reason === "ESTIMATE_INPUT_INCOMPLETE"
    ? "ESTIMATE_INPUT_INCOMPLETE"
    : reason;
  return Object.freeze({
    availability: "unavailable" as const,
    semanticState: "unavailable" as const,
    semanticLabel: "Unavailable" as const,
    reasonCopy,
    evDollars: unavailableMetric("EV $", "evDollars", metricReason),
    evPercent: unavailableMetric("EV %", "evPercent", metricReason),
    grossEv: unavailableMetric("Gross EV", "grossEv", metricReason),
    repackPrice:
      repackPrice.status === "available"
        ? availableMoneyMetric("Repack Price", "repackPrice", repackPrice.value)
        : unavailableMetric("Repack Price", "repackPrice", repackPrice.reason),
    confidence: presentPackScoutConfidence(null),
    accessibleLabel: `${METRIC_TRUST_COPY.estimateLabel}: Unavailable. ${reasonCopy}`,
  });
}

export function presentPackScoutEv(
  input: PackScoutEvPresentationInput,
): PackScoutEvPresentation {
  const issues = packScoutMetricConsistencyIssues(input);
  if (issues.length > 0) {
    if (process.env.NODE_ENV !== "production") {
      throw new MetricPresentationConsistencyError(issues);
    }
    return unavailablePackScoutPresentation(
      "ESTIMATE_INPUT_INCOMPLETE",
      input.repackPrice,
    );
  }
  if (input.estimate.status === "unavailable") {
    return unavailablePackScoutPresentation(
      packScoutReason(input.estimate),
      input.repackPrice,
    );
  }

  const { metrics, confidence } = input.estimate;
  const state = semanticStateForSignedBasisPoints(metrics.evPercentBasisPoints);
  const stateLabel = semanticLabel(state);
  const evDollars = availableMoneyMetric(
    "EV $",
    "evDollars",
    metrics.evDollars,
    { signed: true, state },
  );
  const evPercent = availableMetric(
    "EV %",
    formatSignedEvPercent(metrics.evPercentBasisPoints),
    "evPercent",
    state,
  );
  const grossEv = availableMoneyMetric(
    "Gross EV",
    "grossEv",
    metrics.grossEv,
  );
  const repackPrice = input.repackPrice.status === "available"
    ? availableMoneyMetric(
        "Repack Price",
        "repackPrice",
        input.repackPrice.value,
      )
    : unavailableMetric(
        "Repack Price",
        "repackPrice",
        input.repackPrice.reason,
      );
  const confidencePresentation = presentPackScoutConfidence(confidence);
  return Object.freeze({
    availability: "available" as const,
    semanticState: state,
    semanticLabel: stateLabel,
    evDollars,
    evPercent,
    grossEv,
    repackPrice,
    confidence: confidencePresentation,
    accessibleLabel: [
      METRIC_TRUST_COPY.estimateLabel,
      stateLabel,
      evPercent.accessibleLabel,
      evDollars.accessibleLabel,
      grossEv.accessibleLabel,
      repackPrice.accessibleLabel,
      confidencePresentation.accessibleLabel,
    ].join(" "),
  });
}

export function presentPackScoutConfidence(
  confidence: Extract<PackScoutEv, { status: "available" }>["confidence"] | null,
): ConfidencePresentation {
  if (confidence === null) {
    return Object.freeze({
      availability: "unavailable" as const,
      band: null,
      displayValue: "Unavailable",
      accessibleLabel: "EV confidence: Unavailable.",
      limitations: Object.freeze([]),
    });
  }
  const band = confidence.band;
  const score = formatBasisPoints(confidence.scoreBasisPoints, {
    maximumFractionDigits: 0,
  });
  const limitations = presentConfidenceLimitations(confidence.limitationCodes);
  return Object.freeze({
    availability: "available" as const,
    band,
    displayValue: `${band[0]!.toUpperCase()}${band.slice(1)} · ${score}`,
    accessibleLabel: [
      `EV confidence: ${band}, ${score}.`,
      "Confidence describes reliability, not return.",
      ...(limitations.length > 0
        ? [`Limitations: ${limitations.join(" ")}`]
        : []),
    ].join(" "),
    limitations,
  });
}

function vendorReason(estimate: VendorReportedEv): PublicMetricReason {
  if (estimate.status === "available") return "ESTIMATE_UNAVAILABLE";
  return estimate.reason;
}

function vendorComparisonReason(estimate: VendorReportedEv): string {
  if (estimate.status === "available") return "";
  if (estimate.reason === "PRICE_UNAVAILABLE") {
    return "Vendor EV percentage unavailable because the repack price is unavailable.";
  }
  if (estimate.reason === "CURRENCY_UNSUPPORTED") {
    return "Vendor EV percentage unavailable because the reported currency cannot be compared in USD.";
  }
  return getPublicReasonCopy(estimate.reason);
}

export function presentVendorReportedEv(
  estimate: VendorReportedEv,
): VendorReportedEvPresentation {
  if (estimate.status === "unavailable") {
    const reason = vendorReason(estimate);
    const reasonCopy = vendorComparisonReason(estimate);
    const reportedGrossEv = estimate.displayMoney === null
      ? unavailableMetric(
          "Vendor-reported Gross EV",
          "vendorReportedEv",
          reason,
        )
      : availableMoneyMetric(
          "Vendor-reported Gross EV",
          "vendorReportedEv",
          estimate.displayMoney,
        );
    const evPercent = unavailableMetric(
      "Vendor-reported EV %",
      "vendorReportedEv",
      reason,
    );
    return Object.freeze({
      availability: "unavailable" as const,
      reasonCopy,
      evPercent,
      reportedGrossEv,
      observedAt: estimate.observedAt,
      accessibleLabel: `Vendor-reported EV. ${reportedGrossEv.accessibleLabel} ${evPercent.accessibleLabel} ${reasonCopy}`,
    });
  }
  const state = semanticStateForSignedBasisPoints(
    estimate.metrics.evPercentBasisPoints,
  );
  const evPercent = availableMetric(
    "Vendor-reported EV %",
    formatSignedEvPercent(estimate.metrics.evPercentBasisPoints),
    "vendorReportedEv",
    state,
  );
  const reportedGrossEv = availableMoneyMetric(
    "Vendor-reported Gross EV",
    "vendorReportedEv",
    estimate.displayMoney,
  );
  return Object.freeze({
    availability: "available" as const,
    evPercent,
    reportedGrossEv,
    observedAt: estimate.observedAt,
    accessibleLabel: `Vendor-reported EV. ${reportedGrossEv.accessibleLabel} ${evPercent.accessibleLabel}`,
  });
}

export function presentPackScoutEvPercent(
  estimate: PackScoutEv,
): MetricValuePresentation {
  if (estimate.status === "unavailable") {
    return unavailableMetric(
      "EV %",
      "evPercent",
      estimate.reason,
    );
  }
  const state = semanticStateForSignedBasisPoints(
    estimate.metrics.evPercentBasisPoints,
  );
  return availableMetric(
    "EV %",
    formatSignedEvPercent(estimate.metrics.evPercentBasisPoints),
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
  topChase: PublicRepackChase | null,
  label: "Top Chase Value" | "Desired Chase Value" = "Top Chase Value",
): MetricValuePresentation {
  const valuation = topChase?.collectible.valuation;
  if (valuation === null || valuation === undefined) {
    return unavailableMetric(
      label,
      "topChaseValue",
      "VALUATION_UNAVAILABLE",
    );
  }
  if (valuation.usdComparison.status === "unavailable") {
    return unavailableMetric(
      label,
      "topChaseValue",
      valuation.usdComparison.reason,
    );
  }
  return availableMoneyMetric(
    label,
    "topChaseValue",
    valuation.usdComparison.value,
  );
}
