#!/usr/bin/env node

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ConvexHttpClient } from "convex/browser";
import {
  PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  globalCategoryPublicId,
  normalizeExactDecimal,
  normalizePublicSearchText,
  packscoutPublicIdentityUuid,
  provisionalCollectiblePublicId,
  providerReleaseCatalogPinHash,
  providerReleaseCorrelationSnapshotHash,
  publicCatalogCategorySchema,
  publicCatalogCollectibleSchema,
  publicVendorSchema,
  recomputeProviderCatalogReleaseOriginSetHashV1,
  sha256CanonicalJson,
  type PublicCatalogCategory,
  type PublicCatalogCollectible,
  type PublicRepackDetail,
} from "@packscout/contracts";
import {
  createProviderDatabaseLifecycle,
  PrismaProviderPromotionJobRepository,
  type PinnedProviderReleaseInputs,
  type ProviderPrismaClient,
} from "@packscout/database";
import {
  DataReleaseV3ReleaseAssembler,
  DataReleaseV3ReleasePublisher,
  SignedConvexDataReleaseV3PublicationClient,
  SignedConvexProviderReleasePublicationClient,
  type DataReleaseV3CanonicalProduct,
  type DistributedProviderReleasePublicationTransport,
} from "@packscout/services";
import { readProviderPublicationJobAuthorityConfiguration } from
  "../../apps/worker/src/distributed-promotion-authority-config.ts";
import { createProviderPromotionJobRuntime } from
  "../../apps/worker/src/provider-promotion-job-runtime-composition.ts";
import { createLocalConvexEvMigrationClient } from
  "./local-convex-ev-migration-client.mts";
import { withLocalConvexEvReady } from "./local-convex-ev-migration.mts";
import { withVerifiedLocalConvexPublicationAuthorityCleanup } from
  "./local-convex-publication-authorities.mts";
import { readLocalClutchpacksV3List } from
  "./distributed-clutchpacks-public-transport.mts";
import { clutchpacksPublicValuationFields } from
  "./distributed-clutchpacks-content-snapshot.mts";
import { parseClutchpacksApprovedAssetOrigins } from
  "./distributed-clutchpacks-publication-snapshot.mts";
import {
  captureProviderBatch,
  dataReleaseV3KeyId,
  installPublicationAuthorities,
  loopbackSiteUrl,
  providerKeyId,
  type CapturedProviderRows,
} from "./run-provider-promotion-frontend-e2e.mts";
import { readLocalConvexConfiguration } from
  "./seed-convex-mock-data-release.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const temporaryClusterPrefix = "/tmp/packscout-clutchpacks-worker-e2e-";
const providerDatabaseName = "packscout_clutchpacks";
const centralDatabaseName = "packscout";
const databaseUser = "packscout_clutchpacks_worker_e2e";
const postgresPort = 5432;
const postgresSearchPathStatement =
  "SELECT pg_catalog.set_config('search_path', '', false);";
const restoredSearchPathStatement =
  "SELECT pg_catalog.set_config('search_path', 'public', false);";
const publicPackScope = {
  lifecycle: "active" as const,
  availability: { not: "unavailable" as const },
};

export class LocalClutchpacksWorkerE2eError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "LocalClutchpacksWorkerE2eError";
  }
}

function refuse(code: string): never {
  throw new LocalClutchpacksWorkerE2eError(code);
}

export function parseClutchpacksWorkerE2eArguments(
  args: readonly string[],
): void {
  if (args.length !== 0) refuse("LOCAL_CLUTCHPACKS_WORKER_E2E_ARGUMENT_INVALID");
}

export function isOwnedTemporaryClusterPath(value: string): boolean {
  return path.dirname(value) === "/tmp"
    && /^packscout-clutchpacks-worker-e2e-[A-Za-z0-9]+$/u.test(
      path.basename(value),
    );
}

export function assertProtectedDumpMetadata(input: Readonly<{
  dumpPath: string;
  resolvedPath: string;
  repositoryPath: string;
  isFile: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  uid?: number;
  processUid?: number;
}>): void {
  const relative = path.relative(input.repositoryPath, input.resolvedPath);
  if (
    input.dumpPath.trim() === "" || /[\r\n\0]/u.test(input.dumpPath)
    || path.extname(input.resolvedPath) !== ".dump"
    || !input.isFile || input.isSymbolicLink || input.size < 1
    || (input.mode & 0o077) !== 0
    || (input.uid !== undefined && input.processUid !== undefined
      && input.uid !== input.processUid)
    || relative === "" || (!relative.startsWith(`..${path.sep}`)
      && relative !== ".." && !path.isAbsolute(relative))
  ) refuse("PROTECTED_CLUTCHPACKS_DUMP_INVALID");
}

