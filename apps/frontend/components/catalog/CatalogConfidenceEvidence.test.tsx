import assert from "node:assert/strict";
import { test } from "node:test";
import { renderStatic } from "@/lib/component-render.test-support";
import {
  buildV3CurrentEv,
  buildV3DelayedEv,
  buildV3DelayedProviderHealth,
  buildV3LastKnownEv,
  buildV3ViewDetail,
} from "@/lib/packscout-ev-fixtures.test-support";
import { presentPackScoutEvV3 } from "@/lib/packscout-ev-presentation";
import { presentProviderHealthV3 } from "@/lib/provider-health-presentation";
import {
  CatalogConfidenceEvidence,
  catalogConfidenceEvidenceDetails,
} from "./CatalogConfidenceEvidence.client";

function presentEstimate(detail = buildV3ViewDetail()) {
  return presentPackScoutEvV3({
    estimate: detail.evEstimates.packScout,
    price: detail.price,
    availability: detail.availability,
    repackName: detail.name,
  });
}

test("healthy current confidence needs no evidence disclosure", () => {
  const detail = buildV3ViewDetail({
    evEstimates: {
      ...buildV3ViewDetail().evEstimates,
      packScout: buildV3CurrentEv(8_500),
    },
  });
  const estimate = presentEstimate(detail);
  const providerHealth = presentProviderHealthV3(detail.providerHealth);

  assert.deepEqual(
    catalogConfidenceEvidenceDetails({ estimate, providerHealth }),
    [],
  );
  const markup = renderStatic(
    <CatalogConfidenceEvidence
      estimate={estimate}
      providerHealth={detail.providerHealth}
      repackName={detail.name}
    />,
  );
  assert.ok(markup.includes("High · 100%"));
  assert.equal(markup.includes("View evidence for"), false);
});

test("shared evidence includes every non-current and provider detail", () => {
  const original = buildV3ViewDetail();
  const detail = buildV3ViewDetail({
    price: {
      displayMoney: { minorUnits: 20_000, currency: "USD" },
      usdComparison: {
        status: "available",
        value: { minorUnits: 20_000, currency: "USD" },
      },
    },
    providerHealth: buildV3DelayedProviderHealth(),
    evEstimates: {
      ...original.evEstimates,
      packScout: buildV3LastKnownEv(8_500, {
        referenceTimeIso: "2026-08-20T12:00:00.000Z",
        latestUnavailableReason: "ODDS_UNAVAILABLE",
      }),
    },
  });
  const details = catalogConfidenceEvidenceDetails({
    estimate: presentEstimate(detail),
    providerHealth: presentProviderHealthV3(detail.providerHealth),
  });

  for (const expected of [
    "Last-known estimate",
    "Source data over 60 minutes old; last known values retained",
    "Source evidence last observed",
    "Fresh calculation unavailable",
    "calculation-time Pack Price of $100.00",
    "Provider feed delayed; displaying the latest available data.",
    "Provider health observed",
  ]) {
    assert.ok(
      details.some((detailText) => detailText.includes(expected)),
      `missing evidence detail: ${expected}`,
    );
  }
});

test("provider-only disruption receives the same accessible disclosure", () => {
  const detail = buildV3ViewDetail({
    evEstimates: {
      ...buildV3ViewDetail().evEstimates,
      packScout: buildV3CurrentEv(8_500),
    },
    providerHealth: buildV3DelayedProviderHealth(),
  });
  const markup = renderStatic(
    <CatalogConfidenceEvidence
      estimate={presentEstimate(detail)}
      providerHealth={detail.providerHealth}
      repackName={detail.name}
    />,
  );

  assert.match(
    markup,
    /aria-label="View evidence for Provider feed delayed: [^"]+"/,
  );
  assert.match(markup, /aria-expanded="false"/);
});

test("delayed current source evidence receives a disclosure", () => {
  const detail = buildV3ViewDetail({
    evEstimates: {
      ...buildV3ViewDetail().evEstimates,
      packScout: buildV3DelayedEv(8_500),
    },
  });
  const estimate = presentEstimate(detail);
  const details = catalogConfidenceEvidenceDetails({
    estimate,
    providerHealth: presentProviderHealthV3(detail.providerHealth),
  });

  assert.ok(details.some((item) => item.includes("Source data delayed (15–30 minutes old)")));
  assert.ok(details.some((item) => item.includes("Source evidence last observed")));
  assert.equal(details.includes("Current estimate"), false);
  const markup = renderStatic(
    <CatalogConfidenceEvidence
      estimate={estimate}
      providerHealth={detail.providerHealth}
      repackName={detail.name}
    />,
  );
  assert.match(
    markup,
    /aria-label="View evidence for Delayed source evidence: [^"]+"/,
  );
});
