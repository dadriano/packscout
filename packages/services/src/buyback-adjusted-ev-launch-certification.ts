import { createHash } from "node:crypto";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  canonicalJson,
  type PackScoutBuybackEvConfidenceLimitationCodeV1,
  type PackScoutBuybackEvPublicReasonCodeV1,
} from "@packscout/contracts";

/**
 * Launch certification record for the buyback-adjusted PackScout EV cutover
 * (task buyback-adjusted-ev/013).
 *
 * The certification is the final gate over the whole feature: it links the
 * task-012 operational readiness ledger, the eight sanitized provider-to-
 * browser traces, the exact candidate commit and release identity, the
 * verification-gate results, the product-experience evidence manifest, the
 * deploy-stage browser checklist, the rollback proof, and the enumerated
 * human owner approvals.
 *
 * The result is strict pass or blocked. `evaluate` recomputes every automated
 * criterion from raw evidence on every call and represents each human
 * criterion as an explicit approval entry that ships `unrecorded`; nothing in
 * this module can flip a human approval, waive a criterion, or partially
 * pass. Production activation cannot proceed on a blocked certification.
 */

export const PACKSCOUT_BUYBACK_EV_LAUNCH_CERTIFICATION_VERSION =
  "packscout-buyback-ev-launch-certification-v1" as const;

/** The eight launch providers, in canonical certification order. */
export const PACKSCOUT_BUYBACK_EV_LAUNCH_PROVIDERS_V1 = Object.freeze([
  "beezie",
  "clutchpacks",
  "collector_crypt",
  "courtyard",
  "gamestop",
  "phygitals",
  "stadium_vault",
  "trove",
] as const);

export type PackScoutBuybackEvLaunchProviderV1 =
  (typeof PACKSCOUT_BUYBACK_EV_LAUNCH_PROVIDERS_V1)[number];

/**
 * The scenario classes the eight sanitized examples must jointly cover.
 * Every class maps to a resolved decision in the feature index.
 */
export const PACKSCOUT_BUYBACK_EV_LAUNCH_SCENARIO_CLASSES_V1 = Object.freeze([
  "uniform_rate",
  "outcome_specific_rate",
  "ineligibility",
  "fixed_payout",
  "mandatory_adjustment",
  "no_buyback",
  "current_pool",
  "published_fallback",
  "midpoint",
  "unavailable_evidence",
] as const);

export type PackScoutBuybackEvLaunchScenarioClassV1 =
  (typeof PACKSCOUT_BUYBACK_EV_LAUNCH_SCENARIO_CLASSES_V1)[number];

/** Public four-metric snapshot reconciled at every hop of one trace. */
export interface PackScoutBuybackEvTraceMetricsV1 {
  readonly grossEvMinorUnits: number;
  readonly grossReturnBasisPoints: number;
  readonly evDollarsMinorUnits: number;
  readonly evPercentBasisPoints: number;
}

export interface PackScoutBuybackEvTraceConfidenceV1 {
  readonly scoreBasisPoints: number;
  readonly band: "low" | "medium" | "high";
  readonly limitationCodes:
    readonly PackScoutBuybackEvConfidenceLimitationCodeV1[];
}

/** Rendered browser-facing strings from the shared presentation boundary. */
export interface PackScoutBuybackEvTraceRenderedV1 {
  readonly statusLabel: string;
  readonly grossEvDollars: string;
  readonly grossEvPercent: string;
  readonly evDollars: string;
  readonly evPercent: string;
  readonly confidenceDisplay: string;
  readonly reasonCopy: string | null;
  readonly sourceAgeLabel: string | null;
  readonly outboundActionAllowed: boolean;
}

/**
 * One sanitized provider example traced source revision -> normalized
 * evidence -> fingerprint -> canonical metrics -> confidence -> public
 * release -> query projection -> rendered presentation. Every field is a
 * bounded label, an already-public value, or an opaque digest; raw payloads
 * and protected evidence never enter the record.
 */
export interface PackScoutBuybackEvProviderTraceV1 {
  readonly providerKey: PackScoutBuybackEvLaunchProviderV1;
  readonly productKey: string;
  readonly scenario: string;
  readonly scenarioClasses:
    readonly PackScoutBuybackEvLaunchScenarioClassV1[];
  readonly sourceRevisionId: string;
  readonly observedAt: string;
  readonly calculatedAt: string;
  readonly effectiveFingerprint: string;
  readonly revisionId: string;
  readonly status: "current" | "unavailable";
  readonly publicReason: PackScoutBuybackEvPublicReasonCodeV1 | null;
  readonly metrics: PackScoutBuybackEvTraceMetricsV1 | null;
  readonly confidence: PackScoutBuybackEvTraceConfidenceV1 | null;
  readonly rendered: PackScoutBuybackEvTraceRenderedV1;
  readonly hopsReconciled: boolean;
  readonly firstMismatch: string | null;
}

