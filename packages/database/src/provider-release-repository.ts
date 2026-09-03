import {
  canonicalJson,
  MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES,
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
import { providerPageQueryExpiration } from "./provider-page-transaction.ts";
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
  readonly control: ProviderReleaseAssemblyControl;
}): Promise<ProviderReleaseLease | null> {
  requireLeaseInput(input.workerId, input.leaseMilliseconds);
  const transactionOptions = boundedReleaseTransactionOptions(
    LEASE_TRANSACTION,
    input.control,
  );
  return input.provider.$transaction(async (transaction) => {
    const phases = releaseTransactionPhases({
      transaction,
      transactionTimeoutMilliseconds: transactionOptions.timeout,
      control: input.control,
    });
    const observed = await phases.run(() =>
      transaction.provider_change_consumers.findUnique({
        where: { consumer_key: "provider_release" },
        select: { lease_owner: true, lease_expires_at: true },
      })
    );
    const clock = await phases.run(() =>
      transaction.$queryRaw<{ readonly database_now: Date }[]>(
        ProviderPrisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
      )
    );
    const observedNow = clock[0]?.database_now;
    if (
      observed !== null
      && observed.lease_owner !== null
      && observed.lease_expires_at !== null
      && observedNow !== undefined
      && observed.lease_expires_at > observedNow
    ) return null;
    let row = await phases.run(() => lockReleaseConsumer(transaction));
    const active = row.lease_owner !== null
      && row.lease_expires_at !== null
      && row.lease_expires_at > row.database_now;
    if (active) return null;
    const expiresAt = new Date(
      row.database_now.getTime() + input.leaseMilliseconds,
    );
    const updated = await phases.run(() =>
      transaction.provider_change_consumers.updateMany({
        where: { consumer_key: "provider_release", row_version: row.row_version },
        data: {
          lease_owner: input.workerId,
          lease_fence: row.lease_fence + 1n,
          lease_expires_at: expiresAt,
          row_version: { increment: 1n },
          updated_at: row.database_now,
        },
      })
    );
    if (updated.count !== 1) {
      throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_FENCE_STALE");
    }
    row = await phases.run(() => lockReleaseConsumer(transaction));
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
  }, transactionOptions);
}

async function releaseReleaseLease(input: {
  readonly provider: ProviderPrismaClient;
  readonly lease: ProviderReleaseLease;
  readonly control: ProviderReleaseAssemblyControl;
}): Promise<boolean> {
  const transactionOptions = boundedReleaseTransactionOptions(
    LEASE_TRANSACTION,
    input.control,
  );
  return input.provider.$transaction(async (transaction) => {
    const phases = releaseTransactionPhases({
      transaction,
      transactionTimeoutMilliseconds: transactionOptions.timeout,
      control: input.control,
    });
    const row = await phases.run(() => lockReleaseConsumer(transaction));
    if (row.lease_owner === null) return true;
    if (
      row.lease_owner !== input.lease.leaseOwner
      || row.lease_fence !== input.lease.leaseFence
    ) return false;
    const updated = await phases.run(() =>
      transaction.provider_change_consumers.updateMany({
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
      },
    ));
    return updated.count === 1;
  }, transactionOptions);
}

async function releaseReleaseLeaseBeforeDeadline(input: {
  readonly provider: ProviderPrismaClient;
  readonly lease: ProviderReleaseLease;
  readonly control: ProviderReleaseAssemblyControl;
}): Promise<void> {
  try {
    await releaseReleaseLease(input);
  } catch (error) {
    if (boundedReleaseLeaseCleanupFailure(error)) return;
    throw error;
  }
}

const ASSEMBLY_TRANSACTION = Object.freeze({
  maxWait: 5_000,
  timeout: 120_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.RepeatableRead,
});
const PREFLIGHT_TRANSACTION = Object.freeze({
  maxWait: 5_000,
  timeout: 15_000,
  isolationLevel: ProviderPrisma.TransactionIsolationLevel.RepeatableRead,
});
const ASSEMBLY_COMPLETION_RESERVE_MILLISECONDS = 5_000;
const MINIMUM_TRANSACTION_TIMEOUT_MILLISECONDS = 1_000;
const TRANSACTION_SETTLEMENT_RESERVE_MILLISECONDS = 250;
const RELEASE_LEASE_CLEANUP_WINDOW_MILLISECONDS = 2_000;
const SNAPSHOT_LIMITS = Object.freeze({
  categories: 8_000,
  collectibles: 250_000,
  packs: 8_000,
  contents: 250_000,
});
const PROVIDER_RELEASE_PUBLIC_PACK_SCOPE = {
  lifecycle: "active",
  availability: { not: "unavailable" },
} satisfies ProviderPrisma.packsWhereInput;

