import { createHash } from "node:crypto";
import {
  BoundedProviderDatabaseGateway,
  ProviderDatabaseDestinationPolicy,
  createCentralDatabaseLifecycle,
  locateProviderDatabase,
  providerDatabaseRouteFingerprint,
  type ProviderDatabaseRoute,
  type ProviderPrismaClient,
} from "@packscout/database";
import {
  AesGcmProviderCredentialCipher,
  CipherProviderDatabaseCredentialResolver,
} from "@packscout/services";

export interface ProviderReviewActivationDatabasePins {
  readonly organizationId: string;
  readonly providerId: string;
  readonly providerKey: string;
  readonly configVersionId: string;
  readonly providerRowVersion: bigint;
  readonly topologyVersion: bigint;
  readonly nodeId: string;
  readonly nodeRowVersion: bigint;
  readonly databaseCredentialVersionId: string;
  readonly host: "127.0.0.1";
  readonly port: number;
  readonly databaseName: string;
  readonly sslMode: "disable";
}

export interface ProviderReviewActivationDatabaseSnapshot {
  readonly providerId: string;
  readonly providerKey: string;
  readonly databaseRole: string;
  readonly schemaVersion: string;
  readonly runtimeProviderId: string;
  readonly runtimeProviderKey: string;
  readonly runtimeState: string;
  readonly activeRunCount: number;
  readonly actionableCommandCount: number;
  readonly ownedLeaseCount: number;
  readonly runCount: number;
  readonly commandCount: number;
  readonly canonicalCount: number;
  readonly quarantineCount: number;
}

export interface ProviderReviewActivationDatabaseProof {
  readonly checkKind: "pinned_provider_database_gateway";
  readonly databaseRole: "provider";
  readonly schemaVersion: "distributed-provider-v1";
  readonly runtimeState: string;
  readonly runCount: number;
  readonly commandCount: number;
  readonly canonicalCount: number;
  readonly quarantineCount: number;
  readonly idleRequired: boolean;
  readonly routeFingerprintHash: string;
  readonly checkedAt: string;
}

export class ProviderReviewActivationDatabaseProofError extends Error {
  readonly code = "ACTIVATION_DATABASE_PROOF_FAILED";

  constructor() {
    super("ACTIVATION_DATABASE_PROOF_FAILED");
    this.name = "ProviderReviewActivationDatabaseProofError";
  }
}

function refuse(): never {
  throw new ProviderReviewActivationDatabaseProofError();
}

export function assertProviderReviewActivationDatabaseRoute(
  route: Readonly<ProviderDatabaseRoute>,
  pins: Readonly<ProviderReviewActivationDatabasePins>,
): void {
  if (
    route.organizationId !== pins.organizationId ||
    route.target.providerId !== pins.providerId ||
    route.target.providerKey !== pins.providerKey ||
    route.target.databaseName !== pins.databaseName ||
    route.target.databaseRole !== "provider" ||
    route.target.schemaVersion !== "distributed-provider-v1" ||
    route.configVersionId !== pins.configVersionId ||
    route.providerRowVersion !== pins.providerRowVersion ||
    route.topologyVersion !== pins.topologyVersion ||
    route.node.nodeId !== pins.nodeId ||
    route.node.rowVersion !== pins.nodeRowVersion ||
    route.node.credentialVersionId !== pins.databaseCredentialVersionId ||
    route.node.host !== pins.host || route.node.port !== pins.port ||
    route.node.sslMode !== pins.sslMode || pins.host !== "127.0.0.1" ||
    pins.sslMode !== "disable" ||
    ![55_432, 55_433, 55_434, 55_435].includes(pins.port)
  ) {
    refuse();
  }
}

export function assertProviderReviewActivationDatabaseSnapshot(input: Readonly<{
  snapshot: Readonly<ProviderReviewActivationDatabaseSnapshot>;
  pins: Readonly<ProviderReviewActivationDatabasePins>;
  requireIdle: boolean;
}>): void {
  const { snapshot, pins } = input;
  const counts = [
    snapshot.activeRunCount, snapshot.actionableCommandCount,
    snapshot.ownedLeaseCount, snapshot.runCount, snapshot.commandCount,
    snapshot.canonicalCount, snapshot.quarantineCount,
  ];
  if (
    snapshot.providerId !== pins.providerId ||
    snapshot.runtimeProviderId !== pins.providerId ||
    snapshot.providerKey !== pins.providerKey ||
    snapshot.runtimeProviderKey !== pins.providerKey ||
    snapshot.databaseRole !== "provider" ||
    snapshot.schemaVersion !== "distributed-provider-v1" ||
    counts.some((value) => !Number.isSafeInteger(value) || value < 0) ||
    (input.requireIdle && (
      snapshot.runtimeState !== "idle" || snapshot.activeRunCount !== 0 ||
      snapshot.actionableCommandCount !== 0 || snapshot.ownedLeaseCount !== 0
    ))
  ) {
    refuse();
  }
}

