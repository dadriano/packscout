import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ApprovedPublicCatalogConfigurationV1,
  PackScoutBuybackEvEvidenceOutcomeV1,
  PublicRepackDetailV3,
  PublicRepackSummaryV3,
} from "@packscout/contracts";
import {
  publicRepackSummaryV3FromDetail,
  packScoutEvProjectionsAreByteEquivalentV3,
  containsProtectedEvPublicationKeyV3,
  containsProtectedPublicationField,
} from "@packscout/contracts";
import {
  BuybackEvRevisionRepository,
  PrismaDataReleaseV3CanonicalCatalogSource,
  advanceSettledPublicWatermark,
  allocatePublicChangeCauses,
  prismaApprovedPublicRepackIdentityMaterializer,
  PrismaCatalogReleaseSourceRepository,
  ProviderSourceLifecycleRepository,
} from "@packscout/database";
import type { MigratedTestDatabase } from "@packscout/database/test-support";
import {
  type PackScoutBuybackEvProviderTraceV1,
  type PackScoutBuybackEvTraceMetricsV1,
  type PackScoutBuybackEvCertificationReleaseIdentityV1,
} from "./buyback-adjusted-ev-launch-certification.ts";
import { PACKSCOUT_BUYBACK_EV_PRE_BUYBACK_TOKENS_V1 } from "./buyback-adjusted-ev-cutover-inventory.ts";
import {
  computePackScoutBuybackEvRecomputationFingerprintV1,
  derivePackScoutBuybackEvRecomputationBindingV1,
  computePackScoutBuybackEvUnbindableFingerprintV1,
  type PackScoutBuybackEvRecomputationCommandV1,
} from "./buyback-adjusted-ev-recomputation-contracts.ts";
import { PackScoutBuybackAdjustedEvRecomputationService } from "./buyback-adjusted-ev-recomputation-service.ts";
import { PackScoutBuybackEvRevisionStore } from "./buyback-adjusted-ev-revision-store.ts";
import { DataReleaseV3ReleaseAssembler } from "./buyback-adjusted-ev-release-assembler.ts";
import { InMemoryDataReleaseV3Port } from "./buyback-adjusted-ev-release.test-support.ts";
import { PackScoutBuybackEvBackfillReconciliationRunnerV1 } from "./buyback-adjusted-ev-backfill-reconciliation.ts";
import { DataReleaseV3CanonicalCatalogAdapter } from "./data-release-v3-canonical-catalog-adapter.ts";
import { normalizeClutchpacksBuybackEvEvidenceV1 } from "./providers/clutchpacks/buyback-ev-evidence.ts";
import {
  CERTIFICATION_ASSET_ORIGIN,
  CERTIFICATION_EVIDENCE_SHAS,
  CERTIFICATION_PROVIDER_FIXTURES,
  CERTIFICATION_TIMELINE,
  CERTIFICATION_USDC_PARITY,
  clutchpacksCertificationSource,
  type CertificationProviderFixtureV1,
} from "./buyback-adjusted-ev-launch-certification.fixtures.test-support.ts";

export * from "./buyback-adjusted-ev-launch-certification.fixtures.test-support.ts";

/**
 * Shared harness for the task-013 provider-to-browser launch certification.
 *
 * Eight sanitized provider examples are seeded into one governed canonical
 * catalog, normalized through the real task-004 provider modules, recomputed
 * through the real task-006 boundary into the immutable task-005 store,
 * staged (never activated) through the real task-008 assembler and the
 * byte-mirroring publication protocol double, projected through the task-007
 * public contracts, and rendered through the task-010 frontend presentation
 * boundary. Every hop is reconciled against independent plain-arithmetic
 * expectations computed here from the sanitized source numbers.
 *
 * The DB-backed integration test and the local certification generator both
 * run this exact harness, so the recorded traces and the proven traces are
 * one artifact.
 */

// ---------------------------------------------------------------------------
// Governed catalog seeding
// ---------------------------------------------------------------------------

export interface CertificationSeededPlatform {
  readonly providerId: string;
  readonly sourceInstanceId: string;
  readonly providerSourceRevisionId: string;
}

export interface CertificationSeed {
  readonly organizationId: string;
  readonly platforms: ReadonlyMap<string, CertificationSeededPlatform>;
  readonly publicRepackIdByProduct: ReadonlyMap<string, string>;
}

function certificationIdentity(index: number): string {
  const slot = String(index + 1).padStart(2, "0");
  return `9c444444-4444-5444-8444-4444444444${slot}`;
}

const CERTIFICATION_CATEGORY_ID = "9c222222-2222-5222-8222-222222222222";

