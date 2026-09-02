import {
  canonicalJson,
  packscoutPublicIdentityUuid,
  type BuiltProviderRelease,
  type ProviderReleaseBatch,
  type ProviderReleaseBatchKind,
  type ProviderReleaseDescriptor,
} from "@packscout/contracts";
import {
  Prisma as ProviderPrisma,
  type artifact_lifecycle,
} from "../prisma/generated/provider/index.js";
import type {
  ProviderPrismaClient,
  ProviderTransactionClient,
} from "./provider-database.ts";
import {
  buildProviderRelease,
  ProviderReleaseValidationError,
  type ProviderReleaseValidationCode,
  type ProviderReleaseSnapshot,
} from "./provider-release-contract.ts";
import type { PinnedProviderReleaseInputs } from "./provider-release-central-repository.ts";
import {
  ProviderReleaseIntegrityError,
  assertProviderReleaseIntegrity,
  releaseBatchRecords,
} from "./provider-release-integrity.ts";
import { PROVIDER_SCHEMA_VERSION } from "./database-topology.ts";

interface ProviderReleaseLease {
  readonly leaseOwner: string;
  readonly leaseFence: bigint;
  readonly leaseExpiresAt: Date;
}

interface LockedReleaseConsumer {
  readonly lease_owner: string | null;
  readonly lease_fence: bigint;
  readonly lease_expires_at: Date | null;
  readonly row_version: bigint;
  readonly database_now: Date;
}

const LEASE_TRANSACTION = Object.freeze({
  maxWait: 5_000,
  timeout: 15_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.Serializable,
});
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;

function requireLeaseInput(workerId: string, leaseMilliseconds: number): void {
  if (!WORKER_ID_PATTERN.test(workerId)) {
    throw new TypeError("Provider release worker ID is invalid.");
  }
  if (
    !Number.isInteger(leaseMilliseconds)
    || leaseMilliseconds < 1_000
    || leaseMilliseconds > 15 * 60_000
  ) {
    throw new TypeError("Provider release lease duration is invalid.");
  }
}

async function lockReleaseConsumer(
  transaction: ProviderTransactionClient,
): Promise<LockedReleaseConsumer> {
  const [row] = await transaction.$queryRaw<LockedReleaseConsumer[]>(ProviderPrisma.sql`
    SELECT lease_owner, lease_fence, lease_expires_at, row_version,
           clock_timestamp() AS database_now
    FROM provider_change_consumers
    WHERE consumer_key = 'provider_release'
    FOR UPDATE
  `);
  if (!row) throw new Error("Provider release checkpoint is missing.");
  return row;
}

async function acquireReleaseLease(input: {
  readonly provider: ProviderPrismaClient;
  readonly workerId: string;
  readonly leaseMilliseconds: number;
}): Promise<ProviderReleaseLease | null> {
  requireLeaseInput(input.workerId, input.leaseMilliseconds);
  const [observed, clock] = await Promise.all([
    input.provider.provider_change_consumers.findUnique({
      where: { consumer_key: "provider_release" },
      select: { lease_owner: true, lease_expires_at: true },
    }),
    input.provider.$queryRaw<{ readonly database_now: Date }[]>(
      ProviderPrisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
    ),
  ]);
  const observedNow = clock[0]?.database_now;
  if (
    observed !== null
    && observed.lease_owner !== null
    && observed.lease_expires_at !== null
    && observedNow !== undefined
    && observed.lease_expires_at > observedNow
  ) {
    return null;
  }
  return input.provider.$transaction(async (transaction) => {
    let row = await lockReleaseConsumer(transaction);
    const active = row.lease_owner !== null
      && row.lease_expires_at !== null
      && row.lease_expires_at > row.database_now;
    if (active) return null;
    const expiresAt = new Date(
      row.database_now.getTime() + input.leaseMilliseconds,
    );
    const updated = await transaction.provider_change_consumers.updateMany({
      where: { consumer_key: "provider_release", row_version: row.row_version },
      data: {
        lease_owner: input.workerId,
        lease_fence: row.lease_fence + 1n,
        lease_expires_at: expiresAt,
        row_version: { increment: 1n },
        updated_at: row.database_now,
      },
    });
    if (updated.count !== 1) {
      throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_FENCE_STALE");
    }
    row = await lockReleaseConsumer(transaction);
    if (
      row.lease_owner !== input.workerId
      || row.lease_expires_at === null
      || row.lease_expires_at <= row.database_now
    ) {
      throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_FENCE_STALE");
    }
    return {
      leaseOwner: row.lease_owner,
      leaseFence: row.lease_fence,
      leaseExpiresAt: row.lease_expires_at,
    };
  }, LEASE_TRANSACTION);
}

