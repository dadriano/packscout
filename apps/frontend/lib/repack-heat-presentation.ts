import type {
  PublicRepackHeat,
  RepackHeatComponentUnavailableReason,
  RepackHeatComponents,
  RepackHeatDriverCode,
  RepackHeatLimitationCode,
} from "@packscout/contracts";

export const REPACK_HEAT_INTERPRETATION =
  "Recent activity versus this repack’s own baseline; not profit or +EV." as const;

export type RepackHeatSignalState =
  | "hot"
  | "warm"
  | "normal"
  | "cold"
  | "insufficient_data";

/**
 * The smallest public heat shape the frontend badge needs. Keeping this
 * structural prevents the presentation primitive from depending on storage or
 * aggregation details while allowing the richer public contract to pass
 * through directly.
 */
export type RepackHeatBadgeInput =
  | Readonly<{
      status: "current";
      signal: Readonly<{
        state: RepackHeatSignalState;
        scoreBasisPoints: number | null;
        provenance: Readonly<{ kind: "observed" | "simulated" }>;
      }>;
    }>
  | Readonly<{
      status: "expired";
      signal: null;
      lastCalculatedAt?: string;
      expiredAt?: string;
    }>
  | Readonly<{
      status: "unavailable";
      signal: null;
      reason?: "NOT_PUBLISHED" | "RELEASE_MISMATCH";
    }>;

export type RepackHeatBadgePresentation = Readonly<{
  state: RepackHeatSignalState | "unavailable";
  label: "Hot" | "Warm" | "Normal" | "Cold" | "Not enough data" | "Heat unavailable";
  supportingLabel: "Simulated" | "Expired" | "Awaiting signal" | null;
  simulated: boolean;
  accessibleLabel: string;
}>;

export type RepackHeatComponentPresentation = Readonly<{
  id:
    | "activity"
    | "observedReturn"
    | "largeHitFrequency"
    | "chaseAvailability"
    | "poolComposition";
  label: string;
  value: string;
  context: string;
  availability: "available" | "unavailable";
  accessibleLabel: string;
}>;

export type RepackHeatDriverPresentation = Readonly<{
  code: RepackHeatDriverCode;
  label: string;
  value: string;
  context:
    | "Raises Heat index"
    | "Lowers Heat index"
    | "Neutral contribution"
    | "Component unavailable";
  direction: "positive" | "negative" | "neutral";
  accessibleLabel: string;
}>;

export type RepackHeatDetailsPresentation =
  | Readonly<{
      availability: "current";
      badge: RepackHeatBadgePresentation;
      provenanceLabel: "Observed data" | "Simulated data";
      indexLabel: string;
      indexAccessibleLabel: string;
      confidenceLabel: string;
      confidenceAccessibleLabel: string;
      currentWindow: Readonly<{
        startedAt: string;
        endedAt: string;
        startedLabel: string;
        endedLabel: string;
        pullCountLabel: string;
      }>;
      baselineWindow: Readonly<{
        startedAt: string;
        endedAt: string;
        startedLabel: string;
        endedLabel: string;
        pullCountLabel: string;
      }>;
      sampleRequirementLabel: string;
      driverExplanation: string;
      drivers: readonly RepackHeatDriverPresentation[];
      components: readonly RepackHeatComponentPresentation[];
      limitations: readonly string[];
      calculatedAt: string;
      calculatedLabel: string;
      expiresAt: string;
      expiresLabel: string;
    }>
  | Readonly<{
      availability: "expired";
      badge: RepackHeatBadgePresentation;
      message: string;
      lastCalculatedAt: string;
      lastCalculatedLabel: string;
      expiredAt: string;
      expiredLabel: string;
    }>
  | Readonly<{
      availability: "unavailable";
      badge: RepackHeatBadgePresentation;
      message: string;
    }>;

const STATE_LABELS = Object.freeze({
  hot: "Hot",
  warm: "Warm",
  normal: "Normal",
  cold: "Cold",
  insufficient_data: "Not enough data",
} as const satisfies Readonly<Record<RepackHeatSignalState, RepackHeatBadgePresentation["label"]>>);