async function protectedDumpPath(
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const configured = environment.PACKSCOUT_LOCAL_CLUTCHPACKS_DUMP_PATH
    ?.trim() ?? "";
  if (configured === "") return refuse("PROTECTED_CLUTCHPACKS_DUMP_REQUIRED");
  const [details, resolvedPath] = await Promise.all([
    lstat(configured).catch(() => refuse("PROTECTED_CLUTCHPACKS_DUMP_INVALID")),
    realpath(configured).catch(() => refuse("PROTECTED_CLUTCHPACKS_DUMP_INVALID")),
  ]);
  assertProtectedDumpMetadata({
    dumpPath: configured,
    resolvedPath,
    repositoryPath: repositoryRoot,
    isFile: details.isFile(),
    isSymbolicLink: details.isSymbolicLink(),
    mode: details.mode,
    size: details.size,
    uid: details.uid,
    processUid: typeof process.getuid === "function"
      ? process.getuid()
      : undefined,
  });
  return resolvedPath;
}

async function sha256File(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  const { createReadStream } = await import("node:fs");
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

function waitForChild(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`child failed (${signal ?? code ?? "unknown"})`));
    });
  });
}

function searchPathTransform(): Transform {
  let carry = "";
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const value = carry + chunk.toString("utf8");
      const boundary = Math.max(
        0,
        value.length - postgresSearchPathStatement.length + 1,
      );
      this.push(value.slice(0, boundary).replaceAll(
        postgresSearchPathStatement,
        restoredSearchPathStatement,
      ));
      carry = value.slice(boundary);
      callback();
    },
    flush(callback) {
      this.push(carry.replaceAll(
        postgresSearchPathStatement,
        restoredSearchPathStatement,
      ));
      callback();
    },
  });
}

async function restoreDump(input: Readonly<{
  binDirectory: string;
  dumpPath: string;
  socketDirectory: string;
}>): Promise<void> {
  const environment = {
    PATH: `${input.binDirectory}:/usr/bin:/bin`,
    LANG: "C",
    LC_ALL: "C",
  };
  const restore = spawn(path.join(input.binDirectory, "pg_restore"), [
    "--no-owner",
    "--no-privileges",
    "--file=-",
    input.dumpPath,
  ], { env: environment, stdio: ["ignore", "pipe", "pipe"] });
  const psql = spawn(path.join(input.binDirectory, "psql"), [
    "-X",
    "--set=ON_ERROR_STOP=1",
    "--host", input.socketDirectory,
    "--port", String(postgresPort),
    "--username", databaseUser,
    "--dbname", providerDatabaseName,
    "--file=-",
  ], { env: environment, stdio: ["pipe", "ignore", "pipe"] });
  restore.stderr?.resume();
  psql.stderr?.resume();
  const restored = waitForChild(restore);
  const applied = waitForChild(psql);
  try {
    psql.stdin!.write("BEGIN;\n");
    await pipeline(
      restore.stdout!,
      searchPathTransform(),
      psql.stdin!,
      { end: false },
    );
    await restored;
    psql.stdin!.end("COMMIT;\n");
    await applied;
  } catch {
    restore.kill("SIGTERM");
    psql.kill("SIGTERM");
    await Promise.allSettled([restored, applied]);
    refuse("PROTECTED_CLUTCHPACKS_DUMP_RESTORE_FAILED");
  }
}

export function postgresUrl(
  socketDirectory: string,
  databaseName: string,
): string {
  const result = new URL(
    `postgresql://${databaseUser}@localhost:${postgresPort}/${databaseName}`,
  );
  result.searchParams.set("host", socketDirectory);
  result.searchParams.set("connection_limit", "2");
  return result.toString();
}

async function runMigration(input: Readonly<{
  databaseUrl: string;
  role: "central" | "provider";
}>): Promise<void> {
  const key = input.role === "central"
    ? "PACKSCOUT_CENTRAL_DATABASE_URL"
    : "PACKSCOUT_PROVIDER_DATABASE_URL";
  await execFileAsync(process.execPath, [
    path.join(repositoryRoot, "node_modules/prisma/build/index.js"),
    "migrate",
    "deploy",
    "--schema",
    path.join(
      repositoryRoot,
      `packages/database/prisma/${input.role}/schema.prisma`,
    ),
  ], {
    cwd: repositoryRoot,
    env: { ...process.env, [key]: input.databaseUrl },
    timeout: 180_000,
    maxBuffer: 4 * 1_048_576,
  }).catch(() => refuse(`LOCAL_${input.role.toUpperCase()}_MIGRATION_FAILED`));
}

async function postgres16BinDirectory(
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const directory = environment.PACKSCOUT_TEST_POSTGRES_BIN_DIRECTORY?.trim()
    || "/opt/homebrew/opt/postgresql@16/bin";
  const version = await execFileAsync(path.join(directory, "postgres"), [
    "--version",
  ], { timeout: 10_000 }).then(({ stdout }) => stdout.trim()).catch(() => "");
  if (!/^postgres \(PostgreSQL\) 16\.[0-9]+(?: \(Homebrew\))?$/u.test(version)) {
    return refuse("LOCAL_POSTGRES_16_REQUIRED");
  }
  return directory;
}

interface DisposablePostgres {
  readonly providerUrl: string;
  readonly close: () => Promise<void>;
}

