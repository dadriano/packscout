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
  test("start requires the exact public EV policy version", async () => {
    const t = convexTest(schema, modules);
    const plan = await buildV3FixturePlan({
      publicReleaseId: RELEASE_ID_1,
      details: [buildV3Detail({ publicRepackId: V3_REPACK_ID_A })],
    });
    const missing = structuredClone(v3StartRequest(plan)) as Record<
      string,
      unknown
    > & { manifest: Record<string, unknown> };
    delete missing.manifest.publicEvPolicyVersion;
    await expectRefusal(
      run(t, internal.dataReleaseV3Lifecycle.start, missing),
      "PUBLICATION_REQUEST_INVALID",
    );

    const wrong = structuredClone(v3StartRequest(plan)) as Record<
      string,
      unknown
    > & { manifest: Record<string, unknown> };
    wrong.manifest.publicEvPolicyVersion = "some-other-public-policy";
    await expectRefusal(
      run(t, internal.dataReleaseV3Lifecycle.start, wrong),
      "PUBLICATION_REQUEST_INVALID",
    );
  });

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

  test("a declared top chase with no staged chase row never completes or activates", async () => {
    const t = convexTest(schema, modules);
    const detail = buildV3Detail({ publicRepackId: V3_REPACK_ID_A });
    expect(detail.topChase).not.toBeNull();
    // A publisher whose manifest is internally consistent — counts, entity
    // chains, batch chain, content hash, and fingerprint all computed over
    // exactly the bytes it stages — but which never stages the chase row its
    // own repack detail advertises. Every per-batch guard passes: chases are
    // staged after repacks, so nothing at staging time can observe the gap.
    const plan = await buildV3FixturePlan({
      publicReleaseId: RELEASE_ID_1,
      details: [detail],
      chases: [],
    });
    expect(plan.manifest.topChaseCount).toBe(1);
    expect(plan.manifest.counts.chases).toBe(0);
    expect(plan.batches.some(({ kind }) => kind === "chases")).toBe(false);

    await run(t, internal.dataReleaseV3Lifecycle.start, v3StartRequest(plan));
    for (const batch of plan.batches) {
      const accepted = await run(
        t,
        internal.dataReleaseV3Lifecycle.applyBatch,
        v3BatchRequest(plan, batch),
      );
      expect(accepted.result).toBe("accepted");
    }

    // Reconciliation is the only place the inconsistency is visible, and it
    // must refuse: the release advertises one top chase and verified none.
    await expectRefusal(
      run(t, internal.dataReleaseV3Lifecycle.finalize, v3FinalizeRequest(plan)),
      "PUBLICATION_RECONCILIATION_FAILED",
    );
    const status = (await t.query(internal.dataReleaseV3Lifecycle.status, {
      publicReleaseId: RELEASE_ID_1,
    })) as Record<string, unknown>;
    expect(status.lifecycle).toBe("staging");
    expect(status.completedAt).toBeNull();

    // An unreconciled release can never become the public catalog.
    await expectRefusal(activate(t, plan, null), "PUBLICATION_STATE_CONFLICT");
    const state = (await t.query(
      internal.dataReleaseV3Lifecycle.activeState,
      {},
    )) as { activeRelease: unknown };
    expect(state.activeRelease).toBeNull();
  });

  test("a manifest that under-declares its own top chases never reconciles", async () => {
    const t = convexTest(schema, modules);
    // Coverage for the *pre-existing* manifest check, not the declared-vs-
    // verified guard: the publisher stages a repack detail advertising a top
    // chase but reports `topChaseCount: 0`, so the count the server derives
    // from the staged repack details (1) disagrees with both the manifest and
    // the finalize request (0) and `acceptedTopChaseCount ===
    // expectedTopChaseCount` refuses on its own. The verified counter never
    // gets a say here — with nothing staged it is 0 while declared is 1, but
    // finalize has already refused. The case that isolates the verified guard
    // is the preceding test, where the manifest is internally honest.
    const plan = await buildV3FixturePlan({
      publicReleaseId: RELEASE_ID_1,
      details: [buildV3Detail({ publicRepackId: V3_REPACK_ID_A })],
      chases: [],
      topChaseCount: 0,
    });
    expect(plan.manifest.topChaseCount).toBe(0);
    await run(t, internal.dataReleaseV3Lifecycle.start, v3StartRequest(plan));
    for (const batch of plan.batches) {
      await run(
        t,
        internal.dataReleaseV3Lifecycle.applyBatch,
        v3BatchRequest(plan, batch),
      );
    }
    await expectRefusal(
      run(t, internal.dataReleaseV3Lifecycle.finalize, v3FinalizeRequest(plan)),
      "PUBLICATION_RECONCILIATION_FAILED",
    );
    await expectRefusal(activate(t, plan, null), "PUBLICATION_STATE_CONFLICT");
  });

  // `dataReleaseV3Releases` is never deleted from — retention is what makes
  // rollback to the previous release possible — so documents written before
  // `acceptedVerifiedTopChaseCount` existed outlive the deploy that introduces
  // it, and `schemaValidation` (on by default) validates them at push time.
  // The field is therefore `v.optional`, and these two tests pin both halves of
  // that decision: that such a document is genuinely valid, and that reading
  // the absent value as 0 refuses rather than completes.
  describe("releases staged before the verified top-chase counter", () => {
    async function stageOneDeclaredTopChase(
      t: V3Test,
    ): Promise<V3FixturePlan> {
      const plan = await buildV3FixturePlan({
        publicReleaseId: RELEASE_ID_1,
        details: [buildV3Detail({ publicRepackId: V3_REPACK_ID_A })],
      });
      expect(plan.manifest.topChaseCount).toBe(1);
      await run(t, internal.dataReleaseV3Lifecycle.start, v3StartRequest(plan));
      for (const batch of plan.batches) {
        await run(
          t,
          internal.dataReleaseV3Lifecycle.applyBatch,
          v3BatchRequest(plan, batch),
        );
      }
      return plan;
    }

    test("a release document without the verified counter is a valid document", async () => {
      const t = convexTest(schema, modules);
      await stageOneDeclaredTopChase(t);
      // convex-test validates every write against `schema`, so this insert is
      // the deploy-safety proof itself: were the field required, writing a
      // document that omits it would throw here.
      const legacyId = await t.run(async (ctx) => {
        const staged = await ctx.db
          .query("dataReleaseV3Releases")
          .withIndex("by_public_release_id", (index) =>
            index.eq("publicReleaseId", RELEASE_ID_1),
          )
          .unique();
        expect(staged).not.toBeNull();
        const {
          _id: _ignoredId,
          _creationTime: _ignoredCreationTime,
          acceptedVerifiedTopChaseCount,
          ...withoutVerifiedCounter
        } = staged!;
        expect(acceptedVerifiedTopChaseCount).toBe(1);
        return await ctx.db.insert("dataReleaseV3Releases", {
          ...withoutVerifiedCounter,
          publicReleaseId: RELEASE_ID_2,
        });
      });
      const stored = await t.run(async (ctx) =>
        ctx.db.get("dataReleaseV3Releases", legacyId),
      );
      expect(stored).not.toBeNull();
      expect(stored!.acceptedVerifiedTopChaseCount).toBeUndefined();
      expect(stored!.acceptedTopChaseCount).toBe(1);
    });

    test("one that declared a top chase refuses at finalize instead of completing", async () => {
      const t = convexTest(schema, modules);
      const plan = await stageOneDeclaredTopChase(t);
      // Rewrite the staged release as one whose entire staging predates the
      // counter: declared 1, verified never recorded. Everything else about
      // the release is honest and would otherwise reconcile.
      await t.run(async (ctx) => {
        const staged = await ctx.db
          .query("dataReleaseV3Releases")
          .withIndex("by_public_release_id", (index) =>
            index.eq("publicReleaseId", RELEASE_ID_1),
          )
          .unique();
        const {
          _id,
          _creationTime: _ignoredCreationTime,
          acceptedVerifiedTopChaseCount: _ignoredVerified,
          ...withoutVerifiedCounter
        } = staged!;
        await ctx.db.replace(
          "dataReleaseV3Releases",
          _id,
          withoutVerifiedCounter,
        );
      });
      // Fail safe: the absent counter reads as 0, which cannot equal the
      // declared 1, so the release refuses rather than completing unverified.
      await expectRefusal(
        run(t, internal.dataReleaseV3Lifecycle.finalize, v3FinalizeRequest(plan)),
        "PUBLICATION_RECONCILIATION_FAILED",
      );
      const status = (await t.query(internal.dataReleaseV3Lifecycle.status, {
        publicReleaseId: RELEASE_ID_1,
      })) as Record<string, unknown>;
      expect(status.lifecycle).toBe("staging");
      expect(status.completedAt).toBeNull();
      // The status surface reports the declared counter, and OMITS the
      // verified one for a release staged before that counter existed. The
      // absence is the signal: a publisher's divergence checks are
      // presence-guarded, so reporting 0 here would be indistinguishable
      // from a server that genuinely verified zero and would wedge a
      // release completed before this deploy.
      expect(status.acceptedTopChaseCount).toBe(1);
      expect(status.acceptedVerifiedTopChaseCount).toBeUndefined();
      await expectRefusal(activate(t, plan, null), "PUBLICATION_STATE_CONFLICT");
    });

    test("one that declared no top chase still completes", async () => {
      const t = convexTest(schema, modules);
      const plan = await buildV3FixturePlan({
        publicReleaseId: RELEASE_ID_1,
        details: [
          buildV3Detail({ publicRepackId: V3_REPACK_ID_A, topChase: null }),
        ],
      });
      expect(plan.manifest.topChaseCount).toBe(0);
      await run(t, internal.dataReleaseV3Lifecycle.start, v3StartRequest(plan));
      for (const batch of plan.batches) {
        await run(
          t,
          internal.dataReleaseV3Lifecycle.applyBatch,
          v3BatchRequest(plan, batch),
        );
      }
      await t.run(async (ctx) => {
        const staged = await ctx.db
          .query("dataReleaseV3Releases")
          .withIndex("by_public_release_id", (index) =>
            index.eq("publicReleaseId", RELEASE_ID_1),
          )
          .unique();
        const {
          _id,
          _creationTime: _ignoredCreationTime,
          acceptedVerifiedTopChaseCount: _ignoredVerified,
          ...withoutVerifiedCounter
        } = staged!;
        await ctx.db.replace(
          "dataReleaseV3Releases",
          _id,
          withoutVerifiedCounter,
        );
      });
      // Reading the absent counter as 0 must not over-refuse: with nothing
      // declared there was nothing to verify, so the release still completes.
      const receipt = await run(
        t,
        internal.dataReleaseV3Lifecycle.finalize,
        v3FinalizeRequest(plan),
      );
      expect(receipt.result).toBe("complete");
    });
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
    // Internally coherent positive raw metrics are still forbidden at the
    // public release boundary.
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
                  grossEvMoney: { minorUnits: 12_000, currency: "USD" },
                  grossReturnBasisPoints: 12_000,
                  evDollars: { minorUnits: 2_000, currency: "USD" },
                  evPercentBasisPoints: 2_000,
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