async function releaseReleaseLease(input: {
  readonly provider: ProviderPrismaClient;
  readonly lease: ProviderReleaseLease;
}): Promise<boolean> {
  return input.provider.$transaction(async (transaction) => {
    const row = await lockReleaseConsumer(transaction);
    if (row.lease_owner === null) return true;
    if (
      row.lease_owner !== input.lease.leaseOwner
      || row.lease_fence !== input.lease.leaseFence
    ) return false;
    const updated = await transaction.provider_change_consumers.updateMany({
      where: {
        consumer_key: "provider_release",
        lease_owner: input.lease.leaseOwner,
        lease_fence: input.lease.leaseFence,
        row_version: row.row_version,
      },
      data: {
        lease_owner: null,
        lease_expires_at: null,
        row_version: { increment: 1n },
        updated_at: row.database_now,
      },
    });
    return updated.count === 1;
  }, LEASE_TRANSACTION);
}

const ASSEMBLY_TRANSACTION = Object.freeze({
  maxWait: 5_000,
  timeout: 120_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.RepeatableRead,
});
const SNAPSHOT_LIMITS = Object.freeze({
  categories: 100_000,
  collectibles: 1_000_000,
  aliases: 4_000_000,
  packs: 8_000,
  contents: 250_000,
});

export type ProviderReleaseAssemblyFailureCode =
  | "PROVIDER_RELEASE_LEASE_HELD"
  | "PROVIDER_RELEASE_FENCE_STALE"
  | "PROVIDER_RELEASE_SNAPSHOT_LIMIT"
  | "PROVIDER_RELEASE_SNAPSHOT_INVALID"
  | "PROVIDER_RELEASE_STORED_CONFLICT"
  | "PROVIDER_RELEASE_NOT_FOUND"
  | "PROVIDER_RELEASE_NOT_PUBLISHABLE";

export class ProviderReleaseAssemblyError extends Error {
  constructor(
    readonly code: ProviderReleaseAssemblyFailureCode | ProviderReleaseValidationCode,
    readonly selectedThroughChangeSequence: bigint | null = null,
  ) {
    super(`Provider release assembly failed (${code}).`);
    this.name = "ProviderReleaseAssemblyError";
  }
}

export interface StoredProviderRelease {
  readonly id: string;
  readonly predecessorId: string | null;
  readonly throughChangeSequence: bigint;
  readonly lifecycle: artifact_lifecycle;
  readonly contentHash: string;
  readonly indexHash: string;
  readonly batchCount: number;
  readonly descriptor: ProviderReleaseDescriptor;
}

export interface ProviderReleaseAssemblyResult {
  readonly release: StoredProviderRelease;
  /** The newly claimed provider boundary, even when an older complete release is reused. */
  readonly selectedThroughChangeSequence: bigint;
  /** Fingerprint of public bytes and pinned public inputs, independent of the selected ledger boundary. */
  readonly publicEquivalenceHash: string;
  readonly reusedCompleteRelease: boolean;
  readonly resumedExistingAssembly: boolean;
}

export interface ProviderReleasePublicationSource {
  readonly release: StoredProviderRelease;
  readonly descriptor: ProviderReleaseDescriptor;
  readonly batches: readonly ProviderReleaseBatch[];
  readonly publicEquivalenceHash: string;
}

