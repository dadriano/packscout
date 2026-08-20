import assert from "node:assert/strict";
import { test } from "node:test";
import type { PackScoutBuybackEvBackfillLedgerV1 } from "./buyback-adjusted-ev-backfill-reconciliation.ts";
import {
  PACKSCOUT_BUYBACK_EV_READINESS_CRITERIA_V1,
  composePackScoutBuybackEvReadinessLedgerV1,
  evaluatePackScoutBuybackEvReadinessV1,
  serializePackScoutBuybackEvReadinessLedgerV1,
  type PackScoutBuybackEvReadinessEvidenceV1,
} from "./buyback-adjusted-ev-readiness-ledger.ts";

const CANDIDATE_RELEASE_ID = "20000000-0000-8000-8000-000000000001";
const PRIOR_RELEASE_ID = "20000000-0000-8000-8000-000000000000";

function backfillLedger(
  overrides: Partial<PackScoutBuybackEvBackfillLedgerV1> = {},
): PackScoutBuybackEvBackfillLedgerV1 {
  return {
    schemaVersion: "packscout-buyback-ev-backfill-reconciliation-v1",
    organizationId: "42000000-0000-4000-8000-000000000001",
    readAt: "2026-08-19T12:00:00.000Z",
    classification: "ready",
    methodVersions: ["packscout-buyback-adjusted-ev-v1"],
    confidencePolicyVersions: ["packscout-buyback-adjusted-ev-confidence-v1"],
    counts: {
      total: 3,
      recomputedAvailable: 1,
      deterministicUnavailable: 1,
      soldOutHistorical: 1,
      byPublicReason: { BUYBACK_UNAVAILABLE: 1 },
      byConfidenceBand: { low: 0, medium: 0, high: 2 },
      bySourceAge: {
        fresh_within_15_minutes: 2,
        delayed_over_15_through_30_minutes: 0,
        delayed_over_30_through_60_minutes: 0,
        stale_or_expired: 0,
        unknown_source_time: 1,
      },
    },
    recomputation: {
      created: 2,
      unchanged: 1,
      superseded: 0,
      rejected: 0,
      unbindable: 0,
      skippedNoEvidence: 0,
    },
    staging: {
      staged: true,
      publicReleaseId: CANDIDATE_RELEASE_ID,
      releaseFingerprint: "b".repeat(64),
      lifecycle: "complete",
      priorActivePublicReleaseId: PRIOR_RELEASE_ID,
      activePointerMoved: false,
    },
    rows: [
      {
        platformKey: "vendor",
        productKey: "pack-a",
        publicRepackId: "30000000-0000-8000-8000-000000000001",
        availability: "active",
        classification: "recomputed_available",
        publicReason: null,
        recomputationOutcome: "created",
        revisionId: "40000000-0000-4000-8000-000000000001",
        revisionNumber: 1,
        methodVersion: "packscout-buyback-adjusted-ev-v1",
        confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1",
        confidenceBand: "high",
        sourceAgeBucket: "fresh_within_15_minutes",
        calculatedAt: "2026-08-19T11:56:00.000Z",
      },
      {
        platformKey: "vendor",
        productKey: "pack-b",
        publicRepackId: "30000000-0000-8000-8000-000000000002",
        availability: "active",
        classification: "deterministic_unavailable",
        publicReason: "BUYBACK_UNAVAILABLE",
        recomputationOutcome: "created",
        revisionId: "40000000-0000-4000-8000-000000000002",
        revisionNumber: 1,
        methodVersion: "packscout-buyback-adjusted-ev-v1",
        confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1",
        confidenceBand: null,
        sourceAgeBucket: "unknown_source_time",
        calculatedAt: "2026-08-19T11:56:00.000Z",
      },
      {
        platformKey: "vendor",
        productKey: "pack-c",
        publicRepackId: "30000000-0000-8000-8000-000000000003",
        availability: "sold_out",
        classification: "sold_out_historical",
        publicReason: null,
        recomputationOutcome: "unchanged",
        revisionId: "40000000-0000-4000-8000-000000000003",
        revisionNumber: 2,
        methodVersion: "packscout-buyback-adjusted-ev-v1",
        confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1",
        confidenceBand: "high",
        sourceAgeBucket: "fresh_within_15_minutes",
        calculatedAt: "2026-08-19T11:40:00.000Z",
      },
    ],
    blockedReasons: [],
    ...overrides,
  };
}