function certificationConfiguration(
  fixtures: readonly CertificationProviderFixtureV1[],
): ApprovedPublicCatalogConfigurationV1 {
  const ordered = [...fixtures].sort((left, right) =>
    left.providerKey < right.providerKey ? -1 : 1,
  );
  return {
    schemaVersion: "approved_public_catalog_v1",
    configurationKey: "buyback-ev-launch-certification-r1",
    revision: 1,
    approvedAt: CERTIFICATION_TIMELINE.configApprovedAt,
    staleAfterSeconds: 900,
    confidencePolicy: {
      version: "confidence-v1",
      completeScoreBasisPoints: 9_000,
      partialScoreBasisPoints: 6_000,
      unknownScoreBasisPoints: 3_000,
      limitationPenaltyBasisPoints: 500,
    },
    publicAssetOrigins: [CERTIFICATION_ASSET_ORIGIN],
    verifiedUsdStablecoins: ["USDC"],
    categories: [
      {
        publicCategoryId: CERTIFICATION_CATEGORY_ID,
        parentPublicCategoryId: null,
        categoryKey: "cards",
        name: "Cards",
        kind: "vertical",
        depth: 0,
        pathPublicCategoryIds: [CERTIFICATION_CATEGORY_ID],
        displayOrder: 0,
      },
    ],
    platforms: ordered.map((fixture, index) => ({
      platformKey: fixture.providerKey,
      vendor: {
        publicVendorId: `9c111111-1111-5111-8111-1111111111${String(index + 1).padStart(2, "0")}`,
        vendorKey: fixture.providerKey,
        displayName: `Vendor ${fixture.providerKey}`,
        logoUrl: `${CERTIFICATION_ASSET_ORIGIN}/logo.webp`,
        websiteUrl: CERTIFICATION_ASSET_ORIGIN,
        listingHosts: ["certified-vendor.example"],
        imageOrigins: [CERTIFICATION_ASSET_ORIGIN],
        referralParameters: [],
        publicPromo: null,
      },
      format: "repack" as const,
      defaultPublicCategoryIds: [CERTIFICATION_CATEGORY_ID],
      categoryMappings: [],
      collectibleTypeMappings: [],
    })),
    repacks: ordered.map((fixture, index) => ({
      platformKey: fixture.providerKey,
      packExternalId: fixture.productKey,
      publicRepackId: certificationIdentity(index),
    })),
    collectibles: [],
  };
}

/** Prisma Json inputs without importing Prisma types into this package. */
function json(value: unknown): never {
  return JSON.parse(JSON.stringify(value)) as never;
}

function certificationPackContent(fixture: CertificationProviderFixtureV1) {
  return {
    schemaVersion: "catalog-projection-v1",
    entityType: "pack",
    evInputStatus: "unavailable",
    parentExternalId: null,
    name: fixture.packName,
    category: null,
    description: "A sanitized launch-certification pack.",
    availability: "available",
    sourceStatus: null,
    priceValueMinor: fixture.packPriceMinorUnits,
    priceCurrency: "USD",
    providerReportedEvValueMinor: fixture.vendorReportedEvMinorUnits,
    providerReportedEvCurrency:
      fixture.vendorReportedEvMinorUnits === null ? null : "USD",
    buybackPercent: fixture.catalogBuybackPercent,
    drawCount: 1,
    imageUrls: [`${CERTIFICATION_ASSET_ORIGIN}/pack.webp`],
    dataQualityEvidence: [],
  };
}

/**
 * Seeds one governed canonical catalog carrying all eight launch platforms
 * through the same governed tables the production adapter reads: approved
 * configuration, provider lifecycle, append-only canonical revisions, and
 * the settled public watermark.
 */
