import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  packScoutBuybackEvInputV1Schema,
  type PackScoutBuybackEvEvidenceOutcomeV1,
  type PackScoutBuybackEvInputV1,
} from "@packscout/contracts";
import {
  buildOutcome,
  buildRateTerms,
  buildStablecoinEvidence,
  buildUsdEvidence,
} from "./buyback-adjusted-ev-calculator.test-support.ts";
import {
  PACKSCOUT_BUYBACK_EV_CHANGE_MATRIX_V1,
  computePackScoutBuybackEvRecomputationFingerprintV1,
  derivePackScoutBuybackEvRecomputationBindingV1,
  packScoutBuybackEvRecomputationIdentityV1,
} from "./buyback-adjusted-ev-recomputation-contracts.ts";
import { computePackScoutBuybackEvEffectiveFingerprintV1 } from "./buyback-adjusted-ev-revision-contracts.ts";
import {
  PackScoutBuybackAdjustedEvRecomputationService,
  PackScoutBuybackEvRecomputationError,
} from "./buyback-adjusted-ev-recomputation-service.ts";
import {
  InMemoryBuybackEvRevisionPort,
  RECOMPUTATION_TEST_IDS,
  completeEvidenceOutcome,
  recomputationCommand,
  unavailableEvidenceOutcome,
} from "./buyback-adjusted-ev-recomputation.test-support.ts";
import {
  PackScoutBuybackEvRevisionStore,
  type PackScoutBuybackEvRevisionPersistencePortV1,
} from "./buyback-adjusted-ev-revision-store.ts";
import type {
  OperationalLog,
  OperationalMetric,
} from "./operational-events.ts";

const OBSERVED_AT = "2026-08-19T18:00:00.000Z";
const CALCULATED_AT = "2026-08-19T18:05:00.000Z";

function fingerprintOf(
  evidence: PackScoutBuybackEvEvidenceOutcomeV1,
  configurationRevisionId: string = RECOMPUTATION_TEST_IDS.configuration,
): string {
  const binding = derivePackScoutBuybackEvRecomputationBindingV1(evidence);
  assert.equal(binding.kind, "bindable");
  if (binding.kind !== "bindable") throw new Error("unbindable");
  return computePackScoutBuybackEvRecomputationFingerprintV1(
    binding,
    configurationRevisionId,
  );
}

function observation(
  overrides: Partial<{
    sourceRevisionId: string;
    sourceManifestSha256: string | null;
    observedAt: string;
  }> = {},
): PackScoutBuybackEvInputV1["observation"] {
  return {
    coherenceKind: "provider_revision",
    providerKey: "courtyard",
    sourceRevisionId: "catalog-revision-100",
    sourceManifestSha256: "1".repeat(64),
    observedAt: OBSERVED_AT,
    ...overrides,
  };
}

function harness() {
  const logs: OperationalLog[] = [];
  const metrics: OperationalMetric[] = [];
  const observability = {
    log: (entry: OperationalLog) => logs.push(entry),
    metric: (metric: OperationalMetric) => metrics.push(metric),
  };
  const port = new InMemoryBuybackEvRevisionPort();
  const store = new PackScoutBuybackEvRevisionStore(port, observability);
  const service = new PackScoutBuybackAdjustedEvRecomputationService(
    store,
    observability,
  );
  return { port, store, service, logs, metrics };
}

