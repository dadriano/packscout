/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import schema from "./schema";
import { sha256CanonicalJson } from "./dataReleaseCanonicalHash";
import { DATA_RELEASE_V3_BATCH_HASH_DOMAIN } from "./dataReleaseV3Lifecycle";
import {
  buildV3Detail,
  buildV3FixturePlan,
  buildV3SoldOutDetail,
  buildV3UnavailableEv,
  v3ActivateRequest,
  v3BatchRequest,
  v3Body,
  v3FinalizeRequest,
  v3RollbackRequest,
  v3StartRequest,
  V3_REPACK_ID_A,
  V3_REPACK_ID_B,
  V3_REPACK_ID_C,
  type V3FixturePlan,
} from "./dataReleaseV3Fixture.test-support";

const modules = import.meta.glob("./**/*.ts");
type V3Test = TestConvex<typeof schema>;

const RELEASE_ID_1 = "10000000-0000-4000-8000-000000000001";
const RELEASE_ID_2 = "10000000-0000-4000-8000-000000000002";

async function run(
  t: V3Test,
  operation:
    | typeof internal.dataReleaseV3Lifecycle.start
    | typeof internal.dataReleaseV3Lifecycle.applyBatch
    | typeof internal.dataReleaseV3Lifecycle.finalize
    | typeof internal.dataReleaseV3Lifecycle.activate
    | typeof internal.dataReleaseV3Lifecycle.rollback,
  request: unknown,
): Promise<Record<string, unknown>> {
  return (await t.mutation(operation, await v3Body(request))) as unknown as Record<
    string,
    unknown
  >;
}

async function expectRefusal(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) => {
    if (!(error instanceof ConvexError)) return false;
    return (error.data as { code?: string }).code === code;
  });
}

async function stageComplete(t: V3Test, plan: V3FixturePlan): Promise<void> {
  await run(t, internal.dataReleaseV3Lifecycle.start, v3StartRequest(plan));
  for (const batch of plan.batches) {
    await run(
      t,
      internal.dataReleaseV3Lifecycle.applyBatch,
      v3BatchRequest(plan, batch),
    );
  }
  await run(t, internal.dataReleaseV3Lifecycle.finalize, v3FinalizeRequest(plan));
}

async function activate(
  t: V3Test,
  plan: V3FixturePlan,
  expectedActive: string | null,
): Promise<Record<string, unknown>> {
  return run(
    t,
    internal.dataReleaseV3Lifecycle.activate,
    v3ActivateRequest(plan, expectedActive),
  );
}

function threeRepackPlanDetails() {
  return [
    buildV3Detail({ publicRepackId: V3_REPACK_ID_A }),
    buildV3Detail({
      publicRepackId: V3_REPACK_ID_B,
      name: "Pokemon Value Gacha",
    }),
    buildV3SoldOutDetail({
      publicRepackId: V3_REPACK_ID_C,
      name: "Pokemon Vault Repack",
    }),
  ];
}

