import {
  lockProviderWorkerLease,
  providerWorkerLeaseIsLive,
  type BoundedProviderDatabaseGateway,
  type CentralPrismaClient,
  type ProviderPrismaClient,
} from "@packscout/database";
import { publicHttpsOriginSchema } from "@packscout/contracts";
import { packContentBackfillDigest } from "./pack-content-backfill-contract.mts";
import { loadPackContentBackfillReadiness } from "./pack-content-backfill-readiness.mts";
import { readClutchpacksContentCatalog } from "./distributed-clutchpacks-content-snapshot.mts";
import type { OwnedPublicationImportLease } from "./distributed-clutchpacks-publication-lease.mts";
import {
  DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY,
  DistributedClutchpacksPublicationError,
  assertDistributedClutchpacksStableSnapshot,
  type DistributedClutchpacksPackRow,
  type DistributedClutchpacksSnapshotFacts,
  type DistributedClutchpacksStableSnapshot,
} from "./distributed-clutchpacks-publication-plan.mts";

function refuse(code: string): never {
  throw new DistributedClutchpacksPublicationError(code);
}
function required(value: string | undefined, code: string): string {
  const normalized = value?.trim() ?? "";
  if (normalized.length === 0 || /[\r\n\0]/u.test(normalized)) return refuse(code);
  return normalized;
}

async function centralSnapshot(central: CentralPrismaClient) {
  const provider = await central.providers.findUnique({
    where: { provider_key: DISTRIBUTED_CLUTCHPACKS_PLATFORM_KEY },
    select: {
      id: true,
      organization_id: true,
      provider_key: true,
      display_name: true,
      lifecycle: true,
      active_config_version_id: true,
      active_public_profile_version_id: true,
      active_config_version: {
        select: {
          id: true,
          version_number: true,
          stale_after_seconds: true,
          created_at: true,
        },
      },
      _count: {
        select: {
          category_correlations: true,
          collectible_correlations: true,
        },
      },
    },
  });
  if (
    provider === null || provider.lifecycle !== "active" ||
    provider.active_config_version_id === null ||
    provider.active_config_version === null ||
    provider.active_config_version.id !== provider.active_config_version_id ||
    provider.active_public_profile_version_id !== null ||
    provider._count.category_correlations !== 0 ||
    provider._count.collectible_correlations !== 0
  ) return refuse("CLUTCHPACKS_CENTRAL_STATE_UNSUPPORTED");
  const [globalCategoryCount, globalCollectibleCount] = await Promise.all([
    central.global_categories.count(),
    central.global_collectibles.count(),
  ]);
  if (globalCategoryCount !== 0 || globalCollectibleCount !== 0) {
    return refuse("CLUTCHPACKS_CENTRAL_STATE_UNSUPPORTED");
  }
  return provider;
}

function decimalString(value: { toString(): string } | null, code: string): string {
  if (value === null) return refuse(code);
  return value.toString();
}