async function createDisposablePostgres(input: Readonly<{
  binDirectory: string;
  dumpPath: string;
}>): Promise<DisposablePostgres> {
  const directory = await mkdtemp(temporaryClusterPrefix);
  if (!isOwnedTemporaryClusterPath(directory)) {
    return refuse("LOCAL_POSTGRES_CLUSTER_TARGET_UNSAFE");
  }
  const dataDirectory = path.join(directory, "data");
  const pgCtl = path.join(input.binDirectory, "pg_ctl");
  let started = false;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (started) {
      await execFileAsync(pgCtl, [
        "stop", "-D", dataDirectory, "-m", "fast", "-w", "-t", "30",
      ], { timeout: 40_000 }).catch(() =>
        refuse("LOCAL_POSTGRES_CLUSTER_CLEANUP_FAILED")
      );
      started = false;
    }
    if (!isOwnedTemporaryClusterPath(directory)) {
      return refuse("LOCAL_POSTGRES_CLUSTER_TARGET_UNSAFE");
    }
    await rm(directory, { recursive: true, force: false }).catch(() =>
      refuse("LOCAL_POSTGRES_CLUSTER_CLEANUP_FAILED")
    );
  };
  try {
    await execFileAsync(path.join(input.binDirectory, "initdb"), [
      "-D", dataDirectory,
      "-A", "trust",
      "-U", databaseUser,
      "--no-locale",
      "-E", "UTF8",
      "--data-checksums",
    ], { timeout: 60_000, maxBuffer: 2 * 1_048_576 });
    await execFileAsync(pgCtl, [
      "start", "-D", dataDirectory,
      "-l", path.join(directory, "postgres.log"),
      "-w", "-t", "30",
      "-o",
      `-F -p ${postgresPort} -k ${directory} -c listen_addresses='' -c unix_socket_permissions=0700`,
    ], { timeout: 40_000, maxBuffer: 2 * 1_048_576 });
    started = true;
    for (const databaseName of [centralDatabaseName, providerDatabaseName]) {
      await execFileAsync(path.join(input.binDirectory, "createdb"), [
        "--host", directory,
        "--port", String(postgresPort),
        "--username", databaseUser,
        databaseName,
      ], { timeout: 20_000, maxBuffer: 1_048_576 });
    }
    await runMigration({
      role: "central",
      databaseUrl: postgresUrl(directory, centralDatabaseName),
    });
    await restoreDump({
      binDirectory: input.binDirectory,
      dumpPath: input.dumpPath,
      socketDirectory: directory,
    });
    const providerUrl = postgresUrl(directory, providerDatabaseName);
    await runMigration({ role: "provider", databaseUrl: providerUrl });
    return { providerUrl, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function approvedUrl(value: string, code: string): URL {
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" || parsed.username !== ""
      || parsed.password !== ""
    ) return refuse(code);
    return parsed;
  } catch {
    return refuse(code);
  }
}