async function requireProviderPinPreflight(input: {
  readonly provider: ProviderPrismaClient;
  readonly pin: PinnedProviderReleaseInputs;
}): Promise<void> {
  const [identity, runtime, rows] = await Promise.all([
    input.provider.database_identity.findUniqueOrThrow({
      where: { singleton_key: true },
    }),
    input.provider.provider_runtime.findUniqueOrThrow({
      where: { singleton_key: true },
    }),
    input.provider.$queryRaw<{ readonly database_now: Date }[]>(
      ProviderPrisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
    ),
  ]);
  if (
    identity.database_role !== "provider"
    || identity.provider_id !== input.pin.providerId
    || identity.provider_key !== input.pin.providerKey
    || runtime.central_provider_id !== input.pin.providerId
    || runtime.provider_key !== input.pin.providerKey
  ) {
    throw new ProviderReleaseAssemblyError("PROVIDER_IDENTITY_MISMATCH");
  }
  if (identity.schema_version !== PROVIDER_SCHEMA_VERSION) {
    throw new ProviderReleaseAssemblyError("PROVIDER_SCHEMA_MISMATCH");
  }
  const databaseNow = rows[0]?.database_now;
  if (
    runtime.cached_config_version_id !== input.pin.providerConfigVersionId
    || runtime.config_expires_at?.getTime() !== input.pin.providerConfigExpiresAt?.getTime()
    || databaseNow === undefined
    || !Number.isFinite(databaseNow.getTime())
    || (runtime.config_expires_at !== null
      && runtime.config_expires_at.getTime() <= databaseNow.getTime())
  ) {
    throw new ProviderReleaseAssemblyError("PROVIDER_CONFIG_MISMATCH");
  }
}

interface LockedReleaseCheckpoint {
  readonly lease_owner: string | null;
  readonly lease_fence: bigint;
  readonly lease_expires_at: Date | null;
  readonly database_now: Date;
}

function requireSnapshotLimit(name: keyof typeof SNAPSHOT_LIMITS, count: number): void {
  if (count > SNAPSHOT_LIMITS[name]) {
    throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_SNAPSHOT_LIMIT");
  }
}

async function requireFence(
  transaction: ProviderTransactionClient,
  lease: ProviderReleaseLease,
): Promise<void> {
  const rows = await transaction.$queryRaw<LockedReleaseCheckpoint[]>(ProviderPrisma.sql`
    SELECT lease_owner, lease_fence, lease_expires_at,
           clock_timestamp() AS database_now
    FROM provider_change_consumers
    WHERE consumer_key = 'provider_release'
    FOR SHARE
  `);
  const row = rows[0];
  if (
    !row
    || row.lease_owner !== lease.leaseOwner
    || row.lease_fence !== lease.leaseFence
    || row.lease_expires_at === null
    || row.lease_expires_at <= row.database_now
  ) throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_FENCE_STALE");
}

