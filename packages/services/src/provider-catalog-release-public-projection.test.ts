import assert from "node:assert/strict";
import test from "node:test";
import { calculatePackScoutEstimatedEv } from "./estimated-ev-calculator.ts";
import {
  estimatedEvCalculationFingerprint,
  type EstimatedEvInputManifest,
} from "./estimated-ev-projection-contracts.ts";
import {
  compareProviderCatalogCodeUnits,
  projectProviderCatalogRelease,
} from "./provider-catalog-release-public-projection.ts";
import {
  providerFixtureApprovedConfiguration,
  providerFixtureCheckpoint,
  providerFixtureSnapshot,
} from "./provider-catalog-release-fixture.test-support.ts";
import type { ProviderCatalogReleaseSourceSnapshot } from "./provider-catalog-release-types.ts";

function project(options: Parameters<typeof providerFixtureSnapshot>[0] = {}) {
  const snapshot = providerFixtureSnapshot(options);
  return projectProviderCatalogRelease({
    configuration: options.configuration ?? providerFixtureApprovedConfiguration(),
    platformKey: "alpha",
    revisions: snapshot.revisions,
    repackIdentities: snapshot.repackIdentities,
  });
}

test("provider projection is stable for shuffled canonical source rows", () => {
  const ordered = project();
  const shuffled = project({ reverseRows: true });

  assert.deepEqual(shuffled, ordered);
  assert.equal(ordered.vendors.length, 1);
  assert.equal(ordered.repacks.length, 1);
  assert.equal(ordered.collectibles.length, 1);
  assert.equal(ordered.repackChases.length, 1);
});

test("provider projection excludes unreferenced shared categories", () => {
  const unrelatedCategory = {
    publicCategoryId: "99999999-9999-5999-8999-999999999999",
    parentPublicCategoryId: null,
    categoryKey: "unrelated",
    name: "Unrelated",
    kind: "vertical" as const,
    depth: 0,
    pathPublicCategoryIds: ["99999999-9999-5999-8999-999999999999"],
    displayOrder: 999,
  };
  const base = providerFixtureApprovedConfiguration();
  const configuration = providerFixtureApprovedConfiguration({
    categories: [...base.categories, unrelatedCategory],
  });

  const projection = project({ configuration });

  assert.equal(projection.categories.length, 2);
  assert.equal(
    projection.categories.some(({ categoryKey }) => categoryKey === "unrelated"),
    false,
  );
});

test("provider projection refuses a foreign platform row", () => {
  assert.throws(
    () => project({ includeForeignRows: true }),
    { message: "CANONICAL_PROJECTION_INVALID" },
  );
});

test("provider code-unit ordering is locale-independent for punctuation", () => {
  const values = ["a_b", "a:b", "a.b", "a-b"];
  assert.deepEqual(
    values.sort(compareProviderCatalogCodeUnits),
    ["a-b", "a.b", "a:b", "a_b"],
  );
});

test("basis points use exact decimal half-up conversion", () => {
  const snapshot = providerFixtureSnapshot();
  const revisions = snapshot.revisions.map((revision) => {
    if (revision.recordKind === "pack") {
      return {
        ...revision,
        content: {
          ...(revision.content as Record<string, unknown>),
          buybackPercent: 70.005,
        },
      };
    }
    if (revision.recordKind === "ev_input") {
      const content = revision.content as Record<string, unknown>;
      return {
        ...revision,
        content: {
          ...content,
          coverage: {
            ...(content.coverage as Record<string, unknown>),
            calculatedCoverage: 0.99995,
            probabilityBucketCount: 2,
          },
          probabilityBuckets: [
            {
              ...((content.probabilityBuckets as readonly Record<string, unknown>[])[0]!),
              probability: 0.10005,
            },
            {
              ...((content.probabilityBuckets as readonly Record<string, unknown>[])[0]!),
              bucketId: "other-bucket",
              probability: 0.8999,
            },
          ],
          readiness: {
            status: "unavailable",
            reasons: [
              "incomplete_probability_coverage",
              "declared_coverage_mismatch",
            ],
          },
        },
      };
    }
    return revision;
  }).filter(({ recordKind }) => recordKind !== "estimated_ev");

  const projection = projectProviderCatalogRelease({
    configuration: providerFixtureApprovedConfiguration(),
    platformKey: "alpha",
    revisions,
    repackIdentities: snapshot.repackIdentities,
  });

  assert.equal(projection.repacks[0]!.buyback.status, "available");
  assert.equal(projection.repacks[0]!.buyback.value?.basisPoints, 7_001);
  assert.equal(
    projection.repacks[0]!.contentSummary.probabilityCoverageBasisPoints,
    10_000,
  );
  assert.equal(projection.repackChases[0]!.probabilityBasisPoints, 1_001);
});

