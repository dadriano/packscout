import {
  PrismaAdminProviderRuntimeRepository,
  locateProviderDatabase,
  lockProviderWorkerLease,
  providerDatabaseRouteFingerprint,
  providerResumeEvidenceDigest,
  readProviderRunHeadProof,
  type CentralQueryClient,
  type AdminRuntimeCommandRecord,
  type ProviderDatabaseOperationResult,
  type ProviderDatabaseRoute,
  type ProviderPrismaClient,
  type ProviderTransactionClient,
} from "@packscout/database";
import type { CatalogBridgePauseSubmission } from "./dataforrest-catalog-bridge-drain.mts";
import {
  catalogBridgeDrainBoundaryEvidence,
  catalogBridgeDrainIds,
  catalogBridgeDrainReceiptSchema,
  catalogBridgeDrainStableDatabaseEvidence,
  type CatalogBridgeDrainBoundary,
  type CatalogBridgeDrainProcessObservation,
  type CatalogBridgeDrainReceipt,
  type CatalogBridgePauseCommand,
  type CatalogBridgePauseIntent,
} from "./dataforrest-catalog-bridge-drain-policy.mts";
import type { CatalogBridgeLiveDrainPolicy } from "./dataforrest-catalog-bridge-drain-live-policy.mts";
import {
  catalogBridgeCatalogOperationIds,
  catalogBridgeDigest,
  catalogBridgeOperationIds,
  catalogBridgeProvider,
  refuseCatalogBridge,
  type CatalogBridgeProviderKey,
} from "./dataforrest-catalog-bridge-plan.mts";
import { catalogBridgeResumeRunId } from "./dataforrest-catalog-bridge-state.mts";

const TRANSACTION_OPTIONS = Object.freeze({ isolationLevel: "Serializable" as const, maxWait: 5_000, timeout: 15_000 });
const PAUSE_INTENT_ACTION = "provider.catalog_bridge.pause_intent";
const DRAIN_RECEIPT_ACTION = "provider.catalog_bridge.drain_receipt";

export interface CatalogBridgeLiveCentralAuthority {
  readonly boundary: CatalogBridgeDrainBoundary["central"];
  readonly route: ProviderDatabaseRoute;
  readonly routeDigest: string;
}

export interface CatalogBridgeLiveDatabaseDependencies {
  readonly readAuthority: () => Promise<CatalogBridgeLiveCentralAuthority>;
  readonly runProvider: <T>(route: ProviderDatabaseRoute,
    operation: (database: ProviderPrismaClient) => Promise<T>) => Promise<ProviderDatabaseOperationResult<T>>;
  readonly observeProcess: () => Promise<CatalogBridgeDrainProcessObservation>;
  readonly now?: () => Date;
}

export interface CatalogBridgeLiveDatabaseAdapter {
  readBoundary(): Promise<CatalogBridgeDrainBoundary>;
  readBoundaryReadOnly(): Promise<CatalogBridgeDrainBoundary>;
  recordPauseIntent(intent: CatalogBridgePauseIntent): Promise<Readonly<{ intentDigest: string; exactRetry: boolean }>>;
  submitPause(intent: CatalogBridgePauseIntent): Promise<CatalogBridgePauseSubmission>;
  readPauseCommand(commandId: string): Promise<CatalogBridgePauseCommand | null>;
  readPersistedReceipt(): Promise<CatalogBridgeDrainReceipt | null>;
  persistReceipt(receipt: CatalogBridgeDrainReceipt): Promise<Readonly<{ sha256: string; exactRetry: boolean }>>;
  latestBoundary(): CatalogBridgeDrainBoundary | null;
}

function sameAuthority(left: CatalogBridgeLiveCentralAuthority, right: CatalogBridgeLiveCentralAuthority): boolean {
  return left.routeDigest === right.routeDigest && catalogBridgeDigest(left.boundary) === catalogBridgeDigest(right.boundary);
}

