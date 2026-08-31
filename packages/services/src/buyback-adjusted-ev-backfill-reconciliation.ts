import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V3,
  packScoutPublicEvMetricsAreNonpositiveV3,
  parsePackScoutBuybackEvTimestampMillisV1,
  sha256CanonicalJson,
  type PackScoutBuybackEvPublicReasonCodeV1,
  type PublicRepackDetailV3,
} from "@packscout/contracts";
import type {
  PackScoutBuybackEvPublicationEligibilityV1,
  PackScoutBuybackEvRecomputationCommandV1,
  PackScoutBuybackEvRecomputationResultV1,
} from "./buyback-adjusted-ev-recomputation-contracts.ts";
import type { DataReleaseV3ReleaseAssembler } from "./buyback-adjusted-ev-release-assembler.ts";
import {
  DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
  DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN,
  type DataReleaseV3CanonicalCatalogPort,
  type DataReleaseV3CanonicalProduct,
  type DataReleaseV3PublicationPort,
  type DataReleaseV3PublishPlan,
  type DataReleaseV3Receipt,
} from "./buyback-adjusted-ev-release-types.ts";

/**
 * Backfill reconciliation for the buyback-adjusted EV cutover
 * (task buyback-adjusted-ev/012).
 *
 * One run enumerates every repack in the canonical store at one release read
 * clock, drives each supplied unit of provider-normalized evidence through
 * the real task-006 recomputation boundary, classifies every repack as
 * recomputed-available, deterministically unavailable with its bounded public
 * reason, or sold-out-historical, and reconciles that ledger against a staged
 * — never activated — data_release_v3 publish plan. Two independent
 * derivations must agree: the classification predicted from the
 * publication-eligibility read, and the public EV state the assembler
 * actually emitted. Any disagreement, mixed version, rejected work, staging
 * divergence, or pointer movement blocks the run instead of degrading it.
 */

export const PACKSCOUT_BUYBACK_EV_BACKFILL_VERSION =
  "packscout-buyback-ev-backfill-reconciliation-v1" as const;

export type PackScoutBuybackEvBackfillClassificationV1 =
  | "recomputed_available"
  | "deterministic_unavailable"
  | "sold_out_historical";

export type PackScoutBuybackEvBackfillRecomputationOutcomeV1 =
  | PackScoutBuybackEvRecomputationResultV1["outcome"]
  | "skipped_no_evidence";

export type PackScoutBuybackEvSourceAgeBucketV1 =
  | "fresh_within_15_minutes"
  | "delayed_over_15_through_30_minutes"
  | "delayed_over_30_through_60_minutes"
  | "stale_or_expired"
  | "unknown_source_time";

export interface PackScoutBuybackEvBackfillRowV1 {
  readonly platformKey: string;
  readonly productKey: string;
  readonly publicRepackId: string;
  readonly availability: DataReleaseV3CanonicalProduct["availability"];
  readonly classification: PackScoutBuybackEvBackfillClassificationV1;
  readonly publicReason: PackScoutBuybackEvPublicReasonCodeV1 | null;
  readonly recomputationOutcome: PackScoutBuybackEvBackfillRecomputationOutcomeV1;
  readonly revisionId: string | null;
  readonly revisionNumber: number | null;
  readonly methodVersion: string;
  readonly confidencePolicyVersion: string;
  readonly confidenceBand: "low" | "medium" | "high" | null;
  readonly sourceAgeBucket: PackScoutBuybackEvSourceAgeBucketV1;
  readonly calculatedAt: string | null;
}

export interface PackScoutBuybackEvBackfillCountsV1 {
  readonly total: number;
  readonly recomputedAvailable: number;
  readonly deterministicUnavailable: number;
  readonly soldOutHistorical: number;
  readonly byPublicReason: Readonly<Record<string, number>>;
  readonly byConfidenceBand: Readonly<Record<"low" | "medium" | "high", number>>;
  readonly bySourceAge: Readonly<
    Record<PackScoutBuybackEvSourceAgeBucketV1, number>
  >;
}

export interface PackScoutBuybackEvBackfillRecomputationTallyV1 {
  readonly created: number;
  readonly unchanged: number;
  readonly superseded: number;
  readonly rejected: number;
  readonly unbindable: number;
  readonly skippedNoEvidence: number;
}