export type ProviderReleaseAssemblyFailureCode =
  | "PROVIDER_RELEASE_CANCELLED"
  | "PROVIDER_RELEASE_DEADLINE"
  | "PROVIDER_RELEASE_LEASE_HELD"
  | "PROVIDER_RELEASE_FENCE_STALE"
  | "PROVIDER_RELEASE_SNAPSHOT_LIMIT"
  | "PROVIDER_RELEASE_SNAPSHOT_INVALID"
  | "PROVIDER_RELEASE_STORED_CONFLICT"
  | "PROVIDER_RELEASE_PUBLICATION_TOO_LARGE"
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

interface ProviderReleaseAssemblyControl {
  readonly signal: AbortSignal | undefined;
  readonly deadlineAt: number | null;
  readonly completionReserveMilliseconds: number;
}

interface ProviderReleaseTransactionOptions {
  readonly maxWait: number;
  readonly timeout: number;
  readonly isolationLevel: ProviderPrisma.TransactionIsolationLevel;
}

function releaseAssemblyControl(input: Readonly<{
  signal?: AbortSignal;
  deadlineAt?: number;
}>): ProviderReleaseAssemblyControl {
  if (
    input.deadlineAt !== undefined
    && (!Number.isSafeInteger(input.deadlineAt) || input.deadlineAt < 1)
  ) throw new TypeError("Provider release assembly deadline is invalid.");
  const remaining = input.deadlineAt === undefined
    ? 0
    : Math.max(0, input.deadlineAt - Date.now());
  return {
    signal: input.signal,
    deadlineAt: input.deadlineAt ?? null,
    completionReserveMilliseconds: input.deadlineAt === undefined
      ? 0
      : Math.min(
          ASSEMBLY_COMPLETION_RESERVE_MILLISECONDS,
          Math.max(1_000, Math.floor(remaining / 10)),
        ),
  };
}

function requireReleaseAssemblyActive(
  control: ProviderReleaseAssemblyControl,
): void {
  if (control.signal?.aborted === true) {
    throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_CANCELLED");
  }
  if (control.deadlineAt !== null && Date.now() >= control.deadlineAt) {
    throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_DEADLINE");
  }
}

function boundedReleaseTransactionOptions(
  base: ProviderReleaseTransactionOptions,
  control: ProviderReleaseAssemblyControl,
): ProviderReleaseTransactionOptions {
  requireReleaseAssemblyActive(control);
  if (control.deadlineAt === null) return base;
  const transactionWindow = Math.floor(
    control.deadlineAt
      - Date.now()
      - control.completionReserveMilliseconds,
  );
  const maxWait = Math.min(
    base.maxWait,
    Math.max(1, Math.floor(transactionWindow / 5)),
  );
  const timeout = Math.min(base.timeout, transactionWindow - maxWait);
  if (timeout < MINIMUM_TRANSACTION_TIMEOUT_MILLISECONDS) {
    throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_DEADLINE");
  }
  return { ...base, maxWait, timeout };
}

interface ProviderReleaseTransactionPhases {
  readonly check: () => void;
  readonly run: <T>(operation: () => Promise<T>) => Promise<T>;
}