export async function seedBuybackEvCertificationCatalog(
  harness: Pick<MigratedTestDatabase, "client">,
  input: { readonly organizationId: string; readonly slug: string },
): Promise<CertificationSeed> {
  const fixtures = [...CERTIFICATION_PROVIDER_FIXTURES].sort((left, right) =>
    left.providerKey < right.providerKey ? -1 : 1,
  );
  await harness.client.organizations.create({
    data: { id: input.organizationId, slug: input.slug, name: input.slug },
  });
  const platforms = new Map<string, CertificationSeededPlatform>();
  const ingestion = new Map<
    string,
    {
      providerId: string;
      sourceInstanceId: string;
      providerSourceRevisionId: string;
      sourceRecordId: string;
    }
  >();
  const sourceTypeKey = "dataforrest-events-v1";
  const sourceAdapterVersion = "dataforrest-events-adapter-v1";
  const normalizedContractVersion = "packscout.provider-observation.v1";
  const mapperKey = "dataforrest-catalog-v1";
  const mapperVersion = "1";
  const cursorCodecVersion = "dataforrest-cursor-v1";
  const createdAt = new Date(CERTIFICATION_TIMELINE.configApprovedAt);
  const lifecycle = new ProviderSourceLifecycleRepository(harness.client);
  const connection = await lifecycle.createConnectionProfileRevision({
    organizationId: input.organizationId,
    sourceTypeKey,
    connectionTypeKey: "dataforrest-events-connection-v1",
    displayName: "DataForrest certification",
    requestLimit: 1,
    sourceAdapterVersion,
    revisionNumber: 1,
    configurationCiphertext: new Uint8Array(32).fill(1),
    configurationNonce: new Uint8Array(12).fill(2),
    configurationAuthTag: new Uint8Array(16).fill(3),
    encryptionKeyVersion: 1,
    configurationFingerprint: "a".repeat(64),
    actorKey: "operator:protected-certification-actor",
    createdAt,
  });
  await harness.client.$transaction(async (transaction) => {
    await transaction.source_connection_revisions.update({
      where: { id: connection.revisionId },
      data: { state: "active", activated_at: createdAt },
    });
    await transaction.source_connection_profiles.update({
      where: { id: connection.profileId },
      data: {
        state: "active",
        active_revision_id: connection.revisionId,
        updated_at: createdAt,
      },
    });
  });
  for (const fixture of fixtures) {
    const providerId = randomUUID();
    const runId = randomUUID();
    const pageId = randomUUID();
    await harness.client.provider_sources.create({
      data: {
        id: providerId,
        organization_id: input.organizationId,
        platform_key: fixture.providerKey,
        display_name: `Vendor ${fixture.providerKey}`,
      },
    });
    const source = await lifecycle.createSourceInstanceRevision({
      organizationId: input.organizationId,
      providerId,
      connectionProfileId: connection.profileId,
      sourceTypeKey,
      sourceAdapterVersion,
      normalizedContractVersion,
      mapperKey,
      mapperVersion,
      identityNamespaceKey: `dataforrest-${fixture.providerKey}-v1`,
      cursorCodecVersion,
      revisionNumber: 1,
      intervalSeconds: 300,
      configuration: { provider: fixture.providerKey },
      configurationHash: createHash("sha256")
        .update(fixture.providerKey, "utf8")
        .digest("hex"),
      recordIdScopes: ["catalog-pack-v1", "catalog-card-v1"],
      actorKey: "operator:protected-certification-actor",
      createdAt,
    });
    await harness.client.$transaction(async (transaction) => {
      await transaction.provider_sources.update({
        where: { id: providerId },
        data: { state: "active", updated_at: createdAt },
      });
      await transaction.provider_source_instances.update({
        where: { id: source.sourceInstanceId },
        data: {
          state: "active",
          activated_at: createdAt,
          updated_at: createdAt,
        },
      });
    });
    await harness.client.import_runs.create({
      data: {
        id: runId,
        organization_id: input.organizationId,
        provider_id: providerId,
        config_revision_id: null,
        trigger: "scheduled",
        state: "succeeded",
        started_at: new Date("2026-08-19T17:02:00.000Z"),
        finished_at: new Date(CERTIFICATION_TIMELINE.backfillFinishedAt),
        reached_provider_head: true,
        source_instance_id: source.sourceInstanceId,
        source_revision_id: source.sourceRevisionId,
        source_type_key: sourceTypeKey,
        source_adapter_version: sourceAdapterVersion,
        normalized_contract_version: normalizedContractVersion,
        mapper_key: mapperKey,
        mapper_version: mapperVersion,
        identity_namespace_key: `dataforrest-${fixture.providerKey}-v1`,
        connection_profile_id: connection.profileId,
        connection_revision_id: connection.revisionId,
        cursor_codec_version: cursorCodecVersion,
        cursor_generation: 1n,
        requested_cursor_key: "initial",
        current_cursor_key: "initial",
        next_page_number: 1,
      },
    });
    await harness.client.import_pages.create({
      data: {
        id: pageId,
        organization_id: input.organizationId,
        provider_id: providerId,
        run_id: runId,
        page_number: 1,
        has_more: false,
        payload_hash: "b".repeat(64),
        record_counts_json: json({}),
        expires_at: new Date("2026-11-19T17:00:00.000Z"),
      },
    });
    const sourceRecordId = randomUUID();
    await harness.client.source_records.create({
      data: {
        id: sourceRecordId,
        organization_id: input.organizationId,
        provider_id: providerId,
        first_run_id: runId,
        first_page_id: pageId,
        record_kind: "catalog",
        external_id: `${fixture.productKey}:1`,
        source_time: new Date(fixture.observedAt),
        collected_at: new Date(fixture.observedAt),
        payload_json: json({ rawPayload: "protected-raw-vendor-bytes" }),
        content_hash: "c".repeat(64),
        expires_at: new Date("2026-11-19T17:00:00.000Z"),
      },
    });
    platforms.set(fixture.providerKey, {
      providerId,
      sourceInstanceId: source.sourceInstanceId,
      providerSourceRevisionId: source.sourceRevisionId,
    });
    ingestion.set(fixture.providerKey, {
      providerId,
      sourceInstanceId: source.sourceInstanceId,
      providerSourceRevisionId: source.sourceRevisionId,
      sourceRecordId,
    });
  }
  // The configuration approval settles its own approval-time watermark, so it
  // must land after provider registration and before the canonical
  // revisions whose later settlement clock governs the release read.
  await new PrismaCatalogReleaseSourceRepository(
    harness.client,
    input.organizationId,
  ).approveConfiguration(
    certificationConfiguration(fixtures),
    prismaApprovedPublicRepackIdentityMaterializer,
  );
  for (const fixture of fixtures) {
    const {
      providerId,
      sourceInstanceId,
      providerSourceRevisionId,
      sourceRecordId,
    } =
      ingestion.get(fixture.providerKey)!;
    await harness.client.$transaction(async (transaction) => {
      const causes = await allocatePublicChangeCauses(transaction, {
        organizationId: input.organizationId,
        changes: [
          {
            changeKind: "provider_lifecycle" as const,
            entityKey: `provider:v1:${providerId}`,
            sourceKey: fixture.providerKey,
            sourceRevisionKey: providerSourceRevisionId,
            metadata: {
              providerId,
              platformKey: fixture.providerKey,
              state: "active",
              sourceInstanceId,
              sourceRevisionId: providerSourceRevisionId,
            },
            occurredAt: new Date(CERTIFICATION_TIMELINE.lifecycleAt),
            catalogImpact: {
              kind: "catalog" as const,
              providerPlatformKeys: [fixture.providerKey],
              manifestLifecycle: {
                platformKey: fixture.providerKey,
                state: "active" as const,
              },
            },
          },
          {
            changeKind: "provider_projection" as const,
            entityKey:
              `canonical:v1:${fixture.providerKey}:pack:${fixture.productKey}:1`,
            sourceKey: fixture.providerKey,
            sourceRevisionKey: `${fixture.productKey}:1`,
            occurredAt: new Date(CERTIFICATION_TIMELINE.projectionAt),
            catalogImpact: {
              kind: "catalog" as const,
              providerPlatformKeys: [fixture.providerKey],
            },
          },
        ],
      });
      const entityId = randomUUID();
      await transaction.canonical_entities.create({
        data: {
          id: entityId,
          organization_id: input.organizationId,
          platform_key: fixture.providerKey,
          record_kind: "pack",
          external_id: fixture.productKey,
        },
      });
      const revisionId = randomUUID();
      await transaction.canonical_revisions.create({
        data: {
          id: revisionId,
          organization_id: input.organizationId,
          entity_id: entityId,
          revision_number: 1,
          source_record_id: sourceRecordId,
          content_json: json(certificationPackContent(fixture)),
          content_hash: createHash("sha256")
            .update(JSON.stringify(certificationPackContent(fixture)), "utf8")
            .digest("hex"),
          provenance_json: json({ providerId }),
          provenance_hash: "d".repeat(64),
          actor_key: "operator:protected-projection-actor",
          source_updated_at: new Date(fixture.observedAt),
          source_collected_at: new Date(fixture.observedAt),
          accepted_at: new Date(CERTIFICATION_TIMELINE.projectionAt),
          public_change_sequence: causes[1]!.sequence,
        },
      });
      await transaction.canonical_entities.update({
        where: { id: entityId },
        data: { current_revision_id: revisionId },
      });
    });
  }
  await harness.client.$transaction(async (transaction) => {
    await advanceSettledPublicWatermark(transaction, {
      organizationId: input.organizationId,
      settledAt: new Date(CERTIFICATION_TIMELINE.watermarkAt),
    });
  });
  const publicRepackIdByProduct = new Map(
    certificationConfiguration(fixtures).repacks.map((mapping) => [
      mapping.packExternalId,
      mapping.publicRepackId,
    ]),
  );
  return {
    organizationId: input.organizationId,
    platforms,
    publicRepackIdByProduct,
  };
}

