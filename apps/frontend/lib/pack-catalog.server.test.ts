import assert from "node:assert/strict";
import { test } from "node:test";
import { getFunctionName } from "convex/server";
import { PACK_CATALOG_V1, packCatalogReadErrorCodes, packCatalogV1QueryContracts } from "@packscout/contracts";
import { createPackCatalogV1Fixture, packCatalogFixtureIds } from "@packscout/contracts/test-fixtures/pack-catalog-v1";
import { createPackCatalogReader, type PackCatalogTransport } from "./pack-catalog.server";
import { packCatalogError, packCatalogErrorHttpStatus, parsePackCatalogResult, type PackCatalogOperation } from "./pack-catalog";

const environment = {
  NODE_ENV: "development",
  NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3210",
  PACKSCOUT_CATALOG_READ_TOKEN: "private-rendering-credential-0123456789",
};
const fixturePromise = createPackCatalogV1Fixture(new Uint8Array(32).fill(7));

async function queryFixtures(packName: "packA" | "packB" = "packA") {
  const fixture = await fixturePromise;
  const pack = fixture.packs[packName].snapshot;
  const payload = pack.payload;
  const page = fixture.query.firstPage;
  return {
    getPublicShellStatus: { schemaVersion: PACK_CATALOG_V1, evaluatedAt: page.evaluatedAt, catalogAvailable: true, activeAvailablePackCount: 1 },
    getDashboardBundle: { evaluatedAt: page.evaluatedAt, packs: page.items, totalMatchingPacks: 1, providerProfiles: page.providerProfiles },
    listPublicPacks: page,
    getPublicPack: {
      evaluatedAt: page.evaluatedAt, snapshot: pack.identity, summary: payload.summaryProjection,
      detail: {
        providerProfileSnapshotId: payload.providerProfileSnapshotId, dataAsOf: payload.dataAsOf,
        actions: payload.actions, probabilityInputsSha256: payload.probabilityInputsSha256,
        valuationDependencyIdentities: payload.valuationDependencyIdentities,
        valuationsSha256: payload.valuationsSha256, evMethodIdentity: payload.evMethodIdentity,
        evPolicyIdentity: payload.evPolicyIdentity, evInputsSha256: payload.evInputsSha256,
        economicsSha256: payload.economicsSha256, searchProjection: payload.searchProjection,
      },
      providerProfile: fixture.provider.profile, contents: payload.contents,
      contentCount: payload.contents.length, nextContentsCursor: null,
    },
    searchPublicCollectibles: { evaluatedAt: page.evaluatedAt, items: fixture.collectibles.map(({ profile }) => profile), nextCursor: null },
    findPacksByDesiredCollectible: { ...page, publicCollectibleId: packCatalogFixtureIds.collectibleA },
  };
}

function inputs(operation: PackCatalogOperation) {
  return operation === "getPublicPack" ? { publicRepackId: packCatalogFixtureIds.packA }
    : operation === "findPacksByDesiredCollectible" ? { publicCollectibleId: packCatalogFixtureIds.collectibleA }
      : operation === "searchPublicCollectibles" ? { query: "  ALPHA  " } : {};
}

test("six native journeys use their generated action, validate requests, and return the contract unchanged", async () => {
  const fixtures = await queryFixtures();
  const calls: string[] = [];
  const transport: PackCatalogTransport = async (reference, args, options) => {
    const name = getFunctionName(reference);
    calls.push(name);
    const operation = name.split(":")[1] as PackCatalogOperation;
    assert.equal(name, `packCatalogV1:${operation}`);
    assert.equal(options.url, environment.NEXT_PUBLIC_CONVEX_URL);
    assert.equal(args.catalogReadToken, environment.PACKSCOUT_CATALOG_READ_TOKEN);
    assert.deepEqual(args.request, packCatalogV1QueryContracts[operation].input.parse(inputs(operation)));
    assert.deepEqual(Object.keys(args).sort(), ["catalogReadToken", "request"]);
    return { ok: true, data: fixtures[operation] };
  };
  const reader = createPackCatalogReader({ environment, transport });
  for (const operation of Object.keys(fixtures) as PackCatalogOperation[]) {
    const result = await reader.read(operation, inputs(operation));
    assert.deepEqual(result, { ok: true, data: fixtures[operation] });
    assert.equal(JSON.stringify(result).includes(environment.PACKSCOUT_CATALOG_READ_TOKEN), false);
  }
  assert.equal(calls.length, 6);
});

test("invalid public input fails before any credentialed request", async () => {
  let calls = 0;
  const reader = createPackCatalogReader({ environment, transport: async () => { calls += 1; return null; } });
  for (const input of [null, { query: "x".repeat(121) }, { pageSize: 51 }, { cursor: "x".repeat(8_193) }, { cursor: { token: "wrong shape" } }, { owner: "someone-else" }, { query: "alpha", publicReleaseId: packCatalogFixtureIds.packA }]) {
    assert.deepEqual(await reader.read("listPublicPacks", input), packCatalogError("INVALID_QUERY"));
  }
  assert.equal(calls, 0);
});

