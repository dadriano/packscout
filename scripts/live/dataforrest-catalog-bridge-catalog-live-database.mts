import {
  PROVIDER_CATALOG_IDENTITY_CENSUS_VERSION,
  providerCatalogIdentityCensusSchema,
  providerCatalogIdentityChainDigest,
  type ProviderCatalogIdentityCensus,
} from "@packscout/contracts";
import {
  PrismaAdminProviderRuntimeRepository,
  PrismaProviderWorkerLeaseRepository,
  locateProviderAdminDatabase,
  locateProviderDatabase,
  providerDatabaseRouteFingerprint,
  providerMixedCursorFingerprint,
  providerResumeEvidenceDigest,
  readProviderRunHeadProof,
  type AdminRuntimeCommandRecord,
  type CanonicalJsonValue,
  type CentralPrismaClient,
  type CentralQueryClient,
  type ProviderCatalogOriginResumeGuard,
  type ProviderCatalogQueuedResumeGuard,
  type ProviderRuntimeResumeGuard,
  type ProviderDatabaseOperationResult,
  type ProviderDatabaseRoute,
  type ProviderPrismaClient,
  type ProviderTransactionClient,
} from "@packscout/database";
import {
  catalogBridgeCatalogOperationIds,
  CatalogBridgeError,
  catalogBridgeConfigurationPlan,
  catalogBridgeDigest,
  catalogBridgePauseCommandDigest,
  catalogBridgeProvider,
  reEnvelopeSavedEventCursor,
  refuseCatalogBridge,
  type CatalogBridgeCanonicalEvidence,
  type CatalogBridgeHeadObservation,
  type CatalogBridgePrivatePreparedState,
} from "./dataforrest-catalog-bridge-plan.mts";
import {
  catalogBridgeResumeRunId,
  type CatalogBridgeCatalogRunAdmissionObservation,
  type CatalogBridgeCursorRestoreObservation,
  type CatalogBridgeEventSuccessorStageObservation,
  type CatalogBridgeResumeObservation,
  type CatalogBridgeQuiescentConfigurationObservation,
} from "./dataforrest-catalog-bridge-state.mts";
import type { CatalogBridgeDrainProcessObservation } from
  "./dataforrest-catalog-bridge-drain-policy.mts";
import type { CatalogBridgeCatalogReadyObservation } from
  "./dataforrest-catalog-bridge-catalog.mts";
import type { CatalogBridgeCatalogLivePolicy } from
  "./dataforrest-catalog-bridge-catalog-live-policy.mts";
import { providerDataforrestLiveIntegrationRegistry } from
  "../../apps/worker/src/provider-dataforrest-live-integration.ts";
import { backfillDigest, type BackfillPins } from
  "../local/provider-backfill-supervisor-policy.mts";
import type { BackfillAuthority } from
  "../local/provider-backfill-supervisor-authority.mts";
import { persistResidentRelease } from "../local/provider-resident-handoff.mts";

const CENTRAL_TRANSACTION = Object.freeze({ isolationLevel: "Serializable" as const,
  maxWait: 5_000, timeout: 30_000 });
const PROVIDER_TRANSACTION = Object.freeze({ isolationLevel: "Serializable" as const,
  maxWait: 5_000, timeout: 30_000 });
const ACTOR_KEY = "system:live-dataforrest-catalog-bridge";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const cursorFingerprint = (value: unknown): string | null =>
  providerMixedCursorFingerprint(value as CanonicalJsonValue | null);

function operationCommandId(state: CatalogBridgePrivatePreparedState,
  label: string): string {
  const bytes = Buffer.from(catalogBridgeDigest(
    `${state.operationId}/${state.providerKey}/${label}`).slice(0, 32), "hex");
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function recoveryPauseIdentity(state: CatalogBridgePrivatePreparedState,
  generation: bigint): Readonly<{ commandId: string; idempotencyKey: string; reason: string }> {
  if (generation < 1n) refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_GENERATION_INVALID");
  const suffix = generation.toString();
  return Object.freeze({
    commandId: operationCommandId(state, `event-safe-recovery-pause/${suffix}`),
    idempotencyKey: `catalog-bridge/${state.operationId}/event-safe-recovery/${suffix}/pause`,
    reason: `DataForrest ${state.providerKey} catalog bridge safe recovery at generation ${suffix}`,
  });
}

function catalogRecoveryPauseIdentity(state: CatalogBridgePrivatePreparedState,
  generation: bigint): Readonly<{ commandId: string; idempotencyKey: string; reason: string }> {
  if (generation < 1n) refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_RECOVERY_GENERATION_INVALID");
  const suffix = generation.toString();
  return Object.freeze({
    commandId: operationCommandId(state, `catalog-admission-recovery-pause/${suffix}`),
    idempotencyKey: `catalog-bridge/${state.operationId}/catalog-admission-recovery/${suffix}/pause`,
    reason: `DataForrest ${state.providerKey} catalog bridge queued admission recovery at generation ${suffix}`,
  });
}

function catalogPrequeueRecoveryPauseIdentity(state: CatalogBridgePrivatePreparedState,
  generation: bigint): Readonly<{ commandId: string; idempotencyKey: string; reason: string }> {
  if (generation < 1n) refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_RECOVERY_GENERATION_INVALID");
  const suffix = generation.toString();
  return Object.freeze({
    commandId: operationCommandId(state, `catalog-prequeue-recovery-pause/${suffix}`),
    idempotencyKey: `catalog-bridge/${state.operationId}/catalog-prequeue-recovery/${suffix}/pause`,
    reason: `DataForrest ${state.providerKey} catalog bridge prequeue recovery at generation ${suffix}`,
  });
}

function recoveryResumeIdentity(state: CatalogBridgePrivatePreparedState,
  scope: "catalog-admission" | "catalog-prequeue" | "event-prequeue" | "event-successor",
  generation: bigint): Readonly<{
    commandId: string; idempotencyKey: string; reason: string;
  }> {
  if (generation < 1n) refuseCatalogBridge(scope.startsWith("catalog-")
    ? "CATALOG_BRIDGE_CATALOG_RECOVERY_GENERATION_INVALID"
    : "CATALOG_BRIDGE_EVENT_RECOVERY_GENERATION_INVALID");
  const suffix = generation.toString();
  return Object.freeze({
    commandId: operationCommandId(state, `${scope}-recovery-resume/${suffix}`),
    idempotencyKey: `catalog-bridge/${state.operationId}/${scope}-recovery/${suffix}/resume`,
    reason: `DataForrest ${state.providerKey} catalog bridge ${scope} recovery at generation ${suffix}`,
  });
}

export interface CatalogBridgeCatalogLiveDatabaseDependencies {
  readonly central: CentralPrismaClient;
  readonly runProvider: <T>(route: ProviderDatabaseRoute,
    operation: (database: ProviderPrismaClient) => Promise<T>) => Promise<ProviderDatabaseOperationResult<T>>;
  readonly residentOffline: () => Promise<boolean>;
  readonly executeOneShot: (input: Readonly<{ providerId: string; providerKey: string;
    workerId: string; runId: string }>) => Promise<Readonly<{ kind: "completed"; runId: string }> |
      Readonly<{ kind: "failed" | "blocked"; runId: string | null; failureCode: string }>>;
  readonly now?: () => Date;
  readonly wait?: (milliseconds: number) => Promise<void>;
}

export interface CatalogBridgeRecoveryPauseProof {
  readonly observedAt: string;
  readonly activeConfigId: string;
  readonly runtimeGeneration: string;
  readonly runtimeRowVersion: string;
  readonly pauseCommandId: string;
  readonly pauseCommandDigest: string;
  readonly latestTerminalRunId: string;
  readonly latestTerminalRunDigest: string;
}

export interface CatalogBridgeCatalogLiveDatabaseAdapter {
  readPreparedBoundary(): Promise<CatalogBridgeCatalogReadyObservation>;
  activateCatalogConfiguration(): Promise<CatalogBridgeQuiescentConfigurationObservation>;
  admitCatalogRun(input: Readonly<{ originReceiptDigest: string }>):
    Promise<CatalogBridgeCatalogRunAdmissionObservation>;
  readCatalogHead(): Promise<CatalogBridgeHeadObservation | null>;
  executeCatalogRun(): ReturnType<CatalogBridgeCatalogLiveDatabaseDependencies["executeOneShot"]>;
  ensureResidentOfflineAndPaused(input?: Readonly<{ originReceiptDigest: string }>): Promise<void>;
  readEventDatabaseBoundary(): Promise<Readonly<{ observedAt: string; residentOffline: boolean;
    runtimeState: "paused" | "idle" | "running"; activeRunCount: number; actionableCommandCount: number;
    importLeaseOwner: string | null; importLeaseHeartbeatAt: string | null;
    importLeaseExpiresAt: string | null; otherActiveTransactionCount: number;
    activeConfigId: string; cachedConfigId: string }>>;
  stageEventSuccessor(input: Readonly<{ catalogRunDigest: string }> ):
    Promise<CatalogBridgeEventSuccessorStageObservation>;
  restoreEventCursor(input: Readonly<{ eventStageReceiptDigest: string;
    expectedProviderRowVersion: string; expectedRuntimeRowVersion: string;
    catalogRunDigest: string }> ): Promise<CatalogBridgeCursorRestoreObservation>;
  admitEventResumeRun(input: Readonly<{ cursorRestoreReceiptDigest: string;
    expectedProviderRowVersion: string; expectedRuntimeRowVersion: string;
    restoredCursorHash: string; process: CatalogBridgeDrainProcessObservation }> ): Promise<void>;
  readResumeObservation(process: CatalogBridgeDrainProcessObservation):
    Promise<CatalogBridgeResumeObservation | null>;
  releaseResidentAfterJournal(input: Readonly<{ resumedReceiptDigest: string }>): Promise<void>;
  pauseResidentForRecovery(): Promise<CatalogBridgeRecoveryPauseProof>;
  proveResidentRecoveryPaused(proof: CatalogBridgeRecoveryPauseProof): Promise<void>;
}

function reachable<T>(result: ProviderDatabaseOperationResult<T>): T {
  if (result.state !== "reachable") {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PROVIDER_UNAVAILABLE");
  }
  return result.value;
}

function routeDigest(route: ProviderDatabaseRoute): string {
  return catalogBridgeDigest({ fingerprint: providerDatabaseRouteFingerprint(route), target: route.target,
    organizationId: route.organizationId, configVersionId: route.configVersionId,
    providerRowVersion: route.providerRowVersion, topologyVersion: route.topologyVersion,
    node: { nodeId: route.node.nodeId, host: route.node.host, port: route.node.port,
      sslMode: route.node.sslMode, credentialVersionId: route.node.credentialVersionId,
      rowVersion: route.node.rowVersion } });
}

async function locateRoute(input: Readonly<{ central: CentralQueryClient;
  state: CatalogBridgePrivatePreparedState; admin: boolean }>): Promise<ProviderDatabaseRoute> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const located = await (input.admin ? locateProviderAdminDatabase : locateProviderDatabase)(input.central, {
    organizationId: definition.organizationId, providerId: definition.providerId,
  });
  if (located.state !== "ready") refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ROUTE_UNAVAILABLE");
  return located.route;
}

interface CentralBoundary {
  readonly provider: Awaited<ReturnType<CentralQueryClient["providers"]["findUnique"]>>;
  readonly current: Awaited<ReturnType<CentralQueryClient["provider_config_versions"]["findUnique"]>>;
  readonly catalog: Awaited<ReturnType<CentralQueryClient["provider_config_versions"]["findUnique"]>>;
  readonly eventSuccessor: Awaited<ReturnType<CentralQueryClient["provider_config_versions"]["findUnique"]>>;
  readonly maximum: bigint | null;
  readonly stageAudit: Awaited<ReturnType<CentralQueryClient["audit_events"]["findUnique"]>>;
  readonly activationAudit: Awaited<ReturnType<CentralQueryClient["audit_events"]["findUnique"]>>;
  readonly eventStageAudit: Awaited<ReturnType<CentralQueryClient["audit_events"]["findUnique"]>>;
  readonly eventActivationAudit: Awaited<ReturnType<CentralQueryClient["audit_events"]["findUnique"]>>;
  readonly eventActivationTest: Awaited<ReturnType<CentralQueryClient["provider_connection_tests"]["findUnique"]>>;
  readonly membership: { readonly role: string; readonly operator: { readonly state: string } } | null;
  readonly route: ProviderDatabaseRoute;
  readonly node: Readonly<{ id: string; provider_id: string; credential_version_id: string;
    row_version: bigint; credential: Readonly<{ id: string; credential_kind: string;
      lifecycle: string }> }> | null;
}

async function readCentralBoundary(input: Readonly<{ central: CentralQueryClient;
  policy: CatalogBridgeCatalogLivePolicy; state: CatalogBridgePrivatePreparedState }>): Promise<CentralBoundary> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const plan = catalogBridgeConfigurationPlan(input.state);
  const ids = catalogBridgeCatalogOperationIds(input.policy.pins);
  const [provider, current, catalog, eventSuccessor, aggregate, stageAudit, activationAudit,
    eventStageAudit, eventActivationAudit, eventActivationTest, membership, route, node] =
    await Promise.all([
      input.central.providers.findUnique({ where: { id_organization_id: { id: definition.providerId,
        organization_id: definition.organizationId } } }),
      input.central.provider_config_versions.findUnique({ where: { id: definition.currentConfigId } }),
      input.central.provider_config_versions.findUnique({ where: { id: plan.catalog.id } }),
      input.central.provider_config_versions.findUnique({ where: { id: plan.eventSuccessor.id } }),
      input.central.provider_config_versions.aggregate({ where: { provider_id: definition.providerId },
        _max: { version_number: true } }),
      input.central.audit_events.findUnique({ where: { id: ids.catalogStageAuditId } }),
      input.central.audit_events.findUnique({ where: { id: ids.catalogActivationAuditId } }),
      input.central.audit_events.findUnique({ where: { id: ids.eventStageAuditId } }),
      input.central.audit_events.findUnique({ where: { id: ids.eventActivationAuditId } }),
      input.central.provider_connection_tests.findUnique({ where: { id: ids.eventActivationTestId } }),
      input.central.operator_memberships.findUnique({ where: { organization_id_operator_id: {
        organization_id: definition.organizationId, operator_id: input.policy.pins.operatorId } },
        select: { role: true, operator: { select: { state: true } } } }),
      locateRoute({ central: input.central, state: input.state, admin: true }),
      input.central.provider_database_nodes.findFirst({ where: { provider_id: definition.providerId,
        enabled: true, node_role: "primary" }, include: { credential: true } }),
    ]);
  return Object.freeze({ provider, current, catalog, eventSuccessor,
    maximum: aggregate._max.version_number, stageAudit, activationAudit,
    eventStageAudit, eventActivationAudit, eventActivationTest, membership, route, node });
}

function initialAuthorityDigest(input: Readonly<{ boundary: CentralBoundary;
  policy: CatalogBridgeCatalogLivePolicy; state: CatalogBridgePrivatePreparedState }>): string {
  const { boundary } = input;
  const provider = boundary.provider;
  const config = boundary.current;
  if (!provider || !config || !boundary.membership) return "";
  return catalogBridgeDigest({ provider: { id: provider.id, organizationId: provider.organization_id,
    providerKey: provider.provider_key, lifecycle: provider.lifecycle,
    activeConfigId: provider.active_config_version_id, topologyVersion: provider.topology_version,
    rowVersion: provider.row_version }, config: { id: config.id, providerId: config.provider_id,
    versionNumber: config.version_number, adapterKey: config.adapter_key, endpointUrl: config.endpoint_url,
    sourceCredentialVersionId: config.source_credential_version_id, scheduleSeconds: config.schedule_seconds,
    staleAfterSeconds: config.stale_after_seconds, configuration: config.configuration,
    expiresAt: config.expires_at, createdByOperatorId: config.created_by_operator_id,
    createdAt: config.created_at }, maximumConfigNumber: boundary.maximum,
  operator: { id: input.policy.pins.operatorId, role: boundary.membership.role,
    state: boundary.membership.operator.state }, routeDigest: routeDigest(boundary.route) });
}

function assertCentralShape(input: Readonly<{ boundary: CentralBoundary;
  policy: CatalogBridgeCatalogLivePolicy; state: CatalogBridgePrivatePreparedState;
  allowCatalog: boolean }>): void {
  const { boundary, policy, state } = input;
  const definition = catalogBridgeProvider(state.providerKey);
  const plan = catalogBridgeConfigurationPlan(state);
  const provider = boundary.provider;
  const current = boundary.current;
  if (!provider || !current || !boundary.node || !boundary.membership ||
    provider.id !== definition.providerId || provider.organization_id !== definition.organizationId ||
    provider.provider_key !== definition.providerKey || provider.lifecycle !== "active" ||
    ![definition.currentConfigId, plan.catalog.id, plan.eventSuccessor.id]
      .includes(provider.active_config_version_id ?? "") ||
    current.provider_id !== definition.providerId ||
    current.version_number !== BigInt(definition.currentConfigNumber) ||
    current.adapter_key !== definition.eventManifest.adapterVersion ||
    catalogBridgeDigest(current.configuration) !== catalogBridgeDigest({ platform: definition.providerKey }) ||
    boundary.membership.operator.state !== "active" ||
    !["admin", "data_operator"].includes(boundary.membership.role) ||
    boundary.node.credential.credential_kind !== "database" ||
    boundary.node.credential.lifecycle !== "active" ||
    boundary.route.target.providerId !== definition.providerId ||
    boundary.route.target.providerKey !== definition.providerKey ||
    (!input.allowCatalog && (boundary.catalog !== null ||
      boundary.maximum !== BigInt(definition.currentConfigNumber) ||
      provider.active_config_version_id !== definition.currentConfigId ||
      provider.row_version.toString() !== policy.current.providerRowVersion ||
      routeDigest(boundary.route) !== policy.current.databaseRouteDigest ||
      initialAuthorityDigest(input) !== policy.current.centralAuthorityDigest))) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_CENTRAL_AUTHORITY_CHANGED");
  }
  if (boundary.catalog && (boundary.catalog.provider_id !== definition.providerId ||
    boundary.catalog.version_number !== BigInt(plan.catalog.versionNumber) ||
    boundary.catalog.adapter_key !== plan.catalog.adapterVersion ||
    boundary.catalog.endpoint_url !== current.endpoint_url ||
    boundary.catalog.source_credential_version_id !== current.source_credential_version_id ||
    boundary.catalog.schedule_seconds !== current.schedule_seconds ||
    boundary.catalog.stale_after_seconds !== current.stale_after_seconds ||
    boundary.catalog.expires_at?.getTime() !== current.expires_at?.getTime() ||
    boundary.catalog.created_by_operator_id !== policy.pins.operatorId ||
    catalogBridgeDigest(boundary.catalog.configuration) !== catalogBridgeDigest(plan.catalog.configuration))) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_STAGED_CONFIGURATION_CHANGED");
  }
  if (boundary.eventSuccessor && (boundary.eventSuccessor.provider_id !== definition.providerId ||
    boundary.eventSuccessor.version_number !== BigInt(plan.eventSuccessor.versionNumber) ||
    boundary.eventSuccessor.adapter_key !== plan.eventSuccessor.adapterVersion ||
    boundary.eventSuccessor.endpoint_url !== current.endpoint_url ||
    boundary.eventSuccessor.source_credential_version_id !== current.source_credential_version_id ||
    boundary.eventSuccessor.schedule_seconds !== current.schedule_seconds ||
    boundary.eventSuccessor.stale_after_seconds !== current.stale_after_seconds ||
    boundary.eventSuccessor.expires_at?.getTime() !== current.expires_at?.getTime() ||
    boundary.eventSuccessor.created_by_operator_id !== policy.pins.operatorId ||
    catalogBridgeDigest(boundary.eventSuccessor.configuration) !==
      catalogBridgeDigest(plan.eventSuccessor.configuration))) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_STAGED_CONFIGURATION_CHANGED");
  }
}

function stageEvidence(input: Readonly<{ policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState }>) {
  const plan = catalogBridgeConfigurationPlan(input.state);
  return Object.freeze({ operationId: input.state.operationId, planDigest: input.state.planDigest,
    preparedJournalHeadReceiptSha256: input.policy.prepared.journalHeadReceiptSha256,
    originalProviderRowVersion: input.policy.current.providerRowVersion,
    initialAuthorityDigest: input.policy.current.centralAuthorityDigest,
    drainReceiptSha256: input.policy.evidence.drainReceiptSha256,
    catalogOriginCanarySha256: input.policy.evidence.catalogOriginCanarySha256,
    sourceHeadCounts: input.policy.pins.sourceHeadCounts,
    catalogConfigId: plan.catalog.id, catalogConfigNumber: plan.catalog.versionNumber,
    configurationDigest: catalogBridgeDigest(plan.catalog.configuration) });
}

async function stageInactiveCatalogConfiguration(input: Readonly<{
  central: CentralPrismaClient; policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState; now: () => Date;
}>): Promise<void> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const plan = catalogBridgeConfigurationPlan(input.state);
  const ids = catalogBridgeCatalogOperationIds(input.policy.pins);
  const expectedEvidence = stageEvidence(input);
  await input.central.$transaction(async (transaction) => {
    await transaction.$queryRawUnsafe("select id from providers where id = $1::uuid for update",
      definition.providerId);
    const boundary = await readCentralBoundary({ ...input, central: transaction });
    assertCentralShape({ boundary, ...input, allowCatalog: true });
    if (boundary.catalog || boundary.stageAudit) {
      const metadata = boundary.stageAudit?.metadata_json;
      if (!boundary.catalog || !boundary.stageAudit ||
        boundary.stageAudit.organization_id !== definition.organizationId ||
        boundary.stageAudit.action !== "provider.catalog_bridge.catalog.staged" ||
        boundary.stageAudit.subject_id !== definition.providerId ||
        boundary.stageAudit.outcome !== "success" ||
        catalogBridgeDigest(metadata) !== catalogBridgeDigest(expectedEvidence)) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_STAGE_RETRY_CHANGED");
      }
      return;
    }
    if (boundary.maximum !== BigInt(definition.currentConfigNumber) ||
      boundary.provider?.active_config_version_id !== definition.currentConfigId ||
      boundary.provider.row_version.toString() !== input.policy.current.providerRowVersion ||
      initialAuthorityDigest({ boundary, ...input }) !== input.policy.current.centralAuthorityDigest) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_CENTRAL_CAS_FAILED");
    }
    const current = boundary.current!;
    const node = boundary.node!;
    const now = input.now();
    await transaction.provider_config_versions.create({ data: {
      id: plan.catalog.id, provider_id: definition.providerId,
      version_number: BigInt(plan.catalog.versionNumber), adapter_key: plan.catalog.adapterVersion,
      endpoint_url: current.endpoint_url,
      source_credential_version_id: current.source_credential_version_id,
      schedule_seconds: current.schedule_seconds, stale_after_seconds: current.stale_after_seconds,
      configuration: { ...plan.catalog.configuration }, expires_at: current.expires_at,
      created_by_operator_id: input.policy.pins.operatorId, created_at: now,
    } });
    const rows = await transaction.$queryRawUnsafe<Array<{ digest: string }>>(
      "select packscout_activation_target_digest_nullable_source($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::bigint,$6::uuid,$7::bigint) as digest",
      definition.providerId, plan.catalog.id, current.source_credential_version_id,
      node.credential.id, boundary.provider!.topology_version, node.id, node.row_version);
    const target = rows[0];
    if (!target?.digest) refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ACTIVATION_DIGEST_UNAVAILABLE");
    await transaction.provider_connection_tests.create({ data: {
      id: ids.catalogActivationTestId, provider_id: definition.providerId,
      config_version_id: plan.catalog.id,
      source_credential_version_id: current.source_credential_version_id,
      database_credential_version_id: node.credential.id,
      topology_version: boundary.provider!.topology_version, database_node_id: node.id,
      database_node_row_version: node.row_version, target_digest: target.digest,
      test_kind: "activation", outcome: "succeeded",
      latency_ms: Math.round(input.state.preflight.sourceCanaries.catalogOrigin.durationMilliseconds),
      response_status: 200,
      result_summary: { operationId: input.state.operationId,
        catalogOriginCanarySha256: input.policy.evidence.catalogOriginCanarySha256,
        drainReceiptSha256: input.policy.evidence.drainReceiptSha256 },
      record_counts: { cards: input.policy.pins.sourceHeadCounts.card,
        packs: input.policy.pins.sourceHeadCounts.pack },
      has_more: input.state.preflight.sourceCanaries.catalogOrigin.nextCursorHash !== null,
      next_cursor_present: input.state.preflight.sourceCanaries.catalogOrigin.nextCursorHash !== null,
      tested_by_operator_id: input.policy.pins.operatorId, tested_at: now, created_at: now,
    } });
    await transaction.audit_events.create({ data: {
      id: ids.catalogStageAuditId, organization_id: definition.organizationId,
      actor_key: ACTOR_KEY, action: "provider.catalog_bridge.catalog.staged",
      subject_type: "provider", subject_id: definition.providerId, outcome: "success",
      metadata_json: expectedEvidence, occurred_at: now,
    } });
  }, CENTRAL_TRANSACTION);
}

async function activateCatalogConfigurationLast(input: Readonly<{
  central: CentralPrismaClient; policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState; providerSyncDigest: string; now: () => Date;
}>): Promise<void> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const plan = catalogBridgeConfigurationPlan(input.state);
  const ids = catalogBridgeCatalogOperationIds(input.policy.pins);
  await input.central.$transaction(async (transaction) => {
    await transaction.$queryRawUnsafe("select id from providers where id = $1::uuid for update",
      definition.providerId);
    const boundary = await readCentralBoundary({ ...input, central: transaction });
    assertCentralShape({ boundary, ...input, allowCatalog: true });
    const stage = boundary.stageAudit?.metadata_json;
    if (!boundary.catalog || !boundary.stageAudit ||
      catalogBridgeDigest(stage) !== catalogBridgeDigest(stageEvidence(input))) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ACTIVATION_NOT_STAGED");
    }
    if (boundary.provider?.active_config_version_id === plan.catalog.id) {
      const metadata = boundary.activationAudit?.metadata_json as Record<string, unknown> | null | undefined;
      if (!boundary.activationAudit || metadata?.providerSyncDigest !== input.providerSyncDigest ||
        boundary.provider.row_version !== BigInt(input.policy.current.providerRowVersion) + 1n) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ACTIVATION_RETRY_CHANGED");
      }
      return;
    }
    if (boundary.provider?.active_config_version_id !== definition.currentConfigId ||
      boundary.provider.row_version.toString() !== input.policy.current.providerRowVersion ||
      boundary.maximum !== BigInt(plan.catalog.versionNumber)) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_CENTRAL_CAS_FAILED");
    }
    const changed = await transaction.providers.updateMany({ where: {
      id: definition.providerId, organization_id: definition.organizationId,
      row_version: boundary.provider.row_version,
      active_config_version_id: definition.currentConfigId,
    }, data: { active_config_version_id: plan.catalog.id, row_version: { increment: 1n },
      updated_at: input.now() } });
    if (changed.count !== 1) refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_CENTRAL_CAS_FAILED");
    await transaction.audit_events.create({ data: {
      id: ids.catalogActivationAuditId, organization_id: definition.organizationId,
      actor_key: ACTOR_KEY, action: "provider.catalog_bridge.catalog.activated",
      subject_type: "provider", subject_id: definition.providerId, outcome: "success",
      metadata_json: { operationId: input.state.operationId, catalogConfigId: plan.catalog.id,
        originalProviderRowVersion: input.policy.current.providerRowVersion,
        providerSyncDigest: input.providerSyncDigest,
        stagedEvidenceDigest: catalogBridgeDigest(stageEvidence(input)) },
      occurred_at: input.now(),
    } });
    await transaction.$queryRawUnsafe("select packscout_assert_provider_activation($1::uuid)",
      definition.providerId);
  }, CENTRAL_TRANSACTION);
}

function eventStageEvidence(input: Readonly<{ policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState; catalogRunDigest: string }>) {
  const plan = catalogBridgeConfigurationPlan(input.state);
  return Object.freeze({ operationId: input.state.operationId, planDigest: input.state.planDigest,
    catalogRunDigest: input.catalogRunDigest, catalogConfigId: plan.catalog.id,
    eventSuccessorConfigId: plan.eventSuccessor.id,
    eventSuccessorConfigNumber: plan.eventSuccessor.versionNumber,
    configurationDigest: catalogBridgeDigest(plan.eventSuccessor.configuration),
    drainReceiptSha256: input.policy.evidence.drainReceiptSha256 });
}