export interface PackScoutBuybackEvBackfillStagingV1 {
  readonly staged: boolean;
  readonly publicReleaseId: string;
  readonly releaseFingerprint: string;
  readonly lifecycle: "complete" | "not_staged";
  readonly priorActivePublicReleaseId: string | null;
  readonly activePointerMoved: boolean;
}

export interface PackScoutBuybackEvBackfillLedgerV1 {
  readonly schemaVersion: typeof PACKSCOUT_BUYBACK_EV_BACKFILL_VERSION;
  readonly organizationId: string;
  readonly readAt: string;
  readonly classification: "ready" | "blocked";
  readonly methodVersions: readonly string[];
  readonly confidencePolicyVersions: readonly string[];
  readonly counts: PackScoutBuybackEvBackfillCountsV1;
  readonly recomputation: PackScoutBuybackEvBackfillRecomputationTallyV1;
  readonly staging: PackScoutBuybackEvBackfillStagingV1 | null;
  readonly rows: readonly PackScoutBuybackEvBackfillRowV1[];
  readonly blockedReasons: readonly PackScoutBuybackEvBackfillBlockV1[];
}

export interface PackScoutBuybackEvBackfillBlockV1 {
  readonly code:
    | "PLAN_BLOCKED"
    | "EVIDENCE_SCOPE_VIOLATION"
    | "RECOMPUTATION_REJECTED"
    | "RECOMPUTATION_UNBINDABLE"
    | "REPACK_SET_MISMATCH"
    | "STATE_MISMATCH"
    | "VERSION_MIXED"
    | "STAGING_DIVERGENT"
    | "ACTIVE_POINTER_MOVED"
    | "READ_CLOCK_INVALID";
  readonly productKey: string | null;
  readonly detail: string;
}

/**
 * Supplies the provider-normalized task-004 evidence command for one repack,
 * or null when no evidence exists for it. Implementations must scope every
 * command to the run's organization; the runner fails closed otherwise.
 */
export interface PackScoutBuybackEvBackfillEvidenceSourceV1 {
  loadCommand(input: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly productKey: string;
    readonly readAt: string;
  }): Promise<PackScoutBuybackEvRecomputationCommandV1 | null>;
}

/** The exact recomputation surface the backfill drives. */
export interface PackScoutBuybackEvBackfillRecomputationPortV1 {
  recompute(
    command: PackScoutBuybackEvRecomputationCommandV1,
  ): Promise<PackScoutBuybackEvRecomputationResultV1>;
  getPublicationEligibleRevision(query: {
    readonly organizationId: string;
    readonly platformKey: string;
    readonly productKey: string;
    readonly readAt: string;
  }): Promise<PackScoutBuybackEvPublicationEligibilityV1 | null>;
}

export interface PackScoutBuybackEvBackfillDependenciesV1 {
  readonly catalog: DataReleaseV3CanonicalCatalogPort;
  readonly recomputation: PackScoutBuybackEvBackfillRecomputationPortV1;
  readonly assembler: DataReleaseV3ReleaseAssembler;
  /** Optional evidence source; without one the run classifies current state. */
  readonly evidence?: PackScoutBuybackEvBackfillEvidenceSourceV1;
  /** Optional staging port; the runner stages and reconciles, never activates. */
  readonly publication?: DataReleaseV3PublicationPort;
}

interface ExpectedPublicState {
  readonly classification: PackScoutBuybackEvBackfillClassificationV1;
  readonly status: "current" | "sold_out_historical" | "unavailable";
  readonly reason: PackScoutBuybackEvPublicReasonCodeV1 | null;
}

interface MutableRecomputationTally {
  created: number;
  unchanged: number;
  superseded: number;
  rejected: number;
  unbindable: number;
  skippedNoEvidence: number;
}

function emptyCounts(): {
  total: number;
  recomputedAvailable: number;
  deterministicUnavailable: number;
  soldOutHistorical: number;
  byPublicReason: Record<string, number>;
  byConfidenceBand: Record<"low" | "medium" | "high", number>;
  bySourceAge: Record<PackScoutBuybackEvSourceAgeBucketV1, number>;
} {
  return {
    total: 0,
    recomputedAvailable: 0,
    deterministicUnavailable: 0,
    soldOutHistorical: 0,
    byPublicReason: {},
    byConfidenceBand: { low: 0, medium: 0, high: 0 },
    bySourceAge: {
      fresh_within_15_minutes: 0,
      delayed_over_15_through_30_minutes: 0,
      delayed_over_30_through_60_minutes: 0,
      stale_or_expired: 0,
      unknown_source_time: 0,
    },
  };
}