test("EV return conversion stays exact at safe-integer extremes", () => {
  const priceMinor = 1_229_539_150_168_567;
  const grossMinor = 5_505_323_021_837_267;
  const snapshot = providerFixtureSnapshot();
  const estimate = snapshot.revisions.find(
    ({ recordKind }) => recordKind === "estimated_ev",
  )!;
  const priorContent = estimate.content as Record<string, unknown>;
  const priorManifest = priorContent.inputManifest as EstimatedEvInputManifest;
  const manifest: EstimatedEvInputManifest = {
    ...priorManifest,
    packPriceValueMinor: priceMinor,
    buckets: priorManifest.buckets.map((bucket) => ({
      ...bucket,
      lowerValueMinor: grossMinor,
      upperValueMinor: grossMinor,
    })),
  };
  const recalculated = calculatePackScoutEstimatedEv({
    packPrice: {
      valueMinor: manifest.packPriceValueMinor,
      currency: manifest.packPriceCurrency,
      sourceRevisionId: manifest.packRevisionId!,
    },
    distributionCurrency: manifest.distributionCurrency,
    unitBasis: manifest.unitBasis,
    drawCount: manifest.drawCount,
    declaredCoverage: manifest.declaredCoverage,
    evidenceCompleteness: manifest.evidenceCompleteness,
    buckets: manifest.buckets,
    sourceAt: manifest.sourceAt,
    calculatedAt: priorContent.calculatedAt as string,
    currencyPolicy: {
      verifiedUsdStablecoins: manifest.verifiedUsdStablecoins,
    },
  });
  const revisions = snapshot.revisions.map((revision) => {
    if (revision.recordKind === "pack") {
      return {
        ...revision,
        content: {
          ...(revision.content as Record<string, unknown>),
          priceValueMinor: priceMinor,
          providerReportedEvValueMinor: grossMinor,
        },
      };
    }
    if (revision.recordKind === "estimated_ev") {
      return {
        ...revision,
        content: {
          ...(revision.content as Record<string, unknown>),
          ...recalculated,
          calculationFingerprint:
            estimatedEvCalculationFingerprint(manifest),
          inputManifest: manifest,
        },
      };
    }
    if (revision.recordKind === "ev_input") {
      const content = revision.content as Record<string, unknown>;
      return {
        ...revision,
        content: {
          ...content,
          probabilityBuckets: (
            content.probabilityBuckets as Array<Record<string, unknown>>
          ).map((bucket) => ({
            ...bucket,
            lowerValueMinor: grossMinor,
            upperValueMinor: grossMinor,
          })),
        },
      };
    }
    return revision;
  });

  const projection = projectProviderCatalogRelease({
    configuration: providerFixtureApprovedConfiguration(),
    platformKey: "alpha",
    revisions,
    repackIdentities: snapshot.repackIdentities,
  });

  const vendorEv = projection.repacks[0]!.evEstimates.vendorReported;
  const packScoutEv = projection.repacks[0]!.evEstimates.packScout;
  assert.equal(vendorEv.status, "available");
  assert.equal(packScoutEv.status, "available");
  if (vendorEv.status === "available" && packScoutEv.status === "available") {
    assert.equal(vendorEv.metrics.grossReturnBasisPoints, 44_775);
    assert.equal(packScoutEv.metrics.grossReturnBasisPoints, 44_775);
  }
});

