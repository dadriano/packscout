import {
  CATALOG_BATCH_HASH_DOMAIN,
  PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_CATALOG_SECTION_BYTES,
  PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
  canonicalJsonBytes,
  catalogContentSeedHash,
  containsProtectedProviderCatalogReleaseField,
  extendCatalogContentHash,
  globalCategoryPublicId,
  packscoutPublicIdentityUuid,
  providerPromotionBootstrapCatalogSectionsWithinByteBudget,
  providerReleaseCatalogPinHash,
  providerReleaseCorrelationSnapshotHash,
  publicVendorSchema,
  sha256CanonicalJson,
  type PublicCatalogAlias,
  type PublicCatalogCategory,
  type PublicCatalogCollectible,
  type PublicVendor,
} from "@packscout/contracts";
import { Prisma as CentralPrisma } from "../prisma/generated/central/index.js";
import type {
  CentralPrismaClient,
  CentralTransactionClient,
} from "./central-database.ts";
import { CENTRAL_SCHEMA_VERSION } from "./database-topology.ts";

const PIN_TRANSACTION = Object.freeze({
  maxWait: 5_000,
  timeout: 60_000,
  isolationLevel: CentralPrisma.TransactionIsolationLevel.RepeatableRead,
});
const PIN_TRANSACTION_SETTLEMENT_RESERVE_MILLISECONDS = 50;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;

export type ProviderReleasePinFailureCode =
  | "CENTRAL_IDENTITY_INVALID"
  | "PROVIDER_NOT_ACTIVE"
  | "PROVIDER_CONFIG_MISSING"
  | "PROVIDER_CONFIG_INVALID"
  | "PUBLIC_PROFILE_MISSING"
  | "PUBLIC_PROFILE_INVALID"
  | "CATALOG_VERSION_MISSING"
  | "CATALOG_VERSION_INCOMPLETE"
  | "CATALOG_ARTIFACT_INVALID"
  | "CORRELATION_SNAPSHOT_INVALID"
  | "PROVIDER_RELEASE_PIN_CANCELLED"
  | "PROVIDER_RELEASE_PIN_DEADLINE";

export class ProviderReleasePinError extends Error {
  constructor(readonly code: ProviderReleasePinFailureCode) {
    super(`Provider release central input is unavailable (${code}).`);
    this.name = "ProviderReleasePinError";
  }
}

export interface PinnedProviderCategoryCorrelation {
  readonly localCategoryId: string;
  readonly localEntityVersion: bigint;
  readonly publicCategoryId: string;
}

export interface PinnedProviderCollectibleCorrelation {
  readonly localCollectibleId: string;
  readonly localEntityVersion: bigint;
  readonly publicCollectibleId: string;
}

export interface PinnedProviderReleaseInputs {
  readonly providerId: string;
  readonly providerKey: string;
  readonly providerConfigVersionId: string;
  readonly providerConfigExpiresAt: Date | null;
  readonly staleAfterSeconds: number;
  readonly centralSchemaVersion: string;
  readonly catalogVersionId: string;
  readonly catalogSchemaVersion: string;
  readonly catalogContentHash: string;
  readonly catalogThroughChangeSequence: bigint;
  readonly catalogCategories: readonly PublicCatalogCategory[];
  readonly catalogCollectibles: readonly PublicCatalogCollectible[];
  readonly catalogAliases: readonly PublicCatalogAlias[];
  /** Binds the verified catalog descriptor hash to the exact flattened rows. */
  readonly catalogArtifactVerificationHash: string;
  readonly correlationEventSequence: bigint;
  readonly correlationSnapshotHash: string;
  readonly categoryCorrelations: readonly PinnedProviderCategoryCorrelation[];
  readonly collectibleCorrelations: readonly PinnedProviderCollectibleCorrelation[];
  readonly publicProfileVersionId: string;
  readonly publicProfileHash: string;
  readonly publicProvider: PublicVendor;
}

export interface ProviderReleasePinControl {
  readonly signal?: AbortSignal;
  readonly deadlineAt?: number;
}

interface StoredBatch {
  readonly batch_kind: string;
  readonly batch_index: number;
  readonly payload: unknown;
  readonly record_count: number;
  readonly byte_count: number;
  readonly body_hash: string;
}

interface StoredCatalogPayloadSize {
  readonly payloadBytes: bigint | null;
}

function exactArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new ProviderReleasePinError("CATALOG_ARTIFACT_INVALID");
  }
  return value;
}

function pinFailure(code: ProviderReleasePinFailureCode): never {
  throw new ProviderReleasePinError(code);
}