/** Bounded link to the task-012 operational readiness ledger. */
export interface PackScoutBuybackEvOperationalLedgerLinkV1 {
  readonly ledgerDigest: string;
  readonly readiness: "pass" | "blocked";
  readonly generatedAt: string;
  readonly rollbackDrillExecuted: boolean;
  readonly artifactPath: string;
}

export interface PackScoutBuybackEvCertificationCommandV1 {
  readonly command: string;
  readonly exitCode: number;
  readonly completedAt: string;
}

export interface PackScoutBuybackEvCertificationReleaseIdentityV1 {
  readonly publicReleaseId: string;
  readonly releaseFingerprint: string;
  readonly dataAsOf: string;
  readonly configurationFingerprintSha256: string;
}

export type PackScoutBuybackEvBrowserEvidenceStatusV1 =
  | "pending_deploy"
  | "pass"
  | "fail";

/**
 * One deploy-stage browser checklist item. Items ship `pending_deploy` and
 * may only be closed by a recorded live-deploy pass; this module never
 * fabricates a pass.
 */
export interface PackScoutBuybackEvBrowserEvidenceItemV1 {
  readonly id: string;
  readonly sourceTask: "010" | "011" | "013";
  readonly description: string;
  readonly status: PackScoutBuybackEvBrowserEvidenceStatusV1;
  readonly recordedBy: string | null;
  readonly recordedAt: string | null;
}

export const PACKSCOUT_BUYBACK_EV_HUMAN_APPROVALS_V1 = Object.freeze([
  "product_approval",
  "engineering_approval",
  "gamestop_trove_buyback_terms_confirmed",
  "ncpg_contact_review",
] as const);

export type PackScoutBuybackEvHumanApprovalKeyV1 =
  (typeof PACKSCOUT_BUYBACK_EV_HUMAN_APPROVALS_V1)[number];

export const PACKSCOUT_BUYBACK_EV_HUMAN_APPROVAL_SCOPE_V1: Readonly<
  Record<PackScoutBuybackEvHumanApprovalKeyV1, string>
> = Object.freeze({
  product_approval:
    "Product approves terminology, worked examples, methodology explanation, " +
    "and responsible-play content on the recorded candidate.",
  engineering_approval:
    "Engineering approves provenance, privacy, performance, observability, " +
    "activation, and rollback evidence on the recorded candidate.",
  gamestop_trove_buyback_terms_confirmed:
    "The real GameStop fixed-offer and Trove final-payout buyback terms are " +
    "confirmed against product truth (task 004 spec-compliance divergence: " +
    "both capabilities were modeled from the feature's evidence vocabulary, " +
    "not vendor documents).",
  ncpg_contact_review:
    "A content owner reviews the responsible-play helpline contact " +
    "(1-800-MY-RESET / 1800myreset.org, verified 2026-08-19 against official " +
    "NCPG pages) recorded at task 011.",
});

/**
 * A human owner approval. Ships `unrecorded`; only a human decision recorded
 * with an approver identity and timestamp can move it to `approved`. There is
 * no automated path to `approved` anywhere in this module.
 */
export interface PackScoutBuybackEvHumanApprovalV1 {
  readonly key: PackScoutBuybackEvHumanApprovalKeyV1;
  readonly scope: string;
  readonly status: "unrecorded" | "approved" | "rejected";
  readonly approver: string | null;
  readonly recordedAt: string | null;
  readonly note: string | null;
}

export function packScoutBuybackEvUnrecordedHumanApprovalsV1():
  readonly PackScoutBuybackEvHumanApprovalV1[] {
  return PACKSCOUT_BUYBACK_EV_HUMAN_APPROVALS_V1.map((key) => ({
    key,
    scope: PACKSCOUT_BUYBACK_EV_HUMAN_APPROVAL_SCOPE_V1[key],
    status: "unrecorded" as const,
    approver: null,
    recordedAt: null,
    note: null,
  }));
}

/** One product-experience claim mapped to the tests that carry its proof. */
export interface PackScoutBuybackEvCertificationManifestEntryV1 {
  readonly claim: string;
  readonly evidence: readonly {
    readonly file: string;
    readonly testName: string;
  }[];
}

export interface PackScoutBuybackEvManifestVerificationV1 {
  readonly verifiedAt: string;
  readonly entriesVerified: number;
  readonly missing: readonly string[];
}

