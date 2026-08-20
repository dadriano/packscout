import { createHash } from "node:crypto";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  canonicalJson,
} from "@packscout/contracts";
import type { PackScoutBuybackEvBackfillLedgerV1 } from "./buyback-adjusted-ev-backfill-reconciliation.ts";
import {
  PACKSCOUT_BUYBACK_EV_CUTOVER_INVENTORY_V1,
  packScoutBuybackEvCutoverDispositionCountsV1,
} from "./buyback-adjusted-ev-cutover-inventory.ts";
import {
  PACKSCOUT_BUYBACK_EV_ALERT_CONDITIONS_V1,
  PACKSCOUT_BUYBACK_EV_ALERT_MAPPING_V1,
  assertPackScoutBuybackEvOperationalEventSanitizedV1,
  type PackScoutBuybackEvAlertConditionV1,
} from "./buyback-adjusted-ev-operational-monitor.ts";
import type { PackScoutV3CutoverStep } from "./buyback-adjusted-ev-cutover-runbook.ts";

/**
 * Operational readiness ledger for the buyback-adjusted EV cutover
 * (task buyback-adjusted-ev/012).
 *
 * The ledger is one typed, reproducible record of everything the release
 * decision rests on: candidate and prior release identities, the exact
 * application commit, method and confidence-policy versions, canonical
 * revision counts, the staged public release id, the approved configuration
 * hash, the source-age distribution, every unavailable reason, maintenance
 * timing, the verification commands run, alert evidence, and the promotion
 * and rollback drill results.
 *
 * The readiness result is strict pass or blocked. `evaluate` recomputes every
 * criterion from raw evidence on every call; there is no waiver, override, or
 * partial-pass input, so a blocked ledger cannot activate a mixed release.
 */

export const PACKSCOUT_BUYBACK_EV_READINESS_LEDGER_VERSION =
  "packscout-buyback-ev-readiness-ledger-v1" as const;

export const PACKSCOUT_BUYBACK_EV_READINESS_CRITERIA_V1 = Object.freeze([
  "inventory_dispositions_complete",
  "backfill_reconciled",
  "versions_uniform",
  "staging_reconciled_without_activation",
  "observability_alerts_mapped",
  "alert_evidence_sanitized",
  "failure_drills_verified",
  "rollback_drill_recorded",
  "maintenance_gated",
] as const);

export type PackScoutBuybackEvReadinessCriterionV1 =
  (typeof PACKSCOUT_BUYBACK_EV_READINESS_CRITERIA_V1)[number];

export interface PackScoutBuybackEvReadinessCriterionResultV1 {
  readonly criterion: PackScoutBuybackEvReadinessCriterionV1;
  readonly status: "pass" | "blocked";
  readonly evidence: string;
}

export interface PackScoutBuybackEvReleaseIdentityV1 {
  readonly publicReleaseId: string;
  readonly releaseFingerprint: string;
  readonly dataAsOf: string;
}

export interface PackScoutBuybackEvVerificationCommandV1 {
  readonly command: string;
  readonly exitCode: number;
  readonly completedAt: string;
}

export interface PackScoutBuybackEvAlertEvidenceV1 {
  readonly condition: PackScoutBuybackEvAlertConditionV1;
  readonly kind: string;
  readonly dedupeKey: string;
  readonly status: "accepted" | "deduplicated" | "resolved" | "failed";
}

export interface PackScoutBuybackEvPromotionEvidenceV1 {
  readonly outcome:
    | "cut_over"
    | "rolled_back"
    | "aborted_before_maintenance"
    | "not_executed";
  readonly publicReleaseId: string | null;
  readonly failedStep: PackScoutV3CutoverStep | null;
  readonly steps: readonly PackScoutV3CutoverStep[];
}

export interface PackScoutBuybackEvRollbackDrillEvidenceV1 {
  readonly executed: boolean;
  readonly failedStep: PackScoutV3CutoverStep | null;
  readonly steps: readonly PackScoutV3CutoverStep[];
  readonly restoredActivePublicReleaseId: string | null;
}