async function loadSnapshot(
  transaction: ProviderTransactionClient,
): Promise<ProviderReleaseSnapshot> {
  const [identity, runtime, ledger, categories, collectibles, aliases, packs, contents] = await Promise.all([
    transaction.database_identity.findUniqueOrThrow({ where: { singleton_key: true } }),
    transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
    transaction.promotion_ledger.findUniqueOrThrow({ where: { singleton_key: true } }),
    transaction.categories.findMany({
      take: SNAPSHOT_LIMITS.categories + 1,
      orderBy: { id: "asc" },
      select: {
        id: true, parent_category_id: true, category_key: true,
        display_name: true, lifecycle: true, row_version: true,
      },
    }),
    transaction.collectibles.findMany({
      take: SNAPSHOT_LIMITS.collectibles + 1,
      orderBy: { id: "asc" },
      select: { id: true, collectible_type: true, lifecycle: true, row_version: true },
    }),
    transaction.collectible_name_aliases.findMany({
      take: SNAPSHOT_LIMITS.aliases + 1,
      orderBy: [{ collectible_id: "asc" }, { normalized_name: "asc" }, { id: "asc" }],
      select: { id: true, collectible_id: true, normalized_name: true, lifecycle: true },
    }),
    transaction.packs.findMany({
      take: SNAPSHOT_LIMITS.packs + 1,
      orderBy: { id: "asc" },
    }),
    transaction.pack_contents.findMany({
      take: SNAPSHOT_LIMITS.contents + 1,
      orderBy: [{ pack_id: "asc" }, { display_order: "asc" }, { id: "asc" }],
    }),
  ]);
  requireSnapshotLimit("categories", categories.length);
  requireSnapshotLimit("collectibles", collectibles.length);
  requireSnapshotLimit("aliases", aliases.length);
  requireSnapshotLimit("packs", packs.length);
  requireSnapshotLimit("contents", contents.length);
  if (
    identity.database_role !== "provider"
    || runtime.central_provider_id !== identity.provider_id
    || runtime.provider_key !== identity.provider_key
    || runtime.last_head_reached_at === null
  ) throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_SNAPSHOT_INVALID");
  return {
    providerId: identity.provider_id,
    providerKey: identity.provider_key,
    providerSchemaVersion: identity.schema_version,
    throughChangeSequence: ledger.last_sequence,
    categories: categories.map((row) => ({
      id: row.id,
      parentCategoryId: row.parent_category_id,
      categoryKey: row.category_key,
      displayName: row.display_name,
      lifecycle: row.lifecycle,
      rowVersion: row.row_version,
    })),
    collectibles: collectibles.map((row) => ({
      id: row.id,
      collectibleType: row.collectible_type,
      lifecycle: row.lifecycle,
      rowVersion: row.row_version,
    })),
    aliases: aliases.map((row) => ({
      id: row.id,
      collectibleId: row.collectible_id,
      normalizedName: row.normalized_name,
      lifecycle: row.lifecycle,
    })),
    packs: packs.map((row) => ({
      id: row.id,
      categoryId: row.category_id,
      displayName: row.display_name,
      description: row.description,
      packFormat: row.pack_format,
      lifecycle: row.lifecycle,
      availability: row.availability,
      contentEvidence: row.content_evidence,
      priceAmount: row.price_amount?.toFixed() ?? null,
      priceCurrency: row.price_currency,
      priceUsdAmount: row.price_usd_amount?.toFixed() ?? null,
      priceUnavailableReason: row.price_unavailable_reason,
      buybackRate: row.buyback_rate?.toFixed() ?? null,
      buybackSourceKind: row.buyback_source_kind,
      vendorEvAmount: row.vendor_ev_amount?.toFixed() ?? null,
      vendorEvCurrency: row.vendor_ev_currency,
      vendorEvObservedAt: row.vendor_ev_observed_at,
      vendorEvUnavailableReason: row.vendor_ev_unavailable_reason,
      packscoutEvAmount: row.packscout_ev_amount?.toFixed() ?? null,
      packscoutEvCurrency: row.packscout_ev_currency,
      packscoutEvModelVersion: row.packscout_ev_model_version,
      packscoutEvConfidencePolicyVersion: row.packscout_ev_confidence_policy_version,
      packscoutEvConfidence: row.packscout_ev_confidence,
      packscoutEvDataAsOf: row.packscout_ev_data_as_of,
      packscoutEvCalculatedAt: row.packscout_ev_calculated_at,
      packscoutEvUnavailableReason: row.packscout_ev_unavailable_reason,
      primaryImageUrl: row.primary_image_url,
      primaryImageAlt: row.primary_image_alt,
      listingUrl: row.listing_url,
      sourceUpdatedAt: row.source_updated_at,
      retiredAt: row.retired_at,
      updatedAt: row.updated_at,
    })),
    contents: contents.map((row) => ({
      id: row.id,
      packId: row.pack_id,
      collectibleId: row.collectible_id,
      collectibleInstanceId: row.collectible_instance_id,
      contentRole: row.content_role,
      probability: row.probability?.toFixed() ?? null,
      evidenceKinds: row.evidence_kinds,
      matchConfidenceBasisPoints: row.match_confidence_basis_points,
      matchConfidenceBand: row.match_confidence_band as "low" | "medium" | "high",
      observedAt: row.observed_at,
      displayOrder: row.display_order,
      lifecycle: row.lifecycle,
    })),
    lastSuccessfulObservationAt: runtime.last_head_reached_at,
    providerConfigVersionId: runtime.cached_config_version_id,
    providerConfigExpiresAt: runtime.config_expires_at,
    scheduleSeconds: runtime.schedule_seconds,
    freshnessState: runtime.freshness_state,
  };
}