function reachable<T>(result: ProviderDatabaseOperationResult<T>): T {
  if (result.state !== "reachable") refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_PROVIDER_UNAVAILABLE");
  return result.value;
}

export async function readCatalogBridgeLiveCentralAuthorityObservation(input: Readonly<{
  central: CentralQueryClient;
  providerKey: CatalogBridgeProviderKey;
  operatorId: string;
}>): Promise<CatalogBridgeLiveCentralAuthority> {
  const definition = catalogBridgeProvider(input.providerKey);
  const [provider, activeConfig, maximum, membership, located] = await Promise.all([
    input.central.providers.findUnique({ where: { id_organization_id: { id: definition.providerId,
      organization_id: definition.organizationId } } }),
    input.central.provider_config_versions.findUnique({ where: { id: definition.currentConfigId } }),
    input.central.provider_config_versions.aggregate({ where: { provider_id: definition.providerId },
      _max: { version_number: true } }),
    input.central.operator_memberships.findUnique({ where: { organization_id_operator_id: {
      organization_id: definition.organizationId, operator_id: input.operatorId } },
      select: { role: true, operator: { select: { state: true } } } }),
    locateProviderDatabase(input.central, { organizationId: definition.organizationId, providerId: definition.providerId }),
  ]);
  if (!provider || provider.lifecycle !== "active" || provider.provider_key !== definition.providerKey ||
    provider.active_config_version_id !== definition.currentConfigId || !activeConfig ||
    activeConfig.provider_id !== definition.providerId || activeConfig.version_number !== BigInt(definition.currentConfigNumber) ||
    activeConfig.adapter_key !== definition.eventManifest.adapterVersion ||
    maximum._max.version_number !== BigInt(definition.currentConfigNumber) || !membership ||
    membership.operator.state !== "active" || !["admin", "data_operator"].includes(membership.role) ||
    located.state !== "ready") {
    refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_CENTRAL_AUTHORITY_INVALID");
  }
  const configuration = activeConfig.configuration;
  const configurationDigest = catalogBridgeDigest(configuration);
  const routeDigest = catalogBridgeDigest({ fingerprint: providerDatabaseRouteFingerprint(located.route),
    target: located.route.target, organizationId: located.route.organizationId,
    configVersionId: located.route.configVersionId, providerRowVersion: located.route.providerRowVersion,
    topologyVersion: located.route.topologyVersion,
    node: { nodeId: located.route.node.nodeId, host: located.route.node.host, port: located.route.node.port,
      sslMode: located.route.node.sslMode, credentialVersionId: located.route.node.credentialVersionId,
      rowVersion: located.route.node.rowVersion } });
  const authorityDigest = catalogBridgeDigest({ provider: { id: provider.id, organizationId: provider.organization_id,
    providerKey: provider.provider_key, lifecycle: provider.lifecycle, activeConfigId: provider.active_config_version_id,
    topologyVersion: provider.topology_version, rowVersion: provider.row_version },
  config: { id: activeConfig.id, providerId: activeConfig.provider_id, versionNumber: activeConfig.version_number,
    adapterKey: activeConfig.adapter_key, endpointUrl: activeConfig.endpoint_url,
    sourceCredentialVersionId: activeConfig.source_credential_version_id,
    scheduleSeconds: activeConfig.schedule_seconds, staleAfterSeconds: activeConfig.stale_after_seconds,
    configuration, expiresAt: activeConfig.expires_at, createdByOperatorId: activeConfig.created_by_operator_id,
    createdAt: activeConfig.created_at }, maximumConfigNumber: maximum._max.version_number,
  operator: { id: input.operatorId, role: membership.role, state: membership.operator.state }, routeDigest });
  return Object.freeze({
    boundary: Object.freeze({ organizationId: definition.organizationId, providerId: definition.providerId,
      providerKey: definition.providerKey, providerRowVersion: provider.row_version.toString(),
      activeConfigId: activeConfig.id, activeConfigNumber: Number(activeConfig.version_number),
      maximumConfigNumber: Number(maximum._max.version_number), activeAdapterVersion: activeConfig.adapter_key,
      configuration, configurationDigest, authorityDigest }),
    route: located.route,
    routeDigest,
  });
}

