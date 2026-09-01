import { isDeepStrictEqual } from "node:util";
import { performance } from "node:perf_hooks";
import { opaqueCursorEnvelopeSchema, dataforrestClutchpacksDistributedSourceAdapterManifest as manifest } from "@packscout/contracts";
import { providerMixedPageDigest, providerDatabaseTarget, readDatabaseReadiness,
  type ProviderTransactionClient, type ProviderWorkerLease } from "@packscout/database";
import { refuseSource, sourceDigest, type ClutchpacksProductionSourceOptions, type ProductionSourceAuthority } from "./clutchpacks-production-source-policy.mts";

export type ProductionSourceImportLease = Pick<ProviderWorkerLease, "role" | "owner" | "fence">;
export function assertProductionSourceLeaseBudget(validThrough: number | null, now = performance.now()) {
  if (validThrough !== null && now >= validThrough) refuseSource("PRODUCTION_SOURCE_IMPORT_LEASE_UNAVAILABLE");
}
const progressKeys = ["schemaVersion", "headPageId", "configVersionId", "checkpointHash", "leaseFence", "batchNumber", "phase",
  "packAfterId", "collectibleAfterId", "packScanDone", "collectibleScanDone", "quarantineAfterId", "quarantineAfterAt"].sort();
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;

/** Read-only admission of an own-page completed head. Recovery ancestry is intentionally not inferred. */
export async function readProductionSourceState(tx: ProviderTransactionClient, input: ClutchpacksProductionSourceOptions,
  authority: ProductionSourceAuthority, expectedImportLease?: ProductionSourceImportLease) {
  const p = input.scope, e = input.expected;
  const ready = await readDatabaseReadiness({ client: tx, target: providerDatabaseTarget(p) });
  if (ready.state !== "ready") refuseSource("PRODUCTION_SOURCE_PROVIDER_IDENTITY_INVALID");
  const [runtime, run, ledger, lease, activeRuns, actionableCommands, promotionOwned, page, receipt] = await Promise.all([
    tx.provider_runtime.findUnique({ where: { singleton_key: true } }),
    tx.provider_runs.findFirst({ orderBy: [{ requested_at: "desc" }, { id: "desc" }] }),
    tx.promotion_ledger.findUnique({ where: { singleton_key: true } }),
    tx.provider_worker_states.findUnique({ where: { worker_role: "import" } }),
    tx.provider_runs.count({ where: { state: { in: ["running", "queued"] } } }),
    tx.control_commands.count({ where: { state: { in: ["pending", "accepted"] } } }),
    tx.provider_worker_states.count({ where: { worker_role: "promotion", OR: [{ lease_owner: { not: null } }, { lease_expires_at: { not: null } }] } }),
    tx.provider_run_pages.findFirst({ where: { provider_run_id: e.latestSucceededRunId }, orderBy: { page_number: "desc" } }),
    tx.local_audit_events.findFirst({ where: { action: "provider.run.head_reconciliation", target_id: e.latestSucceededRunId }, orderBy: { sequence: "desc" } }),
  ]);
  if (!runtime || !run || !ledger || !lease || !page || !receipt || activeRuns !== 0 || actionableCommands !== 0 || promotionOwned !== 0 ||
    runtime.central_provider_id !== p.providerId || runtime.provider_key !== p.providerKey || runtime.operating_state !== "idle" ||
    runtime.state_generation !== e.stateGeneration || runtime.row_version !== e.runtimeRowVersion ||
    runtime.cached_config_version_id !== p.configVersionId || runtime.cached_config_version_number !== p.configVersionNumber ||
    run.id !== e.latestSucceededRunId || run.state !== "succeeded" || !run.reached_source_head || !run.finished_at || run.failure_code !== null ||
    run.config_version_id !== p.configVersionId || run.config_version_number !== p.configVersionNumber ||
    runtime.source_cursor_hash !== e.checkpointHash || run.final_cursor_hash !== e.checkpointHash ||
    providerMixedPageDigest(runtime.source_cursor) !== e.checkpointHash || !isDeepStrictEqual(runtime.source_cursor, run.final_cursor) ||
    page.continuation !== "head" || page.page_number !== run.page_count || page.next_cursor_hash !== e.checkpointHash ||
    !isDeepStrictEqual(page.next_cursor, runtime.source_cursor)) refuseSource("PRODUCTION_SOURCE_HEAD_OR_RUNTIME_CHANGED");
  const cursor = opaqueCursorEnvelopeSchema.safeParse(runtime.source_cursor);
  const config = authority.provider.active_config_version!;
  if (!isDeepStrictEqual(runtime.cached_configuration, { adapterKey: config.adapter_key, settings: config.configuration }) ||
    runtime.config_expires_at?.getTime() !== config.expires_at?.getTime() || runtime.schedule_seconds !== config.schedule_seconds) {
    refuseSource("PRODUCTION_SOURCE_CACHED_CONFIGURATION_CHANGED");
  }
  if (!cursor.success || cursor.data.sourceInstanceId !== p.providerId || cursor.data.sourceRevisionId !== p.configVersionId ||
    cursor.data.cursorGeneration !== 1 || cursor.data.value === null || cursor.data.sourceTypeKey !== manifest.sourceTypeKey ||
    cursor.data.adapterVersion !== manifest.adapterVersion || cursor.data.cursorCodecKey !== manifest.cursorCodecKey) refuseSource("PRODUCTION_SOURCE_CHECKPOINT_INVALID");
  const progress = receipt.details;
  if (!progress || typeof progress !== "object" || Array.isArray(progress) ||
    Object.keys(progress).sort().join(",") !== progressKeys.join(",") || progress.schemaVersion !== 1 ||
    progress.headPageId !== page.id || progress.configVersionId !== p.configVersionId || progress.checkpointHash !== e.checkpointHash ||
    progress.leaseFence !== run.worker_fence.toString() || progress.phase !== "complete" || progress.packScanDone !== true || progress.collectibleScanDone !== true ||
    !Number.isSafeInteger(progress.batchNumber) || Number(progress.batchNumber) < 1 ||
    [progress.packAfterId, progress.collectibleAfterId, progress.quarantineAfterId].some(id => id !== null && (typeof id !== "string" || !uuid.test(id))) ||
    (progress.quarantineAfterId === null) !== (progress.quarantineAfterAt === null) ||
    progress.quarantineAfterAt !== null && (typeof progress.quarantineAfterAt !== "string" || !Number.isFinite(Date.parse(progress.quarantineAfterAt))) ||
    receipt.outcome !== "success" || receipt.target_type !== "provider_run" || receipt.occurred_at > run.finished_at ||
    receipt.occurred_at < page.committed_at) refuseSource("PRODUCTION_SOURCE_RECONCILIATION_INVALID");
  // clock_timestamp() is outside MVCC snapshot time: a lease that expired during reads must be refused.
  const clockStarted = performance.now();
  const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`select clock_timestamp() as now`;
  if (!clock) refuseSource("PRODUCTION_SOURCE_DATABASE_CLOCK_UNAVAILABLE");
  if (runtime.config_expires_at !== null && runtime.config_expires_at <= clock.now) refuseSource("PRODUCTION_SOURCE_CONFIGURATION_EXPIRED_OR_UNSUPPORTED");
  if (expectedImportLease === undefined ? lease.lease_owner !== null || lease.lease_expires_at !== null :
    expectedImportLease.role !== "import" || lease.lease_owner !== expectedImportLease.owner || lease.lease_fence !== expectedImportLease.fence ||
    !lease.lease_expires_at || lease.lease_expires_at.getTime() <= clock.now.getTime() + 15_000) {
    refuseSource("PRODUCTION_SOURCE_IMPORT_LEASE_UNAVAILABLE");
  }
  const checkpoint = { runId: run.id, runRowVersion: run.row_version, finishedAt: run.finished_at,
    checkpointHash: e.checkpointHash, stateGeneration: runtime.state_generation, runtimeRowVersion: runtime.row_version,
    configVersionId: p.configVersionId, configVersionNumber: p.configVersionNumber,
    headPageId: page.id, headPageNumber: page.page_number, reconciliationDigest: sourceDigest(receipt),
    promotionSequence: ledger.last_sequence, ledgerDigest: sourceDigest(ledger) };
  const observation = { operatingState: runtime.operating_state, qualityState: runtime.quality_state,
    freshnessState: runtime.freshness_state, lastHeadReachedAt: runtime.last_head_reached_at?.toISOString() ?? null,
    scheduleSeconds: runtime.schedule_seconds, nextDueAt: runtime.next_due_at?.toISOString() ?? null,
    quarantineCount: run.quarantined_count };
  const leaseValidThrough = expectedImportLease === undefined ? null : clockStarted + lease.lease_expires_at!.getTime() - clock.now.getTime() - 15_000;
  assertProductionSourceLeaseBudget(leaseValidThrough);
  return { runtime, run, ledger, lease, checkpoint, observation, leaseValidThrough, digest: sourceDigest({ checkpoint, observation }) };
}
export type ProductionSourceState = Awaited<ReturnType<typeof readProductionSourceState>>;
