import { createHash } from "node:crypto";

export class NeonRoutingCutoverError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "NeonRoutingCutoverError";
  }
}
export function refuse(code: string): never { throw new NeonRoutingCutoverError(code); }
export function digest(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") return Object.fromEntries(
      Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, normalize(child)]),
    );
    return item;
  };
  return createHash("sha256").update(JSON.stringify(normalize(value))).digest("hex");
}
export function cutoverId(operationId: string, providerId: string, kind: string): string {
  const bytes = createHash("sha256").update(`packscout-neon-routing-v1:${operationId}:${providerId}:${kind}`).digest();
  bytes[6] = (bytes[6]! & 15) | 80; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
export const neonHost = (value: unknown): value is string => typeof value === "string" &&
  /^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/u.test(value) && !value.includes("-pooler.") && !value.includes("..");
export interface RouteRequest { providerKey: string; targetHost: string; targetRegion: string }
export interface RoutePin extends RouteRequest {
  providerId: string; configId: string; configVersion: string; nodeId: string;
  databaseName: string; databaseCredentialId: string; sourceCredentialId: string | null;
  providerVersion: string; topologyVersion: string; nodeVersion: string;
  sourcePort: number; authorityHash: string; priorActivationId: string;
  priorTestedAt: string; priorSummaryHash: string;
}
export interface CutoverPlan {
  version: 1; operationId: string; organizationId: string; operatorId: string;
  centralHost: string; preparedAt: string; providers: RoutePin[];
}
export interface DatabaseProof {
  checkKind: "fresh_tls_provider_identity_and_paused_state";
  checkedAt: string; host: string; databaseName: string; appRole: string;
  providerId: string; providerKey: string; configId: string; configVersion: string;
  databaseRole: string; schemaVersion: string; runtimeProviderId: string; runtimeProviderKey: string;
  runtimeState: string; runtimeVersion: string; generation: string;
  activeRuns: number; actionableCommands: number; ownedLeases: number;
  encrypted: boolean; authorized: boolean; tlsVersion: string;
}
export function validateRequests(input: { operationId: string; organizationId: string; operatorId: string;
  centralHost: string; providers: RouteRequest[] }): void {
  if (![input.operationId, input.organizationId, input.operatorId].every(uuid) || !neonHost(input.centralHost) ||
    !Array.isArray(input.providers) || input.providers.length < 1 || input.providers.length > 32) refuse("NEON_CUTOVER_INPUT_INVALID");
  for (const provider of input.providers) {
    if (!provider || typeof provider.providerKey !== "string" || !/^[a-z][a-z0-9_]{0,52}$/u.test(provider.providerKey) || !neonHost(provider.targetHost) ||
      typeof provider.targetRegion !== "string" || !/^[a-z0-9-]{1,64}$/u.test(provider.targetRegion)) refuse("NEON_CUTOVER_ROUTE_INVALID");
  }
  if (new Set(input.providers.map(p => p.providerKey)).size !== input.providers.length ||
    new Set([input.centralHost, ...input.providers.map(p => p.targetHost)]).size !== input.providers.length + 1) refuse("NEON_CUTOVER_ISOLATION_INVALID");
}
export function validatePlan(plan: CutoverPlan, expectedDigest: string): void {
  validateRequests(plan);
  const exactKeys = (value: object, names: string) => Object.keys(value).sort().join(",") === names.split(",").sort().join(",");
  if (!exactKeys(plan,"version,operationId,organizationId,operatorId,centralHost,preparedAt,providers")) refuse("NEON_CUTOVER_PLAN_CHANGED");
  if (plan.version !== 1 || digest(plan) !== expectedDigest || !Number.isFinite(Date.parse(plan.preparedAt))) refuse("NEON_CUTOVER_PLAN_CHANGED");
  for (const pin of plan.providers) {
    if (!exactKeys(pin,"providerKey,targetHost,targetRegion,providerId,configId,configVersion,nodeId,databaseName,databaseCredentialId,sourceCredentialId,providerVersion,topologyVersion,nodeVersion,sourcePort,authorityHash,priorActivationId,priorTestedAt,priorSummaryHash")) refuse("NEON_CUTOVER_PIN_INVALID");
    if (![pin.providerId, pin.configId, pin.nodeId, pin.databaseCredentialId, pin.priorActivationId].every(uuid) ||
      (pin.sourceCredentialId !== null && !uuid(pin.sourceCredentialId)) ||
      ![pin.configVersion, pin.providerVersion, pin.topologyVersion, pin.nodeVersion].every(v => /^[1-9][0-9]*$/u.test(v)) ||
      pin.databaseName !== `packscout_${pin.providerKey}` || !Number.isInteger(pin.sourcePort) || pin.sourcePort < 1024 || pin.sourcePort > 65535 ||
      ![pin.authorityHash, pin.priorSummaryHash].every(v => /^[0-9a-f]{64}$/u.test(v)) || !Number.isFinite(Date.parse(pin.priorTestedAt))) refuse("NEON_CUTOVER_PIN_INVALID");
  }
  for (const key of ["providerId", "nodeId", "databaseCredentialId", "databaseName"] as const) {
    if (new Set(plan.providers.map(pin => pin[key])).size !== plan.providers.length) refuse("NEON_CUTOVER_ISOLATION_INVALID");
  }
}
export function validateProof(proof: DatabaseProof, pin: RoutePin, now = Date.now()): void {
  const expectedKeys = "checkKind,checkedAt,host,databaseName,appRole,providerId,providerKey,configId,configVersion,databaseRole,schemaVersion,runtimeProviderId,runtimeProviderKey,runtimeState,runtimeVersion,generation,activeRuns,actionableCommands,ownedLeases,encrypted,authorized,tlsVersion";
  if (Object.keys(proof).sort().join(",") !== expectedKeys.split(",").sort().join(",")) refuse("NEON_CUTOVER_DATABASE_PROOF_FAILED");
  const age = now - Date.parse(proof.checkedAt);
  if (proof.checkKind !== "fresh_tls_provider_identity_and_paused_state" || !Number.isFinite(age) || age < 0 || age > 120_000 ||
    proof.host !== pin.targetHost || proof.databaseName !== pin.databaseName || proof.appRole !== `packscout_${pin.providerKey}_app` ||
    proof.providerId !== pin.providerId || proof.runtimeProviderId !== pin.providerId || proof.providerKey !== pin.providerKey ||
    proof.runtimeProviderKey !== pin.providerKey || proof.configId !== pin.configId || proof.configVersion !== pin.configVersion ||
    proof.databaseRole !== "provider" || proof.schemaVersion !== "distributed-provider-v1" || proof.runtimeState !== "paused" ||
    proof.activeRuns !== 0 || proof.actionableCommands !== 0 || proof.ownedLeases !== 0 ||
    !/^[1-9][0-9]*$/u.test(proof.runtimeVersion) || !/^[1-9][0-9]*$/u.test(proof.generation) ||
    !proof.encrypted || !proof.authorized || !["TLSv1.2", "TLSv1.3"].includes(proof.tlsVersion)) refuse("NEON_CUTOVER_DATABASE_PROOF_FAILED");
}
/** This does not assert fresh source liveness. The original source evidence keeps its original timestamp. */
export function activationSummary(pin: RoutePin, proof: DatabaseProof, operationId: string) {
  validateProof(proof, pin);
  return {
    checkKind: "infrastructure_only_route_revalidation", operationId,
    sourceCheckPerformed: false, sourceLivenessRechecked: false, importsResumed: false,
    continuationStatus: "new_continuation_required", previousCentralRouteAuthorityHash: pin.authorityHash,
    priorOperationReceiptsRewritten: false,
    sourceEvidence: { basis: "retained_historical_activation", activationTestId: pin.priorActivationId,
      originalTestedAt: pin.priorTestedAt, configVersionId: pin.configId, sourceCredentialVersionId: pin.sourceCredentialId,
      resultSummaryHash: pin.priorSummaryHash },
    databaseProof: proof,
  };
}
