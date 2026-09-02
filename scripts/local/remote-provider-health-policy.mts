import path from "node:path";
import { z } from "zod";
import { opaqueCursorEnvelopeSchema, launchProviderKeySchema } from "@packscout/contracts";
import { providerMixedPageDigest, type DatabaseRuntimePolicy, type ProviderDatabaseRoute } from "@packscout/database";
import { backfillDigest, type BackfillPins } from "./provider-backfill-supervisor-policy.mts";
import type { BackfillAuthority } from "./provider-backfill-supervisor-authority.mts";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const host = z.string().max(253).refine(value => value.includes(".") && value.split(".")
  .every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)));
export const remoteHealthProviderPinSchema = z.object({
  providerKey: launchProviderKeySchema, providerId: z.string().uuid(), configId: z.string().uuid(),
  configNumber: z.string().regex(/^[1-9][0-9]{0,18}$/u), routeHost: host, routeDigest: hash,
}).strict();
export const remoteHealthScopeSchema = z.object({
  schemaVersion: z.literal(1), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/u),
  migrationEvidence: z.object({ path: z.string().refine(path.isAbsolute), sha256: hash }).strict(),
  centralHost: host, organizationId: z.string().uuid(), operatorId: z.string().uuid(),
  providers: z.array(remoteHealthProviderPinSchema).min(1).max(4),
}).strict().superRefine((scope, context) => {
  for (const field of ["providerId", "providerKey", "configId"] as const) {
    if (new Set(scope.providers.map(pin => pin[field])).size !== scope.providers.length) {
      context.addIssue({ code: "custom", message: "Duplicate provider scope" });
    }
  }
});
export type RemoteHealthScope = z.infer<typeof remoteHealthScopeSchema>;
export type RemoteHealthProviderPin = z.infer<typeof remoteHealthProviderPinSchema>;
export class RemoteHealthError extends Error {
  constructor(readonly code: string) { super(code); this.name = "RemoteHealthError"; }
}
export function refuseRemoteHealth(code: string): never { throw new RemoteHealthError(code); }
export function remoteHealthFailureCode(error: unknown) {
  return error instanceof RemoteHealthError && /^REMOTE_HEALTH_[A-Z_]{1,80}$/u.test(error.code)
    ? error.code : "REMOTE_HEALTH_READ_UNAVAILABLE";
}
export function parseRemoteHealthScope(value: unknown): RemoteHealthScope {
  const parsed = remoteHealthScopeSchema.safeParse(value);
  if (!parsed.success) refuseRemoteHealth("REMOTE_HEALTH_SCOPE_INVALID");
  return parsed.data;
}

/** Exact full route, including encrypted bytes and revisions; never output its input. */
export const remoteProviderRouteDigest = (route: ProviderDatabaseRoute): string => backfillDigest(route);
export function remoteHealthRoutePins(route: ProviderDatabaseRoute) {
  return { routeDigest: remoteProviderRouteDigest(route), host: route.node.host, port: route.node.port,
    sslMode: route.node.sslMode, databaseName: route.target.databaseName, schemaVersion: route.target.schemaVersion,
    providerRowVersion: route.providerRowVersion, topologyVersion: route.topologyVersion,
    nodeId: route.node.nodeId, nodeRowVersion: route.node.rowVersion,
    credentialVersionId: route.node.credentialVersionId };
}
export function assertRemoteHealthEnvironment(scope: RemoteHealthScope, environment: {
  centralDatabaseUrl: string; runtimePolicy: DatabaseRuntimePolicy;
}) {
  if (environment.runtimePolicy.mode !== "remote") refuseRemoteHealth("REMOTE_HEALTH_REMOTE_MODE_REQUIRED");
  try {
    environment.runtimePolicy.assertCentralDatabaseUrl(environment.centralDatabaseUrl);
    const url = new URL(environment.centralDatabaseUrl);
    if (url.hostname !== scope.centralHost) refuseRemoteHealth("REMOTE_HEALTH_CENTRAL_HOST_CHANGED");
    for (const pin of scope.providers) environment.runtimePolicy.destinationPolicy.assertAllowed({
      host: pin.routeHost, port: 5432, sslMode: "verify-full",
    });
  } catch (error) {
    if (error instanceof RemoteHealthError) throw error;
    refuseRemoteHealth("REMOTE_HEALTH_DATABASE_POLICY_INVALID");
  }
}
export function remoteHealthAuthorityPins(scope: RemoteHealthScope, pin: RemoteHealthProviderPin): BackfillPins {
  // ReadBackfillAuthority does not consume operation/run IDs. No operation is created.
  return { ...pin, organizationId: scope.organizationId, operatorId: scope.operatorId,
    initialRunId: pin.providerId, operationId: pin.providerId };
}
export function assertRemoteHealthAuthority(scope: RemoteHealthScope, pin: RemoteHealthProviderPin,
  authority: BackfillAuthority, policy: DatabaseRuntimePolicy) {
  const r = authority.route;
  if (policy.mode !== "remote" || r.organizationId !== scope.organizationId || r.target.providerId !== pin.providerId
    || r.target.providerKey !== pin.providerKey || r.configVersionId !== pin.configId
    || authority.configNumber.toString() !== pin.configNumber || authority.integration.providerKey !== pin.providerKey
    || r.node.host !== pin.routeHost || r.node.port !== 5432 || r.node.sslMode !== "verify-full"
    || r.target.databaseRole !== "provider" || r.target.databaseName !== `packscout_${pin.providerKey}`
    || remoteProviderRouteDigest(r) !== pin.routeDigest) refuseRemoteHealth("REMOTE_HEALTH_AUTHORITY_CHANGED");
  try { policy.destinationPolicy.assertAllowed(r.node); }
  catch { refuseRemoteHealth("REMOTE_HEALTH_DATABASE_POLICY_INVALID"); }
}
export function remoteHealthCheckpoint(value: unknown, digest: string | null, pin: RemoteHealthProviderPin,
  manifest: BackfillAuthority["integration"]["manifest"]) {
  const safeHash = digest === null || hash.safeParse(digest).success ? digest : null;
  if (value === null) return { hash: safeHash, hashValid: digest === null, envelopeValid: digest === null, kind: "empty" as const };
  const cursor = opaqueCursorEnvelopeSchema.safeParse(value);
  let hashValid = false;
  try { hashValid = digest !== null && safeHash !== null && providerMixedPageDigest(value) === digest; } catch { /* Invalid JSON is not evidence. */ }
  const envelopeValid = cursor.success && cursor.data.sourceInstanceId === pin.providerId
    && cursor.data.sourceRevisionId === pin.configId && cursor.data.sourceTypeKey === manifest.sourceTypeKey
    && cursor.data.adapterVersion === manifest.adapterVersion && cursor.data.cursorCodecKey === manifest.cursorCodecKey
    && cursor.data.cursorGeneration === 1 && cursor.data.value !== null;
  return { hash: safeHash, hashValid, envelopeValid, kind: "stored" as const };
}
export function remoteHealthSafeCode(value: string | null) {
  return value === null || /^[A-Z][A-Z0-9_]{0,127}$/u.test(value) ? value : "REMOTE_HEALTH_UNSAFE_CODE_REDACTED";
}
export function remoteHealthCount(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || value! < 0) refuseRemoteHealth("REMOTE_HEALTH_COUNT_UNAVAILABLE");
  return value!;
}