function connectionTestProofDigest(row: NonNullable<CentralBoundary["eventActivationTest"]>): string {
  return catalogBridgeDigest({ id: row.id, providerId: row.provider_id,
    configVersionId: row.config_version_id,
    sourceCredentialVersionId: row.source_credential_version_id,
    databaseCredentialVersionId: row.database_credential_version_id,
    topologyVersion: row.topology_version, databaseNodeId: row.database_node_id,
    databaseNodeRowVersion: row.database_node_row_version, targetDigest: row.target_digest,
    testKind: row.test_kind, outcome: row.outcome, responseStatus: row.response_status,
    resultSummary: row.result_summary, testedAt: row.tested_at });
}

async function stageInactiveEventSuccessorConfiguration(input: Readonly<{
  central: CentralPrismaClient; policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState; catalogRunDigest: string; now: () => Date;
}>): Promise<Readonly<{ activationProofDigest: string; providerRowVersion: string }>> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const plan = catalogBridgeConfigurationPlan(input.state);
  const ids = catalogBridgeCatalogOperationIds(input.policy.pins);
  const expectedEvidence = eventStageEvidence(input);
  return input.central.$transaction(async (transaction) => {
    await transaction.$queryRawUnsafe("select id from providers where id = $1::uuid for update",
      definition.providerId);
    const boundary = await readCentralBoundary({ ...input, central: transaction });
    assertCentralShape({ boundary, ...input, allowCatalog: true });
    if (boundary.eventSuccessor || boundary.eventStageAudit || boundary.eventActivationTest) {
      if (!boundary.eventSuccessor || !boundary.eventStageAudit || !boundary.eventActivationTest ||
        boundary.eventStageAudit.organization_id !== definition.organizationId ||
        boundary.eventStageAudit.action !== "provider.catalog_bridge.event_successor.staged" ||
        boundary.eventStageAudit.subject_id !== definition.providerId ||
        boundary.eventStageAudit.outcome !== "success" ||
        catalogBridgeDigest(boundary.eventStageAudit.metadata_json) !== catalogBridgeDigest(expectedEvidence) ||
        boundary.eventActivationTest.provider_id !== definition.providerId ||
        boundary.eventActivationTest.config_version_id !== plan.eventSuccessor.id ||
        boundary.eventActivationTest.test_kind !== "activation" ||
        boundary.eventActivationTest.outcome !== "succeeded") {
        refuseCatalogBridge("CATALOG_BRIDGE_EVENT_STAGE_RETRY_CHANGED");
      }
      return Object.freeze({ activationProofDigest:
        connectionTestProofDigest(boundary.eventActivationTest),
        providerRowVersion: boundary.provider!.row_version.toString() });
    }
    if (!boundary.catalog || boundary.provider?.active_config_version_id !== plan.catalog.id ||
      boundary.provider.row_version !== BigInt(input.policy.current.providerRowVersion) + 1n ||
      boundary.maximum !== BigInt(plan.catalog.versionNumber) || !boundary.activationAudit) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_STAGE_CAS_FAILED");
    }
    const current = boundary.current!;
    const node = boundary.node!;
    const now = input.now();
    await transaction.provider_config_versions.create({ data: {
      id: plan.eventSuccessor.id, provider_id: definition.providerId,
      version_number: BigInt(plan.eventSuccessor.versionNumber),
      adapter_key: plan.eventSuccessor.adapterVersion, endpoint_url: current.endpoint_url,
      source_credential_version_id: current.source_credential_version_id,
      schedule_seconds: current.schedule_seconds, stale_after_seconds: current.stale_after_seconds,
      configuration: { ...plan.eventSuccessor.configuration }, expires_at: current.expires_at,
      created_by_operator_id: input.policy.pins.operatorId, created_at: now,
    } });
    const targets = await transaction.$queryRawUnsafe<Array<{ digest: string }>>(
      "select packscout_activation_target_digest_nullable_source($1::uuid,$2::uuid,$3::uuid," +
      "$4::uuid,$5::bigint,$6::uuid,$7::bigint) as digest",
      definition.providerId, plan.eventSuccessor.id, current.source_credential_version_id,
      node.credential.id, boundary.provider.topology_version, node.id, node.row_version);
    if (!targets[0]?.digest) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_ACTIVATION_DIGEST_UNAVAILABLE");
    }
    const test = await transaction.provider_connection_tests.create({ data: {
      id: ids.eventActivationTestId, provider_id: definition.providerId,
      config_version_id: plan.eventSuccessor.id,
      source_credential_version_id: current.source_credential_version_id,
      database_credential_version_id: node.credential.id,
      topology_version: boundary.provider.topology_version, database_node_id: node.id,
      database_node_row_version: node.row_version, target_digest: targets[0].digest,
      test_kind: "activation", outcome: "succeeded", latency_ms: 0, response_status: 200,
      result_summary: { operationId: input.state.operationId,
        catalogRunDigest: input.catalogRunDigest,
        capabilityProofDigest: input.policy.capabilityProof.proofDigest },
      tested_by_operator_id: input.policy.pins.operatorId, tested_at: now,
    } });
    await transaction.audit_events.create({ data: { id: ids.eventStageAuditId,
      organization_id: definition.organizationId, actor_key: ACTOR_KEY,
      action: "provider.catalog_bridge.event_successor.staged", subject_type: "provider",
      subject_id: definition.providerId, outcome: "success", metadata_json: expectedEvidence,
      occurred_at: now } });
    return Object.freeze({ activationProofDigest: connectionTestProofDigest(test),
      providerRowVersion: boundary.provider.row_version.toString() });
  }, CENTRAL_TRANSACTION);
}

async function activateEventSuccessorConfigurationLast(input: Readonly<{
  central: CentralPrismaClient; policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState; expectedProviderRowVersion: string;
  eventStageReceiptDigest: string; providerSyncDigest: string; now: () => Date;
}>): Promise<void> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const plan = catalogBridgeConfigurationPlan(input.state);
  const ids = catalogBridgeCatalogOperationIds(input.policy.pins);
  await input.central.$transaction(async (transaction) => {
    await transaction.$queryRawUnsafe("select id from providers where id = $1::uuid for update",
      definition.providerId);
    const boundary = await readCentralBoundary({ ...input, central: transaction });
    assertCentralShape({ boundary, ...input, allowCatalog: true });
    if (!boundary.eventSuccessor || !boundary.eventStageAudit || !boundary.eventActivationTest) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_ACTIVATION_NOT_STAGED");
    }
    const expectedMetadata = { operationId: input.state.operationId,
      eventStageReceiptDigest: input.eventStageReceiptDigest,
      providerSyncDigest: input.providerSyncDigest,
      previousProviderRowVersion: input.expectedProviderRowVersion,
      eventSuccessorConfigId: plan.eventSuccessor.id };
    if (boundary.provider?.active_config_version_id === plan.eventSuccessor.id) {
      if (!boundary.eventActivationAudit || boundary.eventActivationAudit.outcome !== "success" ||
        catalogBridgeDigest(boundary.eventActivationAudit.metadata_json) !==
          catalogBridgeDigest(expectedMetadata)) {
        refuseCatalogBridge("CATALOG_BRIDGE_EVENT_ACTIVATION_RETRY_CHANGED");
      }
      return;
    }
    if (boundary.provider?.active_config_version_id !== plan.catalog.id ||
      boundary.provider.row_version.toString() !== input.expectedProviderRowVersion ||
      boundary.maximum !== BigInt(plan.eventSuccessor.versionNumber) ||
      boundary.eventActivationAudit !== null) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_ACTIVATION_CAS_FAILED");
    }
    const changed = await transaction.providers.updateMany({ where: {
      id: definition.providerId, organization_id: definition.organizationId,
      active_config_version_id: plan.catalog.id,
      row_version: BigInt(input.expectedProviderRowVersion),
    }, data: { active_config_version_id: plan.eventSuccessor.id,
      row_version: { increment: 1n }, updated_at: input.now() } });
    if (changed.count !== 1) refuseCatalogBridge("CATALOG_BRIDGE_EVENT_ACTIVATION_CAS_FAILED");
    await transaction.audit_events.create({ data: { id: ids.eventActivationAuditId,
      organization_id: definition.organizationId, actor_key: ACTOR_KEY,
      action: "provider.catalog_bridge.event_successor.activated", subject_type: "provider",
      subject_id: definition.providerId, outcome: "success", metadata_json: expectedMetadata,
      occurred_at: input.now() } });
    await transaction.$queryRawUnsafe("select packscout_assert_provider_activation($1::uuid)",
      definition.providerId);
  }, CENTRAL_TRANSACTION);
}

interface ImportLeaseRow {
  readonly worker_role: string;
  readonly lease_owner: string | null;
  readonly lease_fence: bigint;
  readonly heartbeat_at: Date | null;
  readonly lease_expires_at: Date | null;
  readonly row_version: bigint;
  readonly database_now: Date;
}

/** Exact process/runtime/work/lease coupling used for every resume-admission retry. */
export function assertEventResumeAdmissionState(input: Readonly<{
  operationId: string;
  runState: string;
  runReachedHead: boolean;
  runWorkerFence: bigint;
  runCommandState: string;
  runtimeState: string;
  activeRunCount: number;
  actionableCommandCount: number;
  processOffline: boolean;
  processOnline: boolean;
  leaseOwner: string | null;
  leaseFence: bigint;
  leaseHeartbeatAt: Date | null;
  leaseExpiresAt: Date | null;
  databaseNow: Date;
  expectedUtilityLeaseOwner?: string;
}>): void {
  const fullyReleasedLease = input.leaseOwner === null && input.leaseHeartbeatAt === null &&
    input.leaseExpiresAt === null;
  const residentWorkerPrefix = `local:backfill:${input.operationId}:`;
  const residentWorker = input.leaseOwner?.startsWith(residentWorkerPrefix) === true &&
    uuidPattern.test(input.leaseOwner.slice(residentWorkerPrefix.length));
  const liveResidentLease = residentWorker && input.leaseHeartbeatAt !== null &&
    input.leaseExpiresAt !== null && input.leaseExpiresAt > input.databaseNow;
  const exactUtilityLease = input.expectedUtilityLeaseOwner !== undefined &&
    input.leaseOwner === input.expectedUtilityLeaseOwner && input.leaseHeartbeatAt !== null &&
    input.leaseExpiresAt !== null;
  const offlineLease = input.expectedUtilityLeaseOwner === undefined
    ? fullyReleasedLease : exactUtilityLease;
  const exactQueued = input.runState === "queued" && input.activeRunCount === 1 &&
    input.actionableCommandCount === 1 && input.runCommandState === "accepted" &&
    input.runWorkerFence === 0n &&
    input.processOffline && !input.processOnline && input.runtimeState === "idle" &&
    offlineLease;
  const exactRunning = input.runState === "running" && input.activeRunCount === 1 &&
    input.actionableCommandCount === 0 && input.runCommandState === "completed" &&
    !input.processOffline && input.processOnline && input.runtimeState === "running" &&
    liveResidentLease && input.runWorkerFence === input.leaseFence;
  const exactSucceeded = input.runState === "succeeded" && input.activeRunCount === 0 &&
    input.actionableCommandCount === 0 && input.runCommandState === "completed" &&
    input.processOffline !== input.processOnline && input.runtimeState === "idle" &&
    offlineLease && input.runReachedHead;
  if (!exactQueued && !exactRunning && !exactSucceeded) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_ADMISSION_UNPROVEN");
  }
}

export function eventResumeMutationDisposition(input: Readonly<{
  runtimeState: string;
  runtimeRowVersion: bigint;
  expectedRuntimeRowVersion: bigint;
  resumeCommandPresent: boolean;
  exactCompletedResumeCommand: boolean;
  activeRunCount: number;
  actionableCommandCount: number;
}>): "resume_then_queue" | "resume_prequeue_then_queue" | "queue_only" {
  if (input.activeRunCount !== 0 || input.actionableCommandCount !== 0) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_ADMISSION_CHANGED");
  }
  if (input.runtimeState === "paused" &&
    input.runtimeRowVersion === input.expectedRuntimeRowVersion &&
    !input.resumeCommandPresent) return "resume_then_queue";
  const rowDelta = input.runtimeRowVersion - input.expectedRuntimeRowVersion;
  if (input.runtimeState === "idle" && rowDelta >= 1n && rowDelta % 2n === 1n &&
    input.resumeCommandPresent && input.exactCompletedResumeCommand) return "queue_only";
  if (input.runtimeState === "paused" && rowDelta >= 2n && rowDelta % 2n === 0n &&
    input.resumeCommandPresent && input.exactCompletedResumeCommand) {
    return "resume_prequeue_then_queue";
  }
  return refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_ADMISSION_CHANGED");
}

/** Exact queued/running catalog work admitted under the operation utility lease. */
export function assertCatalogPendingRunState(input: Readonly<{
  expectedWorkerId: string;
  runState: string;
  runWorkerFence: bigint;
  runCommandState: string;
  runtimeState: string;
  activeRunCount: number;
  actionableCommandCount: number;
  leaseOwner: string | null;
  leaseFence: bigint;
  leaseHeartbeatAt: Date | null;
  leaseExpiresAt: Date | null;
  databaseNow: Date;
}>): void {
  const exactLiveLease = input.leaseOwner === input.expectedWorkerId &&
    input.leaseHeartbeatAt !== null && input.leaseExpiresAt !== null &&
    input.leaseExpiresAt > input.databaseNow;
  const exactQueued = input.runState === "queued" && input.runWorkerFence === 0n &&
    input.runCommandState === "accepted" && input.runtimeState === "idle" &&
    input.activeRunCount === 1 && input.actionableCommandCount === 1 && exactLiveLease;
  const exactRunning = input.runState === "running" &&
    input.runWorkerFence === input.leaseFence && input.runCommandState === "completed" &&
    input.runtimeState === "running" && input.activeRunCount === 1 &&
    input.actionableCommandCount === 0 && exactLiveLease;
  if (!exactQueued && !exactRunning) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RUN_RACE");
  }
}

async function lockImportLease(transaction: ProviderTransactionClient): Promise<ImportLeaseRow> {
  const rows = await transaction.$queryRawUnsafe<ImportLeaseRow[]>(
    "select worker_role, lease_owner, lease_fence, heartbeat_at, lease_expires_at, row_version, " +
    "clock_timestamp() as database_now from provider_worker_states " +
    "where worker_role = 'import'::worker_role for update");
  if (rows.length !== 1) refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_IMPORT_LEASE_MISSING");
  return rows[0]!;
}

async function lockExactRun(transaction: ProviderTransactionClient, runId: string): Promise<void> {
  const rows = await transaction.$queryRawUnsafe<Array<{ id: string }>>(
    "select id from provider_runs where id = $1::uuid for update", runId);
  if (rows.length !== 1 || rows[0]?.id !== runId) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_RUN_PROVENANCE_MISSING");
  }
}

async function lockRuntime(transaction: ProviderTransactionClient): Promise<void> {
  const rows = await transaction.$queryRawUnsafe<Array<{ singleton_key: boolean }>>(
    "select singleton_key from provider_runtime where singleton_key = true for update");
  if (rows.length !== 1) refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_RUNTIME_MISSING");
}

function storedResult(value: unknown): { outcome: string; code: string; generation: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  return typeof entry.outcome === "string" && typeof entry.code === "string" &&
    typeof entry.generation === "string"
    ? { outcome: entry.outcome, code: entry.code, generation: entry.generation } : null;
}

function pauseDigest(row: Awaited<ReturnType<ProviderTransactionClient["control_commands"]["findUnique"]>>): string {
  const result = storedResult(row?.result);
  if (!row || !row.completed_at || !result || row.target_run_id !== null ||
    row.target_quarantine_id !== null || row.resulting_run_id !== null) return "";
  return catalogBridgePauseCommandDigest({ commandId: row.id, commandDigest: "",
    commandType: row.command_type, commandState: row.state, idempotencyKey: row.idempotency_key,
    targetRunId: null, targetQuarantineId: null,
    resultingRunId: null, requestedByOperatorId: row.requested_by_operator_id,
    expectedGeneration: row.expected_generation.toString(), resultOutcome: result.outcome,
    resultCode: result.code, resultGeneration: result.generation, correlationId: row.correlation_id,
    reason: row.reason, requestedAt: row.requested_at.toISOString(),
    completedAt: row.completed_at.toISOString() });
}

async function synchronizePausedCatalogConfiguration(input: Readonly<{
  database: ProviderPrismaClient; policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState; now: () => Date;
  scheduleSeconds: number; expiresAt: Date | null;
}>): Promise<Readonly<Record<string, unknown>>> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const plan = catalogBridgeConfigurationPlan(input.state);
  const expectedNewRowVersion = BigInt(input.policy.current.runtimeRowVersion) + 1n;
  return input.database.$transaction(async (transaction) => {
    const lease = await lockImportLease(transaction);
    await lockExactRun(transaction, input.policy.current.latestTerminalRunId);
    await lockRuntime(transaction);
    const [runtime, latest, pause, activeRuns, actionableCommands] = await Promise.all([
      transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
      transaction.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
      transaction.control_commands.findUnique({ where: { id: input.policy.current.pauseCommandId } }),
      transaction.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
      transaction.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
    ]);
    const leaseLive = lease.lease_owner !== null && lease.lease_expires_at !== null &&
      lease.lease_expires_at > lease.database_now;
    const oldConfiguration = catalogBridgeDigest(runtime.cached_configuration) === catalogBridgeDigest({
      adapterKey: definition.eventManifest.adapterVersion, settings: { platform: definition.providerKey },
    });
    const catalogConfiguration = catalogBridgeDigest(runtime.cached_configuration) === catalogBridgeDigest({
      adapterKey: definition.catalogAdapterVersion, settings: plan.catalog.configuration,
    });
    const oldBoundary = runtime.cached_config_version_id === definition.currentConfigId &&
      runtime.cached_config_version_number === BigInt(definition.currentConfigNumber) &&
      runtime.row_version === BigInt(input.policy.current.runtimeRowVersion) &&
      runtime.source_cursor_hash === input.policy.current.sourceCursorHash && runtime.source_cursor !== null &&
      oldConfiguration;
    const synchronizedBoundary = runtime.cached_config_version_id === plan.catalog.id &&
      runtime.cached_config_version_number === BigInt(plan.catalog.versionNumber) &&
      runtime.row_version === expectedNewRowVersion && runtime.source_cursor_hash === null &&
      runtime.source_cursor === null && catalogConfiguration;
    if (runtime.central_provider_id !== definition.providerId ||
      runtime.provider_key !== definition.providerKey || runtime.operating_state !== "paused" ||
      runtime.state_generation.toString() !== input.policy.current.runtimeGeneration ||
      (!oldBoundary && !synchronizedBoundary) || latest?.id !== input.policy.current.latestTerminalRunId ||
      providerResumeEvidenceDigest(latest) !== input.policy.current.latestTerminalRunDigest ||
      pauseDigest(pause) !== input.policy.current.pauseCommandDigest || activeRuns !== 0 ||
      actionableCommands !== 0 || leaseLive) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PROVIDER_SYNC_BOUNDARY_CHANGED");
    }
    if (oldBoundary) {
      const synchronizedAt = input.now();
      const query = "update provider_runtime set cached_config_version_id = $1::uuid, " +
        "cached_config_version_number = $2::bigint, cached_configuration = $3::jsonb, " +
        "config_expires_at = $4::timestamptz, last_control_sync_at = $5::timestamptz, " +
        "schedule_seconds = $6::integer, next_due_at = null, source_cursor = null, " +
        "source_cursor_hash = null, row_version = row_version + 1, updated_at = $5::timestamptz " +
        "where singleton_key = true and row_version = $7::bigint";
      const changed = await transaction.$executeRawUnsafe(query,
        plan.catalog.id, BigInt(plan.catalog.versionNumber),
        JSON.stringify({ adapterKey: definition.catalogAdapterVersion, settings: plan.catalog.configuration }),
        input.expiresAt, synchronizedAt, input.scheduleSeconds,
        BigInt(input.policy.current.runtimeRowVersion));
      if (changed !== 1) refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PROVIDER_SYNC_CAS_FAILED");
    }
    const after = await transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
    if (after.cached_config_version_id !== plan.catalog.id ||
      after.cached_config_version_number !== BigInt(plan.catalog.versionNumber) ||
      after.row_version !== expectedNewRowVersion || after.source_cursor !== null ||
      after.source_cursor_hash !== null) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PROVIDER_SYNC_UNPROVEN");
    }
    return Object.freeze({ operationId: input.state.operationId, providerId: definition.providerId,
      previousConfigId: definition.currentConfigId, catalogConfigId: plan.catalog.id,
      runtimeGeneration: after.state_generation.toString(),
      previousRuntimeRowVersion: input.policy.current.runtimeRowVersion,
      runtimeRowVersion: after.row_version.toString(), cursorCleared: true,
      pauseCommandDigest: input.policy.current.pauseCommandDigest,
      latestTerminalRunDigest: input.policy.current.latestTerminalRunDigest });
  }, PROVIDER_TRANSACTION);
}

async function exactFactDigest(transaction: ProviderTransactionClient,
  kind: "pulls" | "market_events"): Promise<Readonly<{ count: number; digest: string }>> {
  type Aggregate = { count: bigint; minimum: string | null; maximum: string | null;
    ordered_digest: string };
  const table = kind === "pulls" ? "pulls" : "market_events";
  const key = kind === "pulls" ? "pull_key" : "event_key";
  const chunkSize = 2_048;
  // Hash bounded ordered chunks, then hash their ordered digests. This binds
  // every immutable key to its stored SHA-256 fact digest without pgcrypto,
  // avoids a multi-million-row transfer, and never creates an unbounded
  // string_agg value. The outer query returns exactly one row.
  const query = "with ordered as (select " + key + " as fact_key, fact_digest, " +
    "((row_number() over (order by " + key + "))-1)/" + String(chunkSize) +
    " as chunk_number from " + table + "), chunks as (select chunk_number, " +
    "count(*)::bigint as row_count, min(fact_key) as minimum, max(fact_key) as maximum, " +
    "encode(sha256(convert_to(string_agg(octet_length(fact_key)::text || ':' || " +
    "fact_key || ':' || fact_digest || ';','' order by fact_key),'UTF8')),'hex') as chunk_digest " +
    "from ordered group by chunk_number) select coalesce(sum(row_count),0)::bigint as count, " +
    "min(minimum) as minimum, max(maximum) as maximum, " +
    "encode(sha256(convert_to(coalesce(string_agg(chunk_number::text || ':' || " +
    "row_count::text || ':' || chunk_digest,';' order by chunk_number),''),'UTF8')),'hex') " +
    "as ordered_digest from chunks";
  const rows = await transaction.$queryRawUnsafe<Aggregate[]>(query);
  const row = rows[0];
  if (!row || row.count > BigInt(Number.MAX_SAFE_INTEGER)) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_EVENT_EVIDENCE_INVALID");
  }
  return Object.freeze({ count: Number(row.count), digest: catalogBridgeDigest({
    schemaVersion: "provider_event_fact_ordered_chunk_sha256_v1", kind,
    chunkSize, count: row.count.toString(), minimum: row.minimum,
    maximum: row.maximum, orderedDigest: row.ordered_digest,
  }) });
}

async function canonicalEvidence(transaction: ProviderTransactionClient): Promise<CatalogBridgeCanonicalEvidence> {
  const [cards, packs, pulls, marketEvents] = await Promise.all([
    transaction.collectibles.count(), transaction.packs.count(),
    exactFactDigest(transaction, "pulls"), exactFactDigest(transaction, "market_events"),
  ]);
  return Object.freeze({ cards, packs, pulls: pulls.count, marketEvents: marketEvents.count,
    pullsDigest: pulls.digest, marketEventsDigest: marketEvents.digest });
}

interface ProviderSnapshot {
  readonly runtime: Awaited<ReturnType<ProviderTransactionClient["provider_runtime"]["findUniqueOrThrow"]>>;
  readonly latest: Awaited<ReturnType<ProviderTransactionClient["provider_runs"]["findFirst"]>>;
  readonly pinnedPause: Awaited<ReturnType<ProviderTransactionClient["control_commands"]["findUnique"]>>;
  readonly lease: ImportLeaseRow;
  readonly activeRunCount: number;
  readonly actionableCommandCount: number;
  readonly otherActiveTransactionCount: number;
}

async function readProviderSnapshot(transaction: ProviderTransactionClient,
  policy: CatalogBridgeCatalogLivePolicy, lock: boolean): Promise<ProviderSnapshot> {
  const lease = lock ? await lockImportLease(transaction) :
    (await transaction.$queryRawUnsafe<ImportLeaseRow[]>(
      "select worker_role, lease_owner, lease_fence, heartbeat_at, lease_expires_at, row_version, " +
      "clock_timestamp() as database_now from provider_worker_states " +
      "where worker_role = 'import'::worker_role"))[0];
  if (!lease) refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_IMPORT_LEASE_MISSING");
  if (lock) await lockRuntime(transaction);
  const [runtime, latest, pinnedPause, activeRunCount, actionableCommandCount, activeTransactions] =
    await Promise.all([
    transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
    transaction.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
    transaction.control_commands.findUnique({ where: { id: policy.current.pauseCommandId } }),
    transaction.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
    transaction.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
    transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
      "select count(*)::bigint as count from pg_stat_activity " +
      "where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'"),
  ]);
  return Object.freeze({ runtime, latest, pinnedPause, lease, activeRunCount,
    actionableCommandCount, otherActiveTransactionCount: Number(activeTransactions[0]?.count ?? 0n) });
}

function providerSnapshotDigest(snapshot: ProviderSnapshot): string {
  return catalogBridgeDigest({
    runtime: { state: snapshot.runtime.operating_state,
      generation: snapshot.runtime.state_generation,
      rowVersion: snapshot.runtime.row_version,
      configId: snapshot.runtime.cached_config_version_id,
      configNumber: snapshot.runtime.cached_config_version_number,
      configuration: snapshot.runtime.cached_configuration,
      cursor: snapshot.runtime.source_cursor,
      cursorHash: snapshot.runtime.source_cursor_hash },
    latestRunId: snapshot.latest?.id ?? null,
    latestRunDigest: snapshot.latest ? providerResumeEvidenceDigest(snapshot.latest) : null,
    pauseCommandDigest: pauseDigest(snapshot.pinnedPause),
    activeRunCount: snapshot.activeRunCount,
    actionableCommandCount: snapshot.actionableCommandCount,
    lease: { owner: snapshot.lease.lease_owner, fence: snapshot.lease.lease_fence,
      heartbeatAt: snapshot.lease.heartbeat_at, expiresAt: snapshot.lease.lease_expires_at,
      rowVersion: snapshot.lease.row_version },
  });
}

function assertProviderSnapshotSafeForCensus(snapshot: ProviderSnapshot,
  runtimeStates: readonly string[]): void {
  if (!runtimeStates.includes(snapshot.runtime.operating_state) ||
    snapshot.activeRunCount !== 0 || snapshot.actionableCommandCount !== 0 ||
    snapshot.lease.lease_owner !== null || snapshot.lease.heartbeat_at !== null ||
    snapshot.lease.lease_expires_at !== null || snapshot.otherActiveTransactionCount !== 0) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_CENSUS_BOUNDARY_NOT_QUIESCENT");
  }
}

export async function readCatalogBridgeCanonicalEvidenceUnlocked(database: ProviderPrismaClient,
  timeout: number): Promise<CatalogBridgeCanonicalEvidence> {
  return database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await transaction.$queryRawUnsafe("select set_config('statement_timeout',$1,true)",
      String(timeout));
    const capability = await transaction.$queryRawUnsafe<Array<{
      server_version_number: number; sha256_available: boolean;
    }>>("select current_setting('server_version_num')::integer as server_version_number, " +
      "to_regprocedure('pg_catalog.sha256(bytea)') is not null as sha256_available");
    if (capability.length !== 1 || !capability[0]?.sha256_available ||
      capability[0].server_version_number < 100000) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_DIGEST_CAPABILITY_MISSING");
    }
    return canonicalEvidence(transaction);
  }, { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout });
}