export const PACKSCOUT_BUYBACK_EV_CERTIFICATION_CRITERIA_V1 = Object.freeze([
  "operational_readiness_linked",
  "provider_traces_reconciled",
  "vendor_ev_separation_proven",
  "pulls_verified_inventory_only",
  "public_boundary_sanitized",
  "product_experience_manifest_verified",
  "verification_gate_passed",
  "release_identity_recorded",
  "rollback_proof_recorded",
  "browser_evidence_closed",
  "product_approval_recorded",
  "engineering_approval_recorded",
  "gamestop_trove_terms_confirmed",
  "ncpg_contact_review_recorded",
] as const);

export type PackScoutBuybackEvCertificationCriterionV1 =
  (typeof PACKSCOUT_BUYBACK_EV_CERTIFICATION_CRITERIA_V1)[number];

export interface PackScoutBuybackEvCertificationCriterionResultV1 {
  readonly criterion: PackScoutBuybackEvCertificationCriterionV1;
  readonly kind: "automated" | "human";
  readonly status: "pass" | "blocked";
  readonly evidence: string;
}

/** Raw evidence the certification is composed and evaluated from. */
export interface PackScoutBuybackEvLaunchCertificationEvidenceV1 {
  readonly generatedAt: string;
  readonly candidateCommit: string;
  readonly operationalLedger: PackScoutBuybackEvOperationalLedgerLinkV1 | null;
  readonly providerTraces: readonly PackScoutBuybackEvProviderTraceV1[];
  readonly vendorEvSeparationProven: boolean;
  readonly pullsVerifiedInventoryOnly: boolean;
  readonly publicBoundaryScan: Readonly<{
    scannedReleases: number;
    forbiddenTokensChecked: number;
    hits: readonly string[];
  }> | null;
  readonly manifestVerification: PackScoutBuybackEvManifestVerificationV1 | null;
  readonly verificationCommands:
    readonly PackScoutBuybackEvCertificationCommandV1[];
  readonly candidateRelease:
    PackScoutBuybackEvCertificationReleaseIdentityV1 | null;
  readonly browserEvidence:
    readonly PackScoutBuybackEvBrowserEvidenceItemV1[];
  readonly humanApprovals: readonly PackScoutBuybackEvHumanApprovalV1[];
}

