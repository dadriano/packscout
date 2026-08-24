import {
  PUBLIC_REPACK_PRICE_MAX_MINOR,
  PUBLIC_REPACK_PRICE_MIN_MINOR,
  type PublicRepackFilters,
  type RepackSearchRow,
} from "@packscout/contracts";
import { describe, expect, test } from "vitest";
import {
  contextualFacets,
  matchingRepackRows,
  selectionsAreKnown,
  type CategoryHierarchy,
} from "./publicRepackAggregates";

const tradingCards = "20000000-0000-5000-8000-000000000001";
const pokemon = "20000000-0000-5000-8000-000000000002";
const sports = "20000000-0000-5000-8000-000000000003";
const basketball = "20000000-0000-5000-8000-000000000004";
const watches = "20000000-0000-5000-8000-000000000005";
const nba = "20000000-0000-5000-8000-000000000006";

const hierarchy: CategoryHierarchy = new Map([
  [tradingCards, { parentPublicCategoryId: null, depth: 0, name: "Trading Cards" }],
  [pokemon, { parentPublicCategoryId: tradingCards, depth: 1, name: "Pokemon" }],
  [sports, { parentPublicCategoryId: tradingCards, depth: 1, name: "Sports" }],
  [basketball, { parentPublicCategoryId: sports, depth: 2, name: "Basketball" }],
  [watches, { parentPublicCategoryId: null, depth: 0, name: "Watches" }],
  [nba, { parentPublicCategoryId: basketball, depth: 3, name: "NBA" }],
]);

const emptyFilters: PublicRepackFilters = {
  vendors: [],
  categories: [],
  collectibleTypes: [],
  availability: "all",
  price: {
    mode: "full",
    minMinor: PUBLIC_REPACK_PRICE_MIN_MINOR,
    maxMinor: PUBLIC_REPACK_PRICE_MAX_MINOR,
  },
};

function searchRow(
  publicRepackId: string,
  categories: ReadonlyArray<readonly [id: string, label: string]>,
): RepackSearchRow {
  const sorted = [...categories].sort(([left], [right]) => left.localeCompare(right));
  return {
    publicRepackId,
    publicVendorId: "30000000-0000-5000-8000-000000000001",
    vendorKey: "vendor_a",
    vendorDisplayName: "Vendor A",
    publicCategoryIds: sorted.map(([id]) => id),
    categoryLabels: sorted.map(([, label]) => label),
    collectibleTypes: ["card"],
    contentMode: "focused",
    name: publicRepackId,
    normalizedName: publicRepackId.replaceAll("-", " "),
    normalizedVendor: "vendor a",
    normalizedCategories: sorted.map(([, label]) => label.toLowerCase()).join(" "),
    availability: "available",
    priceMinor: 10_000,
    priceNullRank: 0,
    vendorReportedGrossEvMinor: null,
    vendorReportedGrossEvNullRank: 1,
    vendorReportedEvDollarsMinor: null,
    vendorReportedEvDollarsNullRank: 1,
    vendorReportedEvPercentBasisPoints: null,
    vendorReportedEvPercentNullRank: 1,
    packScoutGrossEvMinor: null,
    packScoutGrossEvNullRank: 1,
    packScoutEvDollarsMinor: null,
    packScoutEvDollarsNullRank: 1,
    packScoutEvPercentBasisPoints: null,
    packScoutEvPercentNullRank: 1,
    packScoutConfidenceBasisPoints: null,
    packScoutConfidenceNullRank: 1,
    packScoutConfidenceBand: null,
    buybackBasisPoints: null,
    buybackNullRank: 1,
    topChaseValueMinor: null,
    topChaseNullRank: 1,
    topChaseReason: "CHASE_UNAVAILABLE",
  };
}

const pokemonPack = searchRow("10000000-0000-5000-8000-000000000001", [
  [pokemon, "Pokemon"],
]);
const nbaPack = searchRow("10000000-0000-5000-8000-000000000002", [
  [nba, "NBA"],
]);
const watchesPack = searchRow("10000000-0000-5000-8000-000000000003", [
  [watches, "Watches"],
]);
const rows = [pokemonPack, nbaPack, watchesPack];

describe("category facet ancestry", () => {
  test("leaf-only pack IDs still emit parent categories for the filter tree", () => {
    const facets = contextualFacets(rows, rows, emptyFilters, "", hierarchy);
    const byLabel = Object.fromEntries(
      facets.categories.map((facet) => [facet.label, facet]),
    );

    expect(byLabel["Trading Cards"]).toMatchObject({
      key: tradingCards,
      parentKey: null,
      depth: 0,
      repackCount: 2,
    });
    expect(byLabel.Pokemon).toMatchObject({
      key: pokemon,
      parentKey: tradingCards,
      depth: 1,
      repackCount: 1,
    });
    expect(byLabel.Sports).toMatchObject({
      key: sports,
      parentKey: tradingCards,
      depth: 1,
      repackCount: 1,
    });
    expect(byLabel.Basketball).toMatchObject({
      key: basketball,
      parentKey: sports,
      depth: 2,
      repackCount: 1,
    });
    expect(byLabel.NBA).toMatchObject({
      key: nba,
      parentKey: basketball,
      depth: 3,
      repackCount: 1,
    });
    expect(byLabel.Watches).toMatchObject({
      key: watches,
      parentKey: null,
      depth: 0,
      repackCount: 1,
    });
  });

  test("selecting a parent returns descendant packs and stays a known selection", () => {
    const filters: PublicRepackFilters = {
      ...emptyFilters,
      categories: [tradingCards],
    };
    expect(selectionsAreKnown(rows, filters, hierarchy)).toBe(true);
    expect(
      matchingRepackRows(rows, filters, "", hierarchy).map(
        ({ publicRepackId }) => publicRepackId,
      ),
    ).toEqual([
      pokemonPack.publicRepackId,
      nbaPack.publicRepackId,
    ]);
  });

  test("an unrelated category id is not a known selection", () => {
    expect(
      selectionsAreKnown(
        rows,
        {
          ...emptyFilters,
          categories: ["20000000-0000-5000-8000-000000000099"],
        },
        hierarchy,
      ),
    ).toBe(false);
  });
});