test("the change matrix maps every governing change to a new fingerprint and display-only work to an unchanged fingerprint", () => {
  const probes: Record<string, () => readonly [string, string]> = {
    publicPackPrice: () => [
      fingerprintOf(completeEvidenceOutcome()),
      fingerprintOf(
        completeEvidenceOutcome({ packPrice: buildUsdEvidence(12_000) }),
      ),
    ],
    currencyEvidence: () => [
      fingerprintOf(completeEvidenceOutcome()),
      fingerprintOf(
        completeEvidenceOutcome({
          packPrice: buildStablecoinEvidence({
            sourceMinorUnits: 100_000_000,
            canonicalUsdCents: { numerator: 10_000, denominator: 1 },
          }),
        }),
      ),
    ],
    odds: () => {
      const twoOutcomes = (
        alpha: { numerator: number; denominator: number },
        beta: { numerator: number; denominator: number },
      ) =>
        completeEvidenceOutcome({
          outcomes: [
            buildOutcome({ outcomeKey: "alpha-outcome", probability: alpha }),
            buildOutcome({ outcomeKey: "beta-outcome", probability: beta }),
          ],
        });
      return [
        fingerprintOf(
          twoOutcomes(
            { numerator: 1, denominator: 2 },
            { numerator: 1, denominator: 2 },
          ),
        ),
        fingerprintOf(
          twoOutcomes(
            { numerator: 1, denominator: 4 },
            { numerator: 3, denominator: 4 },
          ),
        ),
      ];
    },
    inventory: () => [
      fingerprintOf(completeEvidenceOutcome()),
      fingerprintOf(
        completeEvidenceOutcome({
          oddsEvidence: {
            sourceKind: "platform_published",
            poolKind: "finite",
            currentPoolEvidence: "unavailable",
            probabilityCoverage: "complete",
          },
        }),
      ),
    ],
    statedValues: () => [
      fingerprintOf(completeEvidenceOutcome()),
      fingerprintOf(
        completeEvidenceOutcome({
          outcomes: [
            buildOutcome({
              statedValue: { kind: "exact", amount: buildUsdEvidence(9_000) },
            }),
          ],
        }),
      ),
    ],
    payoutTerms: () => [
      fingerprintOf(completeEvidenceOutcome()),
      fingerprintOf(
        completeEvidenceOutcome({
          uniformBuybackRate: {
            scope: "every_eligible_outcome",
            terms: buildRateTerms({ rateBasisPoints: 9_000 }),
          },
        }),
      ),
    ],
    eligibility: () => {
      const exactPayout = (eligible: boolean) =>
        completeEvidenceOutcome({
          uniformBuybackRate: null,
          outcomes: [
            buildOutcome({
              buyback: eligible
                ? {
                  eligibility: "eligible",
                  payout: {
                    kind: "exact_final_payout",
                    evidenceKind: "documented_final_payout",
                    amount: buildUsdEvidence(8_500),
                  },
                }
                : { eligibility: "ineligible", payout: null },
            }),
          ],
        });
      return [fingerprintOf(exactPayout(true)), fingerprintOf(exactPayout(false))];
    },
    drawSemantics: () => [
      fingerprintOf(completeEvidenceOutcome()),
      fingerprintOf(
        completeEvidenceOutcome({
          unitBasis: { kind: "per_draw", drawCount: 2 },
        }),
      ),
    ],
    essentialSourceTime: () => [
      fingerprintOf(completeEvidenceOutcome()),
      fingerprintOf(
        completeEvidenceOutcome({
          observation: observation({
            observedAt: "2026-08-19T18:01:00.000Z",
          }),
        }),
      ),
    ],
    sourceRevision: () => [
      fingerprintOf(completeEvidenceOutcome()),
      fingerprintOf(
        completeEvidenceOutcome({
          observation: observation({
            sourceRevisionId: "catalog-revision-200",
          }),
        }),
      ),
    ],
    restockOrPoolReplacementOrDepletion: () => [
      // Identical economics and product identity; only the coherent
      // observation set (a restock re-observation) changed.
      fingerprintOf(completeEvidenceOutcome()),
      fingerprintOf(
        completeEvidenceOutcome({
          observation: observation({
            sourceRevisionId: "catalog-revision-300",
            observedAt: "2026-08-19T18:10:00.000Z",
          }),
        }),
      ),
    ],
    productRevision: () => [
      fingerprintOf(completeEvidenceOutcome()),
      fingerprintOf(
        completeEvidenceOutcome({
          product: {
            productKey: "courtyard-ironman-repack",
            productRevisionId: "product-revision-43",
          },
        }),
      ),
    ],
    approvedConfiguration: () => [
      fingerprintOf(completeEvidenceOutcome()),
      fingerprintOf(
        completeEvidenceOutcome(),
        "41000000-0000-4000-8000-0000000000c2",
      ),
    ],
    methodVersion: () => {
      const binding = derivePackScoutBuybackEvRecomputationBindingV1(
        completeEvidenceOutcome(),
      );
      if (binding.kind !== "bindable") throw new Error("unbindable");
      const identity = packScoutBuybackEvRecomputationIdentityV1(
        binding,
        RECOMPUTATION_TEST_IDS.configuration,
      );
      return [
        computePackScoutBuybackEvEffectiveFingerprintV1({
          identity,
          evidence: binding.evidence,
        }),
        computePackScoutBuybackEvEffectiveFingerprintV1({
          identity: {
            ...identity,
            methodVersion:
              "packscout-buyback-adjusted-ev-v2" as typeof identity.methodVersion,
          },
          evidence: binding.evidence,
        }),
      ];
    },
    confidencePolicyVersion: () => {
      const binding = derivePackScoutBuybackEvRecomputationBindingV1(
        completeEvidenceOutcome(),
      );
      if (binding.kind !== "bindable") throw new Error("unbindable");
      const identity = packScoutBuybackEvRecomputationIdentityV1(
        binding,
        RECOMPUTATION_TEST_IDS.configuration,
      );
      return [
        computePackScoutBuybackEvEffectiveFingerprintV1({
          identity,
          evidence: binding.evidence,
        }),
        computePackScoutBuybackEvEffectiveFingerprintV1({
          identity: {
            ...identity,
            confidencePolicyVersion:
              "packscout-buyback-adjusted-ev-confidence-v2" as typeof identity.confidencePolicyVersion,
          },
          evidence: binding.evidence,
        }),
      ];
    },
    unavailabilityFacts: () => [
      fingerprintOf(
        unavailableEvidenceOutcome({ internalReasons: ["MISSING_BUYBACK"] }),
      ),
      fingerprintOf(
        unavailableEvidenceOutcome({ internalReasons: ["INVALID_PRICE"] }),
      ),
    ],
    displayOnlyFields: () => {
      const base = completeEvidenceOutcome();
      // Display fields are structurally excluded: the strict input schema
      // rejects them outright, so they can never reach the fingerprint.
      if (base.status !== "complete") throw new Error("expected complete");
      assert.equal(
        packScoutBuybackEvInputV1Schema.safeParse({
          ...base.input,
          name: "Renamed Shiny Pack",
        }).success,
        false,
      );
      return [
        fingerprintOf(base),
        fingerprintOf(structuredClone(base)),
      ];
    },
    calculationClock: () => [
      // The fingerprint is derived from identity and evidence only; the
      // work item clock never participates, so replays converge.
      fingerprintOf(completeEvidenceOutcome()),
      fingerprintOf(completeEvidenceOutcome()),
    ],
    workMetadata: () => [
      fingerprintOf(completeEvidenceOutcome()),
      fingerprintOf(structuredClone(completeEvidenceOutcome())),
    ],
  };
  assert.deepEqual(
    Object.keys(probes).sort(),
    Object.keys(PACKSCOUT_BUYBACK_EV_CHANGE_MATRIX_V1).sort(),
    "every change-matrix entry must have exactly one behavioral probe",
  );
  for (const [change, entry] of Object.entries(
    PACKSCOUT_BUYBACK_EV_CHANGE_MATRIX_V1,
  )) {
    const [left, right] = probes[change]!();
    if (entry.effect === "new_fingerprint") {
      assert.notEqual(left, right, `${change} must produce a new fingerprint`);
    } else {
      assert.equal(left, right, `${change} must leave the fingerprint unchanged`);
    }
  }
});

