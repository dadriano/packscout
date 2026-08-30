#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoundedProviderDatabaseGateway, ProviderDatabaseDestinationPolicy, PrismaProviderWorkerLeaseRepository,
  createCentralDatabaseLifecycle, locateProviderDatabase, lockProviderWorkerLease, providerWorkerLeaseIsLive,
  setProviderImportLeaseContext, type ProviderPrismaClient, type ProviderTransactionClient } from "@packscout/database";
import { AesGcmProviderCredentialCipher, CipherProviderDatabaseCredentialResolver } from "@packscout/services";
import { readBackfillEnvironment } from "./provider-backfill-supervisor-authority.mts";
import { assertProviderReviewActivationDatabaseRoute } from "./provider-review-activation-database-proof.mts";
import { handoffDigest } from "./collector-crypt-checkpoint-handoff-plan.mts";
import { CourtyardHandoffError, courtyardHandoff as pins, courtyardHandoffId as id, refuseCourtyardHandoff as refuse,
  assertCourtyardCheckpoint, readCourtyardHandoffCheckpoint, retainedCourtyardCheckpoint, reEnvelopeCourtyardCursor,
  type CourtyardCheckpoint, type CourtyardReceipt, type CourtyardCanaryProof } from "./courtyard-response-budget-handoff-plan.mts";
import { readCourtyardHandoffAuthority, stageCourtyardHandoff, activateCourtyardHandoffLast,
  type CourtyardAuthority } from "./courtyard-response-budget-handoff-central.mts";
import { courtyardTerminalReceipt, readCourtyardReceipt, pauseCourtyardTerminal,
  assertCourtyardPauseProvenance, resumeCourtyardHandoff, courtyardQueueLeaseOwner } from "./courtyard-response-budget-handoff-control.mts";
import { probeCourtyardHandoff } from "./courtyard-response-budget-handoff-canary.mts";

export { CourtyardHandoffError };
export const readCourtyardHandoffEnvironment = readBackfillEnvironment;
const allowedCourtyardHandoffCodes = new Set([
  "COURTYARD_HISTORY_BOUND_EXCEEDED", "COURTYARD_CANARY_ADMISSION_FAILED", "COURTYARD_CANARY_AUTHORITY_INVALID", "COURTYARD_CANARY_COLLECTIBLE_REJECTED",
  "COURTYARD_CANARY_MAPPING_REJECTED", "COURTYARD_CANARY_NORMALIZATION_REJECTED", "COURTYARD_CANARY_PARSER_REJECTED",
  "COURTYARD_CANARY_RESPONSE_INVALID", "COURTYARD_CANARY_TRANSPORT_FAILED", "COURTYARD_ACTIVATION_DIGEST_UNAVAILABLE",
  "COURTYARD_ACTIVATION_NOT_PREPARED", "COURTYARD_CANARY_EXPIRED", "COURTYARD_CENTRAL_AUTHORITY_CHANGED",
  "COURTYARD_CENTRAL_CAS_FAILED", "COURTYARD_OPERATOR_UNAVAILABLE", "COURTYARD_PROOF_BINDING_CHANGED",
  "COURTYARD_STAGED_AUTHORITY_CHANGED", "COURTYARD_STAGED_CHECKPOINT_CHANGED", "COURTYARD_PAUSE_PROVENANCE_INVALID",
  "COURTYARD_PAUSE_REFUSED", "COURTYARD_QUEUED_RUN_CHANGED", "COURTYARD_QUEUE_REFUSED_RESUME_RETAINED",
  "COURTYARD_RECEIPT_CHANGED", "COURTYARD_RECEIPT_INVALID", "COURTYARD_RESUME_RECEIPT_CHANGED", "COURTYARD_RESUME_REFUSED",
  "COURTYARD_TERMINAL_CAS_FAILED", "COURTYARD_TERMINAL_LEASE_CHANGED", "COURTYARD_CHECKPOINT_CURSOR_CHANGED",
  "COURTYARD_PROFILE_CONTINUITY_CHANGED", "COURTYARD_TERMINAL_CHECKPOINT_CHANGED", "COURTYARD_ARGUMENTS_INVALID",
  "COURTYARD_CACHED_CONFIGURATION_CHANGED", "COURTYARD_CHECKPOINT_CHANGED_AFTER_CANARY", "COURTYARD_HANDOFF_FAILED",
  "COURTYARD_NOT_ACTIVATED", "COURTYARD_OPERATION_ID_INVALID", "COURTYARD_PAUSE_REQUIRED", "COURTYARD_PREPARED_RECEIPT_CHANGED",
  "COURTYARD_PROVIDER_OPERATION_FAILED", "COURTYARD_RECEIPT_AUTHORITY_CHANGED", "COURTYARD_RESUME_CHECKPOINT_CHANGED",
  "COURTYARD_RESUME_STATE_CHANGED", "COURTYARD_REVIEW_REQUIRED", "COURTYARD_REVIEW_STALE", "COURTYARD_ROUTE_UNAVAILABLE",
  "COURTYARD_RUNTIME_CAS_FAILED", "COURTYARD_UTILITY_LEASE_EXPIRED", "COURTYARD_UTILITY_LEASE_UNAVAILABLE",
]);
export function courtyardHandoffFailureCode(error: unknown): string | undefined {
  return error instanceof CourtyardHandoffError && allowedCourtyardHandoffCodes.has(error.code) ? error.code : undefined;
}
export async function captureCourtyardHandoffResult<T>(operation: () => Promise<T>) {
  try { return { ok: true as const, value: await operation() }; }
  catch (error) {
    const code = courtyardHandoffFailureCode(error);
    if (code) return { ok: false as const, code };
    throw error; // Keep unknown errors inside the gateway's existing generic redaction boundary.
  }
}