async function localReleasePin(input: Readonly<{
  provider: ProviderPrismaClient;
  approvedImageOrigins: readonly string[];
}>): Promise<Readonly<{
  pin: PinnedProviderReleaseInputs;
  packKeyByPublicId: ReadonlyMap<string, string>;
  canonicalCounts: Readonly<{ packs: number; collectibles: number }>;
  laneSequence: bigint;
}>> {
  return await input.provider.$transaction(async (transaction) => {
    const [identity, runtime, ledger, allCategories, packs, collectibles] =
      await Promise.all([
        transaction.database_identity.findUniqueOrThrow({
          where: { singleton_key: true },
        }),
        transaction.provider_runtime.findUniqueOrThrow({
          where: { singleton_key: true },
        }),
        transaction.promotion_ledger.findUniqueOrThrow({
          where: { singleton_key: true },
        }),
        transaction.categories.findMany({
          orderBy: [{ category_key: "asc" }, { id: "asc" }],
        }),
        transaction.packs.findMany({
          where: publicPackScope,
          orderBy: { id: "asc" },
          select: {
            id: true,
            pack_key: true,
            category_id: true,
            listing_url: true,
            primary_image_url: true,
          },
        }),
        transaction.collectibles.findMany({
          where: {
            pack_contents: {
              some: { lifecycle: "active", pack: publicPackScope },
            },
          },
          orderBy: { id: "asc" },
          include: {
            aliases: {
              where: { lifecycle: "active" },
              orderBy: [{ display_name: "asc" }, { id: "asc" }],
            },
          },
        }),
      ]);
    if (identity.database_role !== "provider") {
      return refuse("CLUTCHPACKS_CANONICAL_ROLE_INVALID");
    }
    if (
      identity.provider_key !== "clutchpacks"
      || runtime.central_provider_id !== identity.provider_id
      || runtime.provider_key !== identity.provider_key
    ) return refuse("CLUTCHPACKS_CANONICAL_IDENTITY_INVALID");
    if (runtime.cached_config_version_id === null) {
      return refuse("CLUTCHPACKS_CANONICAL_CONFIG_MISSING");
    }
    if (runtime.last_head_reached_at === null) {
      return refuse("CLUTCHPACKS_CANONICAL_HEAD_MISSING");
    }
    if (ledger.last_sequence < 1n) {
      return refuse("CLUTCHPACKS_CANONICAL_LANE_EMPTY");
    }
    if (packs.length < 1) return refuse("CLUTCHPACKS_CANONICAL_PACKS_EMPTY");

    const categoryById = new Map(allCategories.map((row) => [row.id, row]));
    const selectedCategoryIds = new Set<string>();
    for (const categoryId of [
      ...packs.map(({ category_id }) => category_id),
      ...collectibles.map(({ category_id }) => category_id),
    ]) {
      let cursor = categoryId;
      const visited = new Set<string>();
      while (cursor !== null) {
        if (visited.has(cursor) || visited.size >= 12) {
          return refuse("CLUTCHPACKS_LOCAL_CATEGORY_PATH_INVALID");
        }
        visited.add(cursor);
        const row = categoryById.get(cursor);
        if (row === undefined || row.lifecycle !== "active") {
          return refuse("CLUTCHPACKS_LOCAL_CATEGORY_PATH_INVALID");
        }
        selectedCategoryIds.add(row.id);
        cursor = row.parent_category_id;
      }
    }
    const selectedCategories = allCategories.filter(({ id }) =>
      selectedCategoryIds.has(id)
    );
    const pathFor = (categoryId: string): string[] => {
      const reversed: string[] = [];
      let cursor: string | null = categoryId;
      while (cursor !== null) {
        const row = categoryById.get(cursor);
        if (row === undefined) {
          return refuse("CLUTCHPACKS_LOCAL_CATEGORY_PATH_INVALID");
        }
        reversed.push(globalCategoryPublicId(row.id));
        cursor = row.parent_category_id;
      }
      return reversed.reverse();
    };
    const catalogCategories = selectedCategories.map((row, displayOrder) => {
      const pathPublicCategoryIds = pathFor(row.id);
      return publicCatalogCategorySchema.parse({
        publicCategoryId: globalCategoryPublicId(row.id),
        parentPublicCategoryId: row.parent_category_id === null
          ? null
          : globalCategoryPublicId(row.parent_category_id),
        // Canonical provider category keys are not centrally governed public
        // keys yet, so this local-only pin uses a stable non-semantic key.
        categoryKey: `local-${row.id}`,
        displayName: row.display_name,
        categoryKind: "other",
        displayOrder,
        depth: pathPublicCategoryIds.length - 1,
        pathPublicCategoryIds,
        lifecycle: "active",
      }) as PublicCatalogCategory;
    });
    const approvedOrigins = new Set(input.approvedImageOrigins);
    const catalogCollectibles = collectibles.map((row) => {
      const aliases = row.aliases.map(({ display_name }) => display_name);
      if (aliases.length > 32 || new Set(aliases).size !== aliases.length) {
        return refuse("CLUTCHPACKS_LOCAL_COLLECTIBLE_ALIAS_INVALID");
      }
      if (
        row.primary_image_url !== null
        && !approvedOrigins.has(approvedUrl(
          row.primary_image_url,
          "CLUTCHPACKS_LOCAL_IMAGE_ORIGIN_INVALID",
        ).origin)
      ) return refuse("CLUTCHPACKS_LOCAL_IMAGE_ORIGIN_INVALID");
      return publicCatalogCollectibleSchema.parse({
        publicCollectibleId: provisionalCollectiblePublicId({
          providerId: identity.provider_id,
          localCollectibleId: row.id,
        }),
        identityState: "provisional",
        collectibleType: row.collectible_type,
        displayName: row.display_name,
        normalizedName: normalizePublicSearchText(row.display_name),
        nameAliases: aliases,
        normalizedNameAliases: aliases.map(normalizePublicSearchText).sort(),
        publicCategoryIds: row.category_id === null
          ? []
          : [globalCategoryPublicId(row.category_id)],
        year: row.year,
        brand: row.brand,
        setOrSeries: row.set_or_series,
        cardNumber: row.card_number,
        referenceNumber: row.reference_number,
        subject: row.subject,
        grade: row.grade,
        grader: row.grader,
        primaryImageUrl: row.primary_image_url,
        primaryImageAlt: row.primary_image_url === null
          ? null
          : row.primary_image_alt ?? row.display_name,
        valuationAmount: row.valuation_amount === null
          ? null
          : normalizeExactDecimal(row.valuation_amount.toFixed()),
        valuationCurrency: row.valuation_currency,
        valuationUsdAmount: row.valuation_usd_amount === null
          ? null
          : normalizeExactDecimal(row.valuation_usd_amount.toFixed()),
        ...clutchpacksPublicValuationFields({
          valuationType: row.valuation_type,
          valuationUnavailableReason: row.valuation_unavailable_reason,
        }),
        valuationObservedAt: row.valuation_observed_at?.toISOString() ?? null,
        dataAsOf: row.data_as_of.toISOString(),
      }) as PublicCatalogCollectible;
    });
    for (const pack of packs) {
      if (
        pack.primary_image_url !== null
        && !approvedOrigins.has(approvedUrl(
          pack.primary_image_url,
          "CLUTCHPACKS_LOCAL_IMAGE_ORIGIN_INVALID",
        ).origin)
      ) return refuse("CLUTCHPACKS_LOCAL_IMAGE_ORIGIN_INVALID");
    }
    const listingHosts = [...new Set(packs.flatMap(({ listing_url }) =>
      listing_url === null
        ? []
        : [approvedUrl(listing_url, "CLUTCHPACKS_LOCAL_LISTING_URL_INVALID").host]
    ))].sort();
    const publicProvider = publicVendorSchema.parse({
      publicVendorId: packscoutPublicIdentityUuid(
        `provider:${identity.provider_id}`,
      ),
      vendorKey: identity.provider_key,
      displayName: "ClutchPacks",
      logoUrl: null,
      websiteUrl: null,
      listingHosts,
      imageOrigins: input.approvedImageOrigins,
      referralParameters: [],
      publicPromo: null,
    });
    const catalogContentHash = await sha256CanonicalJson(
      "packscout.local-clutchpacks-worker-catalog.v1",
      { categories: catalogCategories, collectibles: catalogCollectibles, aliases: [] },
    );
    const catalogVersionId = packscoutPublicIdentityUuid(
      `local-clutchpacks-worker-catalog:${catalogContentHash}`,
    );
    const categoryCorrelations = selectedCategories.map((row) => ({
      localCategoryId: row.id,
      localEntityVersion: row.row_version,
      publicCategoryId: globalCategoryPublicId(row.id),
    })).sort((left, right) =>
      left.localCategoryId.localeCompare(right.localCategoryId)
    );
    const collectibleCorrelations = collectibles.map((row) => ({
      localCollectibleId: row.id,
      localEntityVersion: row.row_version,
      publicCollectibleId: provisionalCollectiblePublicId({
        providerId: identity.provider_id,
        localCollectibleId: row.id,
      }),
    }));
    const publicProfileHash = await sha256CanonicalJson(
      PROVIDER_PUBLIC_PROFILE_HASH_DOMAIN,
      publicProvider,
    );
    const pin: PinnedProviderReleaseInputs = {
      providerId: identity.provider_id,
      providerKey: identity.provider_key,
      providerConfigVersionId: runtime.cached_config_version_id,
      providerConfigExpiresAt: runtime.config_expires_at,
      staleAfterSeconds: 86_400,
      centralSchemaVersion: "distributed-central-v1",
      catalogVersionId,
      catalogSchemaVersion: "catalog-v1",
      catalogContentHash,
      catalogThroughChangeSequence: ledger.last_sequence,
      catalogCategories,
      catalogCollectibles,
      catalogAliases: [],
      catalogArtifactVerificationHash: await providerReleaseCatalogPinHash({
        catalogVersionId,
        catalogSchemaVersion: "catalog-v1",
        catalogContentHash,
        catalogThroughChangeSequence: ledger.last_sequence.toString(),
        categories: catalogCategories,
        collectibles: catalogCollectibles,
        aliases: [],
      }),
      correlationEventSequence: ledger.last_sequence,
      correlationSnapshotHash: await providerReleaseCorrelationSnapshotHash({
        providerId: identity.provider_id,
        correlationEventSequence: ledger.last_sequence.toString(),
        categories: categoryCorrelations.map((row) => ({
          ...row,
          localEntityVersion: row.localEntityVersion.toString(),
        })),
        collectibles: collectibleCorrelations.map((row) => ({
          ...row,
          localEntityVersion: row.localEntityVersion.toString(),
        })),
      }),
      categoryCorrelations,
      collectibleCorrelations,
      publicProfileVersionId: packscoutPublicIdentityUuid(
        `local-clutchpacks-worker-profile:${publicProfileHash}`,
      ),
      publicProfileHash,
      publicProvider,
    };
    return {
      pin,
      packKeyByPublicId: new Map(packs.map((pack) => [
        packscoutPublicIdentityUuid(
          `provider:${identity.provider_id}:pack:${pack.id}`,
        ),
        pack.pack_key,
      ])),
      canonicalCounts: {
        packs: await transaction.packs.count(),
        collectibles: await transaction.collectibles.count(),
      },
      laneSequence: ledger.last_sequence,
    };
  }, { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 60_000 });
}

