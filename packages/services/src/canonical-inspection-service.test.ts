import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CANONICAL_COUNT_BOUND,
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
  captured?: { limit?: number; after?: unknown };
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
    async kindRecency() {
      return { oldest: null, newest: null };
    },
    async listEntities(input: {
      limit: number;
      after?: { externalId: string; entityId: string };
    }) {
      (options.captured ?? {}).limit = input.limit;
      (options.captured ?? {}).after = input.after;
      const start = input.after
        ? entities.findIndex((e) => e.externalId === input.after!.externalId) + 1
        : 0;
      const slice = entities.slice(start, start + input.limit);
      const last = slice.at(-1);
      const more = start + input.limit < entities.length;
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
        nextCursor: more && last
          ? { externalId: last.externalId, entityId: last.entityId }
          : null,
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

test("paging visits every entity exactly once", async () => {
  const entities = Array.from({ length: 7 }, (_, index) => ({
    externalId: `pack-${index}`,
    entityId: `e-${index}`,
  }));
  const service = serviceOver(fakeRepository({ entities }));

  const seen: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await service.listEntities({
      organizationId: ORGANIZATION,
      platformKey: "courtyard",
      recordKind: "pack",
      limit: 3,
      cursor,
    });
    seen.push(...page.items.map((item) => item.externalId));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }

  assert.deepEqual(seen, entities.map((entity) => entity.externalId));
  assert.equal(new Set(seen).size, seen.length, "no entity is visited twice");
});

test("a malformed cursor is refused rather than restarting silently", async () => {
  const service = serviceOver(fakeRepository());
  await assert.rejects(
    () =>
      service.listEntities({
        organizationId: ORGANIZATION,
        platformKey: "courtyard",
        recordKind: "pack",
        cursor: "not-a-cursor",
      }),
    (error: unknown) =>
      error instanceof CanonicalInspectionError &&
      error.code === "CANONICAL_CURSOR_INVALID" &&
      error.status === 400,
  );
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
