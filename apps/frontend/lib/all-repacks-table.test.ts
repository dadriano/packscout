import assert from "node:assert/strict";
import { test } from "node:test";
import type { PublicRepackSummaryV3 } from "@packscout/contracts";
import {
  ALL_REPACKS_HEADERS,
  catalogHeaderAriaSort,
  nextCatalogSortDirection,
  publicRowActions,
} from "./all-repacks-table";

test("the table shows the four PackScout metrics together with both EV sources", () => {
  assert.deepEqual(
    ALL_REPACKS_HEADERS.map(({ label }) => label),
    [
      "Vendor",
      "Category",
      "Repack",
      "Pack Price",
      "Gross EV $",
      "Gross EV %",
      "EV $",
      "EV %",
      "EV Confidence",
      "Buyback %",
      "Vendor EV",
      "Top Chase",
      "Top Chase Value",
      "Promo Code",
      "Repack Link",
    ],
  );
});

test("the retired pre-buyback vendor EV percent sort is gone, not remapped", () => {
  assert.equal(
    ALL_REPACKS_HEADERS.some(
      ({ sort }) => sort === "vendor_reported_ev_percent",
    ),
    false,
  );
  const vendorEv = ALL_REPACKS_HEADERS.find(
    ({ key }) => key === "vendorReportedEv",
  );
  assert.ok(vendorEv);
  assert.equal(vendorEv.sort, undefined);
  assert.deepEqual(
    ALL_REPACKS_HEADERS.flatMap(({ sort }) => (sort ? [sort] : [])),
    [
      "repack",
      "repack_price",
      "packscout_gross_ev",
      "packscout_ev_dollars",
      "packscout_ev_percent",
      "packscout_confidence",
      "buyback_percent",
      "top_chase_value",
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

test("sold-out rows never expose an outbound repack action", () => {
  const repack = {
    availability: "sold_out",
    actionAvailability: { promo: true, repackLink: true },
  } as PublicRepackSummaryV3;
  assert.deepEqual(publicRowActions(repack), {
    promo: true,
    repackLink: false,
  });
});