export async function readCatalogBridgeLiveCentralAuthority(input: Readonly<{
  central: CentralQueryClient;
  policy: CatalogBridgeLiveDrainPolicy;
}>): Promise<CatalogBridgeLiveCentralAuthority> {
  const authority = await readCatalogBridgeLiveCentralAuthorityObservation({ central: input.central,
    providerKey: input.policy.providerKey, operatorId: input.policy.operatorId });
  if (authority.boundary.providerRowVersion !== input.policy.providerRowVersion ||
    authority.boundary.authorityDigest !== input.policy.centralAuthorityDigest ||
    authority.routeDigest !== input.policy.databaseRouteDigest) {
    refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_POLICY_MISMATCH");
  }
  return authority;
}

export async function assertCatalogBridgeLiveCentralOperationFresh(input: Readonly<{
  central: CentralQueryClient;
  operationId: string;
  providerKey: CatalogBridgeProviderKey;
}>): Promise<void> {
  const operation = catalogBridgeOperationIds(input);
  const stage = catalogBridgeCatalogOperationIds(input);
  const [configCount, auditCount, testCount, correlations] = await Promise.all([
    input.central.provider_config_versions.count({ where: { id: { in: [operation.catalogConfigId,
      operation.eventSuccessorConfigId] } } }),
    input.central.audit_events.count({ where: { id: { in: [stage.catalogStageAuditId,
      stage.catalogActivationAuditId, stage.catalogAdmissionAuditId, stage.eventStageAuditId,
      stage.eventActivationAuditId] } } }),
    input.central.provider_connection_tests.count({ where: { id: { in: [stage.catalogActivationTestId,
      stage.eventActivationTestId] } } }),
    input.central.$queryRawUnsafe<Array<{ use_count: bigint }>>(`select (
      (select count(*) from audit_events where metadata_json ->> 'operationId' = $1) +
      (select count(*) from provider_connection_tests where result_summary ->> 'operationId' = $1)
    )::bigint as use_count`, input.operationId),
  ]);
  if (configCount !== 0 || auditCount !== 0 || testCount !== 0 || correlations.length !== 1 ||
    correlations[0]?.use_count !== 0n) {
    refuseCatalogBridge("CATALOG_BRIDGE_OPERATION_ID_ALREADY_USED");
  }
}

interface LockedRunRow { readonly id: string }
interface LockedRuntimeRow { readonly singleton_key: boolean }
interface ActiveTransactionCount { readonly count: bigint }
interface CatalogBridgeImportLeaseRow {
  readonly worker_role: string;
  readonly lease_owner: string | null;
  readonly lease_fence: bigint;
  readonly heartbeat_at: Date | null;
  readonly lease_expires_at: Date | null;
  readonly row_version: bigint;
  readonly database_now: Date;
}

async function lockExactRun(transaction: ProviderTransactionClient, runId: string): Promise<void> {
  const rows = await transaction.$queryRawUnsafe<LockedRunRow[]>(
    "select id from provider_runs where id = $1::uuid for update", runId);
  if (rows.length !== 1 || rows[0]?.id !== runId) refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_RUN_MISSING");
}

async function lockRuntime(transaction: ProviderTransactionClient): Promise<void> {
  const rows = await transaction.$queryRawUnsafe<LockedRuntimeRow[]>(
    "select singleton_key from provider_runtime where singleton_key = true for update");
  if (rows.length !== 1 || rows[0]?.singleton_key !== true) {
    refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_RUNTIME_MISSING");
  }
}