test("complete evidence resolves into one created available revision with bounded status", async () => {
  const { port, service } = harness();
  const result = await service.recompute(
    recomputationCommand(completeEvidenceOutcome(), CALCULATED_AT),
  );
  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") return;
  assert.equal(result.revision.status, "available");
  assert.equal(result.revision.methodVersion, PACKSCOUT_BUYBACK_EV_METHOD_VERSION);
  assert.equal(result.projection.status, "available");
  assert.deepEqual(result.status, {
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1",
    availability: "AVAILABLE",
    publicReason: null,
    sourceAgeMilliseconds: 300_000,
  });
  assert.equal(port.rows.length, 1);
  assert.equal(port.rows[0]!.freshness.state, "current");
});

test("concurrent duplicate work converges on one immutable revision and retries stay idempotent", async () => {
  const { port, service } = harness();
  const command = recomputationCommand(completeEvidenceOutcome(), CALCULATED_AT);
  const outcomes = await Promise.all([
    service.recompute(command),
    service.recompute(command),
    service.recompute(command),
  ]);
  assert.deepEqual(
    outcomes.map(({ outcome }) => outcome).sort(),
    ["created", "unchanged", "unchanged"],
  );
  assert.equal(port.rows.length, 1);
  assert.equal(port.failures.size, 0);
  const retried = await service.recompute(command);
  assert.equal(retried.outcome, "unchanged");
  if (retried.outcome !== "unchanged") return;
  assert.equal(port.rows.length, 1);
  assert.equal(retried.revision.revisionId, port.rows[0]!.revisionId);
});

test("clock-drifted duplicate scheduling converges to one revision and ledgers the conflict", async () => {
  const { port, service } = harness();
  const evidence = completeEvidenceOutcome();
  const [left, right] = await Promise.all([
    service.recompute(recomputationCommand(evidence, CALCULATED_AT)),
    service.recompute(
      recomputationCommand(evidence, "2026-08-19T18:06:00.000Z"),
    ),
  ]);
  assert.deepEqual(
    [left.outcome, right.outcome].sort(),
    ["created", "rejected"],
  );
  const rejected = [left, right].find(({ outcome }) => outcome === "rejected");
  assert.ok(rejected && rejected.outcome === "rejected");
  assert.equal(rejected.reason, "RESULT_CONFLICT");
  assert.equal(port.rows.length, 1);
  // The redelivered drifted item now converges through the fingerprint
  // pre-check without touching the ledger again.
  const converged = await service.recompute(
    recomputationCommand(evidence, "2026-08-19T18:06:00.000Z"),
  );
  assert.equal(converged.outcome, "unchanged");
  assert.equal(port.rows.length, 1);
  assert.equal(port.failures.size, 1);
});