export interface PackScoutBuybackEvMaintenanceTimingV1 {
  readonly gatedAt: string;
  readonly reopenedAt: string;
}

/** Raw evidence the ledger is composed and evaluated from. */
export interface PackScoutBuybackEvReadinessEvidenceV1 {
  readonly generatedAt: string;
  readonly applicationCommit: string;
  readonly configurationFingerprintSha256: string;
  readonly candidate: PackScoutBuybackEvReleaseIdentityV1 | null;
  readonly prior: PackScoutBuybackEvReleaseIdentityV1 | null;
  readonly backfill: PackScoutBuybackEvBackfillLedgerV1;
  readonly maintenance: PackScoutBuybackEvMaintenanceTimingV1 | null;
  readonly verificationCommands: readonly PackScoutBuybackEvVerificationCommandV1[];
  readonly alerts: readonly PackScoutBuybackEvAlertEvidenceV1[];
  readonly promotion: PackScoutBuybackEvPromotionEvidenceV1;
  readonly rollbackDrill: PackScoutBuybackEvRollbackDrillEvidenceV1;
}

export interface PackScoutBuybackEvReadinessLedgerV1 {
  readonly schemaVersion: typeof PACKSCOUT_BUYBACK_EV_READINESS_LEDGER_VERSION;
  readonly generatedAt: string;
  readonly readiness: "pass" | "blocked";
  readonly criteria: readonly PackScoutBuybackEvReadinessCriterionResultV1[];
  readonly candidate: PackScoutBuybackEvReleaseIdentityV1 | null;
  readonly prior: PackScoutBuybackEvReleaseIdentityV1 | null;
  readonly applicationCommit: string;
  readonly methodVersion: typeof PACKSCOUT_BUYBACK_EV_METHOD_VERSION;
  readonly confidencePolicyVersion:
    typeof PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION;
  readonly configurationFingerprintSha256: string;
  readonly inventory: Readonly<{
    itemCount: number;
    dispositions: Readonly<Record<string, number>>;
  }>;
  readonly backfill: PackScoutBuybackEvBackfillLedgerV1;
  readonly maintenance: PackScoutBuybackEvMaintenanceTimingV1 | null;
  readonly verificationCommands: readonly PackScoutBuybackEvVerificationCommandV1[];
  readonly alerts: readonly PackScoutBuybackEvAlertEvidenceV1[];
  readonly promotion: PackScoutBuybackEvPromotionEvidenceV1;
  readonly rollbackDrill: PackScoutBuybackEvRollbackDrillEvidenceV1;
  /** sha-256 over the canonical ledger body (excluding this digest). */
  readonly ledgerDigest: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/u;

function result(
  criterion: PackScoutBuybackEvReadinessCriterionV1,
  pass: boolean,
  evidence: string,
): PackScoutBuybackEvReadinessCriterionResultV1 {
  return { criterion, status: pass ? "pass" : "blocked", evidence };
}

function inventoryCriterion(): PackScoutBuybackEvReadinessCriterionResultV1 {
  const counts = packScoutBuybackEvCutoverDispositionCountsV1();
  const missingReplacement = PACKSCOUT_BUYBACK_EV_CUTOVER_INVENTORY_V1.filter(
    (item) =>
      item.disposition === "replaced_by_v3" && item.replacementPath === null,
  );
  const total = PACKSCOUT_BUYBACK_EV_CUTOVER_INVENTORY_V1.length;
  return result(
    "inventory_dispositions_complete",
    total > 0 && missingReplacement.length === 0,
    `${total} inventoried surfaces: ${counts.replaced_by_v3} replaced_by_v3, ` +
      `${counts.historical_only} historical_only, ${counts.retired} retired; ` +
      `${missingReplacement.length} missing replacements.`,
  );
}

function rollbackStepsRestoreBeforeReopen(
  steps: readonly PackScoutV3CutoverStep[],
): boolean {
  const restoreIndex = steps.indexOf("restore_v2_application");
  const reopenIndex = steps.indexOf("reopen_after_failure");
  if (restoreIndex === -1 || reopenIndex === -1 || reopenIndex < restoreIndex) {
    return false;
  }
  const rollbackIndex = steps.indexOf("rollback_v3_release");
  return rollbackIndex === -1 ||
    (rollbackIndex > restoreIndex && rollbackIndex < reopenIndex);
}

/**
 * Recomputes every readiness criterion from raw evidence. The ledger's
 * `readiness` is pass exactly when every criterion passes; nothing in the
 * evidence can waive an individual criterion.
 */
export function evaluatePackScoutBuybackEvReadinessV1(
  evidence: PackScoutBuybackEvReadinessEvidenceV1,
): Readonly<{
  readiness: "pass" | "blocked";
  criteria: readonly PackScoutBuybackEvReadinessCriterionResultV1[];
}> {
  const criteria: PackScoutBuybackEvReadinessCriterionResultV1[] = [];
  criteria.push(inventoryCriterion());

  const backfill = evidence.backfill;
  criteria.push(
    result(
      "backfill_reconciled",
      backfill.classification === "ready" &&
        backfill.counts.total > 0 &&
        backfill.rows.length === backfill.counts.total &&
        backfill.recomputation.rejected === 0 &&
        backfill.recomputation.unbindable === 0 &&
        backfill.blockedReasons.length === 0,
      `Backfill ${backfill.classification}: ${backfill.counts.total} repacks — ` +
        `${backfill.counts.recomputedAvailable} available, ` +
        `${backfill.counts.deterministicUnavailable} deterministically unavailable, ` +
        `${backfill.counts.soldOutHistorical} sold-out historical; ` +
        `${backfill.blockedReasons.length} blocked reasons.`,
    ),
  );

  const versionsUniform =
    backfill.methodVersions.length === 1 &&
    backfill.methodVersions[0] === PACKSCOUT_BUYBACK_EV_METHOD_VERSION &&
    backfill.confidencePolicyVersions.length === 1 &&
    backfill.confidencePolicyVersions[0] ===
      PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION;
  criteria.push(
    result(
      "versions_uniform",
      versionsUniform,
      `Method versions ${backfill.methodVersions.join(", ") || "none"}; ` +
        `confidence policies ${backfill.confidencePolicyVersions.join(", ") || "none"}.`,
    ),
  );

  const staging = backfill.staging;
  criteria.push(
    result(
      "staging_reconciled_without_activation",
      staging !== null &&
        staging.staged &&
        staging.lifecycle === "complete" &&
        !staging.activePointerMoved &&
        evidence.candidate !== null &&
        evidence.candidate.publicReleaseId === staging.publicReleaseId &&
        evidence.candidate.releaseFingerprint === staging.releaseFingerprint,
      staging === null
        ? "No staged release was reconciled."
        : `Release ${staging.publicReleaseId} staged=${staging.staged} ` +
          `lifecycle=${staging.lifecycle} pointerMoved=${staging.activePointerMoved}.`,
    ),
  );

  const deliveredConditions = new Set(
    evidence.alerts
      .filter((alert) => alert.status !== "failed")
      .map((alert) => alert.condition),
  );
  const mappingHolds = evidence.alerts.every((alert) => {
    const mapping = PACKSCOUT_BUYBACK_EV_ALERT_MAPPING_V1.find(
      (entry) => entry.condition === alert.condition,
    );
    return (
      mapping !== undefined &&
      mapping.kind === alert.kind &&
      alert.dedupeKey.startsWith(
        mapping.dedupeKeyPattern.slice(0, mapping.dedupeKeyPattern.indexOf("<")),
      )
    );
  });
  const allConditionsCovered = PACKSCOUT_BUYBACK_EV_ALERT_CONDITIONS_V1.every(
    (condition) => deliveredConditions.has(condition),
  );
  criteria.push(
    result(
      "observability_alerts_mapped",
      allConditionsCovered && mappingHolds,
      `${deliveredConditions.size}/${PACKSCOUT_BUYBACK_EV_ALERT_CONDITIONS_V1.length} ` +
        `alert conditions delivered through the documented mapping.`,
    ),
  );

  let alertsSanitized = true;
  try {
    assertPackScoutBuybackEvOperationalEventSanitizedV1(evidence.alerts);
    assertPackScoutBuybackEvOperationalEventSanitizedV1({
      counts: backfill.counts,
      recomputation: backfill.recomputation,
      methodVersions: backfill.methodVersions,
      blockedReasons: backfill.blockedReasons,
    });
  } catch {
    alertsSanitized = false;
  }
  criteria.push(
    result(
      "alert_evidence_sanitized",
      alertsSanitized,
      alertsSanitized
        ? "Alert and ledger evidence carry bounded labels only."
        : "Protected content was detected in operational evidence.",
    ),
  );

  const commandsPassed =
    evidence.verificationCommands.length > 0 &&
    evidence.verificationCommands.every(({ exitCode }) => exitCode === 0);
  criteria.push(
    result(
      "failure_drills_verified",
      commandsPassed,
      `${evidence.verificationCommands.length} verification commands recorded; ` +
        `${evidence.verificationCommands.filter(({ exitCode }) => exitCode === 0).length} passed.`,
    ),
  );

  const drill = evidence.rollbackDrill;
  const drillHolds =
    drill.executed &&
    rollbackStepsRestoreBeforeReopen(drill.steps);
  criteria.push(
    result(
      "rollback_drill_recorded",
      drillHolds,
      drill.executed
        ? `Rollback drill failed at ${drill.failedStep ?? "unknown"} and restored ` +
          `${drill.restoredActivePublicReleaseId ?? "the retained pointer"} before reopening.`
        : "No maintenance-gated rollback drill was recorded.",
    ),
  );

  const maintenanceHolds =
    evidence.maintenance !== null &&
    Date.parse(evidence.maintenance.gatedAt) <
      Date.parse(evidence.maintenance.reopenedAt) &&
    COMMIT_PATTERN.test(evidence.applicationCommit) &&
    SHA256_HEX.test(evidence.configurationFingerprintSha256);
  criteria.push(
    result(
      "maintenance_gated",
      maintenanceHolds,
      evidence.maintenance === null
        ? "No maintenance window was recorded."
        : `Gated ${evidence.maintenance.gatedAt} through ${evidence.maintenance.reopenedAt} ` +
          `for commit ${evidence.applicationCommit.slice(0, 12)}.`,
    ),
  );

  const readiness = criteria.every(({ status }) => status === "pass")
    ? "pass"
    : "blocked";
  return { readiness, criteria };
}

/** Composes the complete typed ledger with its strict evaluation and digest. */
export function composePackScoutBuybackEvReadinessLedgerV1(
  evidence: PackScoutBuybackEvReadinessEvidenceV1,
): PackScoutBuybackEvReadinessLedgerV1 {
  const evaluation = evaluatePackScoutBuybackEvReadinessV1(evidence);
  const body = {
    schemaVersion: PACKSCOUT_BUYBACK_EV_READINESS_LEDGER_VERSION,
    generatedAt: evidence.generatedAt,
    readiness: evaluation.readiness,
    criteria: evaluation.criteria,
    candidate: evidence.candidate,
    prior: evidence.prior,
    applicationCommit: evidence.applicationCommit,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    configurationFingerprintSha256: evidence.configurationFingerprintSha256,
    inventory: {
      itemCount: PACKSCOUT_BUYBACK_EV_CUTOVER_INVENTORY_V1.length,
      dispositions: packScoutBuybackEvCutoverDispositionCountsV1(),
    },
    backfill: evidence.backfill,
    maintenance: evidence.maintenance,
    verificationCommands: evidence.verificationCommands,
    alerts: evidence.alerts,
    promotion: evidence.promotion,
    rollbackDrill: evidence.rollbackDrill,
  } as const;
  const ledgerDigest = createHash("sha256")
    .update(canonicalJson(body))
    .digest("hex");
  return { ...body, ledgerDigest };
}

/** Deterministic artifact bytes for the generated ledger file. */
export function serializePackScoutBuybackEvReadinessLedgerV1(
  ledger: PackScoutBuybackEvReadinessLedgerV1,
): string {
  return `${JSON.stringify(ledger, null, 2)}\n`;
}
