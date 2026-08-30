import { renderStatic } from "@/lib/component-render.test-support";
import assert from "node:assert/strict";
import { test } from "node:test";
import { publicRepackViewSummaryV3FromDetail } from "@packscout/contracts";
import {
  buildV3ListPage,
  buildV3LastKnownEv,
  buildV3PastDeadlineCurrentEv,
  buildV3ReleaseIdentity,
  buildV3SoldOutViewDetail,
  buildV3UnavailableEv,
  buildV3ViewDetail,
} from "@/lib/packscout-ev-fixtures.test-support";
import { SavedItemsContext, unavailableSavedItemsValue } from "@/components/auth/SavedItemsContext.client";
import {
  PackScoutAuthContext,
  unavailableAuthValue,
} from "@/components/auth/AuthContext.client";
import { AllRepacksCards } from "./AllRepacksCards.client";
import { AllRepacksTable } from "./AllRepacksTable.client";
import { OpportunityTable } from "./OpportunityTable.client";
import { RepackInspector } from "./PackInspector.client";
import type { ReactElement } from "react";

const noop = () => undefined;

function withProviders(element: ReactElement): ReactElement {
  return (
    <PackScoutAuthContext.Provider value={unavailableAuthValue}>
      <SavedItemsContext.Provider value={unavailableSavedItemsValue}>
        {element}
      </SavedItemsContext.Provider>
    </PackScoutAuthContext.Provider>
  );
}

function renderOpportunityTable(detail = buildV3ViewDetail()): string {
  return renderStatic(
    <OpportunityTable
      onSelectOpportunity={noop}
      opportunities={[publicRepackViewSummaryV3FromDetail(detail)]}
      repacksHref="/packs"
      selectedPublicRepackId={detail.publicRepackId}
    />,
  );
}

function renderAllRepacksTable(
  details = [buildV3ViewDetail()],
): string {
  return renderStatic(
    <AllRepacksTable
      onCopyPromo={noop}
      onOpenRepack={noop}
      onSelect={noop}
      onSort={noop}
      page={buildV3ListPage(details)}
      repackHrefById={new Map()}
      selectedPublicRepackId={details[0]?.publicRepackId ?? null}
    />,
  );
}

function renderInspector(detail = buildV3ViewDetail()): string {
  return renderStatic(
    withProviders(
      <RepackInspector release={buildV3ReleaseIdentity()} repack={detail} />,
    ),
  );
}

const EXPECTED_METRIC_VALUES = ["$85.00", "85.00%", "-$15.00", "-15.00%"] as const;

test("all three surfaces render the same four metrics from the shared boundary", () => {
  const detail = buildV3ViewDetail();
  const surfaces = {
    opportunities: renderOpportunityTable(detail),
    allRepacks: renderAllRepacksTable([detail]),
    inspector: renderInspector(detail),
  };

  for (const [surface, markup] of Object.entries(surfaces)) {
    // EV $ and EV % appear identically everywhere.
    assert.ok(markup.includes("-$15.00"), `${surface} EV $`);
    assert.ok(markup.includes("-15.00%"), `${surface} EV %`);
    // Pack Price presentation is shared too.
    assert.ok(markup.includes("$100.00"), `${surface} price`);
    // Uniform buyback shows the exact rate on every surface.
    assert.ok(markup.includes("85%"), `${surface} buyback`);
  }
  for (const value of EXPECTED_METRIC_VALUES) {
    assert.ok(surfaces.allRepacks.includes(value), `all repacks ${value}`);
    assert.ok(surfaces.inspector.includes(value), `inspector ${value}`);
  }
});

test("the opportunity surface is labeled as ranked by EV $ from the server", () => {
  const markup = renderOpportunityTable();
  assert.ok(markup.includes("Ranked by EV $"));
  assert.ok(markup.includes("Top opportunities"));
  assert.match(markup, /aria-label="Top opportunities comparison"/);
  assert.match(markup, /tabindex="0"/i);
  assert.match(markup, /aria-pressed="true"/);
});

