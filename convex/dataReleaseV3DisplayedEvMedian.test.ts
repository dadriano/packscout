import { expect, test } from "vitest";
import { buildV3Detail, buildV3UnavailableEv, V3_OBSERVED_AT } from "./dataReleaseV3Fixture.test-support";
import { medianDisplayedEvPercent } from "./dataReleaseV3DisplayedEvMedian";
import { dataReleaseV3SearchRowFromDetail } from "./dataReleaseV3Search";

test.each([false, true])("displayed medians resolve source EV with legacy snapshot %s", (legacyEvSnapshot) => {
  const unavailable = buildV3UnavailableEv("SOURCE_EVIDENCE_UNAVAILABLE");
  const detail = buildV3Detail({ vendorKey: "phygitals",
    buyback: { kind: "uniform_rate", rateBasisPoints: 9_000 },
    evEstimates: { packScout: unavailable, vendorReported: {
      status: "available", sourceMoney: { minorUnits: 12_000, currency: "USD" },
      usdComparison: { status: "available", value: { minorUnits: 12_000, currency: "USD" } },
      observedAt: V3_OBSERVED_AT,
    } },
  });
  const row = dataReleaseV3SearchRowFromDetail(detail);
  const context = { legacyEvSnapshot,
    evByPublicId: new Map(legacyEvSnapshot ? [] : [[detail.publicRepackId, unavailable]]) };
  expect(medianDisplayedEvPercent([row], context)).toEqual({ status: "available", basisPoints: 800 });
  expect(medianDisplayedEvPercent([], context)).toEqual({
    status: "unavailable", basisPoints: null, reason: "ESTIMATE_UNAVAILABLE",
  });
  if (!legacyEvSnapshot) {
    // Missing migrated display authority must not admit a source fallback.
    expect(medianDisplayedEvPercent([row], { ...context, evByPublicId: new Map() }).status).toBe("unavailable");
  }
});