test("freshness recomputation replays unchanged and staleness derives at the publication read", async () => {
  const { port, service } = harness();
  const evidence = completeEvidenceOutcome();
  const created = await service.recompute(
    recomputationCommand(evidence, CALCULATED_AT),
  );
  assert.equal(created.outcome, "created");
  if (created.outcome !== "created") return;

  // The 15/30/60-minute boundary sweeps redeliver the same evidence under a
  // later clock: same fingerprint, no recalculation, no conflict, and the
  // immutable prior revision is never mutated.
  for (const laterClock of [
    "2026-08-19T18:25:00.000Z",
    "2026-08-19T18:45:00.000Z",
    "2026-08-19T19:30:00.000Z",
  ]) {
    const replay = await service.recompute(
      recomputationCommand(evidence, laterClock),
    );
    assert.equal(replay.outcome, "unchanged");
    if (replay.outcome !== "unchanged") return;
    assert.equal(replay.revision.revisionId, created.revision.revisionId);
  }
  assert.equal(port.rows.length, 1);
  assert.equal(port.failures.size, 0);
  assert.equal(port.rows[0]!.confidence?.scoreBasisPoints, 10_000);

  const query = {
    organizationId: RECOMPUTATION_TEST_IDS.organization,
    platformKey: "courtyard",
    productKey: "courtyard-ironman-repack",
  };
  const fresh = await service.getPublicationEligibleRevision({
    ...query,
    readAt: "2026-08-19T18:30:00.000Z",
  });
  assert.deepEqual(fresh?.readState, {
    state: "publishable",
    availability: "AVAILABLE",
  });
  const atExpiry = await service.getPublicationEligibleRevision({
    ...query,
    readAt: "2026-08-19T19:00:00.000Z",
  });
  assert.deepEqual(atExpiry?.readState, {
    state: "publishable",
    availability: "AVAILABLE",
  });
  const expired = await service.getPublicationEligibleRevision({
    ...query,
    readAt: "2026-08-19T19:00:00.001Z",
  });
  assert.deepEqual(expired?.readState, {
    state: "expired_since_calculation",
    staleSince: "2026-08-19T19:00:00.000Z",
  });
  assert.equal(expired?.revision.revisionId, created.revision.revisionId);
  // The read is repeatable: the same read clock returns the same answer.
  assert.deepEqual(
    expired,
    await service.getPublicationEligibleRevision({
      ...query,
      readAt: "2026-08-19T19:00:00.001Z",
    }),
  );
});

test("a newly observed but already stale observation mints the unavailable stale revision", async () => {
  const { port, service } = harness();
  const created = await service.recompute(
    recomputationCommand(completeEvidenceOutcome(), CALCULATED_AT),
  );
  assert.equal(created.outcome, "created");
  const reObserved = completeEvidenceOutcome({
    observation: observation({
      sourceRevisionId: "catalog-revision-200",
      observedAt: "2026-08-19T18:30:00.000Z",
    }),
  });
  const stale = await service.recompute(
    recomputationCommand(reObserved, "2026-08-19T20:05:00.000Z"),
  );
  assert.equal(stale.outcome, "created");
  if (stale.outcome !== "created") return;
  assert.equal(stale.revision.status, "unavailable");
  assert.equal(stale.status.publicReason, "SOURCE_DATA_STALE");
  assert.equal(port.rows.length, 2);
  const staleRow = port.rows[1]!;
  assert.deepEqual(staleRow.internalReasons, ["STALE_EVIDENCE"]);
  assert.equal(staleRow.freshness.state, "expired");
  const current = await service.getPublicationEligibleRevision({
    organizationId: RECOMPUTATION_TEST_IDS.organization,
    platformKey: "courtyard",
    productKey: "courtyard-ironman-repack",
    readAt: "2026-08-19T20:06:00.000Z",
  });
  assert.equal(current?.revision.revisionId, stale.revision.revisionId);
  assert.deepEqual(current?.readState, {
    state: "publishable",
    availability: "UNAVAILABLE",
  });
});

