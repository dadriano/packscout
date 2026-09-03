import assert from "node:assert/strict";
import { test } from "node:test";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import {
  PACKSCOUT_BUYBACK_EV_LAUNCH_PROVIDERS_V1,
  PACKSCOUT_BUYBACK_EV_LAUNCH_SCENARIO_CLASSES_V1,
  composePackScoutBuybackEvLaunchCertificationV1,
  packScoutBuybackEvUnrecordedHumanApprovalsV1,
  PACKSCOUT_BUYBACK_EV_BROWSER_EVIDENCE_PENDING_V1,
} from "./buyback-adjusted-ev-launch-certification.ts";
import {
  CERTIFICATION_PROVIDER_FIXTURES,
  CERTIFICATION_TIMELINE,
  loadPackScoutEvPresentationBoundary,
  runBuybackEvLaunchCertificationHarness,
} from "./buyback-adjusted-ev-launch-certification.test-support.ts";

const ORGANIZATION_ID = "9c000000-0000-4000-8000-000000000001";

/**
 * Task buyback-adjusted-ev/013 provider-to-browser certification: one
 * sanitized real example per launch provider, traced source revision ->
 * normalized evidence -> fingerprint -> immutable revision -> canonical
 * metrics and confidence -> staged public release -> query projection ->
 * rendered presentation output, against a real migrated PostgreSQL and the
 * real frontend presentation boundary (loaded through the documented tsx
 * file-URL mechanism because production code never crosses that boundary).
 */
test("eight sanitized provider examples reconcile from source revision to rendered browser values", async () => {
  const harness = await createMigratedTestDatabase();
  try {
    const presentation = await loadPackScoutEvPresentationBoundary();
    const result = await runBuybackEvLaunchCertificationHarness(harness, {
      organizationId: ORGANIZATION_ID,
      slug: "buyback-ev-launch-certification",
      presentation,
    });

    // Every launch provider is present exactly once and fully reconciled.
    assert.equal(
      result.traces.length,
      PACKSCOUT_BUYBACK_EV_LAUNCH_PROVIDERS_V1.length,
    );
    assert.deepEqual(
      [...result.traces.map(({ providerKey }) => providerKey)].sort(),
      [...PACKSCOUT_BUYBACK_EV_LAUNCH_PROVIDERS_V1],
    );
    for (const trace of result.traces) {
      assert.equal(
        trace.firstMismatch,
        null,
        `${trace.providerKey}: ${trace.firstMismatch}`,
      );
      assert.equal(trace.hopsReconciled, true, trace.providerKey);
      assert.match(trace.effectiveFingerprint, /^[0-9a-f]{64}$/u);
      assert.notEqual(trace.revisionId, "");
    }

    // The set jointly covers every required scenario class.
    const coveredClasses = new Set(
      result.traces.flatMap(({ scenarioClasses }) => scenarioClasses),
    );
    for (const scenarioClass of PACKSCOUT_BUYBACK_EV_LAUNCH_SCENARIO_CLASSES_V1) {
      assert.ok(
        coveredClasses.has(scenarioClass),
        `scenario class not covered: ${scenarioClass}`,
      );
    }

    // Two examples lack usable evidence and the raw positive ClutchPacks
    // example is withheld by the public nonpositive-EV policy. The other five
    // remain current.
    const unavailable = result.traces.filter(
      ({ status }) => status === "unavailable",
    );
    assert.deepEqual(
      unavailable.map(({ publicReason }) => publicReason).sort(),
      [
        "BUYBACK_UNAVAILABLE",
        "CALCULATION_UNAVAILABLE",
        "SOURCE_EVIDENCE_UNAVAILABLE",
      ],
    );
    assert.equal(
      result.traces.filter(({ status }) => status === "current").length,
      5,
    );

    // Vendor-reported EV stayed separate; pulls moved EV only through
    // verified remaining inventory (proven pulls 4900c, unproven stay 3350c).
    assert.equal(result.vendorEvSeparationProven, true);
    assert.equal(result.pullsVerifiedInventoryOnly, true);
    assert.deepEqual(result.pullsProof, {
      baselineGrossEvMinorUnits: 3_350,
      provenPullsGrossEvMinorUnits: 4_900,
      unprovenPullsGrossEvMinorUnits: 3_350,
      secondReleaseId: result.pullsProof.secondReleaseId,
    });
    assert.match(
      result.pullsProof.secondReleaseId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    assert.notEqual(
      result.pullsProof.secondReleaseId,
      result.candidateRelease.publicReleaseId,
    );

    // No raw payload, protected evidence, credential, organization
    // identifier, source revision id, or pre-buyback token crossed the
    // public boundary in either staged release or any rendered output.
    assert.deepEqual(result.publicBoundaryScan.hits, []);
    assert.equal(result.publicBoundaryScan.scannedReleases, 2);
    assert.ok(result.publicBoundaryScan.forbiddenTokensChecked >= 30);

    // The staged candidate release identity is complete and reproducible.
    assert.match(
      result.candidateRelease.releaseFingerprint,
      /^[0-9a-f]{64}$/u,
    );
    assert.match(
      result.candidateRelease.configurationFingerprintSha256,
      /^[0-9a-f]{64}$/u,
    );
    assert.equal(result.candidateRelease.dataAsOf, CERTIFICATION_TIMELINE.readAt);
    assert.equal(result.ledgerRowCount, CERTIFICATION_PROVIDER_FIXTURES.length);

    // The certification record composed from this run is BLOCKED — and only
    // blocked — on the deploy-stage browser checklist and the four human
    // owner approvals. Every automated criterion passes.
    const certification = composePackScoutBuybackEvLaunchCertificationV1({
      generatedAt: "2026-08-20T00:00:00.000Z",
      candidateCommit: "0123456789abcdef0123456789abcdef01234567",
      operationalLedger: {
        ledgerDigest: "f".repeat(64),
        readiness: "pass",
        generatedAt: "2026-08-20T00:00:00.000Z",
        rollbackDrillExecuted: true,
        artifactPath: "docs/evidence/buyback-adjusted-ev-readiness-ledger.json",
      },
      providerTraces: result.traces,
      vendorEvSeparationProven: result.vendorEvSeparationProven,
      pullsVerifiedInventoryOnly: result.pullsVerifiedInventoryOnly,
      publicBoundaryScan: result.publicBoundaryScan,
      manifestVerification: {
        verifiedAt: "2026-08-20T00:00:00.000Z",
        entriesVerified: 14,
        missing: [],
      },
      verificationCommands: [
        {
          command: "npm run verify:framework",
          exitCode: 0,
          completedAt: "2026-08-20T00:00:00.000Z",
        },
      ],
      candidateRelease: result.candidateRelease,
      browserEvidence: PACKSCOUT_BUYBACK_EV_BROWSER_EVIDENCE_PENDING_V1,
      humanApprovals: packScoutBuybackEvUnrecordedHumanApprovalsV1(),
    });
    assert.equal(certification.certification, "blocked");
    const blocked = certification.criteria.filter(
      ({ status }) => status === "blocked",
    );
    assert.deepEqual(
      blocked.map(({ criterion }) => criterion).sort(),
      [
        "browser_evidence_closed",
        "engineering_approval_recorded",
        "gamestop_trove_terms_confirmed",
        "ncpg_contact_review_recorded",
        "product_approval_recorded",
      ],
    );
    assert.ok(
      blocked
        .filter(({ kind }) => kind === "human")
        .every(({ evidence }) => evidence.includes("unrecorded")),
    );
  } finally {
    await harness.close();
  }
});