function requirePinActive(
  control: ProviderReleasePinControl,
  nowMilliseconds: () => number,
): void {
  if (control.signal?.aborted === true) {
    pinFailure("PROVIDER_RELEASE_PIN_CANCELLED");
  }
  if (
    control.deadlineAt !== undefined &&
    nowMilliseconds() >= control.deadlineAt
  ) pinFailure("PROVIDER_RELEASE_PIN_DEADLINE");
}

function pinTransactionOptions(
  control: ProviderReleasePinControl,
  nowMilliseconds: () => number,
) {
  if (control.deadlineAt === undefined) return PIN_TRANSACTION;
  if (!Number.isSafeInteger(control.deadlineAt) || control.deadlineAt < 1) {
    throw new TypeError("Provider release pin deadline is invalid.");
  }
  requirePinActive(control, nowMilliseconds);
  const available = Math.floor(
    control.deadlineAt - nowMilliseconds() -
      PIN_TRANSACTION_SETTLEMENT_RESERVE_MILLISECONDS,
  );
  const maxWait = Math.min(
    PIN_TRANSACTION.maxWait,
    Math.max(1, Math.floor(available / 5)),
  );
  const timeout = Math.min(PIN_TRANSACTION.timeout, available - maxWait);
  if (timeout < 1) pinFailure("PROVIDER_RELEASE_PIN_DEADLINE");
  return {
    maxWait,
    timeout,
    isolationLevel: PIN_TRANSACTION.isolationLevel,
  };
}

function transactionExpired(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    (error.code === "P2024" || error.code === "P2028");
}

async function withPinControl<T>(input: Readonly<{
  control: ProviderReleasePinControl;
  nowMilliseconds: () => number;
  operation: () => Promise<T>;
}>): Promise<T> {
  requirePinActive(input.control, input.nowMilliseconds);
  let cancel: (() => void) | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  const boundaries: Promise<never>[] = [];
  const signal = input.control.signal;
  if (signal !== undefined) {
    boundaries.push(new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new ProviderReleasePinError(
        "PROVIDER_RELEASE_PIN_CANCELLED",
      ));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    }));
  }
  const deadlineAt = input.control.deadlineAt;
  if (deadlineAt !== undefined) {
    boundaries.push(new Promise<never>((_resolve, reject) => {
      deadlineTimer = setTimeout(
        () => reject(new ProviderReleasePinError(
          "PROVIDER_RELEASE_PIN_DEADLINE",
        )),
        Math.max(
          0,
          deadlineAt - input.nowMilliseconds(),
        ),
      );
    }));
  }
  try {
    const result = await Promise.race([input.operation(), ...boundaries]);
    requirePinActive(input.control, input.nowMilliseconds);
    return result;
  } catch (error) {
    if (input.control.deadlineAt !== undefined && transactionExpired(error)) {
      pinFailure("PROVIDER_RELEASE_PIN_DEADLINE");
    }
    throw error;
  } finally {
    if (cancel !== null && signal !== undefined) {
      signal.removeEventListener("abort", cancel);
    }
    if (deadlineTimer !== null) clearTimeout(deadlineTimer);
  }
}

