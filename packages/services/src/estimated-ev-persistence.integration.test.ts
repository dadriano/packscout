import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IngestionPersistenceRepository,
  PersistenceError,
  PipelineSetupRepository,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { CatalogProjectionService } from "./catalog-projection-service.ts";
import {
  PACKSCOUT_ESTIMATED_EV_METHOD_VERSION,
} from "./estimated-ev-calculator.ts";
import {
  CanonicalEstimatedEvProjectionRepository,
} from "./estimated-ev-projection-repository.ts";
import { PackScoutEstimatedEvService } from "./estimated-ev-service.ts";
import type {
  CanonicalPackCandidate,
  EvInputCandidate,
  ProviderAdapterCandidate,
  ProviderSourceIdentity,
} from "./provider-adapter.ts";

const ids = {
  organization: "40000000-0000-4000-8000-000000000001",
  provider: "40000000-0000-4000-8000-000000000002",
  configuration: "40000000-0000-4000-8000-000000000003",
  run: "40000000-0000-4000-8000-000000000004",
} as const;

const configuration = {
  providerId: ids.provider,
  configurationRevisionId: ids.configuration,
  platform: "synthetic-platform",
  adapterKey: "synthetic-mapper-v1",
};

function source(
  externalId: string,
  sourceTimestamp: string,
  recordIndex: number,
): ProviderSourceIdentity {
  return {
    platform: configuration.platform,
    recordKind: "catalog",
    recordIndex,
    externalId,
    sourceTimestamp,
    collectedAt: new Date(Date.parse(sourceTimestamp) + 60_000).toISOString(),
  };
}

function packCandidate(
  candidateSource: ProviderSourceIdentity,
  price: number,
): CanonicalPackCandidate {
  return {
    candidateKind: "pack",
    source: candidateSource,
    externalId: "pack-1",
    parentExternalId: null,
    name: "Synthetic Pack",
    description: null,
    category: "fixture",
    availability: "active",
    price: { amount: price, currency: "usd" },
    providerReportedEv: { amount: 4, currency: "usd" },
    relationships: [],
    dataQualityEvidence: [],
  };
}

function evCandidate(
  candidateSource: ProviderSourceIdentity,
  overrides: Partial<EvInputCandidate> = {},
): EvInputCandidate {
  return {
    candidateKind: "ev_input",
    source: candidateSource,
    externalId: "pack-1:odds-v1",
    packExternalId: "pack-1",
    currency: "USD",
    unitBasis: "per_pack",
    drawCount: 1,
    declaredCoverage: 1,
    evidenceCompleteness: "complete",
    buckets: [
      {
        bucketId: "common",
        evidenceKind: "probability_bucket",
        probability: 0.5,
        lowerValue: 1,
        upperValue: 3,
      },
      {
        bucketId: "rare",
        evidenceKind: "probability_bucket",
        probability: 0.5,
        lowerValue: 3,
        upperValue: 5,
      },
    ],
    relationships: [],
    dataQualityEvidence: [],
    ...overrides,
  };
}

function projectCatalog(
  candidateSource: ProviderSourceIdentity,
  candidates: readonly ProviderAdapterCandidate[],
) {
  const result = new CatalogProjectionService().project({
    configuration,
    source: candidateSource,
    candidates,
  });
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") throw new Error("Expected catalog projection.");
  return result.projections;
}

function catalogEvidence(
  candidateSource: ProviderSourceIdentity,
  data: Record<string, string | number>,
) {
  return {
    stream: "catalog" as const,
    platform: candidateSource.platform,
    entity: "pack" as const,
    record_id: candidateSource.externalId,
    first_seen_at: candidateSource.sourceTimestamp,
    occurred_at: candidateSource.sourceTimestamp,
    collected_at: candidateSource.collectedAt,
    data,
  };
}

async function setupHarness(
  operational?: ConstructorParameters<typeof PackScoutEstimatedEvService>[1],
) {
  const harness = await createMigratedTestDatabase();
  const setup = new PipelineSetupRepository(harness.database);
  await setup.createOrganization({
    id: ids.organization,
    slug: "estimated-ev",
    name: "Estimated EV",
  });
  await setup.createProviderSource({
    id: ids.provider,
    organizationId: ids.organization,
    platformKey: configuration.platform,
    displayName: "Synthetic Provider",
  });
  await setup.createConfigRevision({
    id: ids.configuration,
    organizationId: ids.organization,
    providerId: ids.provider,
    version: 1,
    adapterKey: configuration.adapterKey,
    endpointUrl: "https://provider.example/feed",
    authMode: "none",
    createdByActorKey: "actor:test",
  });
  await setup.createImportRun({
    id: ids.run,
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    trigger: "scheduled",
  });
  const persistence = new IngestionPersistenceRepository(harness.database, {
    retentionDays: 90,
    actorPseudonymKey: new Uint8Array(32).fill(8),
  });
  const repository = new CanonicalEstimatedEvProjectionRepository(persistence);
  return {
    ...harness,
    persistence,
    repository,
    service: new PackScoutEstimatedEvService(repository, operational),
  };
}