function descriptorFromRow(row: {
  readonly id: string;
  readonly predecessor_id: string | null;
  readonly provider_id: string;
  readonly provider_key: string;
  readonly public_provider_id: string;
  readonly through_change_sequence: bigint;
  readonly catalog_version_id: string;
  readonly catalog_content_hash: string;
  readonly central_schema_version: string;
  readonly correlation_event_sequence: bigint;
  readonly correlation_snapshot_hash: string;
  readonly public_profile_version_id: string;
  readonly public_profile_hash: string;
  readonly provider_schema_version: string;
  readonly public_schema_version: string;
  readonly category_count: number;
  readonly repack_count: number;
  readonly collectible_reference_count: number;
  readonly chase_count: number;
  readonly retired_repack_count: number;
  readonly batch_count: number;
  readonly content_hash: string;
  readonly index_hash: string;
  readonly data_as_of: Date;
  readonly last_successful_observation_at: Date;
  readonly stale_at: Date;
  readonly freshness: string;
}): ProviderReleaseDescriptor {
  return {
    providerReleaseId: row.id,
    predecessorCompleteReleaseId: row.predecessor_id,
    providerId: row.provider_id,
    providerKey: row.provider_key,
    publicProviderId: row.public_provider_id,
    throughChangeSequence: row.through_change_sequence.toString(),
    catalogVersionId: row.catalog_version_id,
    catalogContentHash: row.catalog_content_hash,
    centralSchemaVersion: row.central_schema_version,
    correlationEventSequence: row.correlation_event_sequence.toString(),
    correlationSnapshotHash: row.correlation_snapshot_hash,
    publicProfileVersionId: row.public_profile_version_id,
    publicProfileHash: row.public_profile_hash,
    providerSchemaVersion: row.provider_schema_version,
    publicSchemaVersion: row.public_schema_version as ProviderReleaseDescriptor["publicSchemaVersion"],
    categoryCount: row.category_count,
    repackCount: row.repack_count,
    collectibleReferenceCount: row.collectible_reference_count,
    chaseCount: row.chase_count,
    retiredRepackCount: row.retired_repack_count,
    batchCount: row.batch_count,
    contentHash: row.content_hash,
    indexHash: row.index_hash,
    dataAsOf: row.data_as_of.toISOString(),
    lastSuccessfulObservationAt: row.last_successful_observation_at.toISOString(),
    staleAt: row.stale_at.toISOString(),
    freshness: row.freshness === "fresh" ? "fresh" : "delayed",
  };
}

function storedRelease(row: Parameters<typeof descriptorFromRow>[0] & {
  readonly lifecycle: artifact_lifecycle;
}): StoredProviderRelease {
  return {
    id: row.id,
    predecessorId: row.predecessor_id,
    throughChangeSequence: row.through_change_sequence,
    lifecycle: row.lifecycle,
    contentHash: row.content_hash,
    indexHash: row.index_hash,
    batchCount: row.batch_count,
    descriptor: descriptorFromRow(row),
  };
}

function jsonPayload(batch: ProviderReleaseBatch): ProviderPrisma.InputJsonValue {
  return batch.records as unknown as ProviderPrisma.InputJsonValue;
}

const RELEASE_BATCH_KIND_ORDER = new Map<ProviderReleaseBatchKind, number>([
  ["provider", 0],
  ["category", 1],
  ["collectible", 2],
  ["repack", 3],
  ["chase", 4],
  ["retired-repack", 5],
  ["search-index", 6],
]);

async function loadStoredBatches(
  transaction: ProviderTransactionClient,
  providerReleaseId: string,
): Promise<readonly ProviderReleaseBatch[]> {
  const rows = await transaction.provider_release_batches.findMany({
    where: { provider_release_id: providerReleaseId },
    orderBy: [{ batch_kind: "asc" }, { batch_index: "asc" }],
  });
  const ordered = rows.sort((left, right) => {
    const leftOrder = RELEASE_BATCH_KIND_ORDER.get(left.batch_kind as ProviderReleaseBatchKind);
    const rightOrder = RELEASE_BATCH_KIND_ORDER.get(right.batch_kind as ProviderReleaseBatchKind);
    if (leftOrder === undefined || rightOrder === undefined) {
      throw new ProviderReleaseIntegrityError("A stored provider release batch kind is invalid.");
    }
    return leftOrder - rightOrder || left.batch_index - right.batch_index;
  });
  return ordered.map((row, batchOrdinal) => ({
    batchOrdinal,
    batchKind: row.batch_kind as ProviderReleaseBatchKind,
    batchIndex: row.batch_index,
    records: releaseBatchRecords(row.payload),
    recordCount: row.record_count,
    byteCount: row.byte_count,
    bodyHash: row.body_hash,
  }));
}

