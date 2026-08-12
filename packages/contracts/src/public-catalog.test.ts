import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSyntheticCatalogSnapshotV1,
  publicPackSummaryFromDetail,
} from "./__fixtures__/catalog-snapshot-v1.fixture.ts";
import {
  PUBLIC_CATALOG_DEFAULT_PAGE_SIZE,
  PUBLIC_CATALOG_PRICE_MAX_MINOR,
  PUBLIC_CATALOG_PRICE_MIN_MINOR,
  PUBLIC_READ_ERRORS,
  contextualCatalogFacetsSchema,
  dashboardBundleSchema,
  decodePublicCursorStack,
  encodePublicCursorStack,
  getDashboardBundleResultSchema,
  getPublicPackResultSchema,
  getPublicShellStatusResultSchema,
  listPublicPacksInputSchema,
  listPublicPacksPageSchema,
  listPublicPacksResultSchema,
  normalizeDashboardQueryInput,
  normalizeListPublicPacksInput,
  normalizePublicSearchText,
  publicCursorStackSchema,
  publicReadError,
  publicReadErrorSchema,
  type ContextualCatalogFacets,
  type DashboardBundle,
  type ListPublicPacksPage,
} from "./public-catalog.ts";

const contextualFacets: ContextualCatalogFacets = {
  platforms: [
    {
      key: "collector_crypt",
      label: "Collector Crypt",
      packCount: 1,
      selected: false,
    },
    {
      key: "courtyard",
      label: "Courtyard",
      packCount: 2,
      selected: false,
    },
  ],
  categories: [
    { key: "pokemon", label: "Pokemon", packCount: 2, selected: false },
    {
      key: "uncategorized",
      label: "Uncategorized",
      packCount: 1,
      selected: false,
    },
  ],
};

function successfulDashboardBundle(): DashboardBundle {
  const snapshot = buildSyntheticCatalogSnapshotV1();
  const selectedPack = snapshot.packs[0]!;
  return {
    metadata: snapshot.metadata,
    kpis: {
      totalPacks: 3,
      positiveEvPacks: 2,
      medianEvPercent: {
        status: "available" as const,
        value: { basisPoints: 399 },
        reason: null,
        nullRank: 0 as const,
      },
      highestChaseValue: {
        status: "available" as const,
        value: { minorUnits: 8_500_000, currency: "USD" as const },
        reason: null,
        nullRank: 0 as const,
      },
    },
    opportunities: [publicPackSummaryFromDetail(selectedPack)],
    details: [selectedPack],
    platformSummaries: [
      {
        key: "collector_crypt",
        label: "Collector Crypt",
        packCount: 1,
        medianEvPercent: {
          status: "available" as const,
          value: { basisPoints: 738 },
          reason: null,
          nullRank: 0 as const,
        },
      },
    ],
    categorySummaries: [
      {
        key: "pokemon",
        label: "Pokemon",
        packCount: 2,
        medianEvPercent: {
          status: "available" as const,
          value: { basisPoints: 399 },
          reason: null,
          nullRank: 0 as const,
        },
      },
    ],
    facets: contextualFacets,
    activeFilters: normalizeDashboardQueryInput({}).filters,
    selectedPack,
  };
}

function successfulListPage(): ListPublicPacksPage {
  const snapshot = buildSyntheticCatalogSnapshotV1();
  const rows = [
    publicPackSummaryFromDetail(snapshot.packs[0]!),
    publicPackSummaryFromDetail(snapshot.packs[2]!),
    publicPackSummaryFromDetail(snapshot.packs[1]!),
  ];
  const input = normalizeListPublicPacksInput({});
  return {
    metadata: snapshot.metadata,
    rows,
    details: [snapshot.packs[0]!, snapshot.packs[2]!, snapshot.packs[1]!],
    selectedPack: snapshot.packs[0]!,
    selectedPackEligible: true,
    facets: contextualFacets,
    activeQuery: {
      search: input.search,
      filters: input.filters,
      sort: input.sort,
      direction: input.direction,
      pageSize: input.pageSize,
    },
    queryFingerprint: "8".repeat(64),
    nextCursor: null,
    hasPrevious: false,
    range: { start: 1, end: 3, total: 3 },
    paginationReset: null,
  };
}