async function commitCatalog(input: {
  persistence: Awaited<ReturnType<typeof setupHarness>>["persistence"];
  pageNumber: number;
  candidateSource: ProviderSourceIdentity;
  candidates: readonly ProviderAdapterCandidate[];
}) {
  await input.persistence.commitPage({
    organizationId: ids.organization,
    providerId: ids.provider,
    configRevisionId: ids.configuration,
    runId: ids.run,
    pageNumber: input.pageNumber,
    requestedCursor: input.pageNumber === 1 ? null : `cursor-${input.pageNumber - 1}`,
    nextCursor: `cursor-${input.pageNumber}`,
    hasMore: true,
    checkpointMode: "provider",
    payload: {
      page: input.pageNumber,
      raw_provider_blob: "expires-with-source-evidence",
    },
    records: [
      {
        recordKind: "catalog",
        recordIndex: input.candidateSource.recordIndex,
        externalId: input.candidateSource.externalId,
        sourceTime: new Date(input.candidateSource.sourceTimestamp),
        collectedAt: new Date(input.candidateSource.collectedAt),
        payload: catalogEvidence(input.candidateSource, {
          raw_provider_blob: "expires-with-source-evidence",
        }),
        projections: projectCatalog(input.candidateSource, input.candidates),
      },
    ],
    committedAt: new Date(
      Date.parse(input.candidateSource.collectedAt) + 60_000,
    ),
  });
}

function command(calculatedAt: string) {
  return {
    organizationId: ids.organization,
    providerId: ids.provider,
    configurationRevisionId: ids.configuration,
    platformKey: configuration.platform,
    packExternalId: "pack-1",
    evInputExternalId: "pack-1:odds-v1",
    calculatedAt,
    currencyPolicy: { verifiedUsdStablecoins: [] },
  } as const;
}