async function readSnapshot(
  database: ProviderPrismaClient,
): Promise<ProviderReviewActivationDatabaseSnapshot> {
  const [identity, runtime, activeRunCount, actionableCommandCount,
    ownedLeaseCount, runCount, commandCount, categories, packs, collectibles,
    contents, contentSnapshots, pulls, pullItems, marketEvents, quarantineCount] =
    await Promise.all([
      database.database_identity.findUniqueOrThrow({
        where: { singleton_key: true },
      }),
      database.provider_runtime.findUniqueOrThrow({
        where: { singleton_key: true },
        select: {
          central_provider_id: true, provider_key: true, operating_state: true,
        },
      }),
      database.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
      database.control_commands.count({
        where: { state: { in: ["pending", "accepted"] } },
      }),
      database.provider_worker_states.count({ where: { lease_owner: { not: null } } }),
      database.provider_runs.count(),
      database.control_commands.count(),
      database.categories.count(),
      database.packs.count(),
      database.collectibles.count(),
      database.pack_contents.count(),
      database.pack_content_snapshots.count(),
      database.pulls.count(),
      database.pull_items.count(),
      database.market_events.count(),
      database.quarantine_records.count(),
    ]);
  return Object.freeze({
    providerId: identity.provider_id ?? "",
    providerKey: identity.provider_key ?? "",
    databaseRole: identity.database_role,
    schemaVersion: identity.schema_version,
    runtimeProviderId: runtime.central_provider_id,
    runtimeProviderKey: runtime.provider_key,
    runtimeState: runtime.operating_state,
    activeRunCount,
    actionableCommandCount,
    ownedLeaseCount,
    runCount,
    commandCount,
    canonicalCount: categories + packs + collectibles + contents + contentSnapshots + pulls +
      pullItems + marketEvents,
    quarantineCount,
  });
}

/** Fresh bounded gateway proof; no provider DSN or credential escapes. */
export async function runPinnedProviderReviewActivationDatabaseProof(
  input: Readonly<{
    centralDatabaseUrl: string;
    cipher: AesGcmProviderCredentialCipher;
    pins: Readonly<ProviderReviewActivationDatabasePins>;
    requireIdle: boolean;
  }>,
): Promise<Readonly<ProviderReviewActivationDatabaseProof>> {
  const central = createCentralDatabaseLifecycle({
    databaseUrl: input.centralDatabaseUrl, connectionLimit: 1,
  });
  const gateway = new BoundedProviderDatabaseGateway({
    central,
    credentialResolver: new CipherProviderDatabaseCredentialResolver(input.cipher),
    destinationPolicy: new ProviderDatabaseDestinationPolicy({
      allowedHosts: ["127.0.0.1"], allowedPorts: [input.pins.port],
      allowedSslModes: ["disable"],
    }),
    connectionLimitPerProvider: 1,
    maximumCachedProviders: 1,
    connectionTimeoutMs: 5_000,
    operationTimeoutMs: 30_000,
  });
  try {
    await central.start();
    const target = {
      organizationId: input.pins.organizationId,
      providerId: input.pins.providerId,
    };
    const before = await locateProviderDatabase(central.client, target);
    if (before.state !== "ready") refuse();
    assertProviderReviewActivationDatabaseRoute(before.route, input.pins);
    const routed = await gateway.runWithCachedProviderDatabase(
      before.route, readSnapshot,
    );
    if (routed.state !== "reachable") refuse();
    assertProviderReviewActivationDatabaseSnapshot({
      snapshot: routed.value, pins: input.pins, requireIdle: input.requireIdle,
    });
    const after = await locateProviderDatabase(central.client, target);
    if (after.state !== "ready") refuse();
    assertProviderReviewActivationDatabaseRoute(after.route, input.pins);
    const fingerprint = providerDatabaseRouteFingerprint(before.route);
    if (providerDatabaseRouteFingerprint(after.route) !== fingerprint) refuse();
    return Object.freeze({
      checkKind: "pinned_provider_database_gateway",
      databaseRole: "provider",
      schemaVersion: "distributed-provider-v1",
      runtimeState: routed.value.runtimeState,
      runCount: routed.value.runCount,
      commandCount: routed.value.commandCount,
      canonicalCount: routed.value.canonicalCount,
      quarantineCount: routed.value.quarantineCount,
      idleRequired: input.requireIdle,
      routeFingerprintHash: createHash("sha256").update(fingerprint).digest("hex"),
      checkedAt: new Date().toISOString(),
    });
  } catch {
    return refuse();
  } finally {
    await gateway.close().catch(() => undefined);
    await central.close().catch(() => undefined);
  }
}
