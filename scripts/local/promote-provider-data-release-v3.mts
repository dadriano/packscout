#!/usr/bin/env node
/**
 * Quick provider PostgreSQL -> Convex data_release_v3 promotion.
 *
 *   npm run promote:data-release-v3:provider:local -- \
 *     --platform phygitals --convex-deployment shiny-newt-310 [--publish]
 *
 * The public V3 catalog is one whole-release document, so promoting one
 * provider means assembling a complete release: the requested platforms are
 * read fresh from their Neon provider databases (located and decrypted through
 * the central control database), and every other vendor is carried forward
 * byte-for-byte from the deployment's currently active release (via a Convex
 * snapshot export). PackScout EV is published as an explicit unavailable
 * estimate: nothing in a provider database is a PackScout calculation.
 *
 * Without `--publish` this is a write-free dry run that validates every entity
 * against the public contracts and writes plan.json + summary.json. With
 * `--publish` the shared publisher drives start / batches / finalize /
 * activate against `https://<deployment>.convex.site` using the operator's
 * `PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_ID` and
 * `PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_SECRET_BASE64`. No credential or
 * secret value is ever printed.
 */

import { spawnSync } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { Client } from "pg";
import {
  AesGcmProviderCredentialCipher,
  DATA_RELEASE_V3_BATCH_CHAIN_HASH_DOMAIN,
  DATA_RELEASE_V3_BATCH_HASH_DOMAIN,
  DATA_RELEASE_V3_CONTENT_HASH_DOMAIN,
  DATA_RELEASE_V3_ENTITY_CHAIN_HASH_DOMAIN,
  DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
  DATA_RELEASE_V3_RELEASE_FINGERPRINT_DOMAIN,
  DATA_RELEASE_V3_RELEASE_ID_DOMAIN,
  DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION,
  DataReleaseV3PublisherError,
  DataReleaseV3ReleasePublisher,
  EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
  MAX_DATA_RELEASE_V3_BATCH_RECORDS,
  MAX_DATA_RELEASE_V3_CATEGORIES,
  MAX_DATA_RELEASE_V3_CHASES,
  MAX_DATA_RELEASE_V3_COLLECTIBLES,
  MAX_DATA_RELEASE_V3_REPACKS,
  MAX_ROWS_PER_DATA_RELEASE_V3_SHARD,
  SignedConvexDataReleaseV3PublicationClient,
  type DataReleaseV3PublishPlan,
} from "@packscout/services";
import {
  PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
  PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
  PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
  canonicalJson,
  containsProtectedEvPublicationKeyV3,
  containsProtectedPublicationField,
  decodeProductionAuthSecretBase64,
  packscoutPublicIdentityUuid,
  publicCategorySchema,
  publicCollectibleSchema,
  publicRepackChaseSchema,
  publicRepackDetailV3Schema,
  sha256CanonicalJson,
} from "@packscout/contracts";
import {
  PROMOTE_PROVIDER_USAGE,
  PromoteProviderDataReleaseV3Error,
  assembleDataReleaseV3Plan,
  boundedText,
  carryForwardActiveRelease,
  parsePromoteProviderArguments,
  parsedHttpsUrl,
  projectProviderPacks,
  publicCollectibleTypes,
  resolvePublicCategories,
  summarizePlan,
} from "./promote-provider-data-release-v3-plan.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

type Environment = Readonly<Record<string, string | undefined>>;

interface ResolvedPlatform {
  readonly platformKey: string;
  readonly providerId: string;
  readonly organizationId: string;
  readonly publicVendorId: string;
  readonly displayName: string;
  readonly logoUrl: string | null;
}

function refuse(code: string, detail: string | null = null): never {
  throw new PromoteProviderDataReleaseV3Error(code, detail);
}

function required(environment: Environment, name: string): string {
  const value = environment[name]?.trim();
  if (value === undefined || value.length === 0 || /[\r\n\0]/u.test(value)) {
    refuse("ENVIRONMENT_MISSING", name);
  }
  return value;
}

/**
 * Driver errors carry connection details (role names, hosts, the decrypted
 * provider username), so only the stable PostgreSQL error code is surfaced.
 */
