import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { locateProviderDatabase, readDatabaseRuntimePolicy, type CentralQueryClient } from "@packscout/database";
import { AesGcmProviderCredentialCipher } from "@packscout/services";
import { CentralDataforrestSourceAuthorityResolver } from "../../apps/worker/src/dataforrest-source-authority-resolver.ts";
import { providerDataforrestLiveIntegrationRegistry } from "../../apps/worker/src/provider-dataforrest-live-integration.ts";
import { backfillDigest, refuseBackfill, type BackfillPins } from "./provider-backfill-supervisor-policy.mts";

export const backfillWorkspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
export const localBackfillProviderPorts = Object.freeze({ clutchpacks: 55432, courtyard: 55433, collector_crypt: 55434, phygitals: 55435 });
export function assertLocalBackfillDestination(providerKey: BackfillPins["providerKey"], route: {
  node: { host: string; port: number; sslMode: string }; target: { databaseName: string };
}) {
  if (route.node.host !== "127.0.0.1" || route.node.port !== localBackfillProviderPorts[providerKey] ||
    route.node.sslMode !== "disable" || route.target.databaseName !== `packscout_${providerKey}`) {
    refuseBackfill("BACKFILL_LOCAL_PROVIDER_ROUTE_REQUIRED");
  }
}
export function assertBackfillDestination(providerKey: BackfillPins["providerKey"], route: {
  node: { host: string; port: number; sslMode: string }; target: { databaseName: string };
}, runtimePolicy: ReturnType<typeof readDatabaseRuntimePolicy>) {
  if (runtimePolicy.mode === "local") return assertLocalBackfillDestination(providerKey, route);
  if (route.target.databaseName !== `packscout_${providerKey}`) refuseBackfill("BACKFILL_REMOTE_PROVIDER_ROUTE_REQUIRED");
  try { runtimePolicy.destinationPolicy.assertAllowed(route.node); }
  catch { refuseBackfill("BACKFILL_REMOTE_PROVIDER_ROUTE_REQUIRED"); }
}
export async function readBackfillEnvironment(environment: NodeJS.ProcessEnv = process.env,
  fileEnvironment?: Readonly<Record<string, string>>) {
  let file: Readonly<Record<string, string>> = fileEnvironment ?? {};
  if (fileEnvironment === undefined) {
    try { file = dotenv.parse(await readFile(new URL("../../.env", import.meta.url))); }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  }
  const merged = { ...file, ...environment };
  if (merged.NODE_ENV === "production" || file.PACKSCOUT_PROVIDER_LANES_JSON !== undefined ||
    environment.PACKSCOUT_PROVIDER_LANES_JSON !== undefined) refuseBackfill("BACKFILL_LOCAL_SINGLE_PROVIDER_REQUIRED");
  let url: URL;
  try { url = new URL(merged.PACKSCOUT_CENTRAL_DATABASE_URL ?? ""); }
  catch { return refuseBackfill("BACKFILL_CENTRAL_CONFIGURATION_INVALID"); }
  let runtimePolicy: ReturnType<typeof readDatabaseRuntimePolicy>;
  try { runtimePolicy = readDatabaseRuntimePolicy(merged); }
  catch { return refuseBackfill("BACKFILL_DATABASE_CONFIGURATION_INVALID"); }
  try { runtimePolicy.assertCentralDatabaseUrl(url.toString()); }
  catch { refuseBackfill(runtimePolicy.mode === "local" ? "BACKFILL_LOCAL_CENTRAL_REQUIRED" : "BACKFILL_REMOTE_CENTRAL_REQUIRED"); }
  const encoded = merged.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64 ?? "";
  const key = Buffer.from(encoded, "base64");
  const version = Number(merged.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION ?? "1");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "") ||
    !Number.isSafeInteger(version) || version < 1) refuseBackfill("BACKFILL_CREDENTIAL_KEY_INVALID");
  // No provider DSN/source credential environment is read or forwarded.
  const workerEnvironment = { PATH: environment.PATH, NODE_ENV: "development",
    PACKSCOUT_DATABASE_MODE: runtimePolicy.mode,
    PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS: merged.PACKSCOUT_CENTRAL_DATABASE_ALLOWED_HOSTS,
    PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS: merged.PACKSCOUT_PROVIDER_DATABASE_ALLOWED_HOSTS,
    PACKSCOUT_CENTRAL_DATABASE_URL: url.toString(),
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: encoded,
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: String(version) };
  return { centralDatabaseUrl: url.toString(), key, version, workerEnvironment, runtimePolicy };
}

/** Historical review utilities must refuse cloud access before any client is constructed. */
export async function readLocalBackfillEnvironment(environment: NodeJS.ProcessEnv = process.env,
  fileEnvironment?: Readonly<Record<string, string>>) {
  const resolved = await readBackfillEnvironment(environment, fileEnvironment);
  if (resolved.runtimePolicy.mode !== "local") {
    resolved.key.fill(0);
    refuseBackfill("BACKFILL_LOCAL_CENTRAL_REQUIRED");
  }
  return resolved;
}

export async function readBackfillAuthority(central: CentralQueryClient, cipher: AesGcmProviderCredentialCipher, pins: BackfillPins,
  runtimePolicy = readDatabaseRuntimePolicy({})) {
  const [provider, membership, located] = await Promise.all([
    central.providers.findUnique({ where: { id: pins.providerId }, include: {
      active_config_version: { include: { source_credential: true } },
    } }),
    central.operator_memberships.findFirst({ where: { organization_id: pins.organizationId,
      operator_id: pins.operatorId, role: "admin", operator: { state: "active" } } }),
    locateProviderDatabase(central, { organizationId: pins.organizationId, providerId: pins.providerId }),
  ]);
  const config = provider?.active_config_version;
  const integration = config ? providerDataforrestLiveIntegrationRegistry.resolve(pins.providerKey, config.adapter_key) : null;
  if (!provider || !config || !integration || !membership || provider.lifecycle !== "active" ||
    provider.organization_id !== pins.organizationId || provider.provider_key !== pins.providerKey ||
    provider.active_config_version_id !== pins.configId || config.id !== pins.configId ||
    located.state !== "ready" || located.route.configVersionId !== pins.configId ||
    located.route.target.providerId !== pins.providerId || located.route.target.providerKey !== pins.providerKey ||
    located.route.organizationId !== pins.organizationId) refuseBackfill("BACKFILL_CENTRAL_AUTHORITY_UNAVAILABLE");
  assertBackfillDestination(pins.providerKey, located.route, runtimePolicy);
  const authority = await new CentralDataforrestSourceAuthorityResolver({ central, credentialCipher: cipher }).resolve({
    providerId: pins.providerId, providerKey: pins.providerKey, configVersionId: config.id,
    configVersionNumber: config.version_number, adapterKey: config.adapter_key,
  });
  if (authority.organizationId !== pins.organizationId) refuseBackfill("BACKFILL_SOURCE_AUTHORITY_CONFLICT");
  return { route: located.route, configNumber: config.version_number, integration,
    cachedConfiguration: { adapterKey: config.adapter_key, settings: config.configuration },
    expiresAt: config.expires_at, scheduleSeconds: config.schedule_seconds,
    digest: backfillDigest({ route: located.route, config, organizationId: pins.organizationId,
      operatorId: pins.operatorId, providerKey: pins.providerKey }) };
}
export type BackfillAuthority = Awaited<ReturnType<typeof readBackfillAuthority>>;
