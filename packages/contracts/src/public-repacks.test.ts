import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSyntheticDataReleaseV2,
  SYNTHETIC_CHARIZARD_ID,
  SYNTHETIC_FOCUSED_REPACK_ID,
  SYNTHETIC_POKEMON_CATEGORY_ID,
} from "./__fixtures__/data-release-v2.fixture.ts";
import {
  PUBLIC_READ_ERRORS,
  acceptedRepackQuerySchema,
  contextualRepackFacetsSchema,
  desiredCollectibleRepackResultsSchema,
  encodePublicCursorStack,
  findRepacksByDesiredCollectibleInputSchema,
  getDashboardBundleResultSchema,
  listPublicRepacksInputSchema,
  listPublicRepacksPageSchema,
  normalizeListPublicRepacksInput,
  normalizePublicSearchText,
  publicReadError,
  publicReadErrorSchema,
  publicRepackViewSummaryFromDetail,
  searchPublicCollectiblesInputSchema,
  type PublicRepackViewDetail,
} from "./public-repacks.ts";
import { unavailableRepackHeat } from "./repack-heat.ts";
import { publicRepackDetailSchema } from "./data-release-v2.ts";

function withUnavailableHeat<T extends object>(value: T): T & {
  readonly heat: ReturnType<typeof unavailableRepackHeat>;
} {
  return { ...value, heat: unavailableRepackHeat() };
}

test("repack query normalization is deterministic across all aggregate facets", () => {
  assert.equal(
    normalizePublicSearchText("  Pokémon—GRAIL pokemon POKÉMON!!  "),
    "pokemon grail",
  );
  const query = normalizeListPublicRepacksInput({
    search: "  Charizard + REPACK charizard ",
    filters: {
      vendors: ["collector_example", "collector_example"],
      categories: [SYNTHETIC_POKEMON_CATEGORY_ID],
      collectibleTypes: ["watch", "card", "card"],
    },
  });
  assert.equal(query.search, "charizard repack");
  assert.deepEqual(query.filters.vendors, ["collector_example"]);
  assert.deepEqual(query.filters.categories, [SYNTHETIC_POKEMON_CATEGORY_ID]);
  assert.deepEqual(query.filters.collectibleTypes, ["card", "watch"]);
  assert.equal(query.filters.availability, "available");
  assert.equal(query.sort, "packscout_ev_dollars");
  assert.equal(query.desiredPublicCollectibleId, null);

  assert.equal(
    normalizeListPublicRepacksInput({ filters: { availability: "all" } }).filters
      .availability,
    "all",
  );

  const desired = normalizeListPublicRepacksInput({
    desiredPublicCollectibleId: SYNTHETIC_CHARIZARD_ID,
  });
  assert.equal(desired.desiredPublicCollectibleId, SYNTHETIC_CHARIZARD_ID);
  assert.equal(
    acceptedRepackQuerySchema.safeParse({
      search: desired.search,
      filters: desired.filters,
      sort: desired.sort,
      direction: desired.direction,
      pageSize: desired.pageSize,
    }).success,
    false,
  );
});

test("repack cursors and public inputs reject partial or legacy-shaped state", () => {
  const cursorStack = encodePublicCursorStack(["first-cursor", "next-cursor"]);
  assert.equal(
    listPublicRepacksInputSchema.safeParse({
      cursor: "next-cursor",
      cursorStack,
      queryFingerprint: "a".repeat(64),
    }).success,
    true,
  );
  for (const input of [
    { cursor: "next-cursor" },
    { sort: "ev_dollars" },
    { filters: { platforms: ["collector_example"] } },
    { filters: { availability: "sold_out" } },
    { selectedPublicPackId: SYNTHETIC_FOCUSED_REPACK_ID },
    {
      desiredPublicCollectibleId: SYNTHETIC_CHARIZARD_ID,
      sort: "top_chase_value",
    },
  ]) {
    assert.equal(listPublicRepacksInputSchema.safeParse(input).success, false);
  }
});