// ---------------------------------------------------------------------------
// Frontend presentation boundary loading
// ---------------------------------------------------------------------------

/** The narrow structural surface of the task-010 presentation boundary. */
export interface PackScoutEvPresentationBoundary {
  presentPackScoutEvV3(input: {
    estimate: PublicRepackDetailV3["evEstimates"]["packScout"];
    price: PublicRepackSummaryV3["price"];
    availability: PublicRepackSummaryV3["availability"];
    repackName?: string;
  }): Readonly<{
    availability: "available" | "unavailable";
    status: string;
    statusLabel: string;
    semanticState: "positive" | "neutral" | "negative" | "unavailable";
    simulated: boolean;
    zeroPayout: boolean;
    sourceLine: string;
    adviceLine: string;
    grossEvDollars: { displayValue: string };
    grossEvPercent: { displayValue: string };
    evDollars: { displayValue: string };
    evPercent: { displayValue: string };
    packPrice: { displayValue: string };
    confidence: {
      displayValue: string;
      limitations: readonly string[];
    };
    freshness: {
      sourceAgeState: string | null;
      sourceAgeLabel: string | null;
      delayed: boolean;
      dataAsOf: string | null;
    };
    reasonCopy?: string;
    outboundActionAllowed: boolean;
    accessibleLabel: string;
  }>;
  presentVendorReportedEvV3(
    estimate: PublicRepackDetailV3["evEstimates"]["vendorReported"],
  ): Readonly<{
    availability: "available" | "unavailable";
    label: string;
    sourceNote: string;
    reported: { displayValue: string };
    accessibleLabel: string;
  }>;
}

/**
 * Loads `apps/frontend/lib/packscout-ev-presentation.ts` for the final
 * certification hop.
 *
 * Mechanism, documented per the launch plan: production code never crosses
 * the services/frontend boundary, so this harness resolves the frontend
 * module to a file URL at runtime and imports it under the tsx loader that
 * already runs the services test lane and the local certification script.
 * The specifier is computed — not a literal — because this is a test-only
 * certification seam, not a dependency direction production code may take.
 */
export async function loadPackScoutEvPresentationBoundary(): Promise<PackScoutEvPresentationBoundary> {
  const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../..",
  );
  const presentationPath = path.join(
    repositoryRoot,
    "apps",
    "frontend",
    "lib",
    "packscout-ev-presentation.ts",
  );
  const loaded = (await import(
    pathToFileURL(presentationPath).href
  )) as unknown as PackScoutEvPresentationBoundary;
  if (
    typeof loaded.presentPackScoutEvV3 !== "function" ||
    typeof loaded.presentVendorReportedEvV3 !== "function"
  ) {
    throw new Error(
      "The frontend presentation boundary did not expose the certification surface.",
    );
  }
  return loaded;
}

// ---------------------------------------------------------------------------
// Public-boundary forbidden tokens
// ---------------------------------------------------------------------------

/**
 * Tokens that must never appear in any serialized public release or rendered
 * presentation output: raw payload markers, protected evidence spellings,
 * credentials and infrastructure, organization and provider identifiers,
 * source revision identifiers, and the pre-buyback vocabulary.
 */
export function certificationForbiddenTokens(
  seed: CertificationSeed,
): readonly string[] {
  return [
    ...PACKSCOUT_BUYBACK_EV_PRE_BUYBACK_TOKENS_V1,
    "protected-raw-vendor-bytes",
    "protected-feed",
    "protected-certification-actor",
    "protected-projection-actor",
    "rawPayload",
    "payload_json",
    "underlyingOutcomeEv",
    "drawMultiplier",
    "protectedEvidence",
    "internalReasons",
    "effectiveFingerprint",
    "oddsSource",
    "sourceRevisionId",
    "configurationRevisionId",
    "providerSourceRevisionId",
    "sourceInstanceId",
    CERTIFICATION_EVIDENCE_SHAS.manifest,
    CERTIFICATION_EVIDENCE_SHAS.homogeneity,
    CERTIFICATION_EVIDENCE_SHAS.collectionGuard,
    seed.organizationId,
    ...[...seed.platforms.values()].flatMap((platform) => [
      platform.providerId,
      platform.sourceInstanceId,
      platform.providerSourceRevisionId,
    ]),
    ...CERTIFICATION_PROVIDER_FIXTURES.map(
      ({ sourceRevisionId }) => sourceRevisionId,
    ),
  ];
}

// ---------------------------------------------------------------------------
// The certification harness
// ---------------------------------------------------------------------------

