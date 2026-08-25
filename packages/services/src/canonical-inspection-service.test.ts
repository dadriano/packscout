import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CANONICAL_COUNT_BOUND,
  CANONICAL_MAX_OFFSET,
  CANONICAL_PAGE_SIZE_MAX,
} from "@packscout/contracts";
import {
  CanonicalInspectionError,
  CanonicalInspectionService,
} from "./canonical-inspection-service.ts";
import { REDACTED } from "./inspection-redaction.ts";

const ORGANIZATION = "00000000-0000-4000-8000-000000000010";

/** An in-memory stand-in ordered exactly as the repository orders. */
function fakeRepository(options: {
  entities?: { externalId: string; entityId: string }[];
  providers?: string[];
  bucketSize?: number;
  failWith?: Error;
  captured?: { limit?: number; offset?: number; collectedExtrema?: boolean };
} = {}) {
  const entities = options.entities ?? [];
  const providers = options.providers ?? ["courtyard"];
  return {
    captured: options.captured ?? {},
    async listProviders() {
      if (options.failWith) throw options.failWith;
      return providers.map((platformKey) => ({
        platformKey,
        displayName: platformKey,
        state: "active",
      }));
    },
    async providerExists(input: { platformKey: string }) {
      if (options.failWith) throw options.failWith;
      return providers.includes(input.platformKey);
    },
    async countBounded(input: { bound: number }) {
      const total = options.bucketSize ?? entities.length;
      return total > input.bound
        ? { count: input.bound, bounded: true }
        : { count: total, bounded: false };
    },
    async kindRecency(input: { collectedExtrema: boolean }) {
      (options.captured ?? {}).collectedExtrema = input.collectedExtrema;
      // Mirrors the repository's real return shape, including the flag that
      // says whether the collection aggregate was affordable to run.
      return {
        oldestCollectedAt: input.collectedExtrema ? new Date("2026-01-01") : null,
        newestCollectedAt: input.collectedExtrema ? new Date("2026-08-01") : null,
        oldestAcceptedAt: new Date("2026-01-02"),
        newestAcceptedAt: new Date("2026-08-02"),
        collectedExtremaComplete: input.collectedExtrema,
      };
    },
    async listEntities(input: { limit: number; offset: number }) {
      (options.captured ?? {}).limit = input.limit;
      (options.captured ?? {}).offset = input.offset;
      const slice = entities.slice(input.offset, input.offset + input.limit);
      const more = input.offset + input.limit < entities.length;
      return {
        items: slice.map((entity) => ({
          entityId: entity.entityId,
          platformKey: "courtyard",
          recordKind: "pack" as const,
          externalId: entity.externalId,
          revisionNumber: 1,
          sourceUpdatedAt: null,
          sourceCollectedAt: null,
          acceptedAt: null,
        })),
        hasMore: more,
      };
    },
    async readEntity() {
      return {
        entityId: "e1",
        platformKey: "courtyard",
        recordKind: "pack" as const,
        externalId: "pack-1",
        revisionNumber: 3,
        sourceUpdatedAt: null,
        sourceCollectedAt: null,
        acceptedAt: null,
        content: { name: "Pack", upstreamToken: "Bearer abc.def.ghi" },
        contentHash: "hash",
        provenance: { mapper_key: "courtyard-catalog", apiKey: "leak" },
        provenanceHash: "phash",
        relationships: [],
      };
    },
  };
}

function serviceOver(repository: unknown) {
  return new CanonicalInspectionService(
    repository as never,
  );
}

test("walking every page visits every entity exactly once", async () => {
  const entities = Array.from({ length: 7 }, (_, index) => ({
    externalId: `pack-${index}`,
    entityId: `e-${index}`,
  }));
  const service = serviceOver(fakeRepository({ entities }));

  const seen: string[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const result = await service.listEntities({
      organizationId: ORGANIZATION,
      platformKey: "courtyard",
      recordKind: "pack",
      limit: 3,
      page,
    });
    seen.push(...result.items.map((item) => item.externalId));
    if (!result.hasMore) break;
  }

  assert.deepEqual(seen, entities.map((entity) => entity.externalId));
  assert.equal(new Set(seen).size, seen.length, "no entity is visited twice");
});

