import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_BUYBACK_EV_PROTECTED_FIELD_NAMES_V1,
  containsProtectedEvPublicationKeyV3,
  type PackScoutBuybackEvInputV1,
} from "@packscout/contracts";
import {
  BuybackEvRevisionIntegrityError,
  BuybackEvRevisionRepository,
  IngestionPersistenceRepository,
  PersistenceError,
  PipelineSetupRepository,
} from "@packscout/database";
import { createMigratedTestDatabase } from "@packscout/database/test-support";
import { calculatePackScoutBuybackAdjustedEvV1 } from "./buyback-adjusted-ev-calculator.ts";
import { buildBuybackEvInput } from "./buyback-adjusted-ev-calculator.test-support.ts";
import { evaluatePackScoutBuybackEvConfidenceV1 } from "./buyback-adjusted-ev-confidence.ts";
import {
  computePackScoutBuybackEvEffectiveFingerprintV1,
  type PackScoutBuybackEvCalculationIdentityV1,
} from "./buyback-adjusted-ev-revision-contracts.ts";
import {
  PackScoutBuybackEvRevisionStore,
  type PersistPackScoutBuybackEvRevisionCommandV1,
} from "./buyback-adjusted-ev-revision-store.ts";
import { CatalogProjectionService } from "./catalog-projection-service.ts";
import { PACKSCOUT_ESTIMATED_EV_METHOD_VERSION } from "./estimated-ev-calculator.ts";
import { CanonicalEstimatedEvProjectionRepository } from "./estimated-ev-projection-repository.ts";
import { PackScoutEstimatedEvService } from "./estimated-ev-service.ts";
import type {
  CanonicalPackCandidate,
  EvInputCandidate,
  ProviderSourceIdentity,
} from "./provider-adapter.ts";

const ids = {
  organization: "40000000-0000-4000-8000-000000000001",
  otherOrganization: "40000000-0000-4000-8000-000000000009",
  provider: "40000000-0000-4000-8000-000000000002",
  configuration: "40000000-0000-4000-8000-000000000003",
  run: "40000000-0000-4000-8000-000000000004",
} as const;

const PLATFORM_KEY = "courtyard";
const PRODUCT_KEY = "courtyard-ironman-repack";

function identityFor(
  input: PackScoutBuybackEvInputV1,
): PackScoutBuybackEvCalculationIdentityV1 {
  return {
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    platformKey: input.observation.providerKey,
    productKey: input.product.productKey,
    productRevisionId: input.product.productRevisionId,
    sourceRevisionId: input.observation.sourceRevisionId,
    sourceManifestSha256: input.observation.sourceManifestSha256,
    observationCoherence: input.observation.coherenceKind,
    configurationRevisionId: ids.configuration,
  };
}

function commandFor(
  input: PackScoutBuybackEvInputV1,
  calculatedAt: string,
  overrides: Partial<PersistPackScoutBuybackEvRevisionCommandV1> = {},
): PersistPackScoutBuybackEvRevisionCommandV1 {
  const calculation = calculatePackScoutBuybackAdjustedEvV1({
    input,
    calculatedAt,
  });
  assert.equal(calculation.status, "available");
  const evaluation = evaluatePackScoutBuybackEvConfidenceV1(
    calculation.confidenceInput,
  );
  return {
    organizationId: ids.organization,
    providerId: ids.provider,
    configurationRevisionId: ids.configuration,
    calculation,
    confidenceEvaluation: evaluation,
    effectiveFingerprint: computePackScoutBuybackEvEffectiveFingerprintV1({
      identity: identityFor(input),
      evidence: { kind: "complete_input", input },
    }),
    sourceRevisions: [
      {
        sourceRevisionId: input.observation.sourceRevisionId,
        sourceManifestSha256: input.observation.sourceManifestSha256,
      },
    ],
    ...overrides,
  };
}

function deepKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(deepKeys);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, nested]) => [
    key,
    ...deepKeys(nested),
  ]);
}

