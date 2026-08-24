import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicRepackSummary } from "@packscout/contracts";
import {
  ALL_REPACKS_HEADERS,
  catalogHeaderAriaSort,
  nextCatalogSortDirection,
  publicRowActions,
} from "./all-repacks-table";

test("the repack table exposes both EV sources and PackScout confidence", () => {
  assert.deepEqual(
    ALL_REPACKS_HEADERS.map(({ label }) => label),
    [
      "Vendor",
      "Category",
      "Repack",
      "Repack Price",
      "EV $",
      "EV %",
      "EV Confidence",
      "Vendor EV %",
      "Buyback %",
      "Gross EV",
      "Top Chase",
      "Top Chase Value",
      "Promo Code",
      "Repack Link",
    ],
  );
});

test("sort headers toggle deterministically and disappear during relevance order", () => {
  const evHeader = ALL_REPACKS_HEADERS.find(
    ({ sort }) => sort === "packscout_ev_dollars",
  )!;
  assert.equal(
    catalogHeaderAriaSort(evHeader, "packscout_ev_dollars", "desc", ""),
    "descending",
  );
  assert.equal(
    catalogHeaderAriaSort(evHeader, "packscout_ev_dollars", "desc", "pokemon"),
    undefined,
  );
  assert.equal(
    nextCatalogSortDirection(
      "packscout_ev_dollars",
      "desc",
      "packscout_ev_dollars",
    ),
    "asc",
  );
  assert.equal(
    nextCatalogSortDirection("packscout_ev_dollars", "desc", "repack"),
    "asc",
  );
  assert.equal(
    nextCatalogSortDirection("repack", "asc", "packscout_gross_ev"),
    "desc",
  );
});

test("only available rows expose purchase-oriented actions", () => {
  for (const availability of ["unavailable", "unknown", "sold_out"] as const) {
    const repack = {
      availability,
      actionAvailability: { promo: true, repackLink: true },
    } as PublicRepackSummary;
    assert.deepEqual(publicRowActions(repack), {
      promo: false,
      repackLink: false,
    });
  }
  assert.deepEqual(
    publicRowActions({
      availability: "available",
      actionAvailability: { promo: true, repackLink: true },
    } as PublicRepackSummary),
    { promo: true, repackLink: true },
  );
});
