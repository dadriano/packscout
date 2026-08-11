import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicPackSummary } from "@packscout/contracts";
import {
  ALL_PACKS_HEADERS,
  catalogHeaderAriaSort,
  nextCatalogSortDirection,
  publicRowActions,
} from "./all-packs-table";

test("the catalog exposes the exact twelve comparison fields", () => {
  assert.deepEqual(
    ALL_PACKS_HEADERS.map(({ label }) => label),
    [
      "Platform",
      "Category",
      "Pack",
      "Pack Price",
      "EV $",
      "EV %",
      "Buyback %",
      "Gross EV",
      "Top Chase",
      "Top Chase Value",
      "Promo Code",
      "Pack Link",
    ],
  );
});

test("sort headers toggle deterministically and disappear during relevance order", () => {
  const evHeader = ALL_PACKS_HEADERS.find(({ sort }) => sort === "ev_dollars")!;
  assert.equal(catalogHeaderAriaSort(evHeader, "ev_dollars", "desc", ""), "descending");
  assert.equal(catalogHeaderAriaSort(evHeader, "ev_dollars", "desc", "pokemon"), undefined);
  assert.equal(nextCatalogSortDirection("ev_dollars", "desc", "ev_dollars"), "asc");
  assert.equal(nextCatalogSortDirection("ev_dollars", "desc", "pack"), "asc");
  assert.equal(nextCatalogSortDirection("pack", "asc", "gross_ev"), "desc");
});

test("sold-out rows never expose an outbound pack action", () => {
  const pack = {
    availability: "sold_out",
    actionAvailability: { promo: true, packLink: true },
  } as PublicPackSummary;
  assert.deepEqual(publicRowActions(pack), { promo: true, packLink: false });
});
