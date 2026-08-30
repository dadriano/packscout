#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoundedProviderDatabaseGateway, ProviderDatabaseDestinationPolicy,
  PrismaProviderWorkerLeaseRepository, createCentralDatabaseLifecycle, locateProviderDatabase,
  lockProviderWorkerLease, providerWorkerLeaseIsLive, setProviderImportLeaseContext,
  type ProviderPrismaClient, type ProviderTransactionClient } from "@packscout/database";
import { AesGcmProviderCredentialCipher, CipherProviderDatabaseCredentialResolver } from "@packscout/services";
import { loadCollectorCryptDataforrestRepositoryEnvironment } from "./activate-collector-crypt-dataforrest-source.mts";
import { readCollectorCryptDataforrestActivationEnvironment } from "./activate-collector-crypt-dataforrest-source-plan.mjs";
import { assertProviderReviewActivationDatabaseRoute } from "./provider-review-activation-database-proof.mts";
import { CollectorCheckpointHandoffError, collectorHandoff as pins, handoffDigest, handoffId,
  checkpointEvidence, assertCollectorHandoffDrained, reEnvelopeCollectorCursor, refuseHandoff,
  type CollectorHandoffCheckpoint } from "./collector-crypt-checkpoint-handoff-plan.mts";
import { probeCollectorHandoff, type CollectorHandoffCanary } from "./collector-crypt-checkpoint-handoff-canary.mts";
import { readCollectorHandoffAuthority, readCollectorHandoffCheckpoint, retainedCollectorCheckpoint,
  stageCollectorHandoff, activateCollectorHandoffLast, collectorLocalConfiguration,
  type CollectorHandoffAuthority } from "./collector-crypt-checkpoint-handoff-state.mts";
import { readPauseReceipt, pauseReceipt, submitCollectorPause, assertCollectorPauseProvenance,
  resumeCollectorHandoff, type CollectorPauseReceipt } from "./collector-crypt-checkpoint-handoff-receipts.mts";
import { collectorTimeoutReceipt, readCollectorTimeoutReceipt, submitCollectorTimeoutPause,
  assertCollectorTimeoutProvenance, assertCollectorTimeoutHandoffDrained,
  type CollectorTimeoutReceipt } from "./collector-crypt-checkpoint-handoff-timeout.mts";