async function readReadyObservation(input: Readonly<{
  central: CentralPrismaClient; runProvider: CatalogBridgeCatalogLiveDatabaseDependencies["runProvider"];
  residentOffline: () => Promise<boolean>; policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState; now: () => Date;
}>): Promise<CatalogBridgeCatalogReadyObservation> {
  const boundary = await input.central.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return readCentralBoundary({ ...input, central: transaction });
  }, { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 30_000 });
  assertCentralShape({ boundary, ...input, allowCatalog: true });
  const provider = boundary.provider!;
  const activeConfig = provider.active_config_version_id === boundary.catalog?.id
    ? boundary.catalog : boundary.current!;
  const evidence = reachable(await input.runProvider(boundary.route, async (database) => {
    const before = await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return readProviderSnapshot(transaction, input.policy, false);
    }, { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 30_000 });
    assertProviderSnapshotSafeForCensus(before, ["paused"]);
    const canonical = await readCatalogBridgeCanonicalEvidenceUnlocked(database,
      input.policy.utility.executionTimeoutMilliseconds);
    const after = await database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return readProviderSnapshot(transaction, input.policy, false);
    }, { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 30_000 });
    assertProviderSnapshotSafeForCensus(after, ["paused"]);
    if (providerSnapshotDigest(before) !== providerSnapshotDigest(after)) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_BOUNDARY_CHANGED_DURING_CENSUS");
    }
    return Object.freeze({ snapshot: after, canonical });
  }));
  const snapshot = evidence.snapshot;
  const leaseLive = snapshot.lease.lease_owner !== null && snapshot.lease.lease_expires_at !== null &&
    snapshot.lease.lease_expires_at > snapshot.lease.database_now;
  return Object.freeze({ observedAt: input.now().toISOString(),
    residentOffline: await input.residentOffline(), providerId: provider.id,
    providerKey: provider.provider_key, providerRowVersion: provider.row_version.toString(),
    centralAuthorityDigest: provider.active_config_version_id === input.policy.current.configId
      ? initialAuthorityDigest({ boundary, ...input }) : catalogBridgeDigest({
        providerId: provider.id, rowVersion: provider.row_version,
        activeConfigId: provider.active_config_version_id, routeDigest: routeDigest(boundary.route) }),
    databaseRouteDigest: routeDigest(boundary.route), activeConfigId: activeConfig.id,
    activeConfigNumber: Number(activeConfig.version_number),
    maximumConfigNumber: Number(boundary.maximum ?? -1n),
    runtimeState: snapshot.runtime.operating_state,
    runtimeGeneration: snapshot.runtime.state_generation.toString(),
    runtimeRowVersion: snapshot.runtime.row_version.toString(),
    cachedConfigId: snapshot.runtime.cached_config_version_id ?? "",
    cachedConfigNumber: Number(snapshot.runtime.cached_config_version_number ?? -1n),
    sourceCursorPresent: snapshot.runtime.source_cursor !== null,
    sourceCursorHash: snapshot.runtime.source_cursor_hash,
    latestTerminalRunId: snapshot.latest?.id ?? "",
    latestTerminalRunDigest: snapshot.latest ? providerResumeEvidenceDigest(snapshot.latest) : "",
    pauseCommandId: snapshot.pinnedPause?.id ?? "",
    pauseCommandDigest: pauseDigest(snapshot.pinnedPause),
    activeRunCount: snapshot.activeRunCount, actionableCommandCount: snapshot.actionableCommandCount,
    importLeaseOwner: leaseLive ? snapshot.lease.lease_owner : null,
    otherActiveTransactionCount: snapshot.otherActiveTransactionCount, canonical: evidence.canonical });
}

async function readActivatedObservation(input: Readonly<{
  central: CentralPrismaClient; runProvider: CatalogBridgeCatalogLiveDatabaseDependencies["runProvider"];
  policy: CatalogBridgeCatalogLivePolicy; state: CatalogBridgePrivatePreparedState;
  now: () => Date;
}>): Promise<CatalogBridgeQuiescentConfigurationObservation> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const plan = catalogBridgeConfigurationPlan(input.state);
  const boundary = await readCentralBoundary(input);
  assertCentralShape({ boundary, ...input, allowCatalog: true });
  if (boundary.provider?.active_config_version_id !== plan.catalog.id ||
    boundary.maximum !== BigInt(plan.catalog.versionNumber) ||
    boundary.provider.row_version !== BigInt(input.policy.current.providerRowVersion) + 1n ||
    !boundary.catalog) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ACTIVATION_UNPROVEN");
  }
  const evidence = reachable(await input.runProvider(boundary.route, async (database) => {
    const before = await database.$transaction(
      (transaction) => readProviderSnapshot(transaction, input.policy, true),
      PROVIDER_TRANSACTION);
    assertProviderSnapshotSafeForCensus(before, ["paused"]);
    const canonical = await readCatalogBridgeCanonicalEvidenceUnlocked(database,
      input.policy.utility.executionTimeoutMilliseconds);
    const after = await database.$transaction(
      (transaction) => readProviderSnapshot(transaction, input.policy, true),
      PROVIDER_TRANSACTION);
    assertProviderSnapshotSafeForCensus(after, ["paused"]);
    if (providerSnapshotDigest(before) !== providerSnapshotDigest(after)) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_BOUNDARY_CHANGED_DURING_CENSUS");
    }
    return Object.freeze({ snapshot: after, canonical });
  }));
  const snapshot = evidence.snapshot;
  const runtime = snapshot.runtime;
  const leaseLive = snapshot.lease.lease_owner !== null && snapshot.lease.lease_expires_at !== null &&
    snapshot.lease.lease_expires_at > snapshot.lease.database_now;
  if (runtime.cached_config_version_id !== plan.catalog.id ||
    runtime.cached_config_version_number !== BigInt(plan.catalog.versionNumber) ||
    runtime.operating_state !== "paused" || runtime.source_cursor !== null ||
    runtime.source_cursor_hash !== null || snapshot.latest?.id !== input.policy.current.latestTerminalRunId ||
    providerResumeEvidenceDigest(snapshot.latest) !== input.policy.current.latestTerminalRunDigest ||
    pauseDigest(snapshot.pinnedPause) !== input.policy.current.pauseCommandDigest || leaseLive) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PROVIDER_ACTIVATION_UNPROVEN");
  }
  return Object.freeze({ observedAt: input.now().toISOString(), centralActiveConfigId: plan.catalog.id,
    centralActiveConfigNumber: plan.catalog.versionNumber,
    centralActiveAdapterVersion: definition.catalogAdapterVersion,
    centralActiveConfigurationDigest: catalogBridgeDigest(boundary.catalog.configuration),
    providerRowVersion: boundary.provider.row_version.toString(),
    providerCachedConfigId: plan.catalog.id, providerCachedConfigNumber: plan.catalog.versionNumber,
    providerCachedConfigurationDigest: catalogBridgeDigest(runtime.cached_configuration),
    runtimeGeneration: runtime.state_generation.toString(), runtimeRowVersion: runtime.row_version.toString(),
    sourceCursorHash: null, sourceCursorPresent: false, runtimeState: runtime.operating_state,
    pauseCommandId: input.policy.current.pauseCommandId,
    pauseCommandDigest: input.policy.current.pauseCommandDigest,
    latestTerminalRunId: input.policy.current.latestTerminalRunId,
    latestTerminalRunDigest: input.policy.current.latestTerminalRunDigest,
    activeRunCount: snapshot.activeRunCount, actionableCommandCount: snapshot.actionableCommandCount,
    importLeaseOwner: null, otherActiveTransactionCount: snapshot.otherActiveTransactionCount,
    canonical: evidence.canonical });
}

function runtimeCommandDigest(command: AdminRuntimeCommandRecord | null): string {
  return command ? providerResumeEvidenceDigest({
    id: command.id, idempotencyKey: command.idempotencyKey, commandType: command.commandType,
    state: command.state, targetRunId: command.targetRunId,
    targetQuarantineId: command.targetQuarantineId,
    expectedGeneration: command.expectedGeneration.toString(),
    requestedByOperatorId: command.requestedByOperatorId, correlationId: command.correlationId,
    reason: command.reason, result: command.result, resultingRunId: command.resultingRunId,
    requestedAt: command.requestedAt.toISOString(),
    completedAt: command.completedAt?.toISOString() ?? null,
  }) : "";
}

function semanticGuardDigest(guard: ProviderRuntimeResumeGuard): string {
  const { expectedImportLease, notAfter, ...semantic } = guard;
  void expectedImportLease;
  void notAfter;
  return providerResumeEvidenceDigest(semantic);
}

async function proveCatalogPrequeueGenerationHistory(input: Readonly<{
  database: Pick<ProviderTransactionClient, "control_commands" | "local_audit_events">;
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  originReceiptDigest: string;
  targetIdleGeneration: bigint;
}>): Promise<ProviderCatalogQueuedResumeGuard["prequeueRecoveryChain"]> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const plan = catalogBridgeConfigurationPlan(input.state);
  const initialPausedGeneration = BigInt(input.policy.current.runtimeGeneration);
  const initialPausedRowVersion = BigInt(input.policy.current.runtimeRowVersion) + 1n;
  const initialIdleGeneration = initialPausedGeneration + 1n;
  const delta = input.targetIdleGeneration - initialIdleGeneration;
  if (delta < 0n || delta % 2n !== 0n) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PREQUEUE_RECOVERY_UNPROVEN");
  }
  const proof: ProviderCatalogQueuedResumeGuard["prequeueRecoveryChain"][number][] = [];
  for (let cycleIdleGeneration = initialIdleGeneration;
    cycleIdleGeneration < input.targetIdleGeneration; cycleIdleGeneration += 2n) {
    const pauseIdentity = catalogPrequeueRecoveryPauseIdentity(input.state, cycleIdleGeneration);
    const resumeIdentity = recoveryResumeIdentity(input.state, "catalog-prequeue",
      cycleIdleGeneration + 1n);
    const [pause, resume, audit] = await Promise.all([
      input.database.control_commands.findUnique({ where: { id: pauseIdentity.commandId } }),
      input.database.control_commands.findUnique({ where: { id: resumeIdentity.commandId } }),
      input.database.local_audit_events.findFirst({ where: {
        command_id: resumeIdentity.commandId, action: "provider.runtime.resume_guard",
      } }),
    ]);
    const pauseResult = storedResult(pause?.result);
    const resumeResult = storedResult(resume?.result);
    const details = audit?.details as Record<string, unknown> | null | undefined;
    const guard: ProviderCatalogOriginResumeGuard = Object.freeze({
      entry: "paused_catalog_origin", providerId: definition.providerId,
      configVersionId: plan.catalog.id, configVersionNumber: BigInt(plan.catalog.versionNumber),
      runtimeRowVersion: initialPausedRowVersion +
        (cycleIdleGeneration - initialPausedGeneration) + 1n,
      latestRunId: input.policy.current.latestTerminalRunId,
      latestRunDigest: input.policy.current.latestTerminalRunDigest,
      expectedImportLease: { owner: input.policy.utility.workerId, fence: 1n },
      checkpointHash: null, checkpoint: null, originReceiptDigest: input.originReceiptDigest,
      pauseCommandId: pauseIdentity.commandId, pauseCommandDigest: pauseDigest(pause),
    });
    if (!pause || pause.id !== pauseIdentity.commandId || pause.command_type !== "pause" ||
      pause.state !== "completed" || pause.completed_at === null ||
      pause.idempotency_key !== pauseIdentity.idempotencyKey || pause.target_run_id !== null ||
      pause.target_quarantine_id !== null || pause.resulting_run_id !== null ||
      pause.expected_generation !== cycleIdleGeneration ||
      pause.requested_by_operator_id !== input.policy.pins.operatorId ||
      pause.correlation_id !== input.state.operationId || pause.reason !== pauseIdentity.reason ||
      pauseResult?.outcome !== "accepted" || pauseResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
      pauseResult.generation !== (cycleIdleGeneration + 1n).toString() ||
      !resume || resume.id !== resumeIdentity.commandId || resume.command_type !== "resume" ||
      resume.state !== "completed" || resume.completed_at === null ||
      resume.idempotency_key !== resumeIdentity.idempotencyKey || resume.target_run_id !== null ||
      resume.target_quarantine_id !== null || resume.resulting_run_id !== null ||
      resume.expected_generation !== cycleIdleGeneration + 1n ||
      resume.requested_by_operator_id !== input.policy.pins.operatorId ||
      resume.correlation_id !== input.state.operationId || resume.reason !== resumeIdentity.reason ||
      resumeResult?.outcome !== "accepted" || resumeResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
      resumeResult.generation !== (cycleIdleGeneration + 2n).toString() ||
      audit?.outcome !== "success" || audit.actor_operator_id !== input.policy.pins.operatorId ||
      audit.correlation_id !== input.state.operationId || audit.target_type !== "control_command" ||
      audit.target_id !== resume.id || details?.guardDigest !== semanticGuardDigest(guard)) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PREQUEUE_RECOVERY_UNPROVEN");
    }
    proof.push(Object.freeze({ pauseCommandId: pause.id,
      pauseCommandDigest: pauseDigest(pause), resumeCommandId: resume.id,
      resumeCommandDigest: providerResumeEvidenceDigest(resume),
      resumeGuardDigest: semanticGuardDigest(guard) }));
  }
  return Object.freeze(proof);
}

interface CatalogPrequeueRecoveryBoundary {
  readonly runtime: Awaited<ReturnType<ProviderTransactionClient["provider_runtime"]["findUniqueOrThrow"]>>;
  readonly originResume: NonNullable<Awaited<ReturnType<ProviderTransactionClient["control_commands"]["findUnique"]>>>;
  readonly recoveryPause: Awaited<ReturnType<ProviderTransactionClient["control_commands"]["findUnique"]>>;
  readonly lease: ImportLeaseRow;
}

/** Exact null-origin resume prefix before the deterministic catalog run exists. */
async function readCatalogPrequeueRecoveryBoundary(input: Readonly<{
  database: ProviderPrismaClient;
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  originReceiptDigest: string;
  runtimeState: "idle" | "paused";
  leaseState: "owned" | "released";
}>): Promise<CatalogPrequeueRecoveryBoundary> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const plan = catalogBridgeConfigurationPlan(input.state);
  const ids = catalogBridgeCatalogOperationIds(input.policy.pins);
  const initialPausedGeneration = BigInt(input.policy.current.runtimeGeneration);
  const initialPausedRowVersion = BigInt(input.policy.current.runtimeRowVersion) + 1n;
  const initialIdleGeneration = initialPausedGeneration + 1n;
  return input.database.$transaction(async (transaction) => {
    const lease = await lockImportLease(transaction);
    await lockExactRun(transaction, input.policy.current.latestTerminalRunId);
    await lockRuntime(transaction);
    const [runtime, latest, run, runCommand, originResume, originGuard,
      activeRunCount, actionableCommandCount, activeTransactions] = await Promise.all([
      transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
      transaction.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
      transaction.provider_runs.findUnique({ where: { id: input.state.catalogRunId } }),
      transaction.control_commands.findUnique({ where: { id: ids.catalogRunCommandId } }),
      transaction.control_commands.findUnique({ where: { id: ids.catalogResumeCommandId } }),
      transaction.local_audit_events.findFirst({ where: {
        command_id: ids.catalogResumeCommandId, action: "provider.runtime.resume_guard",
      } }),
      transaction.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
      transaction.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
      transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
        "select count(*)::bigint as count from pg_stat_activity " +
        "where datname=current_database() and pid<>pg_backend_pid() and state<>'idle'"),
    ]);
    const exactOwnedLease = lease.lease_owner === input.policy.utility.workerId &&
      lease.heartbeat_at !== null && lease.lease_expires_at !== null;
    const exactReleasedLease = lease.lease_owner === null && lease.heartbeat_at === null &&
      lease.lease_expires_at === null;
    const originResult = storedResult(originResume?.result);
    const originDetails = originGuard?.details as Record<string, unknown> | null | undefined;
    const initialGuard: ProviderCatalogOriginResumeGuard = Object.freeze({
      entry: "paused_catalog_origin", providerId: definition.providerId,
      configVersionId: plan.catalog.id, configVersionNumber: BigInt(plan.catalog.versionNumber),
      runtimeRowVersion: initialPausedRowVersion,
      latestRunId: input.policy.current.latestTerminalRunId,
      latestRunDigest: input.policy.current.latestTerminalRunDigest,
      expectedImportLease: { owner: input.policy.utility.workerId, fence: 1n },
      checkpointHash: null, checkpoint: null, originReceiptDigest: input.originReceiptDigest,
      pauseCommandId: input.policy.current.pauseCommandId,
      pauseCommandDigest: input.policy.current.pauseCommandDigest,
    });
    if (run !== null || runCommand !== null || !originResume ||
      latest?.id !== input.policy.current.latestTerminalRunId ||
      providerResumeEvidenceDigest(latest) !== input.policy.current.latestTerminalRunDigest ||
      runtime.operating_state !== input.runtimeState ||
      runtime.cached_config_version_id !== plan.catalog.id ||
      runtime.cached_config_version_number !== BigInt(plan.catalog.versionNumber) ||
      runtime.source_cursor !== null || runtime.source_cursor_hash !== null ||
      activeRunCount !== 0 || actionableCommandCount !== 0 ||
      Number(activeTransactions[0]?.count ?? 0n) !== 0 ||
      (input.leaseState === "owned" ? !exactOwnedLease : !exactReleasedLease) ||
      originResume.id !== ids.catalogResumeCommandId ||
      originResume.command_type !== "resume" || originResume.state !== "completed" ||
      originResume.completed_at === null ||
      originResume.idempotency_key !== `catalog-bridge/${input.state.operationId}/catalog/resume` ||
      originResume.target_run_id !== null || originResume.target_quarantine_id !== null ||
      originResume.resulting_run_id !== null || originResume.reason !== null ||
      originResume.expected_generation !== initialPausedGeneration ||
      originResume.requested_by_operator_id !== input.policy.pins.operatorId ||
      originResume.correlation_id !== input.state.operationId ||
      originResult?.outcome !== "accepted" || originResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
      originResult.generation !== initialIdleGeneration.toString() ||
      originGuard?.outcome !== "success" ||
      originGuard.actor_operator_id !== input.policy.pins.operatorId ||
      originGuard.correlation_id !== input.state.operationId ||
      originGuard.target_type !== "control_command" || originGuard.target_id !== originResume.id ||
      originDetails?.guardDigest !== semanticGuardDigest(initialGuard)) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PREQUEUE_RECOVERY_UNPROVEN");
    }
    const idleGeneration = input.runtimeState === "idle"
      ? runtime.state_generation : runtime.state_generation - 1n;
    const generationDelta = idleGeneration - initialIdleGeneration;
    if (generationDelta < 0n || generationDelta % 2n !== 0n ||
      runtime.row_version !== initialPausedRowVersion +
        (runtime.state_generation - initialPausedGeneration)) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PREQUEUE_RECOVERY_UNPROVEN");
    }
    await proveCatalogPrequeueGenerationHistory({ database: transaction, policy: input.policy,
      state: input.state, originReceiptDigest: input.originReceiptDigest,
      targetIdleGeneration: idleGeneration });
    let recoveryPause = null;
    if (input.runtimeState === "paused") {
      const identity = catalogPrequeueRecoveryPauseIdentity(input.state, idleGeneration);
      recoveryPause = await transaction.control_commands.findUnique({ where: { id: identity.commandId } });
      const result = storedResult(recoveryPause?.result);
      if (!recoveryPause || recoveryPause.id !== identity.commandId ||
        recoveryPause.command_type !== "pause" || recoveryPause.state !== "completed" ||
        recoveryPause.completed_at === null || recoveryPause.idempotency_key !== identity.idempotencyKey ||
        recoveryPause.target_run_id !== null || recoveryPause.target_quarantine_id !== null ||
        recoveryPause.resulting_run_id !== null || recoveryPause.expected_generation !== idleGeneration ||
        recoveryPause.requested_by_operator_id !== input.policy.pins.operatorId ||
        recoveryPause.correlation_id !== input.state.operationId || recoveryPause.reason !== identity.reason ||
        result?.outcome !== "accepted" || result.code !== "RUNTIME_TRANSITION_APPLIED" ||
        result.generation !== runtime.state_generation.toString()) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PREQUEUE_RECOVERY_UNPROVEN");
      }
    }
    return Object.freeze({ runtime, originResume, recoveryPause, lease });
  }, PROVIDER_TRANSACTION);
}

async function resumeCatalogPrequeueAfterRecovery(input: Readonly<{
  database: ProviderPrismaClient;
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  originReceiptDigest: string;
  lease: Readonly<{ owner: string; fence: bigint; expiresAt: Date }>;
  now: () => Date;
}>): Promise<void> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const plan = catalogBridgeConfigurationPlan(input.state);
  const boundary = await readCatalogPrequeueRecoveryBoundary({ ...input,
    runtimeState: "paused", leaseState: "owned" });
  const pause = boundary.recoveryPause;
  if (!pause) refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PREQUEUE_RECOVERY_UNPROVEN");
  const identity = recoveryResumeIdentity(input.state, "catalog-prequeue",
    boundary.runtime.state_generation);
  const guard: ProviderCatalogOriginResumeGuard = Object.freeze({
    entry: "paused_catalog_origin", providerId: definition.providerId,
    configVersionId: plan.catalog.id, configVersionNumber: BigInt(plan.catalog.versionNumber),
    runtimeRowVersion: boundary.runtime.row_version,
    latestRunId: input.policy.current.latestTerminalRunId,
    latestRunDigest: input.policy.current.latestTerminalRunDigest,
    expectedImportLease: { owner: input.lease.owner, fence: input.lease.fence },
    checkpointHash: null, checkpoint: null, originReceiptDigest: input.originReceiptDigest,
    pauseCommandId: pause.id, pauseCommandDigest: pauseDigest(pause),
    notAfter: input.lease.expiresAt,
  });
  const result = await new PrismaAdminProviderRuntimeRepository(input.database).submitRuntimeCommand({
    commandId: identity.commandId, idempotencyKey: identity.idempotencyKey,
    commandType: "resume", expectedGeneration: boundary.runtime.state_generation,
    requestedByOperatorId: input.policy.pins.operatorId, correlationId: input.state.operationId,
    reason: identity.reason, requestedAt: input.now(), expectedRuntimeGuard: guard,
  });
  if (!["accepted", "deduplicated"].includes(result.outcome) || result.state !== "idle" ||
    result.generation !== boundary.runtime.state_generation + 1n) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PREQUEUE_RECOVERY_RESUME_REFUSED");
  }
  await readCatalogPrequeueRecoveryBoundary({ ...input,
    runtimeState: "idle", leaseState: "owned" });
}

/** Contiguous deterministic recovery transitions which explain a later worker-start generation. */
export async function proveCatalogRecoveryGenerationHistory(input: Readonly<{
  database: ProviderPrismaClient;
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  initialIdleGeneration: bigint;
  targetIdleGeneration: bigint;
}>): Promise<void> {
  const delta = input.targetIdleGeneration - input.initialIdleGeneration;
  if (delta < 0n || delta % 2n !== 0n) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_UNPROVEN");
  }
  for (let idleGeneration = input.initialIdleGeneration;
    idleGeneration < input.targetIdleGeneration; idleGeneration += 2n) {
    const pauseIdentity = catalogRecoveryPauseIdentity(input.state, idleGeneration);
    const resumeIdentity = recoveryResumeIdentity(input.state, "catalog-admission", idleGeneration + 1n);
    const [pause, resume, audit] = await Promise.all([
      input.database.control_commands.findUnique({ where: { id: pauseIdentity.commandId } }),
      input.database.control_commands.findUnique({ where: { id: resumeIdentity.commandId } }),
      input.database.local_audit_events.findFirst({ where: {
        command_id: resumeIdentity.commandId, action: "provider.runtime.resume_guard",
      } }),
    ]);
    const pauseResult = storedResult(pause?.result);
    const resumeResult = storedResult(resume?.result);
    const details = audit?.details as Record<string, unknown> | null | undefined;
    if (!pause || pause.id !== pauseIdentity.commandId ||
      pause.command_type !== "pause" || pause.state !== "completed" ||
      pause.completed_at === null || pause.idempotency_key !== pauseIdentity.idempotencyKey ||
      pause.target_run_id !== null || pause.target_quarantine_id !== null ||
      pause.resulting_run_id !== null || pause.expected_generation !== idleGeneration ||
      pause.requested_by_operator_id !== input.policy.pins.operatorId ||
      pause.correlation_id !== input.state.operationId || pause.reason !== pauseIdentity.reason ||
      pauseResult?.outcome !== "accepted" || pauseResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
      pauseResult.generation !== (idleGeneration + 1n).toString() ||
      !resume || resume.id !== resumeIdentity.commandId ||
      resume.command_type !== "resume" || resume.state !== "completed" ||
      resume.completed_at === null || resume.idempotency_key !== resumeIdentity.idempotencyKey ||
      resume.target_run_id !== null || resume.target_quarantine_id !== null ||
      resume.resulting_run_id !== null || resume.expected_generation !== idleGeneration + 1n ||
      resume.requested_by_operator_id !== input.policy.pins.operatorId ||
      resume.correlation_id !== input.state.operationId || resume.reason !== resumeIdentity.reason ||
      resumeResult?.outcome !== "accepted" || resumeResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
      resumeResult.generation !== (idleGeneration + 2n).toString() || audit?.outcome !== "success" ||
      audit.actor_operator_id !== input.policy.pins.operatorId ||
      audit.correlation_id !== input.state.operationId || audit.target_type !== "control_command" ||
      audit.target_id !== resume.id ||
      !/^[a-f0-9]{64}$/u.test(String(details?.guardDigest ?? ""))) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_UNPROVEN");
    }
  }
}

interface CatalogQueuedRecoveryBoundary {
  readonly runtime: Awaited<ReturnType<ProviderTransactionClient["provider_runtime"]["findUniqueOrThrow"]>>;
  readonly run: NonNullable<Awaited<ReturnType<ProviderTransactionClient["provider_runs"]["findUnique"]>>>;
  readonly runCommand: NonNullable<Awaited<ReturnType<ProviderTransactionClient["control_commands"]["findUnique"]>>>;
  readonly originResume: NonNullable<Awaited<ReturnType<ProviderTransactionClient["control_commands"]["findUnique"]>>>;
  readonly recoveryPause: Awaited<ReturnType<ProviderTransactionClient["control_commands"]["findUnique"]>>;
  readonly originResumeGuardDigest: string;
  readonly prequeueRecoveryChain: ProviderCatalogQueuedResumeGuard["prequeueRecoveryChain"];
  readonly lease: ImportLeaseRow;
}

