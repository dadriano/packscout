#!/usr/bin/env node
import { open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { packMembershipSnapshotV1 } from "@packscout/contracts";
import { BoundedProviderDatabaseGateway, ProviderDatabaseDestinationPolicy, PrismaProviderWorkerLeaseRepository,
  createCentralDatabaseLifecycle, type ProviderPrismaClient } from "@packscout/database";
import { AesGcmProviderCredentialCipher, CipherProviderDatabaseCredentialResolver,
  captureClutchpacksPublicPackMembershipV1 } from "@packscout/services";
import { readBackfillAuthority, readLocalBackfillEnvironment } from "./provider-backfill-supervisor-authority.mts";
import { packContentBackfillDigest, packContentBackfillManifestSchema, MAX_PACK_CONTENT_BACKFILL_BYTES,
  type PackContentBackfillManifest } from "./pack-content-backfill-contract.mts";
import { applyPackContentBackfill, readPackContentBackfillBoundary, assertPackContentBackfillBoundary } from "./pack-content-backfill-persistence.mts";
import { acquirePackContentBackfillLease } from "./pack-content-backfill-lease.mts";
import { readPackContentBackfillProgress } from "./pack-content-backfill-progress.mts";

function refuse(code: string): never { throw new Error(`CLUTCHPACKS_CHASE_${code}`); }
export function parseChaseBackfillArguments(args: readonly string[]) {
  const mode = args[0];
  if (!["--capture", "--check-only", "--apply"].includes(mode ?? "")) refuse("ARGUMENTS_INVALID");
  const values = new Map<string, string>();
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index]!; const value = args[index + 1];
    if (!["--manifest", "--digest", "--operation-id", "--operator-id"].includes(key) || !value || values.has(key)) refuse("ARGUMENTS_INVALID");
    values.set(key, value);
  }
  const manifestPath = values.get("--manifest");
  if (!manifestPath || !path.isAbsolute(manifestPath)) refuse("ABSOLUTE_MANIFEST_REQUIRED");
  if (mode === "--capture") {
    const operationId = z.uuid().parse(values.get("--operation-id"));
    const operatorId = z.uuid().parse(values.get("--operator-id"));
    if (values.size !== 3) refuse("ARGUMENTS_INVALID");
    return { mode: "--capture" as const, manifestPath, operationId, operatorId };
  }
  const digest = values.get("--digest");
  if (values.size !== 2 || !digest || !/^[a-f0-9]{64}$/u.test(digest)) refuse("MANIFEST_DIGEST_REQUIRED");
  return { mode: mode as "--check-only" | "--apply", manifestPath, digest };
}

export async function readPackContentBackfillManifest(manifestPath: string, digest: string): Promise<PackContentBackfillManifest> {
  const file = await open(manifestPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  const buffer = Buffer.alloc(MAX_PACK_CONTENT_BACKFILL_BYTES + 1);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_PACK_CONTENT_BACKFILL_BYTES || stat.size < 1) refuse("MANIFEST_INVALID");
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await file.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (chunk.bytesRead === 0) break;
      bytesRead += chunk.bytesRead;
    }
    if (bytesRead > MAX_PACK_CONTENT_BACKFILL_BYTES) refuse("MANIFEST_INVALID");
    const manifest = packContentBackfillManifestSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead))));
    if (packContentBackfillDigest(manifest) !== digest) refuse("MANIFEST_DIGEST_MISMATCH");
    return manifest;
  } finally { buffer.fill(0); await file.close(); }
}

/** This exclusive port claim is held throughout writes; the normal resident
 * must be cleanly stopped by its owner before the backfill can acquire it. */
async function reserveLocalWriter() {
  const server = net.createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", () => reject(new Error("CLUTCHPACKS_CHASE_RESIDENT_STILL_OWNED")));
    server.listen({ host: "127.0.0.1", port: 56432, exclusive: true }, resolve);
  });
  return () => new Promise<void>(resolve => server.close(() => resolve()));
}