function passingEvidence(): PackScoutBuybackEvReadinessEvidenceV1 {
  return {
    generatedAt: "2026-08-19T12:30:00.000Z",
    applicationCommit: "fd16dc0aa11bb22cc33dd44ee55ff6677889900a",
    configurationFingerprintSha256: "c".repeat(64),
    candidate: {
      publicReleaseId: CANDIDATE_RELEASE_ID,
      releaseFingerprint: "b".repeat(64),
      dataAsOf: "2026-08-19T12:00:00.000Z",
    },
    prior: {
      publicReleaseId: PRIOR_RELEASE_ID,
      releaseFingerprint: "a".repeat(64),
      dataAsOf: "2026-08-19T11:00:00.000Z",
    },
    backfill: backfillLedger(),
    maintenance: {
      gatedAt: "2026-08-19T12:10:00.000Z",
      reopenedAt: "2026-08-19T12:20:00.000Z",
    },
    verificationCommands: [
      {
        command:
          "node --import tsx --test packages/services/src/buyback-adjusted-ev-backfill-reconciliation.integration.test.ts",
        exitCode: 0,
        completedAt: "2026-08-19T12:25:00.000Z",
      },
      {
        command: "npm run typecheck",
        exitCode: 0,
        completedAt: "2026-08-19T12:26:00.000Z",
      },
    ],
    alerts: [
      {
        condition: "recomputation_backlog",
        kind: "provider_stale",
        dedupeKey: "buyback-ev:backlog:42000000-0000-4000-8000-000000000002",
        status: "accepted",
      },
      {
        condition: "method_mismatch",
        kind: "run_failed",
        dedupeKey:
          "buyback-ev:method-mismatch:42000000-0000-4000-8000-000000000001",
        status: "accepted",
      },
      {
        condition: "publication_rejected",
        kind: "run_failed",
        dedupeKey:
          "buyback-ev:publication:42000000-0000-4000-8000-000000000001",
        status: "deduplicated",
      },
      {
        condition: "freshness_expired",
        kind: "provider_stale",
        dedupeKey: "buyback-ev:freshness:42000000-0000-4000-8000-000000000002",
        status: "accepted",
      },
    ],
    promotion: {
      outcome: "not_executed",
      publicReleaseId: null,
      failedStep: null,
      steps: [],
    },
    rollbackDrill: {
      executed: true,
      failedStep: "deploy_v3_application",
      steps: [
        "prepare_dataset",
        "prepare_artifacts",
        "gate_traffic",
        "deploy_v3_backend",
        "publish_v3_release",
        "deploy_v3_application",
        "restore_v2_application",
        "rollback_v3_release",
        "reopen_after_failure",
      ],
      restoredActivePublicReleaseId: PRIOR_RELEASE_ID,
    },
  };
}

test("complete evidence evaluates to a strict pass with every criterion recorded", () => {
  const ledger = composePackScoutBuybackEvReadinessLedgerV1(passingEvidence());
  assert.equal(ledger.readiness, "pass");
  assert.deepEqual(
    ledger.criteria.map(({ criterion }) => criterion),
    [...PACKSCOUT_BUYBACK_EV_READINESS_CRITERIA_V1],
  );
  assert.ok(ledger.criteria.every(({ status }) => status === "pass"));
  assert.equal(ledger.candidate?.publicReleaseId, CANDIDATE_RELEASE_ID);
  assert.equal(ledger.prior?.publicReleaseId, PRIOR_RELEASE_ID);
  assert.match(ledger.ledgerDigest, /^[0-9a-f]{64}$/);
  assert.ok(ledger.inventory.itemCount > 0);
  // The artifact serialization is deterministic byte for byte.
  assert.equal(
    serializePackScoutBuybackEvReadinessLedgerV1(ledger),
    serializePackScoutBuybackEvReadinessLedgerV1(
      composePackScoutBuybackEvReadinessLedgerV1(passingEvidence()),
    ),
  );
});