test("out-of-order rapid changes resolve by essential source order, never arrival order", async () => {
  const { port, service } = harness();
  const repricedNewer = completeEvidenceOutcome({
    packPrice: buildUsdEvidence(12_000),
    observation: observation({
      sourceRevisionId: "catalog-revision-210",
      observedAt: "2026-08-19T18:10:00.000Z",
    }),
  });
  const newer = await service.recompute(
    recomputationCommand(repricedNewer, "2026-08-19T18:11:00.000Z"),
  );
  assert.equal(newer.outcome, "created");
  if (newer.outcome !== "created") return;

  const olderArrivingLate = await service.recompute(
    recomputationCommand(completeEvidenceOutcome(), "2026-08-19T18:12:00.000Z"),
  );
  assert.equal(olderArrivingLate.outcome, "superseded");
  if (olderArrivingLate.outcome !== "superseded") return;
  assert.equal(
    olderArrivingLate.currentRevision.revisionId,
    newer.revision.revisionId,
  );
  assert.equal(port.rows.length, 1);
  assert.equal(port.failures.size, 0);

  // Redelivering the superseded older change stays superseded forever.
  const redelivered = await service.recompute(
    recomputationCommand(completeEvidenceOutcome(), "2026-08-19T18:20:00.000Z"),
  );
  assert.equal(redelivered.outcome, "superseded");

  // Unknown-source-time evidence cannot displace ordered current economics.
  const unknownTime = await service.recompute(
    recomputationCommand(
      unavailableEvidenceOutcome({
        internalReasons: ["MISSING_SOURCE_TIME"],
        sourceRevisionId: "catalog-revision-220",
        observedAt: null,
      }),
      "2026-08-19T18:21:00.000Z",
    ),
  );
  assert.equal(unknownTime.outcome, "superseded");

  // A genuinely newer observation still becomes current.
  const newest = await service.recompute(
    recomputationCommand(
      completeEvidenceOutcome({
        packPrice: buildUsdEvidence(11_000),
        observation: observation({
          sourceRevisionId: "catalog-revision-230",
          observedAt: "2026-08-19T18:20:00.000Z",
        }),
      }),
      "2026-08-19T18:22:00.000Z",
    ),
  );
  assert.equal(newest.outcome, "created");
  assert.equal(port.rows.length, 2);
  assert.equal(port.rows[1]!.revisionNumber, 2);
});

test("a concurrent read-check-act interleaving cannot make older evidence current", async () => {
  const { port, service } = harness();
  const newer = await service.recompute(
    recomputationCommand(
      completeEvidenceOutcome({
        packPrice: buildUsdEvidence(12_000),
        observation: observation({
          sourceRevisionId: "catalog-revision-310",
          observedAt: "2026-08-19T18:10:00.000Z",
        }),
      }),
      "2026-08-19T18:11:00.000Z",
    ),
  );
  assert.equal(newer.outcome, "created");
  if (newer.outcome !== "created") return;

  // A concurrent recomputation for the same product performed its read-time
  // supersede check BEFORE the newer revision committed, so that check saw
  // no current revision at all (the write-skew window). The persistence
  // boundary must still refuse the older evidence inside the write.
  const staleReadPort: PackScoutBuybackEvRevisionPersistencePortV1 = {
    persistCompletedRevision: (input) => port.persistCompletedRevision(input),
    recordPersistenceFailure: (input) => port.recordPersistenceFailure(input),
    getCurrentCompletedRevision: async () => null,
    getRevisionTrace: async () => null,
  };
  const racingService = new PackScoutBuybackAdjustedEvRecomputationService(
    new PackScoutBuybackEvRevisionStore(staleReadPort),
  );
  const older = await racingService.recompute(
    recomputationCommand(completeEvidenceOutcome(), "2026-08-19T18:12:00.000Z"),
  );
  assert.equal(older.outcome, "superseded");
  if (older.outcome !== "superseded") return;
  assert.equal(older.currentRevision.revisionId, newer.revision.revisionId);
  assert.equal(
    port.rows.length,
    1,
    "older evidence must never occupy a revision through a stale read",
  );
  assert.equal(port.failures.size, 0, "superseded work is ordered, not failed");

  // Unknown-source-time evidence racing the same window is refused too.
  const unknownTime = await racingService.recompute(
    recomputationCommand(
      unavailableEvidenceOutcome({
        internalReasons: ["MISSING_SOURCE_TIME"],
        sourceRevisionId: "catalog-revision-320",
        observedAt: null,
      }),
      "2026-08-19T18:13:00.000Z",
    ),
  );
  assert.equal(unknownTime.outcome, "superseded");
  assert.equal(port.rows.length, 1);

  // Equal essential source time is not a regression: it falls through to
  // the identity rules and may occupy the next revision.
  const equalTime = await racingService.recompute(
    recomputationCommand(
      completeEvidenceOutcome({
        packPrice: buildUsdEvidence(11_000),
        observation: observation({
          sourceRevisionId: "catalog-revision-330",
          observedAt: "2026-08-19T18:10:00.000Z",
        }),
      }),
      "2026-08-19T18:14:00.000Z",
    ),
  );
  assert.equal(equalTime.outcome, "created");
  assert.equal(port.rows.length, 2);
  assert.equal(port.rows[1]!.revisionNumber, 2);
});

