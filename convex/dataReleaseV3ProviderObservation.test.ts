/// <reference types="vite/client" />

import { convexTest, type TestConvex } from "convex-test";
import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import { internal } from "./_generated/api";
import {
  buildV3Detail,
  buildV3FixturePlan,
  v3ActivateRequest,
  v3BatchRequest,
  v3Body,
  v3FinalizeRequest,
  v3StartRequest,
  V3_REPACK_ID_A,
  V3_VENDOR_ID,
  type V3FixturePlan,
} from "./dataReleaseV3Fixture.test-support";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
type V3Test = TestConvex<typeof schema>;

const RELEASE_ID = "10000000-0000-4000-8000-000000000091";

async function publishActiveRelease(t: V3Test): Promise<V3FixturePlan> {
  const plan = await buildV3FixturePlan({
    publicReleaseId: RELEASE_ID,
    details: [buildV3Detail({ publicRepackId: V3_REPACK_ID_A })],
  });
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
  await t.mutation(
    internal.dataReleaseV3Lifecycle.activate,
    await v3Body(v3ActivateRequest(plan, null)),
  );
  return plan;
}

function observationRequest(
  plan: V3FixturePlan,
  input: Readonly<{
    sequence?: number;
    operationSuffix?: string;
    sourceHeadSequence?: string;
    settledSequence?: string;
    sourceLifecycle?: "active" | "paused" | "disabled";
  }> = {},
) {
  const sequence = input.sequence ?? 1;
  const suffix = input.operationSuffix ?? String(sequence);
  const observedAtMilliseconds = Date.now() - 1_000 + sequence;
  const observedAt = new Date(observedAtMilliseconds).toISOString();
  return {
    schemaVersion: "data_release_v3" as const,
    operationId: `${plan.publicReleaseId}:provider-observation:${suffix}`,
    idempotencyKey: `${plan.publicReleaseId}:provider-observation:${suffix}`,
    publicReleaseId: plan.publicReleaseId,
    releaseFingerprint: plan.releaseFingerprint,
    publicVendorId: V3_VENDOR_ID,
    vendorKey: "collector_example",
    observationSequence: sequence,
    observedAt,
    freshThrough: new Date(
      observedAtMilliseconds + 15 * 60_000,
    ).toISOString(),
    lastHeadReachedAt: observedAt,
    sourceHeadSequence: input.sourceHeadSequence ?? "100",
    settledSequence: input.settledSequence ?? "100",
    sourceLifecycle: input.sourceLifecycle ?? ("active" as const),
    connectionState: "healthy" as const,
    qualityState: "healthy" as const,
    releaseAlignment: "aligned" as const,
  };
}

async function refresh(t: V3Test, request: unknown) {
  return await t.mutation(
    internal.dataReleaseV3ProviderObservation.refresh,
    await v3Body(request),
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

describe("data_release_v3 provider observations", () => {
  test("stores a standard V3 receipt and replays the exact operation idempotently", async () => {
    const t = convexTest(schema, modules);
    const plan = await publishActiveRelease(t);
    const request = observationRequest(plan);
    const first = await refresh(t, request);
    const replay = await refresh(t, request);

    expect(first).toMatchObject({
      schemaVersion: "data_release_v3",
      operationKind: "refreshProviderObservation",
      operationId: request.operationId,
      idempotencyKey: request.idempotencyKey,
      publicReleaseId: plan.publicReleaseId,
      result: "provider_observation_created",
      details: {
        publicVendorId: V3_VENDOR_ID,
        vendorKey: "collector_example",
        observationSequence: 1,
        observedAt: request.observedAt,
        freshThrough: request.freshThrough,
      },
    });
    expect(replay).toEqual(first);
    await t.run(async (ctx) => {
      expect(
        await ctx.db.query("dataReleaseV3ProviderObservations").collect(),
      ).toHaveLength(1);
      expect(
        (
          await ctx.db
            .query("dataReleaseV3Operations")
            .filter((query) =>
              query.eq(query.field("kind"), "refreshProviderObservation"),
            )
            .collect()
        ),
      ).toHaveLength(1);
    });
  });

  test("advances monotonically and rejects conflicting or regressing observations", async () => {
    const t = convexTest(schema, modules);
    const plan = await publishActiveRelease(t);
    const initial = observationRequest(plan);
    await refresh(t, initial);

    await expectRefusal(
      refresh(t, {
        ...initial,
        operationId: `${plan.publicReleaseId}:provider-observation:conflict`,
        idempotencyKey: `${plan.publicReleaseId}:provider-observation:conflict`,
        sourceLifecycle: "paused",
      }),
      "PUBLICATION_OPERATION_CONFLICT",
    );
    await expectRefusal(
      refresh(t, observationRequest(plan, {
        sequence: 2,
        operationSuffix: "regression",
        sourceHeadSequence: "99",
        settledSequence: "99",
      })),
      "PUBLICATION_REFRESH_STALE",
    );

    const advanced = observationRequest(plan, {
      sequence: 2,
      operationSuffix: "advance",
      sourceHeadSequence: "101",
      settledSequence: "101",
    });
    await expect(refresh(t, advanced)).resolves.toMatchObject({
      result: "provider_observation_updated",
      details: { observationSequence: 2 },
    });
  });

  test("binds refreshes to the exact active release and vendor", async () => {
    const t = convexTest(schema, modules);
    const plan = await publishActiveRelease(t);
    const request = observationRequest(plan);

    await expectRefusal(
      refresh(t, {
        ...request,
        publicReleaseId: "10000000-0000-4000-8000-000000000099",
      }),
      "PUBLICATION_PREDECESSOR_CONFLICT",
    );
    await expectRefusal(
      refresh(t, {
        ...request,
        operationId: `${plan.publicReleaseId}:provider-observation:vendor`,
        idempotencyKey: `${plan.publicReleaseId}:provider-observation:vendor`,
        publicVendorId: "00000000-0000-5000-8000-000000000099",
      }),
      "PUBLICATION_REFERENCE_INVALID",
    );
  });

  test("rejects a publisher observation timestamp ahead of the server clock", async () => {
    const t = convexTest(schema, modules);
    const plan = await publishActiveRelease(t);
    const request = observationRequest(plan);
    const futureObservedAt = Date.now() + 60_000;

    await expectRefusal(
      refresh(t, {
        ...request,
        observedAt: new Date(futureObservedAt).toISOString(),
        freshThrough: new Date(futureObservedAt + 15 * 60_000).toISOString(),
        lastHeadReachedAt: new Date(futureObservedAt).toISOString(),
      }),
      "PUBLICATION_REQUEST_INVALID",
    );
  });
});