export { CollectorCheckpointHandoffError };
const allowedCollectorHandoffCodes = new Set([
  "HANDOFF_CANARY_AUTHORITY_INVALID", "HANDOFF_CANARY_BYTE_LIMIT", "HANDOFF_CANARY_JSON_INVALID",
  "HANDOFF_CANARY_PAGE_INVALID", "HANDOFF_CANARY_STATUS_INVALID", "HANDOFF_CANARY_TRANSPORT_FAILED",
  "HANDOFF_CHECKPOINT_NOT_DRAINED", "HANDOFF_CURSOR_INVALID", "HANDOFF_OPERATION_ID_INVALID",
  "HANDOFF_PREPARATION_NOT_DURABLE", "HANDOFF_SOURCE_COMPATIBILITY_CHANGED", "HANDOFF_PAUSE_PROVENANCE_INVALID",
  "HANDOFF_PAUSE_RECEIPT_CHANGED", "HANDOFF_PAUSE_RECEIPT_INVALID", "HANDOFF_PAUSE_REFUSED", "HANDOFF_PAUSE_TARGET_CHANGED",
  "HANDOFF_QUEUED_RUN_CHANGED", "HANDOFF_QUEUE_REFUSED_RESUME_RECEIPT_RETAINED", "HANDOFF_RESUME_RECEIPT_CHANGED", "HANDOFF_RESUME_REFUSED",
  "HANDOFF_ACTIVATION_DIGEST_UNAVAILABLE", "HANDOFF_ACTIVATION_NOT_PREPARED", "HANDOFF_CANARY_EXPIRED", "HANDOFF_CANARY_PROOF_INVALID",
  "HANDOFF_CENTRAL_AUTHORITY_CHANGED", "HANDOFF_CENTRAL_CAS_FAILED", "HANDOFF_OPERATOR_UNAVAILABLE", "HANDOFF_RUNTIME_IDENTITY_INVALID",
  "HANDOFF_STAGED_AUTHORITY_CHANGED", "HANDOFF_STAGED_CHECKPOINT_CHANGED", "HANDOFF_TIMEOUT_CHECKPOINT_CHANGED",
  "HANDOFF_TIMEOUT_LEASE_CHANGED", "HANDOFF_TIMEOUT_PAUSE_REFUSED", "HANDOFF_TIMEOUT_PROVENANCE_INVALID",
  "HANDOFF_TIMEOUT_RECEIPT_CHANGED", "HANDOFF_TIMEOUT_RECEIPT_INVALID", "HANDOFF_TIMEOUT_RUN_CHANGED",
  "HANDOFF_ARGUMENTS_INVALID", "HANDOFF_CACHED_CONFIGURATION_CHANGED", "HANDOFF_CHECKPOINT_CHANGED_AFTER_PROBE",
  "HANDOFF_ENTRY_RECEIPT_CONFLICT", "HANDOFF_NOT_ACTIVATED", "HANDOFF_OPERATION_FAILED", "HANDOFF_PAUSE_REQUIRED",
  "HANDOFF_PROCESS_STATUS_UNAVAILABLE", "HANDOFF_PROVIDER_OPERATION_FAILED", "HANDOFF_RESUME_PRECONDITION_CHANGED",
  "HANDOFF_RETAINED_CHECKPOINT_CHANGED", "HANDOFF_REVIEW_REQUIRED", "HANDOFF_REVIEW_STALE", "HANDOFF_ROUTE_UNAVAILABLE",
  "HANDOFF_RUNTIME_CAS_FAILED", "HANDOFF_UTILITY_LEASE_EXPIRED", "HANDOFF_UTILITY_LEASE_UNAVAILABLE",
]);
export function collectorHandoffFailureCode(error: unknown): string | undefined {
  return error instanceof CollectorCheckpointHandoffError && allowedCollectorHandoffCodes.has(error.code) ? error.code : undefined;
}
/** The gateway receives a safe result union, never a domain Error/cause/message. */
export async function captureCollectorHandoffResult<T>(operation: () => Promise<T>) {
  try { return { ok: true as const, value: await operation() }; }
  catch (error) {
    const code = collectorHandoffFailureCode(error);
    if (code) return { ok: false as const, code };
    throw error; // Unknown failures retain the gateway's existing generic redaction.
  }
}

export function parseCollectorHandoffArguments(args: readonly string[]) {
  const allowed = new Set(["--operation-id", "--old-worker-pid", "--expected-worker-owner", "--review-digest", "--entry"]);
  const modes = ["--check-only", "--pause", "--prepare", "--resume"] as const;
  const mode = args[0];
  if (!modes.includes(mode as typeof modes[number]) || (args.length - 1) % 2 !== 0) refuseHandoff("HANDOFF_ARGUMENTS_INVALID");
  const values = new Map<string, string>();
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i]!; const value = args[i + 1]!;
    if (!allowed.has(key) || values.has(key) || !value) refuseHandoff("HANDOFF_ARGUMENTS_INVALID");
    values.set(key, value);
  }
  const operationId = values.get("--operation-id") ?? "";
  handoffId(operationId, "validate");
  const entry = values.get("--entry") ?? "clean-pause";
  if (entry !== "clean-pause" && entry !== "terminal-timeout") refuseHandoff("HANDOFF_ARGUMENTS_INVALID");
  const pid = values.get("--old-worker-pid") ?? "";
  const expectedOwner = values.get("--expected-worker-owner") ?? "";
  if (entry === "terminal-timeout" ? pid !== "" || expectedOwner !== ""
    : !/^[1-9][0-9]{0,9}$/u.test(pid) || Number(pid) > 2_147_483_647 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u.test(expectedOwner)) refuseHandoff("HANDOFF_ARGUMENTS_INVALID");
  const reviewDigest = values.get("--review-digest");
  if ((mode !== "--check-only" && !reviewDigest) || (reviewDigest && !/^[a-f0-9]{64}$/u.test(reviewDigest))) {
    refuseHandoff("HANDOFF_REVIEW_REQUIRED");
  }
  return { mode, operationId, entry, oldWorkerPid: Number(pid), expectedOwner, reviewDigest };
}
type Arguments = ReturnType<typeof parseCollectorHandoffArguments>;
type EntryReceipt = CollectorPauseReceipt | CollectorTimeoutReceipt;
const isTimeoutReceipt = (receipt: EntryReceipt): receipt is CollectorTimeoutReceipt => "kind" in receipt;
export const collectorHandoffGatewayBounds = Object.freeze({ connectionLimitPerProvider: 1,
  maximumCachedProviders: 1, connectionTimeoutMs: 5000, operationTimeoutMs: 60_000 });