test("canonical unavailable evidence composes deterministic unavailable revisions across freshness states", async () => {
  const { port, service } = harness();

  // Fresh missing buyback: no confidence evaluation exists; the composed
  // revision keeps current freshness and the evidence reasons.
  const fresh = await service.recompute(
    recomputationCommand(
      unavailableEvidenceOutcome({
        internalReasons: ["MISSING_BUYBACK"],
        sourceRevisionId: "catalog-revision-401",
      }),
      CALCULATED_AT,
    ),
  );
  assert.equal(fresh.outcome, "created");
  if (fresh.outcome !== "created") return;
  assert.equal(fresh.revision.status, "unavailable");
  assert.equal(fresh.status.publicReason, "BUYBACK_UNAVAILABLE");
  const freshRow = port.rows[0]!;
  assert.deepEqual(freshRow.internalReasons, ["MISSING_BUYBACK"]);
  assert.equal(freshRow.freshness.state, "current");
  assert.equal(freshRow.metrics, null);
  assert.equal(freshRow.confidence, null);
  assert.equal(freshRow.dataAsOf.observedAt, OBSERVED_AT);

  // Redelivery under any later clock replays unchanged.
  const replay = await service.recompute(
    recomputationCommand(
      unavailableEvidenceOutcome({
        internalReasons: ["MISSING_BUYBACK"],
        sourceRevisionId: "catalog-revision-401",
      }),
      "2026-08-19T19:05:00.000Z",
    ),
  );
  assert.equal(replay.outcome, "unchanged");
  assert.equal(port.rows.length, 1);

  // The same unavailability re-observed after expiry composes the stale
  // reason deterministically on a new revision.
  const expired = await service.recompute(
    recomputationCommand(
      unavailableEvidenceOutcome({
        internalReasons: ["MISSING_BUYBACK"],
        sourceRevisionId: "catalog-revision-402",
        observedAt: "2026-08-19T18:30:00.000Z",
      }),
      "2026-08-19T20:05:00.000Z",
    ),
  );
  assert.equal(expired.outcome, "created");
  const expiredRow = port.rows[1]!;
  assert.deepEqual(expiredRow.internalReasons, [
    "MISSING_BUYBACK",
    "STALE_EVIDENCE",
  ]);
  assert.equal(expiredRow.freshness.state, "expired");
  assert.equal(expiredRow.publicPrimaryReason, "BUYBACK_UNAVAILABLE");
});

test("confidence freshness boundaries score deterministically at the calculation clock", async () => {
  const { port, service } = harness();
  const delayed = await service.recompute(
    recomputationCommand(completeEvidenceOutcome(), "2026-08-19T18:20:00.000Z"),
  );
  assert.equal(delayed.outcome, "created");
  if (delayed.outcome !== "created") return;
  assert.equal(delayed.revision.status, "available");
  assert.deepEqual(port.rows[0]!.confidence, {
    scoreBasisPoints: 9_000,
    band: "high",
    limitationCodes: ["source_age_over_15_through_30_minutes"],
  });

  const veryDelayed = await service.recompute(
    recomputationCommand(
      completeEvidenceOutcome({
        observation: observation({
          sourceRevisionId: "catalog-revision-800",
          observedAt: "2026-08-19T18:05:00.000Z",
        }),
      }),
      "2026-08-19T18:40:00.000Z",
    ),
  );
  assert.equal(veryDelayed.outcome, "created");
  assert.deepEqual(port.rows[1]!.confidence, {
    scoreBasisPoints: 7_500,
    band: "medium",
    limitationCodes: ["source_age_over_30_through_60_minutes"],
  });
});

test("a calculation clock preceding the observation fails closed as unknown source time", async () => {
  const { port, service } = harness();
  const result = await service.recompute(
    recomputationCommand(completeEvidenceOutcome(), "2026-08-19T17:00:00.000Z"),
  );
  assert.equal(result.outcome, "created");
  if (result.outcome !== "created") return;
  assert.equal(result.revision.status, "unavailable");
  const row = port.rows[0]!;
  assert.deepEqual(row.internalReasons, ["MISSING_SOURCE_TIME"]);
  assert.deepEqual(row.dataAsOf, {
    state: "unknown_source_time",
    observedAt: null,
  });
  assert.equal(row.freshness.state, "unknown_source_time");
});

