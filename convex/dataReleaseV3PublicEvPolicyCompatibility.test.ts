/// <reference types="vite/client" />

import { PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3 } from "@packscout/contracts";
import { convexTest, type TestConvex } from "convex-test";
import { ConvexError } from "convex/values";
import { expect, test } from "vitest";
import { api, internal } from "./_generated/api";
import schema from "./schema";
import {
  buildV3Detail,
  buildV3FixturePlan,
  v3ActivateRequest,
  v3BatchRequest,
  v3Body,
  v3FinalizeRequest,
  v3RollbackRequest,
  v3StartRequest,
  V3_REPACK_ID_A,
  type V3FixturePlan,
} from "./dataReleaseV3Fixture.test-support";

const modules = import.meta.glob("./**/*.ts");
type V3Test = TestConvex<typeof schema>;

const LEGACY_RELEASE_ID = "10000000-0000-4000-8000-000000000001";
const CURRENT_RELEASE_ID = "10000000-0000-4000-8000-000000000002";

async function stageComplete(t: V3Test, plan: V3FixturePlan): Promise<void> {
  await t.mutation(
    internal.dataReleaseV3Lifecycle.start,
    await v3Body(v3StartRequest(plan)),
  );
  for (const batch of plan.batches) {
    await t.mutation(
      internal.dataReleaseV3Lifecycle.applyBatch,
      await v3Body(v3BatchRequest(plan, batch)),
    );
  }
  await t.mutation(
    internal.dataReleaseV3Lifecycle.finalize,
    await v3Body(v3FinalizeRequest(plan)),
  );
}

async function expectRefusal(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) =>
    error instanceof ConvexError &&
    (error.data as { code?: string }).code === code
  );
}

test("legacy policy-marker omissions deploy safely, fail closed, and can be superseded", async () => {
  const t = convexTest(schema, modules);
  const legacyPlan = await buildV3FixturePlan({
    publicReleaseId: LEGACY_RELEASE_ID,
    details: [buildV3Detail({ publicRepackId: V3_REPACK_ID_A })],
  });
  await stageComplete(t, legacyPlan);
  await t.mutation(
    internal.dataReleaseV3Lifecycle.activate,
    await v3Body(v3ActivateRequest(legacyPlan, null)),
  );

  // Both replacements are validated against the current Convex schema. They
  // reproduce the retained document shapes that an introducing deploy sees.
  await t.run(async (ctx) => {
    const release = await ctx.db
      .query("dataReleaseV3Releases")
      .withIndex("by_public_release_id", (index) =>
        index.eq("publicReleaseId", LEGACY_RELEASE_ID),
      )
      .unique();
    const state = await ctx.db
      .query("activeDataReleaseV3State")
      .withIndex("by_key", (index) => index.eq("key", "singleton"))
      .unique();
    expect(release).not.toBeNull();
    expect(state?.activeRelease).not.toBeNull();
    const {
      _id: releaseId,
      _creationTime: _ignoredReleaseCreationTime,
      publicEvPolicyVersion: _ignoredReleasePolicy,
      ...legacyRelease
    } = release!;
    const {
      _id: stateId,
      _creationTime: _ignoredStateCreationTime,
      activeRelease,
      ...stateFields
    } = state!;
    const {
      publicEvPolicyVersion: _ignoredPointerPolicy,
      ...legacyPointer
    } = activeRelease!;
    await ctx.db.replace("dataReleaseV3Releases", releaseId, legacyRelease);
    await ctx.db.replace("activeDataReleaseV3State", stateId, {
      ...stateFields,
      activeRelease: legacyPointer,
    });
  });

  const unavailable = await t.query(
    internal.publicRepacksV3.getPublicShellStatusV3AtTime,
    { currentTime: Date.now() },
  );
  expect(unavailable).toMatchObject({
    ok: false,
    code: "RELEASE_UNAVAILABLE",
  });

  const currentPlan = await buildV3FixturePlan({
    publicReleaseId: CURRENT_RELEASE_ID,
    details: [buildV3Detail({ publicRepackId: V3_REPACK_ID_A })],
  });
  await stageComplete(t, currentPlan);
  await t.mutation(
    internal.dataReleaseV3Lifecycle.activate,
    await v3Body(v3ActivateRequest(currentPlan, LEGACY_RELEASE_ID)),
  );

  const state = await t.query(internal.dataReleaseV3Lifecycle.activeState, {});
  expect(state.activeRelease).toMatchObject({
    publicReleaseId: CURRENT_RELEASE_ID,
    publicEvPolicyVersion: PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
  });
  expect(state.previousRelease?.publicReleaseId).toBe(LEGACY_RELEASE_ID);
  expect(state.previousRelease?.publicEvPolicyVersion).toBeUndefined();
  const publicStatus = await t.query(
    internal.publicRepacksV3.getPublicShellStatusV3AtTime,
    { currentTime: Date.now() },
  );
  expect(publicStatus).toMatchObject({
    ok: true,
    data: { release: { publicReleaseId: CURRENT_RELEASE_ID } },
  });

  await expectRefusal(
    t.mutation(
      internal.dataReleaseV3Lifecycle.rollback,
      await v3Body(v3RollbackRequest(CURRENT_RELEASE_ID, LEGACY_RELEASE_ID)),
    ),
    "PUBLICATION_ROLLBACK_UNSAFE",
  );
});
