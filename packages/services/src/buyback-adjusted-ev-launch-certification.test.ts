import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PACKSCOUT_BUYBACK_EV_BROWSER_EVIDENCE_PENDING_V1,
  PACKSCOUT_BUYBACK_EV_CERTIFICATION_CRITERIA_V1,
  PACKSCOUT_BUYBACK_EV_CERTIFICATION_MANIFEST_V1,
  PACKSCOUT_BUYBACK_EV_HUMAN_APPROVALS_V1,
  PACKSCOUT_BUYBACK_EV_LAUNCH_PROVIDERS_V1,
  PACKSCOUT_BUYBACK_EV_LAUNCH_SCENARIO_CLASSES_V1,
  composePackScoutBuybackEvLaunchCertificationV1,
  evaluatePackScoutBuybackEvLaunchCertificationV1,
  packScoutBuybackEvUnrecordedHumanApprovalsV1,
  serializePackScoutBuybackEvLaunchCertificationV1,
  type PackScoutBuybackEvBrowserEvidenceItemV1,
  type PackScoutBuybackEvHumanApprovalV1,
  type PackScoutBuybackEvLaunchCertificationEvidenceV1,
  type PackScoutBuybackEvProviderTraceV1,
} from "./buyback-adjusted-ev-launch-certification.ts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const GENERATED_AT = "2026-08-20T00:00:00.000Z";

function trace(
  providerKey: (typeof PACKSCOUT_BUYBACK_EV_LAUNCH_PROVIDERS_V1)[number],
  scenarioClasses: PackScoutBuybackEvProviderTraceV1["scenarioClasses"],
  overrides: Partial<PackScoutBuybackEvProviderTraceV1> = {},
): PackScoutBuybackEvProviderTraceV1 {
  return {
    providerKey,
    productKey: `${providerKey}:example`,
    scenario: `sanitized ${providerKey} example`,
    scenarioClasses,
    sourceRevisionId: `${providerKey}-rev-1`,
    observedAt: "2026-08-19T18:20:00.000Z",
    calculatedAt: "2026-08-19T18:25:00.000Z",
    effectiveFingerprint: "a".repeat(64),
    revisionId: "9c000000-0000-4000-8000-00000000000e",
    status: "current",
    publicReason: null,
    metrics: {
      grossEvMinorUnits: 8_500,
      grossReturnBasisPoints: 8_500,
      evDollarsMinorUnits: -1_500,
      evPercentBasisPoints: -1_500,
    },
    confidence: {
      scoreBasisPoints: 10_000,
      band: "high",
      limitationCodes: [],
    },
    rendered: {
      statusLabel: "Current estimate",
      grossEvDollars: "$85.00",
      grossEvPercent: "85.00%",
      evDollars: "-$15.00",
      evPercent: "-15.00%",
      confidenceDisplay: "High · 100%",
      reasonCopy: null,
      sourceAgeLabel: "Source data fresh (within 15 minutes)",
      outboundActionAllowed: true,
    },
    hopsReconciled: true,
    firstMismatch: null,
    ...overrides,
  };
}

function completeTraces(): readonly PackScoutBuybackEvProviderTraceV1[] {
  return [
    trace("beezie", ["mandatory_adjustment", "midpoint", "published_fallback"]),
    trace("clutchpacks", ["outcome_specific_rate", "current_pool"]),
    trace("collector_crypt", ["uniform_rate", "mandatory_adjustment"]),
    trace("courtyard", ["uniform_rate", "published_fallback", "midpoint"]),
    trace("gamestop", ["fixed_payout", "ineligibility"]),
    trace("phygitals", ["no_buyback"], {
      status: "unavailable",
      publicReason: "BUYBACK_UNAVAILABLE",
      metrics: null,
      confidence: null,
    }),
    trace("stadium_vault", ["unavailable_evidence"], {
      status: "unavailable",
      publicReason: "SOURCE_EVIDENCE_UNAVAILABLE",
      metrics: null,
      confidence: null,
    }),
    trace("trove", ["fixed_payout", "published_fallback"]),
  ];
}

