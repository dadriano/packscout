import type { PublicRepackDetailV3, PublicRepackViewDetailV3 } from "@packscout/contracts";
import type { TestConvex } from "convex-test";
import { api, internal } from "./_generated/api";
import type schema from "./schema";
import {
  buildV3Detail, buildV3FixturePlan, buildV3UnavailableEv, v3ActivateRequest,
  v3BatchRequest, v3Body, v3FinalizeRequest, v3StartRequest, V3_FIXTURE_NOW,
  V3_REPACK_ID_A, type V3FixturePlan,
} from "./dataReleaseV3Fixture.test-support";

export type RetentionTest = TestConvex<typeof schema>;
export const retentionReleaseId = (number: number) =>
  `10000000-0000-4000-8000-${number.toString().padStart(12, "0")}`;

export function unavailableRetentionDetail(overrides: Partial<PublicRepackDetailV3> = {}) {
  const base = buildV3Detail();
  return buildV3Detail({ ...overrides, evEstimates: {
    ...base.evEstimates, packScout: buildV3UnavailableEv("SOURCE_EVIDENCE_UNAVAILABLE"),
  } });
}

export async function stageRetentionRelease(t: RetentionTest, number: number,
  details: readonly PublicRepackDetailV3[]): Promise<V3FixturePlan> {
  const plan = await buildV3FixturePlan({ publicReleaseId: retentionReleaseId(number), details });
  await t.mutation(internal.dataReleaseV3Lifecycle.start, await v3Body(v3StartRequest(plan)));
  for (const batch of plan.batches) {
    await t.mutation(internal.dataReleaseV3Lifecycle.applyBatch, await v3Body(v3BatchRequest(plan, batch)));
  }
  await t.mutation(internal.dataReleaseV3Lifecycle.finalize, await v3Body(v3FinalizeRequest(plan)));
  return plan;
}

export async function activateRetentionRelease(t: RetentionTest, plan: V3FixturePlan,
  previous: number | null): Promise<void> {
  await t.mutation(internal.dataReleaseV3Lifecycle.activate,
    await v3Body(v3ActivateRequest(plan, previous === null ? null : retentionReleaseId(previous))));
}

export async function readRetentionDetail(t: RetentionTest, release: number,
  currentTime = V3_FIXTURE_NOW, publicRepackId = V3_REPACK_ID_A): Promise<PublicRepackViewDetailV3> {
  const result = await t.query(internal.publicRepacksV3.getPublicRepackV3AtTime, {
    publicReleaseId: retentionReleaseId(release), publicRepackId, currentTime,
  }) as { ok: boolean; data?: PublicRepackViewDetailV3 };
  if (!result.ok || result.data === undefined) throw new Error("expected public detail");
  return result.data;
}

/** Simulates a pre-retention deployment, never changes immutable publications. */
export async function removeDerivedRetentionForLegacyTest(t: RetentionTest): Promise<void> {
  await t.run(async (ctx) => {
    for (const release of await ctx.db.query("dataReleaseV3Releases").collect()) {
      await ctx.db.patch("dataReleaseV3Releases", release._id, { evFactsRequired: undefined });
    }
    for (const set of await ctx.db.query("dataReleaseV3EvFactSets").collect()) {
      await ctx.db.patch("dataReleaseV3EvFactSets", set._id, { source: "backfill" });
    }
    for (const table of ["dataReleaseV3RetainedEv", "dataReleaseV3EvRetentionChanges",
      "dataReleaseV3EvRetentionTransitions"] as const) {
      for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(table, row._id);
    }
    const pointer = await ctx.db.query("activeDataReleaseV3State").unique();
    if (pointer === null) throw new Error("expected active pointer");
    await ctx.db.patch("activeDataReleaseV3State", pointer._id, {
      retainedEvTransitionId: undefined, retainedEvTransitionDirection: undefined,
    });
  });
}