export interface CertificationHarnessResult {
  readonly traces: readonly PackScoutBuybackEvProviderTraceV1[];
  readonly candidateRelease: PackScoutBuybackEvCertificationReleaseIdentityV1;
  readonly vendorEvSeparationProven: boolean;
  readonly pullsVerifiedInventoryOnly: boolean;
  readonly publicBoundaryScan: Readonly<{
    scannedReleases: number;
    forbiddenTokensChecked: number;
    hits: readonly string[];
  }>;
  readonly ledgerRowCount: number;
  readonly pullsProof: Readonly<{
    baselineGrossEvMinorUnits: number;
    provenPullsGrossEvMinorUnits: number;
    unprovenPullsGrossEvMinorUnits: number;
    secondReleaseId: string;
  }>;
}

interface TraceCheck {
  mismatch: string | null;
}

function check(
  state: TraceCheck,
  holds: boolean,
  description: string,
): void {
  if (!holds && state.mismatch === null) {
    state.mismatch = description;
  }
}

function metricsOf(
  detail: PublicRepackDetailV3,
): PackScoutBuybackEvTraceMetricsV1 | null {
  const estimate = detail.evEstimates.packScout;
  if (estimate.status === "unavailable") return null;
  return {
    grossEvMinorUnits: estimate.metrics.grossEvMoney.minorUnits,
    grossReturnBasisPoints: estimate.metrics.grossReturnBasisPoints,
    evDollarsMinorUnits: estimate.metrics.evDollars.minorUnits,
    evPercentBasisPoints: estimate.metrics.evPercentBasisPoints,
  };
}

function orEmpty(value: string | undefined): string {
  return value ?? "";
}

/**
 * Runs the complete provider-to-browser certification against one migrated
 * PostgreSQL database and returns the reconciled traces plus the separation,
 * pulls, and sanitization proofs. Throws only on harness misuse; evidence
 * disagreements are recorded as trace mismatches so the caller can compose a
 * blocked certification instead of losing the record.
 */