export async function providerSnapshot(
  database: ProviderPrismaClient,
  central: Awaited<ReturnType<typeof centralSnapshot>>,
  approvedPublicAssetOrigins: readonly string[],
  expectedImportLease?: OwnedPublicationImportLease,
): Promise<DistributedClutchpacksSnapshotFacts> {
  const activeConfigVersion = central.active_config_version;
  if (activeConfigVersion === null) {
    return refuse("CLUTCHPACKS_CENTRAL_STATE_UNSUPPORTED");
  }
  return await database.$transaction(async (transaction) => {
    const now = new Date();
    const [
      identity,
      runtime,
      latestSourceHead,
      ledger,
      promotionAggregate,
      activePackCount,
      activeCollectibleCount,
      activePackContentCount,
      runningRunCount,
      queuedRunCount,
      importWorker,
      packs,
    ] = await Promise.all([
      transaction.database_identity.findUnique({ where: { singleton_key: true } }),
      transaction.provider_runtime.findUnique({ where: { singleton_key: true } }),
      transaction.provider_runs.findFirst({
        where: { state: "succeeded", reached_source_head: true },
        orderBy: [{ finished_at: "desc" }, { id: "desc" }],
      }),
      transaction.promotion_ledger.findUnique({ where: { singleton_key: true } }),
      transaction.promotion_changes.aggregate({
        _count: { _all: true },
        _min: { sequence: true },
        _max: { sequence: true, changed_at: true },
      }),
      transaction.packs.count({ where: { lifecycle: "active" } }),
      transaction.collectibles.count({ where: { lifecycle: "active" } }),
      transaction.pack_contents.count({ where: { lifecycle: "active" } }),
      transaction.provider_runs.count({ where: { state: "running" } }),
      transaction.provider_runs.count({ where: { state: "queued" } }),
      transaction.provider_worker_states.findUnique({ where: { worker_role: "import" } }),
      transaction.packs.findMany({
        where: { lifecycle: "active" },
        orderBy: [{ pack_key: "asc" }, { id: "asc" }],
        select: {
          id: true,
          pack_key: true,
          row_version: true,
          attributes: true,
          display_name: true,
          description: true,
          pack_format: true,
          availability: true,
          content_evidence: true,
          price_amount: true,
          price_currency: true,
          price_usd_amount: true,
          buyback_rate: true,
          buyback_source_kind: true,
          vendor_ev_amount: true,
          vendor_ev_currency: true,
          vendor_ev_observed_at: true,
          packscout_ev_model_version: true,
          packscout_ev_confidence_policy_version: true,
          packscout_ev_data_as_of: true,
          packscout_ev_calculated_at: true,
          primary_image_url: true,
          primary_image_alt: true,
          listing_url: true,
          source_updated_at: true,
        },
      }),
    ]);
    if (
      identity === null || runtime === null || latestSourceHead === null ||
      latestSourceHead.finished_at === null || ledger === null ||
      importWorker === null ||
      packs.length === 0
    ) return refuse("CLUTCHPACKS_SNAPSHOT_INELIGIBLE");
    const mappedPacks: DistributedClutchpacksPackRow[] = packs.map((pack) => ({
      id: pack.id,
      rowVersion: pack.row_version,
      packKey: pack.pack_key,
      displayName: pack.display_name,
      description: pack.description,
      packFormat: pack.pack_format,
      availability: pack.availability,
      contentEvidence: pack.content_evidence,
      priceAmount: decimalString(pack.price_amount, "PUBLIC_PRICE_INVALID"),
      priceCurrency: required(pack.price_currency ?? undefined, "PUBLIC_PRICE_INVALID"),
      priceUsdAmount: decimalString(pack.price_usd_amount, "PUBLIC_PRICE_INVALID"),
      buybackRate: pack.buyback_rate?.toString() ?? null,
      buybackSourceKind: pack.buyback_source_kind,
      vendorEvAmount: pack.vendor_ev_amount?.toString() ?? null,
      vendorEvCurrency: pack.vendor_ev_currency,
      vendorEvObservedAt: pack.vendor_ev_observed_at,
      packscoutEvModelVersion: pack.packscout_ev_model_version,
      packscoutEvConfidencePolicyVersion:
        pack.packscout_ev_confidence_policy_version,
      packscoutEvDataAsOf: pack.packscout_ev_data_as_of,
      packscoutEvCalculatedAt: pack.packscout_ev_calculated_at,
      primaryImageUrl: required(pack.primary_image_url ?? undefined, "PUBLIC_IMAGE_INVALID"),
      primaryImageAlt: pack.primary_image_alt,
      listingUrl: pack.listing_url,
      sourceUpdatedAt: pack.source_updated_at,
      ...(typeof pack.attributes === "object" && pack.attributes !== null &&
          !Array.isArray(pack.attributes) && Object.hasOwn(pack.attributes, "evInputEvidence")
        ? { evInputEvidence: pack.attributes.evInputEvidence }
        : {}),
    }));
    const maximumPackSourceUpdatedAt = mappedPacks.reduce(
      (latest, pack) =>
        pack.sourceUpdatedAt.getTime() > latest.getTime()
          ? pack.sourceUpdatedAt
          : latest,
      mappedPacks[0]!.sourceUpdatedAt,
    );
    let ownsImportLease = false;
    if (expectedImportLease !== undefined) {
      const leaseRow = await lockProviderWorkerLease(transaction, "import");
      if (expectedImportLease.role !== "import" || !providerWorkerLeaseIsLive(leaseRow, expectedImportLease) ||
          queuedRunCount !== 0 || await transaction.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }) !== 0) {
        return refuse("LOCAL_PUBLICATION_IMPORT_LEASE_UNAVAILABLE");
      }
      ownsImportLease = true;
    }
    const activeImportLeaseCount = !ownsImportLease &&
      importWorker.lease_owner !== null &&
        importWorker.lease_expires_at !== null &&
        importWorker.lease_expires_at.getTime() > now.getTime()
        ? 1
        : 0;
    const [contentCatalog, catalogReadiness] = await Promise.all([
      readClutchpacksContentCatalog(transaction, mappedPacks.map(({ id }) => id)),
      loadPackContentBackfillReadiness(transaction, {
        organizationId: central.organization_id, providerId: central.id,
        configVersionId: activeConfigVersion.id, configVersionNumber: activeConfigVersion.version_number,
        sourceHeadRunId: latestSourceHead.id, sourceHeadFinishedAt: latestSourceHead.finished_at,
        sourceCheckpointHash: runtime.source_cursor === null ? null : packContentBackfillDigest(runtime.source_cursor),
        sourceGeneration: runtime.state_generation, importLeaseFence: importWorker.lease_fence,
        promotionSequence: ledger.last_sequence,
      }),
    ]);
    return {
      organizationId: central.organization_id,
      providerId: central.id,
      providerKey: central.provider_key,
      providerDisplayName: central.display_name,
      providerLifecycle: central.lifecycle,
      activeConfigVersionId: activeConfigVersion.id,
      activeConfigVersionNumber: activeConfigVersion.version_number,
      activeConfigCreatedAt: activeConfigVersion.created_at,
      staleAfterSeconds: activeConfigVersion.stale_after_seconds,
      providerIdentityId: identity.provider_id,
      providerIdentityKey: identity.provider_key,
      runtimeProviderId: runtime.central_provider_id,
      runtimeProviderKey: runtime.provider_key,
      runtimeState: runtime.operating_state,
      runtimeConfigVersionId: runtime.cached_config_version_id,
      runtimeConfigVersionNumber: runtime.cached_config_version_number,
      runningRunCount,
      queuedRunCount,
      activeImportLeaseCount,
      latestSourceHeadRunId: latestSourceHead.id,
      latestSourceHeadConfigVersionId: latestSourceHead.config_version_id,
      latestSourceHeadConfigVersionNumber:
        latestSourceHead.config_version_number,
      latestSourceHeadFinishedAt: latestSourceHead.finished_at,
      catalogSettledAt: catalogReadiness.settledAt,
      catalogBackfillProofDigest: catalogReadiness.digest,
      approvedPublicAssetOrigins,
      contentCatalog,
      promotionSequence: ledger.last_sequence,
      promotionChangeCount: BigInt(promotionAggregate._count._all),
      minimumPromotionSequence: promotionAggregate._min.sequence,
      maximumPromotionSequence: promotionAggregate._max.sequence,
      maximumPromotionChangedAt: promotionAggregate._max.changed_at,
      activePackCount,
      activeCollectibleCount,
      activePackContentCount,
      maximumPackSourceUpdatedAt,
      packs: mappedPacks,
    };
  }, { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 30_000 });
}