function sourceAgeBucket(
  ageMilliseconds: number | null,
): PackScoutBuybackEvSourceAgeBucketV1 {
  if (ageMilliseconds === null) return "unknown_source_time";
  if (ageMilliseconds > PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V3) {
    return "stale_or_expired";
  }
  if (ageMilliseconds > 30 * 60_000) {
    return "delayed_over_30_through_60_minutes";
  }
  if (ageMilliseconds > 15 * 60_000) {
    return "delayed_over_15_through_30_minutes";
  }
  return "fresh_within_15_minutes";
}

/**
 * Predicts the public EV state for one repack from its eligibility read and
 * availability — the independent derivation the staged plan must agree with.
 * The sold-out freeze re-derives the approved rule exactly: an estimate
 * calculated before sellout whose evidence was inside the freshness window at
 * sellout freezes; anything else is the deterministic stale state.
 */
function expectedStateFor(
  product: DataReleaseV3CanonicalProduct,
  eligibility: PackScoutBuybackEvPublicationEligibilityV1 | null,
): ExpectedPublicState {
  if (eligibility === null) {
    return {
      classification: "deterministic_unavailable",
      status: "unavailable",
      reason: "SOURCE_EVIDENCE_UNAVAILABLE",
    };
  }
  const projection = eligibility.projection;
  if (projection.status === "unavailable") {
    return {
      classification: "deterministic_unavailable",
      status: "unavailable",
      reason: projection.publicReason,
    };
  }
  const violatesPublicEvPolicy =
    !packScoutPublicEvMetricsAreNonpositiveV3(projection.metrics);
  if (product.availability === "sold_out") {
    const soldOutMillis =
      product.soldOutAt === null ? null : Date.parse(product.soldOutAt);
    const observedMillis = Date.parse(projection.dataAsOf.observedAt);
    const calculatedMillis = Date.parse(projection.calculatedAt);
    if (
      soldOutMillis !== null &&
      soldOutMillis >= calculatedMillis &&
      soldOutMillis - observedMillis <=
        PACKSCOUT_PUBLIC_EV_FRESHNESS_WINDOW_MILLISECONDS_V3
    ) {
      if (violatesPublicEvPolicy) {
        return {
          classification: "deterministic_unavailable",
          status: "unavailable",
          reason: "CALCULATION_UNAVAILABLE",
        };
      }
      return {
        classification: "sold_out_historical",
        status: "sold_out_historical",
        reason: null,
      };
    }
    return {
      classification: "deterministic_unavailable",
      status: "unavailable",
      reason: "SOURCE_DATA_STALE",
    };
  }
  if (violatesPublicEvPolicy) {
    return {
      classification: "deterministic_unavailable",
      status: "unavailable",
      reason: "CALCULATION_UNAVAILABLE",
    };
  }
  return {
    classification: "recomputed_available",
    status: "current",
    reason: null,
  };
}

async function verifyStagingReceipt(
  receipt: DataReleaseV3Receipt,
  expected: Readonly<{ operationKind: string; operationId: string }>,
): Promise<boolean> {
  const { receiptDigest, ...body } = receipt;
  const recomputed = await sha256CanonicalJson(
    DATA_RELEASE_V3_RECEIPT_HASH_DOMAIN,
    body,
  );
  return (
    recomputed === receiptDigest &&
    receipt.operationKind === expected.operationKind &&
    receipt.operationId === expected.operationId &&
    receipt.schemaVersion === DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION
  );
}

export interface PackScoutBuybackEvBackfillRunResultV1 {
  readonly classification: "ready" | "blocked";
  readonly ledger: PackScoutBuybackEvBackfillLedgerV1;
}

export class PackScoutBuybackEvBackfillReconciliationRunnerV1 {
  constructor(
    private readonly dependencies: PackScoutBuybackEvBackfillDependenciesV1,
  ) {}