const PERCENT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
  signDisplay: "exceptZero",
});

const NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});

const UNSIGNED_PERCENT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
});

const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

const COMPONENT_REASON_COPY = Object.freeze({
  CURRENT_SAMPLE_INSUFFICIENT: "Recent pull sample is below the required minimum.",
  BASELINE_SAMPLE_INSUFFICIENT: "Baseline pull sample is below the required minimum.",
  BASELINE_UNAVAILABLE: "A comparable baseline is not available.",
  EVIDENCE_INCOMPLETE: "Supported evidence is incomplete.",
  METRIC_UNSUPPORTED: "This signal component is not supported for this repack.",
} satisfies Readonly<Record<RepackHeatComponentUnavailableReason, string>>);

const LIMITATION_COPY = Object.freeze({
  current_sample_below_minimum: "Recent pull sample is below the required minimum.",
  baseline_sample_below_minimum: "Baseline pull sample is below the required minimum.",
  partial_source_coverage: "Source coverage is partial.",
  return_data_incomplete: "Observed-return data is incomplete.",
  large_hit_data_incomplete: "Large-hit data is incomplete.",
  chase_inventory_incomplete: "Chase-availability data is incomplete.",
  pool_composition_incomplete: "Pool-composition data is incomplete.",
  simulated_data: "Values are generated by the deterministic data-stream simulator.",
} satisfies Readonly<Record<RepackHeatLimitationCode, string>>);

const DRIVER_LABELS = Object.freeze({
  activity: "Pull activity",
  chase_availability: "Chase availability",
  large_hit_frequency: "Large-hit frequency",
  observed_return: "Observed return",
  pool_composition: "Pool composition",
} satisfies Readonly<Record<RepackHeatDriverCode, string>>);

const SIGNED_NUMBER_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
  signDisplay: "exceptZero",
});

const CONFIDENCE_PERCENT_FORMATTER = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 0,
});

function formatPercentBasisPoints(basisPoints: number): string {
  return `${PERCENT_FORMATTER.format(basisPoints / 100)}%`;
}

function formatUnsignedPercentBasisPoints(basisPoints: number): string {
  return `${UNSIGNED_PERCENT_FORMATTER.format(basisPoints / 100)}%`;
}

function formatConfidenceBasisPoints(basisPoints: number): string {
  return `${CONFIDENCE_PERCENT_FORMATTER.format(basisPoints / 100)}%`;
}

function formatPointBasisPoints(basisPoints: number): string {
  return `${PERCENT_FORMATTER.format(basisPoints / 100)} pts`;
}

function formatIndex(scoreBasisPoints: number): string {
  return `${NUMBER_FORMATTER.format(scoreBasisPoints / 100)} / 100`;
}

function presentDriver(
  code: RepackHeatDriverCode,
  contributionBasisPoints: number,
  componentAvailable: boolean,
): RepackHeatDriverPresentation {
  const label = DRIVER_LABELS[code];
  if (!componentAvailable) {
    return Object.freeze({
      code,
      label,
      value: "Unavailable",
      context: "Component unavailable" as const,
      direction: "neutral" as const,
      accessibleLabel: `${label}: Heat-index contribution unavailable because this component is unavailable.`,
    });
  }
  if (contributionBasisPoints === 0) {
    return Object.freeze({
      code,
      label,
      value: "No Heat-index contribution",
      context: "Neutral contribution" as const,
      direction: "neutral" as const,
      accessibleLabel: `${label}: no Heat-index contribution.`,
    });
  }

  const points = contributionBasisPoints / 100;
  const absolutePoints = Math.abs(points);
  const pointLabel = absolutePoints === 1 ? "index point" : "index points";
  const raises = contributionBasisPoints > 0;
  return Object.freeze({
    code,
    label,
    value: `${SIGNED_NUMBER_FORMATTER.format(points)} ${pointLabel}`,
    context: raises ? "Raises Heat index" as const : "Lowers Heat index" as const,
    direction: raises ? "positive" as const : "negative" as const,
    accessibleLabel: `${label}: ${raises ? "raises" : "lowers"} the Heat index by ${NUMBER_FORMATTER.format(absolutePoints)} ${pointLabel}.`,
  });
}

