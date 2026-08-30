import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  publicRepackDetailV3Schema,
  type PublicRepackDetailV3,
} from "@packscout/contracts";
import { DataReleaseV3ReleaseAssembler } from "./buyback-adjusted-ev-release-assembler.ts";
import type {
  DataReleaseV3CanonicalSnapshot,
  DataReleaseV3EligibilityPort,
  DataReleaseV3PublishPlan,
} from "./buyback-adjusted-ev-release-types.ts";
import type { PackScoutBuybackEvPublicationEligibilityV1 } from "./buyback-adjusted-ev-recomputation-contracts.ts";
import {
  RELEASE_READ_AT,
  RELEASE_SOLD_OUT_AT,
  buildExpiredEligibility,
  buildPublishableEligibility,
  buildReleaseProduct,
  buildReleaseSnapshot,
  buildUnavailableEligibility,
} from "./buyback-adjusted-ev-release.test-support.ts";

const REPACK_A = "00000000-0000-5000-8000-000000000301";
const REPACK_B = "00000000-0000-5000-8000-000000000302";
const REPACK_C = "00000000-0000-5000-8000-000000000303";

function catalogPort(snapshot: DataReleaseV3CanonicalSnapshot) {
  return {
    loadCatalogSnapshot: async () => snapshot,
  };
}

function eligibilityPort(
  byProductKey: ReadonlyMap<
    string,
    PackScoutBuybackEvPublicationEligibilityV1 | null
  >,
): DataReleaseV3EligibilityPort {
  return {
    getPublicationEligibleRevision: async ({ productKey }) =>
      byProductKey.get(productKey) ?? null,
  };
}

function goldenSnapshot(): DataReleaseV3CanonicalSnapshot {
  return buildReleaseSnapshot([
    buildReleaseProduct({ publicRepackId: REPACK_A }),
    buildReleaseProduct({
      publicRepackId: REPACK_B,
      name: "Pokemon Vault Repack",
      availability: "sold_out",
      soldOutAt: RELEASE_SOLD_OUT_AT,
      actionAvailability: { promo: true, repackLink: false },
      actions: { promo: { code: "SCOUT", label: "Use SCOUT" } },
    }),
    buildReleaseProduct({
      publicRepackId: REPACK_C,
      name: "Pokemon Mystery Box",
      buyback: { kind: "not_documented" },
    }),
  ]);
}

function goldenEligibility() {
  const snapshot = goldenSnapshot();
  const productKeyOf = (publicRepackId: string) =>
    snapshot.products.find(
      (product) => product.publicRepackId === publicRepackId,
    )!.productKey;
  return new Map<string, PackScoutBuybackEvPublicationEligibilityV1 | null>([
    [productKeyOf(REPACK_A), buildPublishableEligibility(9_000)],
    [productKeyOf(REPACK_B), buildPublishableEligibility(8_500)],
    [productKeyOf(REPACK_C), buildUnavailableEligibility("BUYBACK_UNAVAILABLE")],
  ]);
}

async function assembleGolden(): Promise<DataReleaseV3PublishPlan> {
  const assembler = new DataReleaseV3ReleaseAssembler(
    catalogPort(goldenSnapshot()),
    eligibilityPort(goldenEligibility()),
  );
  const plan = await assembler.assemble({ readAt: RELEASE_READ_AT });
  assert.equal(plan.classification, "publish");
  if (plan.classification !== "publish") throw new Error("unreachable");
  return plan;
}

function repackDetails(plan: DataReleaseV3PublishPlan): PublicRepackDetailV3[] {
  return plan.batches
    .filter(({ kind }) => kind === "repacks")
    .flatMap(({ records }) =>
      records.map((record) => publicRepackDetailV3Schema.parse(record)),
    );
}

