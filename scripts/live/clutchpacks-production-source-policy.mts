import { createHash } from "node:crypto";
import { canonicalJson, publicHttpsOriginSchema, dataforrestClutchpacksDistributedSourceAdapterManifest } from "@packscout/contracts";
import { assertDatabaseUuid, locateProviderDatabase, readDatabaseReadiness, centralDatabaseTarget,
  type CentralTransactionClient, type ProviderDatabaseCredentialResolver } from "@packscout/database";
export { runDrainedDatabaseTransaction as drainSourceOperation } from "@packscout/database";

export class ClutchpacksProductionSourceError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ClutchpacksProductionSourceError"; }
}
export function refuseSource(code: string): never { throw new ClutchpacksProductionSourceError(code); }
export function sourceWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item));
}
/** Matches the maintenance full-route digest, including revisions and encrypted credential bytes. */
export function sourceDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(sourceWire(value))).digest("hex");
}
export interface ClutchpacksProductionSourceOptions {
  readonly centralDatabaseUrl: string;
  readonly centralHost: string;
  readonly providerHost: string;
  /** Caller owns credentials, their lifetime and secret disposal. This module never loads environment files. */
  readonly credentialResolver: ProviderDatabaseCredentialResolver;
  readonly scope: {
    readonly organizationId: string; readonly providerId: string; readonly providerKey: "clutchpacks";
    readonly operatorId: string; readonly configVersionId: string; readonly configVersionNumber: bigint;
  };
  readonly expected: {
    readonly routeDigest: string; readonly latestSucceededRunId: string; readonly checkpointHash: string;
    readonly stateGeneration: bigint; readonly runtimeRowVersion: bigint;
  };
  readonly approvedPublicAssetOrigins: readonly string[];
}
const hash = /^[a-f0-9]{64}$/u;
function neonHost(value: string) {
  return value.length <= 253 && /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.neon\.tech$/u.test(value);
}
/** Explicit native verified TLS only; no libpq/native-mode downgrade, duplicate parameters or alternate destination. */
export function validateProductionSourceOptions(input: ClutchpacksProductionSourceOptions): string {
  try {
    const p = input.scope, e = input.expected;
    for (const id of [p.organizationId, p.providerId, p.operatorId, p.configVersionId, e.latestSucceededRunId]) assertDatabaseUuid(id);
    if (p.providerKey !== "clutchpacks" || typeof p.configVersionNumber !== "bigint" || p.configVersionNumber < 1n ||
      typeof e.stateGeneration !== "bigint" || e.stateGeneration < 0n || typeof e.runtimeRowVersion !== "bigint" || e.runtimeRowVersion < 1n ||
      !hash.test(e.routeDigest) || !hash.test(e.checkpointHash) || !neonHost(input.centralHost) || !neonHost(input.providerHost) ||
      input.centralHost === input.providerHost || typeof input.credentialResolver?.resolve !== "function") throw new Error();
    const url = new URL(input.centralDatabaseUrl);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== input.centralHost ||
      (url.port !== "" && url.port !== "5432") || url.pathname !== "/packscout" || !url.username || !url.password || url.hash) throw new Error();
    const allowed = new Set(["sslmode", "sslaccept", "connect_timeout", "pool_timeout", "connection_limit", "schema"]);
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) throw new Error();
    }
    const mode = url.searchParams.get("sslmode"), acceptance = url.searchParams.get("sslaccept");
    if (!(mode === "verify-full" && (acceptance === null || acceptance === "strict") || mode === "require" && acceptance === "strict") ||
      url.searchParams.has("schema") && url.searchParams.get("schema") !== "public") throw new Error();
    if (!input.approvedPublicAssetOrigins.length || input.approvedPublicAssetOrigins.length > 64 ||
      new Set(input.approvedPublicAssetOrigins).size !== input.approvedPublicAssetOrigins.length) throw new Error();
    for (const origin of input.approvedPublicAssetOrigins) publicHttpsOriginSchema.parse(origin);
    url.searchParams.set("connect_timeout", "5"); url.searchParams.set("pool_timeout", "5");
    return url.toString();
  } catch { return refuseSource("PRODUCTION_SOURCE_CONFIGURATION_INVALID"); }
}

export async function readProductionSourceAuthority(tx: CentralTransactionClient, input: ClutchpacksProductionSourceOptions) {
  const p = input.scope;
  const ready = await readDatabaseReadiness({ client: tx, target: centralDatabaseTarget() });
  if (ready.state !== "ready") refuseSource("PRODUCTION_SOURCE_CENTRAL_IDENTITY_INVALID");
  const [provider, membership, located] = await Promise.all([
    tx.providers.findUnique({ where: { id_organization_id: { id: p.providerId, organization_id: p.organizationId } },
      select: { id: true, organization_id: true, provider_key: true, display_name: true, lifecycle: true,
        row_version: true, topology_version: true, active_config_version_id: true, active_public_profile_version_id: true,
        active_config_version: { select: { id: true, version_number: true, stale_after_seconds: true, created_at: true, expires_at: true,
          adapter_key: true, configuration: true, schedule_seconds: true, endpoint_url: true, source_credential_version_id: true } } } }),
    tx.operator_memberships.findFirst({ where: { organization_id: p.organizationId, operator_id: p.operatorId,
      role: "admin", operator: { state: "active" } }, select: { organization_id: true, operator_id: true, role: true,
        operator: { select: { state: true } } } }),
    locateProviderDatabase(tx, { organizationId: p.organizationId, providerId: p.providerId }),
  ]);
  if (!provider || !membership || located.state !== "ready" || provider.id !== p.providerId ||
    provider.organization_id !== p.organizationId || provider.provider_key !== p.providerKey || provider.lifecycle !== "active" ||
    provider.active_config_version_id !== p.configVersionId || provider.active_config_version?.id !== p.configVersionId ||
    provider.active_config_version.version_number !== p.configVersionNumber || membership.operator_id !== p.operatorId ||
    membership.organization_id !== p.organizationId || membership.role !== "admin" || membership.operator.state !== "active") {
    refuseSource("PRODUCTION_SOURCE_AUTHORITY_INVALID");
  }
  const route = located.route;
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`select clock_timestamp() as now`;
  if (!clock || provider.active_config_version.adapter_key !== dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion ||
    provider.active_config_version.expires_at !== null && provider.active_config_version.expires_at <= clock.now) {
    refuseSource("PRODUCTION_SOURCE_CONFIGURATION_EXPIRED_OR_UNSUPPORTED");
  }
  if (route.organizationId !== p.organizationId || route.configVersionId !== p.configVersionId ||
    route.target.providerId !== p.providerId || route.target.providerKey !== p.providerKey ||
    route.target.databaseName !== "packscout_clutchpacks" || route.target.databaseRole !== "provider" ||
    route.target.schemaVersion !== "distributed-provider-v1" || route.node.host !== input.providerHost ||
    route.node.port !== 5432 || route.node.sslMode !== "verify-full" || sourceDigest(route) !== input.expected.routeDigest) {
    refuseSource("PRODUCTION_SOURCE_ROUTE_CHANGED");
  }
  return { provider, route, digest: sourceDigest({ provider, membership, route }) };
}
export type ProductionSourceAuthority = Awaited<ReturnType<typeof readProductionSourceAuthority>>;