function releaseTransactionPhases(input: Readonly<{
  transaction: ProviderTransactionClient;
  transactionTimeoutMilliseconds: number;
  control: ProviderReleaseAssemblyControl;
}>): ProviderReleaseTransactionPhases {
  const transactionDeadlineAt = Date.now()
    + input.transactionTimeoutMilliseconds;
  const workDeadlineAt = input.control.deadlineAt === null
    ? transactionDeadlineAt
    : Math.min(
        transactionDeadlineAt,
        input.control.deadlineAt
          - input.control.completionReserveMilliseconds,
      );
  const check = () => {
    requireReleaseAssemblyActive(input.control);
    if (Date.now() >= workDeadlineAt) {
      throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_DEADLINE");
    }
  };
  return {
    check,
    async run<T>(operation: () => Promise<T>): Promise<T> {
      check();
      const statementTimeoutMilliseconds = Math.floor(
        workDeadlineAt
          - Date.now()
          - TRANSACTION_SETTLEMENT_RESERVE_MILLISECONDS,
      );
      if (statementTimeoutMilliseconds < 1) {
        throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_DEADLINE");
      }
      await input.transaction.$queryRaw(
        ProviderPrisma.sql`
          SELECT set_config(
            'statement_timeout',
            ${statementTimeoutMilliseconds.toString()},
            true
          )
        `,
      );
      const statementDeadlineAt = Date.now() + statementTimeoutMilliseconds;
      try {
        const result = await operation();
        check();
        return result;
      } catch (error) {
        if (Date.now() + 50 >= statementDeadlineAt) {
          throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_DEADLINE");
        }
        throw error;
      }
    },
  };
}

function releasePhase<T>(
  phases: ProviderReleaseTransactionPhases | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  return phases === undefined ? operation() : phases.run(operation);
}

function ownField(value: unknown, name: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const field = Object.getOwnPropertyDescriptor(value, name);
  return field && "value" in field ? field.value : undefined;
}

function releaseStatementTimeout(error: unknown): boolean {
  return error instanceof ProviderPrisma.PrismaClientKnownRequestError
    && ownField(error, "code") === "P2010"
    && ownField(ownField(error, "meta"), "code") === "57014";
}

function boundedReleaseLeaseCleanupFailure(error: unknown): boolean {
  if (
    error instanceof ProviderReleaseAssemblyError
    && error.code === "PROVIDER_RELEASE_DEADLINE"
  ) return true;
  if (!(error instanceof ProviderPrisma.PrismaClientKnownRequestError)) {
    return false;
  }
  const code = ownField(error, "code");
  return code === "P2024" || code === "P2028"
    || releaseStatementTimeout(error);
}