export async function runChaseBackfill(args: ReturnType<typeof parseChaseBackfillArguments>, environment = process.env) {
  const config = await readLocalBackfillEnvironment(environment);
  const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: config.version, keys: new Map([[config.version, config.key]]) });
  const central = createCentralDatabaseLifecycle({ databaseUrl: config.centralDatabaseUrl, connectionLimit: 2 });
  const gateway = new BoundedProviderDatabaseGateway({ central,
    credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
    destinationPolicy: new ProviderDatabaseDestinationPolicy({ allowedHosts: ["127.0.0.1"], allowedPorts: [55432], allowedSslModes: ["disable"] }),
    connectionLimitPerProvider: 2, maximumCachedProviders: 1, operationTimeoutMs: 60000 });
  try {
    await central.start();
    let manifest = args.mode === "--capture" ? null : await readPackContentBackfillManifest(args.manifestPath, args.digest);
    const provider = await central.client.providers.findUnique({ where: { provider_key: "clutchpacks" },
      select: { id: true, organization_id: true, active_config_version_id: true } });
    if (!provider?.active_config_version_id) refuse("PROVIDER_UNAVAILABLE");
    const run = async <T,>(operation: (db: ProviderPrismaClient) => Promise<T>): Promise<T> => {
      let pending: Promise<T> | null = null;
      const result = await gateway.runWithProviderDatabase({ organizationId: provider.organization_id, providerId: provider.id }, db => {
        pending = operation(db); return pending;
      });
      // A gateway deadline is not proof that its transaction has settled.
      if (pending !== null) await pending;
      if (result.state !== "reachable") return refuse("DATABASE_UNAVAILABLE");
      return result.value;
    };
    const boundary = await run(db => db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return readPackContentBackfillBoundary(tx);
    }, { isolationLevel: "RepeatableRead", timeout: 15000 }));
    const pins = { providerKey: "clutchpacks" as const, providerId: provider.id, organizationId: provider.organization_id,
      configId: provider.active_config_version_id, initialRunId: manifest?.sourceHeadRunId ?? boundary.sourceHeadRunId,
      operationId: manifest?.operationId ?? (args.mode === "--capture" ? args.operationId : ""),
      operatorId: manifest?.operatorId ?? (args.mode === "--capture" ? args.operatorId : "") };
    const authority = await readBackfillAuthority(central.client, cipher, pins);
    if (manifest && (manifest.providerId !== pins.providerId || manifest.organizationId !== pins.organizationId ||
      manifest.configVersionId !== pins.configId || manifest.configVersionNumber !== authority.configNumber.toString())) refuse("MANIFEST_AUTHORITY_MISMATCH");
    const revalidateAuthority = async () => {
      if ((await readBackfillAuthority(central.client, cipher, pins)).digest !== authority.digest) refuse("AUTHORITY_CHANGED");
    };
    if (args.mode === "--capture") {
      const packs = await run(db => db.packs.findMany({ where: { lifecycle: "active" }, orderBy: { pack_key: "asc" },
        select: { pack_key: true }, take: 101 }));
      if (packs.length < 1 || packs.length > 100 || packs.some(row => !/^pack:[0-9a-f-]{36}$/u.test(row.pack_key))) refuse("PACK_SCOPE_INVALID");
      const captured = await captureClutchpacksPublicPackMembershipV1({ nativePackIds: packs.map(row => row.pack_key.slice(5)), signal: AbortSignal.timeout(120000) });
      manifest = packContentBackfillManifestSchema.parse({ schemaVersion: "provider_pack_content_backfill_manifest_v1", ...boundary,
        operationId: args.operationId, organizationId: pins.organizationId, operatorId: args.operatorId,
        capturedAt: new Date().toISOString(), snapshots: captured.map(row => packMembershipSnapshotV1({
          providerId: provider.id, providerRecordId: row.providerRecordId, sourceAdapterVersion: row.sourceAdapterVersion,
          mapperVersion: "pack-membership-snapshot-mapper-v1", effectiveAt: row.observedAt,
          effectiveAtBasis: row.timeBasis, collectedAt: row.observedAt, membership: row.membership,
        })), responseHashes: captured.map(row => ({ packKey: `pack:${row.providerRecordId}`, sha256: row.responseSha256 })) });
      await revalidateAuthority();
      if (packContentBackfillDigest(await run(readPackContentBackfillBoundary)) !== packContentBackfillDigest(boundary)) refuse("CAPTURE_BOUNDARY_CHANGED");
      const serialized = `${JSON.stringify(manifest)}\n`;
      if (Buffer.byteLength(serialized, "utf8") > MAX_PACK_CONTENT_BACKFILL_BYTES) refuse("MANIFEST_INVALID");
      const file = await open(args.manifestPath, "wx", 0o600);
      try { await file.writeFile(serialized); } finally { await file.close(); }
    }
    if (!manifest) return refuse("MANIFEST_INVALID");
    const prepared = manifest;
    assertPackContentBackfillBoundary(prepared, boundary);
    await run(db => db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return readPackContentBackfillProgress(tx, prepared);
    }, { isolationLevel: "RepeatableRead", timeout: 15000 }));
    const coverage = await run(async db => {
      const keys = [...new Set(prepared.snapshots.flatMap(row => row.items.map(item => item.collectibleKey)))];
      const cards = await db.collectibles.count({ where: { collectible_key: { in: keys }, lifecycle: "active" } });
      if (cards !== keys.length) refuse("UNRESOLVED_CARD_IDENTITIES");
      return { packs: prepared.snapshots.length, memberships: prepared.snapshots.reduce((count, row) => count + row.items.length, 0),
        cards, partialPacks: prepared.snapshots.filter(row => row.completeness === "partial").length };
    });
    if (args.mode !== "--apply") return { mode: args.mode, ...coverage, digest: packContentBackfillDigest(prepared) };
    const releaseResidency = await reserveLocalWriter();
    try {
      const result = await run(async db => {
        const leases = new PrismaProviderWorkerLeaseRepository(db);
        const lease = await acquirePackContentBackfillLease({ database: db, manifest: prepared, revalidateAuthority }, leases);
        try { return await applyPackContentBackfill({ database: db, manifest: prepared, lease, revalidateAuthority }); }
        finally { await leases.release(lease); }
      });
      return { mode: args.mode, ...coverage, digest: packContentBackfillDigest(prepared),
        replayed: result.replayed, settledSequence: result.receipt.lastPromotionSequence };
    } finally { await releaseResidency(); }
  } finally { await gateway.close(); await central.close(); config.key.fill(0); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => runChaseBackfill(parseChaseBackfillArguments(process.argv.slice(2)))).then(
    result => process.stdout.write(`${JSON.stringify(result)}\n`),
    () => { process.stderr.write("CLUTCHPACKS_CHASE_BACKFILL_REFUSED\n"); process.exitCode = 1; });
}
