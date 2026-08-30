import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { locateProviderDatabase, type CentralQueryClient } from "@packscout/database";
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
export async function readBackfillEnvironment(environment: NodeJS.ProcessEnv = process.env) {
  let file: Record<string, string> = {};
  try { file = dotenv.parse(await readFile(new URL("../../.env", import.meta.url))); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const merged = { ...file, ...environment };
  if (merged.NODE_ENV === "production" || file.PACKSCOUT_PROVIDER_LANES_JSON !== undefined ||
    environment.PACKSCOUT_PROVIDER_LANES_JSON !== undefined) refuseBackfill("BACKFILL_LOCAL_SINGLE_PROVIDER_REQUIRED");
  let url: URL;
  try { url = new URL(merged.PACKSCOUT_CENTRAL_DATABASE_URL ?? ""); }
  catch { return refuseBackfill("BACKFILL_CENTRAL_CONFIGURATION_INVALID"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1" ||
    url.port !== "55431" || url.pathname !== "/packscout" ||
    (url.searchParams.has("sslmode") && url.searchParams.get("sslmode") !== "disable")) {
    refuseBackfill("BACKFILL_LOCAL_CENTRAL_REQUIRED");
  }
  const encoded = merged.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64 ?? "";
  const key = Buffer.from(encoded, "base64");
  const version = Number(merged.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION ?? "1");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "") ||
    !Number.isSafeInteger(version) || version < 1) refuseBackfill("BACKFILL_CREDENTIAL_KEY_INVALID");
  // No provider DSN/source credential environment is read or forwarded.
  const workerEnvironment = { PATH: environment.PATH, NODE_ENV: "development",
    PACKSCOUT_CENTRAL_DATABASE_URL: url.toString(),
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64: encoded,
    PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION: String(version) };
  return { centralDatabaseUrl: url.toString(), key, version, workerEnvironment };
}

export async function readBackfillAuthority(central: CentralQueryClient, cipher: AesGcmProviderCredentialCipher, pins: BackfillPins) {
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
  assertLocalBackfillDestination(pins.providerKey, located.route);
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
