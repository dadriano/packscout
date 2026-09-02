import {
  providerPlatformKeySchema,
  type ManifestGateMonitoring,
  type PromotionJobInvocationMonitoring,
  type PromotionJobPublicReleaseMonitoring,
  type PromotionJobScheduleMonitoring,
  type PromotionJobWakeMonitoring,
  type ProviderLifecycleState,
  type ProviderPromotionJobMonitoring,
} from "@packscout/contracts";

const POSITION_PATTERN = /^(?:0|[1-9][0-9]{0,18})$/u;
const SAFE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/u;

export interface ProviderPromotionMonitoringRosterRow {
  readonly providerKey: string;
  readonly displayName: string;
  readonly lifecycle: ProviderLifecycleState;
}

export interface ProviderPromotionMonitoringLocalFacts {
  readonly observedAt: string;
  readonly schedule: PromotionJobScheduleMonitoring | null;
  readonly wake: PromotionJobWakeMonitoring | null;
  readonly settledPosition: string | null;
  readonly completedRelease: PromotionJobPublicReleaseMonitoring | null;
  readonly latestInvocation: PromotionJobInvocationMonitoring | null;
  readonly executionState: "ready" | "retry_wait" | "blocked" | "failed";
  readonly projectionLagMs: number | null;
}

export interface ProviderPromotionMonitoringCentralFacts {
  readonly activeRelease: PromotionJobPublicReleaseMonitoring | null;
  readonly pendingGate: ManifestGateMonitoring | null;
}

export interface JudgeProviderPromotionMonitoringInput {
  readonly roster: ProviderPromotionMonitoringRosterRow;
  readonly live: ProviderPromotionMonitoringLocalFacts | null;
  readonly lastKnown: ProviderPromotionMonitoringLocalFacts | null;
  readonly central: ProviderPromotionMonitoringCentralFacts;
  readonly routeFailureCode: string | null;
  readonly evaluatorCurrent: boolean;
}

export class PromotionJobMonitoringJudgmentError extends Error {
  readonly code = "PROMOTION_JOB_MONITORING_EVIDENCE_INVALID";

  constructor() {
    super("Promotion job monitoring evidence is invalid.");
    this.name = "PromotionJobMonitoringJudgmentError";
  }
}

function invalid(): never {
  throw new PromotionJobMonitoringJudgmentError();
}

function instant(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function position(value: string | null): bigint | null {
  if (value === null) return null;
  if (!POSITION_PATTERN.test(value)) invalid();
  return BigInt(value);
}

function assertRelease(
  release: PromotionJobPublicReleaseMonitoring | null,
  requirePosition = false,
): void {
  if (release === null) return;
  if (
    typeof release.publicReleaseId !== "string"
    || release.publicReleaseId.length < 1
    || release.publicReleaseId.length > 256
    || !/^[0-9a-f]{64}$/u.test(release.fingerprint)
    || (requirePosition && release.position === null)
  ) invalid();
  position(release.position);
}

function assertLocal(facts: ProviderPromotionMonitoringLocalFacts): void {
  if (!instant(facts.observedAt)) invalid();
  position(facts.settledPosition);
  assertRelease(facts.completedRelease, true);
  if (
    facts.completedRelease !== null
    && (facts.settledPosition === null
      || position(facts.completedRelease.position)! > position(facts.settledPosition)!)
  ) invalid();
  if (
    facts.projectionLagMs !== null
    && (!Number.isInteger(facts.projectionLagMs) || facts.projectionLagMs < 0)
  ) invalid();
}

function releasesMatch(
  completed: PromotionJobPublicReleaseMonitoring,
  active: PromotionJobPublicReleaseMonitoring | null,
): boolean {
  return active !== null
    && completed.publicReleaseId === active.publicReleaseId
    && completed.fingerprint === active.fingerprint
    && (active.position === null || completed.position === active.position);
}

function liveState(
  facts: ProviderPromotionMonitoringLocalFacts,
  central: ProviderPromotionMonitoringCentralFacts,
): ProviderPromotionJobMonitoring["state"] {
  if (facts.executionState !== "ready") return facts.executionState;
  const settled = position(facts.settledPosition) ?? 0n;
  const completed = facts.completedRelease === null
    ? 0n
    : position(facts.completedRelease.position)!;
  if (settled > completed) return "awaiting_publication";
  if (
    facts.completedRelease !== null
    && !releasesMatch(facts.completedRelease, central.activeRelease)
  ) return "awaiting_activation";
  return "current";
}

/**
 * Joins one provider's split observations without fabricating live evidence.
 * The browser renders this verdict and never compares checkpoints itself.
 */
export function judgeProviderPromotionMonitoring(
  input: JudgeProviderPromotionMonitoringInput,
): ProviderPromotionJobMonitoring {
  const providerKey = providerPlatformKeySchema.safeParse(
    input.roster.providerKey,
  );
  if (
    !providerKey.success
    || input.roster.displayName.trim() !== input.roster.displayName
    || input.roster.displayName.length < 1
    || input.roster.displayName.length > 120
    || (input.routeFailureCode !== null
      && !SAFE_CODE_PATTERN.test(input.routeFailureCode))
  ) invalid();
  assertRelease(input.central.activeRelease);
  if (input.live !== null) assertLocal(input.live);
  if (input.lastKnown !== null) assertLocal(input.lastKnown);

  const local = input.live ?? input.lastKnown;
  const evidenceSource = input.live !== null
    ? "live" as const
    : input.lastKnown !== null
      ? "last_known" as const
      : "unavailable" as const;
  let state: ProviderPromotionJobMonitoring["state"];
  if (input.roster.lifecycle !== "active") {
    state = input.roster.lifecycle === "archived" && local !== null
      ? "last_known"
      : "inactive";
  } else if (evidenceSource === "unavailable") {
    state = "unavailable";
  } else if (evidenceSource === "last_known") {
    state = "last_known";
  } else {
    state = liveState(local!, input.central);
  }
  return {
    providerKey: providerKey.data,
    displayName: input.roster.displayName,
    lifecycle: input.roster.lifecycle,
    evidenceSource,
    observedAt: local?.observedAt ?? null,
    stale: evidenceSource !== "live" || !input.evaluatorCurrent,
    routeFailureCode: evidenceSource === "live"
      ? null
      : input.routeFailureCode,
    state,
    schedule: local?.schedule ?? null,
    wake: local?.wake ?? null,
    settledPosition: local?.settledPosition ?? null,
    completedRelease: local?.completedRelease ?? null,
    activeRelease: input.central.activeRelease,
    pendingGate: input.central.pendingGate,
    latestInvocation: local?.latestInvocation ?? null,
    projectionLagMs: local?.projectionLagMs ?? null,
  };
}