async function requireStoredIntegrity(
  transaction: ProviderTransactionClient,
  row: Parameters<typeof storedRelease>[0],
): Promise<{ readonly release: StoredProviderRelease; readonly publicEquivalenceHash: string; readonly batches: readonly ProviderReleaseBatch[] }> {
  const release = storedRelease(row);
  const batches = await loadStoredBatches(transaction, row.id);
  const publicEquivalenceHash = await assertProviderReleaseIntegrity({
    descriptor: release.descriptor,
    batches,
  });
  return { release, publicEquivalenceHash, batches };
}

async function requireExactStoredRelease(
  transaction: ProviderTransactionClient,
  row: Parameters<typeof storedRelease>[0],
  built: BuiltProviderRelease,
): Promise<StoredProviderRelease> {
  if (row.lifecycle !== "assembled" && row.lifecycle !== "complete") {
    throw new ProviderReleaseIntegrityError("A deterministic provider release ID has a terminal conflict.");
  }
  const stored = await requireStoredIntegrity(transaction, row);
  if (
    canonicalJson(stored.release.descriptor) !== canonicalJson(built.descriptor)
    || canonicalJson(stored.batches) !== canonicalJson(built.batches)
    || stored.publicEquivalenceHash !== built.publicEquivalenceHash
  ) {
    throw new ProviderReleaseIntegrityError("A deterministic provider release ID has conflicting immutable content.");
  }
  return stored.release;
}

async function persistBuilt(
  transaction: ProviderTransactionClient,
  built: BuiltProviderRelease,
): Promise<{ readonly release: StoredProviderRelease; readonly resumed: boolean }> {
  const descriptor = built.descriptor;
  const priorById = await transaction.provider_releases.findUnique({
    where: { id: descriptor.providerReleaseId },
  });
  if (priorById) {
    return {
      release: await requireExactStoredRelease(transaction, priorById, built),
      resumed: true,
    };
  }
  await transaction.provider_releases.create({
    data: {
      id: descriptor.providerReleaseId,
      predecessor_id: descriptor.predecessorCompleteReleaseId,
      provider_id: descriptor.providerId,
      provider_key: descriptor.providerKey,
      public_provider_id: descriptor.publicProviderId,
      through_change_sequence: BigInt(descriptor.throughChangeSequence),
      catalog_version_id: descriptor.catalogVersionId,
      catalog_content_hash: descriptor.catalogContentHash,
      central_schema_version: descriptor.centralSchemaVersion,
      correlation_event_sequence: BigInt(descriptor.correlationEventSequence),
      correlation_snapshot_hash: descriptor.correlationSnapshotHash,
      public_profile_version_id: descriptor.publicProfileVersionId,
      public_profile_hash: descriptor.publicProfileHash,
      provider_schema_version: descriptor.providerSchemaVersion,
      public_schema_version: descriptor.publicSchemaVersion,
      lifecycle: "building",
      category_count: descriptor.categoryCount,
      repack_count: descriptor.repackCount,
      collectible_reference_count: descriptor.collectibleReferenceCount,
      chase_count: descriptor.chaseCount,
      retired_repack_count: descriptor.retiredRepackCount,
      batch_count: descriptor.batchCount,
      content_hash: descriptor.contentHash,
      index_hash: descriptor.indexHash,
      data_as_of: new Date(descriptor.dataAsOf),
      last_successful_observation_at: new Date(descriptor.lastSuccessfulObservationAt),
      stale_at: new Date(descriptor.staleAt),
      freshness: descriptor.freshness,
    },
  });
  for (const batch of built.batches) {
    await transaction.provider_release_batches.create({
      data: {
        provider_release_id: descriptor.providerReleaseId,
        batch_kind: batch.batchKind,
        batch_index: batch.batchIndex,
        payload: jsonPayload(batch),
        record_count: batch.recordCount,
        byte_count: batch.byteCount,
        body_hash: batch.bodyHash,
      },
    });
  }
  const [{ database_now: assembledAt }] = await transaction.$queryRaw<
    { database_now: Date }[]
  >`SELECT clock_timestamp() AS database_now`;
  if (!assembledAt) throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_SNAPSHOT_INVALID");
  const assembled = await transaction.provider_releases.update({
    where: { id: descriptor.providerReleaseId },
    data: { lifecycle: "assembled", assembled_at: assembledAt },
  });
  return { release: storedRelease(assembled), resumed: false };
}

