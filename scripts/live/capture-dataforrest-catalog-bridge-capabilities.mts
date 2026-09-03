#!/usr/bin/env node
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoundedProviderDatabaseGateway,
  createCentralDatabaseLifecycle,
  locateProviderDatabase,
  readDatabaseRuntimePolicy,
  type ProviderPrismaClient,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  CipherProviderDatabaseCredentialResolver,
} from "@packscout/services";
import {
  catalogBridgeCapabilityProofDigest,
  catalogBridgeCapabilityProofBytes,
  catalogBridgeCapabilityProofFileSha256,
  catalogBridgeCapabilityProofSchema,
  type CatalogBridgeCapabilityProof,
} from "./dataforrest-catalog-bridge-capability-proof.mts";
import {
  CatalogBridgeError,
  catalogBridgeProviderDefinitions,
  refuseCatalogBridge,
} from "./dataforrest-catalog-bridge-plan.mts";

function argumentsValue(args: readonly string[]): Readonly<{
  mode: "check_only" | "capture"; outputPath: string | null;
}> {
  if (args.length === 1 && args[0] === "--check-only") {
    return Object.freeze({ mode: "check_only", outputPath: null });
  }
  if (args.length === 3 && args[0] === "--capture" && args[1] === "--output" &&
    path.isAbsolute(args[2] ?? "") && !/[\r\n\0]/u.test(args[2] ?? "")) {
    return Object.freeze({ mode: "capture", outputPath: args[2]! });
  }
  return refuseCatalogBridge("CATALOG_BRIDGE_CAPABILITY_ARGUMENTS_INVALID");
}

function environmentValue(environment: NodeJS.ProcessEnv) {
  if (environment.NODE_ENV !== "production") {
    refuseCatalogBridge("CATALOG_BRIDGE_CAPABILITY_PRODUCTION_REQUIRED");
  }
  const databaseUrl = environment.PACKSCOUT_CENTRAL_DATABASE_URL ?? "";
  let runtimePolicy: ReturnType<typeof readDatabaseRuntimePolicy>;
  try {
    runtimePolicy = readDatabaseRuntimePolicy(environment);
    runtimePolicy.assertCentralDatabaseUrl(databaseUrl);
  } catch {
    return refuseCatalogBridge("CATALOG_BRIDGE_CAPABILITY_DATABASE_POLICY_INVALID");
  }
  if (runtimePolicy.mode !== "remote") {
    refuseCatalogBridge("CATALOG_BRIDGE_CAPABILITY_REMOTE_DATABASE_REQUIRED");
  }
  const encoded = environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64 ?? "";
  const key = Buffer.from(encoded, "base64");
  const version = Number(environment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION ?? "");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/u, "") !==
    encoded.replace(/=+$/u, "") || !Number.isSafeInteger(version) || version < 1) {
    key.fill(0);
    refuseCatalogBridge("CATALOG_BRIDGE_CAPABILITY_CREDENTIAL_POLICY_INVALID");
  }
  return Object.freeze({ databaseUrl, runtimePolicy, key, version });
}

async function providerObservation(database: ProviderPrismaClient, definition:
  typeof catalogBridgeProviderDefinitions[number]) {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await transaction.$queryRawUnsafe("select set_config('statement_timeout',$1,true)", "10000");
    const [capability, runtime, activeRuns, commands, lease, estimates] = await Promise.all([
      transaction.$queryRawUnsafe<Array<{ server_version_number: number;
        sha256_available: boolean; database_now: Date }>>(
        "select current_setting('server_version_num')::integer as server_version_number, " +
        "to_regprocedure('pg_catalog.sha256(bytea)') is not null as sha256_available, " +
        "clock_timestamp() as database_now"),
      transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true },
        select: { operating_state: true, state_generation: true, row_version: true } }),
      transaction.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
      transaction.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
      transaction.$queryRawUnsafe<Array<{ lease_owner: string | null; lease_expires_at: Date | null;
        database_now: Date }>>("select lease_owner, lease_expires_at, " +
        "clock_timestamp() as database_now from provider_worker_states " +
        "where worker_role='import'::worker_role"),
      transaction.$queryRawUnsafe<Array<{ relname: string; estimated_rows: bigint }>>(
        "select relname, greatest(reltuples,0)::bigint as estimated_rows from pg_class " +
        "where relname in ('pulls','market_events','collectibles','packs') order by relname"),
    ]);
    const feature = capability[0];
    const importLease = lease[0];
    if (!feature || !feature.sha256_available || !importLease || estimates.length !== 4) {
      refuseCatalogBridge("CATALOG_BRIDGE_CAPABILITY_PROBE_INCOMPLETE");
    }
    const estimate = new Map(estimates.map((entry) => [entry.relname, entry.estimated_rows.toString()]));
    const observedAt = feature.database_now.toISOString();
    return Object.freeze({ providerId: definition.providerId, providerKey: definition.providerKey,
      databaseName: definition.databaseName, databasePort: definition.databasePort, observedAt,
      databaseNow: observedAt, serverVersionNumber: feature.server_version_number,
      sha256ByteaAvailable: true as const, runtimeState: runtime.operating_state,
      runtimeGeneration: runtime.state_generation.toString(), runtimeRowVersion: runtime.row_version.toString(),
      activeRunCount: activeRuns, actionableCommandCount: commands,
      importLeaseOwnerPresent: importLease.lease_owner !== null,
      importLeaseLive: importLease.lease_owner !== null && importLease.lease_expires_at !== null &&
        importLease.lease_expires_at > importLease.database_now,
      estimatedRows: { collectibles: estimate.get("collectibles") ?? "0",
        packs: estimate.get("packs") ?? "0", pulls: estimate.get("pulls") ?? "0",
        marketEvents: estimate.get("market_events") ?? "0" } });
  }, { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 15_000 });
}