/** Exact durable catalog queue that may be paused only by this operation's safety recovery. */
async function readCatalogQueuedRecoveryBoundary(input: Readonly<{
  database: ProviderPrismaClient;
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  originReceiptDigest: string;
  runtimeState: "idle" | "paused";
  leaseState: "owned" | "released";
}>): Promise<CatalogQueuedRecoveryBoundary> {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const ids = catalogBridgeCatalogOperationIds(input.policy.pins);
  return input.database.$transaction(async (transaction) => {
    const lease = await lockImportLease(transaction);
    await lockExactRun(transaction, input.state.catalogRunId);
    await lockRuntime(transaction);
    const [runtime, run, latest, runCommand, originResume, originGuard,
      activeRunCount, actionableCommandCount, activeTransactions] = await Promise.all([
      transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
      transaction.provider_runs.findUnique({ where: { id: input.state.catalogRunId } }),
      transaction.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
      transaction.control_commands.findUnique({ where: { id: ids.catalogRunCommandId } }),
      transaction.control_commands.findUnique({ where: { id: ids.catalogResumeCommandId } }),
      transaction.local_audit_events.findFirst({ where: {
        command_id: ids.catalogResumeCommandId, action: "provider.runtime.resume_guard",
      } }),
      transaction.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
      transaction.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
      transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
        "select count(*)::bigint as count from pg_stat_activity " +
        "where datname=current_database() and pid<>pg_backend_pid() and state<>'idle'"),
    ]);
    const runCommandResult = storedResult(runCommand?.result);
    const originResumeResult = storedResult(originResume?.result);
    const originDetails = originGuard?.details as Record<string, unknown> | null | undefined;
    const originGuardDigest = typeof originDetails?.guardDigest === "string"
      ? originDetails.guardDigest : "";
    const initialPausedGeneration = BigInt(input.policy.current.runtimeGeneration);
    const initialIdleGeneration = initialPausedGeneration + 1n;
    const runCommandGenerationText = runCommandResult?.generation ?? "";
    if (!/^[1-9][0-9]{0,18}$/u.test(runCommandGenerationText)) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_UNPROVEN");
    }
    const expectedRuntimeGeneration = BigInt(runCommandGenerationText);
    const exactOwnedLease = lease.lease_owner === input.policy.utility.workerId &&
      lease.heartbeat_at !== null && lease.lease_expires_at !== null;
    const exactReleasedLease = lease.lease_owner === null && lease.heartbeat_at === null &&
      lease.lease_expires_at === null;
    if (!run || latest?.id !== run.id || !runCommand || !originResume ||
      run.id !== input.state.catalogRunId || run.state !== "queued" || run.reached_source_head ||
      run.worker_fence !== 0n || run.control_command_id !== ids.catalogRunCommandId ||
      run.idempotency_key !== `command/${ids.catalogRunCommandId}` ||
      run.config_version_id !== plan.catalog.id ||
      run.config_version_number !== BigInt(plan.catalog.versionNumber) ||
      run.requested_cursor !== null || run.requested_cursor_hash !== null ||
      runtime.operating_state !== input.runtimeState ||
      runtime.cached_config_version_id !== plan.catalog.id ||
      runtime.cached_config_version_number !== BigInt(plan.catalog.versionNumber) ||
      runtime.source_cursor !== null || runtime.source_cursor_hash !== null ||
      activeRunCount !== 1 || actionableCommandCount !== 1 ||
      Number(activeTransactions[0]?.count ?? 0n) !== 0 ||
      (input.leaseState === "owned" ? !exactOwnedLease : !exactReleasedLease) ||
      runCommand.command_type !== "run" || runCommand.state !== "accepted" ||
      runCommand.idempotency_key !== `catalog-bridge/${input.state.operationId}/catalog/run` ||
      runCommand.target_run_id !== null || runCommand.target_quarantine_id !== null ||
      runCommand.resulting_run_id !== run.id ||
      runCommand.requested_by_operator_id !== input.policy.pins.operatorId ||
      runCommand.correlation_id !== input.state.operationId || runCommand.reason !== null ||
      runCommand.completed_at !== null ||
      runCommand.expected_generation !== expectedRuntimeGeneration ||
      runCommandResult?.outcome !== "accepted" || runCommandResult.code !== "COMMAND_ACCEPTED" ||
      runCommandResult.generation !== expectedRuntimeGeneration.toString() ||
      originResume.command_type !== "resume" || originResume.state !== "completed" ||
      originResume.idempotency_key !== `catalog-bridge/${input.state.operationId}/catalog/resume` ||
      originResume.target_run_id !== null || originResume.target_quarantine_id !== null ||
      originResume.resulting_run_id !== null || originResume.completed_at === null ||
      originResume.requested_by_operator_id !== input.policy.pins.operatorId ||
      originResume.correlation_id !== input.state.operationId || originResume.reason !== null ||
      originResume.expected_generation !== initialPausedGeneration ||
      originResumeResult?.outcome !== "accepted" ||
      originResumeResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
      originResumeResult.generation !== initialIdleGeneration.toString() ||
      originGuard?.outcome !== "success" ||
      originGuard.actor_operator_id !== input.policy.pins.operatorId ||
      originGuard.correlation_id !== input.state.operationId ||
      originGuard.target_type !== "control_command" || originGuard.target_id !== originResume.id) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_UNPROVEN");
    }
    const initialOriginGuard: ProviderCatalogOriginResumeGuard = Object.freeze({
      entry: "paused_catalog_origin", providerId: catalogBridgeProvider(input.state.providerKey).providerId,
      configVersionId: plan.catalog.id, configVersionNumber: BigInt(plan.catalog.versionNumber),
      runtimeRowVersion: BigInt(input.policy.current.runtimeRowVersion) + 1n,
      latestRunId: input.policy.current.latestTerminalRunId,
      latestRunDigest: input.policy.current.latestTerminalRunDigest,
      expectedImportLease: { owner: input.policy.utility.workerId, fence: 1n },
      checkpointHash: null, checkpoint: null, originReceiptDigest: input.originReceiptDigest,
      pauseCommandId: input.policy.current.pauseCommandId,
      pauseCommandDigest: input.policy.current.pauseCommandDigest,
    });
    if (originGuardDigest !== semanticGuardDigest(initialOriginGuard)) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_UNPROVEN");
    }
    const prequeueRecoveryChain = await proveCatalogPrequeueGenerationHistory({
      database: transaction, policy: input.policy,
      state: input.state, originReceiptDigest: input.originReceiptDigest,
      targetIdleGeneration: expectedRuntimeGeneration });
    const idleGeneration = input.runtimeState === "idle"
      ? runtime.state_generation : runtime.state_generation - 1n;
    const generationDelta = idleGeneration - expectedRuntimeGeneration;
    const baseIdleRowVersion = BigInt(input.policy.current.runtimeRowVersion) + 1n +
      (expectedRuntimeGeneration - initialPausedGeneration);
    if (idleGeneration < expectedRuntimeGeneration || generationDelta % 2n !== 0n ||
      runtime.row_version !== baseIdleRowVersion +
        (runtime.state_generation - expectedRuntimeGeneration)) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_UNPROVEN");
    }
    for (let cycleIdleGeneration = expectedRuntimeGeneration;
      cycleIdleGeneration < idleGeneration; cycleIdleGeneration += 2n) {
      const cyclePauseIdentity = catalogRecoveryPauseIdentity(input.state, cycleIdleGeneration);
      const cycleResumeIdentity = recoveryResumeIdentity(input.state, "catalog-admission",
        cycleIdleGeneration + 1n);
      const [cyclePause, cycleResume, cycleGuard] = await Promise.all([
        transaction.control_commands.findUnique({ where: { id: cyclePauseIdentity.commandId } }),
        transaction.control_commands.findUnique({ where: { id: cycleResumeIdentity.commandId } }),
        transaction.local_audit_events.findFirst({ where: {
          command_id: cycleResumeIdentity.commandId, action: "provider.runtime.resume_guard",
        } }),
      ]);
      const cyclePauseResult = storedResult(cyclePause?.result);
      const cycleResumeResult = storedResult(cycleResume?.result);
      const cycleDetails = cycleGuard?.details as Record<string, unknown> | null | undefined;
      if (!cyclePause || !cycleResume || cyclePause.completed_at === null ||
        cyclePause.command_type !== "pause" || cyclePause.state !== "completed" ||
        cyclePause.idempotency_key !== cyclePauseIdentity.idempotencyKey ||
        cyclePause.target_run_id !== null || cyclePause.target_quarantine_id !== null ||
        cyclePause.resulting_run_id !== null || cyclePause.expected_generation !== cycleIdleGeneration ||
        cyclePause.requested_by_operator_id !== input.policy.pins.operatorId ||
        cyclePause.correlation_id !== input.state.operationId || cyclePause.reason !== cyclePauseIdentity.reason ||
        cyclePauseResult?.outcome !== "accepted" || cyclePauseResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
        cyclePauseResult.generation !== (cycleIdleGeneration + 1n).toString()) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_UNPROVEN");
      }
      const historicalGuard: ProviderCatalogQueuedResumeGuard = Object.freeze({
        entry: "paused_catalog_queued", providerId: catalogBridgeProvider(input.state.providerKey).providerId,
        configVersionId: plan.catalog.id, configVersionNumber: BigInt(plan.catalog.versionNumber),
        runtimeRowVersion: baseIdleRowVersion +
          (cycleIdleGeneration - expectedRuntimeGeneration) + 1n,
        checkpointHash: null, checkpoint: null,
        latestRunId: run.id, latestRunDigest: providerResumeEvidenceDigest(run),
        pauseCommandId: cyclePause.id, pauseCommandDigest: providerResumeEvidenceDigest(cyclePause),
        runCommandId: runCommand.id, runCommandIdempotencyKey: runCommand.idempotency_key,
        originResumeCommandId: originResume.id,
        originResumeIdempotencyKey: originResume.idempotency_key,
        originResumeGuardDigest: originGuardDigest,
        prequeueRecoveryChain,
        expectedImportLease: { owner: input.policy.utility.workerId, fence: 1n },
      });
      if (cycleResume.command_type !== "resume" || cycleResume.state !== "completed" ||
        cycleResume.completed_at === null || cycleResume.idempotency_key !== cycleResumeIdentity.idempotencyKey ||
        cycleResume.target_run_id !== null || cycleResume.target_quarantine_id !== null ||
        cycleResume.resulting_run_id !== null ||
        cycleResume.expected_generation !== cycleIdleGeneration + 1n ||
        cycleResume.requested_by_operator_id !== input.policy.pins.operatorId ||
        cycleResume.correlation_id !== input.state.operationId || cycleResume.reason !== cycleResumeIdentity.reason ||
        cycleResumeResult?.outcome !== "accepted" ||
        cycleResumeResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
        cycleResumeResult.generation !== (cycleIdleGeneration + 2n).toString() ||
        cycleGuard?.outcome !== "success" ||
        cycleGuard.actor_operator_id !== input.policy.pins.operatorId ||
        cycleGuard.correlation_id !== input.state.operationId ||
        cycleGuard.target_type !== "control_command" || cycleGuard.target_id !== cycleResume.id ||
        cycleDetails?.guardDigest !== semanticGuardDigest(historicalGuard)) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_UNPROVEN");
      }
    }
    let recoveryPause = null;
    if (input.runtimeState === "paused") {
      const identity = catalogRecoveryPauseIdentity(input.state, idleGeneration);
      recoveryPause = await transaction.control_commands.findUnique({ where: { id: identity.commandId } });
      const pauseResult = storedResult(recoveryPause?.result);
      if (!recoveryPause || !recoveryPause.completed_at ||
        runtime.state_generation !== idleGeneration + 1n ||
        recoveryPause.command_type !== "pause" || recoveryPause.state !== "completed" ||
        recoveryPause.idempotency_key !== identity.idempotencyKey ||
        recoveryPause.target_run_id !== null || recoveryPause.target_quarantine_id !== null ||
        recoveryPause.resulting_run_id !== null ||
        recoveryPause.expected_generation !== idleGeneration ||
        recoveryPause.requested_by_operator_id !== input.policy.pins.operatorId ||
        recoveryPause.correlation_id !== input.state.operationId ||
        recoveryPause.reason !== identity.reason || pauseResult?.outcome !== "accepted" ||
        pauseResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
        pauseResult.generation !== runtime.state_generation.toString()) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_UNPROVEN");
      }
    }
    return Object.freeze({ runtime, run, runCommand, originResume, recoveryPause,
      originResumeGuardDigest: originGuardDigest, prequeueRecoveryChain, lease });
  }, PROVIDER_TRANSACTION);
}

async function resumeCatalogQueuedAfterRecovery(input: Readonly<{
  database: ProviderPrismaClient;
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  originReceiptDigest: string;
  lease: Readonly<{ owner: string; fence: bigint; expiresAt: Date }>;
  now: () => Date;
}>): Promise<void> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const plan = catalogBridgeConfigurationPlan(input.state);
  const boundary = await readCatalogQueuedRecoveryBoundary({ ...input,
    runtimeState: "paused", leaseState: "owned" });
  const pause = boundary.recoveryPause;
  if (!pause) refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_UNPROVEN");
  const originGuard: ProviderCatalogOriginResumeGuard = Object.freeze({
    entry: "paused_catalog_origin", providerId: definition.providerId,
    configVersionId: plan.catalog.id, configVersionNumber: BigInt(plan.catalog.versionNumber),
    runtimeRowVersion: BigInt(input.policy.current.runtimeRowVersion) + 1n,
    latestRunId: input.policy.current.latestTerminalRunId,
    latestRunDigest: input.policy.current.latestTerminalRunDigest,
    expectedImportLease: { owner: input.lease.owner, fence: input.lease.fence },
    checkpointHash: null, checkpoint: null, originReceiptDigest: input.originReceiptDigest,
    pauseCommandId: input.policy.current.pauseCommandId,
    pauseCommandDigest: input.policy.current.pauseCommandDigest,
    notAfter: input.lease.expiresAt,
  });
  if (boundary.originResumeGuardDigest !== semanticGuardDigest(originGuard)) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_UNPROVEN");
  }
  const identity = recoveryResumeIdentity(input.state, "catalog-admission",
    boundary.runtime.state_generation);
  const guard: ProviderCatalogQueuedResumeGuard = Object.freeze({
    entry: "paused_catalog_queued", providerId: definition.providerId,
    configVersionId: plan.catalog.id, configVersionNumber: BigInt(plan.catalog.versionNumber),
    runtimeRowVersion: boundary.runtime.row_version, checkpointHash: null, checkpoint: null,
    latestRunId: boundary.run.id, latestRunDigest: providerResumeEvidenceDigest(boundary.run),
    pauseCommandId: pause.id, pauseCommandDigest: providerResumeEvidenceDigest(pause),
    runCommandId: boundary.runCommand.id,
    runCommandIdempotencyKey: boundary.runCommand.idempotency_key,
    originResumeCommandId: boundary.originResume.id,
    originResumeIdempotencyKey: boundary.originResume.idempotency_key,
    originResumeGuardDigest: boundary.originResumeGuardDigest,
    prequeueRecoveryChain: boundary.prequeueRecoveryChain,
    expectedImportLease: { owner: input.lease.owner, fence: input.lease.fence },
    notAfter: input.lease.expiresAt,
  });
  const result = await new PrismaAdminProviderRuntimeRepository(input.database).submitRuntimeCommand({
    commandId: identity.commandId, idempotencyKey: identity.idempotencyKey,
    commandType: "resume", expectedGeneration: boundary.runtime.state_generation,
    requestedByOperatorId: input.policy.pins.operatorId, correlationId: input.state.operationId,
    reason: identity.reason, requestedAt: input.now(), expectedRuntimeGuard: guard,
  });
  if (!["accepted", "deduplicated"].includes(result.outcome) || result.state !== "idle" ||
    result.generation !== boundary.runtime.state_generation + 1n) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_RESUME_REFUSED");
  }
  const [durable, audit, runtime] = await Promise.all([
    input.database.control_commands.findUnique({ where: { id: identity.commandId } }),
    input.database.local_audit_events.findFirst({ where: {
      command_id: identity.commandId, action: "provider.runtime.resume_guard",
    } }),
    input.database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
  ]);
  const durableResult = storedResult(durable?.result);
  const details = audit?.details as Record<string, unknown> | null | undefined;
  if (!durable || durable.command_type !== "resume" || durable.state !== "completed" ||
    durable.completed_at === null || durable.target_run_id !== null ||
    durable.target_quarantine_id !== null || durable.resulting_run_id !== null ||
    durable.idempotency_key !== identity.idempotencyKey ||
    durable.requested_by_operator_id !== input.policy.pins.operatorId ||
    durable.correlation_id !== input.state.operationId || durable.reason !== identity.reason ||
    durable.expected_generation !== boundary.runtime.state_generation ||
    durableResult?.outcome !== "accepted" || durableResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
    durableResult.generation !== (boundary.runtime.state_generation + 1n).toString() ||
    audit?.outcome !== "success" || audit.actor_operator_id !== input.policy.pins.operatorId ||
    audit.correlation_id !== input.state.operationId || audit.target_type !== "control_command" ||
    audit.target_id !== durable.id || details?.guardDigest !== semanticGuardDigest(guard) ||
    runtime.operating_state !== "idle" ||
    runtime.state_generation !== boundary.runtime.state_generation + 1n ||
    runtime.row_version !== boundary.runtime.row_version + 1n) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_RESUME_UNPROVEN");
  }
}

async function admitCatalogRun(input: Readonly<{
  central: CentralPrismaClient; runProvider: CatalogBridgeCatalogLiveDatabaseDependencies["runProvider"];
  policy: CatalogBridgeCatalogLivePolicy; state: CatalogBridgePrivatePreparedState;
  originReceiptDigest: string; now: () => Date;
}>): Promise<CatalogBridgeCatalogRunAdmissionObservation> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const plan = catalogBridgeConfigurationPlan(input.state);
  const ids = catalogBridgeCatalogOperationIds(input.policy.pins);
  const boundary = await readCentralBoundary(input);
  assertCentralShape({ boundary, ...input, allowCatalog: true });
  if (boundary.provider?.active_config_version_id !== plan.catalog.id ||
    boundary.provider.row_version !== BigInt(input.policy.current.providerRowVersion) + 1n) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ADMISSION_AUTHORITY_CHANGED");
  }
  return reachable(await input.runProvider(boundary.route, async (database) => {
    const leases = new PrismaProviderWorkerLeaseRepository(database);
    const acquired = await leases.acquire({ role: "import", owner: input.policy.utility.workerId,
      leaseMilliseconds: input.policy.utility.leaseMilliseconds });
    if (acquired.kind === "held") refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_UTILITY_LEASE_HELD");
    const lease = acquired.lease;
    const admin = new PrismaAdminProviderRuntimeRepository(database);
    let runtimeBefore = await database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
    const existingRun = await database.provider_runs.findUnique({ where: { id: input.state.catalogRunId } });
    const existingResume = await admin.getRuntimeCommand(ids.catalogResumeCommandId);
    let resumeCommand = existingResume;
    const expectedPausedGeneration = BigInt(input.policy.current.runtimeGeneration);
    const expectedPausedRowVersion = BigInt(input.policy.current.runtimeRowVersion) + 1n;
    const originGuard: ProviderCatalogOriginResumeGuard = Object.freeze({
      entry: "paused_catalog_origin", providerId: definition.providerId,
      configVersionId: plan.catalog.id, configVersionNumber: BigInt(plan.catalog.versionNumber),
      runtimeRowVersion: expectedPausedRowVersion,
      latestRunId: input.policy.current.latestTerminalRunId,
      latestRunDigest: input.policy.current.latestTerminalRunDigest,
      expectedImportLease: { owner: input.policy.utility.workerId, fence: lease.fence },
      checkpointHash: null, checkpoint: null, originReceiptDigest: input.originReceiptDigest,
      pauseCommandId: input.policy.current.pauseCommandId,
      pauseCommandDigest: input.policy.current.pauseCommandDigest,
      notAfter: lease.expiresAt,
    });
    if (existingRun?.state === "queued" && runtimeBefore.operating_state === "paused") {
      await resumeCatalogQueuedAfterRecovery({ database, policy: input.policy, state: input.state,
        originReceiptDigest: input.originReceiptDigest, lease, now: input.now });
    } else if (existingRun?.state === "queued" && runtimeBefore.operating_state === "idle") {
      await readCatalogQueuedRecoveryBoundary({ database, policy: input.policy, state: input.state,
        originReceiptDigest: input.originReceiptDigest,
        runtimeState: "idle", leaseState: "owned" });
    }
    if (existingRun === null && resumeCommand !== null && runtimeBefore.operating_state === "paused") {
      await resumeCatalogPrequeueAfterRecovery({ database, policy: input.policy, state: input.state,
        originReceiptDigest: input.originReceiptDigest, lease, now: input.now });
      runtimeBefore = await database.provider_runtime.findUniqueOrThrow({
        where: { singleton_key: true },
      });
    } else if (existingRun === null && resumeCommand !== null &&
      runtimeBefore.operating_state === "idle") {
      await readCatalogPrequeueRecoveryBoundary({ database, policy: input.policy, state: input.state,
        originReceiptDigest: input.originReceiptDigest, runtimeState: "idle", leaseState: "owned" });
    }
    if (existingRun === null) {
      const resumedGenerationDelta = runtimeBefore.state_generation - (expectedPausedGeneration + 1n);
      if (runtimeBefore.cached_config_version_id !== plan.catalog.id ||
        runtimeBefore.cached_config_version_number !== BigInt(plan.catalog.versionNumber) ||
        runtimeBefore.source_cursor !== null || runtimeBefore.source_cursor_hash !== null ||
        (resumeCommand === null
          ? runtimeBefore.operating_state !== "paused" ||
            runtimeBefore.state_generation !== expectedPausedGeneration ||
            runtimeBefore.row_version !== expectedPausedRowVersion
          : runtimeBefore.operating_state !== "idle" ||
            resumedGenerationDelta < 0n || resumedGenerationDelta % 2n !== 0n ||
            runtimeBefore.row_version !== expectedPausedRowVersion + 1n + resumedGenerationDelta)) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_NULL_ORIGIN_CHANGED");
      }
      if (resumeCommand === null) {
        const result = await admin.submitRuntimeCommand({
          commandId: ids.catalogResumeCommandId,
          idempotencyKey: "catalog-bridge/" + input.state.operationId + "/catalog/resume",
          commandType: "resume", expectedGeneration: runtimeBefore.state_generation,
          requestedByOperatorId: input.policy.pins.operatorId,
          correlationId: input.state.operationId, reason: null, requestedAt: input.now(),
          expectedRuntimeGuard: originGuard,
        });
        if (!["accepted", "deduplicated"].includes(result.outcome) ||
          result.code !== "RUNTIME_TRANSITION_APPLIED") {
          refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_NULL_ORIGIN_RESUME_REFUSED");
        }
        resumeCommand = await admin.getRuntimeCommand(ids.catalogResumeCommandId);
      }
      const guardAudit = await database.local_audit_events.findFirst({ where: {
        command_id: ids.catalogResumeCommandId, action: "provider.runtime.resume_guard" } });
      const details = guardAudit?.details as Record<string, unknown> | null | undefined;
      if (!resumeCommand || resumeCommand.commandType !== "resume" ||
        resumeCommand.state !== "completed" || resumeCommand.completedAt === null ||
        resumeCommand.idempotencyKey !== `catalog-bridge/${input.state.operationId}/catalog/resume` ||
        resumeCommand.targetRunId !== null || resumeCommand.targetQuarantineId !== null ||
        resumeCommand.resultingRunId !== null || resumeCommand.reason !== null ||
        resumeCommand.requestedByOperatorId !== input.policy.pins.operatorId ||
        resumeCommand.correlationId !== input.state.operationId ||
        resumeCommand.expectedGeneration !== expectedPausedGeneration ||
        resumeCommand.result?.outcome !== "accepted" ||
        resumeCommand.result.code !== "RUNTIME_TRANSITION_APPLIED" ||
        resumeCommand.result.generation !== (expectedPausedGeneration + 1n).toString() ||
        guardAudit?.outcome !== "success" ||
        guardAudit.actor_operator_id !== input.policy.pins.operatorId ||
        guardAudit.correlation_id !== input.state.operationId ||
        guardAudit.target_type !== "control_command" ||
        guardAudit.target_id !== ids.catalogResumeCommandId ||
        details?.guardDigest !== semanticGuardDigest(originGuard)) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_NULL_ORIGIN_GUARD_UNPROVEN");
      }
      const runtimeAfterResume = await database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
      const queued = await admin.requestRunNow({ providerId: definition.providerId,
        operatorId: input.policy.pins.operatorId, expectedConfigVersionId: plan.catalog.id,
        expectedConfigVersionNumber: BigInt(plan.catalog.versionNumber),
        expectedGeneration: runtimeAfterResume.state_generation,
        idempotencyKey: "catalog-bridge/" + input.state.operationId + "/catalog/run",
        commandId: ids.catalogRunCommandId, runId: input.state.catalogRunId,
        correlationId: input.state.operationId, expectedCursorFingerprint: null,
        requireNoActiveRun: true,
        expectedImportLease: { owner: input.policy.utility.workerId, fence: lease.fence },
        notAfter: lease.expiresAt });
      if (queued.kind !== "created" && queued.kind !== "deduplicated") {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_DETERMINISTIC_QUEUE_REFUSED");
      }
      if (queued.run.id !== input.state.catalogRunId) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_DETERMINISTIC_QUEUE_REFUSED");
      }
    }
    const [run, runtime, runCommand, guardAudit, postCatalogPause] = await Promise.all([
      database.provider_runs.findUnique({ where: { id: input.state.catalogRunId } }),
      database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
      admin.getRuntimeCommand(ids.catalogRunCommandId),
      database.local_audit_events.findFirst({ where: {
        command_id: ids.catalogResumeCommandId, action: "provider.runtime.resume_guard" } }),
      database.control_commands.findUnique({ where: { id: ids.postCatalogPauseCommandId } }),
    ]);
    resumeCommand ??= await admin.getRuntimeCommand(ids.catalogResumeCommandId);
    if (!run || !resumeCommand || !runCommand) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ADMISSION_EVIDENCE_CHANGED");
    }
    if (!["queued", "running", "succeeded"].includes(run.state)) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ADMISSION_EVIDENCE_CHANGED");
    }
    const guardDetails = guardAudit?.details as Record<string, unknown> | null | undefined;
    const pausedOriginGuardDigest = typeof guardDetails?.guardDigest === "string"
      ? guardDetails.guardDigest : "";
    const runCommandResultCode = run.state === "queued" ? "COMMAND_ACCEPTED" : "RUN_STARTED";
    const resultGenerationText = runCommand.result?.generation ?? "";
    if (!/^[1-9][0-9]{0,18}$/u.test(resultGenerationText)) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ADMISSION_EVIDENCE_CHANGED");
    }
    const runCommandResultGeneration = BigInt(resultGenerationText);
    await proveCatalogPrequeueGenerationHistory({ database, policy: input.policy, state: input.state,
      originReceiptDigest: input.originReceiptDigest,
      targetIdleGeneration: runCommand.expectedGeneration });
    if (run.state !== "queued") {
      await proveCatalogRecoveryGenerationHistory({ database, policy: input.policy, state: input.state,
        initialIdleGeneration: runCommand.expectedGeneration,
        targetIdleGeneration: runCommandResultGeneration - 1n });
    }
    const postPauseResult = storedResult(postCatalogPause?.result);
    const exactSucceededPause = runtime.operating_state !== "paused" ||
      (!!postCatalogPause && postCatalogPause.command_type === "pause" &&
        postCatalogPause.state === "completed" && postCatalogPause.completed_at !== null &&
        postCatalogPause.idempotency_key ===
          `catalog-bridge/${input.state.operationId}/post-catalog/pause` &&
        postCatalogPause.target_run_id === null && postCatalogPause.target_quarantine_id === null &&
        postCatalogPause.resulting_run_id === null &&
        postCatalogPause.expected_generation === runCommandResultGeneration + 1n &&
        postCatalogPause.requested_by_operator_id === input.policy.pins.operatorId &&
        postCatalogPause.correlation_id === input.state.operationId &&
        postCatalogPause.reason ===
          `DataForrest ${input.state.providerKey} catalog bridge post-catalog pause` &&
        postPauseResult?.outcome === "accepted" && postPauseResult.code === "RUNTIME_TRANSITION_APPLIED" &&
        postPauseResult.generation === (runCommandResultGeneration + 2n).toString());
    if (run.control_command_id !== ids.catalogRunCommandId ||
      run.idempotency_key !== `command/${ids.catalogRunCommandId}` ||
      run.config_version_id !== plan.catalog.id ||
      run.config_version_number !== BigInt(plan.catalog.versionNumber) ||
      run.requested_cursor !== null || run.requested_cursor_hash !== null ||
      !["queued", "running", "succeeded"].includes(run.state) ||
      (run.state === "queued" && runtime.operating_state !== "idle") ||
      (run.state === "running" && runtime.operating_state !== "running") ||
      (run.state === "succeeded" && !["idle", "paused"].includes(runtime.operating_state)) ||
      (run.state === "queued" && runCommandResultGeneration !== runCommand.expectedGeneration) ||
      (run.state === "running" && runtime.state_generation !== runCommandResultGeneration) ||
      (run.state === "succeeded" && runtime.operating_state === "idle" &&
        runtime.state_generation !== runCommandResultGeneration + 1n) ||
      (run.state === "succeeded" && runtime.operating_state === "paused" &&
        runtime.state_generation !== runCommandResultGeneration + 2n) ||
      !exactSucceededPause ||
      resumeCommand.commandType !== "resume" || resumeCommand.state !== "completed" ||
      resumeCommand.completedAt === null ||
      resumeCommand.idempotencyKey !== `catalog-bridge/${input.state.operationId}/catalog/resume` ||
      resumeCommand.targetRunId !== null || resumeCommand.targetQuarantineId !== null ||
      resumeCommand.resultingRunId !== null || resumeCommand.reason !== null ||
      resumeCommand.requestedByOperatorId !== input.policy.pins.operatorId ||
      resumeCommand.correlationId !== input.state.operationId ||
      resumeCommand.expectedGeneration !== expectedPausedGeneration ||
      resumeCommand.result?.outcome !== "accepted" ||
      resumeCommand.result.code !== "RUNTIME_TRANSITION_APPLIED" ||
      resumeCommand.result.generation !== (expectedPausedGeneration + 1n).toString() ||
      runCommand.commandType !== "run" || runCommand.resultingRunId !== run.id ||
      runCommand.state !== (run.state === "queued" ? "accepted" : "completed") ||
      runCommand.idempotencyKey !== `catalog-bridge/${input.state.operationId}/catalog/run` ||
      runCommand.targetRunId !== null || runCommand.targetQuarantineId !== null ||
      runCommand.reason !== null || runCommand.requestedByOperatorId !== input.policy.pins.operatorId ||
      runCommand.correlationId !== input.state.operationId ||
      (run.state === "queued" ? runCommand.completedAt !== null : runCommand.completedAt === null) ||
      runCommand.result?.outcome !== "accepted" || runCommand.result.code !== runCommandResultCode ||
      runCommand.result.generation !== resultGenerationText ||
      guardAudit?.outcome !== "success" ||
      guardAudit.actor_operator_id !== input.policy.pins.operatorId ||
      guardAudit.correlation_id !== input.state.operationId ||
      guardAudit.target_type !== "control_command" || guardAudit.target_id !== resumeCommand.id ||
      pausedOriginGuardDigest !== semanticGuardDigest(originGuard)) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_ADMISSION_EVIDENCE_CHANGED");
    }
    const originalFence = run.worker_fence > 0n ? run.worker_fence : lease.fence;
    if (run.state === "running" && run.worker_fence !== lease.fence) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_UTILITY_LEASE_LOST");
    }
    if (run.state === "succeeded") {
      if (!["idle", "paused"].includes(runtime.operating_state) || !await leases.release({ role: "import",
        owner: input.policy.utility.workerId, fence: lease.fence })) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_UTILITY_LEASE_LOST");
      }
      const released = await database.provider_worker_states.findUniqueOrThrow({
        where: { worker_role: "import" },
      });
      if (released.lease_owner !== null || released.heartbeat_at !== null ||
        released.lease_expires_at !== null) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_UTILITY_LEASE_LOST");
      }
    }
    return Object.freeze({ observedAt: run.requested_at.toISOString(), runtimeState: "idle" as const,
      runtimeGeneration: resumeCommand.result!.generation,
      activeConfigId: plan.catalog.id, cachedConfigId: plan.catalog.id,
      sourceCursorPresent: false as const, sourceCursorHash: null,
      resumeCommandId: resumeCommand.id, resumeCommandDigest: runtimeCommandDigest(resumeCommand),
      resumeCommandType: "resume" as const, resumeCommandState: "completed" as const,
      resumeExpectedGeneration: resumeCommand.expectedGeneration.toString(),
      resumeResultGeneration: resumeCommand.result!.generation, pausedOriginGuardDigest,
      catalogRunId: run.id, catalogRunState: "queued" as const,
      catalogRunConfigId: run.config_version_id,
      catalogRunConfigNumber: Number(run.config_version_number),
      catalogRunRequestedCursorHash: null,
      requestRunCommandId: runCommand.id,
      requestRunCommandDigest: runtimeCommandDigest(runCommand),
      utilityLeaseDigest: catalogBridgeDigest({ owner: input.policy.utility.workerId,
        fence: originalFence.toString() }) });
  }));
}