async function readImportLease(transaction: ProviderTransactionClient): Promise<CatalogBridgeImportLeaseRow> {
  const rows = await transaction.$queryRawUnsafe<CatalogBridgeImportLeaseRow[]>(`select worker_role, lease_owner,
    lease_fence, heartbeat_at, lease_expires_at, row_version, clock_timestamp() as database_now
    from provider_worker_states where worker_role = 'import'::worker_role`);
  if (rows.length !== 1 || rows[0]?.worker_role !== "import") {
    refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_IMPORT_LEASE_MISSING");
  }
  return rows[0]!;
}

/** Lock order is part of the live safety contract and is intentionally centralized here. */
export async function withCatalogBridgeLockedBoundary<T>(input: Readonly<{
  database: ProviderPrismaClient;
  runId: string;
  operation: (transaction: ProviderTransactionClient,
    lease: Awaited<ReturnType<typeof lockProviderWorkerLease>>) => Promise<T>;
}>): Promise<T> {
  return input.database.$transaction(async (transaction) => {
    const lease = await lockProviderWorkerLease(transaction, "import");
    await lockExactRun(transaction, input.runId);
    await lockRuntime(transaction);
    return input.operation(transaction, lease);
  }, TRANSACTION_OPTIONS);
}

async function readLockedBoundary(input: Readonly<{
  transaction: ProviderTransactionClient;
  lease: CatalogBridgeImportLeaseRow;
  authority: CatalogBridgeLiveCentralAuthority;
  process: CatalogBridgeDrainProcessObservation;
  policy: Pick<CatalogBridgeLiveDrainPolicy, "providerKey" | "runId">;
  observedAt: Date;
}>): Promise<CatalogBridgeDrainBoundary> {
  const { transaction, policy } = input;
  const [identity, runtime, run, latestRun, lastPage, activeRunCount, actionableCommandCount, workerStates,
    activeTransactions] = await Promise.all([
    transaction.database_identity.findUnique({ where: { singleton_key: true } }),
    transaction.provider_runtime.findUnique({ where: { singleton_key: true } }),
    transaction.provider_runs.findUnique({ where: { id: policy.runId } }),
    transaction.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
    transaction.provider_run_pages.findFirst({ where: { provider_run_id: policy.runId },
      orderBy: [{ page_number: "desc" }, { id: "desc" }] }),
    transaction.provider_runs.count({ where: { state: { in: ["queued", "running"] } } }),
    transaction.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
    transaction.provider_worker_states.findMany(),
    transaction.$queryRawUnsafe<ActiveTransactionCount[]>(`select count(*)::bigint as count
      from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'`),
  ]);
  if (!identity || !runtime || !run || latestRun?.id !== policy.runId || activeTransactions.length !== 1) {
    refuseCatalogBridge(latestRun?.id !== policy.runId
      ? "CATALOG_BRIDGE_LIVE_DRAIN_QUEUED_RUN_RACE" : "CATALOG_BRIDGE_LIVE_DRAIN_BOUNDARY_INCOMPLETE");
  }
  const head = await readProviderRunHeadProof(transaction, policy.runId);
  const headProof = head?.checkpointHash && head.receipt ? Object.freeze({ runId: head.runId,
    sourceRunId: head.sourceRunId, headPageId: head.headPageId, pageNumber: head.pageNumber,
    checkpointHash: head.checkpointHash, configVersionId: head.configVersionId,
    configVersionNumber: Number(head.configVersionNumber), fullReplay: head.fullReplay,
    reconciliationComplete: head.reconciliationComplete,
    receipt: Object.freeze({ details: head.receipt.details, outcome: head.receipt.outcome,
      targetType: head.receipt.targetType, workerFence: head.receipt.workerFence.toString() }),
    proofDigest: "",
  }) : null;
  const normalizedHeadProof = headProof ? Object.freeze({ ...headProof,
    proofDigest: catalogBridgeDigest(Object.fromEntries(Object.entries(headProof).filter(([key]) => key !== "proofDigest"))) }) : null;
  const otherOwnedLeaseCount = workerStates.filter((row) => row.worker_role !== "import" && row.lease_owner !== null &&
    row.lease_expires_at !== null && row.lease_expires_at > input.lease.database_now).length;
  return Object.freeze({ observedAt: input.observedAt.toISOString(), databaseNow: input.lease.database_now.toISOString(),
    central: input.authority.boundary,
    runtime: Object.freeze({ providerId: runtime.central_provider_id, providerKey: runtime.provider_key,
      databaseName: identity.database_role === "provider" ? catalogBridgeProvider(policy.providerKey).databaseName : "",
      databasePort: catalogBridgeProvider(policy.providerKey).databasePort, databaseRole: identity.database_role,
      schemaVersion: identity.schema_version, state: runtime.operating_state, generation: runtime.state_generation.toString(),
      rowVersion: runtime.row_version.toString(), cachedConfigId: runtime.cached_config_version_id ?? "",
      cachedConfigNumber: Number(runtime.cached_config_version_number ?? -1n), cachedConfiguration: runtime.cached_configuration,
      sourceCursor: runtime.source_cursor, sourceCursorHash: runtime.source_cursor_hash ?? "",
      activeRunCount, actionableCommandCount, otherOwnedLeaseCount,
      otherActiveTransactionCount: Number(activeTransactions[0]!.count) }),
    importLease: Object.freeze({ owner: input.lease.lease_owner, fence: input.lease.lease_fence.toString(),
      expiresAt: input.lease.lease_expires_at?.toISOString() ?? null }),
    run: Object.freeze({ id: run.id, state: run.state, configId: run.config_version_id,
      configNumber: Number(run.config_version_number), workerFence: run.worker_fence.toString(), pageCount: run.page_count,
      reachedSourceHead: run.reached_source_head, finishedAt: run.finished_at?.toISOString() ?? null,
      failureCode: run.failure_code, finalCursor: run.final_cursor, finalCursorHash: run.final_cursor_hash ?? "",
      runDigest: providerResumeEvidenceDigest(run) }),
    lastPage: lastPage ? Object.freeze({ id: lastPage.id, pageNumber: lastPage.page_number,
      nextCursor: lastPage.next_cursor, nextCursorHash: lastPage.next_cursor_hash ?? "",
      continuation: lastPage.continuation, lastPageDigest: providerResumeEvidenceDigest(lastPage) }) : null,
    headProof: normalizedHeadProof,
    process: input.process,
  });
}

