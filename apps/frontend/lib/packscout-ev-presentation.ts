import {
  packScoutBuybackEvMetricsAreConsistentV1,
  type DashboardKpis,
  type DataReleaseV3Identity,
  type PackScoutPublicEvSourceAgeStateV3,
  type PackScoutPublicEvV3,
  type PublicBuybackSummaryV3,
  type PublicRepackChase,
  type PublicRepackSummaryV3,
  type VendorReportedEvV3,
} from "@packscout/contracts";
import { presentConfidenceLimitations } from "./confidence-limitations";
import { presentPackAvailability } from "./pack-availability-presentation";
import {
  BUYBACK_SUMMARY_COPY,
  ESTIMATE_STATUS_COPY,
  METRIC_TRUST_COPY,
  SOURCE_AGE_COPY,
  getPublicReasonCopy,
  type GlossaryFieldKey,
  type PublicMetricReason,
} from "./metric-vocabulary";

/**
 * The one shared PackScout EV presentation boundary (task
 * buyback-adjusted-ev/010). Every public surface renders EV strictly through
 * this module: it is the single consumer of raw public minor units and basis
 * points, and it owns precision, signs, semantic states, labels, reasons,
 * confidence copy, timestamps, and accessible descriptions. Components never
 * recalculate odds, payouts, confidence, rankings, or aggregates.
 */

const PRESENTATION_LOCALE = "en-US" as const;

type PublicMoney = Readonly<{ minorUnits: number; currency: string }>;
type PublicPrice = PublicRepackSummaryV3["price"];

export type MetricSemanticState = "neutral" | "negative" | "unavailable";

export type MetricSemanticLabel = "Neutral" | "Negative";

export type AvailableMetricValue = Readonly<{
  availability: "available";
  label: string;
  displayValue: string;
  accessibleLabel: string;
  glossaryKey: GlossaryFieldKey;
  semanticState?: Exclude<MetricSemanticState, "unavailable">;
  semanticLabel?: MetricSemanticLabel;
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

export type ConfidencePresentation = Readonly<{
  availability: "available" | "unavailable";
  band: "low" | "medium" | "high" | null;
  scoreBasisPoints: number | null;
  displayValue: string;
  accessibleLabel: string;
  limitations: readonly string[];
}>;

export type PackScoutEvFreshnessPresentation = Readonly<{
  sourceAgeState: PackScoutPublicEvSourceAgeStateV3 | null;
  sourceAgeLabel: string | null;
  delayed: boolean;
  calculatedAt: string;
  calculatedLabel: string;
  dataAsOf: string | null;
  dataAsOfLabel: string;
  expiresAt: string | null;
  soldOutAt: string | null;
  soldOutLabel: string | null;
}>;

export type PackScoutEvStatusKind =
  | "current"
  | "sold_out_historical"
  | "unavailable"
  | "expired";

export type PackScoutEvV3Presentation = Readonly<{
  availability: "available" | "unavailable";
  status: PackScoutEvStatusKind;
  statusLabel: string;
  semanticState: MetricSemanticState;
  semanticLabel: MetricSemanticLabel | "Unavailable";
  simulated: boolean;
  simulatedLabel: string | null;
  zeroPayout: boolean;
  zeroPayoutNote: string | null;
  sourceLine: string;
  adviceLine: string;
  grossEvDollars: MetricValuePresentation;
  grossEvPercent: MetricValuePresentation;
  evDollars: MetricValuePresentation;
  evPercent: MetricValuePresentation;
  packPrice: MetricValuePresentation;
  confidence: ConfidencePresentation;
  freshness: PackScoutEvFreshnessPresentation;
  reason?: PublicMetricReason;
  reasonCopy?: string;
  outboundActionAllowed: boolean;
  accessibleLabel: string;
}>;

export type VendorReportedEvV3Presentation = Readonly<{
  availability: "available" | "unavailable";
  label: "Vendor-reported EV";
  sourceNote: string;
  reported: MetricValuePresentation;
  usdComparison: MetricValuePresentation;
  observedAt: string | null;
  observedLabel: string | null;
  reasonCopy?: string;
  accessibleLabel: string;
}>;

export type PackScoutEvV3PresentationInput = Readonly<{
  estimate: PackScoutPublicEvV3;
  price: PublicPrice;
  availability: PublicRepackSummaryV3["availability"];
  repackName?: string;
}>;

export class MetricPresentationConsistencyError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(
      `Metric presentation received inconsistent values: ${issues.join("; ")}`,
    );
    this.name = "MetricPresentationConsistencyError";
    this.issues = Object.freeze([...issues]);
  }
}