function databaseFailure(code: string, detail: string, error: unknown): never {
  const driverCode =
    typeof error === "object" && error !== null && "code" in error &&
    typeof (error as { code: unknown }).code === "string"
      ? (error as { code: string }).code
      : null;
  refuse(code, driverCode === null ? detail : `${detail} (${driverCode})`);
}

/**
 * The central URL is stored with Prisma's `sslaccept=strict` parameter, which
 * the pg driver does not understand. Drop only that parameter, keeping every
 * other byte of the URL (no re-encoding of the credential).
 */
export function withoutSslAcceptParameter(rawUrl: string): string {
  const separator = rawUrl.indexOf("?");
  if (separator === -1) return rawUrl;
  const base = rawUrl.slice(0, separator);
  const kept = rawUrl
    .slice(separator + 1)
    .split("&")
    .filter((parameter) => parameter.length > 0 && !parameter.startsWith("sslaccept="));
  return kept.length === 0 ? base : `${base}?${kept.join("&")}`;
}

async function loadEnvironment(envFile: string | null): Promise<Environment> {
  const filePath = envFile ?? path.join(repositoryRoot, ".env");
  const fileValues = existsSync(filePath)
    ? dotenv.parse(await readFile(filePath, "utf8"))
    : {};
  if (envFile !== null && !existsSync(filePath)) refuse("ENV_FILE_MISSING", filePath);
  // Explicit process environment wins over the file so an operator can
  // override one value without editing the file.
  return { ...fileValues, ...process.env };
}

// ---------------------------------------------------------------------------
// Central control database: locate the provider database and decrypt its
// credential (read-only, credential values never leave this process).
// ---------------------------------------------------------------------------

interface ProviderDatabaseAccess {
  readonly platform: ResolvedPlatform;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly username: string;
  readonly password: string;
}

async function locateProviderDatabases(
  environment: Environment,
  platformKeys: readonly string[],
  vendorIdentity: (platformKey: string) => string,
): Promise<ProviderDatabaseAccess[]> {
  const keyVersion = Number(
    environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION?.trim() || "1",
  );
  if (!Number.isInteger(keyVersion) || keyVersion < 1) {
    refuse("CREDENTIAL_KEY_VERSION_INVALID");
  }
  const keyBytes = Buffer.from(
    required(environment, "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64"),
    "base64",
  );
  if (keyBytes.byteLength !== 32) refuse("CREDENTIAL_KEY_INVALID");
  const cipher = new AesGcmProviderCredentialCipher({
    primaryVersion: keyVersion,
    keys: new Map([[keyVersion, new Uint8Array(keyBytes)]]),
  });
  const central = new Client({
    connectionString: withoutSslAcceptParameter(
      required(environment, "PACKSCOUT_CENTRAL_DATABASE_URL"),
    ),
    application_name: "packscout-promote-provider-data-release-v3",
  });
  try {
    await central.connect();
  } catch (error) {
    databaseFailure("CENTRAL_DATABASE_UNAVAILABLE", "connect", error);
  }
  const results: ProviderDatabaseAccess[] = [];
  try {
    await central.query("set default_transaction_read_only = on").catch((error: unknown) =>
      databaseFailure("CENTRAL_DATABASE_UNAVAILABLE", "read-only session", error),
    );
    for (const platformKey of platformKeys) {
      const { rows } = await central.query(
        `select p.id as provider_id, p.organization_id, p.lifecycle as provider_lifecycle,
                p.display_name as provider_display_name,
                n.host, n.port, n.database_name,
                c.id as credential_version_id, c.ciphertext, c.nonce, c.auth_tag,
                c.key_version, c.lifecycle as credential_lifecycle,
                profile.display_name as profile_display_name, profile.logo_url
           from providers p
           join provider_database_nodes n
             on n.provider_id = p.id and n.enabled and n.node_role = 'primary'
           join provider_credential_versions c on c.id = n.credential_version_id
           left join lateral (
             select v.display_name, v.logo_url
               from provider_public_profile_versions v
              where v.provider_id = p.id
              order by v.version_number desc
              limit 1
           ) profile on true
          where p.provider_key = $1`,
        [platformKey],
      ).catch((error: unknown) =>
        databaseFailure("CENTRAL_DATABASE_UNAVAILABLE", `provider lookup ${platformKey}`, error),
      );
      if (rows.length !== 1) {
        refuse("PROVIDER_DATABASE_NODE_NOT_FOUND", `${platformKey} (${rows.length} rows)`);
      }
      const row = rows[0];
      if (row.provider_lifecycle !== "active") {
        refuse("PROVIDER_NOT_ACTIVE", `${platformKey} is ${row.provider_lifecycle}`);
      }
      if (row.credential_lifecycle !== "active") {
        refuse("PROVIDER_CREDENTIAL_NOT_ACTIVE", platformKey);
      }
      let credential: { username: string; password: string };
      try {
        credential = JSON.parse(
          cipher.decrypt(
            {
              ciphertext: new Uint8Array(row.ciphertext),
              nonce: new Uint8Array(row.nonce),
              authTag: new Uint8Array(row.auth_tag),
              keyVersion: Number(row.key_version),
            },
            {
              organizationId: row.organization_id,
              providerId: row.provider_id,
              revisionId: row.credential_version_id,
            },
          ),
        );
      } catch {
        refuse("PROVIDER_CREDENTIAL_UNREADABLE", platformKey);
      }
      if (
        typeof credential.username !== "string" ||
        typeof credential.password !== "string"
      ) {
        refuse("PROVIDER_CREDENTIAL_INVALID", platformKey);
      }
      const displayName =
        boundedText(row.profile_display_name, 100) ??
        boundedText(row.provider_display_name, 100) ??
        platformKey;
      const logoUrl =
        typeof row.logo_url === "string" && parsedHttpsUrl(row.logo_url) !== null
          ? row.logo_url
          : null;
      results.push({
        platform: {
          platformKey,
          providerId: row.provider_id,
          organizationId: row.organization_id,
          publicVendorId: vendorIdentity(platformKey),
          displayName,
          logoUrl,
        },
        host: row.host,
        port: Number(row.port),
        database: row.database_name,
        username: credential.username,
        password: credential.password,
      });
    }
  } finally {
    await central.end();
  }
  return results;
}