async function privateWrite(filePath: string, proof: CatalogBridgeCapabilityProof): Promise<void> {
  const parent = path.dirname(filePath);
  const parentDetails = await stat(parent);
  if (!parentDetails.isDirectory() || parentDetails.uid !== process.getuid?.() ||
    (parentDetails.mode & 0o077) !== 0) {
    refuseCatalogBridge("CATALOG_BRIDGE_CAPABILITY_OUTPUT_DIRECTORY_UNSAFE");
  }
  const handle = await open(filePath, constants.O_CREAT | constants.O_EXCL |
    constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(catalogBridgeCapabilityProofBytes(proof));
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(parent, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function captureCatalogBridgeCapabilities(input: Readonly<{
  args: ReturnType<typeof argumentsValue>; environment?: NodeJS.ProcessEnv;
}>): Promise<Readonly<Record<string, unknown>>> {
  const environment = environmentValue(input.environment ?? process.env);
  const centralUrl = new URL(environment.databaseUrl);
  centralUrl.searchParams.set("connect_timeout", "5");
  centralUrl.searchParams.set("pool_timeout", "5");
  const central = createCentralDatabaseLifecycle({ databaseUrl: centralUrl.toString(), connectionLimit: 1 });
  const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: environment.version,
    keys: new Map([[environment.version, environment.key]]) });
  const gateway = new BoundedProviderDatabaseGateway({ central,
    credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
    destinationPolicy: environment.runtimePolicy.destinationPolicy,
    connectionLimitPerProvider: 1, maximumCachedProviders: 1, operationProfile: "standard",
    connectionTimeoutMs: 5_000, operationTimeoutMs: 30_000, closeTimeoutMs: 5_000 });
  try {
    await central.start();
    const providers = [];
    for (const definition of catalogBridgeProviderDefinitions) {
      const located = await locateProviderDatabase(central.client, {
        organizationId: definition.organizationId, providerId: definition.providerId,
      });
      if (located.state !== "ready") refuseCatalogBridge("CATALOG_BRIDGE_CAPABILITY_ROUTE_UNAVAILABLE");
      const observed = await gateway.runWithCachedProviderDatabase(located.route,
        (database) => providerObservation(database, definition));
      if (observed.state !== "reachable") {
        refuseCatalogBridge("CATALOG_BRIDGE_CAPABILITY_PROVIDER_UNAVAILABLE");
      }
      providers.push(observed.value);
    }
    const capturedAt = new Date(Math.max(Date.now(), ...providers.map((entry) =>
      Date.parse(entry.observedAt)))).toISOString();
    const proof = catalogBridgeCapabilityProofSchema.parse({
      schemaVersion: "dataforrest_catalog_bridge_capability_proof_v1",
      capturedAt,
      authorization: "operator_requested_read_only_catalog_capability_probe",
      databaseWritesPerformed: false, sourceRequestsPerformed: false, providers,
    });
    const sha256 = catalogBridgeCapabilityProofDigest(proof);
    const fileSha256 = catalogBridgeCapabilityProofFileSha256(proof);
    if (input.args.mode === "capture") await privateWrite(input.args.outputPath!, proof);
    return Object.freeze({ outcome: input.args.mode === "capture" ? "captured" : "verified",
      mode: input.args.mode, capabilityProofDigest: sha256, capabilityProofFileSha256: fileSha256,
      providerKeys: providers.map((entry) => entry.providerKey),
      databaseWritesPerformed: false, sourceRequestsPerformed: false });
  } finally {
    try { await gateway.close(); } finally {
      try { await central.close(); } finally { environment.key.fill(0); }
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  captureCatalogBridgeCapabilities({ args: argumentsValue(process.argv.slice(2)) })
    .then((result) => process.stdout.write(JSON.stringify(result) + "\n"), (error: unknown) => {
      process.stderr.write(JSON.stringify({ outcome: "refused", code: error instanceof CatalogBridgeError
        ? error.code : "CATALOG_BRIDGE_CAPABILITY_CAPTURE_FAILED" }) + "\n");
      process.exitCode = 1;
    });
}