function recordedApprovals(): readonly PackScoutBuybackEvHumanApprovalV1[] {
  return packScoutBuybackEvUnrecordedHumanApprovalsV1().map((approval) => ({
    ...approval,
    status: "approved" as const,
    approver: "owner@example",
    recordedAt: GENERATED_AT,
    note: "Recorded for the strict-evaluation unit fixture.",
  }));
}

function closedBrowserEvidence(): readonly PackScoutBuybackEvBrowserEvidenceItemV1[] {
  return PACKSCOUT_BUYBACK_EV_BROWSER_EVIDENCE_PENDING_V1.map((item) => ({
    ...item,
    status: "pass" as const,
    recordedBy: "deploy-verifier@example",
    recordedAt: GENERATED_AT,
  }));
}

function passingEvidence(): PackScoutBuybackEvLaunchCertificationEvidenceV1 {
  return {
    generatedAt: GENERATED_AT,
    candidateCommit: "0123456789abcdef0123456789abcdef01234567",
    operationalLedger: {
      ledgerDigest: "b".repeat(64),
      readiness: "pass",
      generatedAt: GENERATED_AT,
      rollbackDrillExecuted: true,
      artifactPath: "docs/evidence/buyback-adjusted-ev-readiness-ledger.json",
    },
    providerTraces: completeTraces(),
    vendorEvSeparationProven: true,
    pullsVerifiedInventoryOnly: true,
    publicBoundaryScan: {
      scannedReleases: 2,
      forbiddenTokensChecked: 40,
      hits: [],
    },
    manifestVerification: {
      verifiedAt: GENERATED_AT,
      entriesVerified: PACKSCOUT_BUYBACK_EV_CERTIFICATION_MANIFEST_V1.length,
      missing: [],
    },
    verificationCommands: [
      { command: "npm run verify:framework", exitCode: 0, completedAt: GENERATED_AT },
      { command: "npm run test:frontend", exitCode: 0, completedAt: GENERATED_AT },
    ],
    candidateRelease: {
      publicReleaseId: "9c000000-0000-4000-8000-0000000000aa",
      releaseFingerprint: "c".repeat(64),
      dataAsOf: "2026-08-19T18:30:00.000Z",
      configurationFingerprintSha256: "d".repeat(64),
    },
    browserEvidence: closedBrowserEvidence(),
    humanApprovals: recordedApprovals(),
  };
}

test("the product-experience manifest names only existing files that still contain every named test", () => {
  assert.ok(PACKSCOUT_BUYBACK_EV_CERTIFICATION_MANIFEST_V1.length >= 12);
  for (const entry of PACKSCOUT_BUYBACK_EV_CERTIFICATION_MANIFEST_V1) {
    assert.ok(entry.evidence.length > 0, entry.claim);
    for (const { file, testName } of entry.evidence) {
      const absolute = path.join(repositoryRoot, file);
      let content: string;
      try {
        content = readFileSync(absolute, "utf8");
      } catch {
        assert.fail(`manifest evidence file missing: ${file}`);
      }
      assert.ok(
        content.includes(testName),
        `manifest test missing from ${file}: ${testName}`,
      );
    }
  }
});

test("complete evidence with recorded approvals evaluates to a strict pass", () => {
  const evaluation = evaluatePackScoutBuybackEvLaunchCertificationV1(
    passingEvidence(),
  );
  assert.equal(evaluation.certification, "pass");
  assert.equal(
    evaluation.criteria.length,
    PACKSCOUT_BUYBACK_EV_CERTIFICATION_CRITERIA_V1.length,
  );
  assert.ok(evaluation.criteria.every(({ status }) => status === "pass"));
  assert.equal(
    evaluation.criteria.filter(({ kind }) => kind === "human").length,
    PACKSCOUT_BUYBACK_EV_HUMAN_APPROVALS_V1.length,
  );
});

