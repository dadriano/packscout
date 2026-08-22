import {
  PUBLIC_REPACK_PRICE_MAX_MINOR,
  PUBLIC_REPACK_PRICE_MIN_MINOR,
  normalizePublicSearchText,
  type PublicPackAvailability,
  type PublicRepackFilters,
  type RepackSearchRow,
} from "@packscout/contracts";
import { describe, expect, test } from "vitest";
import {
  availableRepackRows,
  dashboardKpis,
  deterministicVisibleSelection,
  matchingRepackRows,
  type CategoryHierarchy,
} from "./publicRepackAggregates";

const hierarchy: CategoryHierarchy = new Map();
const allFilters: PublicRepackFilters = {
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
const availableFilters: PublicRepackFilters = {
  ...allFilters,
  availability: "available",
};

function row(
  index: number,
  availability: PublicPackAvailability,
): RepackSearchRow {
  const name = `Pack ${availability}`;
  return {
    publicRepackId: `00000000-0000-5000-8000-${String(index).padStart(12, "0")}`,
    publicVendorId: "00000000-0000-5000-8000-000000000001",
    vendorKey: "courtyard",
    vendorDisplayName: "Courtyard",
    publicCategoryIds: [],
    categoryLabels: [],
    collectibleTypes: [],
    contentMode: "unknown",
    name,
    normalizedName: normalizePublicSearchText(name),
    normalizedVendor: "courtyard",
    normalizedCategories: "",
    availability,
    priceMinor: 10_000,
    priceNullRank: 0,
    vendorReportedGrossEvMinor: null,
    vendorReportedGrossEvNullRank: 1,
    vendorReportedEvDollarsMinor: null,
    vendorReportedEvDollarsNullRank: 1,
    vendorReportedEvPercentBasisPoints: null,
    vendorReportedEvPercentNullRank: 1,
    packScoutGrossEvMinor: 12_000,
    packScoutGrossEvNullRank: 0,
    packScoutEvDollarsMinor: 2_000,
    packScoutEvDollarsNullRank: 0,
    packScoutEvPercentBasisPoints: 2_000,
    packScoutEvPercentNullRank: 0,
    packScoutConfidenceBasisPoints: 8_000,
    packScoutConfidenceNullRank: 0,
    packScoutConfidenceBand: "high",
    buybackBasisPoints: null,
    buybackNullRank: 1,
    topChaseValueMinor: null,
    topChaseNullRank: 1,
    topChaseReason: "CHASE_UNAVAILABLE",
  };
}

const fourStates = [
  row(1, "available"),
  row(2, "unavailable"),
  row(3, "unknown"),
  row(4, "sold_out"),
] as const;

describe("public pack availability query behavior", () => {
  test("the complete catalog retains four exact states while current results retain only available", () => {
    expect(
      matchingRepackRows(fourStates, allFilters, "", hierarchy).map(
        ({ availability }) => availability,
      ),
    ).toEqual(["available", "unavailable", "unknown", "sold_out"]);
    expect(
      matchingRepackRows(fourStates, availableFilters, "", hierarchy).map(
        ({ availability }) => availability,
      ),
    ).toEqual(["available"]);
    expect(availableRepackRows(fourStates)).toEqual([fourStates[0]]);
  });

  test("positive-EV and confidence summaries ignore every non-available pack", () => {
    expect(dashboardKpis(fourStates)).toEqual({
      totalRepacks: 4,
      positiveEvRepacks: 1,
      medianPackScoutEvPercent: {
        status: "available",
        basisPoints: 2_000,
      },
      highestChaseValueUsdMinor: null,
      highConfidenceRepacks: 1,
    });
  });

  test("selection falls back deterministically and a later available revision restores eligibility", () => {
    const selectedId = fourStates[1].publicRepackId;
    const completeCatalog = matchingRepackRows(
      fourStates,
      allFilters,
      "",
      hierarchy,
    );
    expect(
      deterministicVisibleSelection(completeCatalog, selectedId)
        ?.publicRepackId,
    ).toBe(selectedId);

    // Removing the complete-catalog availability opt-in removes the selected
    // unavailable pack and selects the first remaining row deterministically.
    const initiallyVisible = matchingRepackRows(
      fourStates,
      availableFilters,
      "",
      hierarchy,
    );
    expect(
      deterministicVisibleSelection(initiallyVisible, selectedId)
        ?.publicRepackId,
    ).toBe(fourStates[0].publicRepackId);

    const reappeared = { ...fourStates[1], availability: "available" as const };
    const afterReappearance = matchingRepackRows(
      [fourStates[0], reappeared, fourStates[2], fourStates[3]],
      availableFilters,
      "",
      hierarchy,
    );
    expect(
      deterministicVisibleSelection(afterReappearance, selectedId)
        ?.publicRepackId,
    ).toBe(selectedId);
  });
});