test("a schema-valid pack or desired-collectible result cannot satisfy a different requested identity", async (context) => {
  const fixtures = await queryFixtures("packB");
  const results = {
    getPublicPack: { ok: true, data: fixtures.getPublicPack },
    findPacksByDesiredCollectible: { ok: true, data: { ...fixtures.findPacksByDesiredCollectible, publicCollectibleId: packCatalogFixtureIds.collectibleB } },
  };
  for (const operation of ["getPublicPack", "findPacksByDesiredCollectible"] as const) {
    await context.test(operation, async () => {
      assert.equal(packCatalogV1QueryContracts[operation].output.safeParse(results[operation]).success, true);
      let calls = 0;
      const reader = createPackCatalogReader({ environment, transport: async () => { calls += 1; return results[operation]; } });
      assert.deepEqual(await reader.read(operation, inputs(operation)), packCatalogError("CATALOG_UNAVAILABLE"), operation);
      assert.equal(calls, 1);
    });
  }
});

test("cursor recovery rejects a valid response for the wrong pack or desired collectible without another retry", async (context) => {
  const fixture = await fixturePromise;
  const fixtures = await queryFixtures("packB");
  for (const operation of ["getPublicPack", "findPacksByDesiredCollectible"] as const) {
    await context.test(operation, async () => {
      const cursorKey = operation === "getPublicPack" ? "contentsCursor" : "cursor";
      const query = packCatalogV1QueryContracts[operation].input.parse({ ...inputs(operation), [cursorKey]: fixture.query.cursor });
      const response = operation === "getPublicPack" ? { ok: true, data: fixtures.getPublicPack }
        : { ok: true, data: { ...fixtures.findPacksByDesiredCollectible, publicCollectibleId: packCatalogFixtureIds.collectibleB } };
      assert.equal(packCatalogV1QueryContracts[operation].output.safeParse(response).success, true);
      const requests: unknown[] = [];
      const reader = createPackCatalogReader({ environment, transport: async (_reference, args) => {
        requests.push(args.request);
        return requests.length === 1 ? packCatalogError("CURSOR_EXPIRED") : response;
      } });
      assert.deepEqual(await reader.readPage(operation, query), { result: packCatalogError("CATALOG_UNAVAILABLE"), paginationReset: true }, operation);
      assert.deepEqual(requests, [query, { ...query, [cursorKey]: null }]);
    });
  }
});

test("invalid or absent origin never invokes transport", async () => {
  let calls = 0;
  for (const url of [undefined, "https://user:secret@example.convex.cloud", "https://example.convex.cloud/path", "javascript:alert(1)"]) {
    const reader = createPackCatalogReader({ environment: { ...environment, NEXT_PUBLIC_CONVEX_URL: url }, transport: async () => { calls += 1; return null; } });
    assert.deepEqual(await reader.read("getPublicShellStatus", {}), packCatalogError("CATALOG_UNAVAILABLE"));
  }
  assert.equal(calls, 0);
});

test("unconfigured credential is omitted and transport exceptions reveal no raw diagnostics", async () => {
  const reader = createPackCatalogReader({ environment: { ...environment, PACKSCOUT_CATALOG_READ_TOKEN: "short" }, transport: async (_reference, args) => {
    assert.equal("catalogReadToken" in args, false);
    throw new Error("private-rendering-credential-0123456789 internal topology stack");
  } });
  assert.deepEqual(await reader.read("getPublicShellStatus", {}), packCatalogError("CATALOG_UNAVAILABLE"));
});

test("every declared error uses fixed public copy and distinct bounded HTTP outcomes", () => {
  for (const code of packCatalogReadErrorCodes) {
    const result = parsePackCatalogResult("listPublicPacks", { ok: false, code, error: "server credential text must not render", retryable: true });
    assert.deepEqual(result, packCatalogError(code));
    assert.equal(JSON.stringify(result).includes("credential"), false);
  }
  assert.equal(packCatalogErrorHttpStatus("AUTH_REQUIRED"), 401);
  assert.equal(packCatalogErrorHttpStatus("UNAUTHORIZED"), 403);
  assert.equal(packCatalogErrorHttpStatus("PACK_NOT_FOUND"), 404);
  assert.equal(packCatalogErrorHttpStatus("CURSOR_EXPIRED"), 409);
  assert.equal(packCatalogErrorHttpStatus("INVALID_QUERY"), 400);
  assert.equal(packCatalogErrorHttpStatus("CATALOG_UNAVAILABLE"), 503);
});