// --- shared low-level formatting -------------------------------------------

const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(PRESENTATION_LOCALE, {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

export function formatPublicTimestamp(timestamp: string): string {
  return TIMESTAMP_FORMATTER.format(new Date(timestamp));
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
    signDisplay:
      options.signed === true && basisPoints !== 0 ? "always" : "auto",
    minimumFractionDigits,
    maximumFractionDigits,
  }).format(basisPoints / 10_000);
}

/** Signed EV % with an explicit sign for nonzero values and exact cents. */
export function formatSignedEvPercent(basisPoints: number): string {
  return formatBasisPoints(basisPoints, {
    signed: true,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Unsigned Gross EV % with exact two-decimal rendering (85.00%). */
export function formatGrossEvPercent(basisPoints: number): string {
  return formatBasisPoints(basisPoints, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function semanticStateForSignedBasisPoints(
  basisPoints: number,
): Exclude<MetricSemanticState, "unavailable"> {
  if (basisPoints > 0) {
    throw new RangeError("public PackScout EV cannot be positive");
  }
  if (basisPoints < 0) return "negative";
  return "neutral";
}

function semanticLabel(
  state: Exclude<MetricSemanticState, "unavailable">,
): MetricSemanticLabel {
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

// --- simulated provenance ---------------------------------------------------

const SIMULATED_LISTING_PREFIX = "[Simulated]" as const;

/**
 * Task-009 simulated releases label public listings inside existing fields
 * with the exact `[Simulated]` prefix; presentation surfaces that provenance
 * without inventing a structural flag the contract does not carry.
 */
export function isSimulatedRepackListing(name: string | undefined): boolean {
  return name === undefined ? false : name.startsWith(SIMULATED_LISTING_PREFIX);
}

// --- price and chase values --------------------------------------------------

export function presentRepackPrice(price: PublicPrice): MetricValuePresentation {
  if (price.displayMoney !== null) {
    return availableMoneyMetric("Pack Price", "repackPrice", price.displayMoney);
  }
  if (price.usdComparison.status === "available") {
    return availableMoneyMetric(
      "Pack Price",
      "repackPrice",
      price.usdComparison.value,
    );
  }
  return unavailableMetric(
    "Pack Price",
    "repackPrice",
    price.usdComparison.reason,
  );
}

export function presentTopChaseValue(
  topChase: PublicRepackChase | null,
  label: "Top Chase Value" | "Desired Chase Value" = "Top Chase Value",
): MetricValuePresentation {
  const valuation = topChase?.collectible.valuation;
  if (valuation === null || valuation === undefined) {
    return unavailableMetric(label, "topChaseValue", "VALUATION_UNAVAILABLE");
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

// --- buyback summary ---------------------------------------------------------

/**
 * Bounded buyback presentation: an exact numeric Buyback % only for a
 * documented uniform rate; every other kind renders its bounded summary and
 * no synthetic average is ever produced.
 */
export function presentBuybackSummaryV3(
  buyback: PublicBuybackSummaryV3,
): MetricValuePresentation {
  if (buyback.kind === "uniform_rate") {
    return availableMetric(
      "Buyback %",
      formatBasisPoints(buyback.rateBasisPoints, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      }),
      "buybackPercent",
    );
  }
  if (buyback.kind === "unavailable") {
    return unavailableMetric("Buyback %", "buybackPercent", "BUYBACK_UNAVAILABLE");
  }
  return availableMetric(
    "Buyback %",
    BUYBACK_SUMMARY_COPY[buyback.kind],
    "buybackPercent",
  );
}

// --- confidence --------------------------------------------------------------

type PackScoutConfidence = Extract<
  PackScoutPublicEvV3,
  { status: "current" }
>["confidence"];

export function presentPackScoutConfidence(
  confidence: PackScoutConfidence | null,
): ConfidencePresentation {
  if (confidence === null) {
    return Object.freeze({
      availability: "unavailable" as const,
      band: null,
      scoreBasisPoints: null,
      displayValue: "Unavailable",
      accessibleLabel: "PackScout EV confidence: Unavailable.",
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
    scoreBasisPoints: confidence.scoreBasisPoints,
    displayValue: `${band[0]!.toUpperCase()}${band.slice(1)} · ${score}`,
    accessibleLabel: [
      `PackScout EV confidence: ${band}, ${score}.`,
      METRIC_TRUST_COPY.confidenceExplanation,
      ...(limitations.length > 0
        ? [`Limitations: ${limitations.join(" ")}`]
        : []),
    ].join(" "),
    limitations,
  });
}

// --- freshness and timestamps -------------------------------------------------

function presentFreshness(
  estimate: PackScoutPublicEvV3,
): PackScoutEvFreshnessPresentation {
  const sourceAgeState =
    estimate.status === "unavailable" ? null : estimate.sourceAge.state;
  const dataAsOf =
    estimate.dataAsOf.state === "known" ? estimate.dataAsOf.observedAt : null;
  return Object.freeze({
    sourceAgeState,
    sourceAgeLabel:
      sourceAgeState === null ? null : SOURCE_AGE_COPY[sourceAgeState],
    delayed:
      sourceAgeState !== null && sourceAgeState !== "fresh_within_15_minutes",
    calculatedAt: estimate.calculatedAt,
    calculatedLabel: `Calculated ${formatPublicTimestamp(estimate.calculatedAt)}`,
    dataAsOf,
    dataAsOfLabel:
      dataAsOf === null
        ? ESTIMATE_STATUS_COPY.unknownSourceTime
        : `Source data as of ${formatPublicTimestamp(dataAsOf)}`,
    expiresAt: estimate.status === "current" ? estimate.expiresAt : null,
    soldOutAt:
      estimate.status === "sold_out_historical" ? estimate.soldOutAt : null,
    soldOutLabel:
      estimate.status === "sold_out_historical"
        ? `Sold out ${formatPublicTimestamp(estimate.soldOutAt)}`
        : null,
  });
}

// --- development-time arithmetic validation -----------------------------------

/**
 * Verifies — never recomputes for display — that materialized public values
 * are internally consistent, reusing the contract invariant. Development and
 * tests throw; production fails closed to an unavailable presentation.
 */
export function packScoutMetricConsistencyIssuesV3(
  input: PackScoutEvV3PresentationInput,
): readonly string[] {
  if (input.estimate.status === "unavailable") return Object.freeze([]);
  const { metrics } = input.estimate;
  const issues: string[] = [];
  for (const [field, value] of [
    ["grossEvMoney", metrics.grossEvMoney.minorUnits],
    ["grossReturnBasisPoints", metrics.grossReturnBasisPoints],
    ["evDollars", metrics.evDollars.minorUnits],
    ["evPercentBasisPoints", metrics.evPercentBasisPoints],
  ] as const) {
    if (!Number.isSafeInteger(value)) {
      issues.push(`${field} must be a safe integer`);
    }
  }
  if (issues.length > 0) return Object.freeze(issues);
  if (
    metrics.grossReturnBasisPoints > 10_000 ||
    metrics.evDollars.minorUnits > 0 ||
    metrics.evPercentBasisPoints > 0
  ) {
    issues.push("public PackScout EV must be nonpositive");
  }
  if (
    metrics.evPercentBasisPoints !==
    metrics.grossReturnBasisPoints - 10_000
  ) {
    issues.push("EV % must equal Gross EV % minus 100 percentage points");
  }
  if (input.price.usdComparison.status !== "available") {
    issues.push(
      "a presentable PackScout estimate requires a comparable Pack Price",
    );
  } else if (
    !packScoutBuybackEvMetricsAreConsistentV1({
      grossEvMinorUnits: metrics.grossEvMoney.minorUnits,
      grossReturnBasisPoints: metrics.grossReturnBasisPoints,
      evDollarsMinorUnits: metrics.evDollars.minorUnits,
      evPercentBasisPoints: metrics.evPercentBasisPoints,
      packPriceMinorUnits: input.price.usdComparison.value.minorUnits,
    })
  ) {
    issues.push(
      "PackScout metrics must satisfy the versioned calculation invariants",
    );
  }
  return Object.freeze(issues);
}

// --- the PackScout estimate presentation ---------------------------------------

/**
 * Pack availability is a separate axis from PackScout EV availability: a pack
 * the platform still presents as available can carry an unavailable estimate,
 * and a pack that is `unavailable`, `unknown`, or `sold_out` can still carry a
 * presentable estimate. Only the shared pack-availability presenter decides
 * whether an outbound purchase action may be exposed, so `available` is the
 * one state that permits it and the three non-available states — including the
 * `unavailable` and `unknown` states this surface never saw before — all
 * withhold it without being conflated with a sold-out pack.
 */
function packPurchaseActionsAllowed(
  availability: PackScoutEvV3PresentationInput["availability"],
): boolean {
  return presentPackAvailability(availability).purchaseActionsAvailable;
}

function unavailableStatus(
  reason: PublicMetricReason,
): Readonly<{ status: PackScoutEvStatusKind; statusLabel: string }> {
  return reason === "SOURCE_DATA_STALE"
    ? { status: "expired", statusLabel: ESTIMATE_STATUS_COPY.expired }
    : { status: "unavailable", statusLabel: ESTIMATE_STATUS_COPY.unavailable };
}

function unavailablePackScoutPresentation(
  reason: PublicMetricReason,
  input: PackScoutEvV3PresentationInput,
  freshness: PackScoutEvFreshnessPresentation,
): PackScoutEvV3Presentation {
  const reasonCopy = getPublicReasonCopy(reason);
  const { status, statusLabel } = unavailableStatus(reason);
  const simulated = isSimulatedRepackListing(input.repackName);
  return Object.freeze({
    availability: "unavailable" as const,
    status,
    statusLabel,
    semanticState: "unavailable" as const,
    semanticLabel: "Unavailable" as const,
    simulated,
    simulatedLabel: simulated ? ESTIMATE_STATUS_COPY.simulated : null,
    zeroPayout: false,
    zeroPayoutNote: null,
    sourceLine: METRIC_TRUST_COPY.sourceLine,
    adviceLine: METRIC_TRUST_COPY.adviceLine,
    grossEvDollars: unavailableMetric("Gross EV $", "grossEv", reason),
    grossEvPercent: unavailableMetric("Gross EV %", "grossEvPercent", reason),
    evDollars: unavailableMetric("EV $", "evDollars", reason),
    evPercent: unavailableMetric("EV %", "evPercent", reason),
    packPrice: presentRepackPrice(input.price),
    confidence: presentPackScoutConfidence(null),
    freshness,
    reason,
    reasonCopy,
    outboundActionAllowed: packPurchaseActionsAllowed(input.availability),
    accessibleLabel: [
      `${METRIC_TRUST_COPY.estimateLabel}: ${statusLabel}.`,
      reasonCopy,
      ...(simulated ? [`${ESTIMATE_STATUS_COPY.simulated}.`] : []),
      METRIC_TRUST_COPY.sourceLine + ".",
      METRIC_TRUST_COPY.adviceLine + ".",
    ].join(" "),
  });
}

/**
 * Presents one materialized PackScout public estimate. Gross EV $ is the
 * expected guaranteed buyback payout, Gross EV % is that payout divided by
 * the public Pack Price, and EV $ / EV % are signed against Pack Price with
 * explicit signs for nonzero values. An unavailable estimate never renders
 * zero or a vendor fallback.
 */
export function presentPackScoutEvV3(
  input: PackScoutEvV3PresentationInput,
): PackScoutEvV3Presentation {
  const freshness = presentFreshness(input.estimate);
  const issues = packScoutMetricConsistencyIssuesV3(input);
  if (issues.length > 0) {
    if (process.env.NODE_ENV !== "production") {
      throw new MetricPresentationConsistencyError(issues);
    }
    return unavailablePackScoutPresentation(
      "CALCULATION_UNAVAILABLE",
      input,
      freshness,
    );
  }
  if (input.estimate.status === "unavailable") {
    return unavailablePackScoutPresentation(
      input.estimate.reason,
      input,
      freshness,
    );
  }

  const { metrics, confidence } = input.estimate;
  const historical = input.estimate.status === "sold_out_historical";
  const state = semanticStateForSignedBasisPoints(metrics.evPercentBasisPoints);
  const stateLabel = semanticLabel(state);
  const zeroPayout = metrics.grossEvMoney.minorUnits === 0;
  const grossEvDollars = availableMoneyMetric(
    "Gross EV $",
    "grossEv",
    metrics.grossEvMoney,
  );
  const grossEvPercent = availableMetric(
    "Gross EV %",
    formatGrossEvPercent(metrics.grossReturnBasisPoints),
    "grossEvPercent",
  );
  const evDollars = availableMoneyMetric("EV $", "evDollars", metrics.evDollars, {
    signed: true,
    state,
  });
  const evPercent = availableMetric(
    "EV %",
    formatSignedEvPercent(metrics.evPercentBasisPoints),
    "evPercent",
    state,
  );
  const packPrice = presentRepackPrice(input.price);
  const confidencePresentation = presentPackScoutConfidence(confidence);
  const statusLabel = historical
    ? ESTIMATE_STATUS_COPY.sold_out_historical
    : ESTIMATE_STATUS_COPY.current;
  const simulated = isSimulatedRepackListing(input.repackName);
  return Object.freeze({
    availability: "available" as const,
    status: input.estimate.status,
    statusLabel,
    semanticState: state,
    semanticLabel: stateLabel,
    simulated,
    simulatedLabel: simulated ? ESTIMATE_STATUS_COPY.simulated : null,
    zeroPayout,
    zeroPayoutNote: zeroPayout
      ? "Valid $0.00 payout: every supported outcome pays no guaranteed buyback."
      : null,
    sourceLine: METRIC_TRUST_COPY.sourceLine,
    adviceLine: METRIC_TRUST_COPY.adviceLine,
    grossEvDollars,
    grossEvPercent,
    evDollars,
    evPercent,
    packPrice,
    confidence: confidencePresentation,
    freshness,
    outboundActionAllowed:
      packPurchaseActionsAllowed(input.availability) && !historical,
    accessibleLabel: [
      `${METRIC_TRUST_COPY.estimateLabel}: ${statusLabel}.`,
      ...(historical && freshness.soldOutLabel
        ? [`${freshness.soldOutLabel}.`]
        : []),
      ...(simulated ? [`${ESTIMATE_STATUS_COPY.simulated}.`] : []),
      grossEvDollars.accessibleLabel,
      grossEvPercent.accessibleLabel,
      evDollars.accessibleLabel,
      evPercent.accessibleLabel,
      packPrice.accessibleLabel,
      ...(zeroPayout
        ? ["Valid $0.00 payout: every supported outcome pays no guaranteed buyback."]
        : []),
      confidencePresentation.accessibleLabel,
      ...(freshness.sourceAgeLabel ? [`${freshness.sourceAgeLabel}.`] : []),
      METRIC_TRUST_COPY.sourceLine + ".",
      METRIC_TRUST_COPY.adviceLine + ".",
    ].join(" "),
  });
}

// --- vendor-reported EV ---------------------------------------------------------

const VENDOR_SOURCE_NOTE =
  "Reported by vendor — separate from PackScout Gross EV" as const;

/**
 * Vendor-reported EV presentation. Structurally independent from the
 * PackScout estimate: it is labeled as vendor-reported, carries its own
 * observation time, and is never averaged with, merged into, or substituted
 * for a PackScout value.
 */
export function presentVendorReportedEvV3(
  estimate: VendorReportedEvV3,
): VendorReportedEvV3Presentation {
  if (estimate.status === "unavailable") {
    const reported = unavailableMetric(
      "Vendor-reported EV",
      "vendorReportedEv",
      estimate.reason,
    );
    const usdComparison = unavailableMetric(
      "Vendor EV (USD)",
      "vendorReportedEv",
      estimate.reason,
    );
    const reasonCopy = getPublicReasonCopy(estimate.reason);
    return Object.freeze({
      availability: "unavailable" as const,
      label: "Vendor-reported EV" as const,
      sourceNote: VENDOR_SOURCE_NOTE,
      reported,
      usdComparison,
      observedAt: estimate.observedAt,
      observedLabel:
        estimate.observedAt === null
          ? null
          : `Vendor EV observed ${formatPublicTimestamp(estimate.observedAt)}`,
      reasonCopy,
      accessibleLabel: `Vendor-reported EV: Unavailable. ${reasonCopy} ${VENDOR_SOURCE_NOTE}.`,
    });
  }
  const reported = availableMoneyMetric(
    "Vendor-reported EV",
    "vendorReportedEv",
    estimate.sourceMoney,
  );
  const usdComparison =
    estimate.usdComparison.status === "available"
      ? availableMoneyMetric(
          "Vendor EV (USD)",
          "vendorReportedEv",
          estimate.usdComparison.value,
        )
      : unavailableMetric(
          "Vendor EV (USD)",
          "vendorReportedEv",
          estimate.usdComparison.reason,
        );
  return Object.freeze({
    availability: "available" as const,
    label: "Vendor-reported EV" as const,
    sourceNote: VENDOR_SOURCE_NOTE,
    reported,
    usdComparison,
    observedAt: estimate.observedAt,
    observedLabel: `Vendor EV observed ${formatPublicTimestamp(estimate.observedAt)}`,
    accessibleLabel: `${reported.accessibleLabel} ${usdComparison.accessibleLabel} ${VENDOR_SOURCE_NOTE}.`,
  });
}

// --- server-provided aggregates ---------------------------------------------------

/**
 * Formats a server-materialized signed EV percent aggregate (medians and
 * group summaries). The browser never recomputes aggregate values.
 */
export function presentSignedEvPercentMetric(
  metric: DashboardKpis["medianPackScoutEvPercent"],
  label = "EV %",
): MetricValuePresentation {
  if (metric.status === "unavailable") {
    return unavailableMetric(label, "evPercent", metric.reason);
  }
  if (metric.basisPoints > 0) {
    return unavailableMetric(label, "evPercent", "CALCULATION_UNAVAILABLE");
  }
  const state = semanticStateForSignedBasisPoints(metric.basisPoints);
  return availableMetric(
    label,
    formatSignedEvPercent(metric.basisPoints),
    "evPercent",
    state,
  );
}

export function presentReleaseDataAsOf(
  release: DataReleaseV3Identity,
): Readonly<{ dataAsOf: string; label: string }> {
  return Object.freeze({
    dataAsOf: release.dataAsOf,
    label: `Repack data as of ${formatPublicTimestamp(release.dataAsOf)}`,
  });
}
