import { renderStatic } from "@/lib/component-render.test-support";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  presentPackScoutEvV3,
  type PackScoutEvV3PresentationInput,
} from "@/lib/packscout-ev-presentation";
import {
  buildV3CurrentPresentation,
  buildV3DelayedPresentation,
  buildV3HistoricalPresentation,
  buildV3LastKnownPresentation,
  buildV3Price,
  buildV3UnavailablePresentation,
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
  const markup = render(buildV3CurrentPresentation(8_500));

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
  const markup = render(buildV3UnavailablePresentation("BUYBACK_UNAVAILABLE"));

  assert.ok(markup.includes("Unavailable: documented buyback terms are unavailable."));
  assert.ok(markup.includes("Unavailable"));
  assert.equal(markup.includes("$0.00"), false);
  // The Pack Price stays visible while the estimate is unavailable.
  assert.ok(markup.includes("$100.00"));
});

test("last-known estimates keep values, observed time, and decayed confidence", () => {
  const markup = render(buildV3LastKnownPresentation());
  assert.ok(markup.includes("Last-known estimate"));
  assert.ok(markup.includes("$85.00"));
  assert.ok(markup.includes("Medium · 72%"));
  assert.ok(markup.includes("Source evidence last observed"));
  assert.match(markup, /data-status="last_known"/);
});

test("sold-out historical estimates keep values with sold-out wording", () => {
  const markup = render(buildV3HistoricalPresentation(8_500), {
    availability: "sold_out",
  });
  assert.ok(markup.includes("Sold out · historical estimate"));
  assert.ok(markup.includes("$85.00"));
  assert.match(markup, /Sold out Aug 19, 2026/);
});

test("delayed source age renders the delayed freshness text", () => {
  const markup = render(buildV3DelayedPresentation(8_500));
  assert.ok(markup.includes("Source data delayed (15–30 minutes old)"));
  assert.ok(markup.includes("Calculated "));
  assert.ok(markup.includes("Source evidence last observed "));
});

test("a valid zero payout renders $0.00 with the explicit note", () => {
  const markup = render(buildV3CurrentPresentation(0));
  assert.ok(markup.includes("$0.00"));
  assert.ok(
    markup.includes(
      "Valid $0.00 payout: every supported outcome pays no guaranteed buyback.",
    ),
  );
});

test("simulated listings render the simulated chip", () => {
  const markup = render(buildV3CurrentPresentation(8_500), {
    repackName: "[Simulated] Pokemon Grail Gacha",
  });
  assert.ok(markup.includes("Simulated data"));
});