test("any page is reachable directly, without walking to it", async () => {
  const entities = Array.from({ length: 100 }, (_, index) => ({
    externalId: `pack-${String(index).padStart(3, "0")}`,
    entityId: `e-${index}`,
  }));
  const captured: { offset?: number } = {};
  const service = serviceOver(fakeRepository({ entities, captured }));

  // Page 5 at 10 per page starts at record 41 — asked for directly.
  const result = await service.listEntities({
    organizationId: ORGANIZATION,
    platformKey: "courtyard",
    recordKind: "pack",
    limit: 10,
    page: 5,
  });
  assert.equal(captured.offset, 40);
  assert.equal(result.page, 5);
  assert.equal(result.items[0]?.externalId, "pack-040");
});

test("a page number that is not a positive integer is refused", async () => {
  const service = serviceOver(fakeRepository());
  for (const page of [0, -3, 1.5]) {
    await assert.rejects(
      () =>
        service.listEntities({
          organizationId: ORGANIZATION,
          platformKey: "courtyard",
          recordKind: "pack",
          page,
        }),
      (error: unknown) =>
        error instanceof CanonicalInspectionError &&
        error.code === "CANONICAL_PAGE_INVALID",
      `page ${page} should be refused`,
    );
  }
});

test("a page past the scan bound resolves to the deepest reachable page", async () => {
  const captured: { offset?: number } = {};
  const service = serviceOver(fakeRepository({ captured }));
  const result = await service.listEntities({
    organizationId: ORGANIZATION,
    platformKey: "courtyard",
    recordKind: "pack",
    limit: 25,
    page: 1_000_000,
  });

  // Capped rather than answered with an empty page, which would read as
  // "no records" instead of "deeper than this surface will scan".
  assert.equal(result.depthCapped, true);
  assert.ok((captured.offset ?? 0) <= CANONICAL_MAX_OFFSET);
  assert.ok(result.page < 1_000_000);
});

test("page size is bounded server-side whatever the caller asks for", async () => {
  const captured: { limit?: number } = {};
  const service = serviceOver(fakeRepository({ captured }));
  await service.listEntities({
    organizationId: ORGANIZATION,
    platformKey: "courtyard",
    recordKind: "pack",
    limit: 10_000,
  });
  assert.equal(captured.limit, CANONICAL_PAGE_SIZE_MAX);
});

test("an unknown provider and an invalid record kind fail distinctly", async () => {
  const service = serviceOver(fakeRepository({ providers: ["courtyard"] }));

  await assert.rejects(
    () =>
      service.listEntities({
        organizationId: ORGANIZATION,
        platformKey: "not-configured",
        recordKind: "pack",
      }),
    (error: unknown) =>
      error instanceof CanonicalInspectionError &&
      error.code === "CANONICAL_PROVIDER_UNKNOWN",
  );

  await assert.rejects(
    () =>
      service.listEntities({
        organizationId: ORGANIZATION,
        platformKey: "courtyard",
        recordKind: "not_a_kind",
      }),
    (error: unknown) =>
      error instanceof CanonicalInspectionError &&
      error.code === "CANONICAL_RECORD_KIND_INVALID",
  );
});

test("a store failure carries no driver detail", async () => {
  const service = serviceOver(
    fakeRepository({ failWith: new Error("connection to 10.0.0.4:5432 refused") }),
  );
  await assert.rejects(
    () => service.listProviders(ORGANIZATION),
    (error: unknown) => {
      assert.ok(error instanceof CanonicalInspectionError);
      assert.equal(error.code, "CANONICAL_STORE_UNAVAILABLE");
      assert.doesNotMatch(error.message, /5432|refused|connection to/i);
      return true;
    },
  );
});