function releaseLeaseControl(
  control: ProviderReleaseAssemblyControl,
  lease: ProviderReleaseLease,
): ProviderReleaseAssemblyControl {
  return {
    ...control,
    signal: undefined,
    deadlineAt: Math.min(
      lease.leaseExpiresAt.getTime(),
      Date.now() + RELEASE_LEASE_CLEANUP_WINDOW_MILLISECONDS,
    ),
    completionReserveMilliseconds: 0,
  };
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

export interface ProviderReleasePublicationMetadata {
  readonly release: StoredProviderRelease;
  readonly descriptor: ProviderReleaseDescriptor;
  readonly batchRecordCount: number;
  readonly payloadByteCount: number;
}

async function requireProviderPinPreflight(input: {
  readonly provider: ProviderPrismaClient;
  readonly pin: PinnedProviderReleaseInputs;
  readonly control: ProviderReleaseAssemblyControl;
}): Promise<void> {
  const transactionOptions = boundedReleaseTransactionOptions(
    PREFLIGHT_TRANSACTION,
    input.control,
  );
  await input.provider.$transaction(async (transaction) => {
    const phases = releaseTransactionPhases({
      transaction,
      transactionTimeoutMilliseconds: transactionOptions.timeout,
      control: input.control,
    });
    requireReleaseAssemblyActive(input.control);
    const identity = await phases.run(() =>
      transaction.database_identity.findUniqueOrThrow({
        where: { singleton_key: true },
      })
    );
    const runtime = await phases.run(() =>
      transaction.provider_runtime.findUniqueOrThrow({
        where: { singleton_key: true },
      })
    );
    const rows = await phases.run(() =>
      transaction.$queryRaw<{ readonly database_now: Date }[]>(
        ProviderPrisma.sql`SELECT CURRENT_TIMESTAMP AS database_now`,
      )
    );
    requireReleaseAssemblyActive(input.control);
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
  }, transactionOptions);
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
  phases: ProviderReleaseTransactionPhases,
): Promise<void> {
  const rows = await phases.run(() =>
    transaction.$queryRaw<LockedReleaseCheckpoint[]>(ProviderPrisma.sql`
      SELECT lease_owner, lease_fence, lease_expires_at,
             clock_timestamp() AS database_now
      FROM provider_change_consumers
      WHERE consumer_key = 'provider_release'
      FOR SHARE
    `)
  );
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
  phases: ProviderReleaseTransactionPhases,
): Promise<ProviderReleaseSnapshot> {
  const identity = await phases.run(() =>
    transaction.database_identity.findUniqueOrThrow({ where: { singleton_key: true } })
  );
  const runtime = await phases.run(() =>
    transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } })
  );
  const ledger = await phases.run(() =>
    transaction.promotion_ledger.findUniqueOrThrow({ where: { singleton_key: true } })
  );
  const packs = await phases.run(() =>
    transaction.packs.findMany({
      take: SNAPSHOT_LIMITS.packs + 1,
      orderBy: { id: "asc" },
      select: {
        id: true,
        category_id: true,
        display_name: true,
        description: true,
        pack_format: true,
        lifecycle: true,
        availability: true,
        content_evidence: true,
        price_amount: true,
        price_currency: true,
        price_usd_amount: true,
        price_unavailable_reason: true,
        buyback_rate: true,
        buyback_source_kind: true,
        vendor_ev_amount: true,
        vendor_ev_currency: true,
        vendor_ev_observed_at: true,
        vendor_ev_unavailable_reason: true,
        packscout_ev_amount: true,
        packscout_ev_currency: true,
        packscout_ev_model_version: true,
        packscout_ev_confidence_policy_version: true,
        packscout_ev_confidence: true,
        packscout_ev_data_as_of: true,
        packscout_ev_calculated_at: true,
        packscout_ev_unavailable_reason: true,
        primary_image_url: true,
        primary_image_alt: true,
        listing_url: true,
        source_updated_at: true,
        retired_at: true,
        updated_at: true,
      },
    })
  );
  requireSnapshotLimit("packs", packs.length);
  const contents = await phases.run(() =>
    transaction.pack_contents.findMany({
      where: {
        lifecycle: "active",
        pack: PROVIDER_RELEASE_PUBLIC_PACK_SCOPE,
      },
      take: SNAPSHOT_LIMITS.contents + 1,
      orderBy: [{ pack_id: "asc" }, { display_order: "asc" }, { id: "asc" }],
      select: {
        id: true,
        pack_id: true,
        collectible_id: true,
        collectible_instance_id: true,
        content_role: true,
        probability: true,
        evidence_kinds: true,
        match_confidence_basis_points: true,
        match_confidence_band: true,
        observed_at: true,
        display_order: true,
        lifecycle: true,
      },
    })
  );
  requireSnapshotLimit("contents", contents.length);
  const categories = await phases.run(() =>
    transaction.categories.findMany({
      where: { packs: { some: PROVIDER_RELEASE_PUBLIC_PACK_SCOPE } },
      take: SNAPSHOT_LIMITS.categories + 1,
      orderBy: { id: "asc" },
      select: {
        id: true, parent_category_id: true, category_key: true,
        display_name: true, lifecycle: true, row_version: true,
      },
    })
  );
  const collectibles = await phases.run(() =>
    transaction.collectibles.findMany({
      where: {
        pack_contents: {
          some: {
            lifecycle: "active",
            pack: PROVIDER_RELEASE_PUBLIC_PACK_SCOPE,
          },
        },
      },
      take: SNAPSHOT_LIMITS.collectibles + 1,
      orderBy: { id: "asc" },
      select: { id: true, collectible_type: true, lifecycle: true, row_version: true },
    })
  );
  requireSnapshotLimit("categories", categories.length);
  requireSnapshotLimit("collectibles", collectibles.length);
  if (
    identity.database_role !== "provider"
    || runtime.central_provider_id !== identity.provider_id
    || runtime.provider_key !== identity.provider_key
    || runtime.last_head_reached_at === null
  ) throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_SNAPSHOT_INVALID");
  phases.check();
  const snapshot: ProviderReleaseSnapshot = {
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
    // Local aliases never contribute to provider release bytes. Public aliases
    // arrive through the verified central catalog pin, so materializing the
    // provider's potentially multi-million-row alias table is both unnecessary
    // and unsafe for a single assembly transaction.
    aliases: [],
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
  phases.check();
  return snapshot;
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
  transaction: Pick<ProviderPrismaClient, "provider_release_batches">,
  providerReleaseId: string,
  phases?: ProviderReleaseTransactionPhases,
): Promise<readonly ProviderReleaseBatch[]> {
  const rows = await releasePhase(phases, () =>
    transaction.provider_release_batches.findMany({
      where: { provider_release_id: providerReleaseId },
      orderBy: [{ batch_kind: "asc" }, { batch_index: "asc" }],
    })
  );
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
  phases?: ProviderReleaseTransactionPhases,
): Promise<{ readonly release: StoredProviderRelease; readonly publicEquivalenceHash: string; readonly batches: readonly ProviderReleaseBatch[] }> {
  const release = storedRelease(row);
  const batches = await loadStoredBatches(transaction, row.id, phases);
  phases?.check();
  const publicEquivalenceHash = await assertProviderReleaseIntegrity({
    descriptor: release.descriptor,
    batches,
    ...(phases === undefined ? {} : { checkpoint: phases.check }),
  });
  phases?.check();
  return { release, publicEquivalenceHash, batches };
}