export function collectorResumeReviewAvailable(input: Readonly<{
  active: boolean; staged: boolean; leaseOwner: string | null; operationOwner: string;
}>) {
  // A crashed prepare may have activated centrally but not released its lease yet.
  // Expose preparation cleanup first; its drain guard rejects live or foreign leases.
  return input.active && input.staged && input.leaseOwner !== input.operationOwner;
}

export function oldWorkerIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    return refuseHandoff("HANDOFF_PROCESS_STATUS_UNAVAILABLE");
  }
}
const requireReview = (actual: string, expected: string | undefined) => {
  if (actual !== expected) refuseHandoff("HANDOFF_REVIEW_STALE");
};

async function assertRuntimeConfiguration(database: ProviderPrismaClient | ProviderTransactionClient, authority: CollectorHandoffAuthority) {
  const runtime = await database.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
  const adapterKey = runtime.cached_config_version_id === authority.previous.id ? pins.previousAdapter : pins.nextAdapter;
  if (handoffDigest(runtime.cached_configuration) !== handoffDigest({ adapterKey, settings: { platform: pins.providerKey } }) ||
    runtime.schedule_seconds !== authority.previous.schedule_seconds || runtime.config_expires_at !== null) {
    refuseHandoff("HANDOFF_CACHED_CONFIGURATION_CHANGED");
  }
}

function assertReceiptAuthority(receipt: EntryReceipt, authority: CollectorHandoffAuthority, args: Arguments) {
  const entryMatches = isTimeoutReceipt(receipt) ? args.entry === "terminal-timeout"
    : args.entry === "clean-pause" && receipt.oldWorkerPid === args.oldWorkerPid && receipt.owner === args.expectedOwner;
  if (!entryMatches || receipt.authorityDigest !== authority.authorityDigest || receipt.operatorId !== authority.operatorId ||
    receipt.previousConfigId !== authority.previous.id || receipt.nextConfigId !== authority.nextConfigId) {
    refuseHandoff("HANDOFF_PAUSE_RECEIPT_CHANGED");
  }
}