test("a bucket past the bound reports a floor, not an exact total", async () => {
  const service = serviceOver(
    fakeRepository({ bucketSize: CANONICAL_COUNT_BOUND + 1 }),
  );
  const summary = await service.summarizeProvider({
    organizationId: ORGANIZATION,
    platformKey: "courtyard",
  });
  const packs = summary.kinds.find((kind) => kind.recordKind === "pack");
  assert.equal(packs?.precision, "at_least");
  assert.equal(packs?.count, CANONICAL_COUNT_BOUND);
});

test("a bucket inside the bound reports an exact count", async () => {
  const service = serviceOver(fakeRepository({ bucketSize: 12 }));
  const summary = await service.summarizeProvider({
    organizationId: ORGANIZATION,
    platformKey: "courtyard",
  });
  const packs = summary.kinds.find((kind) => kind.recordKind === "pack");
  assert.equal(packs?.precision, "exact");
  assert.equal(packs?.count, 12);
});

test("record detail is redacted and its provenance summarized", async () => {
  const service = serviceOver(fakeRepository());
  const detail = await service.readEntity({
    organizationId: ORGANIZATION,
    platformKey: "courtyard",
    recordKind: "pack",
    externalId: "pack-1",
  });

  const content = detail.content as Record<string, unknown>;
  assert.equal(content.name, "Pack");
  assert.equal(content.upstreamToken, REDACTED);
  assert.equal(detail.provenance?.mapperKey, "courtyard-catalog");
  assert.equal(detail.provenance?.additional.apiKey, REDACTED);
});


test("the collection aggregate is skipped exactly when the count was bounded", async () => {
  // The rule the service documents: a bucket past the count bound is too large
  // to aggregate collection times over, so the aggregate is not run and the
  // summary says the range was not computed rather than showing a null range
  // that reads as "nothing collected".
  const bounded: { collectedExtrema?: boolean } = {};
  const overBound = serviceOver(
    fakeRepository({ bucketSize: CANONICAL_COUNT_BOUND + 1, captured: bounded }),
  );
  const large = await overBound.summarizeProvider({
    organizationId: ORGANIZATION,
    platformKey: "courtyard",
  });
  assert.equal(bounded.collectedExtrema, false);
  const largePack = large.kinds.find((kind) => kind.recordKind === "pack");
  assert.equal(largePack?.collectedExtremaComplete, false);
  assert.equal(largePack?.oldestCollectedAt, null);
  // Acceptance times are cheap and still reported.
  assert.ok(largePack?.newestAcceptedAt);

  const inside: { collectedExtrema?: boolean } = {};
  const underBound = serviceOver(
    fakeRepository({ bucketSize: 12, captured: inside }),
  );
  const small = await underBound.summarizeProvider({
    organizationId: ORGANIZATION,
    platformKey: "courtyard",
  });
  assert.equal(inside.collectedExtrema, true);
  const smallPack = small.kinds.find((kind) => kind.recordKind === "pack");
  assert.equal(smallPack?.collectedExtremaComplete, true);
  assert.ok(smallPack?.oldestCollectedAt);
});

test("summary timestamps are mapped to their own fields, not transposed", async () => {
  const service = serviceOver(fakeRepository({ bucketSize: 5 }));
  const summary = await service.summarizeProvider({
    organizationId: ORGANIZATION,
    platformKey: "courtyard",
  });
  const pack = summary.kinds.find((kind) => kind.recordKind === "pack");
  // Distinct fixture values, so a swapped mapping cannot pass.
  assert.equal(pack?.oldestCollectedAt, new Date("2026-01-01").toISOString());
  assert.equal(pack?.newestCollectedAt, new Date("2026-08-01").toISOString());
  assert.equal(pack?.oldestAcceptedAt, new Date("2026-01-02").toISOString());
  assert.equal(pack?.newestAcceptedAt, new Date("2026-08-02").toISOString());
});