function driverComponentIsAvailable(
  code: RepackHeatDriverCode,
  components: RepackHeatComponents,
): boolean {
  switch (code) {
    case "activity":
      return components.activity.status === "available";
    case "chase_availability":
      return components.chaseAvailability.status === "available";
    case "large_hit_frequency":
      return components.largeHitFrequency.status === "available";
    case "observed_return":
      return components.observedReturn.status === "available";
    case "pool_composition":
      return components.poolComposition.status === "available";
  }
}

function formatTimestamp(timestamp: string): string {
  return TIMESTAMP_FORMATTER.format(new Date(timestamp));
}

function pullCountLabel(pullCount: number): string {
  return `${NUMBER_FORMATTER.format(pullCount)} ${pullCount === 1 ? "pull" : "pulls"}`;
}

function unavailableComponent(
  id: RepackHeatComponentPresentation["id"],
  label: string,
  reason: RepackHeatComponentUnavailableReason,
): RepackHeatComponentPresentation {
  const context = COMPONENT_REASON_COPY[reason];
  return Object.freeze({
    id,
    label,
    value: "Unavailable",
    context,
    availability: "unavailable" as const,
    accessibleLabel: `${label}: Unavailable. ${context}`,
  });
}

export function presentRepackHeatBadge(
  heat: RepackHeatBadgeInput,
): RepackHeatBadgePresentation {
  if (heat.status === "expired") {
    const expiryContext = heat.expiredAt
      ? ` It expired ${formatTimestamp(heat.expiredAt)}.`
      : "";
    return Object.freeze({
      state: "unavailable" as const,
      label: "Heat unavailable" as const,
      supportingLabel: "Expired" as const,
      simulated: false,
      accessibleLabel: `Heat unavailable. The previous heat signal expired.${expiryContext}`,
    });
  }

  if (heat.status === "unavailable") {
    const unavailableContext = heat.reason === "RELEASE_MISMATCH"
      ? "Awaiting a heat signal matched to this data release."
      : "Awaiting a published heat signal.";
    return Object.freeze({
      state: "unavailable" as const,
      label: "Heat unavailable" as const,
      supportingLabel: "Awaiting signal" as const,
      simulated: false,
      accessibleLabel: `Heat unavailable. ${unavailableContext}`,
    });
  }

  const simulated = heat.signal.provenance.kind === "simulated";
  const label = STATE_LABELS[heat.signal.state];
  const subject = simulated ? "Simulated heat" : "Heat";
  const sampleCopy = heat.signal.state === "insufficient_data"
    ? " The current or baseline sample does not yet meet the minimum pull count."
    : "";

  return Object.freeze({
    state: heat.signal.state,
    label,
    supportingLabel: simulated ? "Simulated" as const : null,
    simulated,
    accessibleLabel: `${subject}: ${label}.${sampleCopy} ${REPACK_HEAT_INTERPRETATION}`,
  });
}