test("public query normalization is deterministic and JSON-stable", () => {
  assert.equal(
    normalizePublicSearchText("  Pokémon—MYTHIC pokemon!!  "),
    "pokémon mythic pokemon",
  );

  const normalized = normalizeListPublicPacksInput({
    search: "  Vault + PACK vault ",
    filters: {
      platforms: ["courtyard", "collector_crypt", "courtyard"],
      categories: ["uncategorized", "pokemon", "pokemon"],
    },
  });
  assert.equal(normalized.search, "vault pack");
  assert.deepEqual(normalized.filters.platforms, [
    "collector_crypt",
    "courtyard",
  ]);
  assert.deepEqual(normalized.filters.categories, ["pokemon", "uncategorized"]);
  assert.deepEqual(normalized.filters.price, {
    mode: "full",
    minMinor: PUBLIC_CATALOG_PRICE_MIN_MINOR,
    maxMinor: PUBLIC_CATALOG_PRICE_MAX_MINOR,
  });
  assert.equal(normalized.pageSize, PUBLIC_CATALOG_DEFAULT_PAGE_SIZE);
  assert.deepEqual(JSON.parse(JSON.stringify(normalized)), normalized);
});

test("cursor stacks are canonical base64url arrays bounded to forty cursors", () => {
  const encoded = encodePublicCursorStack(["first_cursor", "next-cursor"]);
  assert.equal(publicCursorStackSchema.safeParse(encoded).success, true);
  assert.deepEqual(decodePublicCursorStack(encoded), [
    "first_cursor",
    "next-cursor",
  ]);
  assert.equal(publicCursorStackSchema.safeParse("W10").success, false);
  assert.equal(publicCursorStackSchema.safeParse("not-json").success, false);
  assert.equal(decodePublicCursorStack("not-json"), null);
  assert.throws(() =>
    encodePublicCursorStack(
      Array.from({ length: 41 }, (_, index) => `cursor-${index}`),
    ),
  );

  const withoutFingerprint = listPublicPacksInputSchema.safeParse({
    cursor: "next-cursor",
  });
  assert.equal(withoutFingerprint.success, false);
  const withFingerprint = listPublicPacksInputSchema.safeParse({
    cursor: "next-cursor",
    cursorStack: encoded,
    queryFingerprint: "a".repeat(64),
  });
  assert.equal(withFingerprint.success, true);
});

test("public list inputs reject unsupported or partial catalog state", () => {
  const invalidInputs: readonly unknown[] = [
    { sort: "provider_rank" },
    { pageSize: 51 },
    { search: "a".repeat(121) },
    { filters: { platforms: ["Collector_Crypt"] } },
    { filters: { categories: ["pokemon"], organizationId: "internal" } },
    {
      filters: {
        price: { mode: "narrowed", minMinor: 50_000, maxMinor: 10_000 },
      },
    },
    {
      filters: {
        price: {
          mode: "narrowed",
          minMinor: PUBLIC_CATALOG_PRICE_MIN_MINOR,
          maxMinor: PUBLIC_CATALOG_PRICE_MAX_MINOR,
        },
      },
    },
    {
      filters: {
        price: {
          mode: "narrowed",
          minMinor: PUBLIC_CATALOG_PRICE_MIN_MINOR - 1,
          maxMinor: 10_000,
        },
      },
    },
    { providerId: "internal-provider" },
  ];

  for (const input of invalidInputs) {
    assert.equal(listPublicPacksInputSchema.safeParse(input).success, false);
  }

  assert.equal(
    listPublicPacksInputSchema.safeParse({ search: " ".repeat(121) }).success,
    true,
  );
});

test("stable public errors are exact discriminated outcomes without partial data", () => {
  for (const code of [
    "INVALID_QUERY",
    "CURSOR_EXPIRED",
    "SNAPSHOT_UNAVAILABLE",
    "PACK_NOT_FOUND",
  ] as const) {
    const error = publicReadError(code);
    assert.deepEqual(error, { ok: false, code, ...PUBLIC_READ_ERRORS[code] });
    assert.equal(publicReadErrorSchema.safeParse(error).success, true);
    assert.equal(
      publicReadErrorSchema.safeParse({ ...error, data: {} }).success,
      false,
    );
    assert.equal(
      publicReadErrorSchema.safeParse({ ...error, error: "internal stack" })
        .success,
      false,
    );
  }
});