test("malformed, oversized, unexpected, or mixed-identity results fail closed", async () => {
  const fixtures = await queryFixtures();
  for (const data of [null, { ...fixtures.listPublicPacks, rawPayload: "private" }, { ...fixtures.listPublicPacks, items: Array(51).fill(fixtures.listPublicPacks.items[0]) }, { ...fixtures.listPublicPacks, providerProfiles: [] }]) {
    assert.deepEqual(parsePackCatalogResult("listPublicPacks", { ok: true, data }), packCatalogError("CATALOG_UNAVAILABLE"));
  }
  const detail = structuredClone(fixtures.getPublicPack);
  detail.summary.publicRepackId = packCatalogFixtureIds.packB;
  assert.deepEqual(parsePackCatalogResult("getPublicPack", { ok: true, data: detail }), packCatalogError("CATALOG_UNAVAILABLE"));
  assert.deepEqual(parsePackCatalogResult("getPublicShellStatus", { ok: false, code: "INTERNAL_ERROR", error: "private", retryable: true }), packCatalogError("CATALOG_UNAVAILABLE"));
});

test("expired list cursor retries once with the same accepted filters, sort, direction and page size", async () => {
  const fixture = await fixturePromise;
  const query = packCatalogV1QueryContracts.listPublicPacks.input.parse({
    query: " Alpha ", providerIds: [packCatalogFixtureIds.providerId], categoryIds: [fixture.packs.packA.snapshot.payload.category.publicCategoryId],
    lifecycle: { retirements: ["retired", "active"], availabilities: ["unknown", "sold_out", "available", "unavailable"] },
    sort: "price", direction: "asc", pageSize: 12, cursor: fixture.query.cursor,
  });
  const requests: unknown[] = [];
  const reader = createPackCatalogReader({ environment, transport: async (_reference, args) => {
    requests.push(args.request);
    return requests.length === 1 ? packCatalogError("CURSOR_EXPIRED") : { ok: true, data: fixture.query.firstPage };
  } });
  const recovered = await reader.readPage("listPublicPacks", query);
  assert.equal(recovered.paginationReset, true);
  assert.equal(recovered.result.ok, true);
  assert.deepEqual(requests, [query, { ...query, cursor: null }]);
  assert.equal(query.cursor, fixture.query.cursor);
});

test("content and desired-collectible recovery preserve stable identity and page bounds", async () => {
  const fixtures = await queryFixtures();
  const fixture = await fixturePromise;
  for (const operation of ["getPublicPack", "findPacksByDesiredCollectible", "searchPublicCollectibles"] as const) {
    const key = operation === "getPublicPack" ? "contentsCursor" : "cursor";
    const query = packCatalogV1QueryContracts[operation].input.parse({ ...inputs(operation), [key]: fixture.query.cursor });
    const requests: unknown[] = [];
    const reader = createPackCatalogReader({ environment, transport: async (_reference, args) => {
      requests.push(args.request);
      return requests.length === 1 ? packCatalogError("CURSOR_EXPIRED") : { ok: true, data: fixtures[operation] };
    } });
    const recovered = await reader.readPage(operation, query);
    assert.equal(recovered.result.ok, true);
    assert.equal(recovered.paginationReset, true);
    assert.deepEqual(requests, [query, { ...query, [key]: null }]);
  }
});

test("a second expiry stops recovery; non-cursor errors and first-page failures never retry", async () => {
  const fixture = await fixturePromise;
  const query = packCatalogV1QueryContracts.listPublicPacks.input.parse({ cursor: fixture.query.cursor });
  for (const code of packCatalogReadErrorCodes) {
    let calls = 0;
    const reader = createPackCatalogReader({ environment, transport: async () => { calls += 1; return packCatalogError(code); } });
    const recovered = await reader.readPage("listPublicPacks", query);
    assert.deepEqual(recovered.result, packCatalogError(code));
    assert.equal(calls, code === "CURSOR_EXPIRED" ? 2 : 1);
    assert.equal(recovered.paginationReset, code === "CURSOR_EXPIRED");
  }
  let calls = 0;
  const reader = createPackCatalogReader({ environment, transport: async () => { calls += 1; return packCatalogError("CURSOR_EXPIRED"); } });
  assert.equal((await reader.readPage("listPublicPacks", { ...query, cursor: null })).paginationReset, false);
  assert.equal(calls, 1);
});

test("malformed cursor syntax recovers only after the rest of the query validates", async () => {
  const fixture = await fixturePromise;
  const requests: unknown[] = [];
  const reader = createPackCatalogReader({ environment, transport: async (_reference, args) => { requests.push(args.request); return { ok: true, data: fixture.query.firstPage }; } });
  const query = packCatalogV1QueryContracts.listPublicPacks.input.parse({ query: "alpha" });
  const result = await reader.readPage("listPublicPacks", { ...query, cursor: "tampered cursor" });
  assert.equal(result.paginationReset, true);
  assert.equal(result.result.ok, true);
  assert.deepEqual(requests, [query]);
  assert.deepEqual(await reader.read("listPublicPacks", { ...query, cursor: "tampered cursor", pageSize: 51 }), packCatalogError("INVALID_QUERY"));
  assert.equal(requests.length, 1);
});