  async run(input: {
    readonly readAt: string;
  }): Promise<PackScoutBuybackEvBackfillRunResultV1> {
    const readAtMillis = parsePackScoutBuybackEvTimestampMillisV1(input.readAt);
    const blocked: PackScoutBuybackEvBackfillBlockV1[] = [];
    if (readAtMillis === null) {
      return this.finish({
        organizationId: "unknown",
        readAt: input.readAt,
        rows: [],
        tally: this.emptyTally(),
        staging: null,
        methodVersions: [],
        confidencePolicyVersions: [],
        blocked: [
          {
            code: "READ_CLOCK_INVALID",
            productKey: null,
            detail: "readAt must be a canonical UTC millisecond timestamp.",
          },
        ],
      });
    }

    const snapshot = await this.dependencies.catalog.loadCatalogSnapshot({
      readAt: input.readAt,
    });
    const products = [...snapshot.products].sort((left, right) =>
      left.publicRepackId < right.publicRepackId ? -1 : 1,
    );
    const tally = this.emptyTally();

    // 1) Recompute every repack through the real boundary where evidence
    //    exists; rejected or unbindable work blocks the run.
    const recomputedOutcomes = new Map<
      string,
      PackScoutBuybackEvBackfillRecomputationOutcomeV1
    >();
    for (const product of products) {
      const command =
        this.dependencies.evidence === undefined
          ? null
          : await this.dependencies.evidence.loadCommand({
            organizationId: snapshot.organizationId,
            platformKey: product.platformKey,
            productKey: product.productKey,
            readAt: input.readAt,
          });
      if (command === null) {
        tally.skippedNoEvidence += 1;
        recomputedOutcomes.set(product.productKey, "skipped_no_evidence");
        continue;
      }
      if (command.organizationId !== snapshot.organizationId) {
        blocked.push({
          code: "EVIDENCE_SCOPE_VIOLATION",
          productKey: product.productKey,
          detail:
            "Evidence must be scoped to the canonical snapshot's organization.",
        });
        tally.skippedNoEvidence += 1;
        recomputedOutcomes.set(product.productKey, "skipped_no_evidence");
        continue;
      }
      const result = await this.dependencies.recomputation.recompute(command);
      tally[result.outcome] += 1;
      recomputedOutcomes.set(product.productKey, result.outcome);
      if (result.outcome === "rejected") {
        blocked.push({
          code: "RECOMPUTATION_REJECTED",
          productKey: product.productKey,
          detail: `Recomputation rejected: ${result.reason}.`,
        });
      } else if (result.outcome === "unbindable") {
        blocked.push({
          code: "RECOMPUTATION_UNBINDABLE",
          productKey: product.productKey,
          detail: "Evidence could not occupy any revision identity.",
        });
      }
    }

    // 2) Assemble the staged release plan at the same read clock.
    const plan = await this.dependencies.assembler.assemble({
      readAt: input.readAt,
    });
    if (plan.classification === "blocked") {
      blocked.push({
        code: "PLAN_BLOCKED",
        productKey: plan.blockedProductKey,
        detail: `The release assembler blocked the plan: ${plan.reason}.`,
      });
      return this.finish({
        organizationId: snapshot.organizationId,
        readAt: input.readAt,
        rows: [],
        tally,
        staging: null,
        methodVersions: [],
        confidencePolicyVersions: [],
        blocked,
      });
    }
    const details = plan.batches
      .filter((batch) => batch.kind === "repacks")
      .flatMap((batch) => batch.records as readonly PublicRepackDetailV3[]);
    const detailByRepackId = new Map(
      details.map((detail) => [detail.publicRepackId, detail]),
    );
    if (
      details.length !== products.length ||
      plan.manifest.counts.repacks !== products.length
    ) {
      blocked.push({
        code: "REPACK_SET_MISMATCH",
        productKey: null,
        detail: `The plan carries ${details.length} repacks for ${products.length} canonical products.`,
      });
    }

    // 3) Classify every repack and reconcile the two derivations.
    const rows: PackScoutBuybackEvBackfillRowV1[] = [];
    const methodVersions = new Set<string>([plan.manifest.methodVersion]);
    const confidencePolicyVersions = new Set<string>([
      plan.manifest.confidencePolicyVersion,
    ]);
    for (const product of products) {
      const eligibility =
        await this.dependencies.recomputation.getPublicationEligibleRevision({
          organizationId: snapshot.organizationId,
          platformKey: product.platformKey,
          productKey: product.productKey,
          readAt: input.readAt,
        });
      const expected = expectedStateFor(product, eligibility);
      const detail = detailByRepackId.get(product.publicRepackId);
      if (detail === undefined) {
        blocked.push({
          code: "REPACK_SET_MISMATCH",
          productKey: product.productKey,
          detail: "The staged plan is missing this canonical repack.",
        });
        continue;
      }
      const packScout = detail.evEstimates.packScout;
      const publishedReason =
        packScout.status === "unavailable" ? packScout.reason : null;
      if (
        packScout.status !== expected.status ||
        publishedReason !== expected.reason
      ) {
        blocked.push({
          code: "STATE_MISMATCH",
          productKey: product.productKey,
          detail:
            `Eligibility predicts ${expected.status}` +
            `${expected.reason === null ? "" : `/${expected.reason}`}, the plan emitted ` +
            `${packScout.status}${publishedReason === null ? "" : `/${publishedReason}`}.`,
        });
      }
      methodVersions.add(packScout.methodVersion);
      confidencePolicyVersions.add(packScout.confidencePolicyVersion);
      if (eligibility !== null) {
        methodVersions.add(eligibility.revision.methodVersion);
        confidencePolicyVersions.add(
          eligibility.revision.confidencePolicyVersion,
        );
      }
      rows.push({
        platformKey: product.platformKey,
        productKey: product.productKey,
        publicRepackId: product.publicRepackId,
        // The reconciliation row reports the canonical state verbatim: folding
        // `unavailable`/`unknown` into `available` would misreport them.
        availability: product.availability,
        classification: expected.classification,
        publicReason: expected.reason,
        recomputationOutcome:
          recomputedOutcomes.get(product.productKey) ?? "skipped_no_evidence",
        revisionId: eligibility?.revision.revisionId ?? null,
        revisionNumber: eligibility?.revision.revisionNumber ?? null,
        methodVersion:
          eligibility?.revision.methodVersion ??
          PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
        confidencePolicyVersion:
          eligibility?.revision.confidencePolicyVersion ??
          PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
        confidenceBand:
          packScout.status === "unavailable"
            ? null
            : packScout.confidence.band,
        sourceAgeBucket:
          packScout.status === "sold_out_historical"
            ? sourceAgeBucket(packScout.sourceAge.milliseconds)
            : packScout.dataAsOf.state === "known"
              ? sourceAgeBucket(
                readAtMillis - Date.parse(packScout.dataAsOf.observedAt),
              )
              : sourceAgeBucket(null),
        calculatedAt: eligibility?.projection.calculatedAt ?? null,
      });
    }
    if (methodVersions.size !== 1 || confidencePolicyVersions.size !== 1) {
      blocked.push({
        code: "VERSION_MIXED",
        productKey: null,
        detail:
          "Exactly one method version and one confidence policy version may appear.",
      });
    }
    if (
      !methodVersions.has(PACKSCOUT_BUYBACK_EV_METHOD_VERSION) ||
      !confidencePolicyVersions.has(
        PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
      )
    ) {
      blocked.push({
        code: "VERSION_MIXED",
        productKey: null,
        detail: "Only the approved buyback-adjusted versions may publish.",
      });
    }

    // 4) Stage the plan (never activate) and reconcile the accepted state.
    const staging = await this.stage(plan, blocked);

    return this.finish({
      organizationId: snapshot.organizationId,
      readAt: input.readAt,
      rows,
      tally,
      staging,
      methodVersions: [...methodVersions].sort(),
      confidencePolicyVersions: [...confidencePolicyVersions].sort(),
      blocked,
    });
  }