interface TranslationAuditRow {
  readonly page_number: bigint;
  readonly continuation: "more" | "head";
  readonly stored_response_digest: string;
  readonly census_version: string | null;
  readonly page_response_digest: string | null;
  readonly raw_cards: bigint | null;
  readonly raw_packs: bigint | null;
  readonly distinct_cards: bigint | null;
  readonly distinct_packs: bigint | null;
  readonly identity_chain_digest: string | null;
  readonly page_identity_multiset_digest: string | null;
  readonly identity_multiset_digest: string | null;
  readonly source_records: bigint | null;
  readonly normalized_records: bigint | null;
  readonly catalog: bigint | null;
  readonly cards: bigint | null;
  readonly pack_content_snapshots: bigint | null;
  readonly pulls: bigint | null;
  readonly market_events: bigint | null;
  readonly rejected: bigint | null;
}

interface CatalogTranslationProof {
  readonly sourceRecordCount: number;
  readonly catalogRecordCount: number;
  readonly pullRecordCount: number;
  readonly marketEventRecordCount: number;
  readonly rejectedRecordCount: number;
  readonly rawCardObservationCount: number;
  readonly rawPackObservationCount: number;
  readonly distinctCardIdentityCount: number;
  readonly distinctPackIdentityCount: number;
  readonly identityChainDigest: string;
  readonly identityMultisetDigest: string;
}

type CatalogHeadWithoutCanonical = Omit<CatalogBridgeHeadObservation, "canonicalAfter">;

type CatalogHeadShortBoundary = Readonly<{ kind: "pending" }> | Readonly<{
  kind: "succeeded";
  observation: CatalogHeadWithoutCanonical;
  stabilityDigest: string;
}>;

function safeCatalogCount(value: bigint | null | undefined): number {
  if (value === null || value === undefined) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_HEAD_EVIDENCE_CHANGED");
  }
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_COUNT_OUT_OF_RANGE");
  }
  return Number(value);
}

function addCatalogCounts(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_COUNT_OUT_OF_RANGE");
  }
  return sum;
}

export function catalogTranslationProof(
  rows: readonly TranslationAuditRow[],
  pageCount: number,
): CatalogTranslationProof {
  if (rows.length !== pageCount || rows.length < 1) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_HEAD_EVIDENCE_CHANGED");
  }
  let sourceRecordCount = 0;
  let catalogRecordCount = 0;
  let pullRecordCount = 0;
  let marketEventRecordCount = 0;
  let rejectedRecordCount = 0;
  let previousRawCards = 0;
  let previousRawPacks = 0;
  let previousDistinctCards = 0;
  let previousDistinctPacks = 0;
  let previousChainDigest: string | null = null;
  let finalCensus: ProviderCatalogIdentityCensus | null = null;
  for (const [index, row] of rows.entries()) {
    const pageNumber = safeCatalogCount(row.page_number);
    const census = providerCatalogIdentityCensusSchema.safeParse({
      schemaVersion: row.census_version,
      pageResponseDigest: row.page_response_digest,
      rawCardObservationCount: safeCatalogCount(row.raw_cards),
      rawPackObservationCount: safeCatalogCount(row.raw_packs),
      distinctCardIdentityCount: safeCatalogCount(row.distinct_cards),
      distinctPackIdentityCount: safeCatalogCount(row.distinct_packs),
      identityChainDigest: row.identity_chain_digest,
      pageIdentityMultisetDigest: row.page_identity_multiset_digest,
      identityMultisetDigest: row.identity_multiset_digest,
    });
    if (!census.success) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_HEAD_EVIDENCE_CHANGED");
    }
    const pageSourceRecords = safeCatalogCount(row.source_records);
    const pageNormalizedRecords = safeCatalogCount(row.normalized_records);
    const pageCatalogRecords = safeCatalogCount(row.catalog);
    const pageCardRecords = safeCatalogCount(row.cards);
    const pagePackContentSnapshots = safeCatalogCount(
      row.pack_content_snapshots,
    );
    const pagePullRecords = safeCatalogCount(row.pulls);
    const pageMarketEventRecords = safeCatalogCount(row.market_events);
    const pageRejectedRecords = safeCatalogCount(row.rejected);
    const rawCardDelta = census.data.rawCardObservationCount - previousRawCards;
    const rawPackDelta = census.data.rawPackObservationCount - previousRawPacks;
    const distinctCardDelta = census.data.distinctCardIdentityCount - previousDistinctCards;
    const distinctPackDelta = census.data.distinctPackIdentityCount - previousDistinctPacks;
    const finalPage = index === rows.length - 1;
    if (pageNumber !== index + 1 ||
      row.continuation !== (finalPage ? "head" : "more") ||
      row.census_version !== PROVIDER_CATALOG_IDENTITY_CENSUS_VERSION ||
      row.stored_response_digest !== census.data.pageResponseDigest ||
      rawCardDelta < 0 || rawPackDelta < 0 || distinctCardDelta < 0 || distinctPackDelta < 0 ||
      distinctCardDelta > rawCardDelta || distinctPackDelta > rawPackDelta ||
      pageRejectedRecords !== 0 || pagePullRecords !== 0 || pageMarketEventRecords !== 0 ||
      pageSourceRecords !== addCatalogCounts(rawCardDelta, rawPackDelta) ||
      pageNormalizedRecords !== pageCatalogRecords ||
      pageCardRecords !== rawCardDelta ||
      pagePackContentSnapshots > rawPackDelta ||
      pageCatalogRecords < addCatalogCounts(rawCardDelta, rawPackDelta) ||
      (finalPage ? census.data.identityMultisetDigest === null :
        census.data.identityMultisetDigest !== null) ||
      census.data.identityChainDigest !== providerCatalogIdentityChainDigest({
        previousChainDigest,
        pageNumber,
        pageResponseDigest: census.data.pageResponseDigest,
        pageIdentityMultisetDigest: census.data.pageIdentityMultisetDigest,
      })) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_HEAD_EVIDENCE_CHANGED");
    }
    sourceRecordCount = addCatalogCounts(sourceRecordCount, pageSourceRecords);
    catalogRecordCount = addCatalogCounts(catalogRecordCount, pageCatalogRecords);
    pullRecordCount = addCatalogCounts(pullRecordCount, pagePullRecords);
    marketEventRecordCount = addCatalogCounts(marketEventRecordCount, pageMarketEventRecords);
    rejectedRecordCount = addCatalogCounts(rejectedRecordCount, pageRejectedRecords);
    previousRawCards = census.data.rawCardObservationCount;
    previousRawPacks = census.data.rawPackObservationCount;
    previousDistinctCards = census.data.distinctCardIdentityCount;
    previousDistinctPacks = census.data.distinctPackIdentityCount;
    previousChainDigest = census.data.identityChainDigest;
    finalCensus = census.data;
  }
  if (finalCensus === null || finalCensus.identityMultisetDigest === null ||
    sourceRecordCount !== addCatalogCounts(finalCensus.rawCardObservationCount,
      finalCensus.rawPackObservationCount)) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_HEAD_EVIDENCE_CHANGED");
  }
  return Object.freeze({ sourceRecordCount, catalogRecordCount,
    pullRecordCount, marketEventRecordCount, rejectedRecordCount,
    rawCardObservationCount: finalCensus.rawCardObservationCount,
    rawPackObservationCount: finalCensus.rawPackObservationCount,
    distinctCardIdentityCount: finalCensus.distinctCardIdentityCount,
    distinctPackIdentityCount: finalCensus.distinctPackIdentityCount,
    identityChainDigest: finalCensus.identityChainDigest,
    identityMultisetDigest: finalCensus.identityMultisetDigest });
}

/**
 * Reads only the operational catalog boundary while holding locks. The lock
 * order is import lease -> exact catalog run -> runtime. Fact-table census is
 * deliberately excluded so no long scan can retain an operational lock.
 */
async function readCatalogHeadShortBoundary(input: Readonly<{
  database: ProviderPrismaClient; policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
}>): Promise<CatalogHeadShortBoundary> {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const ids = catalogBridgeCatalogOperationIds(input.policy.pins);
  return input.database.$transaction(async (transaction) => {
    const lease = await lockImportLease(transaction);
    await lockExactRun(transaction, input.state.catalogRunId);
    await lockRuntime(transaction);
    const [runtime, run, latest, runCommand, activeRunCount, actionableCommandCount, quarantineCount,
      translated, activeTransactions] = await Promise.all([
      transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
      transaction.provider_runs.findUnique({ where: { id: input.state.catalogRunId } }),
      transaction.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
      transaction.control_commands.findUnique({ where: { id: ids.catalogRunCommandId } }),
      transaction.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
      transaction.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
      transaction.quarantine_records.count({ where: { provider_run_id: input.state.catalogRunId } }),
      transaction.$queryRawUnsafe<TranslationAuditRow[]>(
        "select (a.details->>'pageNumber')::bigint as page_number, " +
        "p.continuation as continuation, " +
        "p.response_digest as stored_response_digest, " +
        "a.details->>'catalogCensusVersion' as census_version, " +
        "a.details->>'catalogPageResponseDigest' as page_response_digest, " +
        "(a.details->>'catalogRawCardCount')::bigint as raw_cards, " +
        "(a.details->>'catalogRawPackCount')::bigint as raw_packs, " +
        "(a.details->>'catalogDistinctCardCount')::bigint as distinct_cards, " +
        "(a.details->>'catalogDistinctPackCount')::bigint as distinct_packs, " +
        "a.details->>'catalogIdentityChainDigest' as identity_chain_digest, " +
        "a.details->>'catalogPageIdentityMultisetDigest' as page_identity_multiset_digest, " +
        "a.details->>'catalogIdentityMultisetDigest' as identity_multiset_digest, " +
        "(a.details->>'sourceRecordCount')::bigint as source_records, " +
        "(a.details->>'normalizedRecordCount')::bigint as normalized_records, " +
        "(a.details->>'catalogRecordCount')::bigint as catalog, " +
        "(a.details->>'collectibleRecordCount')::bigint as cards, " +
        "(a.details->>'packContentSnapshotCount')::bigint as pack_content_snapshots, " +
        "(a.details->>'pullRecordCount')::bigint as pulls, " +
        "(a.details->>'marketEventRecordCount')::bigint as market_events, " +
        "(a.details->>'rejectedRecordCount')::bigint as rejected " +
        "from local_audit_events a join provider_run_pages p " +
        "on p.provider_run_id=$1::uuid and p.page_number=(a.details->>'pageNumber')::integer " +
        "where a.action='provider.source.page.translated' and a.details->>'runId'=$1::text " +
        "order by (a.details->>'pageNumber')::integer, a.sequence", input.state.catalogRunId),
      transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
        "select count(*)::bigint as count from pg_stat_activity " +
        "where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'"),
    ]);
    if (!run || latest?.id !== input.state.catalogRunId ||
      run.config_version_id !== plan.catalog.id ||
      run.config_version_number !== BigInt(plan.catalog.versionNumber) ||
      run.requested_cursor !== null || run.requested_cursor_hash !== null ||
      runtime.cached_config_version_id !== plan.catalog.id ||
      runtime.cached_config_version_number !== BigInt(plan.catalog.versionNumber)) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_RUN_PROVENANCE_CHANGED");
    }
    const leaseLive = lease.lease_owner !== null && lease.lease_expires_at !== null &&
      lease.lease_expires_at > lease.database_now;
    const otherActiveTransactionCount = Number(activeTransactions[0]?.count ?? 0n);
    if (["queued", "running"].includes(run.state)) {
      if (!runCommand || runCommand.command_type !== "run" ||
        runCommand.resulting_run_id !== run.id ||
        runCommand.idempotency_key !== `catalog-bridge/${input.state.operationId}/catalog/run` ||
        runCommand.requested_by_operator_id !== input.policy.pins.operatorId ||
        runCommand.correlation_id !== input.state.operationId ||
        runCommand.target_run_id !== null || runCommand.target_quarantine_id !== null ||
        !leaseLive || otherActiveTransactionCount !== 0) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RUN_RACE");
      }
      assertCatalogPendingRunState({ expectedWorkerId: input.policy.utility.workerId,
        runState: run.state, runWorkerFence: run.worker_fence,
        runCommandState: runCommand.state, runtimeState: runtime.operating_state,
        activeRunCount, actionableCommandCount, leaseOwner: lease.lease_owner,
        leaseFence: lease.lease_fence, leaseHeartbeatAt: lease.heartbeat_at,
        leaseExpiresAt: lease.lease_expires_at, databaseNow: lease.database_now });
      return Object.freeze({ kind: "pending" as const });
    }
    if (run.state !== "succeeded") {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_RUN_TERMINAL_FAILURE");
    }
    // A terminal catalog head is admissible only after the executor has
    // released its lease row, not merely after an owned lease has expired.
    if (activeRunCount !== 0 || actionableCommandCount !== 0 ||
      lease.lease_owner !== null || lease.heartbeat_at !== null ||
      lease.lease_expires_at !== null || otherActiveTransactionCount !== 0 ||
      !["idle", "paused"].includes(runtime.operating_state)) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_HEAD_NOT_QUIESCENT");
    }
    const head = await readProviderRunHeadProof(transaction, run.id);
    const counts = catalogTranslationProof(translated, run.page_count);
    if (!head || !head.fullReplay || !head.reconciliationComplete ||
      head.configVersionId !== plan.catalog.id ||
      head.configVersionNumber !== BigInt(plan.catalog.versionNumber) ||
      counts.catalogRecordCount !== run.catalog_record_count ||
      counts.pullRecordCount !== run.pull_record_count ||
      counts.marketEventRecordCount !== run.market_event_record_count ||
      counts.rejectedRecordCount !== run.quarantined_count ||
      quarantineCount !== run.quarantined_count) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_HEAD_EVIDENCE_CHANGED");
    }
    const observation = Object.freeze({ runId: run.id, configId: run.config_version_id,
      configNumber: Number(run.config_version_number), state: "succeeded" as const,
      reachedHead: true as const, requestedCursorHash: null,
      sourceRecordCount: counts.sourceRecordCount,
      catalogRecordCount: run.catalog_record_count,
      cardRecordCount: counts.rawCardObservationCount,
      packRecordCount: counts.rawPackObservationCount,
      distinctCardIdentityCount: counts.distinctCardIdentityCount,
      distinctPackIdentityCount: counts.distinctPackIdentityCount,
      identityChainDigest: counts.identityChainDigest,
      identityMultisetDigest: counts.identityMultisetDigest,
      pullRecordCount: run.pull_record_count,
      marketEventRecordCount: run.market_event_record_count, quarantinedCount: quarantineCount,
      finalCursorHash: run.final_cursor_hash,
      runtimeState: runtime.operating_state as "idle" | "paused",
      activeRunCount: 0 as const, actionableCommandCount: 0 as const,
      importLeaseOwner: null });
    return Object.freeze({ kind: "succeeded" as const, observation,
      stabilityDigest: catalogBridgeDigest({ observation,
        runtime: { actualState: runtime.operating_state,
          generation: runtime.state_generation, rowVersion: runtime.row_version,
          cursor: runtime.source_cursor, cursorHash: runtime.source_cursor_hash },
        runDigest: providerResumeEvidenceDigest(run), headDigest: catalogBridgeDigest(head),
        latestRunDigest: providerResumeEvidenceDigest(latest),
        lease: { fence: lease.lease_fence, rowVersion: lease.row_version,
          owner: lease.lease_owner, heartbeatAt: lease.heartbeat_at,
          expiresAt: lease.lease_expires_at },
        otherActiveTransactionCount }) });
  }, PROVIDER_TRANSACTION);
}

async function catalogHeadObservation(input: Readonly<{
  database: ProviderPrismaClient; policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
}>): Promise<CatalogBridgeHeadObservation | null> {
  const before = await readCatalogHeadShortBoundary(input);
  if (before.kind === "pending") return null;
  const canonical = await readCatalogBridgeCanonicalEvidenceUnlocked(input.database,
    input.policy.utility.executionTimeoutMilliseconds);
  const after = await readCatalogHeadShortBoundary(input);
  if (after.kind !== "succeeded" || after.stabilityDigest !== before.stabilityDigest) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_BOUNDARY_CHANGED_DURING_CENSUS");
  }
  return Object.freeze({ ...after.observation, canonicalAfter: canonical });
}

async function releaseOwnedUtilityLease(input: Readonly<{
  database: ProviderPrismaClient; policy: CatalogBridgeCatalogLivePolicy;
}>): Promise<void> {
  const row = await input.database.provider_worker_states.findUniqueOrThrow({
    where: { worker_role: "import" },
  });
  if (row.lease_owner === null) return;
  if (row.lease_owner !== input.policy.utility.workerId) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_UTILITY_LEASE_LOST");
  }
  const released = await new PrismaProviderWorkerLeaseRepository(input.database).release({
    role: "import", owner: input.policy.utility.workerId, fence: row.lease_fence,
  });
  if (!released) refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_UTILITY_LEASE_LOST");
}

async function ensureCatalogPrequeueRecoveryPaused(input: Readonly<{
  database: ProviderPrismaClient;
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  originReceiptDigest: string;
  runtimeState: "idle" | "paused";
  leaseOwner: string | null;
  now: () => Date;
}>): Promise<void> {
  const leaseState = input.leaseOwner === null ? "released" as const : "owned" as const;
  let boundary = await readCatalogPrequeueRecoveryBoundary({ ...input,
    runtimeState: input.runtimeState, leaseState });
  if (input.runtimeState === "idle") {
    if (leaseState !== "owned") {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PREQUEUE_RECOVERY_UNPROVEN");
    }
    const identity = catalogPrequeueRecoveryPauseIdentity(input.state,
      boundary.runtime.state_generation);
    const result = await new PrismaAdminProviderRuntimeRepository(input.database).submitRuntimeCommand({
      commandId: identity.commandId, idempotencyKey: identity.idempotencyKey,
      commandType: "pause", expectedGeneration: boundary.runtime.state_generation,
      requestedByOperatorId: input.policy.pins.operatorId, correlationId: input.state.operationId,
      reason: identity.reason, requestedAt: input.now(),
    });
    if (!["accepted", "deduplicated"].includes(result.outcome) || result.state !== "paused" ||
      result.generation !== boundary.runtime.state_generation + 1n) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PREQUEUE_RECOVERY_PAUSE_REFUSED");
    }
    boundary = await readCatalogPrequeueRecoveryBoundary({ ...input,
      runtimeState: "paused", leaseState: "owned" });
  }
  if (boundary.lease.lease_owner !== null) {
    await releaseOwnedUtilityLease({ database: input.database, policy: input.policy });
  }
  await readCatalogPrequeueRecoveryBoundary({ ...input,
    runtimeState: "paused", leaseState: "released" });
}

async function ensureCatalogQueuedRecoveryPaused(input: Readonly<{
  database: ProviderPrismaClient;
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  originReceiptDigest: string;
  runtimeState: "idle" | "paused";
  leaseOwner: string | null;
  now: () => Date;
}>): Promise<void> {
  const leaseState = input.leaseOwner === null ? "released" as const : "owned" as const;
  let boundary = await readCatalogQueuedRecoveryBoundary({ ...input,
    runtimeState: input.runtimeState, leaseState });
  if (input.runtimeState === "idle") {
    if (leaseState !== "owned") {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_UNPROVEN");
    }
    const identity = catalogRecoveryPauseIdentity(input.state, boundary.runtime.state_generation);
    const result = await new PrismaAdminProviderRuntimeRepository(input.database).submitRuntimeCommand({
      commandId: identity.commandId, idempotencyKey: identity.idempotencyKey,
      commandType: "pause", expectedGeneration: boundary.runtime.state_generation,
      requestedByOperatorId: input.policy.pins.operatorId, correlationId: input.state.operationId,
      reason: identity.reason, requestedAt: input.now(),
    });
    if (!["accepted", "deduplicated"].includes(result.outcome) || result.state !== "paused" ||
      result.generation !== boundary.runtime.state_generation + 1n) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_PAUSE_REFUSED");
    }
    boundary = await readCatalogQueuedRecoveryBoundary({ ...input,
      runtimeState: "paused", leaseState: "owned" });
  }
  if (boundary.lease.lease_owner !== null) {
    await releaseOwnedUtilityLease({ database: input.database, policy: input.policy });
  }
  await readCatalogQueuedRecoveryBoundary({ ...input,
    runtimeState: "paused", leaseState: "released" });
}

async function ensurePaused(input: Readonly<{
  central: CentralPrismaClient; runProvider: CatalogBridgeCatalogLiveDatabaseDependencies["runProvider"];
  residentOffline: () => Promise<boolean>; policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState; now: () => Date;
  originReceiptDigest?: string;
}>): Promise<void> {
  if (!await input.residentOffline()) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_RESIDENT_NOT_OFFLINE");
  }
  const route = await locateRoute({ central: input.central, state: input.state, admin: true });
  await reachable(await input.runProvider(route, async (database) => {
    const ids = catalogBridgeCatalogOperationIds(input.policy.pins);
    let runtime = await database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
    const [entryActive, entryActionable, entryLease, entryRun, entryOriginResume,
      entryRunCommand] = await Promise.all([
      database.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
      database.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
      database.provider_worker_states.findUniqueOrThrow({ where: { worker_role: "import" } }),
      database.provider_runs.findUnique({ where: { id: input.state.catalogRunId } }),
      database.control_commands.findUnique({ where: { id: ids.catalogResumeCommandId } }),
      database.control_commands.findUnique({ where: { id: ids.catalogRunCommandId } }),
    ]);
    if (entryActive === 1 && entryActionable === 1) {
      if (
        input.originReceiptDigest === undefined ||
        ![null, input.policy.utility.workerId].includes(entryLease.lease_owner) ||
        !["idle", "paused"].includes(runtime.operating_state)) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_UNPROVEN");
      }
      await ensureCatalogQueuedRecoveryPaused({ database, policy: input.policy, state: input.state,
        originReceiptDigest: input.originReceiptDigest,
        runtimeState: runtime.operating_state as "idle" | "paused",
        leaseOwner: entryLease.lease_owner, now: input.now });
      return;
    }
    if (entryActive > 1 || entryActionable !== 0) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_QUEUED_RECOVERY_UNPROVEN");
    }
    if (entryRun === null && entryOriginResume !== null) {
      if (input.originReceiptDigest === undefined || entryRunCommand !== null ||
        ![null, input.policy.utility.workerId].includes(entryLease.lease_owner) ||
        !["idle", "paused"].includes(runtime.operating_state)) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PREQUEUE_RECOVERY_UNPROVEN");
      }
      await ensureCatalogPrequeueRecoveryPaused({ database, policy: input.policy, state: input.state,
        originReceiptDigest: input.originReceiptDigest,
        runtimeState: runtime.operating_state as "idle" | "paused",
        leaseOwner: entryLease.lease_owner, now: input.now });
      return;
    }
    if (entryRun === null && runtime.operating_state !== "paused") {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_PREQUEUE_RECOVERY_UNPROVEN");
    }
    if (runtime.operating_state !== "paused") {
      const result = await new PrismaAdminProviderRuntimeRepository(database).submitRuntimeCommand({
        commandId: ids.postCatalogPauseCommandId,
        idempotencyKey: "catalog-bridge/" + input.state.operationId + "/post-catalog/pause",
        commandType: "pause", expectedGeneration: runtime.state_generation,
        requestedByOperatorId: input.policy.pins.operatorId,
        correlationId: input.state.operationId,
        reason: "DataForrest " + input.state.providerKey + " catalog bridge post-catalog pause",
        requestedAt: input.now(),
      });
      if (!["accepted", "deduplicated"].includes(result.outcome)) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_POST_PAUSE_REFUSED");
      }
    }
    for (let observation = 0; observation < input.policy.utility.pauseMaximumObservations; observation += 1) {
      runtime = await database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
      const [active, actionable] = await Promise.all([
        database.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
        database.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
      ]);
      if (runtime.operating_state === "paused" && active === 0 && actionable === 0) {
        await releaseOwnedUtilityLease({ database, policy: input.policy });
        const lease = await database.provider_worker_states.findUniqueOrThrow({
          where: { worker_role: "import" },
        });
        if (lease.lease_owner !== null) {
          refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_UTILITY_LEASE_NOT_RELEASED");
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, input.policy.utility.pausePollMilliseconds));
    }
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_POST_PAUSE_TIMEOUT");
  }));
  if (!await input.residentOffline()) {
    refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_RESIDENT_NOT_OFFLINE");
  }
}

interface PostCatalogBoundary {
  readonly runtime: Awaited<ReturnType<ProviderTransactionClient["provider_runtime"]["findUniqueOrThrow"]>>;
  readonly run: NonNullable<Awaited<ReturnType<ProviderTransactionClient["provider_runs"]["findUnique"]>>>;
  readonly pause: NonNullable<Awaited<ReturnType<ProviderTransactionClient["control_commands"]["findUnique"]>>>;
  readonly lease: ImportLeaseRow;
  readonly activeRunCount: number;
  readonly actionableCommandCount: number;
  readonly otherActiveTransactionCount: number;
}