async function verifyCatalogArtifact(input: {
  readonly schemaVersion: string;
  readonly contentHash: string;
  readonly categoryCount: number;
  readonly collectibleCount: number;
  readonly aliasCount: number;
  readonly batches: readonly StoredBatch[];
}): Promise<{
  readonly categories: readonly PublicCatalogCategory[];
  readonly collectibles: readonly PublicCatalogCollectible[];
  readonly aliases: readonly PublicCatalogAlias[];
}> {
  const rank = new Map([["categories", 0], ["collectibles", 1], ["aliases", 2]]);
  const batches = [...input.batches].sort((left, right) => (
    (rank.get(left.batch_kind) ?? 99) - (rank.get(right.batch_kind) ?? 99)
    || left.batch_index - right.batch_index
  ));
  const expectedIndex = new Map<string, number>();
  const records = new Map<string, unknown[]>([
    ["categories", []], ["collectibles", []], ["aliases", []],
  ]);
  let contentHash = await catalogContentSeedHash({
    schemaVersion: input.schemaVersion,
    categoryCount: input.categoryCount,
    collectibleCount: input.collectibleCount,
    aliasCount: input.aliasCount,
    batchCount: batches.length,
  });
  for (const [batchOrdinal, batch] of batches.entries()) {
    const nextIndex = expectedIndex.get(batch.batch_kind) ?? 0;
    const payload = exactArray(batch.payload);
    const value = {
      batchKind: batch.batch_kind,
      batchIndex: batch.batch_index,
      records: payload,
    };
    const byteCount = canonicalJsonBytes(value).byteLength;
    const bodyHash = await sha256CanonicalJson(CATALOG_BATCH_HASH_DOMAIN, value);
    if (
      !rank.has(batch.batch_kind)
      || batch.batch_index !== nextIndex
      || payload.length !== batch.record_count
      || byteCount !== batch.byte_count
      || bodyHash !== batch.body_hash
    ) throw new ProviderReleasePinError("CATALOG_ARTIFACT_INVALID");
    expectedIndex.set(batch.batch_kind, nextIndex + 1);
    records.get(batch.batch_kind)!.push(...payload);
    contentHash = await extendCatalogContentHash({
      previousHash: contentHash,
      batchOrdinal,
      batchKind: batch.batch_kind as "categories" | "collectibles" | "aliases",
      batchIndex: batch.batch_index,
      recordCount: batch.record_count,
      byteCount: batch.byte_count,
      bodyHash: batch.body_hash,
    });
  }
  const categories = records.get("categories") as PublicCatalogCategory[];
  const collectibles = records.get("collectibles") as PublicCatalogCollectible[];
  const aliases = records.get("aliases") as PublicCatalogAlias[];
  if (
    !HASH_PATTERN.test(input.contentHash)
    || contentHash !== input.contentHash
    || categories.length !== input.categoryCount
    || collectibles.length !== input.collectibleCount
    || aliases.length !== input.aliasCount
    || containsProtectedProviderCatalogReleaseField({
      categories,
      collectibles,
      aliases,
    })
  ) throw new ProviderReleasePinError("CATALOG_ARTIFACT_INVALID");
  if (!providerPromotionBootstrapCatalogSectionsWithinByteBudget({
    catalogCategories: categories,
    catalogCollectibles: collectibles,
    catalogAliases: aliases,
  })) throw new ProviderReleasePinError("CATALOG_ARTIFACT_INVALID");
  return { categories, collectibles, aliases };
}

function referralParameters(value: unknown): readonly { name: string; value: string }[] {
  if (!Array.isArray(value)) {
    throw new ProviderReleasePinError("PUBLIC_PROFILE_INVALID");
  }
  return value.map((candidate) => {
    if (
      candidate === null
      || Array.isArray(candidate)
      || typeof candidate !== "object"
      || typeof (candidate as { name?: unknown }).name !== "string"
      || typeof (candidate as { value?: unknown }).value !== "string"
    ) throw new ProviderReleasePinError("PUBLIC_PROFILE_INVALID");
    return {
      name: (candidate as { name: string }).name,
      value: (candidate as { value: string }).value,
    };
  });
}