test("unbindable evidence only reaches the deduplicated failure ledger", async () => {
  const { port, service } = harness();
  const noObservation = unavailableEvidenceOutcome({
    internalReasons: ["MISSING_PROVENANCE", "MISSING_SOURCE_TIME"],
    observationPresent: false,
    observedAt: null,
  });
  const first = await service.recompute(
    recomputationCommand(noObservation, CALCULATED_AT),
  );
  assert.deepEqual(first, {
    outcome: "unbindable",
    reason: "UNBINDABLE_RESULT",
    occurrenceCount: 1,
  });
  const repeated = await service.recompute(
    recomputationCommand(noObservation, CALCULATED_AT),
  );
  assert.deepEqual(repeated, {
    outcome: "unbindable",
    reason: "UNBINDABLE_RESULT",
    occurrenceCount: 2,
  });
  assert.equal(port.rows.length, 0);
  assert.equal(port.failures.size, 1);

  const unknownProduct = await service.recompute(
    recomputationCommand(
      unavailableEvidenceOutcome({
        internalReasons: ["MISSING_PRODUCT_IDENTITY"],
        productState: "unknown",
      }),
      CALCULATED_AT,
    ),
  );
  assert.deepEqual(unknownProduct, {
    outcome: "unbindable",
    reason: "UNBINDABLE_RESULT",
    occurrenceCount: 1,
  });
  assert.equal(port.rows.length, 0);
  assert.equal(port.failures.size, 2);
  for (const failure of port.failures.values()) {
    assert.equal(failure.reasonCode, "UNBINDABLE_RESULT");
  }
});

test("conflicting identity reuse is rejected without replacing the completed revision", async () => {
  const { port, service } = harness();
  const created = await service.recompute(
    recomputationCommand(completeEvidenceOutcome(), CALCULATED_AT),
  );
  assert.equal(created.outcome, "created");
  // Same observation set claims different economics: a provider anomaly.
  const conflicting = await service.recompute(
    recomputationCommand(
      completeEvidenceOutcome({ packPrice: buildUsdEvidence(12_000) }),
      CALCULATED_AT,
    ),
  );
  assert.deepEqual(conflicting, {
    outcome: "rejected",
    reason: "IDENTITY_REUSE_CONFLICT",
    occurrenceCount: 1,
  });
  assert.equal(port.rows.length, 1);
  const current = await service.getPublicationEligibleRevision({
    organizationId: RECOMPUTATION_TEST_IDS.organization,
    platformKey: "courtyard",
    productKey: "courtyard-ironman-repack",
    readAt: "2026-08-19T18:10:00.000Z",
  });
  assert.equal(
    current?.revision.revisionId,
    created.outcome === "created" ? created.revision.revisionId : null,
  );
});

test("availability transitions follow the evidence deterministically", async () => {
  const { service } = harness();
  const unavailable = await service.recompute(
    recomputationCommand(
      unavailableEvidenceOutcome({
        internalReasons: ["MISSING_BUYBACK"],
        sourceRevisionId: "catalog-revision-500",
        observedAt: "2026-08-19T18:00:00.000Z",
      }),
      "2026-08-19T18:01:00.000Z",
    ),
  );
  assert.equal(unavailable.outcome, "created");
  if (unavailable.outcome !== "created") return;
  assert.equal(unavailable.status.availability, "UNAVAILABLE");

  // Newly complete evidence turns the estimate available.
  const available = await service.recompute(
    recomputationCommand(
      completeEvidenceOutcome({
        observation: observation({
          sourceRevisionId: "catalog-revision-501",
          observedAt: "2026-08-19T18:10:00.000Z",
        }),
      }),
      "2026-08-19T18:11:00.000Z",
    ),
  );
  assert.equal(available.outcome, "created");
  if (available.outcome !== "created") return;
  assert.equal(available.status.availability, "AVAILABLE");

  // Newly missing evidence turns it deterministically unavailable again.
  const missingAgain = await service.recompute(
    recomputationCommand(
      unavailableEvidenceOutcome({
        internalReasons: ["MISSING_BUYBACK"],
        sourceRevisionId: "catalog-revision-502",
        observedAt: "2026-08-19T18:20:00.000Z",
      }),
      "2026-08-19T18:21:00.000Z",
    ),
  );
  assert.equal(missingAgain.outcome, "created");
  if (missingAgain.outcome !== "created") return;
  assert.deepEqual(missingAgain.status, {
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: "packscout-buyback-adjusted-ev-confidence-v1",
    availability: "UNAVAILABLE",
    publicReason: "BUYBACK_UNAVAILABLE",
    sourceAgeMilliseconds: null,
  });
});