export function parseCourtyardHandoffArguments(args: readonly string[]) {
  const mode = args[0]; const values = new Map<string, string>();
  if (!["--check-only", "--pause", "--prepare", "--resume"].includes(mode ?? "") || (args.length - 1) % 2) refuse("COURTYARD_ARGUMENTS_INVALID");
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index]!; const value = args[index + 1]!;
    if (!["--operation-id", "--review-digest"].includes(key) || values.has(key) || !value) refuse("COURTYARD_ARGUMENTS_INVALID");
    values.set(key, value);
  }
  const operationId = values.get("--operation-id") ?? "";
  if (operationId !== pins.operationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)) refuse("COURTYARD_OPERATION_ID_INVALID");
  const reviewDigest = values.get("--review-digest");
  if ((mode !== "--check-only" && !reviewDigest) || (reviewDigest && !/^[a-f0-9]{64}$/u.test(reviewDigest))) refuse("COURTYARD_REVIEW_REQUIRED");
  return { mode, operationId, reviewDigest };
}
export const courtyardGatewayBounds = Object.freeze({ connectionLimitPerProvider: 1, maximumCachedProviders: 1,
  connectionTimeoutMs: 5000, operationTimeoutMs: 60000 });
export const courtyardResumeReviewAvailable = (active: boolean, owner: string | null, operationOwner: string) => active && owner !== operationOwner;
/** The utility owns only this operation's import lease; no provider/run mutation precedes this lock order. */
export async function withCourtyardCheckpointLocks<T>(database: ProviderPrismaClient,
  utility: Readonly<{ owner: string; fence: bigint }>, operation: (tx: ProviderTransactionClient) => Promise<T>): Promise<T> {
  if (utility.owner !== `local:courtyard:response-budget:${pins.operationId}` || utility.fence <= 82n) refuse("COURTYARD_UTILITY_LEASE_UNAVAILABLE");
  return database.$transaction(async (tx) => {
    const lease = await lockProviderWorkerLease(tx, "import");
    if (!providerWorkerLeaseIsLive(lease, utility)) refuse("COURTYARD_UTILITY_LEASE_EXPIRED");
    await setProviderImportLeaseContext(tx, utility);
    await tx.$queryRaw`select id from provider_runs where id=${pins.runId}::uuid for update`;
    await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
    return operation(tx);
  }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 45000 });
}
const requireReview = (expected: string, received?: string) => { if (expected !== received) refuse("COURTYARD_REVIEW_STALE"); };
const safeCheckpoint = (s: CourtyardCheckpoint) => ({ providerId: s.providerId, runId: s.run.id, runtimeState: s.runtimeState,
  generation: s.generation, rowVersion: s.runtimeRowVersion, configId: s.cachedConfigId, configNumber: s.cachedConfigNumber,
  fence: s.lease.fence, cursorHash: s.cursorHash, checkpointDigest: handoffDigest(retainedCourtyardCheckpoint(s)),
  pageCount: s.run.pageCount, accepted: s.run.accepted, quarantined: s.run.quarantines,
  retainedRuns: s.runCount, retainedQuarantines: s.quarantineCount, ledgerSequence: s.ledgerSequence });
