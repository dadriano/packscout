import { renderStatic } from "@/lib/component-render.test-support";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  presentPackScoutEvV3,
  type PackScoutEvV3PresentationInput,
} from "@/lib/packscout-ev-presentation";
import {
  buildV3CurrentEv,
  buildV3DelayedEv,
  buildV3ExpiredEv,
  buildV3LastKnownEv,
  buildV3Price,
  buildV3SoldOutEv,
  buildV3UnavailableEv,
} from "@/lib/packscout-ev-fixtures.test-support";
import { PackScoutEvMetrics } from "./PackScoutEvMetrics";

function render(
  estimate: PackScoutEvV3PresentationInput["estimate"],
  overrides: Partial<PackScoutEvV3PresentationInput> = {},
): string {
  return renderStatic(
    <PackScoutEvMetrics
      presentation={presentPackScoutEvV3({
        estimate,
        price: buildV3Price(),
        availability: "available",
        ...overrides,
      })}
    />,
  );
}

test("renders the four metrics, price, status, source, and advice lines", () => {
  const markup = render(buildV3CurrentEv(8_500));

  for (const fragment of [
    "Gross EV $",
    "$85.00",
    "Gross EV %",
    "85.00%",
    "EV $",
    "-$15.00",
    "EV %",
    "-15.00%",
    "Pack Price",
    "$100.00",
    "Current estimate",
    "EV confidence",
    "High · 100%",
    "PackScout Gross EV — calculated from platform-provided data",
    "Not financial or gambling advice",
  ]) {
    assert.ok(markup.includes(fragment), fragment);
  }
  // Semantic state is text, not color alone.
  assert.match(markup, /Negative/);
  assert.match(markup, /data-state="negative"/);
});

test("unavailable estimates show the stable reason and never a zero", () => {
  const markup = render(buildV3UnavailableEv("BUYBACK_UNAVAILABLE"));

  assert.ok(markup.includes("Unavailable: documented buyback terms are unavailable."));
  assert.ok(markup.includes("Unavailable"));
  assert.equal(markup.includes("$0.00"), false);
  // The Pack Price stays visible while the estimate is unavailable.
  assert.ok(markup.includes("$100.00"));
});

test("stale evidence without retained values is unavailable", () => {
  const markup = render(buildV3ExpiredEv());
  assert.ok(markup.includes("Unavailable"));
  assert.ok(markup.includes("Source data is older than 60 minutes."));
  assert.match(markup, /data-status="unavailable"/);
});

test("sold-out historical estimates keep values with sold-out wording", () => {
  const markup = render(buildV3SoldOutEv(8_500), { availability: "sold_out" });
  assert.ok(markup.includes("Sold out · historical estimate"));
  assert.ok(markup.includes("$85.00"));
  assert.match(markup, /Sold out Aug 19, 2026/);
});

test("delayed source age renders the delayed freshness text", () => {
  const markup = render(buildV3DelayedEv(8_500));
  assert.ok(markup.includes("Source data delayed (15–30 minutes old)"));
  assert.ok(markup.includes("Calculated "));
  assert.ok(markup.includes("Source data as of "));
});

test("a valid zero payout renders $0.00 with the explicit note", () => {
  const markup = render(buildV3CurrentEv(0));
  assert.ok(markup.includes("$0.00"));
  assert.ok(
    markup.includes(
      "Valid $0.00 payout: every supported outcome pays no guaranteed buyback.",
    ),
  );
});

test("simulated listings render the simulated chip", () => {
  const markup = render(buildV3CurrentEv(8_500), {
    repackName: "[Simulated] Pokemon Grail Gacha",
  });
  assert.ok(markup.includes("Simulated data"));
});


test("last known values remain rendered with zero confidence, failure reason, and original price", () => {
  const markup = render(buildV3LastKnownEv(8_500, { latestUnavailableReason: "BUYBACK_UNAVAILABLE" }), {
    price: buildV3Price(20_000),
  });
  for (const text of ["Last known estimate", "$85.00", "-$15.00", "Low · 0%",
    "Fresh calculation unavailable", "calculation-time Pack Price of $100.00", "$200.00"]) {
    assert.ok(markup.includes(text), text);
  }
  assert.match(markup, /datetime="2026-08-19T10:00:00.000Z"/i);
});