test("each failed criterion blocks the certification and nothing can waive it", () => {
  const base = passingEvidence();
  const mutations: readonly [string, PackScoutBuybackEvLaunchCertificationEvidenceV1][] = [
    ["operational_readiness_linked", { ...base, operationalLedger: null }],
    [
      "operational_readiness_linked",
      {
        ...base,
        operationalLedger: { ...base.operationalLedger!, readiness: "blocked" },
      },
    ],
    [
      "provider_traces_reconciled",
      { ...base, providerTraces: base.providerTraces.slice(1) },
    ],
    [
      "provider_traces_reconciled",
      {
        ...base,
        providerTraces: base.providerTraces.map((entry, index) =>
          index === 0
            ? { ...entry, hopsReconciled: false, firstMismatch: "metrics diverged" }
            : entry,
        ),
      },
    ],
    [
      "provider_traces_reconciled",
      {
        ...base,
        providerTraces: base.providerTraces.map((entry) =>
          entry.providerKey === "phygitals"
            ? { ...entry, scenarioClasses: [] }
            : entry,
        ),
      },
    ],
    ["vendor_ev_separation_proven", { ...base, vendorEvSeparationProven: false }],
    ["pulls_verified_inventory_only", { ...base, pullsVerifiedInventoryOnly: false }],
    ["public_boundary_sanitized", { ...base, publicBoundaryScan: null }],
    [
      "public_boundary_sanitized",
      {
        ...base,
        publicBoundaryScan: {
          scannedReleases: 2,
          forbiddenTokensChecked: 40,
          hits: ["organization-id-leaked"],
        },
      },
    ],
    ["product_experience_manifest_verified", { ...base, manifestVerification: null }],
    [
      "product_experience_manifest_verified",
      {
        ...base,
        manifestVerification: {
          verifiedAt: GENERATED_AT,
          entriesVerified: 3,
          missing: ["apps/frontend/lib/gone.test.ts"],
        },
      },
    ],
    ["verification_gate_passed", { ...base, verificationCommands: [] }],
    [
      "verification_gate_passed",
      {
        ...base,
        verificationCommands: [
          { command: "npm run verify:framework", exitCode: 1, completedAt: GENERATED_AT },
        ],
      },
    ],
    [
      "verification_gate_passed",
      {
        ...base,
        verificationCommands: [
          { command: "npm test", exitCode: 0, completedAt: GENERATED_AT },
        ],
      },
    ],
    ["release_identity_recorded", { ...base, candidateRelease: null }],
    [
      "rollback_proof_recorded",
      {
        ...base,
        operationalLedger: {
          ...base.operationalLedger!,
          rollbackDrillExecuted: false,
        },
      },
    ],
    ["browser_evidence_closed", { ...base, browserEvidence: [] }],
    [
      "browser_evidence_closed",
      { ...base, browserEvidence: PACKSCOUT_BUYBACK_EV_BROWSER_EVIDENCE_PENDING_V1 },
    ],
  ];
  for (const [criterion, evidence] of mutations) {
    const evaluation = evaluatePackScoutBuybackEvLaunchCertificationV1(evidence);
    assert.equal(evaluation.certification, "blocked", criterion);
    assert.equal(
      evaluation.criteria.find((entry) => entry.criterion === criterion)?.status,
      "blocked",
      criterion,
    );
  }
});