async function readPostCatalogBoundary(input: Readonly<{ database: ProviderPrismaClient;
  policy: CatalogBridgeCatalogLivePolicy; state: CatalogBridgePrivatePreparedState;
  expectedConfigId: string; expectedConfigNumber: number }>): Promise<PostCatalogBoundary> {
  const ids = catalogBridgeCatalogOperationIds(input.policy.pins);
  return input.database.$transaction(async (transaction) => {
    const lease = await lockImportLease(transaction);
    await lockExactRun(transaction, input.state.catalogRunId);
    await lockRuntime(transaction);
    const [runtime, run, latest, pause, activeRunCount, actionableCommandCount,
      activeTransactions] = await Promise.all([
      transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
      transaction.provider_runs.findUnique({ where: { id: input.state.catalogRunId } }),
      transaction.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
      transaction.control_commands.findUnique({ where: { id: ids.postCatalogPauseCommandId } }),
      transaction.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
      transaction.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
      transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
        "select count(*)::bigint as count from pg_stat_activity " +
        "where datname=current_database() and pid<>pg_backend_pid() and state<>'idle'"),
    ]);
    const result = storedResult(pause?.result);
    const otherActiveTransactionCount = Number(activeTransactions[0]?.count ?? 0n);
    if (!run || !pause || !pause.completed_at || !result || latest?.id !== run.id ||
      run.state !== "succeeded" || run.config_version_id !==
        catalogBridgeConfigurationPlan(input.state).catalog.id ||
      runtime.operating_state !== "paused" ||
      runtime.cached_config_version_id !== input.expectedConfigId ||
      runtime.cached_config_version_number !== BigInt(input.expectedConfigNumber) ||
      activeRunCount !== 0 || actionableCommandCount !== 0 || otherActiveTransactionCount !== 0 ||
      lease.lease_owner !== null || lease.heartbeat_at !== null || lease.lease_expires_at !== null ||
      pause.command_type !== "pause" || pause.state !== "completed" ||
      pause.idempotency_key !== `catalog-bridge/${input.state.operationId}/post-catalog/pause` ||
      pause.target_run_id !== null || pause.target_quarantine_id !== null || pause.resulting_run_id !== null ||
      pause.requested_by_operator_id !== input.policy.pins.operatorId ||
      pause.correlation_id !== input.state.operationId ||
      pause.reason !== `DataForrest ${input.state.providerKey} catalog bridge post-catalog pause` ||
      result.outcome !== "accepted" ||
      !["RUNTIME_TRANSITION_APPLIED", "RUNTIME_ALREADY_IN_STATE"].includes(result.code) ||
      result.generation !== runtime.state_generation.toString() || pauseDigest(pause) === "") {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_POST_CATALOG_BOUNDARY_CHANGED");
    }
    return Object.freeze({ runtime, run, pause, lease, activeRunCount,
      actionableCommandCount, otherActiveTransactionCount });
  }, PROVIDER_TRANSACTION);
}

function postCatalogBoundaryDigest(boundary: PostCatalogBoundary): string {
  return catalogBridgeDigest({ runtime: { state: boundary.runtime.operating_state,
    generation: boundary.runtime.state_generation, rowVersion: boundary.runtime.row_version,
    configId: boundary.runtime.cached_config_version_id,
    configNumber: boundary.runtime.cached_config_version_number,
    cursor: boundary.runtime.source_cursor, cursorHash: boundary.runtime.source_cursor_hash },
  runDigest: providerResumeEvidenceDigest(boundary.run), pauseDigest: pauseDigest(boundary.pause),
  lease: { owner: boundary.lease.lease_owner, heartbeatAt: boundary.lease.heartbeat_at,
    expiresAt: boundary.lease.lease_expires_at, fence: boundary.lease.lease_fence,
    rowVersion: boundary.lease.row_version }, activeRunCount: boundary.activeRunCount,
  actionableCommandCount: boundary.actionableCommandCount,
  otherActiveTransactionCount: boundary.otherActiveTransactionCount });
}

async function eventDatabaseBoundary(input: Readonly<{
  central: CentralPrismaClient; runProvider: CatalogBridgeCatalogLiveDatabaseDependencies["runProvider"];
  residentOffline: () => Promise<boolean>; policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState; now: () => Date;
}>) {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const boundary = await readCentralBoundary(input);
  assertCentralShape({ boundary, ...input, allowCatalog: true });
  const activeConfigId = boundary.provider?.active_config_version_id ?? "";
  if (![plan.catalog.id, plan.eventSuccessor.id].includes(activeConfigId)) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_AUTHORITY_CHANGED");
  }
  const route = boundary.route;
  const provider = reachable(await input.runProvider(route, async (database) => {
    const runtime = await database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
    const [activeRunCount, actionableCommandCount, lease, activeTransactions] = await Promise.all([
      database.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
      database.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
      database.provider_worker_states.findUniqueOrThrow({ where: { worker_role: "import" } }),
      database.$queryRawUnsafe<Array<{ count: bigint }>>(
        "select count(*)::bigint as count from pg_stat_activity " +
        "where datname=current_database() and pid<>pg_backend_pid() and state<>'idle'"),
    ]);
    return { runtime, activeRunCount, actionableCommandCount, lease,
      otherActiveTransactionCount: Number(activeTransactions[0]?.count ?? 0n) };
  }));
  if (!["paused", "idle", "running"].includes(provider.runtime.operating_state)) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RUNTIME_STATE_CHANGED");
  }
  return Object.freeze({ observedAt: input.now().toISOString(),
    residentOffline: await input.residentOffline(),
    runtimeState: provider.runtime.operating_state as "paused" | "idle" | "running",
    activeRunCount: provider.activeRunCount, actionableCommandCount: provider.actionableCommandCount,
    importLeaseOwner: provider.lease.lease_owner,
    importLeaseHeartbeatAt: provider.lease.heartbeat_at?.toISOString() ?? null,
    importLeaseExpiresAt: provider.lease.lease_expires_at?.toISOString() ?? null,
    otherActiveTransactionCount: provider.otherActiveTransactionCount, activeConfigId,
    cachedConfigId: provider.runtime.cached_config_version_id ?? "" });
}

async function eventStageObservation(input: Readonly<{
  central: CentralPrismaClient; runProvider: CatalogBridgeCatalogLiveDatabaseDependencies["runProvider"];
  residentOffline: () => Promise<boolean>; policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState; catalogRunDigest: string; now: () => Date;
}>): Promise<CatalogBridgeEventSuccessorStageObservation> {
  if (!await input.residentOffline()) refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESIDENT_NOT_OFFLINE");
  const plan = catalogBridgeConfigurationPlan(input.state);
  const definition = catalogBridgeProvider(input.state.providerKey);
  const staged = await stageInactiveEventSuccessorConfiguration(input);
  const boundary = await readCentralBoundary(input);
  if (boundary.provider?.active_config_version_id !== plan.catalog.id || !boundary.eventSuccessor ||
    boundary.provider.row_version.toString() !== staged.providerRowVersion) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_STAGE_UNPROVEN");
  }
  const provider = reachable(await input.runProvider(boundary.route, (database) =>
    readPostCatalogBoundary({ database, policy: input.policy, state: input.state,
      expectedConfigId: plan.catalog.id, expectedConfigNumber: plan.catalog.versionNumber })));
  const pause = provider.pause;
  const result = storedResult(pause.result)!;
  return Object.freeze({ observedAt: input.now().toISOString(),
    centralActiveConfigId: plan.catalog.id,
    centralProviderRowVersion: staged.providerRowVersion,
    stagedConfigId: plan.eventSuccessor.id, stagedConfigNumber: plan.eventSuccessor.versionNumber,
    stagedAdapterVersion: definition.eventManifest.adapterVersion,
    stagedConfigurationDigest: catalogBridgeDigest(plan.eventSuccessor.configuration),
    activationProofDigest: staged.activationProofDigest,
    providerStillAtCatalogConfigId: plan.catalog.id, activeRunCount: 0,
    actionableCommandCount: 0, importLeaseOwner: null, runtimeState: "paused",
    runtimeGeneration: provider.runtime.state_generation.toString(),
    runtimeRowVersion: provider.runtime.row_version.toString(),
    pauseCommandId: pause.id, pauseCommandDigest: pauseDigest(pause),
    pauseCommandType: pause.command_type, pauseCommandState: pause.state,
    pauseIdempotencyKey: pause.idempotency_key, pauseTargetRunId: null,
    pauseTargetQuarantineId: null, pauseResultingRunId: null,
    pauseRequestedByOperatorId: pause.requested_by_operator_id,
    pauseExpectedGeneration: pause.expected_generation.toString(),
    pauseResultOutcome: result.outcome, pauseResultCode: result.code,
    pauseResultGeneration: result.generation, pauseCorrelationId: pause.correlation_id,
    pauseReason: pause.reason, pauseRequestedAt: pause.requested_at.toISOString(),
    pauseCompletedAt: pause.completed_at!.toISOString(), latestTerminalRunId: provider.run.id,
    latestTerminalRunDigest: input.catalogRunDigest });
}

async function synchronizePausedEventConfiguration(input: Readonly<{
  database: ProviderPrismaClient; policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState; expectedRuntimeRowVersion: string;
  eventStageReceiptDigest: string; now: () => Date; scheduleSeconds: number;
  expiresAt: Date | null;
}>): Promise<Readonly<Record<string, unknown>>> {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const definition = catalogBridgeProvider(input.state.providerKey);
  const restored = reEnvelopeSavedEventCursor(input.state);
  return input.database.$transaction(async (transaction) => {
    const lease = await lockImportLease(transaction);
    await lockExactRun(transaction, input.state.catalogRunId);
    await lockRuntime(transaction);
    const [runtime, run, latest, activeRuns, commands, pause, activeTransactions] = await Promise.all([
      transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
      transaction.provider_runs.findUnique({ where: { id: input.state.catalogRunId } }),
      transaction.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
      transaction.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
      transaction.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
      transaction.control_commands.findUnique({ where: {
        id: catalogBridgeCatalogOperationIds(input.policy.pins).postCatalogPauseCommandId } }),
      transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
        "select count(*)::bigint as count from pg_stat_activity " +
        "where datname=current_database() and pid<>pg_backend_pid() and state<>'idle'"),
    ]);
    const expectedRow = BigInt(input.expectedRuntimeRowVersion);
    const oldBoundary = runtime.cached_config_version_id === plan.catalog.id &&
      runtime.cached_config_version_number === BigInt(plan.catalog.versionNumber) &&
      runtime.row_version === expectedRow;
    const synchronizedBoundary = runtime.cached_config_version_id === plan.eventSuccessor.id &&
      runtime.cached_config_version_number === BigInt(plan.eventSuccessor.versionNumber) &&
      runtime.row_version === expectedRow + 1n && runtime.source_cursor_hash === restored.cursorHash &&
      cursorFingerprint(runtime.source_cursor) === restored.cursorHash;
    if (!run || latest?.id !== run.id || run.state !== "succeeded" || !pause ||
      runtime.operating_state !== "paused" || (!oldBoundary && !synchronizedBoundary) ||
      activeRuns !== 0 || commands !== 0 || Number(activeTransactions[0]?.count ?? 0n) !== 0 ||
      lease.lease_owner !== null || lease.heartbeat_at !== null || lease.lease_expires_at !== null ||
      pauseDigest(pause) === "" ||
      (oldBoundary && (runtime.source_cursor_hash !== run.final_cursor_hash ||
        cursorFingerprint(runtime.source_cursor) !== runtime.source_cursor_hash))) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_CURSOR_SYNC_BOUNDARY_CHANGED");
    }
    if (oldBoundary) {
      const changed = await transaction.$executeRawUnsafe(
        "update provider_runtime set cached_config_version_id=$1::uuid, " +
        "cached_config_version_number=$2::bigint, cached_configuration=$3::jsonb, " +
        "config_expires_at=$4::timestamptz, last_control_sync_at=$5::timestamptz, " +
        "schedule_seconds=$6::integer, next_due_at=null, source_cursor=$7::jsonb, " +
        "source_cursor_hash=$8, row_version=row_version+1, updated_at=$5::timestamptz " +
        "where singleton_key=true and row_version=$9::bigint",
        plan.eventSuccessor.id, BigInt(plan.eventSuccessor.versionNumber),
        JSON.stringify({ adapterKey: definition.eventManifest.adapterVersion,
          settings: plan.eventSuccessor.configuration }), input.expiresAt, input.now(),
        input.scheduleSeconds, JSON.stringify(restored.cursor), restored.cursorHash, expectedRow);
      if (changed !== 1) refuseCatalogBridge("CATALOG_BRIDGE_EVENT_CURSOR_SYNC_CAS_FAILED");
    }
    const after = await transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
    if (after.cached_config_version_id !== plan.eventSuccessor.id ||
      after.cached_config_version_number !== BigInt(plan.eventSuccessor.versionNumber) ||
      after.row_version !== expectedRow + 1n || after.source_cursor_hash !== restored.cursorHash ||
      cursorFingerprint(after.source_cursor) !== restored.cursorHash) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_CURSOR_SYNC_UNPROVEN");
    }
    return Object.freeze({ operationId: input.state.operationId,
      eventStageReceiptDigest: input.eventStageReceiptDigest,
      catalogConfigId: plan.catalog.id, eventSuccessorConfigId: plan.eventSuccessor.id,
      runtimeGeneration: after.state_generation.toString(),
      previousRuntimeRowVersion: input.expectedRuntimeRowVersion,
      runtimeRowVersion: after.row_version.toString(), restoredCursorHash: restored.cursorHash });
  }, PROVIDER_TRANSACTION);
}

async function restoreEventCursorObservation(input: Readonly<{
  central: CentralPrismaClient; runProvider: CatalogBridgeCatalogLiveDatabaseDependencies["runProvider"];
  residentOffline: () => Promise<boolean>; policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState; eventStageReceiptDigest: string;
  expectedProviderRowVersion: string; expectedRuntimeRowVersion: string;
  catalogRunDigest: string; now: () => Date;
}>): Promise<CatalogBridgeCursorRestoreObservation> {
  if (!await input.residentOffline()) refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESIDENT_NOT_OFFLINE");
  const plan = catalogBridgeConfigurationPlan(input.state);
  const definition = catalogBridgeProvider(input.state.providerKey);
  const before = await readCentralBoundary(input);
  assertCentralShape({ boundary: before, ...input, allowCatalog: true });
  const centralAtCatalog = before.provider?.active_config_version_id === plan.catalog.id &&
    before.provider.row_version.toString() === input.expectedProviderRowVersion;
  const centralAtSuccessor = before.provider?.active_config_version_id === plan.eventSuccessor.id &&
    before.provider.row_version === BigInt(input.expectedProviderRowVersion) + 1n;
  // Provider synchronization and central activation commit independently. An
  // exact retry may therefore start at either durable prefix; the idempotent
  // activation helper below still proves the operation-owned audit metadata.
  if ((!centralAtCatalog && !centralAtSuccessor) || !before.eventSuccessor) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESTORE_AUTHORITY_CHANGED");
  }
  const syncEvidence = reachable(await input.runProvider(before.route, (database) =>
    synchronizePausedEventConfiguration({ database, policy: input.policy, state: input.state,
      expectedRuntimeRowVersion: input.expectedRuntimeRowVersion,
      eventStageReceiptDigest: input.eventStageReceiptDigest, now: input.now,
      scheduleSeconds: before.eventSuccessor!.schedule_seconds,
      expiresAt: before.eventSuccessor!.expires_at })));
  await activateEventSuccessorConfigurationLast({ central: input.central, policy: input.policy,
    state: input.state, expectedProviderRowVersion: input.expectedProviderRowVersion,
    eventStageReceiptDigest: input.eventStageReceiptDigest,
    providerSyncDigest: catalogBridgeDigest(syncEvidence), now: input.now });
  const central = await readCentralBoundary(input);
  if (central.provider?.active_config_version_id !== plan.eventSuccessor.id ||
    central.provider.row_version !== BigInt(input.expectedProviderRowVersion) + 1n ||
    !central.eventSuccessor) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_ACTIVATION_UNPROVEN");
  }
  const evidence = reachable(await input.runProvider(central.route, async (database) => {
    const first = await readPostCatalogBoundary({ database, policy: input.policy, state: input.state,
      expectedConfigId: plan.eventSuccessor.id,
      expectedConfigNumber: plan.eventSuccessor.versionNumber });
    if (first.runtime.row_version !== BigInt(input.expectedRuntimeRowVersion) + 1n) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESTORE_RUNTIME_CHANGED");
    }
    const canonical = await readCatalogBridgeCanonicalEvidenceUnlocked(database,
      input.policy.utility.executionTimeoutMilliseconds);
    const second = await readPostCatalogBoundary({ database, policy: input.policy, state: input.state,
      expectedConfigId: plan.eventSuccessor.id,
      expectedConfigNumber: plan.eventSuccessor.versionNumber });
    if (postCatalogBoundaryDigest(first) !== postCatalogBoundaryDigest(second)) {
      refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_BOUNDARY_CHANGED_DURING_CENSUS");
    }
    return Object.freeze({ boundary: second, canonical });
  }));
  const restored = reEnvelopeSavedEventCursor(input.state);
  const runtime = evidence.boundary.runtime;
  const pause = evidence.boundary.pause;
  return Object.freeze({ observedAt: input.now().toISOString(),
    centralActiveConfigId: plan.eventSuccessor.id,
    centralActiveConfigNumber: plan.eventSuccessor.versionNumber,
    centralActiveAdapterVersion: definition.eventManifest.adapterVersion,
    centralActiveConfigurationDigest: catalogBridgeDigest(central.eventSuccessor.configuration),
    providerRowVersion: central.provider.row_version.toString(),
    providerCachedConfigId: plan.eventSuccessor.id,
    providerCachedConfigNumber: plan.eventSuccessor.versionNumber,
    providerCachedConfigurationDigest: catalogBridgeDigest(runtime.cached_configuration),
    runtimeGeneration: runtime.state_generation.toString(), runtimeRowVersion: runtime.row_version.toString(),
    sourceCursorHash: runtime.source_cursor_hash, sourceCursorPresent: runtime.source_cursor !== null,
    runtimeState: "paused", pauseCommandId: pause.id, pauseCommandDigest: pauseDigest(pause),
    latestTerminalRunId: evidence.boundary.run.id,
    latestTerminalRunDigest: input.catalogRunDigest, activeRunCount: 0,
    actionableCommandCount: 0, importLeaseOwner: null,
    otherActiveTransactionCount: 0, canonical: evidence.canonical,
    restoredCursorHash: restored.cursorHash, restoredOpaqueValueHash: restored.opaqueValueHash,
    cursorEnvelopeDigest: catalogBridgeDigest(restored.cursor) });
}

interface EventResumeAdmissionBoundary {
  readonly lease: ImportLeaseRow;
  readonly runtime: Awaited<ReturnType<ProviderTransactionClient["provider_runtime"]["findUniqueOrThrow"]>>;
  readonly run: NonNullable<Awaited<ReturnType<ProviderTransactionClient["provider_runs"]["findUnique"]>>>;
}

export async function proveSucceededEventRecoveryHistory(input: Readonly<{
  database: Pick<ProviderTransactionClient, "control_commands" | "local_audit_events">;
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  run: EventResumeAdmissionBoundary["run"];
  baseIdleGeneration: bigint;
  baseIdleRowVersion: bigint;
  targetIdleGeneration: bigint;
  checkpointHash: string;
  checkpoint: CanonicalJsonValue;
  scope: "event-prequeue" | "event-successor";
}>): Promise<void> {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const delta = input.targetIdleGeneration - input.baseIdleGeneration;
  if (delta < 0n || delta % 2n !== 0n || delta / 2n > 1_024n) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_RESUME_UNPROVEN");
  }
  for (let idleGeneration = input.baseIdleGeneration;
    idleGeneration < input.targetIdleGeneration; idleGeneration += 2n) {
    const pauseIdentity = recoveryPauseIdentity(input.state, idleGeneration);
    const resumeIdentity = recoveryResumeIdentity(input.state, input.scope,
      idleGeneration + 1n);
    const [pause, resume, audit] = await Promise.all([
      input.database.control_commands.findUnique({ where: { id: pauseIdentity.commandId } }),
      input.database.control_commands.findUnique({ where: { id: resumeIdentity.commandId } }),
      input.database.local_audit_events.findFirst({ where: {
        command_id: resumeIdentity.commandId, action: "provider.runtime.resume_guard",
      } }),
    ]);
    const pauseResult = storedResult(pause?.result);
    const resumeResult = storedResult(resume?.result);
    const details = audit?.details as Record<string, unknown> | null | undefined;
    const guard: ProviderRuntimeResumeGuard = Object.freeze({
      entry: "paused", providerId: catalogBridgeProvider(input.state.providerKey).providerId,
      configVersionId: plan.eventSuccessor.id,
      configVersionNumber: BigInt(plan.eventSuccessor.versionNumber),
      runtimeRowVersion: input.baseIdleRowVersion +
        (idleGeneration - input.baseIdleGeneration) + 1n,
      checkpointHash: input.checkpointHash, checkpoint: input.checkpoint,
      latestRunId: input.run.id, latestRunDigest: providerResumeEvidenceDigest(input.run),
      pauseCommandId: pauseIdentity.commandId,
      pauseCommandDigest: providerResumeEvidenceDigest(pause),
      expectedImportLease: { owner: input.policy.utility.workerId, fence: 1n },
    });
    if (!pause || pause.id !== pauseIdentity.commandId || pause.command_type !== "pause" ||
      pause.state !== "completed" || pause.completed_at === null ||
      pause.idempotency_key !== pauseIdentity.idempotencyKey || pause.target_run_id !== null ||
      pause.target_quarantine_id !== null || pause.resulting_run_id !== null ||
      pause.expected_generation !== idleGeneration ||
      pause.requested_by_operator_id !== input.policy.pins.operatorId ||
      pause.correlation_id !== input.state.operationId || pause.reason !== pauseIdentity.reason ||
      pauseResult?.outcome !== "accepted" || pauseResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
      pauseResult.generation !== (idleGeneration + 1n).toString() ||
      !resume || resume.id !== resumeIdentity.commandId || resume.command_type !== "resume" ||
      resume.state !== "completed" || resume.completed_at === null ||
      resume.idempotency_key !== resumeIdentity.idempotencyKey || resume.target_run_id !== null ||
      resume.target_quarantine_id !== null || resume.resulting_run_id !== null ||
      resume.expected_generation !== idleGeneration + 1n ||
      resume.requested_by_operator_id !== input.policy.pins.operatorId ||
      resume.correlation_id !== input.state.operationId || resume.reason !== resumeIdentity.reason ||
      resumeResult?.outcome !== "accepted" || resumeResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
      resumeResult.generation !== (idleGeneration + 2n).toString() ||
      audit?.outcome !== "success" || audit.actor_operator_id !== input.policy.pins.operatorId ||
      audit.correlation_id !== input.state.operationId || audit.target_type !== "control_command" ||
      audit.target_id !== resume.id || details?.guardDigest !== semanticGuardDigest(guard)) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_RESUME_UNPROVEN");
    }
  }
}

/** Immutable event admission proof, optionally before releasing this operation's stranded utility lease. */
async function readExactEventResumeAdmission(input: Readonly<{
  database: ProviderPrismaClient;
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  cursorRestoreReceiptDigest: string;
  expectedRuntimeRowVersion: string;
  processOffline: boolean;
  processOnline: boolean;
  leaseState: "released" | "operation_owned";
}>): Promise<EventResumeAdmissionBoundary> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const plan = catalogBridgeConfigurationPlan(input.state);
  const restored = reEnvelopeSavedEventCursor(input.state);
  const ids = catalogBridgeCatalogOperationIds(input.policy.pins);
  const runId = catalogBridgeResumeRunId(input.state.operationId, input.state.providerKey);
  return input.database.$transaction(async (transaction) => {
    const lease = await lockImportLease(transaction);
    await lockExactRun(transaction, runId);
    await lockRuntime(transaction);
    const [run, runtime, latest, resumeCommand, runCommand, resumeGuard, catalogRun,
      originalPause, head, activeRunCount, actionableCommandCount] = await Promise.all([
      transaction.provider_runs.findUnique({ where: { id: runId } }),
      transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
      transaction.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
      transaction.control_commands.findUnique({ where: { id: ids.eventResumeCommandId } }),
      transaction.control_commands.findUnique({ where: { id: ids.eventRunCommandId } }),
      transaction.local_audit_events.findFirst({ where: {
        command_id: ids.eventResumeCommandId, action: "provider.runtime.resume_guard",
      } }),
      transaction.provider_runs.findUnique({ where: { id: input.state.catalogRunId } }),
      transaction.control_commands.findUnique({ where: { id: ids.postCatalogPauseCommandId } }),
      readProviderRunHeadProof(transaction, runId),
      transaction.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
      transaction.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
    ]);
    if (!run || !resumeCommand || !runCommand || !catalogRun || !originalPause) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_ADMISSION_UNPROVEN");
    }
    assertEventResumeAdmissionState({ operationId: input.state.operationId,
      runState: run.state, runReachedHead: run.reached_source_head,
      runWorkerFence: run.worker_fence, runCommandState: runCommand.state,
      runtimeState: runtime.operating_state, activeRunCount, actionableCommandCount,
      processOffline: input.processOffline, processOnline: input.processOnline,
      leaseOwner: lease.lease_owner, leaseFence: lease.lease_fence,
      leaseHeartbeatAt: lease.heartbeat_at, leaseExpiresAt: lease.lease_expires_at,
      databaseNow: lease.database_now,
      ...(input.leaseState === "operation_owned"
        ? { expectedUtilityLeaseOwner: input.policy.utility.workerId } : {}),
    });
    const originalGuard: ProviderRuntimeResumeGuard = Object.freeze({
      entry: "paused", providerId: definition.providerId,
      configVersionId: plan.eventSuccessor.id,
      configVersionNumber: BigInt(plan.eventSuccessor.versionNumber),
      runtimeRowVersion: BigInt(input.expectedRuntimeRowVersion),
      checkpointHash: restored.cursorHash, checkpoint: restored.cursor,
      latestRunId: catalogRun.id, latestRunDigest: providerResumeEvidenceDigest(catalogRun),
      pauseCommandId: originalPause.id,
      pauseCommandDigest: providerResumeEvidenceDigest(originalPause),
      expectedImportLease: { owner: input.policy.utility.workerId, fence: 1n },
    });
    const resumeResult = storedResult(resumeCommand.result);
    const runResult = storedResult(runCommand.result);
    const guardDetails = resumeGuard?.details as Record<string, unknown> | null | undefined;
    const expectedRunCommandState = run.state === "queued" ? "accepted" : "completed";
    const expectedRunResultCode = run.state === "queued" ? "COMMAND_ACCEPTED" : "RUN_STARTED";
    const expectedRunResultGeneration = run.state === "queued"
      ? runCommand.expected_generation : runCommand.expected_generation + 1n;
    if (latest?.id !== runId ||
      runtime.cached_config_version_id !== plan.eventSuccessor.id ||
      runtime.cached_config_version_number !== BigInt(plan.eventSuccessor.versionNumber) ||
      run.control_command_id !== ids.eventRunCommandId ||
      run.idempotency_key !== `command/${ids.eventRunCommandId}` ||
      run.config_version_id !== plan.eventSuccessor.id ||
      run.config_version_number !== BigInt(plan.eventSuccessor.versionNumber) ||
      run.requested_cursor_hash !== restored.cursorHash ||
      cursorFingerprint(run.requested_cursor) !== restored.cursorHash ||
      (run.state === "queued" && (runtime.source_cursor_hash !== restored.cursorHash ||
        cursorFingerprint(runtime.source_cursor) !== restored.cursorHash)) ||
      (run.state === "succeeded" && !head?.reconciliationComplete) ||
      catalogRun.state !== "succeeded" || !catalogRun.reached_source_head ||
      catalogRun.config_version_id !== plan.catalog.id ||
      catalogRun.config_version_number !== BigInt(plan.catalog.versionNumber) ||
      catalogRun.requested_cursor !== null || catalogRun.requested_cursor_hash !== null ||
      resumeCommand.command_type !== "resume" || resumeCommand.state !== "completed" ||
      resumeCommand.completed_at === null || resumeCommand.target_run_id !== null ||
      resumeCommand.target_quarantine_id !== null || resumeCommand.resulting_run_id !== null ||
      resumeCommand.idempotency_key !== `catalog-bridge/${input.state.operationId}/event-resume/resume` ||
      resumeCommand.requested_by_operator_id !== input.policy.pins.operatorId ||
      resumeCommand.correlation_id !== input.state.operationId ||
      resumeCommand.reason !== `DataForrest ${input.state.providerKey} catalog bridge restored event cursor resume ` +
        `[${input.cursorRestoreReceiptDigest}]` ||
      resumeResult?.outcome !== "accepted" || resumeResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
      resumeResult.generation !== (resumeCommand.expected_generation + 1n).toString() ||
      runCommand.command_type !== "run" || runCommand.state !== expectedRunCommandState ||
      runCommand.idempotency_key !== `catalog-bridge/${input.state.operationId}/event-resume/run` ||
      runCommand.target_run_id !== null || runCommand.target_quarantine_id !== null ||
      runCommand.resulting_run_id !== run.id || runCommand.reason !== null ||
      runCommand.requested_by_operator_id !== input.policy.pins.operatorId ||
      runCommand.correlation_id !== input.state.operationId ||
      (run.state === "queued" ? runCommand.completed_at !== null : runCommand.completed_at === null) ||
      runResult?.outcome !== "accepted" || runResult.code !== expectedRunResultCode ||
      runResult.generation !== expectedRunResultGeneration.toString() ||
      resumeGuard?.outcome !== "success" ||
      resumeGuard.actor_operator_id !== input.policy.pins.operatorId ||
      resumeGuard.correlation_id !== input.state.operationId ||
      resumeGuard.target_type !== "control_command" || resumeGuard.target_id !== resumeCommand.id ||
      guardDetails?.guardDigest !== semanticGuardDigest(originalGuard)) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_ADMISSION_UNPROVEN");
    }
    const initialIdleGeneration = resumeCommand.expected_generation + 1n;
    await proveSucceededEventRecoveryHistory({ database: transaction, policy: input.policy,
      state: input.state, run: catalogRun, baseIdleGeneration: initialIdleGeneration,
      baseIdleRowVersion: BigInt(input.expectedRuntimeRowVersion) + 1n,
      targetIdleGeneration: runCommand.expected_generation,
      checkpointHash: restored.cursorHash, checkpoint: restored.cursor,
      scope: "event-prequeue" });
    const queueRuntimeRowVersion = BigInt(input.expectedRuntimeRowVersion) +
      (runCommand.expected_generation - resumeCommand.expected_generation);
    if ((run.state === "queued" && (run.page_count !== 0 ||
        runtime.state_generation !== runCommand.expected_generation ||
        runtime.row_version !== queueRuntimeRowVersion)) ||
      (run.state === "running" &&
        (runtime.state_generation !== BigInt(runResult.generation) ||
          runtime.row_version !== queueRuntimeRowVersion + 1n + BigInt(run.page_count) +
            BigInt(head?.reconciliationBatchNumber ?? 0)))) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_ADMISSION_UNPROVEN");
    }
    if (run.state === "succeeded") {
      if (run.page_count < 1 || runtime.operating_state !== "idle" ||
        runtime.source_cursor_hash === null ||
        cursorFingerprint(runtime.source_cursor) !== runtime.source_cursor_hash) {
        refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_RESUME_UNPROVEN");
      }
      const baseIdleGeneration = BigInt(runResult.generation) + 1n;
      const baseIdleRowVersion = queueRuntimeRowVersion + 2n + BigInt(run.page_count) +
        BigInt(head!.reconciliationBatchNumber);
      if (runtime.row_version !== baseIdleRowVersion +
        (runtime.state_generation - baseIdleGeneration)) {
        refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_RESUME_UNPROVEN");
      }
      await proveSucceededEventRecoveryHistory({ database: transaction, policy: input.policy,
        state: input.state, run, baseIdleGeneration, baseIdleRowVersion,
        targetIdleGeneration: runtime.state_generation,
        checkpointHash: runtime.source_cursor_hash,
        checkpoint: runtime.source_cursor as CanonicalJsonValue,
        scope: "event-successor" });
    }
    return Object.freeze({ lease, runtime, run });
  }, PROVIDER_TRANSACTION);
}