async function loadPin(
  transaction: CentralTransactionClient,
  input: { readonly providerId: string; readonly catalogVersionId?: string },
): Promise<PinnedProviderReleaseInputs> {
  const provider = await transaction.providers.findUnique({
    where: { id: input.providerId },
    include: {
      active_config_version: {
        select: { id: true, stale_after_seconds: true, expires_at: true },
      },
      active_public_profile_version: true,
    },
  });
  if (!provider || provider.lifecycle !== "active") {
    throw new ProviderReleasePinError("PROVIDER_NOT_ACTIVE");
  }
  const configuration = provider.active_config_version;
  if (
    configuration === null
    || provider.active_config_version_id !== configuration.id
  ) {
    throw new ProviderReleasePinError("PROVIDER_CONFIG_MISSING");
  }
  if (
    !Number.isInteger(configuration.stale_after_seconds)
    || configuration.stale_after_seconds < 1
    || configuration.stale_after_seconds > 604_800
  ) {
    throw new ProviderReleasePinError("PROVIDER_CONFIG_INVALID");
  }
  const profile = provider.active_public_profile_version;
  if (!profile) throw new ProviderReleasePinError("PUBLIC_PROFILE_MISSING");
  if (
    provider.active_public_profile_version_id !== profile.id
    || profile.provider_id !== provider.id
  ) {
    throw new ProviderReleasePinError("PUBLIC_PROFILE_INVALID");
  }
  const databaseIdentity = await transaction.database_identity.findUnique({
    where: { singleton_key: true },
  });
  if (
    databaseIdentity === null
    || databaseIdentity.database_role !== "central"
    || databaseIdentity.schema_version !== CENTRAL_SCHEMA_VERSION
    || databaseIdentity.provider_id !== null
    || databaseIdentity.provider_key !== null
  ) {
    throw new ProviderReleasePinError("CENTRAL_IDENTITY_INVALID");
  }
  const [{ database_now: databaseNow } = { database_now: null }] =
    await transaction.$queryRaw<{ readonly database_now: Date | null }[]>(
      CentralPrisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
    );
  if (
    databaseNow === null
    || !Number.isFinite(databaseNow.getTime())
    || (configuration.expires_at !== null
      && (!Number.isFinite(configuration.expires_at.getTime())
        || configuration.expires_at.getTime() <= databaseNow.getTime()))
  ) {
    throw new ProviderReleasePinError("PROVIDER_CONFIG_INVALID");
  }
  const catalog = input.catalogVersionId
    ? await transaction.catalog_versions.findUnique({
        where: { id: input.catalogVersionId },
      })
    : await transaction.catalog_versions.findFirst({
        where: { lifecycle: "complete" },
        orderBy: [{ through_change_sequence: "desc" }, { completed_at: "desc" }, { id: "asc" }],
      });
  if (!catalog) throw new ProviderReleasePinError("CATALOG_VERSION_MISSING");
  if (catalog.lifecycle !== "complete") {
    throw new ProviderReleasePinError("CATALOG_VERSION_INCOMPLETE");
  }
  const [{ payloadBytes } = { payloadBytes: null }] =
    await transaction.$queryRaw<StoredCatalogPayloadSize[]>(CentralPrisma.sql`
      SELECT COALESCE(SUM(octet_length(batch.payload::text)), 0)::bigint
        AS "payloadBytes"
      FROM catalog_version_batches batch
      WHERE batch.catalog_version_id = ${catalog.id}::uuid
    `);
  if (
    payloadBytes === null || payloadBytes < 0n ||
    payloadBytes >
      BigInt(PROVIDER_PROMOTION_BOOTSTRAP_MAXIMUM_CATALOG_SECTION_BYTES)
  ) throw new ProviderReleasePinError("CATALOG_ARTIFACT_INVALID");
  const batches = await transaction.catalog_version_batches.findMany({
    where: { catalog_version_id: catalog.id },
    select: {
      batch_kind: true,
      batch_index: true,
      payload: true,
      record_count: true,
      byte_count: true,
      body_hash: true,
    },
  });
  const artifact = await verifyCatalogArtifact({
    schemaVersion: catalog.schema_version,
    contentHash: catalog.content_hash,
    categoryCount: catalog.category_count,
    collectibleCount: catalog.collectible_count,
    aliasCount: catalog.alias_count,
    batches,
  });
  if (
    catalog.schema_version !== "catalog-v1"
    || catalog.id !== packscoutPublicIdentityUuid(
      `catalog-version:${catalog.schema_version}:${catalog.content_hash}`,
    )
  ) {
    throw new ProviderReleasePinError("CATALOG_ARTIFACT_INVALID");
  }
  let publicProvider: PublicVendor;
  try {
    publicProvider = publicVendorSchema.parse({
      publicVendorId: packscoutPublicIdentityUuid(`provider:${provider.id}`),
      vendorKey: provider.provider_key,
      displayName: profile.display_name,
      logoUrl: profile.logo_url,
      websiteUrl: profile.website_url,
      listingHosts: profile.listing_hosts,
      imageOrigins: profile.image_origins,
      referralParameters: referralParameters(profile.referral_parameters),
      publicPromo: profile.promo_code === null
        ? null
        : { code: profile.promo_code, label: profile.promo_label },
    });
  } catch (error) {
    if (error instanceof ProviderReleasePinError) throw error;
    throw new ProviderReleasePinError("PUBLIC_PROFILE_INVALID");
  }
  const publicProfileHash = await sha256CanonicalJson(
    PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
    publicProvider,
  );
  if (publicProfileHash !== profile.content_hash) {
    throw new ProviderReleasePinError("PUBLIC_PROFILE_INVALID");
  }
  const ledger = await transaction.catalog_ledger.findUniqueOrThrow({
    where: { singleton_key: true },
  });
  const correlationEventSequence = ledger.last_sequence;
  const [categoryRows, collectibleRows] = await Promise.all([
    transaction.provider_category_correlations.findMany({
      where: {
        provider_id: provider.id,
        valid_from_event_sequence: { lte: correlationEventSequence },
        OR: [
          { valid_to_event_sequence: null },
          { valid_to_event_sequence: { gt: correlationEventSequence } },
        ],
      },
      orderBy: [{ local_category_id: "asc" }, { correlation_version: "desc" }],
    }),
    transaction.provider_collectible_correlations.findMany({
      where: {
        provider_id: provider.id,
        valid_from_event_sequence: { lte: correlationEventSequence },
        OR: [
          { valid_to_event_sequence: null },
          { valid_to_event_sequence: { gt: correlationEventSequence } },
        ],
      },
      orderBy: [{ local_collectible_id: "asc" }, { correlation_version: "desc" }],
    }),
  ]);
  const categoryIds = new Set(artifact.categories.map(({ publicCategoryId }) => publicCategoryId));
  const collectibleIds = new Set(artifact.collectibles.map(({ publicCollectibleId }) => publicCollectibleId));
  const aliasTargets = new Map(artifact.aliases.map((alias) => [
    alias.aliasPublicCollectibleId,
    alias.canonicalPublicCollectibleId,
  ]));
  const categoryCorrelations = categoryRows.map((row) => ({
    localCategoryId: row.local_category_id,
    localEntityVersion: row.local_entity_version,
    publicCategoryId: globalCategoryPublicId(row.global_category_id),
  }));
  const collectibleCorrelations = collectibleRows.map((row) => {
    let publicCollectibleId = row.global_collectible_id;
    const visited = new Set<string>();
    while (aliasTargets.has(publicCollectibleId)) {
      if (visited.has(publicCollectibleId)) {
        throw new ProviderReleasePinError("CORRELATION_SNAPSHOT_INVALID");
      }
      visited.add(publicCollectibleId);
      publicCollectibleId = aliasTargets.get(publicCollectibleId)!;
    }
    return {
      localCollectibleId: row.local_collectible_id,
      localEntityVersion: row.local_entity_version,
      publicCollectibleId,
    };
  });
  if (
    new Set(categoryCorrelations.map(({ localCategoryId }) => localCategoryId)).size
      !== categoryCorrelations.length
    || new Set(collectibleCorrelations.map(({ localCollectibleId }) => localCollectibleId)).size
      !== collectibleCorrelations.length
    || categoryCorrelations.some(({ publicCategoryId }) => !categoryIds.has(publicCategoryId))
    || collectibleCorrelations.some(({ publicCollectibleId }) => !collectibleIds.has(publicCollectibleId))
  ) throw new ProviderReleasePinError("CORRELATION_SNAPSHOT_INVALID");
  const correlationSnapshotHash = await providerReleaseCorrelationSnapshotHash({
    providerId: provider.id,
    correlationEventSequence: correlationEventSequence.toString(),
    categories: categoryCorrelations.map((row) => ({
      ...row,
      localEntityVersion: row.localEntityVersion.toString(),
    })),
    collectibles: collectibleCorrelations.map((row) => ({
      ...row,
      localEntityVersion: row.localEntityVersion.toString(),
    })),
  });
  const catalogArtifactVerificationHash = await providerReleaseCatalogPinHash({
    catalogVersionId: catalog.id,
    catalogSchemaVersion: catalog.schema_version,
    catalogContentHash: catalog.content_hash,
    catalogThroughChangeSequence: catalog.through_change_sequence.toString(),
    categories: artifact.categories,
    collectibles: artifact.collectibles,
    aliases: artifact.aliases,
  });
  return {
    providerId: provider.id,
    providerKey: provider.provider_key,
    providerConfigVersionId: configuration.id,
    providerConfigExpiresAt: configuration.expires_at,
    staleAfterSeconds: configuration.stale_after_seconds,
    centralSchemaVersion: databaseIdentity.schema_version,
    catalogVersionId: catalog.id,
    catalogSchemaVersion: catalog.schema_version,
    catalogContentHash: catalog.content_hash,
    catalogThroughChangeSequence: catalog.through_change_sequence,
    catalogCategories: artifact.categories,
    catalogCollectibles: artifact.collectibles,
    catalogAliases: artifact.aliases,
    catalogArtifactVerificationHash,
    correlationEventSequence,
    correlationSnapshotHash,
    categoryCorrelations,
    collectibleCorrelations,
    publicProfileVersionId: profile.id,
    publicProfileHash,
    publicProvider,
  };
}

export class ProviderReleaseCentralRepository {
  constructor(
    private readonly central: CentralPrismaClient,
    private readonly nowMilliseconds: () => number = Date.now,
  ) {}

  pin(input: {
    readonly providerId: string;
    readonly catalogVersionId?: string;
    readonly signal?: AbortSignal;
    readonly deadlineAt?: number;
  }): Promise<PinnedProviderReleaseInputs> {
    const control = {
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
    } satisfies ProviderReleasePinControl;
    const transaction = pinTransactionOptions(control, this.nowMilliseconds);
    return withPinControl({
      control,
      nowMilliseconds: this.nowMilliseconds,
      operation: () => this.central.$transaction(
        (client) => loadPin(client, input),
        transaction,
      ),
    });
  }
}