async function requireExactStoredRelease(
  transaction: ProviderTransactionClient,
  row: Parameters<typeof storedRelease>[0],
  built: BuiltProviderRelease,
  phases: ProviderReleaseTransactionPhases,
): Promise<StoredProviderRelease> {
  if (row.lifecycle !== "assembled" && row.lifecycle !== "complete") {
    throw new ProviderReleaseIntegrityError("A deterministic provider release ID has a terminal conflict.");
  }
  const stored = await requireStoredIntegrity(transaction, row, phases);
  phases.check();
  if (
    canonicalJson(stored.release.descriptor) !== canonicalJson(built.descriptor)
    || canonicalJson(stored.batches) !== canonicalJson(built.batches)
    || stored.publicEquivalenceHash !== built.publicEquivalenceHash
  ) {
    throw new ProviderReleaseIntegrityError("A deterministic provider release ID has conflicting immutable content.");
  }
  phases.check();
  return stored.release;
}

async function persistBuilt(
  transaction: ProviderTransactionClient,
  built: BuiltProviderRelease,
  phases: ProviderReleaseTransactionPhases,
): Promise<{ readonly release: StoredProviderRelease; readonly resumed: boolean }> {
  const descriptor = built.descriptor;
  const priorById = await phases.run(() =>
    transaction.provider_releases.findUnique({
      where: { id: descriptor.providerReleaseId },
    })
  );
  if (priorById) {
    return {
      release: await requireExactStoredRelease(
        transaction,
        priorById,
        built,
        phases,
      ),
      resumed: true,
    };
  }
  await phases.run(() => transaction.provider_releases.create({
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
  }));
  for (const batch of built.batches) {
    phases.check();
    await phases.run(() => transaction.provider_release_batches.create({
      data: {
        provider_release_id: descriptor.providerReleaseId,
        batch_kind: batch.batchKind,
        batch_index: batch.batchIndex,
        payload: jsonPayload(batch),
        record_count: batch.recordCount,
        byte_count: batch.byteCount,
        body_hash: batch.bodyHash,
      },
    }));
  }
  const [{ database_now: assembledAt }] = await phases.run(() =>
    transaction.$queryRaw<{ database_now: Date }[]>(
      ProviderPrisma.sql`SELECT clock_timestamp() AS database_now`,
    )
  );
  if (!assembledAt) throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_SNAPSHOT_INVALID");
  const assembled = await phases.run(() =>
    transaction.provider_releases.update({
      where: { id: descriptor.providerReleaseId },
      data: { lifecycle: "assembled", assembled_at: assembledAt },
    })
  );
  return { release: storedRelease(assembled), resumed: false };
}