  private async stage(
    plan: DataReleaseV3PublishPlan,
    blocked: PackScoutBuybackEvBackfillBlockV1[],
  ): Promise<PackScoutBuybackEvBackfillStagingV1 | null> {
    const port = this.dependencies.publication;
    if (port === undefined) return null;
    const divergent = (detail: string) => {
      blocked.push({ code: "STAGING_DIVERGENT", productKey: null, detail });
    };
    try {
      const before = await port.activeState();
      // A previously staged identical release replays by read: the completed
      // status is the convergence point, so no staging write repeats.
      const alreadyStaged = await port.status(plan.publicReleaseId);
      if (alreadyStaged !== null && alreadyStaged.lifecycle === "complete") {
        if (alreadyStaged.releaseFingerprint !== plan.releaseFingerprint) {
          divergent("A conflicting release already occupies this identity.");
          return this.stagingState(plan, before, false, "not_staged");
        }
        return this.reconcileStagedStatus(plan, before, blocked, port);
      }
      const startOperationId = `${plan.publicReleaseId}:start`;
      const startReceipt = await port.start({
        schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
        operationId: startOperationId,
        idempotencyKey: startOperationId,
        publicReleaseId: plan.publicReleaseId,
        releaseFingerprint: plan.releaseFingerprint,
        manifest: plan.manifest,
      });
      if (
        !(await verifyStagingReceipt(startReceipt, {
          operationKind: "start",
          operationId: startOperationId,
        }))
      ) {
        divergent("The staging start receipt failed verification.");
        return this.stagingState(plan, before, false, "not_staged");
      }
      if (startReceipt.result !== "already_complete") {
        for (const batch of plan.batches) {
          const operationId = `${plan.publicReleaseId}:batch:${batch.batchIndex}`;
          const receipt = await port.applyBatch({
            schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
            operationId,
            idempotencyKey: operationId,
            publicReleaseId: plan.publicReleaseId,
            batchIndex: batch.batchIndex,
            kind: batch.kind,
            batchHash: batch.batchHash,
            records: batch.records,
          } as Parameters<DataReleaseV3PublicationPort["applyBatch"]>[0]);
          if (
            !(await verifyStagingReceipt(receipt, {
              operationKind: "applyBatch",
              operationId,
            }))
          ) {
            divergent("A staging batch receipt failed verification.");
            return this.stagingState(plan, before, false, "not_staged");
          }
        }
      }
      const finalizeOperationId = `${plan.publicReleaseId}:finalize`;
      const finalizeReceipt = await port.finalize({
        schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
        operationId: finalizeOperationId,
        idempotencyKey: finalizeOperationId,
        publicReleaseId: plan.publicReleaseId,
        releaseFingerprint: plan.releaseFingerprint,
        expectedCounts: plan.manifest.counts,
        expectedEntityChainHashes: plan.manifest.entityChainHashes,
        expectedTopChaseCount: plan.manifest.topChaseCount,
        expectedBatchCount: plan.manifest.batchCount,
        expectedBatchChainHash: plan.manifest.batchChainHash,
      });
      if (
        !(await verifyStagingReceipt(finalizeReceipt, {
          operationKind: "finalize",
          operationId: finalizeOperationId,
        }))
      ) {
        divergent("The staging finalize receipt failed verification.");
        return this.stagingState(plan, before, false, "not_staged");
      }
      return await this.reconcileStagedStatus(plan, before, blocked, port);
    } catch (error) {
      divergent(
        `Staging failed before completion: ${
          error instanceof Error ? error.message : String(error)
        }.`,
      );
      return {
        staged: false,
        publicReleaseId: plan.publicReleaseId,
        releaseFingerprint: plan.releaseFingerprint,
        lifecycle: "not_staged",
        priorActivePublicReleaseId: null,
        activePointerMoved: false,
      };
    }
  }

