import { createHash } from "node:crypto";
import { canonicalJson } from "@packscout/contracts";
import {
  assertDatabaseUuid,
  locateProviderDatabase,
  providerDatabaseRouteFingerprint,
  readDatabaseRuntimePolicy,
  type CentralPrismaClient,
} from "@packscout/database";
import { DistributedClutchpacksPublicationError } from "./distributed-clutchpacks-publication-plan.mts";
import { loadStableSnapshot } from "./distributed-clutchpacks-publication-snapshot.mts";

const SCOPE_VARIABLE = "PACKSCOUT_LOCAL_CLUTCHPACKS_PUBLICATION_SCOPE_JSON";
const SCOPE_KEYS = ["configVersionId", "configVersionNumber", "operatorId", "organizationId", "providerId"];
export interface ClutchpacksPublicationScope {
  readonly organizationId: string;
  readonly providerId: string;
  readonly configVersionId: string;
  readonly configVersionNumber: string;
  readonly operatorId: string;
}

function refuse(code: string): never { throw new DistributedClutchpacksPublicationError(code); }

function publicationScope(raw: string | undefined, required: boolean): ClutchpacksPublicationScope | null {
  if (raw === undefined && !required) return null;
  try {
    if (raw === undefined || raw.length > 1_024) throw new TypeError();
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).sort().join(",") !== SCOPE_KEYS.join(",") || canonicalJson(value) !== raw) throw new TypeError();
    const scope = value as Record<string, unknown>;
    for (const key of SCOPE_KEYS) if (typeof scope[key] !== "string") throw new TypeError();
    for (const key of ["organizationId", "providerId", "configVersionId", "operatorId"]) {
      assertDatabaseUuid(scope[key] as string);
    }
    const version = scope.configVersionNumber as string;
    if (!/^[1-9][0-9]{0,18}$/u.test(version) || BigInt(version) > 9_223_372_036_854_775_807n) throw new TypeError();
    return Object.freeze(scope) as unknown as ClutchpacksPublicationScope;
  } catch { return refuse("CLUTCHPACKS_PUBLICATION_SCOPE_INVALID"); }
}

/** Neon is explicit database access only; the independent Convex target remains local. */
export function readClutchpacksPublicationDatabaseConfiguration(environment: NodeJS.ProcessEnv) {
  try {
    if (environment.NODE_ENV === "production") throw new TypeError();
    const centralDatabaseUrl = environment.PACKSCOUT_CENTRAL_DATABASE_URL?.trim() ?? "";
    const runtimePolicy = readDatabaseRuntimePolicy(environment, { localProviderPorts: [55_432] });
    runtimePolicy.assertCentralDatabaseUrl(centralDatabaseUrl);
    const scope = publicationScope(environment[SCOPE_VARIABLE], runtimePolicy.mode === "remote");
    return { centralDatabaseUrl: new URL(centralDatabaseUrl).toString(), runtimePolicy, scope };
  } catch (error) {
    if (error instanceof DistributedClutchpacksPublicationError) throw error;
    return refuse("CLUTCHPACKS_PUBLICATION_DATABASE_CONFIGURATION_INVALID");
  }
}

export type ClutchpacksPublicationDatabaseConfiguration = ReturnType<typeof readClutchpacksPublicationDatabaseConfiguration>;

/** Resolve the protected scope and operator before any provider snapshot or lease. */
export async function readClutchpacksPublicationAuthority(
  central: CentralPrismaClient,
  configuration: ClutchpacksPublicationDatabaseConfiguration,
): Promise<string | null> {
  const scope = configuration.scope;
  if (scope === null) return null; // Existing loopback-only preview has no portable tenant pin.
  const [provider, membership, located] = await Promise.all([
    central.providers.findUnique({
      where: { id_organization_id: { id: scope.providerId, organization_id: scope.organizationId } },
      select: { id: true, organization_id: true, provider_key: true, lifecycle: true,
        active_config_version_id: true,
        active_config_version: { select: { id: true, version_number: true } } },
    }),
    central.operator_memberships.findFirst({
      where: { organization_id: scope.organizationId, operator_id: scope.operatorId,
        role: "admin", operator: { state: "active" } },
      select: { organization_id: true, operator_id: true, role: true, operator: { select: { state: true } } },
    }),
    locateProviderDatabase(central, { organizationId: scope.organizationId, providerId: scope.providerId }),
  ]);
  const active = provider?.active_config_version;
  if (!provider || !active || !membership || located.state !== "ready" ||
      provider.id !== scope.providerId || provider.organization_id !== scope.organizationId ||
      provider.provider_key !== "clutchpacks" || provider.lifecycle !== "active" ||
      provider.active_config_version_id !== scope.configVersionId || active.id !== scope.configVersionId ||
      active.version_number.toString() !== scope.configVersionNumber ||
      membership.organization_id !== scope.organizationId || membership.operator_id !== scope.operatorId ||
      membership.role !== "admin" || membership.operator.state !== "active") {
    return refuse("CLUTCHPACKS_PUBLICATION_AUTHORITY_UNAVAILABLE");
  }
  const { route } = located;
  if (route.organizationId !== scope.organizationId || route.configVersionId !== scope.configVersionId ||
      route.target.providerId !== scope.providerId || route.target.providerKey !== "clutchpacks" ||
      route.target.databaseName !== "packscout_clutchpacks" || route.target.databaseRole !== "provider" ||
      route.target.schemaVersion !== "distributed-provider-v1") {
    return refuse("CLUTCHPACKS_PUBLICATION_AUTHORITY_UNAVAILABLE");
  }
  try { configuration.runtimePolicy.destinationPolicy.assertAllowed(route.node); }
  catch { return refuse("CLUTCHPACKS_PUBLICATION_DESTINATION_INVALID"); }
  return canonicalJson({ route: providerDatabaseRouteFingerprint(route), organizationId: scope.organizationId,
    host: route.node.host, port: route.node.port, sslMode: route.node.sslMode,
    databaseName: route.target.databaseName, configVersionNumber: scope.configVersionNumber });
}

/** Every publication revalidation keeps the exact remote tenant/config and route. */
export async function loadClutchpacksPublicationSnapshot(
  input: Parameters<typeof loadStableSnapshot>[0] & { readonly databaseConfiguration: ClutchpacksPublicationDatabaseConfiguration },
  readSnapshot: typeof loadStableSnapshot = loadStableSnapshot,
) {
  const { databaseConfiguration, ...snapshotInput } = input;
  const before = await readClutchpacksPublicationAuthority(input.central, databaseConfiguration);
  const scope = databaseConfiguration.scope;
  const snapshot = await readSnapshot({ ...snapshotInput, ...(scope === null ? {} : { expectedScope: scope }) });
  if (scope !== null && (snapshot.facts.organizationId !== scope.organizationId ||
      snapshot.facts.providerId !== scope.providerId || snapshot.facts.activeConfigVersionId !== scope.configVersionId ||
      snapshot.facts.activeConfigVersionNumber.toString() !== scope.configVersionNumber)) {
    return refuse("CLUTCHPACKS_PUBLICATION_AUTHORITY_UNAVAILABLE");
  }
  if (await readClutchpacksPublicationAuthority(input.central, databaseConfiguration) !== before) {
    return refuse("CLUTCHPACKS_PUBLICATION_AUTHORITY_CHANGED");
  }
  return before === null ? snapshot : { ...snapshot, stabilityFingerprint: createHash("sha256")
    .update(canonicalJson({ source: snapshot.stabilityFingerprint, authority: before })).digest("hex") };
}