function v3Product(input: Readonly<{
  detail: PublicRepackDetail;
  productKey: string;
}>): DataReleaseV3CanonicalProduct {
  const detail = input.detail;
  const vendorReported = detail.evEstimates.vendorReported;
  return {
    platformKey: "clutchpacks",
    productKey: input.productKey,
    publicRepackId: detail.publicRepackId,
    publicVendorId: detail.publicVendorId,
    vendorKey: detail.vendorKey,
    vendorDisplayName: detail.vendorDisplayName,
    vendorLogoUrl: detail.vendorLogoUrl,
    name: detail.name,
    format: detail.format,
    contentMode: detail.contentMode,
    categories: detail.categories,
    collectibleTypes: detail.collectibleTypes,
    availability: detail.availability,
    soldOutAt: null,
    price: detail.price,
    buyback: detail.buyback.status === "available"
      ? { kind: "uniform_rate", rateBasisPoints: detail.buyback.value.basisPoints }
      : { kind: "not_documented" },
    vendorReportedEv: vendorReported.status === "available"
      ? {
          status: "available",
          sourceMoney: vendorReported.displayMoney,
          usdComparison: {
            status: "available",
            value: vendorReported.metrics.grossEv,
          },
          observedAt: vendorReported.observedAt,
        }
      : {
          status: "unavailable",
          sourceMoney: null,
          usdComparison: null,
          observedAt: null,
          reason: "NOT_REPORTED",
        },
    primaryImage: detail.primaryImage,
    topChase: detail.topChase,
    contentSummary: detail.contentSummary,
    actionAvailability: detail.actionAvailability,
    sourceUpdatedAt: detail.sourceUpdatedAt,
    description: detail.description,
    actions: detail.actions,
  };
}