test("estimated EV rejects missing USD proof and malformed canonical inputs", () => {
  const snapshot = providerFixtureSnapshot();
  for (const patch of [
    { currency: null },
    { method: "unapproved_method" },
    { inputManifest: null },
  ]) {
    const revisions = snapshot.revisions.map((revision) =>
      revision.recordKind === "estimated_ev"
        ? {
            ...revision,
            content: {
              ...(revision.content as Record<string, unknown>),
              ...patch,
            },
          }
        : revision);
    assert.throws(
      () => projectProviderCatalogRelease({
        configuration: providerFixtureApprovedConfiguration(),
        platformKey: "alpha",
        revisions,
        repackIdentities: snapshot.repackIdentities,
      }),
      { message: "CANONICAL_PROJECTION_INVALID" },
    );
  }
});

test("estimated EV accepts only the stablecoins governed by the approved epoch", () => {
  const snapshot = providerFixtureSnapshot();
  const revisionsFor = (
    currency: string,
    verifiedUsdStablecoins: readonly string[],
  ) => {
    const estimate = snapshot.revisions.find(
      ({ recordKind }) => recordKind === "estimated_ev",
    )!;
    const priorContent = estimate.content as Record<string, unknown>;
    const priorManifest = priorContent.inputManifest as EstimatedEvInputManifest;
    const manifest: EstimatedEvInputManifest = {
      ...priorManifest,
      packPriceCurrency: currency,
      distributionCurrency: currency,
      verifiedUsdStablecoins,
    };
    const recalculated = calculatePackScoutEstimatedEv({
      packPrice: {
        valueMinor: manifest.packPriceValueMinor,
        currency: manifest.packPriceCurrency,
        sourceRevisionId: manifest.packRevisionId!,
      },
      distributionCurrency: manifest.distributionCurrency,
      unitBasis: manifest.unitBasis,
      drawCount: manifest.drawCount,
      declaredCoverage: manifest.declaredCoverage,
      evidenceCompleteness: manifest.evidenceCompleteness,
      buckets: manifest.buckets,
      sourceAt: manifest.sourceAt,
      calculatedAt: priorContent.calculatedAt as string,
      currencyPolicy: { verifiedUsdStablecoins },
    });
    return snapshot.revisions.map((revision) => {
      if (revision.recordKind === "pack") {
        return {
          ...revision,
          content: {
            ...(revision.content as Record<string, unknown>),
            priceCurrency: currency,
          },
        };
      }
      if (revision.recordKind === "ev_input") {
        return {
          ...revision,
          content: {
            ...(revision.content as Record<string, unknown>),
            currency,
          },
        };
      }
      if (revision.recordKind === "estimated_ev") {
        return {
          ...revision,
          content: {
            ...priorContent,
            ...recalculated,
            calculationFingerprint:
              estimatedEvCalculationFingerprint(manifest),
            inputManifest: manifest,
          },
        };
      }
      return revision;
    });
  };

  const configuration = providerFixtureApprovedConfiguration({
    verifiedUsdStablecoins: ["USDC"],
  });
  const approved = projectProviderCatalogRelease({
    configuration,
    platformKey: "alpha",
    revisions: revisionsFor("USDC", ["USDC"]),
    repackIdentities: snapshot.repackIdentities,
  });
  assert.equal(
    approved.repacks[0]?.evEstimates.packScout.status,
    "available",
  );
  assert.deepEqual(approved.repacks[0]?.price, {
    displayMoney: null,
    usdComparison: {
      status: "available",
      value: { minorUnits: 1_000, currency: "USD" },
    },
  });
  assert.equal(
    approved.repacks[0]?.evEstimates.vendorReported.status,
    "available",
  );

  const stablecoinGross = projectProviderCatalogRelease({
    configuration,
    platformKey: "alpha",
    revisions: revisionsFor("USDC", ["USDC"]).map((revision) =>
      revision.recordKind === "pack"
        ? {
            ...revision,
            content: {
              ...(revision.content as Record<string, unknown>),
              providerReportedEvCurrency: "USDC",
            },
          }
        : revision),
    repackIdentities: snapshot.repackIdentities,
  });
  const vendorReported = stablecoinGross.repacks[0]!.evEstimates.vendorReported;
  assert.equal(vendorReported.status, "available");
  if (vendorReported.status === "available") {
    assert.equal(vendorReported.displayMoney.currency, "USDC");
    assert.equal(vendorReported.metrics.grossEv.currency, "USD");
  }

  assert.throws(
    () => projectProviderCatalogRelease({
      configuration,
      platformKey: "alpha",
      revisions: revisionsFor("DOGE", ["DOGE"]),
      repackIdentities: snapshot.repackIdentities,
    }),
    { message: "CANONICAL_PROJECTION_INVALID" },
  );
});

