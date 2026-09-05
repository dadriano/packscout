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
  buildV3SoldOutEv,
  buildV3LastKnownEv,
  buildV3Price,
  buildV3UnavailableEv,
} from "@/lib/packscout-ev-fixtures.test-support";
import { confidenceEvidenceDetails, PackScoutEvMetrics } from "./PackScoutEvMetrics";

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

function evidence(
  estimate: PackScoutEvV3PresentationInput["estimate"],
  overrides: Partial<PackScoutEvV3PresentationInput> = {},
): string {
  return confidenceEvidenceDetails(presentPackScoutEvV3({
    estimate,
    price: buildV3Price(),
    availability: "available",
    ...overrides,
  })).join("\n");
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
  // Semantic state is text, not color alone: the accessible label carries it.
  assert.match(markup, /Negative/);
  assert.match(markup, /data-state="negative"/);
  // Every public EV is at or below zero, so no visible "Negative" word repeats
  // beside EV $; the sign and tone carry it for sighted readers.
  assert.equal(markup.includes('class="stateLabel"'), false);
});

test("unavailable estimates show the stable reason and never a zero", () => {
  const markup = render(buildV3UnavailableEv("BUYBACK_UNAVAILABLE"));

  assert.ok(markup.includes("Unavailable: documented buyback terms are unavailable."));
  assert.ok(markup.includes("Unavailable"));
  assert.equal(markup.includes("$0.00"), false);
  // The Pack Price stays visible while the estimate is unavailable.
  assert.ok(markup.includes("$100.00"));
});

test("last-known estimates keep values, observed time, and decayed confidence", () => {
  const markup = render(buildV3LastKnownEv());
  assert.ok(markup.includes("Last-known estimate"));
  assert.ok(markup.includes("$85.00"));
  assert.ok(markup.includes("Medium · 50%"));
  assert.ok(evidence(buildV3LastKnownEv()).includes("Source evidence last observed"));
  assert.equal(markup.includes("Source evidence last observed"), false);
  assert.match(markup, /data-status="last_known"/);
});

test("sold-out historical estimates keep values with sold-out wording", () => {
  const markup = render(buildV3SoldOutEv(8_500), {
    availability: "sold_out",
  });
  assert.ok(markup.includes("Sold out · historical estimate"));
  assert.ok(markup.includes("$85.00"));
  assert.match(evidence(buildV3SoldOutEv(8_500), { availability: "sold_out" }), /Sold out/);
  assert.equal(markup.includes("<dt>Sold out</dt>"), false);
});

test("delayed source age and timestamps are available from the confidence value", () => {
  const markup = render(buildV3DelayedEv(8_500));
  assert.ok(markup.includes("Source data delayed (15–30 minutes old)"));
  const details = evidence(buildV3DelayedEv(8_500));
  for (const label of ["Calculated", "Source evidence last observed", "Confidence evaluated"]) {
    assert.ok(details.includes(label), label);
    assert.equal(markup.includes(`<dt>${label}</dt>`), false);
  }
  assert.match(markup, /aria-label="PackScout EV confidence: [^"]+ View confidence evidence\."/);
  assert.match(markup, /aria-expanded="false"/);
});

test("a valid zero payout stays numeric with its explanation in confidence evidence", () => {
  const markup = render(buildV3CurrentEv(0));
  assert.ok(markup.includes("$0.00"));
  assert.ok(
    evidence(buildV3CurrentEv(0)).includes(
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
  for (const text of ["Last-known estimate", "$85.00", "-$15.00", "Low · 0%", "$200.00"]) {
    assert.ok(markup.includes(text), text);
  }
  const details = evidence(buildV3LastKnownEv(8_500, { latestUnavailableReason: "BUYBACK_UNAVAILABLE" }), {
    price: buildV3Price(20_000),
  });
  for (const text of ["Fresh calculation unavailable", "calculation-time Pack Price of $100.00", "Calculated", "Source evidence last observed"]) {
    assert.ok(details.includes(text), text);
  }
});