async function admitEventResumeRun(input: Readonly<{
  central: CentralPrismaClient; runProvider: CatalogBridgeCatalogLiveDatabaseDependencies["runProvider"];
  residentOffline: () => Promise<boolean>; policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState; cursorRestoreReceiptDigest: string;
  expectedProviderRowVersion: string; expectedRuntimeRowVersion: string;
  restoredCursorHash: string; process: CatalogBridgeDrainProcessObservation; now: () => Date;
}>): Promise<void> {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const definition = catalogBridgeProvider(input.state.providerKey);
  const restored = reEnvelopeSavedEventCursor(input.state);
  const ids = catalogBridgeCatalogOperationIds(input.policy.pins);
  const runId = catalogBridgeResumeRunId(input.state.operationId, input.state.providerKey);
  const processOffline = input.process.launchdLabel === definition.launchdLabel &&
    input.process.residencyPort === definition.residencyPort && !input.process.launchdLoaded &&
    input.process.processCount === 0 && input.process.pids.length === 0 &&
    input.process.processIdentitySha256 === null && !input.process.residencyPortListening;
  const processOnline = input.process.launchdLabel === definition.launchdLabel &&
    input.process.residencyPort === definition.residencyPort && input.process.launchdLoaded &&
    input.process.processCount === 1 && input.process.pids.length === 1 &&
    input.process.processIdentitySha256 !== null && input.process.residencyPortListening;
  const residentOffline = await input.residentOffline();
  if (restored.cursorHash !== input.restoredCursorHash || (!processOffline && !processOnline) ||
    residentOffline !== processOffline) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_ADMISSION_CHANGED");
  }
  const central = await readCentralBoundary(input);
  if (central.provider?.active_config_version_id !== plan.eventSuccessor.id ||
    central.provider.row_version.toString() !== input.expectedProviderRowVersion) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_AUTHORITY_CHANGED");
  }
  await reachable(await input.runProvider(central.route, async (database) => {
    const admin = new PrismaAdminProviderRuntimeRepository(database);
    const existing = await database.provider_runs.findUnique({ where: { id: runId } });
    if (existing === null) {
      // Queue the deterministic first run before launchd starts the resident.
      // Once the run exists, --await-initial-run can never mistake this exact
      // admission's lease/resume transitions for foreign boundary drift.
      if (!processOffline) refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_ADMISSION_CHANGED");
      const leases = new PrismaProviderWorkerLeaseRepository(database);
      const acquired = await leases.acquire({ role: "import", owner: input.policy.utility.workerId,
        leaseMilliseconds: input.policy.utility.leaseMilliseconds });
      if (acquired.kind === "held") refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_LEASE_HELD");
      const lease = acquired.lease;
      try {
        const [runtime, latest, pause, existingResume, activeRunCount,
          actionableCommandCount] = await Promise.all([
          database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
          database.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
          database.control_commands.findUnique({ where: { id: ids.postCatalogPauseCommandId } }),
          database.control_commands.findUnique({ where: { id: ids.eventResumeCommandId } }),
          database.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
          database.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
        ]);
        const resumeReason = `DataForrest ${input.state.providerKey} catalog bridge restored event cursor resume ` +
          `[${input.cursorRestoreReceiptDigest}]`;
        const resumeResult = storedResult(existingResume?.result);
        const pauseResult = storedResult(pause?.result);
        const exactCompletedResumeCommand = !!existingResume &&
          existingResume.command_type === "resume" && existingResume.state === "completed" &&
          existingResume.completed_at !== null &&
          existingResume.idempotency_key === `catalog-bridge/${input.state.operationId}/event-resume/resume` &&
          existingResume.target_run_id === null && existingResume.target_quarantine_id === null &&
          existingResume.resulting_run_id === null &&
          existingResume.requested_by_operator_id === input.policy.pins.operatorId &&
          existingResume.correlation_id === input.state.operationId && existingResume.reason === resumeReason &&
          pauseResult?.generation === existingResume.expected_generation.toString() &&
          resumeResult?.outcome === "accepted" && resumeResult.code === "RUNTIME_TRANSITION_APPLIED" &&
          resumeResult.generation === (existingResume.expected_generation + 1n).toString();
        const disposition = eventResumeMutationDisposition({ runtimeState: runtime.operating_state,
          runtimeRowVersion: runtime.row_version,
          expectedRuntimeRowVersion: BigInt(input.expectedRuntimeRowVersion),
          resumeCommandPresent: existingResume !== null, exactCompletedResumeCommand,
          activeRunCount, actionableCommandCount });
        if (runtime.cached_config_version_id !== plan.eventSuccessor.id ||
          runtime.cached_config_version_number !== BigInt(plan.eventSuccessor.versionNumber) ||
          runtime.source_cursor_hash !== restored.cursorHash ||
          cursorFingerprint(runtime.source_cursor) !== restored.cursorHash || !latest || !pause ||
          latest.id !== input.state.catalogRunId || latest.state !== "succeeded" ||
          pauseDigest(pause) === "") {
          refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_ADMISSION_CHANGED");
        }
        const guard: ProviderRuntimeResumeGuard = { entry: "paused",
            providerId: definition.providerId, configVersionId: plan.eventSuccessor.id,
            configVersionNumber: BigInt(plan.eventSuccessor.versionNumber),
            runtimeRowVersion: BigInt(input.expectedRuntimeRowVersion), checkpointHash: restored.cursorHash,
            checkpoint: restored.cursor, latestRunId: latest.id,
            latestRunDigest: providerResumeEvidenceDigest(latest), pauseCommandId: pause.id,
            pauseCommandDigest: providerResumeEvidenceDigest(pause),
            expectedImportLease: { owner: lease.owner, fence: lease.fence },
            notAfter: lease.expiresAt };
        if (disposition === "resume_then_queue") {
          const resumed = await admin.submitRuntimeCommand({ commandId: ids.eventResumeCommandId,
            idempotencyKey: `catalog-bridge/${input.state.operationId}/event-resume/resume`,
            commandType: "resume", expectedGeneration: runtime.state_generation,
            requestedByOperatorId: input.policy.pins.operatorId, correlationId: input.state.operationId,
            reason: resumeReason, requestedAt: input.now(), expectedRuntimeGuard: guard });
          if (!["accepted", "deduplicated"].includes(resumed.outcome)) {
            refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_COMMAND_REFUSED");
          }
        }
        const [durableResume, guardAudit] = await Promise.all([
          database.control_commands.findUnique({ where: { id: ids.eventResumeCommandId } }),
          database.local_audit_events.findFirst({ where: {
            command_id: ids.eventResumeCommandId, action: "provider.runtime.resume_guard" } }),
        ]);
        const durableResult = storedResult(durableResume?.result);
        const guardDetails = guardAudit?.details as Record<string, unknown> | null | undefined;
        if (!durableResume || durableResume.command_type !== "resume" ||
          durableResume.state !== "completed" || durableResume.completed_at === null ||
          durableResume.idempotency_key !==
            `catalog-bridge/${input.state.operationId}/event-resume/resume` ||
          durableResume.target_run_id !== null || durableResume.target_quarantine_id !== null ||
          durableResume.resulting_run_id !== null ||
          durableResume.expected_generation !== pause!.expected_generation + 1n ||
          durableResume.requested_by_operator_id !== input.policy.pins.operatorId ||
          durableResume.correlation_id !== input.state.operationId || durableResume.reason !== resumeReason ||
          durableResult?.outcome !== "accepted" || durableResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
          durableResult.generation !== (durableResume.expected_generation + 1n).toString() ||
          guardAudit?.outcome !== "success" ||
          guardAudit.actor_operator_id !== input.policy.pins.operatorId ||
          guardAudit.correlation_id !== input.state.operationId ||
          guardAudit.target_type !== "control_command" || guardAudit.target_id !== durableResume.id ||
          guardDetails?.guardDigest !== semanticGuardDigest(guard)) {
          refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_COMMAND_REFUSED");
        }
        if (disposition !== "resume_then_queue") {
          const initialIdleGeneration = durableResume.expected_generation + 1n;
          const targetIdleGeneration = disposition === "queue_only"
            ? runtime.state_generation : runtime.state_generation - 1n;
          const generationDelta = targetIdleGeneration - initialIdleGeneration;
          if (generationDelta < 0n || generationDelta % 2n !== 0n ||
            runtime.row_version !== BigInt(input.expectedRuntimeRowVersion) +
              (runtime.state_generation - durableResume.expected_generation)) {
            refuseCatalogBridge("CATALOG_BRIDGE_EVENT_PREQUEUE_RECOVERY_UNPROVEN");
          }
          await proveSucceededEventRecoveryHistory({ database, policy: input.policy,
            state: input.state, run: latest, baseIdleGeneration: initialIdleGeneration,
            baseIdleRowVersion: BigInt(input.expectedRuntimeRowVersion) + 1n,
            targetIdleGeneration, checkpointHash: restored.cursorHash,
            checkpoint: restored.cursor, scope: "event-prequeue" });
        }
        if (disposition === "resume_prequeue_then_queue") {
          const pauseIdentity = recoveryPauseIdentity(input.state, runtime.state_generation - 1n);
          const recovery = await readRecoveryPausedBoundary({ database, policy: input.policy,
            state: input.state, pauseCommandId: pauseIdentity.commandId,
            allowedImportLeaseOwner: input.policy.utility.workerId });
          if (recovery.latest.id !== input.state.catalogRunId) {
            refuseCatalogBridge("CATALOG_BRIDGE_EVENT_PREQUEUE_RECOVERY_UNPROVEN");
          }
          const identity = recoveryResumeIdentity(input.state, "event-prequeue",
            recovery.runtime.state_generation);
          const recoveryGuard: ProviderRuntimeResumeGuard = Object.freeze({
            entry: "paused", providerId: definition.providerId,
            configVersionId: plan.eventSuccessor.id,
            configVersionNumber: BigInt(plan.eventSuccessor.versionNumber),
            runtimeRowVersion: recovery.runtime.row_version,
            checkpointHash: restored.cursorHash, checkpoint: restored.cursor,
            latestRunId: recovery.latest.id,
            latestRunDigest: providerResumeEvidenceDigest(recovery.latest),
            pauseCommandId: recovery.pause.id,
            pauseCommandDigest: providerResumeEvidenceDigest(recovery.pause),
            expectedImportLease: { owner: lease.owner, fence: lease.fence },
            notAfter: lease.expiresAt,
          });
          const resumed = await admin.submitRuntimeCommand({ commandId: identity.commandId,
            idempotencyKey: identity.idempotencyKey, commandType: "resume",
            expectedGeneration: recovery.runtime.state_generation,
            requestedByOperatorId: input.policy.pins.operatorId,
            correlationId: input.state.operationId, reason: identity.reason,
            requestedAt: input.now(), expectedRuntimeGuard: recoveryGuard });
          if (!["accepted", "deduplicated"].includes(resumed.outcome) || resumed.state !== "idle" ||
            resumed.generation !== recovery.runtime.state_generation + 1n) {
            refuseCatalogBridge("CATALOG_BRIDGE_EVENT_PREQUEUE_RECOVERY_RESUME_REFUSED");
          }
          const [durableRecovery, recoveryAudit] = await Promise.all([
            database.control_commands.findUnique({ where: { id: identity.commandId } }),
            database.local_audit_events.findFirst({ where: {
              command_id: identity.commandId, action: "provider.runtime.resume_guard",
            } }),
          ]);
          const recoveryResult = storedResult(durableRecovery?.result);
          const recoveryDetails = recoveryAudit?.details as Record<string, unknown> | null | undefined;
          if (!durableRecovery || durableRecovery.command_type !== "resume" ||
            durableRecovery.state !== "completed" || durableRecovery.completed_at === null ||
            durableRecovery.idempotency_key !== identity.idempotencyKey ||
            durableRecovery.target_run_id !== null || durableRecovery.target_quarantine_id !== null ||
            durableRecovery.resulting_run_id !== null ||
            durableRecovery.expected_generation !== recovery.runtime.state_generation ||
            durableRecovery.requested_by_operator_id !== input.policy.pins.operatorId ||
            durableRecovery.correlation_id !== input.state.operationId ||
            durableRecovery.reason !== identity.reason || recoveryResult?.outcome !== "accepted" ||
            recoveryResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
            recoveryResult.generation !== (recovery.runtime.state_generation + 1n).toString() ||
            recoveryAudit?.outcome !== "success" ||
            recoveryAudit.actor_operator_id !== input.policy.pins.operatorId ||
            recoveryAudit.correlation_id !== input.state.operationId ||
            recoveryAudit.target_type !== "control_command" ||
            recoveryAudit.target_id !== durableRecovery.id ||
            recoveryDetails?.guardDigest !== semanticGuardDigest(recoveryGuard)) {
            refuseCatalogBridge("CATALOG_BRIDGE_EVENT_PREQUEUE_RECOVERY_UNPROVEN");
          }
        }
        const afterResume = await database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
        const queued = await admin.requestRunNow({ providerId: definition.providerId,
          operatorId: input.policy.pins.operatorId, expectedConfigVersionId: plan.eventSuccessor.id,
          expectedConfigVersionNumber: BigInt(plan.eventSuccessor.versionNumber),
          expectedGeneration: afterResume.state_generation,
          idempotencyKey: `catalog-bridge/${input.state.operationId}/event-resume/run`,
          commandId: ids.eventRunCommandId, runId, correlationId: input.state.operationId,
          expectedCursorFingerprint: restored.cursorHash, requireNoActiveRun: true,
          expectedImportLease: { owner: input.policy.utility.workerId, fence: lease.fence },
          notAfter: lease.expiresAt });
        if (queued.kind !== "created" && queued.kind !== "deduplicated") {
          refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_QUEUE_REFUSED");
        }
        if (queued.run.id !== runId) refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_QUEUE_REFUSED");
      } finally {
        const released = await leases.release({ role: "import", owner: input.policy.utility.workerId,
          fence: lease.fence });
        if (!released) refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_LEASE_LOST");
      }
    } else if (processOffline && existing.state === "queued") {
      // A hard exit may strand this operation's utility lease either live or
      // expired. Prove the complete immutable queue before renewing/re-fencing
      // and releasing it; foreign or malformed ownership remains untouchable.
      const [stranded] = await database.$queryRawUnsafe<ImportLeaseRow[]>(
        "select worker_role, lease_owner, lease_fence, heartbeat_at, lease_expires_at, row_version, " +
        "clock_timestamp() as database_now from provider_worker_states " +
        "where worker_role='import'::worker_role");
      if (stranded?.lease_owner === input.policy.utility.workerId) {
        await readExactEventResumeAdmission({ database, policy: input.policy, state: input.state,
          cursorRestoreReceiptDigest: input.cursorRestoreReceiptDigest,
          expectedRuntimeRowVersion: input.expectedRuntimeRowVersion,
          processOffline, processOnline, leaseState: "operation_owned" });
        const leases = new PrismaProviderWorkerLeaseRepository(database);
        const acquired = await leases.acquire({ role: "import", owner: input.policy.utility.workerId,
          leaseMilliseconds: input.policy.utility.leaseMilliseconds });
        if (acquired.kind === "held" || !await leases.release({ role: "import",
          owner: input.policy.utility.workerId, fence: acquired.lease.fence })) {
          refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_LEASE_LOST");
        }
      }
    } else if (processOffline && existing.state === "succeeded") {
      const runtime = await database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
      if (runtime.operating_state === "paused") {
        await resumeSucceededEventAfterRecovery({ database, policy: input.policy,
          state: input.state, cursorRestoreReceiptDigest: input.cursorRestoreReceiptDigest,
          expectedRuntimeRowVersion: input.expectedRuntimeRowVersion,
          now: input.now });
      } else if (runtime.operating_state === "idle") {
        const stranded = await database.provider_worker_states.findUniqueOrThrow({
          where: { worker_role: "import" },
        });
        if (stranded.lease_owner === input.policy.utility.workerId) {
          await releaseSucceededEventRecoveryLease({ database, policy: input.policy,
            state: input.state, cursorRestoreReceiptDigest: input.cursorRestoreReceiptDigest,
            expectedRuntimeRowVersion: input.expectedRuntimeRowVersion,
            processOffline, processOnline });
        }
      }
    }
    await readExactEventResumeAdmission({ database, policy: input.policy, state: input.state,
      cursorRestoreReceiptDigest: input.cursorRestoreReceiptDigest,
      expectedRuntimeRowVersion: input.expectedRuntimeRowVersion,
      processOffline, processOnline, leaseState: "released" });
  }));
}

interface RecoveryPausedBoundary {
  readonly runtime: Awaited<ReturnType<ProviderTransactionClient["provider_runtime"]["findUniqueOrThrow"]>>;
  readonly latest: NonNullable<Awaited<ReturnType<ProviderTransactionClient["provider_runs"]["findFirst"]>>>;
  readonly pause: NonNullable<Awaited<ReturnType<ProviderTransactionClient["control_commands"]["findUnique"]>>>;
  readonly lease: ImportLeaseRow;
}

function recoveryPauseMatches(input: Readonly<{ pause: RecoveryPausedBoundary["pause"];
  runtimeGeneration: bigint; policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState }>): boolean {
  const result = storedResult(input.pause.result);
  if (!result || !input.pause.completed_at || input.pause.command_type !== "pause" ||
    input.pause.state !== "completed" || input.pause.target_run_id !== null ||
    input.pause.target_quarantine_id !== null || input.pause.resulting_run_id !== null ||
    input.pause.requested_by_operator_id !== input.policy.pins.operatorId ||
    input.pause.correlation_id !== input.state.operationId || result.outcome !== "accepted" ||
    result.code !== "RUNTIME_TRANSITION_APPLIED" ||
    result.generation !== input.runtimeGeneration.toString() ||
    input.pause.expected_generation + 1n !== input.runtimeGeneration) return false;
  const ids = catalogBridgeCatalogOperationIds(input.policy.pins);
  if (input.pause.id === ids.postCatalogPauseCommandId) {
    return input.pause.idempotency_key ===
      `catalog-bridge/${input.state.operationId}/post-catalog/pause` &&
      input.pause.reason ===
        `DataForrest ${input.state.providerKey} catalog bridge post-catalog pause`;
  }
  const expected = recoveryPauseIdentity(input.state, input.pause.expected_generation);
  return input.pause.id === expected.commandId &&
    input.pause.idempotency_key === expected.idempotencyKey &&
    input.pause.reason === expected.reason;
}

async function readRecoveryPausedBoundary(input: Readonly<{
  database: ProviderPrismaClient; policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState; pauseCommandId: string;
  allowedImportLeaseOwner?: string;
}>): Promise<RecoveryPausedBoundary> {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const restored = reEnvelopeSavedEventCursor(input.state);
  return input.database.$transaction(async (transaction) => {
    const lease = await lockImportLease(transaction);
    const before = await transaction.provider_runs.findFirst({
      orderBy: [{ requested_at: "desc" }, { id: "desc" }],
    });
    if (!before) refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_RUN_MISSING");
    await lockExactRun(transaction, before.id);
    await lockRuntime(transaction);
    const [runtime, latest, pause, activeRuns, commands, activeTransactions] = await Promise.all([
      transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
      transaction.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
      transaction.control_commands.findUnique({ where: { id: input.pauseCommandId } }),
      transaction.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
      transaction.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
      transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
        "select count(*)::bigint as count from pg_stat_activity " +
        "where datname=current_database() and pid<>pg_backend_pid() and state<>'idle'"),
    ]);
    const catalogPrequeue = latest?.id === input.state.catalogRunId &&
      latest.state === "succeeded" && latest.reached_source_head && latest.finished_at !== null &&
      latest.config_version_id === plan.catalog.id &&
      latest.config_version_number === BigInt(plan.catalog.versionNumber) &&
      runtime.source_cursor_hash === restored.cursorHash &&
      cursorFingerprint(runtime.source_cursor) === restored.cursorHash;
    const eventTerminal = latest?.id !== input.state.catalogRunId && !!latest &&
      ["succeeded", "failed", "incomplete"].includes(latest.state) &&
      latest.finished_at !== null && latest.final_cursor_hash === runtime.source_cursor_hash;
    const terminal = catalogPrequeue || eventTerminal;
    const releasedLease = lease.lease_owner === null && lease.heartbeat_at === null &&
      lease.lease_expires_at === null;
    const operationOwnedLease = input.allowedImportLeaseOwner !== undefined &&
      lease.lease_owner === input.allowedImportLeaseOwner && lease.heartbeat_at !== null &&
      lease.lease_expires_at !== null;
    if (!latest || latest.id !== before.id || !pause || !terminal ||
      runtime.operating_state !== "paused" ||
      runtime.cached_config_version_id !== plan.eventSuccessor.id ||
      runtime.cached_config_version_number !== BigInt(plan.eventSuccessor.versionNumber) ||
      runtime.source_cursor_hash === null ||
      runtime.source_cursor_hash !== cursorFingerprint(runtime.source_cursor) ||
      (latest.id === input.state.catalogRunId
        ? latest.config_version_id !== plan.catalog.id
        : latest.config_version_id !== plan.eventSuccessor.id) ||
      (latest.id !== input.state.catalogRunId && latest.requested_cursor_hash !== restored.cursorHash) ||
      activeRuns !== 0 || commands !== 0 || Number(activeTransactions[0]?.count ?? 0n) !== 0 ||
      (!releasedLease && !operationOwnedLease) ||
      !recoveryPauseMatches({ pause, runtimeGeneration: runtime.state_generation,
        policy: input.policy, state: input.state })) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_NOT_SETTLED");
    }
    return Object.freeze({ runtime, latest, pause, lease });
  }, PROVIDER_TRANSACTION);
}