test("estimated EV must bind the current pack and EV-input revisions", () => {
  const snapshot = providerFixtureSnapshot();
  for (const mutate of [
    (revision: ProviderCatalogReleaseSourceSnapshot["revisions"][number]) =>
      revision.recordKind === "pack"
        ? {
            ...revision,
            content: {
              ...(revision.content as Record<string, unknown>),
              priceValueMinor: 2_500,
            },
          }
        : revision,
    (revision: ProviderCatalogReleaseSourceSnapshot["revisions"][number]) => {
      if (revision.recordKind !== "ev_input") return revision;
      const content = revision.content as Record<string, unknown>;
      return {
        ...revision,
        content: {
          ...content,
          probabilityBuckets: (
            content.probabilityBuckets as Array<Record<string, unknown>>
          ).map((bucket) => ({
            ...bucket,
            lowerValueMinor: 5_000,
            upperValueMinor: 5_000,
          })),
        },
      };
    },
  ]) {
    assert.throws(
      () => projectProviderCatalogRelease({
        configuration: providerFixtureApprovedConfiguration(),
        platformKey: "alpha",
        revisions: snapshot.revisions.map(mutate),
        repackIdentities: snapshot.repackIdentities,
      }),
      { message: "CANONICAL_PROJECTION_INVALID" },
    );
  }
});

test("estimated EV calculation time cannot exceed its accepted canonical revision", () => {
  const snapshot = providerFixtureSnapshot();
  const futureCalculatedAt = "2030-01-01T00:00:00.000Z";
  const revisions = snapshot.revisions.map((revision) => {
    if (revision.recordKind !== "estimated_ev") return revision;
    const priorContent = revision.content as Record<string, unknown>;
    const manifest = priorContent.inputManifest as EstimatedEvInputManifest;
    const recalculated = calculatePackScoutEstimatedEv({
      packPrice: {
        valueMinor: manifest.packPriceValueMinor,
        currency: manifest.packPriceCurrency,
        sourceRevisionId: manifest.packRevisionId!,
      },
      distributionCurrency: manifest.distributionCurrency,
      unitBasis: manifest.unitBasis,
      drawCount: manifest.drawCount,
      declaredCoverage: manifest.declaredCoverage,
      evidenceCompleteness: manifest.evidenceCompleteness,
      buckets: manifest.buckets,
      sourceAt: manifest.sourceAt,
      calculatedAt: futureCalculatedAt,
      currencyPolicy: {
        verifiedUsdStablecoins: manifest.verifiedUsdStablecoins,
      },
    });
    return {
      ...revision,
      content: {
        ...priorContent,
        ...recalculated,
        calculatedAt: futureCalculatedAt,
      },
    };
  });

  assert.throws(
    () => projectProviderCatalogRelease({
      configuration: providerFixtureApprovedConfiguration(),
      platformKey: "alpha",
      revisions,
      repackIdentities: snapshot.repackIdentities,
    }),
    { message: "CANONICAL_PROJECTION_INVALID" },
  );
});

test("present out-of-range buyback evidence fails instead of becoming unavailable", () => {
  const snapshot = providerFixtureSnapshot();
  const revisions = snapshot.revisions.map((revision) =>
    revision.recordKind === "pack"
      ? {
          ...revision,
          content: {
            ...(revision.content as Record<string, unknown>),
            buybackPercent: 100.01,
          },
        }
      : revision);

  assert.throws(
    () => projectProviderCatalogRelease({
      configuration: providerFixtureApprovedConfiguration(),
      platformKey: "alpha",
      revisions,
      repackIdentities: snapshot.repackIdentities,
    }),
    { message: "EXACT_VALUE_INVALID" },
  );
});