test("collectible search and exact desired-collectible contracts stay distinct", () => {
  assert.equal(
    searchPublicCollectiblesInputSchema.safeParse({ search: "charizard" })
      .success,
    true,
  );
  assert.equal(
    searchPublicCollectiblesInputSchema.safeParse({ search: "c" }).success,
    false,
  );
  assert.equal(
    findRepacksByDesiredCollectibleInputSchema.safeParse({
      publicCollectibleId: SYNTHETIC_CHARIZARD_ID,
      sort: "match_confidence",
    }).success,
    true,
  );

  const release = buildSyntheticDataReleaseV2();
  const desiredCollectible = release.collectibles[0]!;
  const matches = release.repackChases
    .filter(
      ({ publicCollectibleId }) =>
        publicCollectibleId === desiredCollectible.publicCollectibleId,
    )
    .map((chase) => ({
      repack: publicRepackViewSummaryFromDetail(
        withUnavailableHeat(release.repacks.find(
          ({ publicRepackId }) => publicRepackId === chase.publicRepackId,
        )!),
      ),
      chase,
    }));
  const result = {
    metadata: release.metadata,
    desiredCollectible,
    matches,
    total: matches.length,
  };
  assert.equal(desiredCollectibleRepackResultsSchema.safeParse(result).success, true);

  const mismatched = structuredClone(result);
  mismatched.matches[0]!.chase.publicCollectibleId =
    release.collectibles[1]!.publicCollectibleId;
  assert.equal(
    desiredCollectibleRepackResultsSchema.safeParse(mismatched).success,
    false,
  );
});

test("dashboard and errors expose repack vocabulary with no partial data", () => {
  const release = buildSyntheticDataReleaseV2();
  const detail = withUnavailableHeat(release.repacks[0]!) satisfies PublicRepackViewDetail;
  const opportunity = publicRepackViewSummaryFromDetail(detail);
  const result = {
    ok: true as const,
    data: {
      metadata: release.metadata,
      kpis: {
        totalRepacks: 2,
        positiveEvRepacks: 1,
        medianPackScoutEvPercent: {
          status: "available" as const,
          basisPoints: 2_000,
        },
        highestChaseValueUsdMinor: 1_250_000,
        highConfidenceRepacks: 0,
      },
      opportunities: [opportunity],
      details: [detail],
      vendorSummaries: [],
      categorySummaries: [],
      facets: { vendors: [], categories: [], collectibleTypes: [] },
      activeFilters: normalizeListPublicRepacksInput({}).filters,
      selectedRepack: detail,
    },
  };
  assert.equal(getDashboardBundleResultSchema.safeParse(result).success, true);

  for (const code of [
    "INVALID_QUERY",
    "CURSOR_EXPIRED",
    "RELEASE_UNAVAILABLE",
    "REPACK_NOT_FOUND",
    "COLLECTIBLE_NOT_FOUND",
  ] as const) {
    const error = publicReadError(code);
    assert.deepEqual(error, { ok: false, code, ...PUBLIC_READ_ERRORS[code] });
    assert.equal(publicReadErrorSchema.safeParse(error).success, true);
    assert.equal(
      publicReadErrorSchema.safeParse({ ...error, data: {} }).success,
      false,
    );
  }
});