  /**
   * The single completion check: the staged status must reconcile the plan's
   * counts and hashes exactly, and the active pointer must not have moved.
   */
  private async reconcileStagedStatus(
    plan: DataReleaseV3PublishPlan,
    before: Awaited<ReturnType<DataReleaseV3PublicationPort["activeState"]>>,
    blocked: PackScoutBuybackEvBackfillBlockV1[],
    port: DataReleaseV3PublicationPort,
  ): Promise<PackScoutBuybackEvBackfillStagingV1> {
    const status = await port.status(plan.publicReleaseId);
    if (
      status === null ||
      status.lifecycle !== "complete" ||
      status.releaseFingerprint !== plan.releaseFingerprint ||
      status.acceptedBatchCount !== plan.manifest.batchCount ||
      status.acceptedBatchChainHash !== plan.manifest.batchChainHash ||
      status.acceptedTopChaseCount !== plan.manifest.topChaseCount ||
      // A server that reports the verified top-chase counter must report it
      // agreeing with the declared one on a complete release; a server that
      // predates the counter reports nothing and is not held to it.
      (status.acceptedVerifiedTopChaseCount !== undefined &&
        status.acceptedVerifiedTopChaseCount !==
          status.acceptedTopChaseCount) ||
      JSON.stringify(status.acceptedCounts) !==
        JSON.stringify(plan.manifest.counts) ||
      JSON.stringify(status.acceptedEntityChainHashes) !==
        JSON.stringify(plan.manifest.entityChainHashes)
    ) {
      blocked.push({
        code: "STAGING_DIVERGENT",
        productKey: null,
        // The declared/verified pair is named explicitly because it is the
        // one divergence an operator cannot reconstruct from the plan: both
        // counts are server-derived, and when the verified guard is what
        // refuses, the declared count still matches the manifest.
        detail:
          "The staged release did not read back complete" +
          ` (top chases: manifest ${plan.manifest.topChaseCount},` +
          ` declared ${status === null ? "unknown" : status.acceptedTopChaseCount},` +
          ` verified ${status?.acceptedVerifiedTopChaseCount ?? "unreported"}).`,
      });
      return this.stagingState(plan, before, false, "not_staged");
    }
    const after = await port.activeState();
    const pointerMoved =
      after.generation !== before.generation ||
      (after.activeRelease?.publicReleaseId ?? null) !==
        (before.activeRelease?.publicReleaseId ?? null);
    if (pointerMoved) {
      blocked.push({
        code: "ACTIVE_POINTER_MOVED",
        productKey: null,
        detail:
          "The active release pointer moved during staging; staging must never activate.",
      });
    }
    return {
      staged: true,
      publicReleaseId: plan.publicReleaseId,
      releaseFingerprint: plan.releaseFingerprint,
      lifecycle: "complete",
      priorActivePublicReleaseId: before.activeRelease?.publicReleaseId ?? null,
      activePointerMoved: pointerMoved,
    };
  }