test("unavailable estimates render the reason on every surface, never zero or vendor EV", () => {
  const detail = buildV3ViewDetail({
    buyback: { kind: "not_documented" },
    evEstimates: {
      packScout: buildV3UnavailableEv("BUYBACK_UNAVAILABLE"),
      vendorReported: {
        status: "available",
        sourceMoney: { minorUnits: 9_000, currency: "USD" },
        usdComparison: {
          status: "available",
          value: { minorUnits: 9_000, currency: "USD" },
        },
        observedAt: "2026-08-19T10:00:00.000Z",
      },
    },
  });
  const table = renderAllRepacksTable([detail]);
  const inspector = renderInspector(detail);

  for (const markup of [table, inspector]) {
    assert.ok(
      markup.includes("Unavailable: documented buyback terms are unavailable."),
    );
    // Vendor EV stays present but separately labeled — never as PackScout EV.
    assert.ok(markup.includes("$90.00"));
    assert.ok(markup.includes("Reported by vendor — separate from PackScout Gross EV"));
  }
  // Not documented buyback shows the bounded summary, not a number.
  assert.ok(table.includes("Not documented"));
  // The PackScout gross cell shows Unavailable, never the vendor $90.00 value
  // in its place and never a fabricated $0.00.
  assert.equal(table.includes("$0.00"), false);
  assert.equal(inspector.includes("$0.00"), false);
});

test("sold-out historical rows stay visible with no outbound action", () => {
  const detail = buildV3SoldOutViewDetail();
  const table = renderAllRepacksTable([detail]);
  const inspector = renderInspector(detail);

  assert.ok(table.includes("Sold out"));
  assert.ok(table.includes("Sold out · historical estimate"));
  assert.ok(table.includes("$85.00"));
  // Row actions collapse to the inert text, not a link or enabled button.
  assert.ok(table.includes("Not available"));
  assert.equal(table.includes("Open repack <"), false);

  assert.ok(inspector.includes("Sold out · historical estimate"));
  assert.equal(inspector.includes("Opens the vendor listing"), false);
});

test("server render keeps a current estimate before hydration even past its deadline", () => {
  // This estimate's public deadline is firmly in the past relative to the
  // real test clock, yet the server snapshot must still render the served
  // values so hydration never disagrees with the server HTML. Confidence
  // ages in the browser after hydration through the shared clock.
  const detail = buildV3ViewDetail({
    evEstimates: {
      packScout: buildV3PastDeadlineCurrentEv(8_500),
      vendorReported: {
        status: "unavailable",
        sourceMoney: null,
        usdComparison: null,
        observedAt: null,
        reason: "NOT_REPORTED",
      },
    },
  });
  assert.ok(
    Date.parse("2026-08-18T11:00:00.000Z") < Date.now(),
    "fixture deadline must be in the past for this proof",
  );
  const markup = renderAllRepacksTable([detail]);
  assert.ok(markup.includes("-$15.00"));
  assert.ok(markup.includes("$85.00"));
  assert.equal(markup.includes("Expired"), false);
});

test("tables expose sortable headers with aria-sort and glossary help", () => {
  const markup = renderAllRepacksTable();
  assert.match(markup, /aria-sort="descending"/);
  assert.ok(markup.includes("Gross EV $"));
  assert.ok(markup.includes("Gross EV %"));
  assert.ok(markup.includes("EV Confidence"));
  assert.ok(markup.includes("Vendor EV"));
  // The retired vendor percent sort has no header control.
  assert.equal(markup.includes("Vendor EV %"), false);
  assert.match(
    markup,
    /aria-label="All Repacks comparison table. Scroll horizontally for all fields."/,
  );
});

test("the inspector names the release data-as-of time and keeps focusable close affordances", () => {
  const markup = renderStatic(
    withProviders(
      <RepackInspector
        onClose={noop}
        release={buildV3ReleaseIdentity()}
        repack={buildV3ViewDetail()}
      />,
    ),
  );
  assert.ok(markup.includes("Repack data as of "));
  assert.match(markup, /aria-label="Close repack details"/);
  assert.match(markup, /role="complementary"/);
  assert.ok(markup.includes("How this estimate works"));
});


test("all four catalog surfaces retain aged values and a visible zero-confidence state", () => {
  const original = buildV3ViewDetail();
  const detail = buildV3ViewDetail({
    evEstimates: { ...original.evEstimates, packScout: buildV3LastKnownEv(8_500, {
      referenceTimeIso: "2026-08-20T12:00:00.000Z",
      latestUnavailableReason: "ODDS_UNAVAILABLE",
    }) },
  });
  const surfaces = [
    renderOpportunityTable(detail), renderAllRepacksTable([detail]), renderInspector(detail),
    renderStatic(<AllRepacksCards controls={null} onSelect={noop}
      page={buildV3ListPage([detail])} selectedPublicRepackId={null} />),
  ];
  for (const markup of surfaces) {
    assert.ok(markup.includes("-$15.00"));
    assert.ok(markup.includes("-15.00%"));
    assert.ok(markup.includes("Low · 0%"));
    assert.ok(markup.includes("Last known estimate"));
    assert.ok(markup.includes("Fresh calculation unavailable"));
    assert.equal(markup.includes("Expired"), false);
  }
});