function assertSanitizedProjection(projection: unknown): void {
  assert.equal(containsProtectedEvPublicationKeyV3(projection), false);
  const protectedLeafKeys = new Set(
    PACKSCOUT_BUYBACK_EV_PROTECTED_FIELD_NAMES_V1.flatMap((path) =>
      path.split("."),
    ),
  );
  for (const key of deepKeys(projection)) {
    assert.equal(protectedLeafKeys.has(key), false, key);
  }
  assert.doesNotMatch(
    JSON.stringify(projection),
    /courtyard|product-revision|catalog-revision|40000000-0000/,
  );
}

async function setupHarness() {
  const harness = await createMigratedTestDatabase();
  const setup = new PipelineSetupRepository(harness.database);
  await setup.createOrganization({
    id: ids.organization,
    slug: "buyback-ev",
    name: "Buyback EV",
  });
  await setup.createOrganization({
    id: ids.otherOrganization,
    slug: "other-org",
    name: "Other Org",
  });
  await setup.createProviderSource({
    id: ids.provider,
    organizationId: ids.organization,
    platformKey: PLATFORM_KEY,
    displayName: "Courtyard",
  });
  await setup.createConfigRevision({
    id: ids.configuration,
    organizationId: ids.organization,
    providerId: ids.provider,
    version: 1,
    adapterKey: "synthetic-mapper-v1",
    endpointUrl: "https://provider.example/feed",
    authMode: "none",
    createdByActorKey: "actor:test",
  });
  const repository = new BuybackEvRevisionRepository(harness.database);
  return {
    ...harness,
    repository,
    store: new PackScoutBuybackEvRevisionStore(repository),
  };
}