  private stagingState(
    plan: DataReleaseV3PublishPlan,
    before: Awaited<ReturnType<DataReleaseV3PublicationPort["activeState"]>>,
    staged: boolean,
    lifecycle: "complete" | "not_staged",
  ): PackScoutBuybackEvBackfillStagingV1 {
    return {
      staged,
      publicReleaseId: plan.publicReleaseId,
      releaseFingerprint: plan.releaseFingerprint,
      lifecycle,
      priorActivePublicReleaseId: before.activeRelease?.publicReleaseId ?? null,
      activePointerMoved: false,
    };
  }

  private emptyTally(): MutableRecomputationTally {
    return {
      created: 0,
      unchanged: 0,
      superseded: 0,
      rejected: 0,
      unbindable: 0,
      skippedNoEvidence: 0,
    };
  }

  private finish(input: {
    readonly organizationId: string;
    readonly readAt: string;
    readonly rows: readonly PackScoutBuybackEvBackfillRowV1[];
    readonly tally: MutableRecomputationTally;
    readonly staging: PackScoutBuybackEvBackfillStagingV1 | null;
    readonly methodVersions: readonly string[];
    readonly confidencePolicyVersions: readonly string[];
    readonly blocked: readonly PackScoutBuybackEvBackfillBlockV1[];
  }): PackScoutBuybackEvBackfillRunResultV1 {
    const counts = emptyCounts();
    for (const row of input.rows) {
      counts.total += 1;
      if (row.classification === "recomputed_available") {
        counts.recomputedAvailable += 1;
      } else if (row.classification === "sold_out_historical") {
        counts.soldOutHistorical += 1;
      } else {
        counts.deterministicUnavailable += 1;
      }
      if (row.publicReason !== null) {
        counts.byPublicReason[row.publicReason] =
          (counts.byPublicReason[row.publicReason] ?? 0) + 1;
      }
      if (row.confidenceBand !== null) {
        counts.byConfidenceBand[row.confidenceBand] += 1;
      }
      counts.bySourceAge[row.sourceAgeBucket] += 1;
    }
    const classification = input.blocked.length === 0 ? "ready" : "blocked";
    const ledger: PackScoutBuybackEvBackfillLedgerV1 = {
      schemaVersion: PACKSCOUT_BUYBACK_EV_BACKFILL_VERSION,
      organizationId: input.organizationId,
      readAt: input.readAt,
      classification,
      methodVersions: input.methodVersions,
      confidencePolicyVersions: input.confidencePolicyVersions,
      counts,
      recomputation: {
        created: input.tally.created,
        unchanged: input.tally.unchanged,
        superseded: input.tally.superseded,
        rejected: input.tally.rejected,
        unbindable: input.tally.unbindable,
        skippedNoEvidence: input.tally.skippedNoEvidence,
      },
      staging: input.staging,
      rows: input.rows,
      blockedReasons: input.blocked,
    };
    return { classification, ledger };
  }
}