async function assembleInSnapshot(input: {
  readonly transaction: ProviderTransactionClient;
  readonly pin: PinnedProviderReleaseInputs;
  readonly lease: ProviderReleaseLease;
}): Promise<ProviderReleaseAssemblyResult> {
  await requireFence(input.transaction, input.lease);
  const snapshot = await loadSnapshot(input.transaction);
  const predecessor = await input.transaction.provider_releases.findFirst({
    where: { lifecycle: "complete" },
    orderBy: [{ completed_at: "desc" }, { id: "asc" }],
  });
  let built: BuiltProviderRelease;
  try {
    built = await buildProviderRelease({
      snapshot,
      pin: input.pin,
      predecessorCompleteReleaseId: predecessor?.id ?? null,
    });
  } catch (error) {
    if (error instanceof ProviderReleaseValidationError) {
      throw new ProviderReleaseAssemblyError(
        error.code,
        snapshot.throughChangeSequence,
      );
    }
    throw error;
  }
  await requireFence(input.transaction, input.lease);
  try {
    let cursorId: string | undefined;
    for (;;) {
      const candidates = await input.transaction.provider_releases.findMany({
        where: {
          lifecycle: "complete",
          provider_id: input.pin.providerId,
          provider_key: input.pin.providerKey,
          public_provider_id: input.pin.publicProvider.publicVendorId,
          catalog_version_id: input.pin.catalogVersionId,
          catalog_content_hash: input.pin.catalogContentHash,
          central_schema_version: input.pin.centralSchemaVersion,
          correlation_event_sequence: input.pin.correlationEventSequence,
          correlation_snapshot_hash: input.pin.correlationSnapshotHash,
          public_profile_version_id: input.pin.publicProfileVersionId,
          public_profile_hash: input.pin.publicProfileHash,
          provider_schema_version: snapshot.providerSchemaVersion,
          public_schema_version: built.descriptor.publicSchemaVersion,
          category_count: built.descriptor.categoryCount,
          repack_count: built.descriptor.repackCount,
          collectible_reference_count: built.descriptor.collectibleReferenceCount,
          chase_count: built.descriptor.chaseCount,
          retired_repack_count: built.descriptor.retiredRepackCount,
          batch_count: built.descriptor.batchCount,
          index_hash: built.descriptor.indexHash,
          data_as_of: new Date(built.descriptor.dataAsOf),
          last_successful_observation_at: new Date(built.descriptor.lastSuccessfulObservationAt),
          stale_at: new Date(built.descriptor.staleAt),
          freshness: built.descriptor.freshness,
        },
        orderBy: [{ completed_at: "desc" }, { id: "asc" }],
        take: 50,
        ...(cursorId === undefined ? {} : { cursor: { id: cursorId }, skip: 1 }),
      });
      for (const candidate of candidates) {
        const stored = await requireStoredIntegrity(input.transaction, candidate);
        if (stored.publicEquivalenceHash !== built.publicEquivalenceHash) continue;
        return {
          release: stored.release,
          selectedThroughChangeSequence: snapshot.throughChangeSequence,
          publicEquivalenceHash: stored.publicEquivalenceHash,
          reusedCompleteRelease: true,
          resumedExistingAssembly: false,
        };
      }
      if (candidates.length < 50) break;
      cursorId = candidates.at(-1)!.id;
      await requireFence(input.transaction, input.lease);
    }
  } catch (error) {
    if (error instanceof ProviderReleaseIntegrityError) {
      throw new ProviderReleaseAssemblyError(
        "PROVIDER_RELEASE_STORED_CONFLICT",
        snapshot.throughChangeSequence,
      );
    }
    throw error;
  }
  await requireFence(input.transaction, input.lease);
  try {
    const persisted = await persistBuilt(input.transaction, built);
    return {
      release: persisted.release,
      selectedThroughChangeSequence: snapshot.throughChangeSequence,
      publicEquivalenceHash: built.publicEquivalenceHash,
      reusedCompleteRelease: false,
      resumedExistingAssembly: persisted.resumed,
    };
  } catch (error) {
    if (error instanceof ProviderReleaseIntegrityError) {
      throw new ProviderReleaseAssemblyError(
        "PROVIDER_RELEASE_STORED_CONFLICT",
        snapshot.throughChangeSequence,
      );
    }
    throw error;
  }
}

