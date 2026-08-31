import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoundedProviderDatabaseGateway, createCentralDatabaseLifecycle, readDatabaseReadiness, centralDatabaseTarget, type ProviderPrismaClient,
  type ProviderDatabaseOperationResult, type CentralTransactionClient } from "@packscout/database";
import { AesGcmProviderCredentialCipher, CipherProviderDatabaseCredentialResolver } from "@packscout/services";
import { readBackfillAuthority, readBackfillEnvironment, type BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";
import { runProviderHealthReadWithDrain } from "./inspect-provider-import-health.mts";
import { readRemoteHealthScope } from "./remote-provider-health-files.mts";
import { readRemoteProviderHealth } from "./remote-provider-health-read.mts";
import { runRemoteHealthTransaction } from "./remote-provider-health-transaction.mts";
import { assertRemoteHealthEnvironment, assertRemoteHealthAuthority, remoteHealthAuthorityPins, remoteHealthFailureCode,
  remoteHealthRoutePins, refuseRemoteHealth, type RemoteHealthScope, type RemoteHealthProviderPin } from "./remote-provider-health-policy.mts";

type Environment = Awaited<ReturnType<typeof readBackfillEnvironment>>;
type Observation = Awaited<ReturnType<typeof readRemoteProviderHealth>>;
type ReadResult = { ok: true; value: Observation } | { ok: false; code: string };
/** Narrow injection seam: tests need no runtime environment, database, socket or source. */
export async function inspectRemoteHealthProviders(scope: RemoteHealthScope, environment: Environment, dependencies: {
  readAuthority(pin: RemoteHealthProviderPin): Promise<BackfillAuthority>;
  run(route: BackfillAuthority["route"], callback: (db: ProviderPrismaClient) => Promise<ReadResult>): Promise<ProviderDatabaseOperationResult<ReadResult>>;
}) {
  assertRemoteHealthEnvironment(scope, environment);
  const observations = [];
  for (const pin of scope.providers) {
    try {
      const authority = await dependencies.readAuthority(pin);
      assertRemoteHealthAuthority(scope, pin, authority, environment.runtimePolicy);
      const result = await runProviderHealthReadWithDrain(async database => {
        try { return { ok: true as const, value: await readRemoteProviderHealth(database, pin, authority) }; }
        catch (error) { return { ok: false as const, code: remoteHealthFailureCode(error) }; }
      }, callback => dependencies.run(authority.route, callback));
      if (result.state !== "reachable") refuseRemoteHealth("REMOTE_HEALTH_PROVIDER_UNAVAILABLE");
      if (!result.value.ok) refuseRemoteHealth(result.value.code);
      // The observation is discarded if authority changed while the provider snapshot was read.
      const confirmed = await dependencies.readAuthority(pin);
      assertRemoteHealthAuthority(scope, pin, confirmed, environment.runtimePolicy);
      if (confirmed.digest !== authority.digest) refuseRemoteHealth("REMOTE_HEALTH_AUTHORITY_CHANGED");
      observations.push({ provider: pin.providerKey, providerId: pin.providerId, reachability: "reachable",
        authorityDigest: authority.digest, route: remoteHealthRoutePins(authority.route), ...result.value.value });
    } catch (error) {
      observations.push({ provider: pin.providerKey, providerId: pin.providerId, health: "unavailable",
        reachability: "unavailable", code: remoteHealthFailureCode(error) });
    }
  }
  return { schemaVersion: 1, observedAt: new Date().toISOString(), sourceCommit: scope.sourceCommit,
    migrationEvidenceSha256: scope.migrationEvidence.sha256, centralHost: scope.centralHost,
    organizationId: scope.organizationId, operatorId: scope.operatorId, observations,
    databaseWritesPerformed: false, sourceRequestsPerformed: false, recoveryAuthorityGranted: false };
}

export async function inspectRemoteProviderImportHealth(scopeFile: string) {
  // File permissions, reviewed migration bytes, clean code and explicit remote policy precede client creation.
  const scope = await readRemoteHealthScope(scopeFile);
  const environment = await readBackfillEnvironment();
  let central: ReturnType<typeof createCentralDatabaseLifecycle> | undefined;
  let gateway: BoundedProviderDatabaseGateway | undefined;
  try {
    assertRemoteHealthEnvironment(scope, environment);
    const url = new URL(environment.centralDatabaseUrl);
    url.searchParams.set("connect_timeout", "5"); url.searchParams.set("pool_timeout", "5");
    central = createCentralDatabaseLifecycle({ databaseUrl: url.toString(), connectionLimit: 1 });
    const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: environment.version,
      keys: new Map([[environment.version, environment.key]]) });
    gateway = new BoundedProviderDatabaseGateway({ central,
      credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher), destinationPolicy: environment.runtimePolicy.destinationPolicy,
      connectionLimitPerProvider: 1, maximumCachedProviders: 1, connectionTimeoutMs: 5000, operationTimeoutMs: 35_000 });
    const client = central.client, reader = gateway;
    return await inspectRemoteHealthProviders(scope, environment, {
      readAuthority: pin => runRemoteHealthTransaction(callback => client.$transaction(callback,
        { isolationLevel: "RepeatableRead", maxWait: 5000, timeout: 20_000 }), async (tx: CentralTransactionClient) => {
        await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '10000ms'");
        const identity = await readDatabaseReadiness({ client: tx, target: centralDatabaseTarget() });
        if (identity.state !== "ready") refuseRemoteHealth("REMOTE_HEALTH_CENTRAL_IDENTITY_INVALID");
        return readBackfillAuthority(tx, cipher, remoteHealthAuthorityPins(scope, pin), environment.runtimePolicy);
      }),
      run: (route, callback) => reader.runWithCachedProviderDatabase(route, callback),
    });
  } finally {
    // inspectRemoteHealthProviders drains timed-out gateway callbacks before this resource close.
    try { await gateway?.close(); } finally { try { await central?.close(); } finally { environment.key.fill(0); } }
  }
}
export function parseRemoteHealthArguments(args: readonly string[]) {
  if (args.length !== 2 || args[0] !== "--scope-file" || !args[1] || !path.isAbsolute(args[1])) {
    refuseRemoteHealth("REMOTE_HEALTH_ARGUMENTS_INVALID");
  }
  return args[1];
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  Promise.resolve().then(() => inspectRemoteProviderImportHealth(parseRemoteHealthArguments(process.argv.slice(2))))
    .then(result => process.stdout.write(`${JSON.stringify(result, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value)}\n`), (error: unknown) => {
      process.stderr.write(`${JSON.stringify({ health: "unavailable", code: remoteHealthFailureCode(error) })}\n`);
      process.exitCode = 1;
    });
}