test("list pages bind each desired-collectible row to exact chase evidence", () => {
  const release = buildSyntheticDataReleaseV2();
  const detail = withUnavailableHeat(release.repacks[0]!) satisfies PublicRepackViewDetail;
  const row = publicRepackViewSummaryFromDetail(detail);
  const desiredCollectible = release.collectibles[0]!;
  const chase = release.repackChases.find(
    ({ publicRepackId, publicCollectibleId }) =>
      publicRepackId === detail.publicRepackId &&
      publicCollectibleId === desiredCollectible.publicCollectibleId,
  )!;
  const query = normalizeListPublicRepacksInput({
    desiredPublicCollectibleId: desiredCollectible.publicCollectibleId,
  });
  const page = {
    metadata: release.metadata,
    rows: [row],
    details: [detail],
    selectedRepack: detail,
    selectedRepackEligible: true,
    desiredCollectible,
    desiredChaseMatches: [{ publicRepackId: detail.publicRepackId, chase }],
    facets: { vendors: [], categories: [], collectibleTypes: [] },
    activeQuery: {
      search: query.search,
      filters: query.filters,
      sort: query.sort,
      direction: query.direction,
      pageSize: query.pageSize,
      desiredPublicCollectibleId: query.desiredPublicCollectibleId,
    },
    queryFingerprint: "a".repeat(64),
    nextCursor: null,
    hasPrevious: false,
    range: { start: 1, end: 1, total: 1 },
    paginationReset: null,
  };
  assert.equal(listPublicRepacksPageSchema.safeParse(page).success, true);

  const missingMatch = structuredClone(page);
  missingMatch.desiredChaseMatches = [];
  assert.equal(listPublicRepacksPageSchema.safeParse(missingMatch).success, false);

  const wrongHydration = structuredClone(page);
  wrongHydration.desiredChaseMatches[0]!.chase.collectible.name = "Wrong chase";
  assert.equal(listPublicRepacksPageSchema.safeParse(wrongHydration).success, false);

  const inactive = structuredClone(page);
  inactive.activeQuery.desiredPublicCollectibleId = null;
  assert.equal(listPublicRepacksPageSchema.safeParse(inactive).success, false);
});

test("category facets require parent and depth so the dashboard can nest subcategories", () => {
  const pokemon = {
    key: SYNTHETIC_POKEMON_CATEGORY_ID,
    label: "Pokemon",
    repackCount: 2,
    selected: false,
    parentKey: null,
    depth: 0,
  };
  assert.equal(
    contextualRepackFacetsSchema.safeParse({
      vendors: [],
      categories: [pokemon],
      collectibleTypes: [],
    }).success,
    true,
  );
  assert.equal(
    contextualRepackFacetsSchema.safeParse({
      vendors: [],
      categories: [
        {
          key: pokemon.key,
          label: pokemon.label,
          repackCount: pokemon.repackCount,
          selected: pokemon.selected,
        },
      ],
      collectibleTypes: [],
    }).success,
    false,
  );
});

test("public pack details retain four states and reject protected or non-available actions", () => {
  const base = buildSyntheticDataReleaseV2().repacks[0]!;
  for (const availability of [
    "available",
    "unavailable",
    "unknown",
    "sold_out",
  ] as const) {
    const actionAvailability = availability === "available"
      ? base.actionAvailability
      : { promo: false, repackLink: false };
    const actions = availability === "available" ? base.actions : {};
    const detail = { ...base, availability, actionAvailability, actions };
    assert.equal(publicRepackDetailSchema.safeParse(detail).success, true);
    assert.equal(detail.publicVendorId, base.publicVendorId);
    assert.equal(detail.vendorKey, base.vendorKey);
    assert.equal(detail.sourceUpdatedAt, base.sourceUpdatedAt);
  }

  for (const availability of ["unavailable", "unknown", "sold_out"] as const) {
    assert.equal(
      publicRepackDetailSchema.safeParse({
        ...base,
        availability,
      }).success,
      false,
    );
  }

  for (const forbidden of [
    { sourceInstanceId: "source-1" },
    { connectionId: "connection-1" },
    { checkpoint: "opaque" },
    { processorDiagnostics: [] },
    { quarantine: null },
    { paymentMethod: "card" },
    { protectedProviderData: {} },
  ]) {
    assert.equal(
      publicRepackDetailSchema.safeParse({ ...base, ...forbidden }).success,
      false,
    );
  }
});