/** Captures the current latest-run boundary without acquiring a lock or writing. */
export async function readCatalogBridgeLiveDrainCaptureBoundary(input: Readonly<{
  database: ProviderPrismaClient;
  authority: CatalogBridgeLiveCentralAuthority;
  process: CatalogBridgeDrainProcessObservation;
  providerKey: CatalogBridgeProviderKey;
  operationId: string;
  operatorId: string;
  now?: () => Date;
}>): Promise<CatalogBridgeDrainBoundary> {
  return input.database.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await transaction.$executeRawUnsafe("SET LOCAL statement_timeout = '10000ms'");
    const operation = catalogBridgeOperationIds(input);
    const stage = catalogBridgeCatalogOperationIds(input);
    const drain = catalogBridgeDrainIds(input);
    const commandIds = [drain.runningPauseCommandId, drain.idlePauseCommandId,
      stage.catalogResumeCommandId, stage.catalogRunCommandId, stage.postCatalogPauseCommandId,
      stage.eventResumeCommandId, stage.eventRunCommandId];
    const runIds = [operation.catalogRunId,
      catalogBridgeResumeRunId(input.operationId, input.providerKey)];
    const [lease, latestRun, commandCount, runCount, stateEventCount, quarantineAttemptCount,
      auditCount] = await Promise.all([
      readImportLease(transaction),
      transaction.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
      transaction.control_commands.count({ where: { OR: [
        { correlation_id: input.operationId }, { id: { in: commandIds } },
      ] } }),
      transaction.provider_runs.count({ where: { id: { in: runIds } } }),
      transaction.provider_state_events.count({ where: { correlation_id: input.operationId } }),
      transaction.quarantine_attempts.count({ where: { correlation_id: input.operationId } }),
      transaction.local_audit_events.count({ where: { correlation_id: input.operationId } }),
    ]);
    if (commandCount !== 0 || runCount !== 0 || stateEventCount !== 0 ||
      quarantineAttemptCount !== 0 || auditCount !== 0) {
      refuseCatalogBridge("CATALOG_BRIDGE_OPERATION_ID_ALREADY_USED");
    }
    if (!latestRun) refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_RUN_MISSING");
    return readLockedBoundary({ transaction, lease, authority: input.authority,
      process: input.process, policy: { providerKey: input.providerKey, runId: latestRun.id },
      observedAt: input.now?.() ?? new Date() });
  }, { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 15_000 });
}