test("human approvals only pass with a recorded approver and timestamp; defaults ship unrecorded", () => {
  const defaults = packScoutBuybackEvUnrecordedHumanApprovalsV1();
  assert.deepEqual(
    defaults.map(({ key }) => key),
    [...PACKSCOUT_BUYBACK_EV_HUMAN_APPROVALS_V1],
  );
  assert.ok(
    defaults.every(
      (approval) =>
        approval.status === "unrecorded" &&
        approval.approver === null &&
        approval.recordedAt === null,
    ),
  );

  const base = passingEvidence();
  const withDefaults = evaluatePackScoutBuybackEvLaunchCertificationV1({
    ...base,
    humanApprovals: defaults,
  });
  assert.equal(withDefaults.certification, "blocked");
  assert.deepEqual(
    withDefaults.criteria
      .filter(({ kind, status }) => kind === "human" && status === "blocked")
      .map(({ criterion }) => criterion),
    [
      "product_approval_recorded",
      "engineering_approval_recorded",
      "gamestop_trove_terms_confirmed",
      "ncpg_contact_review_recorded",
    ],
  );

  // An "approved" status without approver identity or timestamp stays blocked.
  const unattributed = evaluatePackScoutBuybackEvLaunchCertificationV1({
    ...base,
    humanApprovals: recordedApprovals().map((approval) => ({
      ...approval,
      approver: null,
    })),
  });
  assert.equal(unattributed.certification, "blocked");
  const untimed = evaluatePackScoutBuybackEvLaunchCertificationV1({
    ...base,
    humanApprovals: recordedApprovals().map((approval) => ({
      ...approval,
      recordedAt: null,
    })),
  });
  assert.equal(untimed.certification, "blocked");
  const rejected = evaluatePackScoutBuybackEvLaunchCertificationV1({
    ...base,
    humanApprovals: recordedApprovals().map((approval, index) =>
      index === 0 ? { ...approval, status: "rejected" as const } : approval,
    ),
  });
  assert.equal(rejected.certification, "blocked");
});

test("the browser checklist ships pending-deploy items from tasks 010, 011, and 013 only", () => {
  assert.ok(PACKSCOUT_BUYBACK_EV_BROWSER_EVIDENCE_PENDING_V1.length >= 9);
  const ids = new Set(
    PACKSCOUT_BUYBACK_EV_BROWSER_EVIDENCE_PENDING_V1.map(({ id }) => id),
  );
  assert.equal(
    ids.size,
    PACKSCOUT_BUYBACK_EV_BROWSER_EVIDENCE_PENDING_V1.length,
  );
  for (const item of PACKSCOUT_BUYBACK_EV_BROWSER_EVIDENCE_PENDING_V1) {
    assert.equal(item.status, "pending_deploy");
    assert.equal(item.recordedBy, null);
    assert.equal(item.recordedAt, null);
    assert.ok(["010", "011", "013"].includes(item.sourceTask));
  }
});

test("the composed record carries a stable digest over its canonical body", () => {
  const first = composePackScoutBuybackEvLaunchCertificationV1(passingEvidence());
  const second = composePackScoutBuybackEvLaunchCertificationV1(passingEvidence());
  assert.equal(first.certification, "pass");
  assert.equal(first.certificationDigest, second.certificationDigest);
  assert.match(first.certificationDigest, /^[0-9a-f]{64}$/u);

  const tampered = composePackScoutBuybackEvLaunchCertificationV1({
    ...passingEvidence(),
    vendorEvSeparationProven: false,
  });
  assert.notEqual(tampered.certificationDigest, first.certificationDigest);
  assert.equal(tampered.certification, "blocked");

  const serialized = serializePackScoutBuybackEvLaunchCertificationV1(first);
  assert.ok(serialized.endsWith("\n"));
  assert.deepEqual(JSON.parse(serialized), first);
});

test("launch providers and scenario classes are unique, canonical, and complete", () => {
  assert.equal(PACKSCOUT_BUYBACK_EV_LAUNCH_PROVIDERS_V1.length, 8);
  assert.deepEqual(
    [...PACKSCOUT_BUYBACK_EV_LAUNCH_PROVIDERS_V1],
    [...PACKSCOUT_BUYBACK_EV_LAUNCH_PROVIDERS_V1].sort(),
  );
  assert.equal(PACKSCOUT_BUYBACK_EV_LAUNCH_SCENARIO_CLASSES_V1.length, 10);
  assert.equal(
    new Set(PACKSCOUT_BUYBACK_EV_LAUNCH_SCENARIO_CLASSES_V1).size,
    10,
  );
});