async function assertConfiguration(database: ProviderPrismaClient | ProviderTransactionClient, authority: CourtyardAuthority) {
  const runtime = await database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
  const adapterKey = runtime.cached_config_version_id === pins.previousConfigId ? pins.previousAdapter : pins.nextAdapter;
  if (handoffDigest(runtime.cached_configuration) !== handoffDigest({ adapterKey, settings: { platform: pins.providerKey } }) ||
    runtime.schedule_seconds !== authority.previous.schedule_seconds || runtime.config_expires_at !== null) refuse("COURTYARD_CACHED_CONFIGURATION_CHANGED");
}
function assertReceiptAuthority(receipt: CourtyardReceipt, authority: CourtyardAuthority) {
  if (receipt.providerId !== authority.provider.id || receipt.authorityDigest !== authority.authorityDigest ||
    receipt.operatorId !== authority.operatorId || receipt.nextConfigId !== authority.nextConfigId || receipt.previousCursorHash !== pins.cursorHash) refuse("COURTYARD_RECEIPT_AUTHORITY_CHANGED");
}
async function assertPreparedAudit(database: ProviderPrismaClient | ProviderTransactionClient, receipt: CourtyardReceipt, nextCursorHash: string) {
  const rows = await database.local_audit_events.findMany({ where: { correlation_id: receipt.operationId, action: `${pins.action}.prepared` } });
  if (rows.length !== 1 || rows[0]?.outcome !== "success" || rows[0]?.target_id !== receipt.providerId ||
    handoffDigest(rows[0]?.details) !== handoffDigest({ receiptDigest: handoffDigest(receipt), nextConfigId: receipt.nextConfigId,
      previousCursorHash: pins.cursorHash, nextCursorHash, checkpointDigest: receipt.checkpointDigest })) refuse("COURTYARD_PREPARED_RECEIPT_CHANGED");
}