interface ProviderSnapshot {
  readonly platform: ResolvedPlatform;
  readonly packs: readonly Record<string, unknown>[];
  readonly categories: readonly Record<string, unknown>[];
  readonly collectibleTypes: readonly string[];
}

async function readProviderSnapshot(
  access: ProviderDatabaseAccess,
): Promise<ProviderSnapshot> {
  const platformKey = access.platform.platformKey;
  const client = new Client({
    host: access.host,
    port: access.port,
    database: access.database,
    user: access.username,
    password: access.password,
    ssl: { rejectUnauthorized: true },
    application_name: "packscout-promote-provider-data-release-v3",
  });
  try {
    await client.connect();
  } catch (error) {
    databaseFailure("PROVIDER_DATABASE_UNAVAILABLE", `${platformKey} connect`, error);
  }
  try {
    await client.query("set default_transaction_read_only = on").catch((error: unknown) =>
      databaseFailure("PROVIDER_DATABASE_UNAVAILABLE", `${platformKey} read-only session`, error),
    );
    const packs = await client.query(
      `select id, pack_key, display_name, description, pack_format, availability,
              content_evidence, lifecycle, category_id,
              price_amount::text, price_currency, price_usd_amount::text,
              buyback_rate::text, vendor_ev_amount::text, vendor_ev_currency,
              vendor_ev_observed_at, primary_image_url, primary_image_alt,
              listing_url, source_updated_at
         from packs
        where lifecycle = 'active'
        order by pack_key`,
    ).catch((error: unknown) =>
      databaseFailure("PROVIDER_DATABASE_UNAVAILABLE", `${platformKey} packs`, error),
    );
    const categories = await client.query(
      `select id, category_key, display_name, parent_category_id
         from categories
        where lifecycle = 'active'
        order by category_key`,
    ).catch((error: unknown) =>
      databaseFailure("PROVIDER_DATABASE_UNAVAILABLE", `${platformKey} categories`, error),
    );
    const types = await client.query(
      `select distinct collectible_type from collectibles where lifecycle = 'active'`,
    ).catch((error: unknown) =>
      databaseFailure("PROVIDER_DATABASE_UNAVAILABLE", `${platformKey} collectible types`, error),
    );
    return {
      platform: access.platform,
      packs: packs.rows,
      categories: categories.rows,
      collectibleTypes: types.rows.map((row) => String(row.collectible_type)),
    };
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Convex snapshot export: the active release's entities, carried forward.
// ---------------------------------------------------------------------------

async function readJsonlDocuments(
  filePath: string,
  keep: (document: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>[]> {
  if (!existsSync(filePath)) refuse("EXPORT_TABLE_MISSING", filePath);
  const documents: Record<string, unknown>[] = [];
  const lines = createInterface({
    input: createReadStream(filePath, "utf8"),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  for await (const line of lines) {
    if (line.trim().length === 0) continue;
    const document = JSON.parse(line) as Record<string, unknown>;
    if (keep(document)) documents.push(document);
  }
  return documents;
}

const CARRIED_EXPORT_TABLES = [
  "activeDataReleaseV3State",
  "dataReleaseV3Categories",
  "dataReleaseV3Collectibles",
  "dataReleaseV3Repacks",
  "dataReleaseV3Chases",
] as const;

/**
 * A snapshot export contains every table of the deployment, including user
 * and allowlist records. Only the five release tables are ever extracted, the
 * zip is deleted as soon as they are out, and a script-downloaded extraction
 * is removed again once the carried release is in memory.
 */
async function obtainExportDirectory(
  options: { exportDir: string | null; convexDeployment: string | null },
  outDir: string,
  stamp: string,
): Promise<{ directory: string; ephemeral: boolean }> {
  if (options.exportDir !== null) {
    const directory = path.resolve(options.exportDir);
    if (!existsSync(path.join(directory, "activeDataReleaseV3State", "documents.jsonl"))) {
      refuse("EXPORT_DIR_INVALID", directory);
    }
    return { directory, ephemeral: false };
  }
  if (options.convexDeployment === null) refuse("CONVEX_DEPLOYMENT_REQUIRED");
  const zipPath = path.join(outDir, `convex-export-${stamp}.zip`);
  const directory = path.join(outDir, `convex-export-${stamp}`);
  console.log(`Downloading a snapshot export of ${options.convexDeployment} ...`);
  try {
    const exported = spawnSync(
      "npx",
      [
        "convex",
        "export",
        "--deployment-name",
        options.convexDeployment,
        "--path",
        zipPath,
      ],
      { cwd: repositoryRoot, stdio: "inherit" },
    );
    if (exported.status !== 0) refuse("CONVEX_EXPORT_FAILED");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const unzipped = spawnSync(
      "unzip",
      [
        "-q",
        "-o",
        zipPath,
        ...CARRIED_EXPORT_TABLES.map((table) => `${table}/*`),
        "-d",
        directory,
      ],
      { stdio: "inherit" },
    );
    if (unzipped.status !== 0) refuse("CONVEX_EXPORT_UNZIP_FAILED");
  } finally {
    await rm(zipPath, { force: true });
  }
  return { directory, ephemeral: true };
}

async function loadCarriedRelease(
  exportDirectory: string,
  promotedVendorKeys: readonly string[],
) {
  const table = (name: string) => path.join(exportDirectory, name, "documents.jsonl");
  const activeStateDocuments = await readJsonlDocuments(
    table("activeDataReleaseV3State"),
    () => true,
  );
  const state = activeStateDocuments.find((document) => document.key === "singleton");
  const activeReleaseId = state?.activeReleaseId ?? null;
  if (typeof activeReleaseId !== "string") {
    refuse("ACTIVE_RELEASE_MISSING", "the export has no active data_release_v3");
  }
  const forActiveRelease = (document: Record<string, unknown>) =>
    document.releaseId === activeReleaseId;
  return carryForwardActiveRelease({
    activeStateDocuments,
    categoryDocuments: await readJsonlDocuments(table("dataReleaseV3Categories"), forActiveRelease),
    collectibleDocuments: await readJsonlDocuments(table("dataReleaseV3Collectibles"), forActiveRelease),
    repackDocuments: await readJsonlDocuments(table("dataReleaseV3Repacks"), forActiveRelease),
    chaseDocuments: await readJsonlDocuments(table("dataReleaseV3Chases"), forActiveRelease),
    promotedVendorKeys,
  });
}

// ---------------------------------------------------------------------------
// Contract validation: every emitted entity must parse under the public
// schemas and re-serialize canonically, or nothing is sent.
// ---------------------------------------------------------------------------

function validatePlanEntities(plan: DataReleaseV3PublishPlan): void {
  const schemaFor = {
    categories: publicCategorySchema,
    collectibles: publicCollectibleSchema,
    repacks: publicRepackDetailV3Schema,
    chases: publicRepackChaseSchema,
  } as const;
  for (const batch of plan.batches) {
    const schema = schemaFor[batch.kind];
    for (const record of batch.records) {
      const parsed = schema.safeParse(record);
      const label = `${batch.kind} ${JSON.stringify(
        (record as { publicRepackId?: string; publicCategoryId?: string; publicCollectibleId?: string })
          .publicRepackId ??
          (record as { publicCategoryId?: string }).publicCategoryId ??
          (record as { publicCollectibleId?: string }).publicCollectibleId,
      )}`;
      if (!parsed.success) {
        refuse(
          "ENTITY_CONTRACT_INVALID",
          `${label}: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")} ${issue.message}`)
            .join("; ")}`,
        );
      }
      if (canonicalJson(parsed.data) !== canonicalJson(record)) {
        refuse("ENTITY_NOT_CANONICAL", label);
      }
    }
    if (
      containsProtectedEvPublicationKeyV3(batch.records) ||
      containsProtectedPublicationField(batch.records)
    ) {
      refuse("PROTECTED_PUBLICATION_FIELD", `${batch.kind} batch ${batch.batchIndex}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const options = parsePromoteProviderArguments(process.argv.slice(2));
  if (options.help) {
    console.log(PROMOTE_PROVIDER_USAGE);
    return;
  }
  const environment = await loadEnvironment(options.envFile);
  const stamp = new Date().toISOString().replace(/[-:.]/gu, "").replace("T", "-").slice(0, 15);
  const outDir = path.resolve(
    options.outDir ??
      path.join(
        os.tmpdir(),
        "packscout-promote-provider-data-release-v3",
        options.platformKeys.join("+"),
      ),
  );
  await mkdir(outDir, { recursive: true, mode: 0o700 });

  // 1. Carry forward the active release (unless replacing the catalog).
  let carried: Awaited<ReturnType<typeof loadCarriedRelease>> | null = null;
  if (!options.replaceCatalog) {
    const exportDirectory = await obtainExportDirectory(options, outDir, stamp);
    try {
      carried = await loadCarriedRelease(exportDirectory.directory, options.platformKeys);
    } finally {
      if (exportDirectory.ephemeral) {
        await rm(exportDirectory.directory, { recursive: true, force: true });
      }
    }
    console.log(
      `Carrying forward active release ${carried.activePublicReleaseId}: ` +
        `${carried.repacks.length} repacks, ${carried.categories.length} categories, ` +
        `${carried.collectibles.length} collectibles, ${carried.chases.length} chases ` +
        `(${carried.droppedRepackCount} repacks of the promoted vendors replaced).`,
    );
  }

  // 2. Read the promoted providers from their Neon databases.
  const vendorIdentity = (platformKey: string) =>
    carried?.vendors.get(platformKey) ??
    packscoutPublicIdentityUuid(`vendor:${platformKey}`);
  const accesses = await locateProviderDatabases(
    environment,
    options.platformKeys,
    vendorIdentity,
  );
  const snapshots: ProviderSnapshot[] = [];
  for (const access of accesses) {
    const snapshot = await readProviderSnapshot(access);
    console.log(
      `${access.platform.platformKey}: ${snapshot.packs.length} active packs, ` +
        `${snapshot.categories.length} categories, collectible types ${JSON.stringify(
          snapshot.collectibleTypes,
        )}.`,
    );
    snapshots.push(snapshot);
  }

  // The release read clock is stamped only after every source read, so no
  // carried or freshly read record can post-date dataAsOf (Convex refuses
  // such a release at finalize; the assembler proves it before staging).
  const readAt = new Date().toISOString();

  // 3. Project provider rows into public entities on the carried taxonomy.
  const versions = {
    methodVersion: PACKSCOUT_BUYBACK_EV_METHOD_VERSION,
    confidencePolicyVersion: PACKSCOUT_BUYBACK_EV_CONFIDENCE_POLICY_VERSION,
    publicEvPolicyVersion: PACKSCOUT_PUBLIC_EV_POLICY_VERSION_V3,
    schemaVersion: DATA_RELEASE_V3_PUBLICATION_SCHEMA_VERSION,
    searchAlgorithmVersion: DATA_RELEASE_V3_SEARCH_ALGORITHM_VERSION,
  };
  const identity = (name: string) => packscoutPublicIdentityUuid(name);
  const resolved = resolvePublicCategories({
    providerCategories: snapshots.flatMap((snapshot) => snapshot.categories),
    carriedCategories: carried?.categories ?? [],
    identity,
  });
  const repacks = [...(carried?.repacks ?? [])];
  const skipped: unknown[] = [];
  for (const snapshot of snapshots) {
    const projected = projectProviderPacks({
      platform: snapshot.platform,
      packs: snapshot.packs,
      chainByProviderCategoryId: resolved.chainByProviderCategoryId,
      collectibleTypes: publicCollectibleTypes(snapshot.collectibleTypes),
      readAt,
      versions,
      identity,
      includePriceless: options.includePriceless,
    });
    repacks.push(...projected.repacks);
    skipped.push(
      ...projected.skipped.map((entry: { packKey: string; reason: string }) => ({
        platformKey: snapshot.platform.platformKey,
        ...entry,
      })),
    );
  }
  if (repacks.length === 0) refuse("NO_REPACKS", "nothing to publish");

  // 4. Assemble and validate the whole release.
  const plan = (await assembleDataReleaseV3Plan(
    {
      readAt,
      categories: resolved.categories,
      collectibles: carried?.collectibles ?? [],
      repacks,
      chases: carried?.chases ?? [],
    },
    {
      sha256CanonicalJson,
      canonicalJson,
      domains: {
        batch: DATA_RELEASE_V3_BATCH_HASH_DOMAIN,
        batchChain: DATA_RELEASE_V3_BATCH_CHAIN_HASH_DOMAIN,
        entityChain: DATA_RELEASE_V3_ENTITY_CHAIN_HASH_DOMAIN,
        content: DATA_RELEASE_V3_CONTENT_HASH_DOMAIN,
        releaseId: DATA_RELEASE_V3_RELEASE_ID_DOMAIN,
        fingerprint: DATA_RELEASE_V3_RELEASE_FINGERPRINT_DOMAIN,
      },
      versions,
      limits: {
        batchRecords: MAX_DATA_RELEASE_V3_BATCH_RECORDS,
        repackBatchRecords: MAX_ROWS_PER_DATA_RELEASE_V3_SHARD,
        repacks: MAX_DATA_RELEASE_V3_REPACKS,
        categories: MAX_DATA_RELEASE_V3_CATEGORIES,
        collectibles: MAX_DATA_RELEASE_V3_COLLECTIBLES,
        chases: MAX_DATA_RELEASE_V3_CHASES,
      },
      emptyChainHash: EMPTY_DATA_RELEASE_V3_CHAIN_HASH,
    },
  )) as DataReleaseV3PublishPlan;
  validatePlanEntities(plan);

  const summary = summarizePlan(plan, {
    vendors: Object.fromEntries(
      [
        ...(carried?.vendors ?? new Map<string, string>()),
        ...snapshots.map(
          (snapshot) =>
            [snapshot.platform.platformKey, snapshot.platform.publicVendorId] as const,
        ),
      ].sort(),
    ),
    skipped,
    minted: resolved.minted,
    carried:
      carried === null
        ? null
        : {
            activePublicReleaseId: carried.activePublicReleaseId,
            activeReleaseFingerprint: carried.activeReleaseFingerprint,
            activeDataAsOf: carried.activeDataAsOf,
            droppedRepackCount: carried.droppedRepackCount,
          },
    promotedVendorKeys: options.platformKeys,
  });
  await writeFile(path.join(outDir, "plan.json"), JSON.stringify(plan), "utf8");
  await writeFile(
    path.join(outDir, "summary.json"),
    JSON.stringify(summary, null, 2),
    "utf8",
  );
  console.log(JSON.stringify(summary, null, 2));
  for (const warning of summary.warnings as string[]) console.warn(`WARNING: ${warning}`);
  console.log(`Plan written to ${outDir}`);

  if (!options.publish) {
    console.log("Dry run only. Re-run with --publish to stage, finalize, and activate.");
    return;
  }

  // 5. Publish through the shared signed lifecycle.
  const deployment = options.convexDeployment;
  if (deployment === null) refuse("CONVEX_DEPLOYMENT_REQUIRED");
  const keyId = required(environment, "PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_KEY_ID");
  const secret = decodeProductionAuthSecretBase64(
    required(environment, "PACKSCOUT_DATA_RELEASE_V3_PUBLICATION_SECRET_BASE64"),
  );
  if (secret === null) refuse("PUBLICATION_SECRET_INVALID");
  const client = new SignedConvexDataReleaseV3PublicationClient({
    baseUrl: `https://${deployment}.convex.site`,
    keyId,
    secret,
  });
  const state = await client.activeState();
  const livePublicReleaseId = state.activeRelease?.publicReleaseId ?? null;
  if (carried !== null && livePublicReleaseId !== carried.activePublicReleaseId) {
    refuse(
      "ACTIVE_RELEASE_DRIFT",
      `the deployment now serves ${livePublicReleaseId ?? "no release"} but the ` +
        `export carried ${carried.activePublicReleaseId}; re-run without --export-dir`,
    );
  }
  console.log(
    `Publishing ${plan.publicReleaseId} to ${deployment} ` +
      `(replacing ${livePublicReleaseId ?? "genesis"}) ...`,
  );
  const outcome = await new DataReleaseV3ReleasePublisher(client).publish(plan);
  await writeFile(
    path.join(outDir, "publish-outcome.json"),
    JSON.stringify(outcome, null, 2),
    "utf8",
  );
  if (outcome.outcome === "unchanged") {
    console.log(`Already active: ${outcome.publicReleaseId}. Nothing changed.`);
    return;
  }
  console.log(
    `Activated ${outcome.publicReleaseId} (generation ${outcome.generation}, ` +
      `previous ${outcome.previousPublicReleaseId ?? "none"}).`,
  );
  // The publisher re-reads the active pointer right before activation. If
  // someone activated another release between the drift check and that read,
  // the carried entities were stale; say so loudly instead of exiting clean.
  if (carried !== null && outcome.previousPublicReleaseId !== carried.activePublicReleaseId) {
    refuse(
      "PREDECESSOR_CHANGED_DURING_PUBLISH",
      `activated over ${outcome.previousPublicReleaseId ?? "none"} but the carried vendors ` +
        `came from ${carried.activePublicReleaseId}; re-run this script now so the other ` +
        `vendors are re-carried from the release that was replaced`,
    );
  }
}

main().catch((error: unknown) => {
  if (error instanceof PromoteProviderDataReleaseV3Error) {
    console.error(`promote-provider-data-release-v3: ${error.message}`);
    if (error.code === "PLATFORM_REQUIRED" || error.code === "ARGUMENT_UNKNOWN") {
      console.error(PROMOTE_PROVIDER_USAGE);
    }
  } else if (error instanceof DataReleaseV3PublisherError) {
    console.error(
      `promote-provider-data-release-v3: publish failed at ${error.stage} (${error.code}): ${error.message}`,
    );
  } else {
    // Unknown failures are reported by class and code only: driver and HTTP
    // errors can embed hosts, role names, or request details in their text.
    const named = error instanceof Error ? error : null;
    const code =
      named !== null && "code" in named && typeof named.code === "string" ? ` ${named.code}` : "";
    console.error(
      `promote-provider-data-release-v3: PROMOTION_FAILED ${named?.name ?? typeof error}${code}`,
    );
  }
  process.exitCode = 1;
});