test("recovery reprocessing never mutates completed history", async () => {
  const { port, service } = harness();
  const commands = [
    recomputationCommand(completeEvidenceOutcome(), CALCULATED_AT),
    recomputationCommand(
      completeEvidenceOutcome({
        packPrice: buildUsdEvidence(12_000),
        observation: observation({
          sourceRevisionId: "catalog-revision-600",
          observedAt: "2026-08-19T18:10:00.000Z",
        }),
      }),
      "2026-08-19T18:11:00.000Z",
    ),
  ];
  for (const command of commands) {
    assert.equal((await service.recompute(command)).outcome, "created");
  }
  assert.equal(port.rows.length, 2);
  const rowsBefore = structuredClone(port.rows);

  const recovered = await service.reprocess(commands);
  assert.deepEqual(recovered.tally, {
    created: 0,
    unchanged: 1,
    superseded: 1,
    rejected: 0,
    unbindable: 0,
  });
  assert.deepEqual(port.rows, rowsBefore);

  await assert.rejects(
    service.reprocess(
      Array.from({ length: 101 }, () => commands[0]!),
    ),
    (error: unknown) =>
      error instanceof PackScoutBuybackEvRecomputationError &&
      error.code === "CONTRACT_VIOLATION",
  );
});

test("contract violations fail closed before any store work", async () => {
  const { port, service } = harness();
  const violates = (input: Parameters<typeof service.recompute>[0]) =>
    assert.rejects(
      service.recompute(input),
      (error: unknown) =>
        error instanceof PackScoutBuybackEvRecomputationError &&
        error.code === "CONTRACT_VIOLATION",
    );
  await violates(
    recomputationCommand(completeEvidenceOutcome(), "2026-08-19T18:05:00Z"),
  );
  await violates({
    ...recomputationCommand(completeEvidenceOutcome(), CALCULATED_AT),
    evidence: { raw_provider_blob: "garbage" },
  });
  await assert.rejects(
    service.getPublicationEligibleRevision({
      organizationId: RECOMPUTATION_TEST_IDS.organization,
      platformKey: "courtyard",
      productKey: "courtyard-ironman-repack",
      readAt: "not-a-timestamp",
    }),
    (error: unknown) =>
      error instanceof PackScoutBuybackEvRecomputationError &&
      error.code === "CONTRACT_VIOLATION",
  );
  assert.equal(port.rows.length, 0);
  assert.equal(port.failures.size, 0);
});

test("operational events stay bounded and never leak money, evidence, or source fields", async () => {
  const { service, logs, metrics } = harness();
  await service.recompute(
    recomputationCommand(completeEvidenceOutcome(), CALCULATED_AT),
  );
  await service.recompute(
    recomputationCommand(completeEvidenceOutcome(), "2026-08-19T18:30:00.000Z"),
  );
  await service.recompute(
    recomputationCommand(
      unavailableEvidenceOutcome({
        internalReasons: ["MISSING_BUYBACK"],
        sourceRevisionId: "catalog-revision-700",
        observedAt: "2026-08-19T18:10:00.000Z",
      }),
      "2026-08-19T18:11:00.000Z",
    ),
  );
  await service.recompute(
    recomputationCommand(completeEvidenceOutcome(), "2026-08-19T18:40:00.000Z"),
  );
  await service.recompute(
    recomputationCommand(
      unavailableEvidenceOutcome({
        internalReasons: ["MISSING_PROVENANCE", "MISSING_SOURCE_TIME"],
        observationPresent: false,
        observedAt: null,
      }),
      "2026-08-19T18:41:00.000Z",
    ),
  );
  assert.ok(logs.length > 0);
  assert.ok(metrics.length > 0);
  for (const entry of logs) {
    assert.match(entry.code, /^[A-Z][A-Z0-9_]{0,127}$/);
    assert.ok(["info", "warning"].includes(entry.level));
  }
  const serialized = JSON.stringify([logs, metrics]);
  assert.doesNotMatch(
    serialized,
    /minorUnits|grossEv|packPrice|statedValue|payout|canonicalUsdCents/,
  );
  assert.doesNotMatch(serialized, /(?<![0-9-])(8500|10000|12000|1500)(?![0-9])/);
  assert.doesNotMatch(
    serialized,
    /catalog-revision|product-revision|courtyard|raw_provider_blob/,
  );
  assert.ok(
    logs.some(({ code }) => code === "BUYBACK_EV_RECOMPUTATION_UNCHANGED"),
  );
  assert.ok(
    logs.some(
      ({ code }) =>
        code === "BUYBACK_EV_RECOMPUTATION_UNAVAILABLE_BUYBACK_UNAVAILABLE",
    ),
  );
});