export async function loadStableSnapshot(input: {
  readonly central: CentralPrismaClient;
  readonly gateway: BoundedProviderDatabaseGateway;
  readonly approvedPublicAssetOrigins: readonly string[];
  readonly expectedImportLease?: OwnedPublicationImportLease;
  readonly expectedScope?: { readonly organizationId: string; readonly providerId: string;
    readonly configVersionId: string; readonly configVersionNumber: string };
}): Promise<DistributedClutchpacksStableSnapshot> {
  const central = await centralSnapshot(input.central);
  const expected = input.expectedScope;
  if (expected !== undefined && (central.organization_id !== expected.organizationId || central.id !== expected.providerId ||
      central.active_config_version_id !== expected.configVersionId ||
      central.active_config_version?.version_number.toString() !== expected.configVersionNumber)) {
    return refuse("CLUTCHPACKS_PUBLICATION_AUTHORITY_UNAVAILABLE");
  }
  const result = await input.gateway.runWithProviderDatabase(
    { organizationId: central.organization_id, providerId: central.id },
    async (database) => await providerSnapshot(database, central, input.approvedPublicAssetOrigins, input.expectedImportLease),
  );
  if (result.state !== "reachable") return refuse("CLUTCHPACKS_DATABASE_UNREACHABLE");
  return assertDistributedClutchpacksStableSnapshot(result.value);
}

/** Explicit local approval, never inferred from provider-controlled image URLs. */
export function parseClutchpacksApprovedAssetOrigins(value: string | undefined): readonly string[] {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 64) return refuse("PUBLIC_IMAGE_ORIGINS_UNCONFIGURED");
    const origins = parsed.map((entry) => publicHttpsOriginSchema.parse(entry)).sort();
    if (new Set(origins).size !== origins.length) return refuse("PUBLIC_IMAGE_ORIGINS_UNCONFIGURED");
    return origins;
  } catch { return refuse("PUBLIC_IMAGE_ORIGINS_UNCONFIGURED"); }
}