test("assembles one canonical state into validated task-007 entities", async () => {
  const plan = await assembleGolden();
  assert.equal(plan.manifest.counts.repacks, 3);
  assert.equal(plan.manifest.counts.categories, 1);
  assert.equal(plan.manifest.counts.collectibles, 1);
  assert.equal(plan.manifest.counts.chases, 3);
  assert.equal(plan.manifest.counts.searchShards, 1);
  assert.equal(plan.manifest.topChaseCount, 3);
  assert.equal(plan.manifest.methodVersion, PACKSCOUT_BUYBACK_EV_METHOD_VERSION);
  const details = repackDetails(plan);
  assert.equal(details.length, 3);
  const current = details.find(({ publicRepackId }) => publicRepackId === REPACK_A)!;
  assert.equal(current.evEstimates.packScout.status, "current");
  const soldOut = details.find(({ publicRepackId }) => publicRepackId === REPACK_B)!;
  assert.equal(soldOut.evEstimates.packScout.status, "sold_out_historical");
  assert.equal(soldOut.actions.repackLink, undefined);
  const unavailable = details.find(
    ({ publicRepackId }) => publicRepackId === REPACK_C,
  )!;
  assert.equal(unavailable.evEstimates.packScout.status, "unavailable");
  if (unavailable.evEstimates.packScout.status !== "unavailable") return;
  assert.equal(
    unavailable.evEstimates.packScout.reason,
    "BUYBACK_UNAVAILABLE",
  );
  // Deterministic kind order with strictly ascending record keys.
  assert.deepEqual(
    plan.batches.map(({ kind }) => kind),
    ["categories", "collectibles", "repacks", "chases"],
  );
});

test("identical replay assembles a byte-identical plan", async () => {
  const first = await assembleGolden();
  const second = await assembleGolden();
  assert.equal(second.publicReleaseId, first.publicReleaseId);
  assert.equal(second.releaseFingerprint, first.releaseFingerprint);
  assert.deepEqual(second, first);
});

test("an expired-since-calculation revision publishes the deterministic stale state", async () => {
  const snapshot = buildReleaseSnapshot([
    buildReleaseProduct({ publicRepackId: REPACK_A }),
  ]);
  const assembler = new DataReleaseV3ReleaseAssembler(
    catalogPort(snapshot),
    eligibilityPort(
      new Map([[snapshot.products[0]!.productKey, buildExpiredEligibility()]]),
    ),
  );
  // The stale conversion is honest only once the read clock has passed the
  // 60-minute deadline for the frozen observation.
  const readAt = new Date(
    Date.parse(RELEASE_READ_AT) + 61 * 60_000,
  ).toISOString();
  const plan = await assembler.assemble({ readAt });
  assert.equal(plan.classification, "publish");
  if (plan.classification !== "publish") return;
  const [detail] = repackDetails(plan);
  assert.equal(detail!.evEstimates.packScout.status, "unavailable");
  if (detail!.evEstimates.packScout.status !== "unavailable") return;
  assert.equal(detail!.evEstimates.packScout.reason, "SOURCE_DATA_STALE");
  assert.deepEqual(detail!.evEstimates.packScout.dataAsOf, {
    state: "known",
    observedAt: buildExpiredEligibility().projection.dataAsOf.observedAt,
  });
});

test("positive raw current EV fails closed per pack without altering the revision", async () => {
  const snapshot = buildReleaseSnapshot([
    buildReleaseProduct({ publicRepackId: REPACK_A }),
  ]);
  const eligibility = buildPublishableEligibility(12_000);
  const assembler = new DataReleaseV3ReleaseAssembler(
    catalogPort(snapshot),
    eligibilityPort(new Map([[snapshot.products[0]!.productKey, eligibility]])),
  );

  const plan = await assembler.assemble({ readAt: RELEASE_READ_AT });
  assert.equal(plan.classification, "publish");
  if (plan.classification !== "publish") return;
  const [detail] = repackDetails(plan);
  assert.deepEqual(detail?.evEstimates.packScout, {
    status: "unavailable",
    methodVersion: eligibility.revision.methodVersion,
    confidencePolicyVersion: eligibility.revision.confidencePolicyVersion,
    metrics: null,
    confidence: null,
    calculatedAt: eligibility.projection.calculatedAt,
    dataAsOf: eligibility.projection.dataAsOf,
    reason: "CALCULATION_UNAVAILABLE",
  });
  assert.equal(
    eligibility.projection.status === "available"
      ? eligibility.projection.metrics.evDollars.minorUnits
      : null,
    2_000,
    "the protected raw revision remains exact",
  );
});

