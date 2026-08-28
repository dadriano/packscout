import { renderStatic } from "@/lib/component-render.test-support";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildV3ListPage,
  buildV3ReleaseIdentity,
  buildV3SoldOutViewDetail,
  buildV3ViewDetail,
} from "@/lib/packscout-ev-fixtures.test-support";
import { publicRowActions } from "@/lib/all-repacks-table";
import {
  PackScoutAuthContext,
  unavailableAuthValue,
} from "@/components/auth/AuthContext.client";
import {
  SavedItemsContext,
  unavailableSavedItemsValue,
} from "@/components/auth/SavedItemsContext.client";
import { AllRepacksTable } from "./AllRepacksTable.client";
import { RepackInspector } from "./PackInspector.client";
import { buildPublishedRepackHref } from "./pack-actions.client";
import { publicRepackViewSummaryV3FromDetail } from "@packscout/contracts";
import type { ReactElement } from "react";

/**
 * Pack availability and promo availability are separate axes. The
 * data_release_v3 contract governs promos by `actionAvailability` alone and
 * gates only the outbound purchase link on a purchasable pack, so a pack the
 * platform no longer presents as buyable stays discoverable with its promo
 * intact and loses exactly one thing: the way to buy it.
 */

const noop = () => undefined;
const promoOnlyActions = {
  actionAvailability: { promo: true, repackLink: false },
  actions: { promo: { code: "SCOUT", label: "Use SCOUT" } },
} as const;

function withProviders(element: ReactElement): ReactElement {
  return (
    <PackScoutAuthContext.Provider value={unavailableAuthValue}>
      <SavedItemsContext.Provider value={unavailableSavedItemsValue}>
        {element}
      </SavedItemsContext.Provider>
    </PackScoutAuthContext.Provider>
  );
}

function renderSurfaces(detail: ReturnType<typeof buildV3ViewDetail>) {
  return {
    table: renderStatic(
      <AllRepacksTable
        onCopyPromo={noop}
        onOpenRepack={noop}
        onSelect={noop}
        onSort={noop}
        page={buildV3ListPage([detail])}
        repackHrefById={new Map()}
        selectedPublicRepackId={detail.publicRepackId}
      />,
    ),
    inspector: renderStatic(
      withProviders(
        <RepackInspector release={buildV3ReleaseIdentity()} repack={detail} />,
      ),
    ),
  };
}

test("a sold-out pack keeps its published promo and never an outbound purchase link", () => {
  const detail = buildV3SoldOutViewDetail(promoOnlyActions);
  const { table, inspector } = renderSurfaces(detail);

  assert.deepEqual(
    publicRowActions(publicRepackViewSummaryV3FromDetail(detail)),
    { promo: true, repackLink: false },
  );
  assert.ok(table.includes("Sold out"));
  assert.ok(table.includes("Copy promo"));
  assert.equal(table.includes("Open repack"), false);

  assert.ok(inspector.includes("Use SCOUT"));
  assert.ok(inspector.includes("Copy promo"));
  assert.equal(inspector.includes("Visit repack"), false);
  assert.equal(inspector.includes("Opens the vendor listing"), false);
  assert.equal(inspector.includes("utm_source=packscout"), false);
});

test("an unavailable pack keeps its published promo and never an outbound purchase link", () => {
  const detail = buildV3ViewDetail({
    availability: "unavailable",
    ...promoOnlyActions,
  });
  const { table, inspector } = renderSurfaces(detail);

  assert.deepEqual(
    publicRowActions(publicRepackViewSummaryV3FromDetail(detail)),
    { promo: true, repackLink: false },
  );
  assert.ok(table.includes("Unavailable"));
  assert.ok(table.includes("Copy promo"));
  assert.equal(table.includes("Open repack"), false);

  assert.ok(inspector.includes("Use SCOUT"));
  assert.ok(inspector.includes("Copy promo"));
  assert.equal(inspector.includes("Visit repack"), false);
  assert.equal(inspector.includes("utm_source=packscout"), false);
});

test("the outbound gate refuses every non-available pack even when a link is supplied", () => {
  const link = {
    listingUrl: "https://vendor.example/listing/alpha",
    listingHost: "vendor.example",
    referralParameters: [{ name: "utm_source", value: "packscout" }],
  };

  assert.deepEqual(buildPublishedRepackHref(link, "sold_out"), {
    ok: false,
    code: "SOLD_OUT",
  });
  assert.deepEqual(buildPublishedRepackHref(link, "unavailable"), {
    ok: false,
    code: "UNAVAILABLE",
  });
  assert.deepEqual(buildPublishedRepackHref(link, "unknown"), {
    ok: false,
    code: "AVAILABILITY_UNKNOWN",
  });
  assert.equal(buildPublishedRepackHref(link, "available").ok, true);
});