function assertProcessUnchanged(left: CatalogBridgeDrainProcessObservation,
  right: CatalogBridgeDrainProcessObservation): void {
  if (catalogBridgeDigest(left) !== catalogBridgeDigest(right)) {
    refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_PROCESS_CHANGED");
  }
}

function parsePauseCommand(row: AdminRuntimeCommandRecord | null):
  CatalogBridgePauseCommand | null {
  if (!row || !row.completedAt || !row.result) return null;
  return Object.freeze({ id: row.id, idempotencyKey: row.idempotencyKey, commandType: row.commandType,
    state: row.state, targetRunId: row.targetRunId, targetQuarantineId: row.targetQuarantineId,
    expectedGeneration: row.expectedGeneration.toString(), requestedByOperatorId: row.requestedByOperatorId,
    correlationId: row.correlationId, reason: row.reason, resultOutcome: row.result.outcome,
    resultCode: row.result.code, resultGeneration: row.result.generation, resultingRunId: row.resultingRunId,
    requestedAt: row.requestedAt.toISOString(), completedAt: row.completedAt.toISOString() });
}

export function createCatalogBridgeLiveDatabaseAdapter(input: Readonly<{
  policy: CatalogBridgeLiveDrainPolicy;
  dependencies: CatalogBridgeLiveDatabaseDependencies;
}>): CatalogBridgeLiveDatabaseAdapter {
  let latest: CatalogBridgeDrainBoundary | null = null;
  const recordedIntentDigests = new Set<string>();
  const readWith = async <T,>(operation: (database: ProviderPrismaClient,
    authority: CatalogBridgeLiveCentralAuthority) => Promise<T>): Promise<T> => {
    const authority = await input.dependencies.readAuthority();
    const result = reachable(await input.dependencies.runProvider(authority.route,
      (database) => operation(database, authority)));
    const confirmed = await input.dependencies.readAuthority();
    if (!sameAuthority(authority, confirmed)) refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_AUTHORITY_CHANGED");
    return result;
  };

  const readBoundary = async (): Promise<CatalogBridgeDrainBoundary> => {
    const process = await input.dependencies.observeProcess();
    const boundary = await readWith((database, authority) => withCatalogBridgeLockedBoundary({ database,
      runId: input.policy.runId, operation: (transaction, lease) => readLockedBoundary({ transaction, lease,
        authority, process, policy: input.policy, observedAt: input.dependencies.now?.() ?? new Date() }) }));
    const confirmedProcess = await input.dependencies.observeProcess();
    assertProcessUnchanged(process, confirmedProcess);
    latest = boundary;
    return boundary;
  };

  const readBoundaryReadOnly = async (): Promise<CatalogBridgeDrainBoundary> => {
    const process = await input.dependencies.observeProcess();
    const boundary = await readWith(async (database, authority) => database.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const lease = await readImportLease(transaction);
      return readLockedBoundary({ transaction, lease, authority, process, policy: input.policy,
        observedAt: input.dependencies.now?.() ?? new Date() });
    }, { isolationLevel: "RepeatableRead", maxWait: 5_000, timeout: 15_000 }));
    const confirmedProcess = await input.dependencies.observeProcess();
    assertProcessUnchanged(process, confirmedProcess);
    return boundary;
  };

  const recordPauseIntent = async (intent: CatalogBridgePauseIntent) => {
    const prior = latest;
    if (!prior || intent.boundaryDigest !== catalogBridgeDigest(catalogBridgeDrainBoundaryEvidence(prior)) ||
      intent.operationId !== input.policy.operationId || intent.providerId !== input.policy.providerId ||
      intent.operatorId !== input.policy.operatorId || intent.runId !== input.policy.runId ||
      intent.runFence !== input.policy.runFence || intent.configId !== input.policy.currentConfigId ||
      intent.cursorHash !== input.policy.sourceCursorHash) {
      refuseCatalogBridge("CATALOG_BRIDGE_DRAIN_INTENT_NOT_DURABLE");
    }
    const process = await input.dependencies.observeProcess();
    assertProcessUnchanged(prior.process, process);
    const exactRetry = await readWith((database, authority) => withCatalogBridgeLockedBoundary({ database,
      runId: input.policy.runId, operation: async (transaction, lease) => {
        const current = await readLockedBoundary({ transaction, lease, authority, process, policy: input.policy,
          observedAt: input.dependencies.now?.() ?? new Date() });
        if (catalogBridgeDigest(catalogBridgeDrainStableDatabaseEvidence(current)) !==
          catalogBridgeDigest(catalogBridgeDrainStableDatabaseEvidence(prior))) {
          refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_BOUNDARY_CHANGED");
        }
        const rows = await transaction.local_audit_events.findMany({ where: { correlation_id: intent.operationId,
          action: PAUSE_INTENT_ACTION }, orderBy: { sequence: "asc" } });
        if (rows.length > 0) {
          if (rows.length !== 1 || rows[0]?.actor_operator_id !== intent.operatorId ||
            rows[0]?.target_type !== "provider_run" || rows[0]?.target_id !== intent.runId ||
            rows[0]?.outcome !== "success" || catalogBridgeDigest(rows[0]?.details) !== catalogBridgeDigest(intent)) {
            refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_INTENT_CONFLICT");
          }
          return true;
        }
        await transaction.local_audit_events.create({ data: { command_id: null,
          actor_operator_id: intent.operatorId, correlation_id: intent.operationId, action: PAUSE_INTENT_ACTION,
          target_type: "provider_run", target_id: intent.runId, outcome: "success",
          details: JSON.parse(JSON.stringify(intent)),
          occurred_at: lease.database_now } });
        return false;
      } }));
    const confirmedProcess = await input.dependencies.observeProcess();
    assertProcessUnchanged(process, confirmedProcess);
    recordedIntentDigests.add(catalogBridgeDigest(intent));
    return Object.freeze({ intentDigest: catalogBridgeDigest(intent), exactRetry });
  };

  const submitPause = (intent: CatalogBridgePauseIntent): Promise<CatalogBridgePauseSubmission> => {
    if (!recordedIntentDigests.has(catalogBridgeDigest(intent))) {
      refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_INTENT_NOT_RECORDED");
    }
    return readWith(async (database) => {
      const prior = latest;
      if (!prior) refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_BOUNDARY_MISSING");
      assertProcessUnchanged(prior.process, await input.dependencies.observeProcess());
      const result = await new PrismaAdminProviderRuntimeRepository(database).submitRuntimeCommand({
        commandId: intent.commandId, idempotencyKey: intent.idempotencyKey, commandType: "pause",
        expectedGeneration: BigInt(intent.expectedGeneration), requestedByOperatorId: intent.operatorId,
        correlationId: intent.operationId, reason: intent.reason, requestedAt: new Date(intent.requestedAt),
      });
      return Object.freeze({ commandId: result.commandId, outcome: result.outcome, code: result.code,
        state: result.state, generation: result.generation.toString() });
    });
  };

  const readPauseCommand = (commandId: string): Promise<CatalogBridgePauseCommand | null> => readWith(async (database) =>
    parsePauseCommand(await new PrismaAdminProviderRuntimeRepository(database).getRuntimeCommand(commandId)));

  const readPersistedReceipt = (): Promise<CatalogBridgeDrainReceipt | null> => readWith(async (database) => {
    const rows = await database.local_audit_events.findMany({ where: { correlation_id: input.policy.operationId,
      action: DRAIN_RECEIPT_ACTION }, orderBy: { sequence: "asc" } });
    if (rows.length === 0) return null;
    const parsed = catalogBridgeDrainReceiptSchema.safeParse(rows[0]?.details);
    if (rows.length !== 1 || !parsed.success || rows[0]?.actor_operator_id !== input.policy.operatorId ||
      rows[0]?.target_type !== "provider_run" || rows[0]?.target_id !== parsed.data.terminal.runId ||
      rows[0]?.outcome !== "success" || parsed.data.operationId !== input.policy.operationId ||
      parsed.data.providerId !== input.policy.providerId) {
      refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_RECEIPT_CONFLICT");
    }
    return parsed.data;
  });

  const persistReceipt = async (receipt: CatalogBridgeDrainReceipt) => {
    const prior = latest;
    const sha256 = catalogBridgeDigest(receipt);
    if (!prior || receipt.operationId !== input.policy.operationId || receipt.providerId !== input.policy.providerId ||
      receipt.operatorId !== input.policy.operatorId || receipt.providerKey !== input.policy.providerKey ||
      receipt.currentConfigId !== input.policy.currentConfigId ||
      receipt.drainedEvidenceDigest !== catalogBridgeDigest(catalogBridgeDrainStableDatabaseEvidence(prior))) {
      refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_RECEIPT_INVALID");
    }
    const process = await input.dependencies.observeProcess();
    assertProcessUnchanged(prior.process, process);
    const exactRetry = await readWith((database, authority) => withCatalogBridgeLockedBoundary({ database,
      runId: receipt.terminal.runId, operation: async (transaction, lease) => {
        const current = await readLockedBoundary({ transaction, lease, authority, process, policy: input.policy,
          observedAt: input.dependencies.now?.() ?? new Date() });
        if (receipt.drainedEvidenceDigest !== catalogBridgeDigest(catalogBridgeDrainStableDatabaseEvidence(current))) {
          refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_RECEIPT_CHANGED");
        }
        const rows = await transaction.local_audit_events.findMany({ where: { correlation_id: receipt.operationId,
          action: DRAIN_RECEIPT_ACTION }, orderBy: { sequence: "asc" } });
        if (rows.length > 0) {
          if (rows.length !== 1 || rows[0]?.actor_operator_id !== receipt.operatorId ||
            rows[0]?.target_type !== "provider_run" || rows[0]?.target_id !== receipt.terminal.runId ||
            rows[0]?.outcome !== "success" || catalogBridgeDigest(rows[0]?.details) !== sha256) {
            refuseCatalogBridge("CATALOG_BRIDGE_LIVE_DRAIN_RECEIPT_CONFLICT");
          }
          return true;
        }
        await transaction.local_audit_events.create({ data: { command_id: receipt.pause.commandId,
          actor_operator_id: receipt.operatorId, correlation_id: receipt.operationId, action: DRAIN_RECEIPT_ACTION,
          target_type: "provider_run", target_id: receipt.terminal.runId, outcome: "success",
          details: JSON.parse(JSON.stringify(receipt)),
          occurred_at: lease.database_now } });
        return false;
      } }));
    return Object.freeze({ sha256, exactRetry });
  };

  return Object.freeze({ readBoundary, readBoundaryReadOnly, recordPauseIntent, submitPause, readPauseCommand,
    readPersistedReceipt, persistReceipt,
    latestBoundary: () => latest });
}