test("positive raw EV cannot enter a sold-out historical public estimate", async () => {
  const snapshot = buildReleaseSnapshot([
    buildReleaseProduct({
      publicRepackId: REPACK_A,
      availability: "sold_out",
      soldOutAt: RELEASE_SOLD_OUT_AT,
      actionAvailability: { promo: true, repackLink: false },
      actions: { promo: { code: "SCOUT", label: "Use SCOUT" } },
    }),
  ]);
  const assembler = new DataReleaseV3ReleaseAssembler(
    catalogPort(snapshot),
    eligibilityPort(
      new Map([[snapshot.products[0]!.productKey, buildPublishableEligibility(12_000)]]),
    ),
  );

  const plan = await assembler.assemble({ readAt: RELEASE_READ_AT });
  assert.equal(plan.classification, "publish");
  if (plan.classification !== "publish") return;
  assert.equal(
    repackDetails(plan)[0]?.evEstimates.packScout.status,
    "unavailable",
  );
});

test("a product with no completed revision publishes the explicit unknown-evidence state", async () => {
  const snapshot = buildReleaseSnapshot([
    buildReleaseProduct({
      publicRepackId: REPACK_A,
      buyback: { kind: "not_documented" },
    }),
  ]);
  const assembler = new DataReleaseV3ReleaseAssembler(
    catalogPort(snapshot),
    eligibilityPort(new Map()),
  );
  const plan = await assembler.assemble({ readAt: RELEASE_READ_AT });
  assert.equal(plan.classification, "publish");
  if (plan.classification !== "publish") return;
  const [detail] = repackDetails(plan);
  if (detail!.evEstimates.packScout.status !== "unavailable") {
    throw new Error("expected unavailable");
  }
  assert.equal(
    detail!.evEstimates.packScout.reason,
    "SOURCE_EVIDENCE_UNAVAILABLE",
  );
  assert.deepEqual(detail!.evEstimates.packScout.dataAsOf, {
    state: "unknown_source_time",
    observedAt: null,
  });
});

test("mixed calculation versions block the release", async () => {
  const snapshot = buildReleaseSnapshot([
    buildReleaseProduct({ publicRepackId: REPACK_A }),
  ]);
  const tampered = buildPublishableEligibility();
  const assembler = new DataReleaseV3ReleaseAssembler(
    catalogPort(snapshot),
    eligibilityPort(
      new Map([
        [
          snapshot.products[0]!.productKey,
          {
            ...tampered,
            revision: {
              ...tampered.revision,
              methodVersion:
                "estimated-ev-v2" as typeof tampered.revision.methodVersion,
            },
          },
        ],
      ]),
    ),
  );
  const plan = await assembler.assemble({ readAt: RELEASE_READ_AT });
  assert.deepEqual(plan, {
    classification: "blocked",
    reason: "MIXED_CALCULATION_VERSIONS",
    blockedProductKey: snapshot.products[0]!.productKey,
  });
});