export function presentRepackHeatDetails(
  heat: PublicRepackHeat,
): RepackHeatDetailsPresentation {
  const badge = presentRepackHeatBadge(heat);
  if (heat.status === "expired") {
    return Object.freeze({
      availability: "expired" as const,
      badge,
      message: "The latest heat signal expired and is not shown as normal or cold.",
      lastCalculatedAt: heat.lastCalculatedAt,
      lastCalculatedLabel: `Last calculated ${formatTimestamp(heat.lastCalculatedAt)}`,
      expiredAt: heat.expiredAt,
      expiredLabel: `Expired ${formatTimestamp(heat.expiredAt)}`,
    });
  }
  if (heat.status === "unavailable") {
    return Object.freeze({
      availability: "unavailable" as const,
      badge,
      message: heat.reason === "RELEASE_MISMATCH"
        ? "Heat is awaiting a signal matched to this data release."
        : "A heat signal has not been published for this repack yet.",
    });
  }

  const { signal } = heat;
  const confidence = signal.signalConfidence;
  const activity = signal.components.activity.status === "available"
    ? Object.freeze({
        id: "activity" as const,
        label: "Pull activity",
        value: `${formatPercentBasisPoints(signal.components.activity.relativeRateDeltaBasisPoints)} rate`,
        context: `${pullCountLabel(signal.components.activity.currentPullCount)} recent · ${pullCountLabel(signal.components.activity.baselinePullCount)} baseline`,
        availability: "available" as const,
        accessibleLabel: `Pull activity: ${formatPercentBasisPoints(signal.components.activity.relativeRateDeltaBasisPoints)} relative rate change. ${pullCountLabel(signal.components.activity.currentPullCount)} recent; ${pullCountLabel(signal.components.activity.baselinePullCount)} baseline.`,
      })
    : unavailableComponent(
        "activity",
        "Pull activity",
        signal.components.activity.reason,
      );
  const observedReturn = signal.components.observedReturn.status === "available"
    ? Object.freeze({
        id: "observedReturn" as const,
        label: "Observed return rate",
        value: formatPointBasisPoints(signal.components.observedReturn.rateDeltaBasisPoints),
        context: `${formatUnsignedPercentBasisPoints(signal.components.observedReturn.currentReturnBasisPoints)} recent · ${formatUnsignedPercentBasisPoints(signal.components.observedReturn.baselineReturnBasisPoints)} baseline`,
        availability: "available" as const,
        accessibleLabel: `Observed return rate: ${formatPointBasisPoints(signal.components.observedReturn.rateDeltaBasisPoints)} versus baseline. Recent ${formatUnsignedPercentBasisPoints(signal.components.observedReturn.currentReturnBasisPoints)}; baseline ${formatUnsignedPercentBasisPoints(signal.components.observedReturn.baselineReturnBasisPoints)}.`,
      })
    : unavailableComponent(
        "observedReturn",
        "Observed return rate",
        signal.components.observedReturn.reason,
      );
  const largeHits = signal.components.largeHitFrequency.status === "available"
    ? Object.freeze({
        id: "largeHitFrequency" as const,
        label: "Large-hit frequency",
        value: formatPointBasisPoints(signal.components.largeHitFrequency.rateDeltaBasisPoints),
        context: `${signal.components.largeHitFrequency.currentHitCount} recent · ${signal.components.largeHitFrequency.baselineHitCount} baseline · threshold ${NUMBER_FORMATTER.format(signal.components.largeHitFrequency.thresholdMultipleBasisPoints / 10_000)}× price`,
        availability: "available" as const,
        accessibleLabel: `Large-hit frequency: ${formatPointBasisPoints(signal.components.largeHitFrequency.rateDeltaBasisPoints)} versus baseline. ${signal.components.largeHitFrequency.currentHitCount} recent hits; ${signal.components.largeHitFrequency.baselineHitCount} baseline hits; threshold ${NUMBER_FORMATTER.format(signal.components.largeHitFrequency.thresholdMultipleBasisPoints / 10_000)} times repack price.`,
      })
    : unavailableComponent(
        "largeHitFrequency",
        "Large-hit frequency",
        signal.components.largeHitFrequency.reason,
      );
  const chase = signal.components.chaseAvailability.status === "available"
    ? Object.freeze({
        id: "chaseAvailability" as const,
        label: "Chase availability",
        value: signal.components.chaseAvailability.change === "restocked"
          ? "Restocked"
          : signal.components.chaseAvailability.change === "depleted"
            ? "Depleted"
            : "Unchanged",
        context: `${signal.components.chaseAvailability.currentAvailableChaseCount} available now · ${signal.components.chaseAvailability.baselineAvailableChaseCount} baseline`,
        availability: "available" as const,
        accessibleLabel: `Chase availability: ${signal.components.chaseAvailability.change}. ${signal.components.chaseAvailability.currentAvailableChaseCount} available now; ${signal.components.chaseAvailability.baselineAvailableChaseCount} baseline.`,
      })
    : unavailableComponent(
        "chaseAvailability",
        "Chase availability",
        signal.components.chaseAvailability.reason,
      );
  const pool = signal.components.poolComposition.status === "available"
    ? Object.freeze({
        id: "poolComposition" as const,
        label: "Pool composition",
        value: signal.components.poolComposition.changed
          ? `${formatUnsignedPercentBasisPoints(signal.components.poolComposition.changeMagnitudeBasisPoints)} changed`
          : "Unchanged",
        context: `${signal.components.poolComposition.addedOutcomeCount} added · ${signal.components.poolComposition.removedOutcomeCount} removed`,
        availability: "available" as const,
        accessibleLabel: `Pool composition: ${signal.components.poolComposition.changed ? `${formatUnsignedPercentBasisPoints(signal.components.poolComposition.changeMagnitudeBasisPoints)} changed` : "unchanged"}. ${signal.components.poolComposition.addedOutcomeCount} outcomes added; ${signal.components.poolComposition.removedOutcomeCount} removed.`,
      })
    : unavailableComponent(
        "poolComposition",
        "Pool composition",
        signal.components.poolComposition.reason,
      );

  return Object.freeze({
    availability: "current" as const,
    badge,
    provenanceLabel: signal.provenance.kind === "simulated"
      ? "Simulated data" as const
      : "Observed data" as const,
    indexLabel: signal.scoreBasisPoints === null
      ? "Pending sample"
      : formatIndex(signal.scoreBasisPoints),
    indexAccessibleLabel: signal.scoreBasisPoints === null
      ? "Heat index unavailable until minimum samples are met."
      : `Heat index ${formatIndex(signal.scoreBasisPoints)}. This is an index, not a percentage, probability, or EV.`,
    confidenceLabel: confidence === null
      ? "Pending sample"
      : `${confidence.band[0]!.toUpperCase()}${confidence.band.slice(1)} · ${formatConfidenceBasisPoints(confidence.scoreBasisPoints)}`,
    confidenceAccessibleLabel: confidence === null
      ? "Heat signal confidence unavailable until minimum samples are met."
      : `Heat signal confidence: ${confidence.band}, ${formatConfidenceBasisPoints(confidence.scoreBasisPoints)}.`,
    currentWindow: Object.freeze({
      startedAt: signal.currentWindow.startedAt,
      endedAt: signal.currentWindow.endedAt,
      startedLabel: formatTimestamp(signal.currentWindow.startedAt),
      endedLabel: formatTimestamp(signal.currentWindow.endedAt),
      pullCountLabel: pullCountLabel(signal.currentWindow.pullCount),
    }),
    baselineWindow: Object.freeze({
      startedAt: signal.baselineWindow.startedAt,
      endedAt: signal.baselineWindow.endedAt,
      startedLabel: formatTimestamp(signal.baselineWindow.startedAt),
      endedLabel: formatTimestamp(signal.baselineWindow.endedAt),
      pullCountLabel: pullCountLabel(signal.baselineWindow.pullCount),
    }),
    sampleRequirementLabel: `Minimum samples: ${signal.sampleRequirements.minimumCurrentPullCount} recent · ${signal.sampleRequirements.minimumBaselinePullCount} baseline`,
    driverExplanation: signal.state === "insufficient_data"
      ? "Minimum samples are not met, so contributions are diagnostic only and no Heat index is published. They are not EV, profitability, or recommendations."
      : "Contributions move the Heat index from its neutral 50-point baseline. They are not EV, profitability, or recommendations.",
    drivers: Object.freeze(
      signal.drivers.map(({ code, contributionBasisPoints }) =>
        presentDriver(
          code,
          contributionBasisPoints,
          driverComponentIsAvailable(code, signal.components),
        )
      ),
    ),
    components: Object.freeze([activity, observedReturn, largeHits, chase, pool]),
    limitations: Object.freeze(
      signal.limitationCodes.map((limitation) => LIMITATION_COPY[limitation]),
    ),
    calculatedAt: signal.calculatedAt,
    calculatedLabel: `Calculated ${formatTimestamp(signal.calculatedAt)}`,
    expiresAt: signal.expiresAt,
    expiresLabel: `Expires ${formatTimestamp(signal.expiresAt)}`,
  });
}