test("probability and coverage above one fail before basis-point rounding", () => {
  const snapshot = providerFixtureSnapshot();
  for (const contentPatch of [
    (content: Record<string, unknown>) => ({
      ...content,
      probabilityBuckets: (content.probabilityBuckets as Array<Record<string, unknown>>)
        .map((bucket) => ({ ...bucket, probability: 1.000_01 })),
    }),
    (content: Record<string, unknown>) => ({
      ...content,
      coverage: {
        ...(content.coverage as Record<string, unknown>),
        calculatedCoverage: 1.000_01,
      },
    }),
  ]) {
    const revisions = snapshot.revisions.map((revision) =>
      revision.recordKind === "ev_input"
        ? {
            ...revision,
            content: contentPatch(
              revision.content as Record<string, unknown>,
            ),
          }
        : revision);
    assert.throws(
      () => projectProviderCatalogRelease({
        configuration: providerFixtureApprovedConfiguration(),
        platformKey: "alpha",
        revisions,
        repackIdentities: snapshot.repackIdentities,
      }),
      { message: "EXACT_VALUE_INVALID" },
    );
  }
});

test("EV-input coverage, counts, buckets, and readiness must reconcile", () => {
  const snapshot = providerFixtureSnapshot();
  const revisions = snapshot.revisions.map((revision) => {
    if (revision.recordKind !== "ev_input") return revision;
    const content = revision.content as Record<string, unknown>;
    return {
      ...revision,
      content: {
        ...content,
        coverage: {
          ...(content.coverage as Record<string, unknown>),
          calculatedCoverage: 0.5,
          probabilityBucketCount: 999,
        },
        readiness: {
          status: "unavailable",
          reasons: ["invalid_probability"],
        },
      },
    };
  });

  assert.throws(
    () => projectProviderCatalogRelease({
      configuration: providerFixtureApprovedConfiguration(),
      platformKey: "alpha",
      revisions,
      repackIdentities: snapshot.repackIdentities,
    }),
    { message: "CANONICAL_PROJECTION_INVALID" },
  );
});

test("a governed probability-bucket reference must resolve", () => {
  const snapshot = providerFixtureSnapshot();
  const configuration = providerFixtureApprovedConfiguration();
  const invalidConfiguration = {
    ...configuration,
    collectibles: configuration.collectibles.map((collectible) => ({
      ...collectible,
      probabilityBucketId: "missing-bucket",
    })),
  };

  assert.throws(
    () => projectProviderCatalogRelease({
      configuration: invalidConfiguration,
      platformKey: "alpha",
      revisions: snapshot.revisions,
      repackIdentities: snapshot.repackIdentities,
    }),
    { message: "PUBLIC_REFERENCE_INVALID" },
  );
});

test("orphan EV inputs and estimates fail closed", () => {
  const snapshot = providerFixtureSnapshot();
  const evInput = snapshot.revisions.find(({ recordKind }) => recordKind === "ev_input")!;
  const estimate = snapshot.revisions.find(({ recordKind }) => recordKind === "estimated_ev")!;

  for (const orphan of [
    {
      ...evInput,
      revisionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      externalId: "orphan-ev-input",
      content: {
        ...(evInput.content as Record<string, unknown>),
        packExternalId: "missing-pack",
      },
    },
    {
      ...estimate,
      revisionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      externalId: "missing-pack",
    },
  ]) {
    assert.throws(
      () => projectProviderCatalogRelease({
        configuration: providerFixtureApprovedConfiguration(),
        platformKey: "alpha",
        revisions: [...snapshot.revisions, orphan],
        repackIdentities: snapshot.repackIdentities,
      }),
      { message: "PUBLIC_REFERENCE_INVALID" },
    );
  }
});

test("governed identity first-approval provenance survives later epochs", () => {
  const checkpoint = providerFixtureCheckpoint({
    configurationKey: "catalog-v2",
    revision: 2,
    configurationHash: "b".repeat(64),
    configurationSequence: 21n,
    settledSequence: 30n,
  });
  const configuration = providerFixtureApprovedConfiguration({
    configurationKey: "catalog-v2",
    revision: 2,
  });

  const projection = project({ checkpoint, configuration });

  assert.equal(projection.repacks.length, 1);
});