export async function runCollectorHandoff(args: Arguments) {
  const environment = readCollectorCryptDataforrestActivationEnvironment({ processEnvironment: process.env,
    fileEnvironment: await loadCollectorCryptDataforrestRepositoryEnvironment() });
  const cipher = new AesGcmProviderCredentialCipher({ primaryVersion: environment.credentialKeyVersion,
    keys: new Map([[environment.credentialKeyVersion, environment.credentialKey]]) });
  const central = createCentralDatabaseLifecycle({ databaseUrl: environment.centralDatabaseUrl, connectionLimit: 1 });
  const gateway = new BoundedProviderDatabaseGateway({ central,
    credentialResolver: new CipherProviderDatabaseCredentialResolver(cipher),
    destinationPolicy: new ProviderDatabaseDestinationPolicy({ allowedHosts: ["127.0.0.1"], allowedPorts: [pins.port], allowedSslModes: ["disable"] }),
    ...collectorHandoffGatewayBounds });
  try {
    await central.start();
    const authority = await readCollectorHandoffAuthority(central.client, args.operationId);
    const route = await locateProviderDatabase(central.client, { organizationId: pins.organizationId, providerId: pins.providerId });
    if (route.state !== "ready") refuseHandoff("HANDOFF_ROUTE_UNAVAILABLE");
    assertProviderReviewActivationDatabaseRoute(route.route, { organizationId: pins.organizationId,
      providerId: pins.providerId, providerKey: pins.providerKey, configVersionId: authority.provider.active_config_version_id!,
      providerRowVersion: authority.provider.row_version, topologyVersion: authority.provider.topology_version,
      nodeId: authority.node.id, nodeRowVersion: authority.node.row_version, databaseCredentialVersionId: authority.node.credential.id,
      host: "127.0.0.1", port: pins.port, databaseName: pins.databaseName, sslMode: "disable" });
    const result = await gateway.runWithCachedProviderDatabase(route.route, async (database) => captureCollectorHandoffResult(async () => {
      const cleanReceipt = await readPauseReceipt(database, args.operationId);
      const timeoutReceipt = await readCollectorTimeoutReceipt(database, args.operationId);
      if (cleanReceipt && timeoutReceipt) refuseHandoff("HANDOFF_ENTRY_RECEIPT_CONFLICT");
      let receipt: EntryReceipt | null = cleanReceipt ?? timeoutReceipt;
      const read = (client: ProviderPrismaClient | ProviderTransactionClient = database) => readCollectorHandoffCheckpoint(client,
        { oldProcessAlive: args.entry === "terminal-timeout" ? false : oldWorkerIsAlive(args.oldWorkerPid),
          ...(receipt ? { runId: receipt.runId } : {}) });
      let snapshot = await read();
      await assertRuntimeConfiguration(database, authority);
      if (receipt) assertReceiptAuthority(receipt, authority, args);
      const pauseLabel = args.entry === "terminal-timeout" ? "terminal-timeout-pause-command" : "pause-command";
      const pauseCommand = receipt ? await database.control_commands.findUnique({ where: { id: handoffId(args.operationId, pauseLabel) } }) : null;
      if (!receipt || args.mode === "--pause" || !pauseCommand) {
        const intent = receipt ?? (args.entry === "terminal-timeout"
          ? collectorTimeoutReceipt({ authority, snapshot, operationId: args.operationId })
          : pauseReceipt({ authority, snapshot, operationId: args.operationId,
            oldWorkerPid: args.oldWorkerPid, expectedOwner: args.expectedOwner }));
        const reviewDigest = handoffDigest(intent);
        if (args.mode === "--check-only") return { phase: isTimeoutReceipt(intent) ? "terminal_timeout_pause_review" : "pause_review", reviewDigest,
          providerId: pins.providerId, runId: intent.runId, runFence: intent.runFence, generation: intent.generation };
        if (args.mode !== "--pause") refuseHandoff("HANDOFF_PAUSE_REQUIRED");
        requireReview(reviewDigest, args.reviewDigest);
        return isTimeoutReceipt(intent) ? submitCollectorTimeoutPause(database, intent, authority) : submitCollectorPause(database, intent);
      }
      receipt = receipt as EntryReceipt;
      const assertProvenance = (client: ProviderPrismaClient | ProviderTransactionClient, current: CollectorHandoffCheckpoint) =>
        isTimeoutReceipt(receipt) ? assertCollectorTimeoutProvenance(client, receipt, current)
          : assertCollectorPauseProvenance(client, receipt, current);
      const assertDrained = isTimeoutReceipt(receipt) ? assertCollectorTimeoutHandoffDrained : assertCollectorHandoffDrained;
      const pausedGeneration = (BigInt(receipt.generation) + 1n).toString();
      const migrated = reEnvelopeCollectorCursor({ cursor: snapshot.run.finalCursor, cursorHash: snapshot.run.finalCursorHash,
        previousConfigId: authority.previous.id, nextConfigId: authority.nextConfigId });
      const stageMetadata = authority.stage?.metadata_json as Record<string, unknown> | undefined;
      const owner = `local:collector:handoff:${args.operationId}`;
      const reclaim = stageMetadata?.checkpointDigest === handoffDigest(retainedCollectorCheckpoint(snapshot))
        ? { reclaimableUtilityOwner: owner } : {};
      const resumeReviewDigest = handoffDigest({ authorityDigest: authority.authorityDigest,
        operationId: args.operationId, checkpointDigest: stageMetadata?.checkpointDigest, nextCursorHash: stageMetadata?.nextCursorHash });
      if (args.mode === "--resume") {
        requireReview(resumeReviewDigest, args.reviewDigest);
        if (!authority.active || !stageMetadata || stageMetadata.nextCursorHash !== migrated.cursorHash) refuseHandoff("HANDOFF_NOT_ACTIVATED");
        return resumeCollectorHandoff({ database, receipt, cursorHash: migrated.cursorHash, assertPrepared: async (resumed) => {
          const current = await read();
          const stable = { ...current, generation: pausedGeneration };
          if (handoffDigest(retainedCollectorCheckpoint(stable)) !== stageMetadata.checkpointDigest ||
            current.cachedConfigId !== authority.nextConfigId || current.cachedConfigNumber !== "3" ||
            current.cursorHash !== migrated.cursorHash || handoffDigest(current.cursor) !== handoffDigest(migrated.cursor) ||
            current.generation !== (BigInt(pausedGeneration) + (resumed ? 1n : 0n)).toString() ||
            current.runtimeState !== (resumed ? "idle" : "paused") || current.activeRunCount !== 0 ||
            current.actionableCommandCount !== 0 || current.oldProcessAlive || current.lease.owner !== null ||
            current.lease.expiresAt !== null || current.otherActiveTransactionCount !== 0) refuseHandoff("HANDOFF_RESUME_PRECONDITION_CHANGED");
          await assertRuntimeConfiguration(database, authority);
          const fresh = await readCollectorHandoffAuthority(central.client, args.operationId);
          if (!fresh.active || fresh.authorityDigest !== authority.authorityDigest) refuseHandoff("HANDOFF_CENTRAL_AUTHORITY_CHANGED");
        } });
      }
      if (args.mode === "--check-only" && collectorResumeReviewAvailable({ active: authority.active,
        staged: Boolean(stageMetadata), leaseOwner: snapshot.lease.owner, operationOwner: owner })) {
        return { phase: "resume_review", reviewDigest: resumeReviewDigest,
          ...checkpointEvidence(snapshot), runtimeState: snapshot.runtimeState };
      }
      await assertProvenance(database, snapshot);
      const phase = assertDrained({ snapshot, previousConfigId: authority.previous.id,
        nextConfigId: authority.nextConfigId, expectedGeneration: pausedGeneration, ...reclaim });
      const reviewDigest = handoffDigest({ authorityDigest: authority.authorityDigest, checkpoint: checkpointEvidence(snapshot) });
      if (args.mode === "--check-only") return { phase: `${phase}_prepare_review`, reviewDigest, ...checkpointEvidence(snapshot) };
      if (args.mode !== "--prepare") refuseHandoff("HANDOFF_ARGUMENTS_INVALID");
      requireReview(reviewDigest, args.reviewDigest);
      let sourceProof: CollectorHandoffCanary;
      if (authority.stage) {
        const test = await central.client.provider_connection_tests.findUniqueOrThrow({ where: { id: handoffId(args.operationId, "activation-test") } });
        sourceProof = (test.result_summary as { sourceProof: unknown }).sourceProof as CollectorHandoffCanary;
      } else {
        let token = cipher.decrypt({ ciphertext: authority.source.ciphertext, nonce: authority.source.nonce,
          authTag: authority.source.auth_tag, keyVersion: authority.source.key_version },
        { organizationId: pins.organizationId, providerId: pins.providerId, revisionId: authority.source.id });
        try { sourceProof = await probeCollectorHandoff({ token, opaqueCursor: migrated.cursor.value!,
          previousConfigId: authority.previous.id, nextConfigId: authority.nextConfigId }); }
        finally { token = ""; }
      }
      const fresh = await read();
      if (handoffDigest(checkpointEvidence(fresh)) !== handoffDigest(checkpointEvidence(snapshot))) refuseHandoff("HANDOFF_CHECKPOINT_CHANGED_AFTER_PROBE");
      assertDrained({ snapshot: fresh, previousConfigId: authority.previous.id,
        nextConfigId: authority.nextConfigId, expectedGeneration: pausedGeneration, ...reclaim });
      await stageCollectorHandoff({ central: central.client, authority, operationId: args.operationId,
        checkpoint: fresh, sourceProof, nextCursorHash: migrated.cursorHash });
      const leases = new PrismaProviderWorkerLeaseRepository(database);
      const acquired = await leases.acquire({ role: "import", owner, leaseMilliseconds: 120_000 });
      if (acquired.kind === "held") refuseHandoff("HANDOFF_UTILITY_LEASE_UNAVAILABLE");
      const utilityLease = { owner, fence: acquired.lease.fence.toString() };
      const locked = async <T,>(action: (tx: ProviderTransactionClient, current: CollectorHandoffCheckpoint) => Promise<T>) => database.$transaction(async (tx) => {
        const lease = await lockProviderWorkerLease(tx, "import");
        if (!providerWorkerLeaseIsLive(lease, { owner, fence: acquired.lease.fence })) refuseHandoff("HANDOFF_UTILITY_LEASE_EXPIRED");
        await setProviderImportLeaseContext(tx, { owner, fence: acquired.lease.fence });
        await tx.$queryRaw`select id from provider_runs where id=${receipt.runId}::uuid for update`;
        await tx.$queryRaw`select singleton_key from provider_runtime where singleton_key=true for update`;
        const current = await read(tx);
        assertDrained({ snapshot: current, previousConfigId: authority.previous.id,
          nextConfigId: authority.nextConfigId, expectedGeneration: pausedGeneration, utilityLease });
        await assertProvenance(tx, current);
        await assertRuntimeConfiguration(tx, authority);
        if (handoffDigest(retainedCollectorCheckpoint(current)) !== handoffDigest(retainedCollectorCheckpoint(snapshot))) {
          refuseHandoff("HANDOFF_RETAINED_CHECKPOINT_CHANGED");
        }
        return action(tx, current);
      }, { isolationLevel: "Serializable", maxWait: 5000, timeout: 45_000 });
      try {
        await locked(async (tx, current) => {
          if (current.cachedConfigId === authority.nextConfigId) return;
          if (current.runtimeRowVersion !== snapshot.runtimeRowVersion) refuseHandoff("HANDOFF_RUNTIME_CAS_FAILED");
          const updated = await tx.provider_runtime.updateMany({ where: { singleton_key: true,
            operating_state: "paused", state_generation: BigInt(pausedGeneration), row_version: BigInt(current.runtimeRowVersion),
            cached_config_version_id: authority.previous.id, source_cursor_hash: current.cursorHash }, data: {
            cached_config_version_id: authority.nextConfigId, cached_config_version_number: 3n,
            cached_configuration: collectorLocalConfiguration(), source_cursor: migrated.cursor,
            source_cursor_hash: migrated.cursorHash, config_expires_at: authority.previous.expires_at,
            schedule_seconds: authority.previous.schedule_seconds, next_due_at: null, last_control_sync_at: new Date(),
            row_version: { increment: 1n }, updated_at: new Date() } });
          if (updated.count !== 1) refuseHandoff("HANDOFF_RUNTIME_CAS_FAILED");
          await tx.local_audit_events.create({ data: { correlation_id: args.operationId,
            actor_operator_id: authority.operatorId, action: `${pins.action}.prepared`, target_type: "provider_runtime",
            target_id: pins.providerId, outcome: "success", details: { ...retainedCollectorCheckpoint(current),
              nextConfigId: authority.nextConfigId, nextCursorHash: migrated.cursorHash, opaqueValueHash: migrated.opaqueValueHash }, occurred_at: new Date() } });
        });
        // Local commit is durable BEFORE central activation. The second transaction holds
        // runtime/lease/run locks across central CAS, so operator resume cannot race it.
        await locked(async (_tx, current) => activateCollectorHandoffLast({ central: central.client,
          operationId: args.operationId, authorityDigest: authority.authorityDigest, checkpoint: current }));
        snapshot = await read();
        return { phase: "prepared_paused", operationId: args.operationId, ...checkpointEvidence(snapshot), sourceProof };
      } finally { await leases.release({ role: "import", owner, fence: acquired.lease.fence }); }
    }));
    if (result.state !== "reachable") refuseHandoff("HANDOFF_PROVIDER_OPERATION_FAILED");
    if (!result.value.ok) refuseHandoff(result.value.code);
    return result.value.value;
  } finally {
    environment.credentialKey.fill(0);
    await gateway.close().catch(() => undefined);
    await central.close().catch(() => undefined);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await runCollectorHandoff(parseCollectorHandoffArguments(process.argv.slice(2))))); }
  catch (error) {
    console.error(JSON.stringify({ outcome: "refused", code: collectorHandoffFailureCode(error) ?? "HANDOFF_OPERATION_FAILED" }));
    process.exitCode = 1;
  }
}