test("promotion eligibility must be calculated and evaluated at the exact assembly clock", async () => {
  const snapshot = buildReleaseSnapshot([buildReleaseProduct({ publicRepackId: REPACK_A })]);
  const { projection } = buildUnavailableEligibility("BUYBACK_UNAVAILABLE");
  const mismatchedAt = new Date(Date.parse(RELEASE_READ_AT) - 1).toISOString();
  for (const clock of ["evaluatedAt", "calculatedAt"] as const) {
    const assembler = new DataReleaseV3ReleaseAssembler(catalogPort(snapshot), {
      async getPublicationEligibleRevision() {
        return {
          calculationSource: "promotion",
          projection: { ...projection, calculatedAt: clock === "calculatedAt" ? mismatchedAt : RELEASE_READ_AT },
          evaluatedAt: clock === "evaluatedAt" ? mismatchedAt : RELEASE_READ_AT,
          readState: { state: "publishable", availability: "UNAVAILABLE" },
        };
      },
    });
    assert.deepEqual(await assembler.assemble({ readAt: RELEASE_READ_AT }), {
      classification: "blocked",
      reason: "CANONICAL_SNAPSHOT_INVALID",
      blockedProductKey: snapshot.products[0]!.productKey,
    });
  }
});

test("an undocumented buyback can never carry a current estimate", async () => {
  const snapshot = buildReleaseSnapshot([
    buildReleaseProduct({
      publicRepackId: REPACK_A,
      buyback: { kind: "not_documented" },
    }),
  ]);
  const assembler = new DataReleaseV3ReleaseAssembler(
    catalogPort(snapshot),
    eligibilityPort(
      new Map([[snapshot.products[0]!.productKey, buildPublishableEligibility()]]),
    ),
  );
  const plan = await assembler.assemble({ readAt: RELEASE_READ_AT });
  assert.deepEqual(plan, {
    classification: "blocked",
    reason: "PUBLIC_CONTRACT_INVALID",
    blockedProductKey: snapshot.products[0]!.productKey,
  });
});

test("an incoherent sold-out freeze blocks instead of degrading", async () => {
  const snapshot = buildReleaseSnapshot([
    buildReleaseProduct({
      publicRepackId: REPACK_A,
      availability: "sold_out",
      soldOutAt: null,
      actionAvailability: { promo: true, repackLink: false },
      actions: { promo: { code: "SCOUT", label: "Use SCOUT" } },
    }),
  ]);
  const assembler = new DataReleaseV3ReleaseAssembler(
    catalogPort(snapshot),
    eligibilityPort(
      new Map([[snapshot.products[0]!.productKey, buildPublishableEligibility()]]),
    ),
  );
  const plan = await assembler.assemble({ readAt: RELEASE_READ_AT });
  assert.deepEqual(plan, {
    classification: "blocked",
    reason: "SOLD_OUT_FREEZE_INCOHERENT",
    blockedProductKey: snapshot.products[0]!.productKey,
  });
});

test("protected or raw provider fields block the release", async () => {
  const base = buildReleaseSnapshot([
    buildReleaseProduct({ publicRepackId: REPACK_A }),
  ]);
  const snapshot: DataReleaseV3CanonicalSnapshot = {
    ...base,
    collectibles: [
      {
        ...base.collectibles[0]!,
        rawPayload: "leak",
      } as unknown as (typeof base.collectibles)[number],
    ],
  };
  const assembler = new DataReleaseV3ReleaseAssembler(
    catalogPort(snapshot),
    eligibilityPort(
      new Map([[base.products[0]!.productKey, buildPublishableEligibility()]]),
    ),
  );
  const plan = await assembler.assemble({ readAt: RELEASE_READ_AT });
  assert.equal(plan.classification, "blocked");
  if (plan.classification !== "blocked") return;
  assert.equal(plan.reason, "PROTECTED_PUBLICATION_FIELD");
});

test("capacity overruns block before any per-product work", async () => {
  const products = Array.from({ length: 1_001 }, (_, index) =>
    buildReleaseProduct({
      publicRepackId: `00000000-0000-5000-8000-${String(index).padStart(12, "0")}`,
    }),
  );
  const assembler = new DataReleaseV3ReleaseAssembler(
    catalogPort(buildReleaseSnapshot(products)),
    eligibilityPort(new Map()),
  );
  const plan = await assembler.assemble({ readAt: RELEASE_READ_AT });
  assert.equal(plan.classification, "blocked");
  if (plan.classification !== "blocked") return;
  assert.equal(plan.reason, "CAPACITY_EXCEEDED");
});