function exactPublicIds(rows: readonly { readonly publicRepackId: string }[]) {
  return [...new Set(rows.map(({ publicRepackId }) => publicRepackId))].sort();
}

export async function runClutchpacksProviderPromotionFrontendE2e(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const dumpPath = await protectedDumpPath(environment);
  const approvedImageOrigins = parseClutchpacksApprovedAssetOrigins(
    environment.PACKSCOUT_LOCAL_CLUTCHPACKS_PUBLIC_ASSET_ORIGINS_JSON,
  );
  const [dumpSha256, binDirectory, local] = await Promise.all([
    sha256File(dumpPath),
    postgres16BinDirectory(environment),
    readLocalConvexConfiguration(),
  ]);
  const siteUrl = loopbackSiteUrl(local.childEnvironment);
  const postgres = await createDisposablePostgres({ binDirectory, dumpPath });
  let cleaned = false;
  let lifecycle: ReturnType<typeof createProviderDatabaseLifecycle> | undefined;
  let runtime: ReturnType<typeof createProviderPromotionJobRuntime>["runtime"]
    | undefined;
  const providerSecret = new Uint8Array(randomBytes(32));
  const dataReleaseV3Secret = new Uint8Array(randomBytes(32));
  let evidence: Record<string, unknown> | undefined;
  try {
    const identityClient = createProviderDatabaseLifecycle({
      databaseUrl: postgres.providerUrl,
      providerId: "00000000-0000-4000-8000-000000000000",
      providerKey: "clutchpacks",
      connectionLimit: 2,
    });
    const identity = await identityClient.client.database_identity
      .findUniqueOrThrow({ where: { singleton_key: true } });
    await identityClient.close();
    lifecycle = createProviderDatabaseLifecycle({
      databaseUrl: postgres.providerUrl,
      providerId: identity.provider_id,
      providerKey: identity.provider_key,
      connectionLimit: 2,
    });
    await lifecycle.start();
    const restoredRuntime = await lifecycle.client.provider_runtime
      .findUniqueOrThrow({ where: { singleton_key: true } });
    const normalizedLegacyFreshness = restoredRuntime.freshness_state !== "fresh"
      && restoredRuntime.freshness_state !== "stale";
    if (normalizedLegacyFreshness) {
      // This protected snapshot predates the publication contract's two
      // accepted labels. Preserve uncertainty by mapping only the disposable
      // copy to stale; never manufacture a fresh source observation.
      await lifecycle.client.provider_runtime.update({
        where: { singleton_key: true },
        data: { freshness_state: "stale", row_version: { increment: 1 } },
      });
    }
    const localPin = await localReleasePin({
      provider: lifecycle.client,
      approvedImageOrigins,
    });
    const initialPublication = await lifecycle.client.provider_publication_state
      .findUniqueOrThrow({ where: { singleton_key: true } });
    if (
      initialPublication.completed_through_change_sequence >=
        localPin.laneSequence
    ) return refuse("CLUTCHPACKS_PROVIDER_CHECKPOINT_NOT_BEHIND");
    const originSetHash =
      await recomputeProviderCatalogReleaseOriginSetHashV1(
        approvedImageOrigins,
      );
    const frontendOriginSetHash = createHash("sha256")
      .update(JSON.stringify([...approvedImageOrigins].sort()))
      .digest("hex");
    await withLocalConvexEvReady(
      await createLocalConvexEvMigrationClient(local),
      async () => await withVerifiedLocalConvexPublicationAuthorityCleanup({
        install: async () => await installPublicationAuthorities({
          environment: local.childEnvironment,
          providerKey: "clutchpacks",
          providerSecret,
          dataReleaseV3Secret,
          originSetHash,
        }),
        publish: async () => {
          const providerClient =
            new SignedConvexProviderReleasePublicationClient({
              baseUrl: siteUrl,
              keyId: providerKeyId,
              secret: providerSecret,
            });
          const v3Client = new SignedConvexDataReleaseV3PublicationClient({
            baseUrl: siteUrl,
            keyId: dataReleaseV3KeyId,
            secret: dataReleaseV3Secret,
          });
          const [initialProviderHead, initialV3] = await Promise.all([
            providerClient.completedHead({
              schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
              operationId: "local-clutchpacks-worker-e2e-fresh-head",
              platformKey: "clutchpacks",
            }),
            v3Client.activeState(),
          ]);
          if (
            initialProviderHead.receipt.details.head.release !== null
            || initialV3.activeRelease !== null
          ) return refuse("LOCAL_CONVEX_NOT_FRESH");
          const captured: CapturedProviderRows = {
            categories: [], collectibles: [], repacks: [], chases: [],
          };
          const transport: DistributedProviderReleasePublicationTransport = {
            async sendExact(operation, signal) {
              if (operation.kind === "applyBatch") {
                captureProviderBatch(captured, operation.canonicalRequestBody);
              }
              return await providerClient.sendExact(operation, signal);
            },
            async status(request, signal) {
              return await providerClient.status(request, signal);
            },
          };
          const authority = readProviderPublicationJobAuthorityConfiguration({
            PACKSCOUT_CONVEX_PUBLICATION_BASE_URL: "https://convex.example",
            PACKSCOUT_CATALOG_DEPLOYMENT_KEY: "local-clutchpacks-worker-e2e",
            PACKSCOUT_PROMOTION_PROVIDER_ID: localPin.pin.providerId,
            PACKSCOUT_PROMOTION_PROVIDER_KEY_ID: providerKeyId,
            PACKSCOUT_PROMOTION_PROVIDER_SECRET_BASE64:
              Buffer.from(providerSecret).toString("base64"),
            PACKSCOUT_PROMOTION_PROVIDER_AUTHORITY_VERSION: "local-e2e-v1",
          });
          const composed = createProviderPromotionJobRuntime({
            authority,
            provider: lifecycle!.client,
            pin: localPin.pin,
            loadPin: async () => localPin.pin,
            workerId: "provider-promotion:clutchpacks-local-e2e",
            logger: { log() {} },
            manualCommands: {
              async verify() {
                return { state: "rejected", failureCode: "NOT_USED" };
              },
            },
            transport,
          });
          runtime = composed.runtime;
          const jobs = new PrismaProviderPromotionJobRepository(
            lifecycle!.client,
          );
          const wake = await jobs.coalesceWake({
            requestedGeneration: 1n,
            cause: "canonical_settlement",
            requestedAt: new Date(),
          });
          if (!wake.pending) return refuse("LOCAL_CLUTCHPACKS_WAKE_NOT_PENDING");
          let invocation:
            | Awaited<ReturnType<typeof runtime.runCycle>>["invocations"][number]
            | undefined;
          let invocationCount = 0;
          for (let cycleIndex = 0; cycleIndex < 4; cycleIndex += 1) {
            const cycle = await runtime.runCycle();
            if (cycle.reconciliationFailures !== 0) {
              return refuse("CLUTCHPACKS_PROVIDER_WORKER_RECONCILIATION_FAILED");
            }
            if (cycle.stateReadFailures !== 0) {
              return refuse("CLUTCHPACKS_PROVIDER_WORKER_STATE_READ_FAILED");
            }
            if (cycle.invocations.length !== 1) {
              return refuse("CLUTCHPACKS_PROVIDER_WORKER_INVOCATION_MISSING");
            }
            if (cycle.invocations[0]?.state !== "completed") {
              return refuse(
                cycle.invocations[0]?.failureCode
                  ?? "CLUTCHPACKS_PROVIDER_WORKER_INVOCATION_FAILED",
              );
            }
            invocation = cycle.invocations[0];
            invocationCount += 1;
            if (invocation.outcome === "caught_up") break;
            if (invocation.outcome !== "continuation_required") {
              const durable = await lifecycle!.client
                .provider_promotion_job_invocations.findFirst({
                  orderBy: [{ started_at: "desc" }, { run_id: "desc" }],
                  select: { safe_failure_code: true },
                });
              return refuse(
                durable?.safe_failure_code
                  ?? `CLUTCHPACKS_PROVIDER_WORKER_OUTCOME_${invocation.outcome
                    .toUpperCase().replaceAll(/[^A-Z0-9_]/gu, "_")}`,
              );
            }
          }
          if (invocation?.outcome !== "caught_up") {
            return refuse("CLUTCHPACKS_PROVIDER_WORKER_DID_NOT_CATCH_UP");
          }
          const [lane, publication] = await Promise.all([
            lifecycle!.client.promotion_ledger.findUniqueOrThrow({
              where: { singleton_key: true },
            }),
            lifecycle!.client.provider_publication_state.findUniqueOrThrow({
              where: { singleton_key: true },
            }),
          ]);
          if (
            lane.last_sequence !== localPin.laneSequence
            || publication.completed_through_change_sequence !==
              lane.last_sequence
            || captured.repacks.length < 1
          ) return refuse("CLUTCHPACKS_PROVIDER_CHECKPOINT_DIVERGENT");
          const providerHead = await providerClient.completedHead({
            schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
            operationId: "local-clutchpacks-worker-e2e-completed-head",
            platformKey: "clutchpacks",
          });
          if (
            providerHead.receipt.details.head.release === null
            || providerHead.receipt.details.head.providerCheckpoint
              .settledSequence !== lane.last_sequence.toString()
          ) return refuse("CLUTCHPACKS_PROVIDER_CONVEX_HEAD_DIVERGENT");
          const products = captured.repacks.map((detail) => {
            const productKey = localPin.packKeyByPublicId.get(
              detail.publicRepackId,
            );
            if (productKey === undefined) {
              return refuse("CLUTCHPACKS_WORKER_ROW_IDENTITY_DIVERGENT");
            }
            return v3Product({ detail, productKey });
          });
          const plan = await new DataReleaseV3ReleaseAssembler(
            {
              async loadCatalogSnapshot() {
                return {
                  organizationId: localPin.pin.providerId,
                  products,
                  categories: captured.categories,
                  collectibles: captured.collectibles,
                  chases: captured.chases,
                };
              },
            },
            { async getPublicationEligibleRevision() { return null; } },
          ).assemble({ readAt: new Date().toISOString() });
          if (plan.classification !== "publish") {
            return refuse(`CLUTCHPACKS_FRONTEND_RELEASE_BLOCKED_${plan.reason}`);
          }
          const v3Outcome = await new DataReleaseV3ReleasePublisher(v3Client)
            .publish(plan);
          const activeV3 = await v3Client.activeState();
          if (
            activeV3.activeRelease?.publicReleaseId !== plan.publicReleaseId
            || activeV3.activeRelease.releaseFingerprint !==
              plan.releaseFingerprint
          ) return refuse("CLUTCHPACKS_FRONTEND_RELEASE_DIVERGENT");
          const publicList = await readLocalClutchpacksV3List(
            new ConvexHttpClient(local.publicUrl),
          );
          const emittedIds = exactPublicIds(captured.repacks);
          const frontendIds = exactPublicIds(publicList.data.rows);
          if (
            JSON.stringify(emittedIds) !== JSON.stringify(frontendIds)
            || publicList.data.release.publicReleaseId !== plan.publicReleaseId
          ) return refuse("CLUTCHPACKS_FRONTEND_IDENTITY_DIVERGENT");
          evidence = {
            status: "ready",
            source: {
              kind: "protected_local_dump",
              sha256: dumpSha256,
              providerKey: "clutchpacks",
              normalizedLegacyFreshness,
              canonicalPackCount: localPin.canonicalCounts.packs,
              canonicalCollectibleCount: localPin.canonicalCounts.collectibles,
              laneSequence: lane.last_sequence.toString(),
            },
            database: {
              kind: "disposable_socket_only_postgresql_16",
              restored: true,
              migrated: true,
              cleaned: false,
            },
            worker: {
              triggerKind: invocation.triggerKind,
              outcome: invocation.outcome,
              invocationCount,
              emitted: {
                categories: captured.categories.length,
                collectibles: captured.collectibles.length,
                repacks: captured.repacks.length,
                chases: captured.chases.length,
              },
            },
            convex: {
              clientUrl: local.publicUrl,
              siteUrl,
              providerReleaseId: providerHead.receipt.details.head.release
                .publicProviderReleaseId,
              frontendDataReleaseId: plan.publicReleaseId,
              frontendDataReleaseOutcome: v3Outcome.outcome,
            },
            frontend: {
              readModel: "data_release_v3",
              sameRepackIdentitySet: true,
              repackCount: emittedIds.length,
              environment: {
                NEXT_PUBLIC_CONVEX_URL: local.publicUrl,
                PACKSCOUT_PUBLIC_IMAGE_ORIGINS:
                  approvedImageOrigins.join(","),
                PACKSCOUT_PUBLIC_ORIGIN_SET_HASH: frontendOriginSetHash,
              },
              reviewPath:
                "/packs?vendor=clutchpacks&availability=all&pageSize=50",
            },
          };
        },
      }),
    );
  } finally {
    runtime?.stop();
    providerSecret.fill(0);
    dataReleaseV3Secret.fill(0);
    await lifecycle?.close();
    await postgres.close();
    cleaned = true;
  }
  if (evidence === undefined || !cleaned) {
    return refuse("LOCAL_CLUTCHPACKS_WORKER_E2E_FAILED");
  }
  (evidence.database as { cleaned: boolean }).cleaned = true;
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
}

const isMain = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;

if (isMain) {
  try {
    parseClutchpacksWorkerE2eArguments(process.argv.slice(2));
    await runClutchpacksProviderPromotionFrontendE2e();
  } catch (error) {
    const code = error instanceof LocalClutchpacksWorkerE2eError
      ? error.code
      : "LOCAL_CLUTCHPACKS_WORKER_E2E_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "refused", code })}\n`);
    process.exitCode = 1;
  }
}