export interface PackScoutBuybackEvLaunchCertificationV1 {
  readonly schemaVersion:
    typeof PACKSCOUT_BUYBACK_EV_LAUNCH_CERTIFICATION_VERSION;
  readonly generatedAt: string;
  readonly certification: "pass" | "blocked";
  readonly criteria:
    readonly PackScoutBuybackEvCertificationCriterionResultV1[];
  readonly candidateCommit: string;
  readonly methodVersion: typeof PACKSCOUT_BUYBACK_EV_METHOD_VERSION;
  readonly confidencePolicyVersion:
    typeof PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION;
  readonly operationalLedger: PackScoutBuybackEvOperationalLedgerLinkV1 | null;
  readonly providerTraces: readonly PackScoutBuybackEvProviderTraceV1[];
  readonly publicBoundaryScan:
    PackScoutBuybackEvLaunchCertificationEvidenceV1["publicBoundaryScan"];
  readonly manifestVerification:
    PackScoutBuybackEvManifestVerificationV1 | null;
  readonly verificationCommands:
    readonly PackScoutBuybackEvCertificationCommandV1[];
  readonly candidateRelease:
    PackScoutBuybackEvCertificationReleaseIdentityV1 | null;
  readonly browserEvidence:
    readonly PackScoutBuybackEvBrowserEvidenceItemV1[];
  readonly humanApprovals: readonly PackScoutBuybackEvHumanApprovalV1[];
  /** sha-256 over the canonical certification body (excluding this digest). */
  readonly certificationDigest: string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const COMMIT_PATTERN = /^[0-9a-f]{7,64}$/u;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function result(
  criterion: PackScoutBuybackEvCertificationCriterionV1,
  pass: boolean,
  evidence: string,
  kind: "automated" | "human" = "automated",
): PackScoutBuybackEvCertificationCriterionResultV1 {
  return { criterion, kind, status: pass ? "pass" : "blocked", evidence };
}

function humanCriterion(
  criterion: PackScoutBuybackEvCertificationCriterionV1,
  approvals: readonly PackScoutBuybackEvHumanApprovalV1[],
  key: PackScoutBuybackEvHumanApprovalKeyV1,
): PackScoutBuybackEvCertificationCriterionResultV1 {
  const approval = approvals.find((entry) => entry.key === key);
  const recorded =
    approval !== undefined &&
    approval.status === "approved" &&
    approval.approver !== null &&
    approval.approver.trim().length > 0 &&
    approval.recordedAt !== null &&
    TIMESTAMP_PATTERN.test(approval.recordedAt);
  return result(
    criterion,
    recorded,
    approval === undefined
      ? `No ${key} entry is present; the approval is unrecorded.`
      : approval.status === "approved" && recorded
        ? `${key} approved by ${approval.approver} at ${approval.recordedAt}.`
        : `${key} is ${approval.status}; only a recorded human approval can ` +
          "close this criterion.",
    "human",
  );
}

function tracesCriterion(
  traces: readonly PackScoutBuybackEvProviderTraceV1[],
): PackScoutBuybackEvCertificationCriterionResultV1 {
  const providers = new Set(traces.map(({ providerKey }) => providerKey));
  const allProviders = PACKSCOUT_BUYBACK_EV_LAUNCH_PROVIDERS_V1.every(
    (provider) => providers.has(provider),
  );
  const classes = new Set(
    traces.flatMap(({ scenarioClasses }) => scenarioClasses),
  );
  const allClasses = PACKSCOUT_BUYBACK_EV_LAUNCH_SCENARIO_CLASSES_V1.every(
    (scenarioClass) => classes.has(scenarioClass),
  );
  const mismatches = traces.filter(
    (trace) => !trace.hopsReconciled || trace.firstMismatch !== null,
  );
  return result(
    "provider_traces_reconciled",
    traces.length === PACKSCOUT_BUYBACK_EV_LAUNCH_PROVIDERS_V1.length &&
      providers.size === traces.length &&
      allProviders &&
      allClasses &&
      mismatches.length === 0,
    `${traces.length}/${PACKSCOUT_BUYBACK_EV_LAUNCH_PROVIDERS_V1.length} ` +
      `provider traces; ${classes.size}/` +
      `${PACKSCOUT_BUYBACK_EV_LAUNCH_SCENARIO_CLASSES_V1.length} scenario ` +
      `classes covered; ${mismatches.length} unreconciled ` +
      `(first: ${mismatches[0]?.firstMismatch ?? "none"}).`,
  );
}

/**
 * Recomputes every certification criterion from raw evidence. Certification
 * is pass exactly when every automated criterion passes AND every human
 * criterion carries a recorded approval; there is no waiver or override.
 */
export function evaluatePackScoutBuybackEvLaunchCertificationV1(
  evidence: PackScoutBuybackEvLaunchCertificationEvidenceV1,
): Readonly<{
  certification: "pass" | "blocked";
  criteria: readonly PackScoutBuybackEvCertificationCriterionResultV1[];
}> {
  const criteria: PackScoutBuybackEvCertificationCriterionResultV1[] = [];

  const ledger = evidence.operationalLedger;
  criteria.push(
    result(
      "operational_readiness_linked",
      ledger !== null &&
        ledger.readiness === "pass" &&
        SHA256_HEX.test(ledger.ledgerDigest),
      ledger === null
        ? "No task-012 operational readiness ledger is linked."
        : `Ledger ${ledger.ledgerDigest.slice(0, 12)} readiness=` +
          `${ledger.readiness} generated ${ledger.generatedAt}.`,
    ),
  );

  criteria.push(tracesCriterion(evidence.providerTraces));

  criteria.push(
    result(
      "vendor_ev_separation_proven",
      evidence.vendorEvSeparationProven,
      evidence.vendorEvSeparationProven
        ? "Vendor-reported EV stayed structurally separate from PackScout EV " +
          "across release and presentation."
        : "Vendor-EV separation is not proven.",
    ),
  );

  criteria.push(
    result(
      "pulls_verified_inventory_only",
      evidence.pullsVerifiedInventoryOnly,
      evidence.pullsVerifiedInventoryOnly
        ? "Proven pulls changed EV exactly through verified remaining " +
          "inventory; unproven pulls changed nothing."
        : "The pulls-through-verified-inventory proof is not recorded.",
    ),
  );

  const scan = evidence.publicBoundaryScan;
  criteria.push(
    result(
      "public_boundary_sanitized",
      scan !== null &&
        scan.scannedReleases > 0 &&
        scan.forbiddenTokensChecked > 0 &&
        scan.hits.length === 0,
      scan === null
        ? "No public-boundary scan is recorded."
        : `${scan.scannedReleases} release(s) scanned against ` +
          `${scan.forbiddenTokensChecked} forbidden tokens; ` +
          `${scan.hits.length} hits.`,
    ),
  );

  const manifest = evidence.manifestVerification;
  criteria.push(
    result(
      "product_experience_manifest_verified",
      manifest !== null &&
        manifest.entriesVerified > 0 &&
        manifest.missing.length === 0,
      manifest === null
        ? "The product-experience manifest has not been verified."
        : `${manifest.entriesVerified} manifest claims verified; ` +
          `${manifest.missing.length} missing ` +
          `(first: ${manifest.missing[0] ?? "none"}).`,
    ),
  );

  const commands = evidence.verificationCommands;
  const commandsPass =
    commands.length > 0 &&
    commands.every(({ exitCode }) => exitCode === 0) &&
    commands.some(({ command }) => command.includes("verify:framework")) &&
    COMMIT_PATTERN.test(evidence.candidateCommit);
  criteria.push(
    result(
      "verification_gate_passed",
      commandsPass,
      `${commands.length} commands recorded, ` +
        `${commands.filter(({ exitCode }) => exitCode === 0).length} passed, ` +
        `verify:framework ${
          commands.some(({ command }) => command.includes("verify:framework"))
            ? "recorded"
            : "missing"
        }, commit ${evidence.candidateCommit.slice(0, 12) || "missing"}.`,
    ),
  );

  const release = evidence.candidateRelease;
  criteria.push(
    result(
      "release_identity_recorded",
      release !== null &&
        SHA256_HEX.test(release.releaseFingerprint) &&
        SHA256_HEX.test(release.configurationFingerprintSha256) &&
        TIMESTAMP_PATTERN.test(release.dataAsOf),
      release === null
        ? "No candidate public release identity is recorded."
        : `Release ${release.publicReleaseId} fingerprint ` +
          `${release.releaseFingerprint.slice(0, 12)} dataAsOf ` +
          `${release.dataAsOf}.`,
    ),
  );

  criteria.push(
    result(
      "rollback_proof_recorded",
      ledger !== null && ledger.rollbackDrillExecuted,
      ledger !== null && ledger.rollbackDrillExecuted
        ? "The task-012 maintenance-gated rollback drill is linked."
        : "No rollback drill proof is linked.",
    ),
  );

  const browser = evidence.browserEvidence;
  const browserClosed =
    browser.length > 0 &&
    browser.every(
      (item) =>
        item.status === "pass" &&
        item.recordedBy !== null &&
        item.recordedAt !== null,
    );
  const pending = browser.filter(
    ({ status }) => status !== "pass",
  ).length;
  criteria.push(
    result(
      "browser_evidence_closed",
      browserClosed,
      `${browser.length} browser checklist items; ${pending} not closed by ` +
        "a recorded live-deploy pass.",
    ),
  );

  criteria.push(
    humanCriterion(
      "product_approval_recorded",
      evidence.humanApprovals,
      "product_approval",
    ),
  );
  criteria.push(
    humanCriterion(
      "engineering_approval_recorded",
      evidence.humanApprovals,
      "engineering_approval",
    ),
  );
  criteria.push(
    humanCriterion(
      "gamestop_trove_terms_confirmed",
      evidence.humanApprovals,
      "gamestop_trove_buyback_terms_confirmed",
    ),
  );
  criteria.push(
    humanCriterion(
      "ncpg_contact_review_recorded",
      evidence.humanApprovals,
      "ncpg_contact_review",
    ),
  );

  const certification = criteria.every(({ status }) => status === "pass")
    ? "pass"
    : "blocked";
  return { certification, criteria };
}

/** Composes the complete typed certification with evaluation and digest. */
export function composePackScoutBuybackEvLaunchCertificationV1(
  evidence: PackScoutBuybackEvLaunchCertificationEvidenceV1,
): PackScoutBuybackEvLaunchCertificationV1 {
  const evaluation = evaluatePackScoutBuybackEvLaunchCertificationV1(evidence);
  const body = {
    schemaVersion: PACKSCOUT_BUYBACK_EV_LAUNCH_CERTIFICATION_VERSION,
    generatedAt: evidence.generatedAt,
    certification: evaluation.certification,
    criteria: evaluation.criteria,
    candidateCommit: evidence.candidateCommit,
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    operationalLedger: evidence.operationalLedger,
    providerTraces: evidence.providerTraces,
    publicBoundaryScan: evidence.publicBoundaryScan,
    manifestVerification: evidence.manifestVerification,
    verificationCommands: evidence.verificationCommands,
    candidateRelease: evidence.candidateRelease,
    browserEvidence: evidence.browserEvidence,
    humanApprovals: evidence.humanApprovals,
  } as const;
  const certificationDigest = createHash("sha256")
    .update(canonicalJson(body))
    .digest("hex");
  return { ...body, certificationDigest };
}

/** Deterministic artifact bytes for the generated certification file. */
export function serializePackScoutBuybackEvLaunchCertificationV1(
  certification: PackScoutBuybackEvLaunchCertificationV1,
): string {
  return `${JSON.stringify(certification, null, 2)}\n`;
}

/**
 * Deploy-stage browser checklist. Items originate from the recorded task-010
 * and task-011 spec-compliance checklists plus this task's certification
 * requirements; each ships `pending_deploy` and is closed only by the
 * orchestrator's live-deploy pass.
 */
export const PACKSCOUT_BUYBACK_EV_BROWSER_EVIDENCE_PENDING_V1: readonly PackScoutBuybackEvBrowserEvidenceItemV1[] =
  Object.freeze(
    (
      [
        {
          id: "themes-contrast",
          sourceTask: "010",
          description:
            "Both themes: metric chip and value contrast on Dashboard, All " +
            "Repacks, and the inspector.",
        },
        {
          id: "small-viewport-zoom-scroll",
          sourceTask: "010",
          description:
            "390x844 and 200% zoom: tables scroll inside their own " +
            "containers with no page-level horizontal scroll.",
        },
        {
          id: "inspector-focus-keyboard",
          sourceTask: "010",
          description:
            "Sheet inspector focus trap and focus return plus a complete " +
            "keyboard-only walk of the catalog surfaces.",
        },
        {
          id: "live-deadline-flip",
          sourceTask: "010",
          description:
            "A current estimate flips to the expired state in an open tab " +
            "at its deadline without reload or aria-live chatter.",
        },
        {
          id: "glossary-hint-positioning",
          sourceTask: "010",
          description:
            "GlossaryHint positioning inside narrow and zoomed viewports.",
        },
        {
          id: "reduced-motion",
          sourceTask: "010",
          description: "Reduced-motion pass across the catalog surfaces.",
        },
        {
          id: "learn-routes-live",
          sourceTask: "011",
          description:
            "All four Learn routes render at desktop and 375px on the " +
            "deployed candidate with the responsible-play block visible.",
        },
        {
          id: "hydration-console-state",
          sourceTask: "013",
          description:
            "Hydration completes without mismatches and the console is free " +
            "of errors on Dashboard, All Repacks, and Learn.",
        },
        {
          id: "anonymous-degraded-browsing",
          sourceTask: "013",
          description:
            "Anonymous public browsing stays available while EV, " +
            "authentication, or simulation is unavailable outside the " +
            "bounded maintenance cutover.",
        },
      ] as const
    ).map((item) => ({
      ...item,
      status: "pending_deploy" as const,
      recordedBy: null,
      recordedAt: null,
    })),
  );

/**
 * Product-experience certification manifest: each launch claim names the
 * existing test files and test names that carry its proof. The certification
 * unit test verifies every referenced file exists and still contains every
 * named test, so the manifest cannot silently rot.
 */
export const PACKSCOUT_BUYBACK_EV_CERTIFICATION_MANIFEST_V1: readonly PackScoutBuybackEvCertificationManifestEntryV1[] =
  Object.freeze([
    {
      claim:
        "Positive, neutral, negative, zero, unavailable, delayed, expired, " +
        "simulated, and sold-out states present through the shared boundary.",
      evidence: [
        {
          file: "apps/frontend/lib/packscout-ev-presentation.test.ts",
          testName:
            "positive estimates carry explicit plus signs on both signed metrics",
        },
        {
          file: "apps/frontend/lib/packscout-ev-presentation.test.ts",
          testName:
            "break-even estimates present a neutral state without invented signs",
        },
        {
          file: "apps/frontend/lib/packscout-ev-presentation.test.ts",
          testName:
            "a valid zero payout renders $0.00 with an explicit zero-payout note",
        },
        {
          file: "apps/frontend/lib/packscout-ev-presentation.test.ts",
          testName:
            "unavailable estimates never render zero, metrics, or a vendor fallback",
        },
        {
          file: "apps/frontend/lib/packscout-ev-presentation.test.ts",
          testName:
            "delayed source age is a limitation with copy, never a hidden state",
        },
        {
          file: "apps/frontend/lib/packscout-ev-presentation.test.ts",
          testName:
            "expired estimates present the distinct expired state with stale copy",
        },
        {
          file: "apps/frontend/lib/packscout-ev-presentation.test.ts",
          testName:
            "simulated listings surface simulated provenance on the estimate",
        },
        {
          file: "apps/frontend/lib/packscout-ev-presentation.test.ts",
          testName:
            "sold-out historical estimates keep values, timestamps, and no outbound action",
        },
        {
          file: "apps/frontend/components/metrics/PackScoutEvMetrics.test.tsx",
          testName:
            "renders the four metrics, price, status, source, and advice lines",
        },
      ],
    },
    {
      claim:
        "Every approved public state flows through the unmodified production " +
        "path under simulation and parses the production contracts.",
      evidence: [
        {
          file: "packages/services/src/buyback-adjusted-ev-simulation.test.ts",
          testName:
            "every approved public state appears and passes the production contracts",
        },
        {
          file: "packages/services/src/buyback-adjusted-ev-simulation.test.ts",
          testName:
            "published values equal an independent recomputation through the real calculator and confidence policy",
        },
        {
          file: "packages/services/src/buyback-adjusted-ev-simulation.test.ts",
          testName:
            "the $100 outcome EV / 85% uniform buyback / $100 price example flows through the full production path",
        },
      ],
    },
    {
      claim:
        "Rankings use signed EV dollars, exclude ineligible repacks, break " +
        "ties deterministically, and keep sold-out history unranked.",
      evidence: [
        {
          file: "convex/publicRepacksV3.test.ts",
          testName:
            "dashboard ranks by signed EV dollars, excludes ineligible repacks, and aggregates with the same rules",
        },
        {
          file: "convex/publicRepacksV3.test.ts",
          testName: "EV-dollar ties rank deterministically by public id",
        },
        {
          file: "convex/publicRepacksV3.test.ts",
          testName:
            "the list keeps sold-out history visible without ranking or action and keeps unavailable reasons public",
        },
      ],
    },
    {
      claim:
        "KPIs, medians, and opportunity rows are server-materialized and " +
        "never recomputed or re-sorted in the browser.",
      evidence: [
        {
          file: "apps/frontend/components/catalog/overview-presentation.test.ts",
          testName:
            "always presents four overview KPIs with buyback-adjusted meaning",
        },
        {
          file: "apps/frontend/components/catalog/overview-presentation.test.ts",
          testName:
            "presents server-ranked opportunities without re-sorting or recomputing",
        },
        {
          file: "apps/frontend/packscout-ev-no-recalculation.source.test.ts",
          testName:
            "only the presentation boundary consumes raw public EV numerics",
        },
      ],
    },
    {
      claim:
        "Sorts, filters, pagination, and desired-collectible selection are " +
        "canonical, bounded, and never reinterpret retired pre-buyback sorts.",
      evidence: [
        {
          file: "apps/frontend/lib/catalog-query-state.client.test.ts",
          testName:
            "saved links using the retired pre-buyback vendor sort reset instead of reinterpreting",
        },
        {
          file: "apps/frontend/lib/catalog-query-state.client.test.ts",
          testName:
            "cursor navigation keeps a bounded stack of prior non-initial page starts",
        },
        {
          file: "apps/frontend/lib/catalog-query-state.client.test.ts",
          testName:
            "exact desired chase selection uses a stable collectible ID and resets pagination",
        },
        {
          file: "apps/frontend/lib/all-repacks-table.test.ts",
          testName:
            "sort headers toggle deterministically and disappear during relevance order",
        },
        {
          file: "convex/publicRepacksV3.test.ts",
          testName:
            "pagination is bounded, fingerprinted, and survives release changes explicitly",
        },
        {
          file: "convex/publicRepacksV3.test.ts",
          testName:
            "desired-collectible matching binds rows to chases and search stays bounded",
        },
      ],
    },
    {
      claim:
        "Saves require authentication, fail closed without it, and expose " +
        "bounded state transitions.",
      evidence: [
        {
          file: "apps/frontend/components/auth/saved-item-presentation.test.ts",
          testName:
            "a guest save action opens authentication without claiming a save",
        },
        {
          file: "apps/frontend/components/auth/saved-item-presentation.test.ts",
          testName: "unconfigured and unverifiable sessions fail closed",
        },
      ],
    },
    {
      claim:
        "Heat presents an explicit unavailable state on v3 views and stays " +
        "distinct from EV.",
      evidence: [
        {
          file: "apps/frontend/heat-visibility.source.test.ts",
          testName:
            "keeps dormant Heat components disconnected from public catalog surfaces",
        },
        {
          file: "apps/frontend/lib/repack-heat-presentation.test.ts",
          testName:
            "keeps expired and unpublished heat unavailable rather than normal or cold",
        },
        {
          file: "scripts/local/simulate-convex-buyback-ev.test.mjs",
          testName:
            "read-back verification pins bytes, identity, and the unavailable heat state",
        },
      ],
    },
    {
      claim:
        "Selected details stay byte-equivalent to their list projections and " +
        "the inspector presents evidence coverage plainly.",
      evidence: [
        {
          file: "apps/frontend/lib/public-repacks-v3.test.ts",
          testName:
            "fails closed on malformed, mixed, or arithmetically inconsistent data",
        },
        {
          file: "apps/frontend/components/catalog/pack-inspector-presentation.test.ts",
          testName:
            "states complete, partial, unquantified, and unknown evidence coverage plainly",
        },
        {
          file: "apps/frontend/components/catalog/catalog-surfaces-ev.test.tsx",
          testName:
            "the inspector names the release data-as-of time and keeps focusable close affordances",
        },
      ],
    },
    {
      claim:
        "Outbound actions are blocked for sold-out, unavailable, and " +
        "unapproved targets and referral parameters apply exactly once.",
      evidence: [
        {
          file: "apps/frontend/components/catalog/pack-actions.client.test.ts",
          testName:
            "blocks missing, sold-out, unapproved, and malformed outbound actions",
        },
        {
          file: "apps/frontend/components/catalog/pack-actions.client.test.ts",
          testName:
            "builds the approved outbound URL with each referral parameter exactly once",
        },
        {
          file: "apps/frontend/lib/all-repacks-table.test.ts",
          testName: "sold-out rows never expose an outbound repack action",
        },
      ],
    },
    {
      claim:
        "Glossary, Learn, source disclosures, confidence explanations, " +
        "reasons, and disclaimers teach the buyback-adjusted method.",
      evidence: [
        {
          file: "apps/frontend/lib/metric-vocabulary.test.ts",
          testName:
            "gross EV is defined as the expected guaranteed buyback payout",
        },
        {
          file: "apps/frontend/lib/metric-vocabulary.test.ts",
          testName:
            "maps the bounded v3 reason vocabulary to stable public copy",
        },
        {
          file: "apps/frontend/lib/metric-vocabulary.test.ts",
          testName:
            "keeps the required source, advice, and bounded-summary language canonical",
        },
        {
          file: "apps/frontend/lib/learn-content.test.ts",
          testName:
            "Learn teaches every EV term from the one canonical glossary registry",
        },
        {
          file: "apps/frontend/lib/learn-content.test.ts",
          testName:
            "the EV article teaches the buyback formula through shared values",
        },
        {
          file: "apps/frontend/lib/confidence-limitations.test.ts",
          testName:
            "maps the exact confidence-policy V1 limitation vocabulary to copy",
        },
        {
          file: "apps/frontend/lib/packscout-ev-examples.test.ts",
          testName:
            "exposes exactly the six approved worked examples in teaching order",
        },
        {
          file: "apps/frontend/lib/packscout-ev-examples.test.ts",
          testName:
            "every example's metric rows come verbatim from the shared presentation",
        },
      ],
    },
    {
      claim:
        "The current responsible-play contact is pinned as a release check.",
      evidence: [
        {
          file: "apps/frontend/lib/responsible-play.test.ts",
          testName:
            "pins the verified official NCPG helpline contact (release check)",
        },
        {
          file: "apps/frontend/components/learn/learn-surfaces.test.tsx",
          testName:
            "the responsible-play notice renders the verified helpline contact",
        },
      ],
    },
    {
      claim:
        "Deadline expiry converts client-side exactly like the server and " +
        "never invents a live state.",
      evidence: [
        {
          file: "apps/frontend/lib/packscout-ev-deadline.client.test.ts",
          testName:
            "strictly after the deadline the estimate converts to the stale state",
        },
        {
          file: "apps/frontend/lib/packscout-ev-deadline.client.test.ts",
          testName:
            "historical and unavailable estimates never expire into a live state",
        },
        {
          file: "convex/publicRepacksV3.test.ts",
          testName:
            "a current estimate past its deadline fails closed at read time without any new transition",
        },
      ],
    },
    {
      claim:
        "Anonymous public browsing survives unavailable EV, releases, and " +
        "reads outside the bounded maintenance cutover.",
      evidence: [
        {
          file: "apps/frontend/lib/public-repacks-v3.test.ts",
          testName: "passes through bounded public read errors untouched",
        },
        {
          file: "apps/frontend/lib/public-repacks-v3.test.ts",
          testName:
            "distinguishes an empty catalog from a filtered-down zero result",
        },
        {
          file: "apps/frontend/lib/data-release-status.client.test.ts",
          testName:
            "data release status exposes stable fresh, delayed, loading, and unavailable copy",
        },
        {
          file: "convex/publicRepacksV3.test.ts",
          testName:
            "an incomplete or internally inconsistent active release fails reads safely",
        },
        {
          file: "packages/services/src/buyback-adjusted-ev-cutover-runbook.test.ts",
          testName:
            "cuts over in the approved order and reopens only after read-back passes",
        },
      ],
    },
    {
      claim:
        "Sold-out, recovery, expiry, interruption, and rollback behavior is " +
        "proven through the same contracts operationally.",
      evidence: [
        {
          file:
            "packages/services/src/buyback-adjusted-ev-failure-drills.integration.test.ts",
          testName:
            "failure, expiry, interruption, malformed-projection, and replay drills fail closed and preserve coherent releases",
        },
        {
          file: "packages/services/src/buyback-adjusted-ev-cutover-runbook.test.ts",
          testName:
            "one maintenance-gated rollback drill restores the prior code and pointer and records into the readiness ledger",
        },
      ],
    },
  ]);