describe("data_release_v3 lifecycle", () => {
  test("stages, reconciles, completes, and activates one coherent release", async () => {
    const t = convexTest(schema, modules);
    const plan = await buildV3FixturePlan({
      publicReleaseId: RELEASE_ID_1,
      details: threeRepackPlanDetails(),
    });
    await stageComplete(t, plan);
    const status = (await t.query(internal.dataReleaseV3Lifecycle.status, {
      publicReleaseId: RELEASE_ID_1,
    })) as Record<string, unknown>;
    expect(status.lifecycle).toBe("complete");
    expect(status.acceptedCounts).toEqual(plan.manifest.counts);
    expect(status.acceptedBatchChainHash).toBe(plan.manifest.batchChainHash);
    expect(status.acceptedSearchRowCount).toBe(3);

    // Before activation nothing is publicly visible.
    const dormant = (await t.query(internal.dataReleaseV3Lifecycle.activeState, {})) as {
      activeRelease: unknown;
    };
    expect(dormant.activeRelease).toBeNull();

    const receipt = await activate(t, plan, null);
    expect(receipt.result).toBe("activated");
    const state = (await t.query(internal.dataReleaseV3Lifecycle.activeState, {})) as {
      generation: number;
      activeRelease: { publicReleaseId: string } | null;
      previousRelease: unknown;
    };
    expect(state.generation).toBe(1);
    expect(state.activeRelease?.publicReleaseId).toBe(RELEASE_ID_1);
    expect(state.previousRelease).toBeNull();
  });

  test("identical replay is unchanged and conflicting replay fails without moving state", async () => {
    const t = convexTest(schema, modules);
    const plan = await buildV3FixturePlan({
      publicReleaseId: RELEASE_ID_1,
      details: threeRepackPlanDetails(),
    });
    await stageComplete(t, plan);
    await activate(t, plan, null);

    // Byte-identical replays return the stored receipts without new writes.
    const startReplay = await run(
      t,
      internal.dataReleaseV3Lifecycle.start,
      v3StartRequest(plan),
    );
    expect(startReplay.result).toBe("started");
    const batchReplay = await run(
      t,
      internal.dataReleaseV3Lifecycle.applyBatch,
      v3BatchRequest(plan, plan.batches[0]!),
    );
    expect(batchReplay.result).toBe("accepted");
    const finalizeReplay = await run(
      t,
      internal.dataReleaseV3Lifecycle.finalize,
      v3FinalizeRequest(plan),
    );
    expect(finalizeReplay.result).toBe("complete");

    // A conflicting replay of the same operation id fails closed.
    const conflicting = {
      ...v3FinalizeRequest(plan),
      expectedTopChaseCount: plan.manifest.topChaseCount + 1,
    };
    await expectRefusal(
      run(t, internal.dataReleaseV3Lifecycle.finalize, conflicting),
      "PUBLICATION_OPERATION_CONFLICT",
    );
    // A different manifest under the same release identity fails closed.
    const tamperedStart = {
      ...v3StartRequest(plan),
      operationId: `${plan.publicReleaseId}:start:retry`,
      idempotencyKey: `${plan.publicReleaseId}:start:retry`,
      releaseFingerprint: "0".repeat(64),
    };
    await expectRefusal(
      run(t, internal.dataReleaseV3Lifecycle.start, tamperedStart),
      "PUBLICATION_MANIFEST_MISMATCH",
    );
    const state = (await t.query(internal.dataReleaseV3Lifecycle.activeState, {})) as {
      generation: number;
      activeRelease: { publicReleaseId: string } | null;
    };
    expect(state.generation).toBe(1);
    expect(state.activeRelease?.publicReleaseId).toBe(RELEASE_ID_1);
  });

  test("tampered batches, counts, references, versions, and protected fields fail closed", async () => {
    const t = convexTest(schema, modules);
    const plan = await buildV3FixturePlan({
      publicReleaseId: RELEASE_ID_1,
      details: threeRepackPlanDetails(),
    });
    await run(t, internal.dataReleaseV3Lifecycle.start, v3StartRequest(plan));

    // Tampered records under the declared batch hash.
    const categoriesBatch = plan.batches[0]!;
    await expectRefusal(
      run(t, internal.dataReleaseV3Lifecycle.applyBatch, {
        ...v3BatchRequest(plan, categoriesBatch),
        records: [
          { ...(categoriesBatch.records[0] as Record<string, unknown>), name: "Tampered" },
        ],
      }),
      "PUBLICATION_BATCH_CONFLICT",
    );
    // Out-of-order batch index.
    await expectRefusal(
      run(t, internal.dataReleaseV3Lifecycle.applyBatch, {
        ...v3BatchRequest(plan, plan.batches[1]!),
      }),
      "PUBLICATION_BATCH_OUT_OF_ORDER",
    );
    // Protected fields are rejected before anything is staged.
    await expectRefusal(
      run(t, internal.dataReleaseV3Lifecycle.applyBatch, {
        ...v3BatchRequest(plan, categoriesBatch),
        records: [
          {
            ...(categoriesBatch.records[0] as Record<string, unknown>),
            rawPayload: "protected",
          },
        ],
      }),
      "PUBLICATION_PROTECTED_FIELD",
    );
    // The revision-layer spellings of the protected underlying-outcome EV
    // values are refused as protected fields, not as generic parse failures.
    for (const protectedSpelling of [
      { underlyingOutcomeEvMinorUnits: 10_000 },
      { drawMultiplier: 1 },
    ]) {
      await expectRefusal(
        run(t, internal.dataReleaseV3Lifecycle.applyBatch, {
          ...v3BatchRequest(plan, categoriesBatch),
          records: [
            {
              ...(categoriesBatch.records[0] as Record<string, unknown>),
              ...protectedSpelling,
            },
          ],
        }),
        "PUBLICATION_PROTECTED_FIELD",
      );
    }

    // Stage everything, then finalize against tampered expectations.
    for (const batch of plan.batches) {
      await run(
        t,
        internal.dataReleaseV3Lifecycle.applyBatch,
        v3BatchRequest(plan, batch),
      );
    }
    await expectRefusal(
      run(t, internal.dataReleaseV3Lifecycle.finalize, {
        ...v3FinalizeRequest(plan),
        operationId: `${plan.publicReleaseId}:finalize:tampered`,
        idempotencyKey: `${plan.publicReleaseId}:finalize:tampered`,
        expectedCounts: {
          ...plan.manifest.counts,
          repacks: plan.manifest.counts.repacks + 1,
          searchShards: plan.manifest.counts.searchShards,
        },
      }),
      "PUBLICATION_RECONCILIATION_FAILED",
    );
    await expectRefusal(
      run(t, internal.dataReleaseV3Lifecycle.finalize, {
        ...v3FinalizeRequest(plan),
        operationId: `${plan.publicReleaseId}:finalize:tampered2`,
        idempotencyKey: `${plan.publicReleaseId}:finalize:tampered2`,
        expectedBatchChainHash: "1".repeat(64),
      }),
      "PUBLICATION_RECONCILIATION_FAILED",
    );
    // An incomplete release can never activate.
    await expectRefusal(
      activate(t, plan, null),
      "PUBLICATION_STATE_CONFLICT",
    );
  });

  test("a chase referencing an unstaged repack or divergent top chase fails closed", async () => {
    const t = convexTest(schema, modules);
    const detailA = buildV3Detail({ publicRepackId: V3_REPACK_ID_A });
    const plan = await buildV3FixturePlan({
      publicReleaseId: RELEASE_ID_1,
      details: [detailA],
    });
    await run(t, internal.dataReleaseV3Lifecycle.start, v3StartRequest(plan));
    for (const batch of plan.batches.filter(({ kind }) => kind !== "chases")) {
      await run(
        t,
        internal.dataReleaseV3Lifecycle.applyBatch,
        v3BatchRequest(plan, batch),
      );
    }
    const chasesBatch = plan.batches.find(({ kind }) => kind === "chases")!;
    const chase = chasesBatch.records[0] as Record<string, unknown>;
    // A tampered batch under its original declared hash is a batch conflict.
    await expectRefusal(
      run(t, internal.dataReleaseV3Lifecycle.applyBatch, {
        ...v3BatchRequest(plan, chasesBatch),
        records: [{ ...chase, probabilityBasisPoints: 75 }],
      }),
      "PUBLICATION_BATCH_CONFLICT",
    );
    // Honestly hashed batches still fail closed on invalid references.
    const rehashedBatch = async (records: readonly unknown[]) => ({
      ...v3BatchRequest(plan, chasesBatch),
      records,
      batchHash: await sha256CanonicalJson(DATA_RELEASE_V3_BATCH_HASH_DOMAIN, {
        kind: "chases",
        records,
      }),
    });
    await expectRefusal(
      run(
        t,
        internal.dataReleaseV3Lifecycle.applyBatch,
        await rehashedBatch([{ ...chase, publicRepackId: V3_REPACK_ID_B }]),
      ),
      "PUBLICATION_REFERENCE_INVALID",
    );
    await expectRefusal(
      run(
        t,
        internal.dataReleaseV3Lifecycle.applyBatch,
        await rehashedBatch([{ ...chase, probabilityBasisPoints: 75 }]),
      ),
      "PUBLICATION_REFERENCE_INVALID",
    );
  });

  test("a mixed-method or malformed estimate never enters a release", async () => {
    const t = convexTest(schema, modules);
    const detail = buildV3Detail({ publicRepackId: V3_REPACK_ID_A });
    const plan = await buildV3FixturePlan({
      publicReleaseId: RELEASE_ID_1,
      details: [detail],
    });
    await run(t, internal.dataReleaseV3Lifecycle.start, v3StartRequest(plan));
    for (const batch of plan.batches.filter(({ kind }) => kind !== "repacks")) {
      if (batch.kind === "chases") continue;
      await run(
        t,
        internal.dataReleaseV3Lifecycle.applyBatch,
        v3BatchRequest(plan, batch),
      );
    }
    const repackBatch = plan.batches.find(({ kind }) => kind === "repacks")!;
    const packScout = detail.evEstimates.packScout;
    if (packScout.status !== "current") throw new Error("unexpected fixture");
    // Tampered arithmetic fails the strict entity schema.
    await expectRefusal(
      run(t, internal.dataReleaseV3Lifecycle.applyBatch, {
        ...v3BatchRequest(plan, repackBatch),
        records: [
          {
            ...detail,
            evEstimates: {
              ...detail.evEstimates,
              packScout: {
                ...packScout,
                metrics: {
                  ...packScout.metrics,
                  evDollars: {
                    ...packScout.metrics.evDollars,
                    minorUnits: packScout.metrics.evDollars.minorUnits + 1,
                  },
                },
              },
            },
          },
        ],
      }),
      "PUBLICATION_REQUEST_INVALID",
    );
    // A foreign method version fails the strict entity schema.
    await expectRefusal(
      run(t, internal.dataReleaseV3Lifecycle.applyBatch, {
        ...v3BatchRequest(plan, repackBatch),
        records: [
          {
            ...detail,
            evEstimates: {
              ...detail.evEstimates,
              packScout: { ...packScout, methodVersion: "estimated-ev-v2" },
            },
          },
        ],
      }),
      "PUBLICATION_REQUEST_INVALID",
    );
  });

  test("activation refuses a dataAsOf regression unless explicitly overridden", async () => {
    const t = convexTest(schema, modules);
    const newerPlan = await buildV3FixturePlan({
      publicReleaseId: RELEASE_ID_1,
      details: threeRepackPlanDetails(),
    });
    const olderPlan = await buildV3FixturePlan({
      publicReleaseId: RELEASE_ID_2,
      dataAsOf: new Date(
        Date.parse(newerPlan.manifest.dataAsOf) - 10 * 60_000,
      ).toISOString(),
      details: threeRepackPlanDetails(),
    });
    await stageComplete(t, newerPlan);
    await stageComplete(t, olderPlan);
    await activate(t, newerPlan, null);

    // Replaying the older complete plan against the matching predecessor can
    // never move the public catalog backward in time.
    await expectRefusal(
      activate(t, olderPlan, RELEASE_ID_1),
      "PUBLICATION_DATA_REGRESSION",
    );
    const unchanged = (await t.query(internal.dataReleaseV3Lifecycle.activeState, {})) as {
      generation: number;
      activeRelease: { publicReleaseId: string } | null;
    };
    expect(unchanged.generation).toBe(1);
    expect(unchanged.activeRelease?.publicReleaseId).toBe(RELEASE_ID_1);

    // The documented operator override rolls forward to older data on purpose.
    const overridden = await run(t, internal.dataReleaseV3Lifecycle.activate, {
      ...v3ActivateRequest(olderPlan, RELEASE_ID_1),
      operationId: `${olderPlan.publicReleaseId}:activate:${RELEASE_ID_1}:override`,
      idempotencyKey: `${olderPlan.publicReleaseId}:activate:${RELEASE_ID_1}:override`,
      allowDataAsOfRegression: true,
    });
    expect(overridden.result).toBe("activated");
    const afterOverride = (await t.query(internal.dataReleaseV3Lifecycle.activeState, {})) as {
      generation: number;
      activeRelease: { publicReleaseId: string } | null;
      previousRelease: { publicReleaseId: string } | null;
    };
    expect(afterOverride.generation).toBe(2);
    expect(afterOverride.activeRelease?.publicReleaseId).toBe(RELEASE_ID_2);
    expect(afterOverride.previousRelease?.publicReleaseId).toBe(RELEASE_ID_1);

    // The sanctioned rollback path stays intact regardless of watermarks.
    await run(
      t,
      internal.dataReleaseV3Lifecycle.rollback,
      v3RollbackRequest(RELEASE_ID_2, RELEASE_ID_1),
    );
    const rolledBack = (await t.query(internal.dataReleaseV3Lifecycle.activeState, {})) as {
      activeRelease: { publicReleaseId: string } | null;
    };
    expect(rolledBack.activeRelease?.publicReleaseId).toBe(RELEASE_ID_1);
  });

  test("activation retains the previous release and rollback restores it exactly", async () => {
    const t = convexTest(schema, modules);
    const planOne = await buildV3FixturePlan({
      publicReleaseId: RELEASE_ID_1,
      details: threeRepackPlanDetails(),
    });
    await stageComplete(t, planOne);
    await activate(t, planOne, null);

    const planTwo = await buildV3FixturePlan({
      publicReleaseId: RELEASE_ID_2,
      details: [
        buildV3Detail({
          publicRepackId: V3_REPACK_ID_A,
          evEstimates: {
            packScout: buildV3UnavailableEv(),
            vendorReported: {
              status: "unavailable",
              sourceMoney: null,
              usdComparison: null,
              observedAt: null,
              reason: "NOT_REPORTED",
            },
          },
          buyback: { kind: "not_documented" },
        }),
      ],
    });
    await stageComplete(t, planTwo);

    // Activation with a stale predecessor expectation fails closed.
    await expectRefusal(
      activate(t, planTwo, null),
      "PUBLICATION_PREDECESSOR_CONFLICT",
    );
    await activate(t, planTwo, RELEASE_ID_1);
    const afterSwap = (await t.query(internal.dataReleaseV3Lifecycle.activeState, {})) as {
      generation: number;
      activeRelease: { publicReleaseId: string } | null;
      previousRelease: { publicReleaseId: string } | null;
    };
    expect(afterSwap.generation).toBe(2);
    expect(afterSwap.activeRelease?.publicReleaseId).toBe(RELEASE_ID_2);
    expect(afterSwap.previousRelease?.publicReleaseId).toBe(RELEASE_ID_1);

    // Rollback to anything but the retained previous release is unsafe.
    await expectRefusal(
      run(
        t,
        internal.dataReleaseV3Lifecycle.rollback,
        v3RollbackRequest(RELEASE_ID_2, RELEASE_ID_2),
      ),
      "PUBLICATION_ROLLBACK_UNSAFE",
    );
    await run(
      t,
      internal.dataReleaseV3Lifecycle.rollback,
      v3RollbackRequest(RELEASE_ID_2, RELEASE_ID_1),
    );
    const rolledBack = (await t.query(internal.dataReleaseV3Lifecycle.activeState, {})) as {
      generation: number;
      activeRelease: { publicReleaseId: string } | null;
      previousRelease: { publicReleaseId: string } | null;
    };
    expect(rolledBack.generation).toBe(3);
    expect(rolledBack.activeRelease?.publicReleaseId).toBe(RELEASE_ID_1);
    expect(rolledBack.previousRelease?.publicReleaseId).toBe(RELEASE_ID_2);
  });
});