async function assembleInSnapshot(input: {
  readonly transaction: ProviderTransactionClient;
  readonly pin: PinnedProviderReleaseInputs;
  readonly lease: ProviderReleaseLease;
  readonly phases: ProviderReleaseTransactionPhases;
}): Promise<ProviderReleaseAssemblyResult> {
  await requireFence(input.transaction, input.lease, input.phases);
  const snapshot = await loadSnapshot(input.transaction, input.phases);
  const predecessor = await input.phases.run(() =>
    input.transaction.provider_releases.findFirst({
      where: { lifecycle: "complete" },
      orderBy: [{ completed_at: "desc" }, { id: "asc" }],
    })
  );
  let built: BuiltProviderRelease;
  try {
    input.phases.check();
    built = await buildProviderRelease({
      snapshot,
      pin: input.pin,
      predecessorCompleteReleaseId: predecessor?.id ?? null,
      checkpoint: input.phases.check,
    });
    input.phases.check();
  } catch (error) {
    if (error instanceof ProviderReleaseValidationError) {
      throw new ProviderReleaseAssemblyError(
        error.code,
        snapshot.throughChangeSequence,
      );
    }
    throw error;
  }
  await requireFence(input.transaction, input.lease, input.phases);
  try {
    let cursorId: string | undefined;
    for (;;) {
      input.phases.check();
      const candidates = await input.phases.run(() =>
        input.transaction.provider_releases.findMany({
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
        })
      );
      for (const candidate of candidates) {
        input.phases.check();
        const stored = await requireStoredIntegrity(
          input.transaction,
          candidate,
          input.phases,
        );
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
      await requireFence(input.transaction, input.lease, input.phases);
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
  await requireFence(input.transaction, input.lease, input.phases);
  try {
    const persisted = await persistBuilt(
      input.transaction,
      built,
      input.phases,
    );
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

export interface ProviderReleaseSourceTransactionDeadline {
  readonly deadlineAt: number;
}

function publicationSourceTransactionOptions(
  deadline?: ProviderReleaseSourceTransactionDeadline,
) {
  if (deadline === undefined) return PUBLICATION_SOURCE_TRANSACTION;
  const available = Math.floor(deadline.deadlineAt - Date.now() - 50);
  const maxWait = Math.min(
    PUBLICATION_SOURCE_TRANSACTION.maxWait,
    Math.max(1, Math.floor(available / 5)),
  );
  const timeout = Math.min(
    PUBLICATION_SOURCE_TRANSACTION.timeout,
    available - maxWait,
  );
  if (timeout < 1) {
    throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_DEADLINE");
  }
  return { ...PUBLICATION_SOURCE_TRANSACTION, maxWait, timeout };
}

function publicationSourceTransactionExpired(error: unknown): boolean {
  return error !== null
    && typeof error === "object"
    && "code" in error
    && (error.code === "P2024" || error.code === "P2028");
}

async function withPublicationSourceDeadline<T>(
  deadline: ProviderReleaseSourceTransactionDeadline | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (deadline !== undefined && publicationSourceTransactionExpired(error)) {
      throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_DEADLINE");
    }
    throw error;
  }
}

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
  const metadata = await loadProviderReleasePublicationMetadata(
    transaction,
    providerReleaseId,
  );
  return hydrateProviderReleasePublicationSource(transaction, metadata);
}

export async function loadProviderReleasePublicationMetadata(
  transaction: Pick<ProviderPrismaClient,
    "database_identity" | "provider_releases" | "$queryRaw"
  >,
  providerReleaseId: string,
): Promise<ProviderReleasePublicationMetadata> {
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
  const [sizes] = await transaction.$queryRaw<Array<{
    batchCount: bigint;
    batchRecordCount: bigint;
    payloadByteCount: bigint;
  }>>(ProviderPrisma.sql`
    select count(*)::bigint as "batchCount",
           coalesce(sum(record_count), 0)::bigint as "batchRecordCount",
           coalesce(sum(octet_length(payload::text)), 0)::bigint
             as "payloadByteCount"
    from provider_release_batches
    where provider_release_id = ${providerReleaseId}::uuid
  `);
  if (
    sizes === undefined ||
    sizes.batchCount !== BigInt(row.batch_count) ||
    sizes.batchRecordCount > BigInt(Number.MAX_SAFE_INTEGER) ||
    sizes.payloadByteCount > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_STORED_CONFLICT");
  }
  if (
    sizes.payloadByteCount >
      BigInt(MAX_PROVIDER_PROMOTION_AGGREGATE_PLAN_BYTES)
  ) {
    throw new ProviderReleaseAssemblyError(
      "PROVIDER_RELEASE_PUBLICATION_TOO_LARGE",
    );
  }
  const release = storedRelease(row);
  return {
    release,
    descriptor: release.descriptor,
    batchRecordCount: Number(sizes.batchRecordCount),
    payloadByteCount: Number(sizes.payloadByteCount),
  };
}

export async function hydrateProviderReleasePublicationSource(
  provider: Pick<ProviderPrismaClient, "provider_release_batches">,
  metadata: ProviderReleasePublicationMetadata,
): Promise<ProviderReleasePublicationSource> {
  try {
    const batches = await loadStoredBatches(provider, metadata.release.id);
    const publicEquivalenceHash = await assertProviderReleaseIntegrity({
      descriptor: metadata.descriptor,
      batches,
    });
    if (
      batches.length !== metadata.release.batchCount ||
      batches.reduce((total, batch) => total + batch.recordCount, 0) !==
        metadata.batchRecordCount
    ) {
      throw new ProviderReleaseIntegrityError(
        "Stored provider release metadata changed during hydration.",
      );
    }
    return {
      release: metadata.release,
      descriptor: metadata.descriptor,
      batches,
      publicEquivalenceHash,
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
    readonly deadlineAt?: number;
    readonly signal?: AbortSignal;
  }): Promise<ProviderReleaseAssemblyResult> {
    requireLeaseInput(input.workerId, input.leaseMilliseconds);
    const control = releaseAssemblyControl(input);
    try {
      await requireProviderPinPreflight({
        provider: this.provider,
        pin: input.pin,
        control,
      });
      const lease = await acquireReleaseLease({
        provider: this.provider,
        workerId: input.workerId,
        leaseMilliseconds: input.leaseMilliseconds,
        control,
      });
      if (lease === null) {
        throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_LEASE_HELD");
      }
      const leasedControl = control.deadlineAt === null
        ? control
        : {
            ...control,
            deadlineAt: Math.min(
              control.deadlineAt,
              lease.leaseExpiresAt.getTime(),
            ),
          };
      try {
        const transactionOptions = boundedReleaseTransactionOptions(
          ASSEMBLY_TRANSACTION,
          leasedControl,
        );
        const assembled = await this.provider.$transaction(
          (transaction) => {
            const phases = releaseTransactionPhases({
              transaction,
              transactionTimeoutMilliseconds: transactionOptions.timeout,
              control: leasedControl,
            });
            return assembleInSnapshot({
              transaction,
              pin: input.pin,
              lease,
              phases,
            });
          },
          transactionOptions,
        );
        requireReleaseAssemblyActive(leasedControl);
        return assembled;
      } finally {
        // The bounded transaction has settled. A lease that cannot be released
        // inside the remaining window is safe to expire by fence.
        await releaseReleaseLeaseBeforeDeadline({
          provider: this.provider,
          lease,
          control: releaseLeaseControl(leasedControl, lease),
        });
      }
    } catch (error) {
      if (control.signal?.aborted === true) {
        throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_CANCELLED");
      }
      if (control.deadlineAt !== null && Date.now() >= control.deadlineAt) {
        throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_DEADLINE");
      }
      if (
        control.deadlineAt !== null
        && (
          providerPageQueryExpiration(error) !== null
          || releaseStatementTimeout(error)
        )
      ) {
        throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_DEADLINE");
      }
      throw error;
    }
  }

  publicationSource(
    providerReleaseId: string,
    deadline?: ProviderReleaseSourceTransactionDeadline,
  ): Promise<ProviderReleasePublicationSource> {
    const id = requireProviderReleaseId(providerReleaseId);
    return withPublicationSourceDeadline(deadline, async () => {
      const metadata = await this.provider.$transaction(
        (transaction) => loadProviderReleasePublicationMetadata(transaction, id),
        publicationSourceTransactionOptions(deadline),
      );
      if (deadline !== undefined && Date.now() >= deadline.deadlineAt) {
        throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_DEADLINE");
      }
      const source = await hydrateProviderReleasePublicationSource(
        this.provider,
        metadata,
      );
      if (deadline !== undefined && Date.now() >= deadline.deadlineAt) {
        throw new ProviderReleaseAssemblyError("PROVIDER_RELEASE_DEADLINE");
      }
      return source;
    });
  }
}