export async function runCourtyardHandoff(args: ReturnType<typeof parseCourtyardHandoffArguments>) {
  // Shared local bootstrap tolerates an absent .env. Only central55431 + the
  // cipher keyring are consumed; provider DSNs/source-token overrides are never used.
  const environment = await readCourtyardHandoffEnvironment();
  const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: environment.version,
    keys: new Map([[environment.version, environment.key]]) });
  const central = createCentralDatabaseLifecycle({ databaseUrl: environment.centralDatabaseUrl, connectionLimit: 1 });
  const gateway = new BoundedProviderDatabaseGateway({ central, credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
    destinationPolicy: new ProviderDatabaseDestinationPolicy({ allowedHosts: ["127.0.0.1"], allowedPorts: [pins.port], allowedSslModes: ["disable"] }),
    ...courtyardGatewayBounds });
  try {
    await central.start();
    const authority = await readCourtyardHandoffAuthority(central.client, args.operationId);
    const route = await locateProviderDatabase(central.client, { organizationId: pins.organizationId, providerId: authority.provider.id });
    if (route.state !== "ready") refuse("COURTYARD_ROUTE_UNAVAILABLE");
    assertProviderReviewActivationDatabaseRoute(route.route, { organizationId: pins.organizationId, providerId: authority.provider.id,
      providerKey: pins.providerKey, configVersionId: authority.provider.active_config_version_id!, providerRowVersion: authority.provider.row_version,
      topologyVersion: authority.provider.topology_version, nodeId: authority.node.id, nodeRowVersion: authority.node.row_version,
      databaseCredentialVersionId: authority.node.credential.id, host: "127.0.0.1", port: pins.port, databaseName: pins.databaseName, sslMode: "disable" });
    const result = await gateway.runWithCachedProviderDatabase(route.route, async (database) => captureCourtyardHandoffResult(async () => {
      const snapshot = await readCourtyardHandoffCheckpoint(database);
      await assertConfiguration(database, authority);
      const existing = await readCourtyardReceipt(database, args.operationId);
      if (existing) assertReceiptAuthority(existing, authority);
      const pauseCommand = existing && await database.control_commands.findUnique({ where: { id: id(args.operationId, "pause-command") } });
      if (!existing || !pauseCommand || args.mode === "--pause") {
        const receipt = existing ?? courtyardTerminalReceipt(authority, snapshot, args.operationId);
        const reviewDigest = handoffDigest(receipt);
        if (args.mode === "--check-only") return { phase: "terminal_failure_pause_review", reviewDigest, ...safeCheckpoint(snapshot) };
        if (args.mode !== "--pause") refuse("COURTYARD_PAUSE_REQUIRED");
        requireReview(reviewDigest, args.reviewDigest);
        return pauseCourtyardTerminal(database, authority, receipt);
      }
      const receipt = existing;
      const migrated = reEnvelopeCourtyardCursor({ cursor: snapshot.run.finalCursor, cursorHash: snapshot.run.finalCursorHash,
        providerId: receipt.providerId, nextConfigId: receipt.nextConfigId });
      const owner = `local:courtyard:response-budget:${args.operationId}`;
      const staged = authority.metadata?.receiptDigest === handoffDigest(receipt) && authority.metadata?.checkpointDigest === receipt.checkpointDigest &&
        authority.metadata?.nextCursorHash === migrated.cursorHash;
      const reclaim = { reclaimableOwner: owner }; // Exact own receipt + pause provenance is required before reclaim.
      const resumeReview = handoffDigest({ receiptDigest: handoffDigest(receipt), nextCursorHash: migrated.cursorHash, authorityDigest: authority.authorityDigest });
      if (args.mode === "--resume") {
        requireReview(resumeReview, args.reviewDigest);
        if (!authority.active || !staged) refuse("COURTYARD_NOT_ACTIVATED");
        return resumeCourtyardHandoff({ database, receipt, cursorHash: migrated.cursorHash, assertPrepared: async (resumed, lease) => {
          const current = await readCourtyardHandoffCheckpoint(database);
          if (current.runtimeState !== (resumed ? "idle" : "paused") || current.generation !== (resumed ? "23" : "22")) refuse("COURTYARD_RESUME_STATE_CHANGED");
          // Recheck the operation's original pause even after our own resume.
          // Actual runtime state/generation are checked above; only this historical
          // provenance projection uses the paused generation.
          await assertCourtyardPauseProvenance(database, receipt, { ...current, generation: "22" });
          assertCourtyardCheckpoint({ snapshot: { ...current, runtimeState: "paused", generation: "22" },
            providerId: receipt.providerId, nextConfigId: receipt.nextConfigId, phase: "paused",
            ...(lease ? { utilityLease: { owner: lease.owner, fence: lease.fence.toString() } }
              : { reclaimableOwner: courtyardQueueLeaseOwner(receipt.operationId) }) });
          if (current.cachedConfigId !== receipt.nextConfigId || handoffDigest(retainedCourtyardCheckpoint(current)) !== receipt.checkpointDigest) refuse("COURTYARD_RESUME_CHECKPOINT_CHANGED");
          await assertPreparedAudit(database, receipt, migrated.cursorHash);
          await assertConfiguration(database, authority);
          const fresh = await readCourtyardHandoffAuthority(central.client, args.operationId);
          assertReceiptAuthority(receipt, fresh);
          if (!fresh.active) refuse("COURTYARD_CENTRAL_AUTHORITY_CHANGED");
        } });
      }
      if (args.mode === "--check-only" && courtyardResumeReviewAvailable(authority.active, snapshot.lease.owner, owner)) {
        if (!staged) refuse("COURTYARD_STAGED_CHECKPOINT_CHANGED");
        return { phase: "resume_review", reviewDigest: resumeReview, ...safeCheckpoint(snapshot) };
      }
      await assertCourtyardPauseProvenance(database, receipt, snapshot);
      const phase = assertCourtyardCheckpoint({ snapshot, providerId: receipt.providerId, nextConfigId: receipt.nextConfigId, phase: "paused", ...reclaim });
      const reviewDigest = handoffDigest({ authorityDigest: authority.authorityDigest, checkpoint: safeCheckpoint(snapshot) });
      if (args.mode === "--check-only") return { phase: `${phase}_prepare_review`, reviewDigest, ...safeCheckpoint(snapshot) };
      if (args.mode !== "--prepare") refuse("COURTYARD_ARGUMENTS_INVALID");
      requireReview(reviewDigest, args.reviewDigest);
      let sourceProof: CourtyardCanaryProof;
      if (authority.stage) {
        const test = await central.client.provider_connection_tests.findUniqueOrThrow({ where: { id: id(args.operationId, "activation-test") } });
        sourceProof = (test.result_summary as { sourceProof: unknown }).sourceProof as CourtyardCanaryProof;
      } else {
        let token = cipher.decrypt({ ciphertext: authority.source.ciphertext, nonce: authority.source.nonce,
          authTag: authority.source.auth_tag, keyVersion: authority.source.key_version },
        { organizationId: pins.organizationId, providerId: receipt.providerId, revisionId: authority.source.id });
        try { sourceProof = await probeCourtyardHandoff({ token, opaqueCursor: migrated.cursor.value!, providerId: receipt.providerId, nextConfigId: receipt.nextConfigId }); }
        finally { token = ""; }
      }
      const fresh = await readCourtyardHandoffCheckpoint(database);
      if (handoffDigest(safeCheckpoint(fresh)) !== handoffDigest(safeCheckpoint(snapshot))) refuse("COURTYARD_CHECKPOINT_CHANGED_AFTER_CANARY");
      assertCourtyardCheckpoint({ snapshot: fresh, providerId: receipt.providerId, nextConfigId: receipt.nextConfigId, phase: "paused", ...reclaim });
      const leases = new PrismaProviderWorkerLeaseRepository(database);
      const acquired = await leases.acquire({ role: "import", owner, leaseMilliseconds: 120000 });
      if (acquired.kind === "held") refuse("COURTYARD_UTILITY_LEASE_UNAVAILABLE");
      const utilityLease = { owner, fence: acquired.lease.fence.toString() };
      const locked = async (action: (tx: ProviderTransactionClient, checkpoint: CourtyardCheckpoint) => Promise<void>) =>
        withCourtyardCheckpointLocks(database, { owner, fence: acquired.lease.fence }, async (tx) => {
        const current = await readCourtyardHandoffCheckpoint(tx);
        assertCourtyardCheckpoint({ snapshot: current, providerId: receipt.providerId, nextConfigId: receipt.nextConfigId, phase: "paused", utilityLease });
        await assertCourtyardPauseProvenance(tx, receipt, current);
        await assertConfiguration(tx, authority);
        await action(tx, current);
      });
      try {
        await locked(async (tx, current) => {
          // Stage inactive central authority only while the exact provider checkpoint is locked.
          await stageCourtyardHandoff({ central: central.client, authority, receipt, checkpoint: current, sourceProof });
          if (current.cachedConfigId === receipt.nextConfigId) { await assertPreparedAudit(tx, receipt, migrated.cursorHash); return; }
          if (current.runtimeRowVersion !== snapshot.runtimeRowVersion) refuse("COURTYARD_RUNTIME_CAS_FAILED");
          const updated = await tx.provider_runtime.updateMany({ where: { singleton_key: true, operating_state: "paused", state_generation: 22n,
            row_version: BigInt(current.runtimeRowVersion), cached_config_version_id: pins.previousConfigId, source_cursor_hash: pins.cursorHash }, data: {
            cached_config_version_id: receipt.nextConfigId, cached_config_version_number: 3n,
            cached_configuration: { adapterKey: pins.nextAdapter, settings: { platform: pins.providerKey } },
            source_cursor: migrated.cursor, source_cursor_hash: migrated.cursorHash, next_due_at: null, last_control_sync_at: new Date(),
            row_version: { increment: 1n }, updated_at: new Date() } });
          if (updated.count !== 1) refuse("COURTYARD_RUNTIME_CAS_FAILED");
          await tx.local_audit_events.create({ data: { correlation_id: receipt.operationId, actor_operator_id: receipt.operatorId,
            action: `${pins.action}.prepared`, target_type: "provider_runtime", target_id: receipt.providerId, outcome: "success",
            details: { receiptDigest: handoffDigest(receipt), nextConfigId: receipt.nextConfigId, previousCursorHash: pins.cursorHash,
              nextCursorHash: migrated.cursorHash, checkpointDigest: receipt.checkpointDigest }, occurred_at: new Date() } });
        });
        // Provider commit precedes central CAS. Hold a second exact provider lock across activation.
        await locked(async (tx, current) => { await assertPreparedAudit(tx, receipt, migrated.cursorHash);
          await activateCourtyardHandoffLast({ central: central.client, authority, receipt, checkpoint: current }); });
        return { phase: "prepared_paused", operationId: receipt.operationId, ...safeCheckpoint(await readCourtyardHandoffCheckpoint(database)), sourceProof };
      } finally { await leases.release({ role: "import", owner, fence: acquired.lease.fence }); }
    }));
    if (result.state !== "reachable") refuse("COURTYARD_PROVIDER_OPERATION_FAILED");
    if (!result.value.ok) refuse(result.value.code);
    return result.value.value;
  } finally { environment.key.fill(0); await gateway.close().catch(() => undefined); await central.close().catch(() => undefined); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runCourtyardHandoff(parseCourtyardHandoffArguments(process.argv.slice(2))))); }
  catch (error) { console.error(JSON.stringify({ outcome: "refused", code: courtyardHandoffFailureCode(error) ?? "COURTYARD_HANDOFF_FAILED" })); process.exitCode = 1; }
}