test("each failed criterion blocks the result and nothing can waive it", () => {
  const cases: readonly {
    mutate: (evidence: PackScoutBuybackEvReadinessEvidenceV1) =>
      PackScoutBuybackEvReadinessEvidenceV1;
    criterion: (typeof PACKSCOUT_BUYBACK_EV_READINESS_CRITERIA_V1)[number];
  }[] = [
    {
      criterion: "backfill_reconciled",
      mutate: (evidence) => ({
        ...evidence,
        backfill: backfillLedger({
          classification: "blocked",
          blockedReasons: [
            {
              code: "STATE_MISMATCH",
              productKey: "pack-b",
              detail: "Eligibility predicts unavailable, the plan emitted current.",
            },
          ],
        }),
      }),
    },
    {
      criterion: "versions_uniform",
      mutate: (evidence) => ({
        ...evidence,
        backfill: backfillLedger({
          methodVersions: [
            "packscout-buyback-adjusted-ev-v1",
            "packscout-estimated-ev-v1",
          ],
        }),
      }),
    },
    {
      criterion: "staging_reconciled_without_activation",
      mutate: (evidence) => ({
        ...evidence,
        backfill: backfillLedger({
          staging: {
            staged: true,
            publicReleaseId: CANDIDATE_RELEASE_ID,
            releaseFingerprint: "b".repeat(64),
            lifecycle: "complete",
            priorActivePublicReleaseId: PRIOR_RELEASE_ID,
            activePointerMoved: true,
          },
        }),
      }),
    },
    {
      criterion: "observability_alerts_mapped",
      mutate: (evidence) => ({
        ...evidence,
        alerts: evidence.alerts.filter(
          ({ condition }) => condition !== "freshness_expired",
        ),
      }),
    },
    {
      criterion: "failure_drills_verified",
      mutate: (evidence) => ({
        ...evidence,
        verificationCommands: [
          {
            command: "npm run typecheck",
            exitCode: 1,
            completedAt: "2026-08-19T12:26:00.000Z",
          },
        ],
      }),
    },
    {
      criterion: "rollback_drill_recorded",
      mutate: (evidence) => ({
        ...evidence,
        rollbackDrill: {
          executed: true,
          failedStep: "deploy_v3_application",
          steps: [
            "gate_traffic",
            "reopen_after_failure",
            "restore_v2_application",
          ],
          restoredActivePublicReleaseId: PRIOR_RELEASE_ID,
        },
      }),
    },
    {
      criterion: "maintenance_gated",
      mutate: (evidence) => ({ ...evidence, maintenance: null }),
    },
  ];
  for (const { criterion, mutate } of cases) {
    const evidence = mutate(passingEvidence());
    const evaluation = evaluatePackScoutBuybackEvReadinessV1(evidence);
    assert.equal(evaluation.readiness, "blocked", criterion);
    assert.equal(
      evaluation.criteria.find((entry) => entry.criterion === criterion)?.status,
      "blocked",
      criterion,
    );

    // No waiver: smuggling pre-passed criteria or a pass flag into the
    // evidence changes nothing — evaluation recomputes from raw facts.
    const tampered = {
      ...evidence,
      readiness: "pass",
      criteria: PACKSCOUT_BUYBACK_EV_READINESS_CRITERIA_V1.map((name) => ({
        criterion: name,
        status: "pass",
        evidence: "waived",
      })),
      waivers: [criterion],
    } as unknown as PackScoutBuybackEvReadinessEvidenceV1;
    const reevaluated = evaluatePackScoutBuybackEvReadinessV1(tampered);
    assert.equal(reevaluated.readiness, "blocked", `${criterion} was waived`);
    const composed = composePackScoutBuybackEvReadinessLedgerV1(tampered);
    assert.equal(composed.readiness, "blocked");
  }
});

test("a blocked ledger still records complete reproducible evidence", () => {
  const evidence = {
    ...passingEvidence(),
    backfill: backfillLedger({
      classification: "blocked",
      blockedReasons: [
        {
          code: "PLAN_BLOCKED",
          productKey: null,
          detail: "The release assembler blocked the plan: PUBLIC_CONTRACT_INVALID.",
        },
      ],
    }),
    promotion: {
      outcome: "rolled_back" as const,
      publicReleaseId: CANDIDATE_RELEASE_ID,
      failedStep: "verify_candidate_origin" as const,
      steps: [
        "prepare_dataset" as const,
        "prepare_artifacts" as const,
        "gate_traffic" as const,
        "deploy_v3_backend" as const,
        "publish_v3_release" as const,
        "deploy_v3_application" as const,
        "verify_candidate_origin" as const,
        "restore_v2_application" as const,
        "rollback_v3_release" as const,
        "reopen_after_failure" as const,
      ],
    },
  };
  const ledger = composePackScoutBuybackEvReadinessLedgerV1(evidence);
  assert.equal(ledger.readiness, "blocked");
  assert.equal(ledger.promotion.outcome, "rolled_back");
  assert.equal(ledger.backfill.blockedReasons.length, 1);
  assert.equal(ledger.applicationCommit, evidence.applicationCommit);
  assert.equal(
    ledger.configurationFingerprintSha256,
    evidence.configurationFingerprintSha256,
  );
  assert.ok(ledger.verificationCommands.length > 0);
  assert.ok(ledger.alerts.length === 4);
  // The digest covers the blocked evaluation, so evidence cannot be swapped
  // under a previously computed digest.
  const passing = composePackScoutBuybackEvReadinessLedgerV1(passingEvidence());
  assert.notEqual(ledger.ledgerDigest, passing.ledgerDigest);
});
