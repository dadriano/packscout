/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import { api } from "./_generated/api";
import { V3_FIXTURE_NOW } from "./dataReleaseV3Fixture.test-support";
import type { MutationCtx } from "./_generated/server";
import { buildV3Detail } from "./dataReleaseV3Fixture.test-support";
import {
  activateRetainedEv, assertRetainedEvTransitionBounds, MAX_RETAINED_EV_TRANSITION_BYTES,
  MAX_RETAINED_EV_TRANSITION_CHANGES, type RetainedEvValue,
} from "./dataReleaseV3RetainedEv";
import {
  activateRetentionRelease, removeDerivedRetentionForLegacyTest, stageRetentionRelease,
} from "./dataReleaseV3Retention.test-support";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");
const encodedBytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

/** Counts the real helper's DB calls while convex-test executes their writes. */
function measuredDb(ctx: MutationCtx) {
  const usage = { queries: 0, readDocuments: 0, readBytes: 0, writes: 0, writeBytes: 0,
    inFlight: 0, maxConcurrentIo: 0 };
  const readResult = (result: unknown) => {
    const rows = result === null ? [] : Array.isArray(result) ? result : [result];
    usage.readDocuments += rows.length;
    usage.readBytes += encodedBytes(rows);
    return result;
  };
  const read = async (operation: () => unknown) => {
    usage.inFlight += 1;
    usage.maxConcurrentIo = Math.max(usage.maxConcurrentIo, usage.inFlight);
    try { return readResult(await operation()); } finally { usage.inFlight -= 1; }
  };
  const query = (target: object): object => new Proxy(target, {
    get(object, property) {
      const member: unknown = Reflect.get(object, property, object);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => ["take", "unique", "first", "collect"].includes(String(property))
        ? read(() => Reflect.apply(member, object, args))
        : query(Reflect.apply(member, object, args) as object);
    },
  });
  const db = new Proxy(ctx.db, {
    get(object, property) {
      const member: unknown = Reflect.get(object, property, object);
      if (typeof member !== "function") return member;
      return (...args: unknown[]) => {
        if (property === "query") {
          usage.queries += 1;
          return query(Reflect.apply(member, object, args) as object);
        }
        if (property === "get") {
          usage.queries += 1;
          return read(() => Reflect.apply(member, object, args));
        }
        if (["insert", "patch", "replace", "delete"].includes(String(property))) {
          usage.writes += 1;
          // Conservative allowance for system fields added to each document.
          usage.writeBytes += encodedBytes(args.at(-1)) + 128;
        }
        return Reflect.apply(member, object, args);
      };
    },
  });
  return { db, usage };
}

describe("bounded EV retention transactions", () => {
  test("1000 prior and 1000 disjoint target packs fit the legacy seed transaction with bounded IO", async () => {
    const t = convexTest(schema, modules);
    const details = (start: number) => Array.from({ length: 1_000 }, (_, index) =>
      buildV3Detail({ publicRepackId: `00000000-0000-5000-8000-${(start + index).toString().padStart(12, "0")}` }));
    await activateRetentionRelease(t, await stageRetentionRelease(t, 1, details(10_000)), null);
    await removeDerivedRetentionForLegacyTest(t);
    await stageRetentionRelease(t, 2, details(20_000));
    const usage = await t.run(async (ctx) => {
      const releases = await ctx.db.query("dataReleaseV3Releases").collect();
      const measured = measuredDb(ctx);
      await activateRetainedEv({ ...ctx, db: measured.db }, {
        previousRelease: releases[0]!, nextRelease: releases[1]!, seedPrevious: true,
        operationId: "bounded-legacy-retention-test",
      });
      return measured.usage;
    });
    // The activation caller adds only the existing pointer/receipt writes and
    // a handful of exact lookups; reserve headroom below Convex's hard limits.
    expect(usage.queries).toBe(2_004);
    expect(usage.readDocuments).toBe(2_002);
    expect(usage.writes + 2).toBe(4_003);
    expect(usage.readBytes).toBeLessThan(12 * 1_024 * 1_024);
    expect(usage.writeBytes).toBeLessThan(12 * 1_024 * 1_024);
    expect(usage.maxConcurrentIo).toBeLessThanOrEqual(100);
    expect(await t.run(async (ctx) => (await ctx.db.query("dataReleaseV3RetainedEv").collect()).length)).toBe(2_000);
  }, 30_000);

  test("1000 full-size descriptions activate through compact EV facts and hydrate one selected detail", async () => {
    const t = convexTest(schema, modules);
    // Full descriptions exceed4MiB; they must never enter activation's EV read.
    const details = Array.from({ length: 1_000 }, (_, index) => buildV3Detail({
      publicRepackId: `00000000-0000-5000-8000-${(30_000 + index).toString().padStart(12, "0")}`,
      description: "x".repeat(4_000),
    }));
    const first = await stageRetentionRelease(t, 1, details);
    await activateRetentionRelease(t, first, null);
    const detail = await t.query(api.publicRepacksV3.getPublicRepackV3, {
      publicReleaseId: first.publicReleaseId, publicRepackId: details[0]!.publicRepackId,
      currentTime: V3_FIXTURE_NOW,
    }) as { ok: boolean; data: { description: string; evEstimates: { packScout: { status: string } } } };
    expect(detail.ok).toBe(true);
    expect(detail.data.description).toHaveLength(4_000);
    expect(detail.data.evEstimates.packScout.status).toBe("last_known");
  }, 30_000);

  test("journal count and encoded-byte budgets refuse overflow before writes", () => {
    const detail = buildV3Detail();
    const value: RetainedEvValue = { estimate: detail.evEstimates.packScout,
      calculationPriceUsdMinor: 10_000, sourcePublicReleaseId: "release",
      latestUnavailableAttempt: null };
    const change = { vendorKey: detail.vendorKey, publicVendorId: detail.publicVendorId,
      publicRepackId: detail.publicRepackId, before: value, after: value };
    expect(() => assertRetainedEvTransitionBounds(Array(MAX_RETAINED_EV_TRANSITION_CHANGES + 1).fill(change))).toThrow();
    expect(() => assertRetainedEvTransitionBounds([{ ...change,
      vendorKey: "x".repeat(MAX_RETAINED_EV_TRANSITION_BYTES) }])).toThrow();
  });
});