const PUBLICATION_SOURCE_TRANSACTION = Object.freeze({
  maxWait: 5_000,
  timeout: 15_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.RepeatableRead,
});

function requireProviderReleaseId(providerReleaseId: string): string {
  if (!UUID_PATTERN.test(providerReleaseId)) {
    throw new TypeError("Provider release ID is invalid.");
  }
  return providerReleaseId.toLowerCase();
}

export async function loadProviderReleasePublicationSource(
  transaction: ProviderTransactionClient,
  providerReleaseId: string,
): Promise<ProviderReleasePublicationSource> {
  const [identity, row] = await Promise.all([
    transaction.database_identity.findUniqueOrThrow({
      where: { singleton_key: true },
    }),
    transaction.provider_releases.findUnique({
      where: { id: providerReleaseId },
    }),
  ]);
  if (row === null) {
    throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_NOT_FOUND");
  }
  if (
    identity.database_role !== "provider"
    || identity.provider_id === null
    || identity.provider_key === null
    || row.provider_id !== identity.provider_id
    || row.provider_key !== identity.provider_key
    || row.public_provider_id !== packscoutPublicIdentityUuid(`provider:${identity.provider_id}`)
  ) {
    throw new ProviderReleaseAssemblyError("PROVIDER_IDENTITY_MISMATCH");
  }
  if (
    identity.schema_version !== PROVIDER_SCHEMA_VERSION
    || row.provider_schema_version !== PROVIDER_SCHEMA_VERSION
  ) {
    throw new ProviderReleaseAssemblyError("PROVIDER_SCHEMA_MISMATCH");
  }
  if (
    row.lifecycle !== "assembled"
    && row.lifecycle !== "publishing"
    && row.lifecycle !== "complete"
  ) {
    throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_NOT_PUBLISHABLE");
  }
  try {
    const source = await requireStoredIntegrity(transaction, row);
    return {
      release: source.release,
      descriptor: source.release.descriptor,
      batches: source.batches,
      publicEquivalenceHash: source.publicEquivalenceHash,
    };
  } catch (error) {
    if (error instanceof ProviderReleaseIntegrityError) {
      throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_STORED_CONFLICT");
    }
    throw error;
  }
}

export class ProviderReleaseRepository {
  constructor(private readonly provider: ProviderPrismaClient) {}

  async assemble(input: {
    readonly workerId: string;
    readonly leaseMilliseconds: number;
    readonly pin: PinnedProviderReleaseInputs;
  }): Promise<ProviderReleaseAssemblyResult> {
    requireLeaseInput(input.workerId, input.leaseMilliseconds);
    await requireProviderPinPreflight({ provider: this.provider, pin: input.pin });
    const lease = await acquireReleaseLease({
      provider: this.provider,
      workerId: input.workerId,
      leaseMilliseconds: input.leaseMilliseconds,
    });
    if (lease === null) {
      throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_LEASE_HELD");
    }
    try {
      return await this.provider.$transaction(
        (transaction) => assembleInSnapshot({
          transaction,
          pin: input.pin,
          lease,
        }),
        ASSEMBLY_TRANSACTION,
      );
    } finally {
      await releaseReleaseLease({ provider: this.provider, lease });
    }
  }

  publicationSource(providerReleaseId: string): Promise<ProviderReleasePublicationSource> {
    const id = requireProviderReleaseId(providerReleaseId);
    return this.provider.$transaction(
      (transaction) => loadProviderReleasePublicationSource(transaction, id),
      PUBLICATION_SOURCE_TRANSACTION,
    );
  }
}