test("buyback EV revisions persist immutably with replay, conflict, failure, and trace guarantees", async () => {
  const harness = await setupHarness();
  try {
    const availableInput = buildBuybackEvInput();
    const availableCommand = commandFor(
      availableInput,
      "2026-08-19T18:05:00.000Z",
    );
    harness.statementCounter.reset();
    const created = await harness.store.persistCompletedCalculation(
      availableCommand,
    );
    assert.ok(
      harness.statementCounter.count <= 15,
      `persist statement budget exceeded: ${harness.statementCounter.count}`,
    );
    assert.equal(created.outcome, "created");
    if (created.outcome !== "created") return;
    assert.equal(created.revision.revisionNumber, 1);
    assert.equal(created.revision.status, "available");
    assert.equal(
      created.revision.methodVersion,
      PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    );
    assert.equal(created.projection.status, "available");
    assertSanitizedProjection(created.projection);

    const storedRow = await harness.database.buyback_ev_revisions.findFirst({
      where: { organization_id: ids.organization },
    });
    assert.ok(storedRow);
    assert.equal(storedRow.lifecycle, "completed");
    assert.equal(storedRow.method_version, PACKSCOUT_BUYBACK_EV_METHOD_VERSION);
    assert.equal(
      storedRow.confidence_policy_version,
      PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    );
    assert.equal(storedRow.platform_key, PLATFORM_KEY);
    assert.equal(storedRow.product_key, PRODUCT_KEY);
    assert.equal(storedRow.product_revision_id, "product-revision-42");
    assert.equal(storedRow.source_revision_id, "catalog-revision-100");
    assert.equal(storedRow.gross_ev_minor_units, 8_500n);
    assert.equal(storedRow.gross_return_basis_points, 8_500n);
    assert.equal(storedRow.ev_dollars_minor_units, -1_500n);
    assert.equal(storedRow.ev_percent_basis_points, -1_500n);
    assert.equal(storedRow.pack_price_minor_units, 10_000n);
    assert.equal(storedRow.underlying_outcome_ev_minor_units, 10_000n);
    assert.equal(storedRow.confidence_score_basis_points, 10_000);
    assert.equal(
      storedRow.calculated_at.toISOString(),
      "2026-08-19T18:05:00.000Z",
    );
    assert.equal(
      storedRow.data_observed_at?.toISOString(),
      "2026-08-19T18:00:00.000Z",
    );

    const replayed = await harness.store.persistCompletedCalculation(
      availableCommand,
    );
    assert.equal(replayed.outcome, "unchanged");
    if (replayed.outcome !== "unchanged") return;
    assert.equal(replayed.revision.revisionId, created.revision.revisionId);
    assert.equal(
      await harness.database.buyback_ev_revisions.count(),
      1,
      "an identical replay must not write a duplicate revision",
    );

    const repricedInput = buildBuybackEvInput({
      packPrice: {
        sourceAmount: { minorUnits: 12_000, currency: "USD", precision: 2 },
        canonicalUsdCents: { numerator: 12_000, denominator: 1 },
        normalization: { kind: "usd_direct" },
      },
    });
    const identityReuse = commandFor(repricedInput, "2026-08-19T18:05:00.000Z");
    const rejected = await harness.store.persistCompletedCalculation(
      identityReuse,
    );
    assert.deepEqual(rejected, {
      outcome: "rejected",
      reason: "IDENTITY_REUSE_CONFLICT",
      occurrenceCount: 1,
    });
    const rejectedAgain = await harness.store.persistCompletedCalculation(
      identityReuse,
    );
    assert.deepEqual(rejectedAgain, {
      outcome: "rejected",
      reason: "IDENTITY_REUSE_CONFLICT",
      occurrenceCount: 2,
    });
    assert.equal(await harness.database.buyback_ev_revisions.count(), 1);
    assert.equal(
      await harness.database.buyback_ev_persistence_failures.count(),
      1,
      "repeated invalid work must dedupe into one bounded failure row",
    );

    const driftedClock = commandFor(availableInput, "2026-08-19T18:06:00.000Z", {
      effectiveFingerprint: availableCommand.effectiveFingerprint,
    });
    const resultConflict = await harness.store.persistCompletedCalculation(
      driftedClock,
    );
    assert.deepEqual(resultConflict, {
      outcome: "rejected",
      reason: "RESULT_CONFLICT",
      occurrenceCount: 1,
    });
    assert.equal(await harness.database.buyback_ev_revisions.count(), 1);

    const currentBeforeCorruption = await harness.store.getCurrentPublication({
      organizationId: ids.organization,
      platformKey: PLATFORM_KEY,
      productKey: PRODUCT_KEY,
    });
    assert.equal(currentBeforeCorruption?.projection.status, "available");

    await harness.database.$executeRawUnsafe(
      "alter table public.buyback_ev_revisions disable trigger buyback_ev_revisions_immutable",
    );
    await harness.database.$executeRawUnsafe(
      "alter table public.buyback_ev_revisions drop constraint buyback_ev_revisions_arithmetic_check",
    );
    await harness.database.$executeRawUnsafe(
      `update public.buyback_ev_revisions set gross_ev_minor_units = 8501 where id = '${created.revision.revisionId}'`,
    );
    await assert.rejects(
      harness.store.getCurrentPublication({
        organizationId: ids.organization,
        platformKey: PLATFORM_KEY,
        productKey: PRODUCT_KEY,
      }),
      (error: unknown) =>
        error instanceof BuybackEvRevisionIntegrityError &&
        error.code === "ARITHMETIC_INVARIANTS_VIOLATED",
    );
    await harness.database.$executeRawUnsafe(
      `update public.buyback_ev_revisions set gross_ev_minor_units = 8500 where id = '${created.revision.revisionId}'`,
    );
    await harness.database.$executeRawUnsafe(`
      alter table public.buyback_ev_revisions add constraint buyback_ev_revisions_arithmetic_check
        check (
          status <> 'available'
          or (
            ev_dollars_minor_units = gross_ev_minor_units - pack_price_minor_units
            and ev_percent_basis_points = gross_return_basis_points - 10000
            and gross_return_basis_points =
              ((gross_ev_minor_units * 20000) + pack_price_minor_units)
                / (pack_price_minor_units * 2)
          )
        )
    `);
    await harness.database.$executeRawUnsafe(
      "alter table public.buyback_ev_revisions enable trigger buyback_ev_revisions_immutable",
    );

    const staleInput = buildBuybackEvInput({
      observation: {
        coherenceKind: "provider_revision",
        providerKey: PLATFORM_KEY,
        sourceRevisionId: "catalog-revision-200",
        sourceManifestSha256: "2".repeat(64),
        observedAt: "2026-08-19T18:30:00.000Z",
      },
    });
    const staleCommand = commandFor(staleInput, "2026-08-19T20:05:00.000Z");
    const stale = await harness.store.persistCompletedCalculation(staleCommand);
    assert.equal(stale.outcome, "created");
    if (stale.outcome !== "created") return;
    assert.equal(stale.revision.revisionNumber, 2);
    assert.equal(stale.revision.status, "unavailable");
    assert.equal(stale.projection.status, "unavailable");
    assert.equal(
      stale.projection.status === "unavailable"
        ? stale.projection.publicReason
        : null,
      "SOURCE_DATA_STALE",
    );
    assertSanitizedProjection(stale.projection);
    const staleRow = await harness.database.buyback_ev_revisions.findFirst({
      where: { id: stale.revision.revisionId },
    });
    assert.deepEqual(staleRow?.internal_reasons, ["STALE_EVIDENCE"]);
    assert.equal(staleRow?.freshness_state, "expired");
    assert.equal(staleRow?.gross_ev_minor_units, null);

    const currentAfterStale = await harness.store.getCurrentPublication({
      organizationId: ids.organization,
      platformKey: PLATFORM_KEY,
      productKey: PRODUCT_KEY,
    });
    assert.equal(
      currentAfterStale?.revision.revisionId,
      stale.revision.revisionId,
      "completed-current selection must be deterministic by revision number",
    );

    const unbindable = calculatePackScoutBuybackAdjustedEvV1({
      input: { raw_provider_blob: "garbage" },
      calculatedAt: "2026-08-19T20:06:00.000Z",
    });
    const unbindableCommand: PersistPackScoutBuybackEvRevisionCommandV1 = {
      organizationId: ids.organization,
      providerId: ids.provider,
      configurationRevisionId: ids.configuration,
      calculation: unbindable,
      confidenceEvaluation: null,
      effectiveFingerprint: "f".repeat(64),
      sourceRevisions: [{ sourceRevisionId: "catalog-revision-201" }],
    };
    const failed = await harness.store.persistCompletedCalculation(
      unbindableCommand,
    );
    assert.deepEqual(failed, {
      outcome: "failed",
      reason: "UNBINDABLE_RESULT",
      occurrenceCount: 1,
    });
    const failedAgain = await harness.store.persistCompletedCalculation(
      unbindableCommand,
    );
    assert.deepEqual(failedAgain, {
      outcome: "failed",
      reason: "UNBINDABLE_RESULT",
      occurrenceCount: 2,
    });
    assert.equal(
      await harness.database.buyback_ev_revisions.count(),
      2,
      "failed work must never create or replace completed revisions",
    );
    assert.equal(
      (await harness.store.getCurrentPublication({
        organizationId: ids.organization,
        platformKey: PLATFORM_KEY,
        productKey: PRODUCT_KEY,
      }))?.revision.revisionId,
      stale.revision.revisionId,
      "failed work must not advance completed freshness",
    );

    const trace = await harness.store.getRevisionTrace({
      organizationId: ids.organization,
      revisionId: created.revision.revisionId,
    });
    assert.ok(trace);
    assert.deepEqual(
      {
        methodVersion: trace.methodVersion,
        confidencePolicyVersion: trace.confidencePolicyVersion,
        productRevisionId: trace.productRevisionId,
        effectiveFingerprint: trace.effectiveFingerprint,
        resultHash: trace.resultHash,
        sourceReferences: trace.sourceReferences,
      },
      {
        methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
        confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
        productRevisionId: "product-revision-42",
        effectiveFingerprint: availableCommand.effectiveFingerprint,
        resultHash: created.revision.resultHash,
        sourceReferences: [
          {
            referenceIndex: 0,
            sourceRevisionId: "catalog-revision-100",
            sourceManifestSha256: "1".repeat(64),
            canonicalRevisionId: null,
          },
        ],
      },
    );

    await assert.rejects(
      harness.database.$executeRawUnsafe(
        `update public.buyback_ev_revisions set platform_key = 'beezie' where id = '${created.revision.revisionId}'`,
      ),
      /immutable/,
    );
    await assert.rejects(
      harness.database.$executeRawUnsafe(
        `delete from public.buyback_ev_revisions where id = '${created.revision.revisionId}'`,
      ),
      /immutable/,
    );
    await assert.rejects(
      harness.database.$executeRawUnsafe(
        `update public.buyback_ev_revision_source_refs set source_revision_id = 'tampered' where revision_id = '${created.revision.revisionId}'`,
      ),
      /immutable/,
    );
    await assert.rejects(
      harness.database.$executeRawUnsafe(
        "update public.buyback_ev_persistence_failures set reason_code = 'RESULT_CONFLICT'",
      ),
      /accumulate occurrences/,
    );
    await assert.rejects(
      harness.database.$executeRawUnsafe(
        "delete from public.buyback_ev_persistence_failures",
      ),
      /append-only/,
    );

    await assert.rejects(
      harness.store.persistCompletedCalculation({
        ...availableCommand,
        organizationId: ids.otherOrganization,
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "TENANT_SCOPE_VIOLATION",
    );
    await assert.rejects(
      harness.store.persistCompletedCalculation({
        ...commandFor(
          buildBuybackEvInput({
            observation: {
              coherenceKind: "provider_revision",
              providerKey: PLATFORM_KEY,
              sourceRevisionId: "catalog-revision-300",
              sourceManifestSha256: null,
              observedAt: "2026-08-19T18:00:00.000Z",
            },
          }),
          "2026-08-19T18:05:00.000Z",
        ),
        sourceRevisions: [
          {
            sourceRevisionId: "catalog-revision-300",
            canonicalRevisionId: "40000000-0000-4000-8000-0000000000ff",
          },
        ],
      }),
      (error: unknown) =>
        error instanceof PersistenceError &&
        error.code === "TENANT_SCOPE_VIOLATION",
    );
  } finally {
    await harness.close();
  }
});

test("the persistence transaction refuses older essential source evidence even after a stale read-check", async () => {
  const harness = await setupHarness();
  const observationFor = (revision: string, observedAt: string) => ({
    coherenceKind: "provider_revision" as const,
    providerKey: PLATFORM_KEY,
    sourceRevisionId: revision,
    sourceManifestSha256: "4".repeat(64),
    observedAt,
  });
  try {
    const newer = await harness.store.persistCompletedCalculation(
      commandFor(
        buildBuybackEvInput({
          observation: observationFor(
            "catalog-revision-410",
            "2026-08-19T18:10:00.000Z",
          ),
        }),
        "2026-08-19T18:11:00.000Z",
      ),
    );
    assert.equal(newer.outcome, "created");
    if (newer.outcome !== "created") return;

    // A raced recomputation whose read-time supersede check ran before the
    // newer revision committed writes its older evidence afterwards: the
    // transaction that assigns currency must refuse it as superseded.
    const older = await harness.store.persistCompletedCalculation(
      commandFor(buildBuybackEvInput(), "2026-08-19T18:12:00.000Z"),
    );
    assert.equal(older.outcome, "superseded");
    if (older.outcome !== "superseded") return;
    assert.equal(older.revision.revisionId, newer.revision.revisionId);
    assert.equal(
      await harness.database.buyback_ev_revisions.count(),
      1,
      "older evidence must never occupy a revision",
    );
    assert.equal(
      await harness.database.buyback_ev_persistence_failures.count(),
      0,
      "superseded work is an ordered outcome, never a ledgered failure",
    );

    // Equal essential source time is not a regression: identity rules own it.
    const equalTime = await harness.store.persistCompletedCalculation(
      commandFor(
        buildBuybackEvInput({
          observation: observationFor(
            "catalog-revision-420",
            "2026-08-19T18:10:00.000Z",
          ),
        }),
        "2026-08-19T18:13:00.000Z",
      ),
    );
    assert.equal(equalTime.outcome, "created");

    // Two interleaved writers for the same product: whichever interleaving
    // the scheduler produces, the newest essential source time ends current.
    const [olderWriter, newerWriter] = await Promise.all([
      harness.store.persistCompletedCalculation(
        commandFor(
          buildBuybackEvInput({
            observation: observationFor(
              "catalog-revision-430",
              "2026-08-19T18:20:00.000Z",
            ),
          }),
          "2026-08-19T18:31:00.000Z",
        ),
      ),
      harness.store.persistCompletedCalculation(
        commandFor(
          buildBuybackEvInput({
            observation: observationFor(
              "catalog-revision-440",
              "2026-08-19T18:30:00.000Z",
            ),
          }),
          "2026-08-19T18:31:00.000Z",
        ),
      ),
    ]);
    assert.equal(newerWriter.outcome, "created");
    if (newerWriter.outcome !== "created") return;
    assert.ok(
      olderWriter.outcome === "created" || olderWriter.outcome === "superseded",
      `unexpected racing outcome: ${olderWriter.outcome}`,
    );
    const current = await harness.store.getCurrentPublication({
      organizationId: ids.organization,
      platformKey: PLATFORM_KEY,
      productKey: PRODUCT_KEY,
    });
    assert.equal(current?.revision.revisionId, newerWriter.revision.revisionId);
    assert.equal(
      current?.projection.status === "available"
        ? current.projection.dataAsOf.observedAt
        : null,
      "2026-08-19T18:30:00.000Z",
      "the completed current revision must carry the newest source time",
    );
  } finally {
    await harness.close();
  }
});

function oldMethodSource(
  externalId: string,
  sourceTimestamp: string,
  recordIndex: number,
): ProviderSourceIdentity {
  return {
    platform: PLATFORM_KEY,
    recordKind: "catalog",
    recordIndex,
    externalId,
    sourceTimestamp,
    collectedAt: new Date(Date.parse(sourceTimestamp) + 60_000).toISOString(),
  };
}

test("historical pre-buyback revisions keep their original method identity and are never selected", async () => {
  const harness = await setupHarness();
  try {
    const setup = new PipelineSetupRepository(harness.database);
    await setup.createImportRun({
      id: ids.run,
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.configuration,
      trigger: "scheduled",
    });
    const ingestion = new IngestionPersistenceRepository(harness.database, {
      retentionDays: 90,
      actorPseudonymKey: new Uint8Array(32).fill(8),
    });
    const source = oldMethodSource(
      "catalog-initial",
      "2026-08-19T17:00:00.000Z",
      0,
    );
    const configuration = {
      providerId: ids.provider,
      configurationRevisionId: ids.configuration,
      platform: PLATFORM_KEY,
      adapterKey: "synthetic-mapper-v1",
    };
    const packCandidate: CanonicalPackCandidate = {
      candidateKind: "pack",
      source,
      externalId: PRODUCT_KEY,
      parentExternalId: null,
      name: "Ironman Repack",
      description: null,
      category: "fixture",
      availability: "available",
      price: { amount: 100, currency: "usd" },
      providerReportedEv: null,
      relationships: [],
      dataQualityEvidence: [],
    };
    const evCandidate: EvInputCandidate = {
      candidateKind: "ev_input",
      source,
      externalId: `${PRODUCT_KEY}:odds-v1`,
      packExternalId: PRODUCT_KEY,
      currency: "USD",
      unitBasis: "per_pack",
      drawCount: 1,
      declaredCoverage: 1,
      evidenceCompleteness: "complete",
      buckets: [
        {
          bucketId: "common",
          evidenceKind: "probability_bucket",
          probability: 1,
          lowerValue: 60,
          upperValue: 80,
        },
      ],
      relationships: [],
      dataQualityEvidence: [],
    };
    const projected = new CatalogProjectionService().project({
      configuration,
      source,
      candidates: [packCandidate, evCandidate],
    });
    assert.equal(projected.status, "accepted");
    if (projected.status !== "accepted") return;
    await ingestion.commitPage({
      organizationId: ids.organization,
      providerId: ids.provider,
      configRevisionId: ids.configuration,
      runId: ids.run,
      pageNumber: 1,
      requestedCursor: null,
      nextCursor: "cursor-1",
      hasMore: false,
      payload: { page: 1 },
      records: [
        {
          recordKind: "catalog",
          recordIndex: 0,
          externalId: source.externalId,
          sourceTime: new Date(source.sourceTimestamp),
          collectedAt: new Date(source.collectedAt),
          payload: { raw_provider_blob: "protected" },
          projections: projected.projections,
        },
      ],
      committedAt: new Date(Date.parse(source.collectedAt) + 60_000),
    });
    const estimatedEvService = new PackScoutEstimatedEvService(
      new CanonicalEstimatedEvProjectionRepository(ingestion),
    );
    const oldMethod = await estimatedEvService.recalculate({
      organizationId: ids.organization,
      providerId: ids.provider,
      // This case drives the pre-buyback estimated-EV method through the
      // configuration revision the page above was committed under, so it is the
      // legacy origin rather than a provider source revision.
      origin: {
        kind: "legacy_configuration",
        configurationRevisionId: ids.configuration,
      },
      platformKey: PLATFORM_KEY,
      packExternalId: PRODUCT_KEY,
      evInputExternalId: `${PRODUCT_KEY}:odds-v1`,
      calculatedAt: "2026-08-19T17:05:00.000Z",
      currencyPolicy: { verifiedUsdStablecoins: [] },
    });
    assert.equal(oldMethod.persistenceStatus, "revised");
    assert.equal(
      oldMethod.explanation.methodVersion,
      PACKSCOUT_ESTIMATED_EV_METHOD_VERSION,
    );

    assert.equal(
      await harness.store.getCurrentPublication({
        organizationId: ids.organization,
        platformKey: PLATFORM_KEY,
        productKey: PRODUCT_KEY,
      }),
      null,
      "pre-buyback estimated EV rows must never satisfy the new-method reader",
    );

    const created = await harness.store.persistCompletedCalculation(
      commandFor(buildBuybackEvInput(), "2026-08-19T18:05:00.000Z"),
    );
    assert.equal(created.outcome, "created");
    const current = await harness.store.getCurrentPublication({
      organizationId: ids.organization,
      platformKey: PLATFORM_KEY,
      productKey: PRODUCT_KEY,
    });
    assert.equal(current?.projection.methodVersion, PACKSCOUT_BUYBACK_EV_METHOD_VERSION);
    assert.equal(current?.projection.status, "available");

    const oldRevisions = await ingestion.listCanonicalRevisions(
      ids.organization,
      {
        platformKey: PLATFORM_KEY,
        recordKind: "estimated_ev",
        externalId: PRODUCT_KEY,
      },
    );
    assert.equal(oldRevisions.length, 1);
    assert.equal(
      (oldRevisions[0]!.content as { methodVersion?: string }).methodVersion,
      PACKSCOUT_ESTIMATED_EV_METHOD_VERSION,
      "the historical revision must keep its original method identity",
    );

    await assert.rejects(
      harness.database.$executeRawUnsafe(`
        insert into public.buyback_ev_revisions (
          organization_id, provider_id, configuration_revision_id,
          platform_key, product_key, product_revision_id,
          method_version, confidence_policy_version, lifecycle, status,
          revision_number, calculation_key, effective_fingerprint, result_hash,
          source_revision_id, observation_coherence, odds_source,
          used_closed_range_midpoint, calculated_at, data_as_of_state,
          freshness_state, internal_reasons, public_primary_reason
        ) values (
          '${ids.organization}', '${ids.provider}', '${ids.configuration}',
          '${PLATFORM_KEY}', '${PRODUCT_KEY}', 'product-revision-42',
          '${PACKSCOUT_ESTIMATED_EV_METHOD_VERSION}',
          'packscout-buyback-adjusted-ev-confidence-v1', 'completed', 'unavailable',
          9, repeat('d', 64), repeat('e', 64), repeat('f', 64),
          'catalog-revision-999', 'provider_revision', 'platform_published',
          false, '2026-08-19T18:05:00.000Z', 'unknown_source_time',
          'unknown_source_time', array['MISSING_SOURCE_TIME']::text[],
          'SOURCE_EVIDENCE_UNAVAILABLE'
        )
      `),
      /check constraint|violates/i,
      "the new store must reject any row that is not the approved new method version",
    );
  } finally {
    await harness.close();
  }
});