async function resumeSucceededEventAfterRecovery(input: Readonly<{
  database: ProviderPrismaClient;
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  cursorRestoreReceiptDigest: string;
  expectedRuntimeRowVersion: string;
  now: () => Date;
}>): Promise<void> {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const definition = catalogBridgeProvider(input.state.providerKey);
  const restored = reEnvelopeSavedEventCursor(input.state);
  const ids = catalogBridgeCatalogOperationIds(input.policy.pins);
  const runId = catalogBridgeResumeRunId(input.state.operationId, input.state.providerKey);
  const runtime = await input.database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
  if (runtime.operating_state !== "paused" || runtime.state_generation < 2n) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_RESUME_UNPROVEN");
  }
  const pauseIdentity = recoveryPauseIdentity(input.state, runtime.state_generation - 1n);
  const boundary = await readRecoveryPausedBoundary({ database: input.database,
    policy: input.policy, state: input.state, pauseCommandId: pauseIdentity.commandId,
    allowedImportLeaseOwner: input.policy.utility.workerId });
  const provenance = await input.database.$transaction(async (transaction) => {
    const [runCommand, resumeCommand, resumeGuard, head, catalogRun, originalPause] = await Promise.all([
      transaction.control_commands.findUnique({ where: { id: ids.eventRunCommandId } }),
      transaction.control_commands.findUnique({ where: { id: ids.eventResumeCommandId } }),
      transaction.local_audit_events.findFirst({ where: {
        command_id: ids.eventResumeCommandId, action: "provider.runtime.resume_guard",
      } }),
      readProviderRunHeadProof(transaction, runId),
      transaction.provider_runs.findUnique({ where: { id: input.state.catalogRunId } }),
      transaction.control_commands.findUnique({ where: { id: ids.postCatalogPauseCommandId } }),
    ]);
    const runResult = storedResult(runCommand?.result);
    const resumeResult = storedResult(resumeCommand?.result);
    const guardDetails = resumeGuard?.details as Record<string, unknown> | null | undefined;
    if (!catalogRun || !originalPause) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_RESUME_UNPROVEN");
    }
    const originalGuard: ProviderRuntimeResumeGuard = Object.freeze({
      entry: "paused", providerId: definition.providerId,
      configVersionId: plan.eventSuccessor.id,
      configVersionNumber: BigInt(plan.eventSuccessor.versionNumber),
      runtimeRowVersion: BigInt(input.expectedRuntimeRowVersion),
      checkpointHash: restored.cursorHash, checkpoint: restored.cursor,
      latestRunId: catalogRun.id, latestRunDigest: providerResumeEvidenceDigest(catalogRun),
      pauseCommandId: originalPause.id,
      pauseCommandDigest: providerResumeEvidenceDigest(originalPause),
      expectedImportLease: { owner: input.policy.utility.workerId, fence: 1n },
    });
    if (boundary.latest.id !== runId || boundary.latest.state !== "succeeded" ||
      !boundary.latest.reached_source_head || boundary.latest.page_count < 1 ||
      boundary.latest.control_command_id !== ids.eventRunCommandId ||
      boundary.latest.idempotency_key !== `command/${ids.eventRunCommandId}` ||
      boundary.latest.config_version_id !== plan.eventSuccessor.id ||
      boundary.latest.config_version_number !== BigInt(plan.eventSuccessor.versionNumber) ||
      boundary.latest.requested_cursor_hash !== restored.cursorHash ||
      cursorFingerprint(boundary.latest.requested_cursor) !== restored.cursorHash ||
      !head?.reconciliationComplete || catalogRun.state !== "succeeded" ||
      !catalogRun.reached_source_head || catalogRun.config_version_id !== plan.catalog.id ||
      catalogRun.config_version_number !== BigInt(plan.catalog.versionNumber) ||
      catalogRun.requested_cursor !== null || catalogRun.requested_cursor_hash !== null ||
      !runCommand || runCommand.command_type !== "run" ||
      runCommand.state !== "completed" || runCommand.completed_at === null ||
      runCommand.idempotency_key !== `catalog-bridge/${input.state.operationId}/event-resume/run` ||
      runCommand.target_run_id !== null || runCommand.target_quarantine_id !== null ||
      runCommand.resulting_run_id !== runId || runCommand.reason !== null ||
      runCommand.requested_by_operator_id !== input.policy.pins.operatorId ||
      runCommand.correlation_id !== input.state.operationId || runResult?.outcome !== "accepted" ||
      runResult.code !== "RUN_STARTED" ||
      runResult.generation !== (runCommand.expected_generation + 1n).toString() ||
      !resumeCommand || resumeCommand.command_type !== "resume" ||
      resumeCommand.state !== "completed" ||
      resumeCommand.idempotency_key !== `catalog-bridge/${input.state.operationId}/event-resume/resume` ||
      resumeCommand.target_run_id !== null || resumeCommand.target_quarantine_id !== null ||
      resumeCommand.requested_by_operator_id !== input.policy.pins.operatorId ||
      resumeCommand.correlation_id !== input.state.operationId ||
      resumeCommand.resulting_run_id !== null || resumeCommand.completed_at === null ||
      resumeCommand.reason !== `DataForrest ${input.state.providerKey} catalog bridge restored event cursor resume ` +
        `[${input.cursorRestoreReceiptDigest}]` || resumeResult?.outcome !== "accepted" ||
      resumeResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
      resumeResult.generation !== runCommand.expected_generation.toString() ||
      resumeGuard?.outcome !== "success" ||
      resumeGuard.actor_operator_id !== input.policy.pins.operatorId ||
      resumeGuard.correlation_id !== input.state.operationId ||
      resumeGuard.target_type !== "control_command" || resumeGuard.target_id !== resumeCommand.id ||
      guardDetails?.guardDigest !== semanticGuardDigest(originalGuard)) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_RESUME_UNPROVEN");
    }
    await proveSucceededEventRecoveryHistory({ database: transaction, policy: input.policy,
      state: input.state, run: catalogRun,
      baseIdleGeneration: resumeCommand.expected_generation + 1n,
      baseIdleRowVersion: BigInt(input.expectedRuntimeRowVersion) + 1n,
      targetIdleGeneration: runCommand.expected_generation,
      checkpointHash: restored.cursorHash, checkpoint: restored.cursor,
      scope: "event-prequeue" });
    if (boundary.runtime.source_cursor_hash === null ||
      cursorFingerprint(boundary.runtime.source_cursor) !== boundary.runtime.source_cursor_hash) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_RESUME_UNPROVEN");
    }
    const baseIdleGeneration = BigInt(runResult.generation) + 1n;
    const queueRuntimeRowVersion = BigInt(input.expectedRuntimeRowVersion) +
      (runCommand.expected_generation - resumeCommand.expected_generation);
    const baseIdleRowVersion = queueRuntimeRowVersion + 2n + BigInt(boundary.latest.page_count) +
      BigInt(head.reconciliationBatchNumber);
    if (boundary.runtime.row_version !== baseIdleRowVersion +
      (boundary.runtime.state_generation - baseIdleGeneration)) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_RESUME_UNPROVEN");
    }
    await proveSucceededEventRecoveryHistory({ database: transaction, policy: input.policy,
      state: input.state, run: boundary.latest, baseIdleGeneration, baseIdleRowVersion,
      targetIdleGeneration: boundary.runtime.state_generation - 1n,
      checkpointHash: boundary.runtime.source_cursor_hash,
      checkpoint: boundary.runtime.source_cursor as CanonicalJsonValue,
      scope: "event-successor" });
    return Object.freeze({ pause: boundary.pause, latest: boundary.latest,
      runtime: boundary.runtime });
  }, PROVIDER_TRANSACTION);
  const leases = new PrismaProviderWorkerLeaseRepository(input.database);
  const acquired = await leases.acquire({ role: "import", owner: input.policy.utility.workerId,
    leaseMilliseconds: input.policy.utility.leaseMilliseconds });
  if (acquired.kind === "held") refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_LEASE_HELD");
  const lease = acquired.lease;
  try {
    const identity = recoveryResumeIdentity(input.state, "event-successor",
      provenance.runtime.state_generation);
    const guard: ProviderRuntimeResumeGuard = Object.freeze({
      entry: "paused", providerId: catalogBridgeProvider(input.state.providerKey).providerId,
      configVersionId: plan.eventSuccessor.id,
      configVersionNumber: BigInt(plan.eventSuccessor.versionNumber),
      runtimeRowVersion: provenance.runtime.row_version,
      checkpointHash: provenance.runtime.source_cursor_hash!,
      checkpoint: provenance.runtime.source_cursor as CanonicalJsonValue,
      latestRunId: provenance.latest.id,
      latestRunDigest: providerResumeEvidenceDigest(provenance.latest),
      pauseCommandId: provenance.pause.id,
      pauseCommandDigest: providerResumeEvidenceDigest(provenance.pause),
      expectedImportLease: { owner: lease.owner, fence: lease.fence }, notAfter: lease.expiresAt,
    });
    const result = await new PrismaAdminProviderRuntimeRepository(input.database).submitRuntimeCommand({
      commandId: identity.commandId, idempotencyKey: identity.idempotencyKey,
      commandType: "resume", expectedGeneration: provenance.runtime.state_generation,
      requestedByOperatorId: input.policy.pins.operatorId, correlationId: input.state.operationId,
      reason: identity.reason, requestedAt: input.now(), expectedRuntimeGuard: guard,
    });
    if (!["accepted", "deduplicated"].includes(result.outcome) || result.state !== "idle" ||
      result.generation !== provenance.runtime.state_generation + 1n) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_RESUME_REFUSED");
    }
    const [durable, audit] = await Promise.all([
      input.database.control_commands.findUnique({ where: { id: identity.commandId } }),
      input.database.local_audit_events.findFirst({ where: {
        command_id: identity.commandId, action: "provider.runtime.resume_guard",
      } }),
    ]);
    const durableResult = storedResult(durable?.result);
    const details = audit?.details as Record<string, unknown> | null | undefined;
    if (!durable || durable.command_type !== "resume" || durable.state !== "completed" ||
      durable.completed_at === null || durable.target_run_id !== null ||
      durable.target_quarantine_id !== null || durable.resulting_run_id !== null ||
      durable.idempotency_key !== identity.idempotencyKey || durable.reason !== identity.reason ||
      durable.requested_by_operator_id !== input.policy.pins.operatorId ||
      durable.correlation_id !== input.state.operationId ||
      durable.expected_generation !== provenance.runtime.state_generation ||
      durableResult?.outcome !== "accepted" ||
      durableResult.code !== "RUNTIME_TRANSITION_APPLIED" ||
      durableResult.generation !== (provenance.runtime.state_generation + 1n).toString() ||
      audit?.outcome !== "success" || audit.actor_operator_id !== input.policy.pins.operatorId ||
      audit.correlation_id !== input.state.operationId || audit.target_type !== "control_command" ||
      audit.target_id !== durable.id || details?.guardDigest !== semanticGuardDigest(guard)) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_RESUME_UNPROVEN");
    }
  } finally {
    if (!await leases.release({ role: "import", owner: input.policy.utility.workerId,
      fence: lease.fence })) {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_LEASE_LOST");
    }
  }
}

/** Reconciles the hard-crash prefix after the guarded recovery resume but before lease release. */
async function releaseSucceededEventRecoveryLease(input: Readonly<{
  database: ProviderPrismaClient;
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  cursorRestoreReceiptDigest: string;
  expectedRuntimeRowVersion: string;
  processOffline: boolean;
  processOnline: boolean;
}>): Promise<void> {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const boundary = await readExactEventResumeAdmission({ ...input,
    leaseState: "operation_owned" });
  const runtime = boundary.runtime;
  if (runtime.operating_state !== "idle" || runtime.state_generation < 3n ||
    runtime.row_version < 2n || runtime.source_cursor_hash === null ||
    cursorFingerprint(runtime.source_cursor) !== runtime.source_cursor_hash) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_RESUME_UNPROVEN");
  }
  const expectedGeneration = runtime.state_generation - 1n;
  const identity = recoveryResumeIdentity(input.state, "event-successor", expectedGeneration);
  const pauseIdentity = recoveryPauseIdentity(input.state, expectedGeneration - 1n);
  const [resume, pause, audit] = await Promise.all([
    input.database.control_commands.findUnique({ where: { id: identity.commandId } }),
    input.database.control_commands.findUnique({ where: { id: pauseIdentity.commandId } }),
    input.database.local_audit_events.findFirst({ where: {
      command_id: identity.commandId, action: "provider.runtime.resume_guard",
    } }),
  ]);
  if (!resume || !pause || !recoveryPauseMatches({ pause,
    runtimeGeneration: expectedGeneration, policy: input.policy, state: input.state })) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_RESUME_UNPROVEN");
  }
  const guard: ProviderRuntimeResumeGuard = Object.freeze({
    entry: "paused", providerId: catalogBridgeProvider(input.state.providerKey).providerId,
    configVersionId: plan.eventSuccessor.id,
    configVersionNumber: BigInt(plan.eventSuccessor.versionNumber),
    runtimeRowVersion: runtime.row_version - 1n,
    checkpointHash: runtime.source_cursor_hash,
    checkpoint: runtime.source_cursor as CanonicalJsonValue,
    latestRunId: boundary.run.id, latestRunDigest: providerResumeEvidenceDigest(boundary.run),
    pauseCommandId: pause.id, pauseCommandDigest: providerResumeEvidenceDigest(pause),
    expectedImportLease: { owner: input.policy.utility.workerId, fence: boundary.lease.lease_fence },
  });
  const result = storedResult(resume.result);
  const details = audit?.details as Record<string, unknown> | null | undefined;
  if (resume.command_type !== "resume" || resume.state !== "completed" ||
    resume.completed_at === null || resume.idempotency_key !== identity.idempotencyKey ||
    resume.target_run_id !== null || resume.target_quarantine_id !== null ||
    resume.resulting_run_id !== null || resume.expected_generation !== expectedGeneration ||
    resume.requested_by_operator_id !== input.policy.pins.operatorId ||
    resume.correlation_id !== input.state.operationId || resume.reason !== identity.reason ||
    result?.outcome !== "accepted" || result.code !== "RUNTIME_TRANSITION_APPLIED" ||
    result.generation !== runtime.state_generation.toString() || audit?.outcome !== "success" ||
    audit.actor_operator_id !== input.policy.pins.operatorId ||
    audit.correlation_id !== input.state.operationId || audit.target_type !== "control_command" ||
    audit.target_id !== resume.id || details?.guardDigest !== semanticGuardDigest(guard)) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_RESUME_UNPROVEN");
  }
  const released = await new PrismaProviderWorkerLeaseRepository(input.database).release({
    role: "import", owner: input.policy.utility.workerId, fence: boundary.lease.lease_fence,
  });
  if (!released) refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RESUME_LEASE_LOST");
}

function recoveryPauseProof(input: Readonly<{ boundary: RecoveryPausedBoundary;
  activeConfigId: string; now: () => Date }>): CatalogBridgeRecoveryPauseProof {
  return Object.freeze({ observedAt: input.now().toISOString(),
    activeConfigId: input.activeConfigId,
    runtimeGeneration: input.boundary.runtime.state_generation.toString(),
    runtimeRowVersion: input.boundary.runtime.row_version.toString(),
    pauseCommandId: input.boundary.pause.id,
    pauseCommandDigest: pauseDigest(input.boundary.pause),
    latestTerminalRunId: input.boundary.latest.id,
    latestTerminalRunDigest: providerResumeEvidenceDigest(input.boundary.latest) });
}

function stableRecoveryProof(value: CatalogBridgeRecoveryPauseProof): string {
  const { observedAt, ...stable } = value;
  void observedAt;
  return catalogBridgeDigest(stable);
}

async function pauseResidentForRecovery(input: Readonly<{
  central: CentralPrismaClient; runProvider: CatalogBridgeCatalogLiveDatabaseDependencies["runProvider"];
  policy: CatalogBridgeCatalogLivePolicy; state: CatalogBridgePrivatePreparedState;
  now: () => Date; wait: (milliseconds: number) => Promise<void>;
}>): Promise<CatalogBridgeRecoveryPauseProof> {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const central = await readCentralBoundary(input);
  if (central.provider?.active_config_version_id !== plan.eventSuccessor.id ||
    central.provider.row_version !== BigInt(input.policy.current.providerRowVersion) + 2n) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_AUTHORITY_CHANGED");
  }
  return reachable(await input.runProvider(central.route, async (database) => {
    let runtime = await database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
    let latest = await database.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] });
    for (let index = 0; latest?.state === "queued" &&
      index < input.policy.utility.pauseMaximumObservations; index += 1) {
      await input.wait(input.policy.utility.pausePollMilliseconds);
      [runtime, latest] = await Promise.all([
        database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
        database.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
      ]);
    }
    if (latest?.state === "queued") {
      refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_QUEUED_RACE");
    }
    let pauseCommandId: string;
    if (runtime.operating_state === "paused") {
      const candidates = await database.control_commands.findMany({ where: {
        correlation_id: input.state.operationId, command_type: "pause", state: "completed",
      }, orderBy: [{ requested_at: "desc" }, { id: "desc" }], take: 10 });
      const candidate = candidates.find((pause) => recoveryPauseMatches({ pause,
        runtimeGeneration: runtime.state_generation, policy: input.policy, state: input.state }));
      if (!candidate) refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_PAUSE_MISSING");
      pauseCommandId = candidate.id;
    } else {
      const identity = recoveryPauseIdentity(input.state, runtime.state_generation);
      const submitted = await new PrismaAdminProviderRuntimeRepository(database).submitRuntimeCommand({
        commandId: identity.commandId, idempotencyKey: identity.idempotencyKey,
        commandType: "pause", expectedGeneration: runtime.state_generation,
        requestedByOperatorId: input.policy.pins.operatorId,
        correlationId: input.state.operationId, reason: identity.reason, requestedAt: input.now(),
      });
      if (!["accepted", "deduplicated"].includes(submitted.outcome) ||
        submitted.state !== "paused" || submitted.generation !== runtime.state_generation + 1n) {
        refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_PAUSE_REFUSED");
      }
      pauseCommandId = identity.commandId;
    }
    for (let index = 0; index < input.policy.utility.pauseMaximumObservations; index += 1) {
      try {
        const boundary = await readRecoveryPausedBoundary({ database, policy: input.policy,
          state: input.state, pauseCommandId });
        return recoveryPauseProof({ boundary, activeConfigId: plan.eventSuccessor.id, now: input.now });
      } catch (error) {
        if (!(error instanceof CatalogBridgeError) ||
          error.code !== "CATALOG_BRIDGE_EVENT_RECOVERY_NOT_SETTLED") throw error;
      }
      await input.wait(input.policy.utility.pausePollMilliseconds);
    }
    return refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_PAUSE_TIMEOUT");
  }));
}

async function proveResidentRecoveryPaused(input: Readonly<{
  central: CentralPrismaClient; runProvider: CatalogBridgeCatalogLiveDatabaseDependencies["runProvider"];
  policy: CatalogBridgeCatalogLivePolicy; state: CatalogBridgePrivatePreparedState;
  proof: CatalogBridgeRecoveryPauseProof; now: () => Date;
}>): Promise<void> {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const central = await readCentralBoundary(input);
  if (central.provider?.active_config_version_id !== plan.eventSuccessor.id ||
    input.proof.activeConfigId !== plan.eventSuccessor.id) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_AUTHORITY_CHANGED");
  }
  const boundary = reachable(await input.runProvider(central.route, (database) =>
    readRecoveryPausedBoundary({ database, policy: input.policy, state: input.state,
      pauseCommandId: input.proof.pauseCommandId })));
  const observed = recoveryPauseProof({ boundary, activeConfigId: plan.eventSuccessor.id, now: input.now });
  if (stableRecoveryProof(observed) !== stableRecoveryProof(input.proof)) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RECOVERY_PROOF_CHANGED");
  }
}

async function resumeObservation(input: Readonly<{
  central: CentralPrismaClient; runProvider: CatalogBridgeCatalogLiveDatabaseDependencies["runProvider"];
  policy: CatalogBridgeCatalogLivePolicy; state: CatalogBridgePrivatePreparedState;
  process: CatalogBridgeDrainProcessObservation; now: () => Date;
}>): Promise<CatalogBridgeResumeObservation | null> {
  const plan = catalogBridgeConfigurationPlan(input.state);
  const definition = catalogBridgeProvider(input.state.providerKey);
  const restored = reEnvelopeSavedEventCursor(input.state);
  const runId = catalogBridgeResumeRunId(input.state.operationId, input.state.providerKey);
  const central = await readCentralBoundary(input);
  if (central.provider?.active_config_version_id !== plan.eventSuccessor.id) {
    refuseCatalogBridge("CATALOG_BRIDGE_RESUME_AUTHORITY_CHANGED");
  }
  return reachable(await input.runProvider(central.route, async (database) =>
    database.$transaction(async (transaction) => {
      const lease = await lockImportLease(transaction);
      await lockExactRun(transaction, runId);
      await lockRuntime(transaction);
      const [runtime, run, latest, activeRuns, commands, activeTransactions] = await Promise.all([
        transaction.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } }),
        transaction.provider_runs.findUnique({ where: { id: runId } }),
        transaction.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
        transaction.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
        transaction.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
        transaction.$queryRawUnsafe<Array<{ count: bigint }>>(
          "select count(*)::bigint as count from pg_stat_activity " +
          "where datname=current_database() and pid<>pg_backend_pid() and state<>'idle'"),
      ]);
      if (!run || latest?.id !== run.id) {
        refuseCatalogBridge("CATALOG_BRIDGE_RESUME_RUN_CHANGED");
      }
      if (["queued", "running"].includes(run.state)) return null;
      if (run.state !== "succeeded") refuseCatalogBridge("CATALOG_BRIDGE_RESUME_RUN_FAILED");
      const head = await readProviderRunHeadProof(transaction, run.id);
      if (!head || !head.reconciliationComplete || !run.reached_source_head ||
        run.config_version_id !== plan.eventSuccessor.id ||
        run.requested_cursor_hash !== restored.cursorHash ||
        cursorFingerprint(run.requested_cursor) !== restored.cursorHash ||
        runtime.operating_state !== "idle" ||
        runtime.cached_config_version_id !== plan.eventSuccessor.id || activeRuns !== 0 || commands !== 0 ||
        Number(activeTransactions[0]?.count ?? 0n) !== 0 || lease.lease_owner !== null ||
        lease.heartbeat_at !== null || lease.lease_expires_at !== null ||
        input.process.launchdLabel !== definition.launchdLabel || !input.process.launchdLoaded ||
        input.process.processCount !== 1 || input.process.pids.length !== 1 ||
        input.process.processIdentitySha256 === null ||
        input.process.residencyPort !== definition.residencyPort ||
        !input.process.residencyPortListening) {
        refuseCatalogBridge("CATALOG_BRIDGE_RESUME_ACCEPTANCE_CHANGED");
      }
      return Object.freeze({ observedAt: input.now().toISOString(),
        launchdLabel: definition.launchdLabel, processCount: 1,
        residencyPortListening: true, activeConfigId: plan.eventSuccessor.id,
        cachedConfigId: plan.eventSuccessor.id, startupRunId: run.id,
        startupRunState: "succeeded" as const, startupRunRequestedCursorHash: restored.cursorHash,
        startupRunReachedHead: true as const, activeRunCount: 0, actionableCommandCount: 0,
        importLeaseOwner: null });
    }, PROVIDER_TRANSACTION)));
}

async function releaseResidentAfterJournal(input: Readonly<{
  central: CentralPrismaClient;
  runProvider: CatalogBridgeCatalogLiveDatabaseDependencies["runProvider"];
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  resumedReceiptDigest: string;
  wait: (milliseconds: number) => Promise<void>;
}>): Promise<void> {
  const definition = catalogBridgeProvider(input.state.providerKey);
  const plan = catalogBridgeConfigurationPlan(input.state);
  const boundary = await readCentralBoundary(input);
  assertCentralShape({ boundary, ...input, allowCatalog: true });
  const authorityProvider = await input.central.providers.findUnique({
    where: { id_organization_id: { id: definition.providerId,
      organization_id: definition.organizationId } },
    include: { active_config_version: { include: { source_credential: true } } },
  });
  const config = authorityProvider?.active_config_version;
  if (!authorityProvider || !config ||
    authorityProvider.active_config_version_id !== plan.eventSuccessor.id ||
    boundary.provider?.active_config_version_id !== plan.eventSuccessor.id ||
    boundary.eventSuccessor?.id !== plan.eventSuccessor.id || config.id !== plan.eventSuccessor.id ||
    config.version_number !== BigInt(plan.eventSuccessor.versionNumber) ||
    config.adapter_key !== plan.eventSuccessor.adapterVersion ||
    boundary.route.configVersionId !== plan.eventSuccessor.id ||
    boundary.route.organizationId !== definition.organizationId ||
    boundary.route.target.providerId !== definition.providerId ||
    boundary.route.target.providerKey !== definition.providerKey) {
    refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RELEASE_AUTHORITY_CHANGED");
  }
  const integration = providerDataforrestLiveIntegrationRegistry.resolve(
    definition.providerKey, config.adapter_key);
  const pins: BackfillPins = Object.freeze({ organizationId: definition.organizationId,
    providerId: definition.providerId, providerKey: definition.providerKey,
    configId: plan.eventSuccessor.id,
    initialRunId: catalogBridgeResumeRunId(input.state.operationId, input.state.providerKey),
    operationId: input.state.operationId, operatorId: input.policy.pins.operatorId });
  const authority: BackfillAuthority = Object.freeze({ route: boundary.route,
    configNumber: config.version_number, integration,
    cachedConfiguration: { adapterKey: config.adapter_key, settings: config.configuration },
    expiresAt: config.expires_at, scheduleSeconds: config.schedule_seconds,
    digest: backfillDigest({ route: boundary.route, config,
      organizationId: pins.organizationId, operatorId: pins.operatorId,
      providerKey: pins.providerKey }) });
  for (let index = 0;
    index < input.policy.successorLaunchAgent.startupMaximumObservations; index += 1) {
    const release = reachable(await input.runProvider(boundary.route, database =>
      persistResidentRelease(database, pins, authority, input.resumedReceiptDigest)));
    if (release) return;
    await input.wait(input.policy.successorLaunchAgent.startupPollMilliseconds);
  }
  refuseCatalogBridge("CATALOG_BRIDGE_EVENT_RELEASE_HANDOFF_TIMEOUT");
}

export function createCatalogBridgeCatalogLiveDatabaseAdapter(input: Readonly<{
  policy: CatalogBridgeCatalogLivePolicy;
  state: CatalogBridgePrivatePreparedState;
  dependencies: CatalogBridgeCatalogLiveDatabaseDependencies;
}>): CatalogBridgeCatalogLiveDatabaseAdapter {
  const now = input.dependencies.now ?? (() => new Date());
  const wait = input.dependencies.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const common = { central: input.dependencies.central, runProvider: input.dependencies.runProvider,
    residentOffline: input.dependencies.residentOffline, policy: input.policy, state: input.state, now };
  return Object.freeze({
    readPreparedBoundary: () => readReadyObservation(common),
    async activateCatalogConfiguration() {
      if (!await input.dependencies.residentOffline()) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_RESIDENT_NOT_OFFLINE");
      }
      await stageInactiveCatalogConfiguration({ central: input.dependencies.central,
        policy: input.policy, state: input.state, now });
      const staged = await readCentralBoundary({ central: input.dependencies.central,
        policy: input.policy, state: input.state });
      assertCentralShape({ boundary: staged, policy: input.policy, state: input.state, allowCatalog: true });
      if (!staged.current || !staged.catalog) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_STAGE_UNPROVEN");
      }
      const syncEvidence = reachable(await input.dependencies.runProvider(staged.route, (database) =>
        synchronizePausedCatalogConfiguration({ database, policy: input.policy, state: input.state, now,
          scheduleSeconds: staged.catalog!.schedule_seconds, expiresAt: staged.catalog!.expires_at })));
      const providerSyncDigest = catalogBridgeDigest(syncEvidence);
      await activateCatalogConfigurationLast({ central: input.dependencies.central,
        policy: input.policy, state: input.state, providerSyncDigest, now });
      if (!await input.dependencies.residentOffline()) {
        refuseCatalogBridge("CATALOG_BRIDGE_CATALOG_RESIDENT_NOT_OFFLINE");
      }
      return readActivatedObservation(common);
    },
    admitCatalogRun: ({ originReceiptDigest }: Readonly<{ originReceiptDigest: string }>) =>
      admitCatalogRun({ ...common, originReceiptDigest }),
    async readCatalogHead() {
      const route = await locateRoute({ central: input.dependencies.central, state: input.state, admin: true });
      return reachable(await input.dependencies.runProvider(route, (database) =>
        catalogHeadObservation({ database, policy: input.policy, state: input.state })));
    },
    executeCatalogRun: () => input.dependencies.executeOneShot({
      providerId: input.policy.current.providerId, providerKey: input.policy.pins.providerKey,
      workerId: input.policy.utility.workerId, runId: input.state.catalogRunId,
    }),
    ensureResidentOfflineAndPaused: (recoveryInput?: Readonly<{ originReceiptDigest: string }>) =>
      ensurePaused({ ...common, ...recoveryInput }),
    readEventDatabaseBoundary: () => eventDatabaseBoundary(common),
    stageEventSuccessor: ({ catalogRunDigest }: Readonly<{ catalogRunDigest: string }>) =>
      eventStageObservation({ ...common, catalogRunDigest }),
    restoreEventCursor: (eventInput: Readonly<{ eventStageReceiptDigest: string;
      expectedProviderRowVersion: string; expectedRuntimeRowVersion: string;
      catalogRunDigest: string }>) => restoreEventCursorObservation({ ...common, ...eventInput }),
    admitEventResumeRun: (eventInput: Readonly<{ cursorRestoreReceiptDigest: string;
      expectedProviderRowVersion: string; expectedRuntimeRowVersion: string;
      restoredCursorHash: string; process: CatalogBridgeDrainProcessObservation }>) =>
      admitEventResumeRun({ ...common, ...eventInput }),
    readResumeObservation: (process: CatalogBridgeDrainProcessObservation) =>
      resumeObservation({ ...common, process }),
    releaseResidentAfterJournal: ({ resumedReceiptDigest }: Readonly<{
      resumedReceiptDigest: string }>) =>
      releaseResidentAfterJournal({ ...common, resumedReceiptDigest, wait }),
    pauseResidentForRecovery: () => pauseResidentForRecovery({ ...common, wait }),
    proveResidentRecoveryPaused: (proof: CatalogBridgeRecoveryPauseProof) =>
      proveResidentRecoveryPaused({ ...common, proof }),
  });
}