test("estimated EV revisions are source-linked, explainable, idempotent, and responsive to relevant inputs", async () => {
  const availability: string[] = [];
  const harness = await setupHarness({
    calculation(input) {
      availability.push(input.availability);
    },
  });
  try {
    const initialSource = source("catalog-initial", "2026-08-06T10:00:00.000Z", 0);
    await commitCatalog({
      persistence: harness.persistence,
      pageNumber: 1,
      candidateSource: initialSource,
      candidates: [packCandidate(initialSource, 10), evCandidate(initialSource)],
    });

    const first = await harness.service.recalculate(
      command("2026-08-06T10:05:00.000Z"),
    );
    assert.equal(first.persistenceStatus, "revised");
    assert.equal(first.calculationRevisionNumber, 1);
    assert.deepEqual(
      {
        status: first.explanation.status,
        grossValueMinor: first.explanation.grossValueMinor,
        minorUnitExponent: first.explanation.minorUnitExponent,
        evPercent: first.explanation.evPercent,
        unitLabel: first.explanation.unitLabel,
        methodVersion: first.explanation.methodVersion,
        coveragePercent: first.explanation.coveragePercent,
      },
      {
        status: "estimated",
        grossValueMinor: 300,
        minorUnitExponent: 2,
        evPercent: 30,
        unitLabel: "per pack",
        methodVersion: PACKSCOUT_ESTIMATED_EV_METHOD_VERSION,
        coveragePercent: 100,
      },
    );
    assert.deepEqual(first.explanation.providerReportedEv, {
      status: "reported",
      valueMinor: 400,
      currency: "USD",
      minorUnitExponent: 2,
      sourceAt: initialSource.sourceTimestamp,
      sourceRevisionId: first.explanation.sourceRevisionIds[0],
    });
    assert.equal(first.explanation.sourceRevisionIds.length, 2);

    const repeated = await harness.service.recalculate(
      command("2026-08-06T10:06:00.000Z"),
    );
    assert.equal(repeated.persistenceStatus, "unchanged");
    assert.equal(repeated.calculationRevisionId, first.calculationRevisionId);
    assert.equal(repeated.explanation.calculatedAt, "2026-08-06T10:05:00.000Z");
    assert.equal(
      (await harness.persistence.listCanonicalRevisions(ids.organization, {
        platformKey: configuration.platform,
        recordKind: "estimated_ev",
        externalId: "pack-1",
      })).length,
      1,
    );

    const priceSource = source("catalog-price-change", "2026-08-06T11:00:00.000Z", 1);
    await commitCatalog({
      persistence: harness.persistence,
      pageNumber: 2,
      candidateSource: priceSource,
      candidates: [packCandidate(priceSource, 12)],
    });
    const repriced = await harness.service.recalculate(
      command("2026-08-06T11:05:00.000Z"),
    );
    assert.equal(repriced.persistenceStatus, "revised");
    assert.equal(repriced.calculationRevisionNumber, 2);
    assert.equal(repriced.explanation.grossValueMinor, 300);
    assert.equal(repriced.explanation.evPercent, 25);

    const partialSource = source("catalog-partial-odds", "2026-08-06T12:00:00.000Z", 2);
    await commitCatalog({
      persistence: harness.persistence,
      pageNumber: 3,
      candidateSource: partialSource,
      candidates: [
        evCandidate(partialSource, {
          evidenceCompleteness: "partial",
          buckets: [
            {
              bucketId: "open-range",
              evidenceKind: "probability_bucket",
              probability: 1,
              lowerValue: 1,
              upperValue: null,
            },
          ],
        }),
      ],
    });
    const unavailable = await harness.service.recalculate(
      command("2026-08-06T12:05:00.000Z"),
    );
    assert.equal(unavailable.persistenceStatus, "revised");
    assert.equal(unavailable.explanation.status, "unavailable");
    assert.deepEqual(unavailable.explanation.reasonCodes, [
      "incomplete_inventory",
      "open_ended_value_range",
    ]);
    assert.ok(unavailable.explanation.limitations.includes("incomplete_inventory"));

    const current = await harness.persistence.getCurrentProjection(ids.organization, {
      platformKey: configuration.platform,
      recordKind: "estimated_ev",
      externalId: "pack-1",
    });
    assert.ok(current);
    assert.equal("providerReportedEv" in current.content, false);
    assert.doesNotMatch(JSON.stringify(current), /raw_provider_blob|expires-with-source/i);
    const manifest = current.content.inputManifest as Record<string, unknown>;
    assert.equal(typeof manifest.packRevisionId, "string");
    assert.equal(typeof manifest.evInputRevisionId, "string");
    assert.equal(manifest.packPriceMinorUnitExponent, 2);
    assert.equal(manifest.distributionMinorUnitExponent, 2);

    const relationship = await harness.database.canonical_relationships.findFirst({
      where: { relationship_kind: "estimates_pack" },
      select: { target_external_id: true },
    });
    assert.equal(relationship?.target_external_id, "pack-1");
    assert.deepEqual(
      await harness.service.explain({
        organizationId: ids.organization,
        platformKey: configuration.platform,
        packExternalId: "pack-1",
      }),
      unavailable.explanation,
    );

    const calculationInputs = await harness.repository.loadCalculationInputs({
      organizationId: ids.organization,
      platformKey: configuration.platform,
      packExternalId: "pack-1",
      evInputExternalId: "pack-1:odds-v1",
    });
    assert.ok(calculationInputs.evInput);
    await harness.persistence.projectDerivedSourceRecord({
      organizationId: ids.organization,
      providerId: ids.provider,
      configurationRevisionId: ids.configuration,
      sourceRecordId: calculationInputs.evInput.sourceRecordId,
      acceptedAt: new Date("2026-08-06T12:10:00.000Z"),
      projections: [
        {
          platformKey: configuration.platform,
          recordKind: "estimated_ev",
          externalId: "pack-1",
          content: {
            ...current.content,
            calculationFingerprint: "legacy-method-fingerprint",
            methodVersion: "packscout-estimated-ev-v0",
          },
          provenance: {
            calculationFingerprint: "legacy-method-fingerprint",
            methodVersion: "packscout-estimated-ev-v0",
          },
          sourceUpdatedAt: current.sourceUpdatedAt,
          sourceCollectedAt: current.sourceCollectedAt,
        },
      ],
    });
    const methodUpgrade = await harness.service.recalculate(
      command("2026-08-06T12:15:00.000Z"),
    );
    assert.equal(methodUpgrade.persistenceStatus, "revised");
    assert.equal(methodUpgrade.calculationRevisionNumber, 5);
    assert.equal(
      methodUpgrade.explanation.methodVersion,
      PACKSCOUT_ESTIMATED_EV_METHOD_VERSION,
    );
    const methodReplay = await harness.service.recalculate(
      command("2026-08-06T12:20:00.000Z"),
    );
    assert.equal(methodReplay.persistenceStatus, "unchanged");
    assert.equal(methodReplay.calculationRevisionId, methodUpgrade.calculationRevisionId);
    assert.deepEqual(availability, [
      "LIMITED",
      "LIMITED",
      "LIMITED",
      "UNAVAILABLE",
      "UNAVAILABLE",
      "UNAVAILABLE",
    ]);

    const failureIsolated = new PackScoutEstimatedEvService(harness.repository, {
      calculation() {
        throw new Error("metrics unavailable");
      },
    });
    assert.equal(
      (await failureIsolated.recalculate(command("2026-08-06T12:21:00.000Z")))
        .persistenceStatus,
      "unchanged",
    );

    await assert.rejects(
      harness.persistence.projectDerivedSourceRecord({
        organizationId: "40000000-0000-4000-8000-000000000099",
        providerId: ids.provider,
        configurationRevisionId: ids.configuration,
        sourceRecordId: calculationInputs.evInput.sourceRecordId,
        acceptedAt: new Date("2026-08-06T12:25:00.000Z"),
        projections: [],
      }),
      (error: unknown) =>
        error instanceof PersistenceError && error.code === "TENANT_SCOPE_VIOLATION",
    );
  } finally {
    await harness.close();
  }
});