test("all four public queries share strict success and failure unions", () => {
  const snapshot = buildSyntheticCatalogSnapshotV1();
  const dashboard = successfulDashboardBundle();
  const listPage = successfulListPage();

  assert.equal(
    getPublicShellStatusResultSchema.safeParse({
      ok: true,
      data: { metadata: snapshot.metadata },
    }).success,
    true,
  );
  assert.equal(
    getDashboardBundleResultSchema.safeParse({ ok: true, data: dashboard })
      .success,
    true,
  );
  assert.equal(
    listPublicPacksResultSchema.safeParse({ ok: true, data: listPage }).success,
    true,
  );
  assert.equal(
    getPublicPackResultSchema.safeParse({
      ok: true,
      data: snapshot.packs[0],
    }).success,
    true,
  );

  assert.equal(
    getPublicShellStatusResultSchema.safeParse(
      publicReadError("SNAPSHOT_UNAVAILABLE"),
    ).success,
    true,
  );
  assert.equal(
    getPublicPackResultSchema.safeParse(publicReadError("PACK_NOT_FOUND"))
      .success,
    true,
  );
});

test("dashboard DTOs require eligible EV-ranked opportunities and coherent selection", () => {
  const soldOut = successfulDashboardBundle();
  const snapshot = buildSyntheticCatalogSnapshotV1();
  soldOut.opportunities = [publicPackSummaryFromDetail(snapshot.packs[2]!)];
  soldOut.details = [snapshot.packs[2]!];
  soldOut.selectedPack = snapshot.packs[2]!;
  assert.equal(dashboardBundleSchema.safeParse(soldOut).success, false);

  const noSelection = successfulDashboardBundle();
  noSelection.selectedPack = null;
  assert.equal(dashboardBundleSchema.safeParse(noSelection).success, false);

  const unavailable = successfulDashboardBundle();
  unavailable.opportunities = [
    publicPackSummaryFromDetail(snapshot.packs[1]!),
  ];
  unavailable.details = [snapshot.packs[1]!];
  unavailable.selectedPack = snapshot.packs[1]!;
  assert.equal(dashboardBundleSchema.safeParse(unavailable).success, false);
});

test("list page DTOs bind range, selection, and snapshot-reset state", () => {
  assert.equal(listPublicPacksPageSchema.safeParse(successfulListPage()).success, true);

  const rangeMismatch = successfulListPage();
  rangeMismatch.range.end = 2;
  assert.equal(listPublicPacksPageSchema.safeParse(rangeMismatch).success, false);

  const selectionMismatch = successfulListPage();
  selectionMismatch.selectedPackEligible = false;
  assert.equal(
    listPublicPacksPageSchema.safeParse(selectionMismatch).success,
    false,
  );

  const resetMismatch = successfulListPage();
  resetMismatch.paginationReset = "snapshot_changed";
  resetMismatch.hasPrevious = true;
  assert.equal(listPublicPacksPageSchema.safeParse(resetMismatch).success, false);

  const emptyWithCursor = successfulListPage();
  emptyWithCursor.rows = [];
  emptyWithCursor.details = [];
  emptyWithCursor.selectedPack = null;
  emptyWithCursor.selectedPackEligible = false;
  emptyWithCursor.range = { start: 0, end: 0, total: 0 };
  emptyWithCursor.nextCursor = "impossible-next";
  assert.equal(listPublicPacksPageSchema.safeParse(emptyWithCursor).success, false);

  const incoherentDetails = successfulListPage();
  incoherentDetails.details.reverse();
  assert.equal(
    listPublicPacksPageSchema.safeParse(incoherentDetails).success,
    false,
  );
});

test("contextual facets keep selected zero-count values but remain canonical", () => {
  const selectedZero = structuredClone(contextualFacets);
  selectedZero.platforms[0]!.packCount = 0;
  selectedZero.platforms[0]!.selected = true;
  assert.equal(contextualCatalogFacetsSchema.safeParse(selectedZero).success, true);

  const outOfOrder = structuredClone(contextualFacets);
  outOfOrder.platforms.reverse();
  assert.equal(contextualCatalogFacetsSchema.safeParse(outOfOrder).success, false);
});