export async function runBuybackEvLaunchCertificationHarness(
  harness: Pick<MigratedTestDatabase, "client" | "database">,
  input: {
    readonly organizationId: string;
    readonly slug: string;
    readonly presentation: PackScoutEvPresentationBoundary;
  },
): Promise<CertificationHarnessResult> {
  const seed = await seedBuybackEvCertificationCatalog(harness, {
    organizationId: input.organizationId,
    slug: input.slug,
  });
  const store = new PackScoutBuybackEvRevisionStore(
    new BuybackEvRevisionRepository(harness.database),
  );
  const service = new PackScoutBuybackAdjustedEvRecomputationService(store);
  const source = new PrismaDataReleaseV3CanonicalCatalogSource(
    harness.client,
    input.organizationId,
  );
  const catalog = new DataReleaseV3CanonicalCatalogAdapter(source);
  const assembler = new DataReleaseV3ReleaseAssembler(catalog, service);
  const port = new InMemoryDataReleaseV3Port();
  const fixtureByProduct = new Map(
    CERTIFICATION_PROVIDER_FIXTURES.map((fixture) => [
      fixture.productKey,
      fixture,
    ]),
  );

  const commandFor = (
    fixture: CertificationProviderFixtureV1,
  ): PackScoutBuybackEvRecomputationCommandV1 => {
    const platform = seed.platforms.get(fixture.providerKey);
    if (platform === undefined) {
      throw new Error(`Unseeded certification platform: ${fixture.providerKey}`);
    }
    return {
      organizationId: input.organizationId,
      providerId: platform.providerId,
      providerSourceRevisionId: platform.providerSourceRevisionId,
      evidence: fixture.normalize(),
      calculatedAt: CERTIFICATION_TIMELINE.calculatedAt,
    };
  };

  const runner = new PackScoutBuybackEvBackfillReconciliationRunnerV1({
    catalog,
    recomputation: service,
    assembler,
    evidence: {
      loadCommand: async ({ productKey }) => {
        const fixture = fixtureByProduct.get(productKey);
        return fixture === undefined ? null : commandFor(fixture);
      },
    },
    publication: port,
  });
  const backfill = await runner.run({ readAt: CERTIFICATION_TIMELINE.readAt });
  if (backfill.classification !== "ready" || backfill.ledger.staging === null) {
    throw new Error(
      `Certification backfill blocked: ${JSON.stringify(
        backfill.ledger.blockedReasons,
      )}`,
    );
  }

  // Independent re-assembly must reproduce the staged release identity, and
  // the plan's repack batches are the hash-chained staged rows themselves.
  const plan = await assembler.assemble({
    readAt: CERTIFICATION_TIMELINE.readAt,
  });
  if (plan.classification !== "publish") {
    throw new Error("Certification release plan did not classify as publish.");
  }
  if (plan.publicReleaseId !== backfill.ledger.staging.publicReleaseId) {
    throw new Error(
      "Independent re-assembly diverged from the staged release identity.",
    );
  }
  const details = plan.batches
    .filter(({ kind }) => kind === "repacks")
    .flatMap(({ records }) => records) as readonly PublicRepackDetailV3[];
  const detailByProduct = new Map(
    [...seed.publicRepackIdByProduct.entries()].map(
      ([productKey, publicRepackId]) => [
        productKey,
        details.find(
          (detail) => detail.publicRepackId === publicRepackId,
        ) ?? null,
      ],
    ),
  );
  const ledgerRowByProduct = new Map(
    backfill.ledger.rows.map((row) => [row.productKey, row]),
  );

  const traces: PackScoutBuybackEvProviderTraceV1[] = [];
  let vendorEvSeparationProven = false;
  for (const fixture of CERTIFICATION_PROVIDER_FIXTURES) {
    const state: TraceCheck = { mismatch: null };
    const platform = seed.platforms.get(fixture.providerKey)!;
    const evidence = fixture.normalize();
    const expected = fixture.expected;

    // Hop 1: source revision -> normalized evidence.
    check(
      state,
      evidence.status ===
        (expected.status === "current" ? "complete" : "unavailable"),
      "normalized evidence status diverged from the sanitized source example",
    );
    const binding = derivePackScoutBuybackEvRecomputationBindingV1(evidence);
    check(
      state,
      binding.kind === "bindable" &&
        binding.productKey === fixture.productKey &&
        binding.sourceRevisionId === fixture.sourceRevisionId &&
        binding.observedAt === fixture.observedAt,
      "the evidence binding lost the source revision or observation time",
    );

    // Hop 2: fingerprint and immutable revision.
    const fingerprint =
      binding.kind === "bindable"
        ? computePackScoutBuybackEvRecomputationFingerprintV1(
            binding,
            platform.providerSourceRevisionId,
          )
        : computePackScoutBuybackEvUnbindableFingerprintV1({
            organizationId: input.organizationId,
            providerId: platform.providerId,
            providerSourceRevisionId: platform.providerSourceRevisionId,
            evidence: evidence as Extract<
              PackScoutBuybackEvEvidenceOutcomeV1,
              { status: "unavailable" }
            >,
          });
    const replay = await service.recompute(commandFor(fixture));
    check(
      state,
      replay.outcome === "unchanged",
      "the certification replay did not converge onto the immutable revision",
    );
    const revision =
      replay.outcome === "created" || replay.outcome === "unchanged"
        ? replay.revision
        : null;
    const projection =
      replay.outcome === "created" || replay.outcome === "unchanged"
        ? replay.projection
        : null;
    check(
      state,
      revision !== null && revision.effectiveFingerprint === fingerprint,
      "the stored revision fingerprint diverged from the evidence fingerprint",
    );

    // Hop 3: canonical metrics and confidence.
    if (expected.status === "current") {
      check(
        state,
        projection !== null &&
          projection.status === "available" &&
          projection.metrics.grossEvMoney.minorUnits ===
            expected.metrics!.grossEvMinorUnits &&
          projection.metrics.grossReturnBasisPoints ===
            expected.metrics!.grossReturnBasisPoints &&
          projection.metrics.evDollars.minorUnits ===
            expected.metrics!.evDollarsMinorUnits &&
          projection.metrics.evPercentBasisPoints ===
            expected.metrics!.evPercentBasisPoints,
        "canonical metrics diverged from the independent plain-arithmetic expectation",
      );
      check(
        state,
        projection !== null &&
          projection.status === "available" &&
          projection.confidence.scoreBasisPoints ===
            expected.confidence!.scoreBasisPoints &&
          projection.confidence.band === expected.confidence!.band &&
          JSON.stringify(projection.confidence.limitationCodes) ===
            JSON.stringify(expected.confidence!.limitationCodes),
        "canonical confidence diverged from the approved penalty table",
      );
      check(
        state,
        projection !== null &&
          projection.status === "available" &&
          projection.calculatedAt === CERTIFICATION_TIMELINE.calculatedAt &&
          projection.dataAsOf.observedAt === fixture.observedAt,
        "canonical timestamps diverged from the observation and calculation clocks",
      );
    } else {
      check(
        state,
        projection !== null &&
          projection.status === "unavailable" &&
          projection.publicReason === expected.publicReason &&
          projection.dataAsOf.state === "known" &&
          projection.dataAsOf.observedAt === fixture.observedAt,
        "the unavailable projection lost its bounded reason or source time",
      );
    }

    // Hop 4: public release row.
    const ledgerRow = ledgerRowByProduct.get(fixture.productKey);
    const detail = detailByProduct.get(fixture.productKey) ?? null;
    check(
      state,
      ledgerRow !== undefined &&
        ledgerRow.platformKey === fixture.providerKey &&
        ledgerRow.revisionId !== null,
      "the backfill ledger lost the certification revision identity",
    );
    check(state, detail !== null, "the staged release lost the repack row");
    if (detail !== null) {
      const estimate = detail.evEstimates.packScout;
      if (expected.status === "current") {
        const releaseMetrics = metricsOf(detail);
        check(
          state,
          estimate.status === "current" &&
            releaseMetrics !== null &&
            JSON.stringify(releaseMetrics) ===
              JSON.stringify(expected.metrics),
          "public release metrics diverged from the canonical revision",
        );
        check(
          state,
          estimate.status === "current" &&
            estimate.confidence.scoreBasisPoints ===
              expected.confidence!.scoreBasisPoints &&
            estimate.sourceAge.state === expected.sourceAgeState &&
            estimate.dataAsOf.observedAt === fixture.observedAt &&
            estimate.calculatedAt === CERTIFICATION_TIMELINE.calculatedAt,
          "public release confidence, freshness, or timestamps diverged",
        );
      } else {
        check(
          state,
          estimate.status === "unavailable" &&
            estimate.reason === expected.publicReason &&
            estimate.metrics === null &&
            estimate.confidence === null,
          "the public unavailable state lost its reason or leaked metrics",
        );
      }
      check(
        state,
        detail.price.usdComparison.status === "available" &&
          detail.price.usdComparison.value.minorUnits ===
            fixture.packPriceMinorUnits,
        "the public pack price diverged from the canonical listing price",
      );

      // Hop 5: query projection byte-equivalence (summary vs detail).
      const summary = publicRepackSummaryV3FromDetail(detail);
      check(
        state,
        packScoutEvProjectionsAreByteEquivalentV3(summary, detail),
        "the summary query projection is not byte-equivalent to the detail",
      );

      // Hop 6: rendered presentation output.
      const rendered = input.presentation.presentPackScoutEvV3({
        estimate,
        price: detail.price,
        availability: detail.availability,
        repackName: detail.name,
      });
      check(
        state,
        rendered.statusLabel === expected.rendered.statusLabel &&
          rendered.grossEvDollars.displayValue ===
            expected.rendered.grossEvDollars &&
          rendered.grossEvPercent.displayValue ===
            expected.rendered.grossEvPercent &&
          rendered.evDollars.displayValue === expected.rendered.evDollars &&
          rendered.evPercent.displayValue === expected.rendered.evPercent &&
          rendered.confidence.displayValue ===
            expected.rendered.confidenceDisplay &&
          (rendered.reasonCopy ?? null) === expected.rendered.reasonCopy &&
          rendered.semanticState === expected.rendered.semanticState,
        "the rendered browser values diverged from the deterministic derivation",
      );
      check(
        state,
        rendered.simulated === false &&
          rendered.outboundActionAllowed === true &&
          rendered.sourceLine ===
            "PackScout Gross EV — calculated from platform-provided data" &&
          rendered.adviceLine === "Not financial or gambling advice",
        "trust copy, provenance labeling, or the outbound-action rule diverged",
      );
      if (expected.sourceAgeState !== null) {
        check(
          state,
          rendered.freshness.sourceAgeState === expected.sourceAgeState &&
            rendered.freshness.delayed ===
              (expected.sourceAgeState !== "fresh_within_15_minutes"),
          "the rendered freshness state diverged from the release source age",
        );
      }

      // Vendor separation is proven on the one fixture that reports one.
      if (fixture.vendorReportedEvMinorUnits !== null) {
        const vendor = input.presentation.presentVendorReportedEvV3(
          detail.evEstimates.vendorReported,
        );
        const vendorSeparate =
          detail.evEstimates.vendorReported.status === "available" &&
          detail.evEstimates.vendorReported.sourceMoney !== null &&
          detail.evEstimates.vendorReported.sourceMoney.minorUnits ===
            fixture.vendorReportedEvMinorUnits &&
          expected.metrics !== null &&
          detail.evEstimates.vendorReported.sourceMoney.minorUnits !==
            expected.metrics.grossEvMinorUnits &&
          vendor.sourceNote ===
            "Reported by vendor — separate from PackScout Gross EV" &&
          vendor.reported.displayValue === "$111.11";
        check(
          state,
          vendorSeparate,
          "vendor-reported EV was merged into or substituted for PackScout EV",
        );
        vendorEvSeparationProven = vendorSeparate && state.mismatch === null;
      }

      const renderedRecord = {
        statusLabel: rendered.statusLabel,
        grossEvDollars: rendered.grossEvDollars.displayValue,
        grossEvPercent: rendered.grossEvPercent.displayValue,
        evDollars: rendered.evDollars.displayValue,
        evPercent: rendered.evPercent.displayValue,
        confidenceDisplay: rendered.confidence.displayValue,
        reasonCopy: rendered.reasonCopy ?? null,
        sourceAgeLabel: rendered.freshness.sourceAgeLabel,
        outboundActionAllowed: rendered.outboundActionAllowed,
      };
      traces.push({
        providerKey: fixture.providerKey,
        productKey: fixture.productKey,
        scenario: fixture.scenario,
        scenarioClasses: fixture.scenarioClasses,
        sourceRevisionId: fixture.sourceRevisionId,
        observedAt: fixture.observedAt,
        calculatedAt: CERTIFICATION_TIMELINE.calculatedAt,
        effectiveFingerprint: fingerprint,
        revisionId: orEmpty(revision?.revisionId),
        status: expected.status,
        publicReason: expected.publicReason,
        metrics: expected.status === "current" ? metricsOf(detail) : null,
        confidence:
          expected.status === "current" &&
          detail.evEstimates.packScout.status === "current"
            ? {
                scoreBasisPoints:
                  detail.evEstimates.packScout.confidence.scoreBasisPoints,
                band: detail.evEstimates.packScout.confidence.band,
                limitationCodes: [
                  ...detail.evEstimates.packScout.confidence.limitationCodes,
                ],
              }
            : null,
        rendered: renderedRecord,
        hopsReconciled: state.mismatch === null,
        firstMismatch: state.mismatch,
      });
    } else {
      traces.push({
        providerKey: fixture.providerKey,
        productKey: fixture.productKey,
        scenario: fixture.scenario,
        scenarioClasses: fixture.scenarioClasses,
        sourceRevisionId: fixture.sourceRevisionId,
        observedAt: fixture.observedAt,
        calculatedAt: CERTIFICATION_TIMELINE.calculatedAt,
        effectiveFingerprint: fingerprint,
        revisionId: orEmpty(revision?.revisionId),
        status: expected.status,
        publicReason: expected.publicReason,
        metrics: null,
        confidence: null,
        rendered: {
          statusLabel: "",
          grossEvDollars: "",
          grossEvPercent: "",
          evDollars: "",
          evPercent: "",
          confidenceDisplay: "",
          reasonCopy: null,
          sourceAgeLabel: null,
          outboundActionAllowed: false,
        },
        hopsReconciled: false,
        firstMismatch: state.mismatch ?? "the staged release lost the repack row",
      });
    }
  }

  // Pulls proof: verified remaining-inventory updates are the only channel
  // through which recent pulls may change EV.
  const clutchpacks = seed.platforms.get("clutchpacks")!;
  const pullsCommand: PackScoutBuybackEvRecomputationCommandV1 = {
    organizationId: input.organizationId,
    providerId: clutchpacks.providerId,
    providerSourceRevisionId: clutchpacks.providerSourceRevisionId,
    evidence: normalizeClutchpacksBuybackEvEvidenceV1(
      clutchpacksCertificationSource({
        siteRevisionId: "cert-clutch-rev-2",
        observedAt: CERTIFICATION_TIMELINE.pullsObservedAt,
        remainingAlpha: 3,
        remainingBeta: 1,
        publishedPercents: null,
        pullLedger: [
          { bucketId: "alpha", pulls: 2, ledgerRevisionId: "cert-clutch-rev-2" },
        ],
      }),
      {
        evaluatedAt: CERTIFICATION_TIMELINE.pullsCalculatedAt,
        stablecoinParityApprovals: [CERTIFICATION_USDC_PARITY],
      },
    ),
    calculatedAt: CERTIFICATION_TIMELINE.pullsCalculatedAt,
  };
  const pullsResult = await service.recompute(pullsCommand);
  // Verified pulls: remaining {1, 1} -> (1/2) x 1800c + (1/2) x 8000c.
  const provenPullsGross =
    pullsResult.outcome === "created" &&
    pullsResult.projection.status === "available"
      ? pullsResult.projection.metrics.grossEvMoney.minorUnits
      : -1;
  const secondPlan = await assembler.assemble({
    readAt: CERTIFICATION_TIMELINE.readAtAfterPulls,
  });
  let secondReleaseId = "";
  let pullsReleaseGross = -1;
  if (secondPlan.classification === "publish") {
    secondReleaseId = secondPlan.publicReleaseId;
    const secondDetails = secondPlan.batches
      .filter(({ kind }) => kind === "repacks")
      .flatMap(({ records }) => records) as readonly PublicRepackDetailV3[];
    const clutchDetail = secondDetails.find(
      (detail) =>
        detail.publicRepackId ===
        seed.publicRepackIdByProduct.get("clutchpacks:cert-pack-1"),
    );
    if (
      clutchDetail !== undefined &&
      clutchDetail.evEstimates.packScout.status === "current"
    ) {
      pullsReleaseGross =
        clutchDetail.evEstimates.packScout.metrics.grossEvMoney.minorUnits;
    }
  }
  const unprovenCommand: PackScoutBuybackEvRecomputationCommandV1 = {
    organizationId: input.organizationId,
    providerId: clutchpacks.providerId,
    providerSourceRevisionId: clutchpacks.providerSourceRevisionId,
    evidence: normalizeClutchpacksBuybackEvEvidenceV1(
      clutchpacksCertificationSource({
        siteRevisionId: "cert-clutch-rev-3",
        observedAt: CERTIFICATION_TIMELINE.unprovenObservedAt,
        remainingAlpha: 3,
        remainingBeta: 1,
        publishedPercents: null,
        // The pull ledger names a different revision: never applied.
        pullLedger: [
          { bucketId: "alpha", pulls: 2, ledgerRevisionId: "cert-clutch-rev-9" },
        ],
      }),
      {
        evaluatedAt: CERTIFICATION_TIMELINE.unprovenCalculatedAt,
        stablecoinParityApprovals: [CERTIFICATION_USDC_PARITY],
      },
    ),
    calculatedAt: CERTIFICATION_TIMELINE.unprovenCalculatedAt,
  };
  const unprovenResult = await service.recompute(unprovenCommand);
  const unprovenGross =
    unprovenResult.outcome === "created" &&
    unprovenResult.projection.status === "available"
      ? unprovenResult.projection.metrics.grossEvMoney.minorUnits
      : -1;
  const pullsVerifiedInventoryOnly =
    provenPullsGross === 4_900 &&
    pullsReleaseGross === 4_900 &&
    unprovenGross === 3_350;

  // Public-boundary sanitization: the serialized staged releases and every
  // rendered presentation must carry none of the forbidden tokens, and the
  // contract tripwires must agree.
  const forbiddenTokens = certificationForbiddenTokens(seed);
  const renderedOutputs = traces.map((trace) => trace.rendered);
  const scannedPayloads = [
    JSON.stringify(plan),
    secondPlan.classification === "publish" ? JSON.stringify(secondPlan) : "",
    JSON.stringify(renderedOutputs),
  ];
  const hits = forbiddenTokens.filter((token) =>
    scannedPayloads.some((payload) => payload.includes(token)),
  );
  if (
    containsProtectedEvPublicationKeyV3({ repacks: details }) ||
    containsProtectedPublicationField({ repacks: details })
  ) {
    hits.push("contract-protected-publication-tripwire");
  }

  // The exact approved-configuration fingerprint, recorded from the same raw
  // snapshot the release read, mirroring the task-012 ledger script.
  const rawSnapshot = await source.loadSourceSnapshot({
    readAt: CERTIFICATION_TIMELINE.readAt,
  });
  const configurationFingerprintSha256 = createHash("sha256")
    .update(
      JSON.stringify(rawSnapshot.configuration ?? null, (_key, entry) =>
        typeof entry === "bigint" ? entry.toString() : entry,
      ),
      "utf8",
    )
    .digest("hex");

  return {
    traces,
    candidateRelease: {
      publicReleaseId: plan.publicReleaseId,
      releaseFingerprint: plan.releaseFingerprint,
      dataAsOf: CERTIFICATION_TIMELINE.readAt,
      configurationFingerprintSha256,
    },
    vendorEvSeparationProven,
    pullsVerifiedInventoryOnly,
    publicBoundaryScan: {
      scannedReleases: secondPlan.classification === "publish" ? 2 : 1,
      forbiddenTokensChecked: forbiddenTokens.length,
      hits,
    },
    ledgerRowCount: backfill.ledger.rows.length,
    pullsProof: {
      baselineGrossEvMinorUnits: 3_350,
      provenPullsGrossEvMinorUnits: provenPullsGross,
      unprovenPullsGrossEvMinorUnits: unprovenGross,
      secondReleaseId,
    },
  };
}
