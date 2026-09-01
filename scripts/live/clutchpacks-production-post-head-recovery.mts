import { execFile, spawn as spawnChild, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, existsSync, readdirSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { canonicalJson } from "@packscout/contracts";
import { publishClutchpacksProductionPostHead, clutchpacksProductionPostHeadSchema,
  clutchpacksProductionPostHeadRecoveryPrimitives as artifact } from "./clutchpacks-production-post-head.mts";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const commit = z.string().regex(/^[a-f0-9]{40}$/u);
const integerText = z.string().regex(/^(?:0|[1-9][0-9]*)$/u);
const iso = z.iso.datetime().refine(value => new Date(value).toISOString() === value);
const absolute = z.string().min(1).max(4096).refine(value => path.isAbsolute(value) &&
  path.resolve(value) === value && !/[\r\n\0]/u.test(value));
const filePin = z.object({ path: absolute, sha256: hash }).strict();
const releasePointer = z.object({ publicReleaseId: z.uuid(), releaseFingerprint: hash }).strict();
const failurePins = z.object({ pendingBlocked: filePin, prepared: filePin,
  prepareStarted: filePin, prepareStdout: filePin, prepareStderr: filePin, prepareCompleted: filePin,
  publishStarted: filePin, publishStdout: filePin, publishStderr: filePin }).strict();
const targetChainPins = z.object({ authenticatedPreflight: filePin, preflightScript: filePin, preflightStderr: filePin,
  predecessorBundle: filePin, predecessorReceipt: filePin }).strict();
const oldIncidentPins = z.object({ artifactDirectory: absolute, publisherWorktree: absolute, publisherCommit: commit,
  pendingHead: filePin, journal: filePin, sourceConfig: filePin, bundle: filePin,
  targetPrevious: releasePointer.nullable(), targetChain: targetChainPins, failure: failurePins }).strict();
const modulePins = z.object({ promoteCli: filePin, convexRuntime: filePin,
  publicationOrchestrator: filePin, publicationPolicy: filePin, genericPublisher: filePin,
  sourceReader: filePin, servicesIndex: filePin }).strict();
const executorPins = z.object({ recovery: filePin, postHead: filePin, publishShim: filePin,
  runtimeInventory: filePin, launcher: filePin }).strict();
const publisherIdentity = z.object({ worktree: absolute, commit, modules: modulePins }).strict();
const executorIdentity = z.object({ worktree: absolute, commit, modules: executorPins }).strict();
const runtimeInventorySchema = z.object({ schemaVersion: z.literal("clutchpacks_production_runtime_inventory_v1"),
  root: absolute, allowedTargetRoot: absolute, entryCount: z.number().int().safe().min(1).max(300_000),
  fileCount: z.number().int().safe().min(1).max(300_000), directoryCount: z.number().int().safe().min(1).max(300_000),
  symlinkCount: z.number().int().safe().nonnegative().max(300_000),
  totalBytes: z.number().int().safe().min(1).max(5 * 1024 * 1024 * 1024), treeSha256: hash }).strict();
const sourceReaderIdentitySchema = z.object({ worktree: absolute, commit, script: filePin, policy: filePin,
  executable: filePin, loader: filePin, runtimeInventory: runtimeInventorySchema }).strict();
const environmentSchema = z.object({ HOME: absolute, NODE_ENV: z.literal("production"),
  PATH: z.string().min(1).max(4096), TMPDIR: absolute }).strict();
const successorRootSchema = z.object({ ordinal: z.union([z.literal(1), z.literal(2)]), rootId: z.uuid(),
  artifactDirectory: absolute, proofDirectory: absolute }).strict();
const executorPolicySchema = z.object({
  schemaVersion: z.literal("clutchpacks_production_post_head_recovery_executor_policy_v1"),
  executor: executorIdentity, importedRecoveryModule: filePin, publisher: publisherIdentity,
  executable: filePin, loader: filePin, runtimeInventory: runtimeInventorySchema,
  executorRuntimeInventory: runtimeInventorySchema, sourceReader: sourceReaderIdentitySchema,
  environment: environmentSchema,
  incidentManifest: filePin, ledgerPath: absolute,
  roots: z.tuple([successorRootSchema, successorRootSchema]), policySha256: hash,
}).strict();
const incidentManifestSchema = z.object({
  schemaVersion: z.literal("clutchpacks_production_post_head_successor_recovery_manifest_v1"),
  createdAt: iso, incidentId: z.uuid(), ledgerPath: absolute, recordsPath: absolute,
  ledgerSchemaSha256: hash, head: clutchpacksProductionPostHeadSchema, freshnessCutoff: iso,
  old: oldIncidentPins, oldRootInventorySha256: hash, publisher: publisherIdentity,
  executor: executorIdentity, sourceReader: sourceReaderIdentitySchema,
  roots: z.tuple([successorRootSchema, successorRootSchema]), manifestSha256: hash,
}).strict();
const successorInputSchema = z.object({ schemaVersion: z.literal("clutchpacks_production_post_head_successor_v1"),
  head: clutchpacksProductionPostHeadSchema, old: oldIncidentPins,
  publisher: publisherIdentity, executor: executorIdentity, executorPolicy: filePin,
  incidentManifest: filePin,
  deadlineMs: z.number().int().min(1).max(900_000) }).strict();
export type ClutchpacksProductionPostHeadSuccessorInput = z.input<typeof successorInputSchema>;

const sourceSnapshotSchema = z.object({ providerId: z.uuid(), configId: z.uuid(), configNumber: z.string(),
  runId: z.uuid(), checkpointHash: hash, generation: z.string(), runtimeRowVersion: z.string(),
  headFinishedAt: iso, authorityDigest: hash, runtimeState: z.literal("idle"), disposition: z.literal("due"),
  importLeaseOwned: z.literal(false), assertionProvenance: z.object({
    headAndImportLease: z.literal("clutchpacks_poller_check_only_v1"),
    noActiveOrActionableWork: z.literal("continuous_decision_due_v1"),
  }).strict() }).strict();
const sourceProofSchema = z.object({ startedAt: iso, completedAt: iso, snapshot: sourceSnapshotSchema }).strict();
const recoveryQuietSnapshotSchema = clutchpacksProductionPostHeadSchema.extend({ runtimeState: z.literal("idle"),
  importLeaseOwner: z.null(), importLeaseExpiresAt: z.null(), sourceStateDigest: hash,
  assertionProvenance: z.literal("production_source_state_strict_admission_v1") }).strict();
const recoveryQuietProofSchema = z.object({ startedAt: iso, completedAt: iso,
  snapshot: recoveryQuietSnapshotSchema }).strict();
const releaseStatusSchema = z.object({ publicReleaseId: z.uuid(), releaseFingerprint: hash,
  lifecycle: z.enum(["staging", "complete", "failed"]) }).strict();
const releaseCountsSchema = z.object({ categories: z.number().int().safe().nonnegative(),
  collectibles: z.number().int().safe().nonnegative(), repacks: z.number().int().safe().nonnegative(),
  chases: z.number().int().safe().nonnegative(), searchShards: z.number().int().safe().nonnegative() }).strict();
const fullReleaseStatusSchema = releaseStatusSchema.extend({ acceptedCounts: releaseCountsSchema,
  acceptedBatchCount: z.number().int().safe().nonnegative(), acceptedBatchChainHash: hash,
  acceptedEntityChainHashes: z.object({ categories: hash, collectibles: hash, repacks: hash, chases: hash }).strict(),
  acceptedSearchRowCount: z.number().int().safe().nonnegative(), acceptedSearchRowSetHash: hash,
  acceptedTopChaseCount: z.number().int().safe().nonnegative(),
  acceptedVerifiedTopChaseCount: z.number().int().safe().nonnegative().optional(),
  completedAt: iso.nullable() }).strict();
const richReleasePointerSchema = releasePointer.extend({
  methodVersion: z.string().min(1).max(128), confidencePolicyVersion: z.string().min(1).max(128),
  publicEvPolicyVersion: z.string().min(1).max(128).optional(), dataAsOf: iso, completedAt: iso,
  counts: releaseCountsSchema,
}).strict();
const targetSnapshotSchema = z.object({ active: z.object({ generation: z.number().int().safe().nonnegative(),
  publicReleaseId: z.uuid(), releaseFingerprint: hash }).strict(), previous: releasePointer.nullable(),
  activeStatus: releaseStatusSchema, previousStatus: releaseStatusSchema.nullable(),
  candidateStatus: releaseStatusSchema.nullable(), assertionProvenance: z.object({
    activeChain: z.literal("signed_active_state_double_read_v1"),
    lifecycle: z.literal("signed_release_status_projection_v1"),
    stagingExclusion: z.literal("publisher_start_cas_v1"),
  }).strict() }).strict();
const targetProofSchema = z.object({ startedAt: iso, completedAt: iso, snapshot: targetSnapshotSchema }).strict();
const authenticatedTargetPreflightSchema = z.object({
  schemaVersion: z.literal("clutchpacks_c533_authenticated_target_preflight_v1"), startedAt: iso, completedAt: iso,
  publisher: z.object({ worktree: absolute, commit,
    runtimeModule: filePin, publicationClient: filePin }).strict(),
  authenticatedReads: z.object({ activeStateOperationId: z.literal("data-release-v3-active-state"),
    statusPublicReleaseIds: z.array(z.uuid()).length(3) }).strict(),
  firstActiveState: z.object({ generation: z.number().int().safe().nonnegative(),
    activeRelease: richReleasePointerSchema.nullable(), previousRelease: richReleasePointerSchema.nullable() }).strict(),
  secondActiveState: z.object({ generation: z.number().int().safe().nonnegative(),
    activeRelease: richReleasePointerSchema.nullable(), previousRelease: richReleasePointerSchema.nullable() }).strict(),
  activeStatus: fullReleaseStatusSchema, previousStatus: fullReleaseStatusSchema,
  candidate: z.object({ publicReleaseId: z.uuid(), status: fullReleaseStatusSchema.nullable() }).strict(),
}).strict();
const residencyProofSchema = z.object({ label: z.literal("com.packscout.provider-import.clutchpacks"),
  port: z.literal(56_432), launchdUnloaded: z.literal(true), residentProcessCount: z.literal(0),
  portBound: z.literal(true), acquiredAt: iso, checkedAt: iso }).strict();
const executionLockProofSchema = z.object({ port: z.literal(47_432), portBound: z.literal(true), acquiredAt: iso }).strict();
const childTerminationProofSchema = z.object({ checkedAt: iso, pid: z.number().int().safe().positive(),
  processGroupId: z.number().int().safe().positive(), processAbsent: z.literal(true),
  processGroupAbsent: z.literal(true), executionLock: executionLockProofSchema }).strict();
const unboundChildAbsenceProofSchema = z.object({ checkedAt: iso, matchingProcessIds: z.array(z.never()).length(0),
  matchingProcessGroupIds: z.array(z.never()).length(0), executionLock: executionLockProofSchema,
  proofSha256: hash }).strict();
const checkoutProofSchema = z.object({ worktree: absolute, commit, cleanStatusSha256: hash,
  trackedFilesSha256: hash, verifiedAt: iso, proofSha256: hash }).strict();
const childLockProofSchema = z.object({
  schemaVersion: z.literal("clutchpacks_production_post_head_recovery_child_lock_v1"), acquiredAt: iso,
  pid: z.number().int().safe().positive(), port: z.literal(47_432), attemptDirectory: absolute,
  bundle: filePin, executorPolicy: filePin, executable: filePin, loader: filePin, shim: filePin, cli: filePin,
  runtimeInventory: runtimeInventorySchema, executorRuntimeInventory: runtimeInventorySchema,
  sourceRuntimeInventory: runtimeInventorySchema,
  publisherCheckout: checkoutProofSchema, executorCheckout: checkoutProofSchema, sourceCheckout: checkoutProofSchema,
  lockSha256: hash,
}).strict();
const continueTokenSchema = z.object({
  schemaVersion: z.literal("clutchpacks_production_post_head_recovery_continue_v1"), createdAt: iso,
  attemptDirectory: absolute, bundle: filePin, handshake: filePin, executorPolicy: filePin,
  sourcePreDispatch: sourceProofSchema, targetPreDispatch: targetProofSchema,
  residencyPreDispatch: residencyProofSchema, ledgerRecord: filePin, tokenSha256: hash,
}).strict();
const leaseSidecarSchema = z.object({ schemaVersion: z.literal("clutchpacks_production_lease_attempt_v1"),
  bundleSha256: hash, attemptId: z.uuid(), intentSha256: hash,
  request: z.object({ role: z.literal("import"), owner: z.string().min(1).max(512),
    leaseMilliseconds: z.literal(900_000) }).strict(), requestSha256: hash }).strict();
const observationRequestSchema = z.object({ schemaVersion: z.literal("data_release_v3"),
  operationId: z.string().min(1).max(512), idempotencyKey: z.string().min(1).max(512),
  publicReleaseId: z.uuid(), releaseFingerprint: hash, publicVendorId: z.uuid(), vendorKey: z.literal("clutchpacks"),
  observationSequence: z.number().int().safe().positive(), observedAt: iso, freshThrough: iso,
  lastHeadReachedAt: iso, sourceHeadSequence: integerText, settledSequence: integerText,
  sourceLifecycle: z.literal("active"), connectionState: z.literal("healthy"),
  qualityState: z.enum(["healthy", "degraded", "unknown"]), releaseAlignment: z.literal("aligned") }).strict();
const observationSidecarSchema = z.object({
  schemaVersion: z.literal("clutchpacks_production_observation_attempt_v1"), bundleSha256: hash,
  intentSha256: hash, request: observationRequestSchema, requestSha256: hash }).strict();
const sidecarSetSchema = z.object({ lease: filePin, observation: filePin, receipt: filePin }).strict();
const inventoryMetadata = { dev: integerText, ino: integerText, uid: integerText, gid: integerText,
  mode: integerText, nlink: integerText, size: integerText, flags: integerText.nullable(),
  birthtimeNs: integerText, mtimeNs: integerText, ctimeNs: integerText } as const;
const inventoryEntry = z.discriminatedUnion("type", [
  z.object({ relativePath: z.string().min(1).max(4096), type: z.literal("directory"),
    ...inventoryMetadata, listingSha256: hash }).strict(),
  z.object({ relativePath: z.string().min(1).max(4096), type: z.literal("file"),
    ...inventoryMetadata, sha256: hash }).strict(),
]);
const rootInventorySchema = z.object({ entries: z.array(inventoryEntry).min(1).max(20_000),
  xattrsSha256: hash, aclListingSha256: hash, inventorySha256: hash }).strict();
const abandonedRootStateSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("absent"), path: absolute, checkedAt: iso }).strict(),
  z.object({ state: z.literal("present"), path: absolute, inventory: rootInventorySchema }).strict(),
]);
const successorReceiptSchema = z.object({
  schemaVersion: z.literal("clutchpacks_production_post_head_successor_receipt_v1"), createdAt: iso, completedAt: iso,
  head: clutchpacksProductionPostHeadSchema, oldRootInventory: rootInventorySchema,
  finalOldRootInventory: rootInventorySchema, successorArtifactDirectory: absolute, successorRunDirectory: absolute,
  publisher: publisherIdentity, executor: executorIdentity, executorPolicy: filePin, bundle: filePin,
  firstEvidence: z.unknown(), firstSidecars: sidecarSetSchema, reentryEvidence: z.unknown(),
  reentrySidecars: sidecarSetSchema, firstTarget: targetProofSchema,
  finalTarget: targetProofSchema, sourceFinal: sourceProofSchema, residencyExclusion: residencyProofSchema,
  receiptSha256: hash,
}).strict();

const ledgerClaimPayloadSchema = z.object({ artifactRootAbsent: z.literal(true), proofRootAbsent: z.literal(true) }).strict();
const ledgerDispatchPayloadSchema = z.object({ phase: z.enum(["direct", "adoption"]), attemptDirectory: absolute,
  handshake: filePin, sourcePreDispatch: sourceProofSchema, targetPreDispatch: targetProofSchema,
  residencyPreDispatch: residencyProofSchema }).strict();
const ledgerDirectVerifiedPayloadSchema = z.object({ attemptDirectory: absolute, bundle: filePin,
  evidenceSha256: hash, sidecars: sidecarSetSchema, target: targetProofSchema,
  attemptVerified: filePin, runVerified: filePin }).strict();
const interruptedAdoptionSchema = z.object({ pendingHead: filePin, pendingBlocked: filePin,
  attemptDirectory: absolute, attemptFiles: z.array(filePin).min(4).max(5),
  sidecarNames: z.array(z.string().min(1).max(256)).length(3) }).strict();
const ledgerRetryCommon = z.object({
  termination: childTerminationProofSchema, source: sourceProofSchema, quiet: recoveryQuietProofSchema,
  target: targetProofSchema, residency: residencyProofSchema,
  abandonedArtifactInventory: rootInventorySchema, abandonedProofInventory: rootInventorySchema });
const ledgerRetryPayloadSchema = z.discriminatedUnion("reason", [
  ledgerRetryCommon.extend({ reason: z.literal("no_durable_receipt"), interruptedAdoption: z.null() }).strict(),
  ledgerRetryCommon.extend({ reason: z.literal("adoption_interrupted_pending"),
    interruptedAdoption: interruptedAdoptionSchema }).strict(),
  z.object({ reason: z.literal("claim_interrupted"), termination: unboundChildAbsenceProofSchema,
    source: sourceProofSchema, quiet: recoveryQuietProofSchema, target: targetProofSchema,
    residency: residencyProofSchema, abandonedArtifactRoot: abandonedRootStateSchema,
    abandonedProofRoot: abandonedRootStateSchema }).strict(),
]);
const ledgerCompletePayloadSchema = z.object({ successorReceipt: filePin, bundle: filePin,
  firstSidecars: sidecarSetSchema, reentrySidecars: sidecarSetSchema, finalTarget: targetProofSchema,
  sourceFinal: sourceProofSchema }).strict();
const ledgerTerminalPayloadSchema = z.object({ reason: z.enum(["unknown_child", "source_stale_or_moved",
  "target_rollback_or_divergence", "lease_or_work_owned", "adoption_pending_retained", "evidence_invalid",
  "direct_retry_exhausted", "claim_retry_exhausted"]),
  evidenceSha256: hash.nullable() }).strict();
const ledgerRecordCommon = z.object({ schemaVersion: z.literal("clutchpacks_production_post_head_successor_ledger_record_v1"),
  sequence: z.number().int().safe().nonnegative().max(15), previousRecordSha256: hash.nullable(),
  manifestSha256: hash, ledgerSchemaSha256: hash, incidentId: z.uuid(), recordedAt: iso,
  ordinal: z.union([z.literal(1), z.literal(2)]), root: successorRootSchema,
  recordSha256: hash });
const ledgerRecordSchema = z.discriminatedUnion("event", [
  ledgerRecordCommon.extend({ event: z.literal("attempt_claimed"), payload: ledgerClaimPayloadSchema }).strict(),
  ledgerRecordCommon.extend({ event: z.literal("direct_dispatched"), payload: ledgerDispatchPayloadSchema }).strict(),
  ledgerRecordCommon.extend({ event: z.literal("direct_verified"), payload: ledgerDirectVerifiedPayloadSchema }).strict(),
  ledgerRecordCommon.extend({ event: z.literal("retry_authorized"), payload: ledgerRetryPayloadSchema }).strict(),
  ledgerRecordCommon.extend({ event: z.literal("adoption_dispatched"), payload: ledgerDispatchPayloadSchema }).strict(),
  ledgerRecordCommon.extend({ event: z.literal("complete"), payload: ledgerCompletePayloadSchema }).strict(),
  ledgerRecordCommon.extend({ event: z.literal("terminal"), payload: ledgerTerminalPayloadSchema }).strict(),
]);
type SuccessorRoot = { readonly ordinal: 1 | 2; readonly rootId: string;
  readonly artifactDirectory: string; readonly proofDirectory: string };
type LedgerRecord = z.infer<typeof ledgerRecordSchema>;
type IncidentManifest = Omit<z.infer<typeof incidentManifestSchema>, "roots"> &
  { readonly roots: readonly [SuccessorRoot, SuccessorRoot] };
const ledgerSchemaDescriptor = Object.freeze({ schemaVersion: "clutchpacks_production_post_head_successor_ledger_schema_v1",
  maximumRoots: 2, maximumRecords: 16,
  events: ["attempt_claimed", "direct_dispatched", "direct_verified", "retry_authorized",
    "adoption_dispatched", "complete", "terminal"],
  retryReasons: ["claim_interrupted", "no_durable_receipt", "adoption_interrupted_pending"],
  retryPreserves: ["artifact_root_state", "proof_root_state"],
  terminationProof: "held_execution_lock_47432_v1" });

interface SuccessorDependencies {
  readonly git?: (args: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => Promise<string>;
  readonly spawn?: (file: string, args: readonly string[], options: {
    cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: ["ignore", "pipe", "pipe"];
  }) => ChildProcess;
  readonly kill?: (child: ChildProcess, signal: NodeJS.Signals) => void;
  readonly startDeadline?: (abort: () => void, milliseconds: number) => () => void;
  readonly now?: () => string;
  readonly signal?: AbortSignal;
  readonly readSourceProof?: (environment: NodeJS.ProcessEnv, signal?: AbortSignal,
    identity?: z.infer<typeof sourceReaderIdentitySchema>) => Promise<z.input<typeof sourceSnapshotSchema>>;
  readonly readRecoveryQuietProof?: (environment: NodeJS.ProcessEnv, signal?: AbortSignal,
    identity?: z.infer<typeof sourceReaderIdentitySchema>, sourceConfig?: z.infer<typeof filePin>,
    publisher?: z.infer<typeof publisherIdentity>, publisherRuntime?: z.infer<typeof runtimeInventorySchema>) =>
    Promise<z.input<typeof recoveryQuietSnapshotSchema>>;
  readonly readTargetProof?: (environment: NodeJS.ProcessEnv, signal: AbortSignal | undefined,
    publisher: z.infer<typeof publisherIdentity>, publisherRuntime: z.infer<typeof runtimeInventorySchema>) =>
    Promise<z.input<typeof targetSnapshotSchema>>;
  readonly inspectChildTermination?: (proof: z.infer<typeof childLockProofSchema>,
    executionLock: z.infer<typeof executionLockProofSchema>) =>
    Promise<z.input<typeof childTerminationProofSchema>>;
  readonly inspectUnboundChildAbsence?: (successor: SuccessorRoot, bundlePath: string,
    executionLock: z.infer<typeof executionLockProofSchema>) =>
    Promise<z.input<typeof unboundChildAbsenceProofSchema>>;
  readonly readRuntimeInventory?: (root: string, allowedTargetRoot: string) => Promise<z.input<typeof runtimeInventorySchema>>;
  readonly readRootMetadata?: (root: string) => Promise<{ xattrs: string; aclListing: string }>;
  readonly acquireResidencyExclusion?: () => Promise<{ proof: z.input<typeof residencyProofSchema>;
    refreshProof: () => Promise<z.input<typeof residencyProofSchema>>; release: () => void | Promise<void> }>;
  readonly acquireExecutionExclusion?: () => Promise<{ proof: z.input<typeof executionLockProofSchema>;
    refreshProof: () => Promise<z.input<typeof executionLockProofSchema>>;
    relinquishForChild: () => void | Promise<void>; reacquireAfterChild: () => void | Promise<void>;
    release: () => void | Promise<void> }>;
  readonly afterSuccessorCreated?: () => void | Promise<void>;
  readonly afterAttemptClaimed?: () => void | Promise<void>;
  readonly afterArtifactRootCreated?: () => void | Promise<void>;
  readonly afterChildHandshake?: () => void | Promise<void>;
  readonly afterLedgerDispatch?: (phase: "initial" | "reentry") => void | Promise<void>;
  readonly afterChildReady?: (phase: "initial" | "reentry") => void | Promise<void>;
  readonly afterFirstPublish?: () => void | Promise<void>;
  readonly afterStandardReentry?: () => void | Promise<void>;
  readonly afterAdoptionCommandCompleted?: () => void | Promise<void>;
  readonly afterAdoptionAttemptVerified?: () => void | Promise<void>;
  readonly afterAdoptionRunVerified?: () => void | Promise<void>;
}
interface SuccessorPolicy { readonly production: boolean; readonly importedModulePath?: string;
  readonly environment?: z.infer<typeof environmentSchema>; }
class SuccessorError extends Error {
  constructor(readonly code: string) { super("ClutchPacks production successor publication was refused safely."); }
}
const refuse = (code: string): never => { throw new SuccessorError(code); };
const same = (left: unknown, right: unknown) => artifact.digest(left) === artifact.digest(right);
const jsonBytes = (value: unknown) => Buffer.from(`${canonicalJson(value)}\n`);
const ledgerSchemaSha256 = artifact.digest(ledgerSchemaDescriptor);
const sameOrInside = (candidate: string, ancestor: string) =>
  candidate === ancestor || candidate.startsWith(`${ancestor}${path.sep}`);
async function exists(file: string) {
  try { await lstat(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

type LedgerState = { readonly status: "empty" | LedgerRecord["event"];
  readonly ordinal: 0 | 1 | 2; readonly tail: LedgerRecord | null; readonly retryUsed: boolean };
function reduceLedger(manifest: IncidentManifest, records: readonly LedgerRecord[]): LedgerState {
  let status: LedgerState["status"] = "empty", ordinal: 0 | 1 | 2 = 0;
  let tail: LedgerRecord | null = null, retryUsed = false;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index], { recordSha256, ...core } = record;
    const root = manifest.roots[record.ordinal - 1];
    const previousMatches = tail === null ? record.previousRecordSha256 === null :
      record.previousRecordSha256 === tail.recordSha256;
    if (record.sequence !== index || !previousMatches || artifact.digest(core) !== recordSha256 ||
      record.manifestSha256 !== manifest.manifestSha256 || record.ledgerSchemaSha256 !== manifest.ledgerSchemaSha256 ||
      record.incidentId !== manifest.incidentId || !root || !same(record.root, root)) {
      refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
    }
    if (record.event === "attempt_claimed") {
      const valid = status === "empty" && record.ordinal === 1 ||
        status === "retry_authorized" && ordinal === 1 && record.ordinal === 2 && !retryUsed;
      if (!valid) refuse("POST_HEAD_SUCCESSOR_LEDGER_TRANSITION_INVALID");
      if (record.ordinal === 2) retryUsed = true;
      ordinal = record.ordinal;
    } else {
      if (record.ordinal !== ordinal) refuse("POST_HEAD_SUCCESSOR_LEDGER_TRANSITION_INVALID");
      const allowed = record.event === "direct_dispatched" ? status === "attempt_claimed" && record.payload.phase === "direct" :
        record.event === "direct_verified" ? status === "direct_dispatched" :
          record.event === "retry_authorized" ? (status === "attempt_claimed" || status === "direct_dispatched" ||
            status === "adoption_dispatched") && ordinal === 1 && !retryUsed :
            record.event === "adoption_dispatched" ? status === "direct_verified" && record.payload.phase === "adoption" :
              record.event === "complete" ? status === "adoption_dispatched" :
                record.event === "terminal" && ["attempt_claimed", "direct_dispatched", "direct_verified",
                  "adoption_dispatched"].includes(status);
      if (!allowed) refuse("POST_HEAD_SUCCESSOR_LEDGER_TRANSITION_INVALID");
    }
    status = record.event; tail = record;
  }
  return { status, ordinal, tail, retryUsed };
}
async function readLedgerRecords(manifest: IncidentManifest) {
  await artifact.directory(manifest.ledgerPath); await artifact.directory(manifest.recordsPath, true);
  const rootNames = (await readdir(manifest.ledgerPath)).sort();
  if (!same(rootNames, ["executor-policy.json", "incident-manifest.json", "launch-policy.json", "records"])) {
    refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
  }
  let names = (await readdir(manifest.recordsPath)).sort();
  const orphanPattern = /^\.clutchpacks-publication-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/u;
  const orphans = names.filter(name => orphanPattern.test(name));
  if (orphans.length > 4) refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
  for (const name of orphans) {
    const temporaryPath = path.join(manifest.recordsPath, name), metadata = await lstat(temporaryPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o077) !== 0 || metadata.size > 1_048_576 || metadata.nlink < 1 || metadata.nlink > 2) {
      refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
    }
    if (metadata.nlink === 2) {
      const linked = await Promise.all(names.filter(candidate => /^[0-9]{6}\.json$/u.test(candidate)).map(async candidate => {
        const value = await lstat(path.join(manifest.recordsPath, candidate));
        return value.dev === metadata.dev && value.ino === metadata.ino;
      }));
      if (linked.filter(Boolean).length !== 1) refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
    }
    await unlink(temporaryPath);
  }
  if (orphans.length > 0) {
    await artifact.syncDirectory(manifest.recordsPath);
    names = (await readdir(manifest.recordsPath)).sort();
  }
  if (names.length > 16 || names.some((name, index) => name !== `${String(index).padStart(6, "0")}.json`)) {
    refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
  }
  const records: LedgerRecord[] = [];
  for (const name of names) records.push(ledgerRecordSchema.parse(
    artifact.parseJsonBytes(await artifact.readPrivate(path.join(manifest.recordsPath, name), 1_048_576))));
  reduceLedger(manifest, records);
  return records;
}
async function appendLedgerRecord(manifest: IncidentManifest, expectedStatus: LedgerState["status"],
  event: LedgerRecord["event"], ordinal: 1 | 2, payload: unknown, now: () => string) {
  const records = await readLedgerRecords(manifest), state = reduceLedger(manifest, records);
  const ordinalMatches = expectedStatus === "retry_authorized" ? state.ordinal === 1 && ordinal === 2 :
    state.ordinal === 0 || state.ordinal === ordinal;
  if (state.status !== expectedStatus || !ordinalMatches) {
    refuse("POST_HEAD_SUCCESSOR_LEDGER_TRANSITION_INVALID");
  }
  const root = manifest.roots[ordinal - 1]; if (!root) refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
  const core = { schemaVersion: "clutchpacks_production_post_head_successor_ledger_record_v1" as const,
    sequence: records.length, previousRecordSha256: state.tail?.recordSha256 ?? null,
    manifestSha256: manifest.manifestSha256, ledgerSchemaSha256: manifest.ledgerSchemaSha256,
    incidentId: manifest.incidentId, recordedAt: now(), ordinal, root, event, payload };
  const record = ledgerRecordSchema.parse({ ...core, recordSha256: artifact.digest(core) });
  const file = path.join(manifest.recordsPath, `${String(records.length).padStart(6, "0")}.json`);
  await artifact.writeBytesExclusive(file, jsonBytes(record));
  return { record, pin: await pin(file, 1_048_576) };
}

const incident = Object.freeze({
  oldRoot: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publications-successor-20260901T011542Z-7454390-126d1069",
  oldWorktree: "/Users/lains/Projects/packscout/.worktrees/clutchpacks-runtime-open-retry",
  oldCommit: "7454390f7bc85648f38320f8d52451f63a899422",
  runId: "c533e197-9a56-5360-a7cc-e35ad9677978",
  bundleSha256: "1fdcb21eee25b2fa82df7c7270f5e398df922542c92df725f5ba1b68e128577c",
  operationId: "617d8d8f-d51e-4841-9b64-d345b9fd2a8f",
  candidate: Object.freeze({ publicReleaseId: "407fcd2f-c202-8041-8965-03facabaab52",
    releaseFingerprint: "e21268d87b453850ec4ff443aeeb4207f0959880bfc213498fb7a930c08530ed" }),
  predecessor: Object.freeze({ generation: 25, publicReleaseId: "e6525685-89eb-8c5b-8ebf-e82d319ca1ff",
    releaseFingerprint: "2c15e1a2960b538a2ab770ec87c2eb98df18e5d1f78f9a6cadddfa6e1aaebdef" }),
  previous: Object.freeze({ publicReleaseId: "dd5597c1-7caf-85ae-84b4-28939255e4ef",
    releaseFingerprint: "aaedc8ecfe45fb920fbfcd94c13f9d486ced2803cd2387c06ff39be8e0d8e024" }),
  head: Object.freeze({ providerId: "14787a87-77c0-5771-bfe1-cd5507bf2881",
    configId: "de37fd7f-4461-4df1-86e6-6609486df4b7", configNumber: "4",
    runId: "c533e197-9a56-5360-a7cc-e35ad9677978",
    checkpointHash: "21d42b7688028e0e4fd95b2564dc5975ef32fa01ce2beec032c3beceb384e76f",
    generation: "87", runtimeRowVersion: "880", headFinishedAt: "2026-09-01T02:52:20.539Z",
    authorityDigest: "5cc97f73ecefa4e93b7706e37a3dd00a6fddf3b4c397eca9ec4b6bcc01b26384" }),
  freshnessCutoff: "2026-09-02T02:52:20.539Z",
  oldAttemptDirectoryName: "attempt-c1f1602d-d61d-4699-84cc-a0bd8a3f86c4",
  pendingHeadSha256: "775dae39249407d3718da5cad190644099590ed9458971da6af2cc43dd518029",
  blockedMarkerSha256: "9f186ae8b523973d3684c33189901417e8bf12bbffffb77ae481f0995f6c1046",
  targetHistory: Object.freeze({
    preflight: Object.freeze({ path: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-c533-target-preflight-20260901T055131Z.json",
      sha256: "ccfe601f5aebcd107374980e78796cc3337f2e7790624ee2fd2b62291b68494b" }),
    script: Object.freeze({ path: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-c533-target-preflight-20260901T055131Z.mjs",
      sha256: "98f8426710d0ebb02360fca3a78b38009e9a1145764979f9e5c6137436ab835d" }),
    stderr: Object.freeze({ path: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-c533-target-preflight-20260901T055131Z.stderr",
      sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" }),
    predecessorBundle: Object.freeze({ path: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publications-successor-20260901T011542Z-7454390-126d1069/5ee207cb-2608-5f47-a6db-0a16deb2682a/bundle.json",
      sha256: "0a0af154538c1feaa78fa279c2988dfd718cdf5a51f5b641d59a5d158e71e5d8" }),
    predecessorReceipt: Object.freeze({ path: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publications-successor-20260901T011542Z-7454390-126d1069/5ee207cb-2608-5f47-a6db-0a16deb2682a/bundle.json.receipt.b209365f-b9f3-421b-be2d-2a2da3f05a13.json",
      sha256: "2980cefc2db5977b074d65a3227730922b251990fb44a3202395c45e8c9f07ae" }),
    publicationClient: Object.freeze({ path: "/Users/lains/Projects/packscout/.worktrees/clutchpacks-runtime-open-retry/packages/services/src/convex-data-release-v3-publication-client.ts",
      sha256: "73fab70b8ca17a704650a90dffaa2a12f5a0e70bdce3daf7d0e682f6516dd14d" }),
    runtimeModule: Object.freeze({ path: "/Users/lains/Projects/packscout/.worktrees/clutchpacks-runtime-open-retry/scripts/live/clutchpacks-production-convex-runtime.mts",
      sha256: "b7fd402002f142d647727f6158fc49e841917a71e5a855a0896013f015f23d78" }),
  }),
});
const productionRegistry = Object.freeze({
  ledgerPath: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-c533e197-9a56-5360-a7cc-e35ad9677978-successor-recovery-ledger-v1",
  roots: Object.freeze([
    Object.freeze({ ordinal: 1 as const, rootId: "c80f32fe-d8d7-469a-8667-5f801c082f99",
      artifactDirectory: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publications-c533-recovery-1-20260901T065004Z-c80f32fe",
      proofDirectory: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publication-proofs-c533-recovery-1-20260901T065004Z-c80f32fe" }),
    Object.freeze({ ordinal: 2 as const, rootId: "9825ddf9-5fdc-4660-b2db-51c8fc74b041",
      artifactDirectory: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publications-c533-recovery-2-20260901T065004Z-9825ddf9",
      proofDirectory: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-publication-proofs-c533-recovery-2-20260901T065004Z-9825ddf9" }),
  ]),
});
const moduleRelativePaths = Object.freeze({ promoteCli: "scripts/live/promote-clutchpacks-production.mts",
  convexRuntime: "scripts/live/clutchpacks-production-convex-runtime.mts",
  publicationOrchestrator: "scripts/live/clutchpacks-production-v3-publication.mts",
  publicationPolicy: "scripts/live/clutchpacks-production-publication-policy.mts",
  genericPublisher: "packages/services/src/buyback-adjusted-ev-release-publisher.ts",
  sourceReader: "scripts/live/clutchpacks-production-source-reader.mts",
  servicesIndex: "packages/services/src/index.ts" });
const executorRelativePaths = Object.freeze({ recovery: "scripts/live/clutchpacks-production-post-head-recovery.mts",
  postHead: "scripts/live/clutchpacks-production-post-head.mts",
  publishShim: "scripts/live/clutchpacks-production-recovery-publish-shim.mjs",
  runtimeInventory: "scripts/live/clutchpacks-production-runtime-inventory.mjs",
  launcher: "scripts/live/clutchpacks-production-post-head-successor-launcher.mjs" });

function safeEnvironment(source: NodeJS.ProcessEnv) {
  const forbidden = ["NODE_OPTIONS", "NODE_PATH", "TSX_TSCONFIG_PATH", "TS_NODE_PROJECT", "TS_NODE_TRANSPILE_ONLY",
    "BABEL_ENV", "BABEL_CONFIG_PATH"];
  if (forbidden.some(key => source[key] !== undefined)) refuse("POST_HEAD_SUCCESSOR_RUNTIME_INVALID");
  const parsed = z.object({ HOME: z.string().min(1), PATH: z.string().min(1), TMPDIR: z.string().min(1) })
    .passthrough().parse(source);
  return environmentSchema.parse({ HOME: path.resolve(parsed.HOME), NODE_ENV: "production",
    PATH: parsed.PATH, TMPDIR: path.resolve(parsed.TMPDIR) });
}
function normalizeSealedEnvironment(source: NodeJS.ProcessEnv, expected = productionEnvironment,
  platform = process.platform, uid = process.getuid?.()) {
  const environment = Object.fromEntries(Object.entries(source));
  const injectedKey = "__CF_USER_TEXT_ENCODING";
  if (Object.hasOwn(environment, injectedKey)) {
    if (platform !== "darwin" || typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0 ||
      environment[injectedKey] !== `0x${uid.toString(16).toUpperCase()}:0x0:0x0`) {
      refuse("POST_HEAD_SUCCESSOR_LAUNCHER_INVALID");
    }
    delete environment[injectedKey];
  }
  const normalized = environmentSchema.safeParse(environment);
  if (!normalized.success || !same(normalized.data, expected)) refuse("POST_HEAD_SUCCESSOR_LAUNCHER_INVALID");
  return Object.freeze(normalized.data);
}
async function pin(file: string, maximum = 128 * 1024 * 1024, minimum = 1) {
  return { path: file, sha256: artifact.hashBytes(await artifact.readPrivate(file, maximum, minimum)) };
}
async function pinTrustedRegular(file: string, maximum = 256 * 1024 * 1024, minimum = 1) {
  let handle;
  try { handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { return refuse("POST_HEAD_SUCCESSOR_RUNTIME_CHANGED"); }
  try {
    const before = await handle.stat(), outsideBefore = await lstat(file);
    if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o022) !== 0 ||
      before.size < minimum || before.size > maximum || await realpath(file) !== file ||
      outsideBefore.isSymbolicLink() || outsideBefore.dev !== before.dev || outsideBefore.ino !== before.ino ||
      outsideBefore.uid !== before.uid || outsideBefore.gid !== before.gid || outsideBefore.mode !== before.mode ||
      outsideBefore.size !== before.size || outsideBefore.mtimeMs !== before.mtimeMs ||
      outsideBefore.ctimeMs !== before.ctimeMs) {
      refuse("POST_HEAD_SUCCESSOR_RUNTIME_CHANGED");
    }
    const bytes = await handle.readFile(), after = await handle.stat(), outsideAfter = await lstat(file);
    if (bytes.length !== before.size || after.dev !== before.dev || after.ino !== before.ino ||
      after.uid !== before.uid || after.gid !== before.gid || after.mode !== before.mode ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      outsideAfter.isSymbolicLink() || outsideAfter.dev !== before.dev || outsideAfter.ino !== before.ino ||
      outsideAfter.uid !== before.uid || outsideAfter.gid !== before.gid || outsideAfter.mode !== before.mode ||
      outsideAfter.size !== before.size || outsideAfter.mtimeMs !== before.mtimeMs ||
      outsideAfter.ctimeMs !== before.ctimeMs) {
      refuse("POST_HEAD_SUCCESSOR_RUNTIME_CHANGED");
    }
    return { path: file, sha256: artifact.hashBytes(bytes) };
  } finally { await handle.close(); }
}
async function pinned(expected: z.infer<typeof filePin>, maximum = 128 * 1024 * 1024, minimum = 1) {
  const bytes = await artifact.readPrivate(expected.path, maximum, minimum);
  if (artifact.hashBytes(bytes) !== expected.sha256) refuse("POST_HEAD_SUCCESSOR_INPUT_CHANGED");
  return bytes;
}
async function verifyModuleMap(worktree: string, pins: Record<string, z.infer<typeof filePin>>,
  relatives: Readonly<Record<string, string>>) {
  for (const [key, relative] of Object.entries(relatives)) {
    const expected = path.join(worktree, relative);
    if (pins[key]?.path !== expected || !same(pins[key], await pinTrustedRegular(expected, 8 * 1024 * 1024))) {
      refuse("POST_HEAD_SUCCESSOR_MODULE_CHANGED");
    }
  }
}
function checkoutOptions(worktree: string, expectedCommit: string, artifactDirectory: string,
  head: z.infer<typeof clutchpacksProductionPostHeadSchema>, baseSourceConfig: z.infer<typeof filePin>) {
  return artifact.parseOptions({ head, baseSourceConfig, artifactDirectory, publisherWorktree: worktree,
    expectedPublisherCommit: expectedCommit, expectedResidentAuthorityDigest: head.authorityDigest, timeoutMs: 900_000 });
}
async function rootInventory(root: string, deps: SuccessorDependencies) {
  const entries: z.infer<typeof rootInventorySchema>["entries"] = []; let totalBytes = 0;
  const metadata = (value: unknown) => {
    const stat = value as unknown as Record<string, bigint | undefined>;
    const required = (key: string) => {
      const found = stat[key]; if (typeof found !== "bigint" || found < 0n) refuse("POST_HEAD_SUCCESSOR_INVENTORY_INVALID");
      return found.toString();
    };
    const flags = stat.flags;
    return { dev: required("dev"), ino: required("ino"), uid: required("uid"), gid: required("gid"),
      mode: required("mode"), nlink: required("nlink"), size: required("size"),
      flags: typeof flags === "bigint" ? flags.toString() : null,
      birthtimeNs: required("birthtimeNs"), mtimeNs: required("mtimeNs"), ctimeNs: required("ctimeNs") };
  };
  async function visit(file: string, relativePath: string): Promise<void> {
    if (entries.length >= 20_000) refuse("POST_HEAD_SUCCESSOR_INVENTORY_INVALID");
    const before = await lstat(file, { bigint: true });
    if (before.isSymbolicLink() || before.uid !== BigInt(process.getuid?.() ?? -1) || (before.mode & 0o077n) !== 0n ||
      await realpath(file) !== file) refuse("POST_HEAD_SUCCESSOR_INVENTORY_INVALID");
    const base = { relativePath, ...metadata(before as never) };
    if (before.isDirectory()) {
      const names = (await readdir(file)).sort();
      entries.push({ ...base, type: "directory", listingSha256: artifact.digest(names) });
      for (const name of names) await visit(path.join(file, name), relativePath === "." ? name : path.join(relativePath, name));
      const after = await lstat(file, { bigint: true });
      if (!same(metadata(after as never), metadata(before as never)) ||
        !same(names, (await readdir(file)).sort())) refuse("POST_HEAD_SUCCESSOR_INVENTORY_CHANGED");
      return;
    }
    if (!before.isFile() || before.size > 256n * 1024n * 1024n ||
      BigInt(totalBytes) + before.size > 1024n * 1024n * 1024n) {
      refuse("POST_HEAD_SUCCESSOR_INVENTORY_INVALID");
    }
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW); let data: Buffer, opened;
    try { opened = await handle.stat({ bigint: true }); data = await handle.readFile(); } finally { await handle.close(); }
    const after = await lstat(file, { bigint: true }); totalBytes += data.length;
    if (!same(metadata(opened as never), metadata(before as never)) ||
      !same(metadata(after as never), metadata(before as never)) || BigInt(data.length) !== before.size) {
      refuse("POST_HEAD_SUCCESSOR_INVENTORY_CHANGED");
    }
    entries.push({ ...base, type: "file", sha256: artifact.hashBytes(data) });
  }
  await visit(root, "."); entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const external = deps.readRootMetadata ? await deps.readRootMetadata(root) : { xattrs: "", aclListing: "" };
  const core = { entries, xattrsSha256: artifact.hashBytes(Buffer.from(external.xattrs)),
    aclListingSha256: artifact.hashBytes(Buffer.from(external.aclListing)) };
  return rootInventorySchema.parse({ ...core, inventorySha256: artifact.digest(core) });
}
async function abandonedRootState(root: string, deps: SuccessorDependencies, now: () => string) {
  if (!await exists(root)) return abandonedRootStateSchema.parse({ state: "absent", path: root, checkedAt: now() });
  return abandonedRootStateSchema.parse({ state: "present", path: root, inventory: await rootInventory(root, deps) });
}
async function verifyAbandonedRootState(value: z.infer<typeof abandonedRootStateSchema>, deps: SuccessorDependencies) {
  if (value.state === "absent") {
    if (await exists(value.path)) refuse("POST_HEAD_SUCCESSOR_ABANDONED_ROOT_CHANGED");
    return;
  }
  if (!same(await rootInventory(value.path, deps), value.inventory)) {
    refuse("POST_HEAD_SUCCESSOR_ABANDONED_ROOT_CHANGED");
  }
}
function exactSource(head: z.infer<typeof clutchpacksProductionPostHeadSchema>) {
  return sourceSnapshotSchema.parse({ ...head, runtimeState: "idle", disposition: "due", importLeaseOwned: false,
    assertionProvenance: { headAndImportLease: "clutchpacks_poller_check_only_v1",
      noActiveOrActionableWork: "continuous_decision_due_v1" } });
}
function projectReleaseStatus(value: unknown) {
  if (value === null) return null;
  const parsed = fullReleaseStatusSchema.parse(value);
  return releaseStatusSchema.parse({ publicReleaseId: parsed.publicReleaseId,
    releaseFingerprint: parsed.releaseFingerprint, lifecycle: parsed.lifecycle });
}
async function readSource(deps: SuccessorDependencies, environment: NodeJS.ProcessEnv, now: () => string,
  head: z.infer<typeof clutchpacksProductionPostHeadSchema>, identity?: z.infer<typeof sourceReaderIdentitySchema>) {
  if (!deps.readSourceProof) refuse("POST_HEAD_SUCCESSOR_SOURCE_READER_MISSING");
  const startedAt = now(); let value: unknown;
  try { value = await deps.readSourceProof(environment, deps.signal, identity); }
  catch { return refuse("POST_HEAD_SUCCESSOR_SOURCE_UNAVAILABLE"); }
  const completedAt = now(), parsed = sourceSnapshotSchema.safeParse(value);
  if (!parsed.success || !same(parsed.data, exactSource(head)) || completedAt < startedAt ||
    Date.parse(completedAt) >= Date.parse(incident.freshnessCutoff)) refuse("POST_HEAD_SUCCESSOR_SOURCE_CHANGED");
  return sourceProofSchema.parse({ startedAt, completedAt, snapshot: parsed.data });
}
async function readRecoveryQuiet(deps: SuccessorDependencies, environment: NodeJS.ProcessEnv, now: () => string,
  head: z.infer<typeof clutchpacksProductionPostHeadSchema>, identity: z.infer<typeof sourceReaderIdentitySchema>,
  sourceConfig: z.infer<typeof filePin>, publisher: z.infer<typeof publisherIdentity>,
  publisherRuntime: z.infer<typeof runtimeInventorySchema>) {
  if (!deps.readRecoveryQuietProof) refuse("POST_HEAD_SUCCESSOR_RECOVERY_QUIET_READER_MISSING");
  const startedAt = now(); let value: unknown;
  try { value = await deps.readRecoveryQuietProof(environment, deps.signal, identity, sourceConfig,
    publisher, publisherRuntime); }
  catch { return refuse("POST_HEAD_SUCCESSOR_RECOVERY_QUIET_UNAVAILABLE"); }
  const completedAt = now(), parsed = recoveryQuietSnapshotSchema.safeParse(value);
  if (!parsed.success || !same(Object.fromEntries(Object.entries(parsed.data).filter(([key]) =>
    !["sourceStateDigest", "assertionProvenance", "runtimeState", "importLeaseOwner", "importLeaseExpiresAt"].includes(key))), head) ||
    parsed.data.runtimeState !== "idle" || parsed.data.importLeaseOwner !== null || parsed.data.importLeaseExpiresAt !== null ||
    parsed.data.assertionProvenance !== "production_source_state_strict_admission_v1" || completedAt < startedAt ||
    Date.parse(completedAt) >= Date.parse(incident.freshnessCutoff)) {
    refuse("POST_HEAD_SUCCESSOR_RECOVERY_QUIET_CHANGED");
  }
  return recoveryQuietProofSchema.parse({ startedAt, completedAt, snapshot: parsed.data });
}
async function readTarget(deps: SuccessorDependencies, environment: NodeJS.ProcessEnv, now: () => string,
  publisher: z.infer<typeof publisherIdentity>, publisherRuntime: z.infer<typeof runtimeInventorySchema>) {
  if (!deps.readTargetProof) refuse("POST_HEAD_SUCCESSOR_TARGET_READER_MISSING");
  const startedAt = now(); let value: unknown;
  try { value = await deps.readTargetProof(environment, deps.signal, publisher, publisherRuntime); }
  catch { return refuse("POST_HEAD_SUCCESSOR_TARGET_UNAVAILABLE"); }
  const completedAt = now(), parsed = targetSnapshotSchema.safeParse(value);
  if (!parsed.success || completedAt < startedAt || parsed.data.activeStatus.lifecycle !== "complete" ||
    parsed.data.activeStatus.publicReleaseId !== parsed.data.active.publicReleaseId ||
    parsed.data.activeStatus.releaseFingerprint !== parsed.data.active.releaseFingerprint ||
    ((parsed.data.previous === null) !== (parsed.data.previousStatus === null)) ||
    (parsed.data.previous !== null && (parsed.data.previousStatus?.lifecycle !== "complete" ||
      parsed.data.previousStatus.publicReleaseId !== parsed.data.previous.publicReleaseId ||
      parsed.data.previousStatus.releaseFingerprint !== parsed.data.previous.releaseFingerprint))) {
    refuse("POST_HEAD_SUCCESSOR_TARGET_INVALID");
  }
  return targetProofSchema.parse({ startedAt, completedAt, snapshot: parsed.data });
}
function targetDisposition(proof: z.infer<typeof targetProofSchema>, bundle: ReturnType<typeof artifact.boundBundleBytes>,
  expectedPrevious: z.infer<typeof releasePointer> | null) {
  const predecessor = bundle.intent.predecessor, candidate = bundle.intent.candidate, status = proof.snapshot.candidateStatus;
  if (status !== null && (status.publicReleaseId !== candidate.publicReleaseId ||
    status.releaseFingerprint !== candidate.releaseFingerprint || status.lifecycle === "failed")) {
    refuse("POST_HEAD_SUCCESSOR_TARGET_CHANGED");
  }
  if (same(proof.snapshot.active, predecessor) && same(proof.snapshot.previous, expectedPrevious)) return "predecessor" as const;
  const changed = predecessor.publicReleaseId !== candidate.publicReleaseId ||
    predecessor.releaseFingerprint !== candidate.releaseFingerprint;
  const expected = { generation: predecessor.generation + (changed ? 1 : 0),
    publicReleaseId: candidate.publicReleaseId, releaseFingerprint: candidate.releaseFingerprint };
  if (same(proof.snapshot.active, expected) && status?.lifecycle === "complete" &&
    same(proof.snapshot.previous, { publicReleaseId: predecessor.publicReleaseId,
      releaseFingerprint: predecessor.releaseFingerprint })) return "candidate" as const;
  return refuse("POST_HEAD_SUCCESSOR_TARGET_CHANGED");
}
async function publicationSidecars(bundlePath: string, bundle: ReturnType<typeof artifact.boundBundleBytes>,
  head: z.infer<typeof clutchpacksProductionPostHeadSchema>, expectedCount: number,
  previousNames: ReadonlySet<string>, selectedOutput?: ReturnType<typeof artifact.parseVerifiedOutput>) {
  const directory = path.dirname(bundlePath), allNames = (await readdir(directory)).sort();
  if (allNames.some(name => name.startsWith(".clutchpacks-") || name.includes(".tmp"))) {
    refuse("POST_HEAD_SUCCESSOR_SIDECAR_INVALID");
  }
  const names = allNames.filter(name => name.startsWith("bundle.json."));
  const leases = names.filter(name => /^bundle\.json\.lease\.[a-f0-9-]{36}\.json$/u.test(name));
  const observations = names.filter(name => /^bundle\.json\.observation\.[1-9][0-9]*\.json$/u.test(name));
  const receipts = names.filter(name => /^bundle\.json\.receipt\.[a-f0-9-]{36}\.json$/u.test(name));
  if (names.length !== expectedCount * 3 || leases.length !== expectedCount ||
    observations.length !== expectedCount || receipts.length !== expectedCount) {
    refuse("POST_HEAD_SUCCESSOR_SIDECAR_INVALID");
  }
  const intentSha256 = artifact.digest(bundle.intent);
  for (const name of leases) {
    const value = leaseSidecarSchema.parse(artifact.parseJsonBytes(await artifact.readPrivate(path.join(directory, name), 65_536)));
    if (name !== `bundle.json.lease.${value.attemptId}.json` || value.bundleSha256 !== bundle.bundleSha256 ||
      value.intentSha256 !== intentSha256 || value.requestSha256 !== artifact.digest(value.request) ||
      value.request.owner !== `production-publication:${bundle.intent.operationId}:${value.attemptId}`) {
      refuse("POST_HEAD_SUCCESSOR_SIDECAR_INVALID");
    }
  }
  for (const name of observations) {
    const value = observationSidecarSchema.parse(artifact.parseJsonBytes(
      await artifact.readPrivate(path.join(directory, name), 65_536)));
    const request = value.request, operationId = `clutchpacks-observation:${intentSha256}:${request.observationSequence}`;
    if (name !== `bundle.json.observation.${request.observationSequence}.json` ||
      value.bundleSha256 !== bundle.bundleSha256 || value.intentSha256 !== intentSha256 ||
      value.requestSha256 !== artifact.digest(request) || request.operationId !== operationId ||
      request.idempotencyKey !== operationId || request.publicReleaseId !== bundle.intent.candidate.publicReleaseId ||
      request.releaseFingerprint !== bundle.intent.candidate.releaseFingerprint ||
      request.lastHeadReachedAt !== bundle.intent.source.lastHeadReachedAt ||
      request.sourceHeadSequence !== bundle.intent.source.promotionSequence ||
      request.settledSequence !== bundle.intent.source.promotionSequence ||
      request.qualityState !== bundle.intent.source.qualityState || request.freshThrough <= request.observedAt ||
      request.observedAt < request.lastHeadReachedAt) refuse("POST_HEAD_SUCCESSOR_SIDECAR_INVALID");
  }
  const evidenceByReceipt = new Map<string, unknown>();
  const outputByReceipt = new Map<string, ReturnType<typeof artifact.parseVerifiedOutput>>();
  for (const name of receipts) {
    const receiptPath = path.join(directory, name), bytes = await artifact.readPrivate(receiptPath, 65_536);
    const receipt = artifact.parseReceiptBytes(bytes);
    const output = artifact.parseVerifiedOutput({ status: "verified", receiptPath,
      bundleSha256: receipt.bundleSha256, operationId: receipt.operationId,
      publicReleaseId: receipt.candidate.publicReleaseId, qualityState: receipt.source.qualityState,
      quarantineCount: receipt.source.quarantineCount });
    const evidence = artifact.receiptEvidenceBytes(output, bundle, bundlePath, head, bytes);
    evidenceByReceipt.set(receiptPath, evidence); outputByReceipt.set(receiptPath, output);
  }
  const newNames = names.filter(name => !previousNames.has(name));
  const newLease = newNames.filter(name => leases.includes(name));
  const newObservation = newNames.filter(name => observations.includes(name));
  const newReceipt = newNames.filter(name => receipts.includes(name));
  if (newNames.length !== 3 || newLease.length !== 1 || newObservation.length !== 1 || newReceipt.length !== 1) {
    refuse("POST_HEAD_SUCCESSOR_SIDECAR_INVALID");
  }
  const receiptPath = path.join(directory, newReceipt[0]!);
  if (selectedOutput && selectedOutput.receiptPath !== receiptPath) refuse("POST_HEAD_SUCCESSOR_SIDECAR_INVALID");
  const output = selectedOutput ?? outputByReceipt.get(receiptPath);
  const evidence = evidenceByReceipt.get(receiptPath);
  if (!output || !evidence) refuse("POST_HEAD_SUCCESSOR_SIDECAR_INVALID");
  return { output, evidence,
    set: sidecarSetSchema.parse({ lease: await pin(path.join(directory, newLease[0]!), 65_536),
      observation: await pin(path.join(directory, newObservation[0]!), 65_536), receipt: await pin(receiptPath, 65_536) }),
    names: new Set(names) };
}
async function publicationFromPinnedSet(bundlePath: string, bundle: ReturnType<typeof artifact.boundBundleBytes>,
  head: z.infer<typeof clutchpacksProductionPostHeadSchema>, set: z.infer<typeof sidecarSetSchema>) {
  const directory = path.dirname(bundlePath), pins = sidecarSetSchema.parse(set);
  for (const value of Object.values(pins)) {
    if (path.dirname(value.path) !== directory || !same(await pin(value.path, 65_536), value)) {
      refuse("POST_HEAD_SUCCESSOR_SIDECAR_INVALID");
    }
  }
  artifact.assertReceiptPath(artifact.parseVerifiedOutput({ status: "verified", receiptPath: pins.receipt.path,
    bundleSha256: bundle.bundleSha256, operationId: bundle.intent.operationId,
    publicReleaseId: bundle.intent.candidate.publicReleaseId, qualityState: bundle.intent.source.qualityState,
    quarantineCount: bundle.intent.source.quarantineCount }), bundlePath);
  const bytes = await artifact.readPrivate(pins.receipt.path, 65_536), receipt = artifact.parseReceiptBytes(bytes);
  const output = artifact.parseVerifiedOutput({ status: "verified", receiptPath: pins.receipt.path,
    bundleSha256: receipt.bundleSha256, operationId: receipt.operationId,
    publicReleaseId: receipt.candidate.publicReleaseId, qualityState: receipt.source.qualityState,
    quarantineCount: receipt.source.quarantineCount });
  const evidence = artifact.receiptEvidenceBytes(output, bundle, bundlePath, head, bytes);
  return { output, evidence, set: pins, names: new Set(Object.values(pins).map(value => path.basename(value.path))) };
}
async function readRuntimeTree(root: string, allowedTargetRoot: string,
  input: z.infer<typeof successorInputSchema>, deps: SuccessorDependencies) {
  let value: unknown;
  if (deps.readRuntimeInventory) value = await deps.readRuntimeInventory(root, allowedTargetRoot);
  else {
    const loaded: unknown = await import(pathToFileURL(input.executor.modules.runtimeInventory.path).href);
    const read = (loaded as { readClutchpacksProductionRuntimeInventory?: (a: string, b: string) => Promise<unknown> })
      .readClutchpacksProductionRuntimeInventory;
    if (typeof read !== "function") refuse("POST_HEAD_SUCCESSOR_RUNTIME_INVENTORY_INVALID");
    value = await read(root, allowedTargetRoot);
  }
  const parsed = runtimeInventorySchema.safeParse(value);
  if (!parsed.success || parsed.data.root !== root || parsed.data.allowedTargetRoot !== allowedTargetRoot ||
    parsed.data.entryCount !== parsed.data.fileCount + parsed.data.directoryCount + parsed.data.symlinkCount) {
    refuse("POST_HEAD_SUCCESSOR_RUNTIME_INVENTORY_INVALID");
  }
  return parsed.data;
}
async function readRuntimeInventory(input: z.infer<typeof successorInputSchema>, deps: SuccessorDependencies) {
  return readRuntimeTree(path.join(input.publisher.worktree, "node_modules"), input.publisher.worktree, input, deps);
}
async function readIncidentManifest(input: z.infer<typeof successorInputSchema>, policy: SuccessorPolicy) {
  const parsed = incidentManifestSchema.safeParse(artifact.parseJsonBytes(await pinned(input.incidentManifest, 8 * 1024 * 1024)));
  if (!parsed.success) refuse("POST_HEAD_SUCCESSOR_MANIFEST_INVALID");
  const manifest = parsed.data as unknown as IncidentManifest, { manifestSha256, ...core } = manifest;
  const paths = [manifest.ledgerPath, manifest.old.artifactDirectory,
    ...manifest.roots.flatMap(root => [root.artifactDirectory, root.proofDirectory])];
  if (artifact.digest(core) !== manifestSha256 || manifest.ledgerSchemaSha256 !== ledgerSchemaSha256 ||
    manifest.incidentId !== input.head.runId || manifest.recordsPath !== path.join(manifest.ledgerPath, "records") ||
    input.incidentManifest.path !== path.join(manifest.ledgerPath, "incident-manifest.json") ||
    manifest.freshnessCutoff !== incident.freshnessCutoff || !same(manifest.head, input.head) ||
    !same(manifest.old, input.old) || !same(manifest.publisher, input.publisher) ||
    !same(manifest.executor, input.executor) ||
    manifest.roots[0].ordinal !== 1 || manifest.roots[1].ordinal !== 2 ||
    new Set(paths).size !== paths.length || paths.some((left, index) =>
      paths.some((right, other) => index !== other && sameOrInside(left, right)))) {
    refuse("POST_HEAD_SUCCESSOR_MANIFEST_INVALID");
  }
  if (policy.production && (manifest.ledgerPath !== productionRegistry.ledgerPath ||
    !same(manifest.roots, productionRegistry.roots))) refuse("POST_HEAD_SUCCESSOR_MANIFEST_INVALID");
  return manifest;
}
async function readExecutorPolicy(input: z.infer<typeof successorInputSchema>, manifest: IncidentManifest,
  policy: SuccessorPolicy) {
  const parsed = executorPolicySchema.safeParse(artifact.parseJsonBytes(await pinned(input.executorPolicy, 1_048_576)));
  if (!parsed.success) refuse("POST_HEAD_SUCCESSOR_EXECUTOR_POLICY_INVALID");
  const document = parsed.data, { policySha256, ...core } = document;
  const imported = policy.importedModulePath ?? input.executor.modules.recovery.path;
  if (artifact.digest(core) !== policySha256 || !same(document.executor, input.executor) ||
    !same(document.publisher, input.publisher) || !same(document.incidentManifest, input.incidentManifest) ||
    document.ledgerPath !== manifest.ledgerPath || !same(document.roots, manifest.roots) ||
    !same(document.sourceReader, manifest.sourceReader) || document.importedRecoveryModule.path !== imported ||
    !same(document.importedRecoveryModule, input.executor.modules.recovery)) {
    refuse("POST_HEAD_SUCCESSOR_EXECUTOR_POLICY_INVALID");
  }
  return { pin: input.executorPolicy, document };
}

function validateHistoricalTarget(input: z.infer<typeof successorInputSchema>,
  currentBundle: ReturnType<typeof artifact.boundBundleBytes>, values: {
    preflightBytes: Buffer; predecessorBundleBytes: Buffer; predecessorReceiptBytes: Buffer;
  }, production: boolean) {
  const preflight = authenticatedTargetPreflightSchema.parse(artifact.parseJsonBytes(values.preflightBytes));
  const active = currentBundle.intent.predecessor, previous = input.old.targetPrevious;
  const first = preflight.firstActiveState, second = preflight.secondActiveState;
  const activePointer = first.activeRelease && { publicReleaseId: first.activeRelease.publicReleaseId,
    releaseFingerprint: first.activeRelease.releaseFingerprint };
  const previousPointer = first.previousRelease && { publicReleaseId: first.previousRelease.publicReleaseId,
    releaseFingerprint: first.previousRelease.releaseFingerprint };
  if (preflight.completedAt < preflight.startedAt || !same(first, second) || first.generation !== active.generation ||
    !same(activePointer, { publicReleaseId: active.publicReleaseId, releaseFingerprint: active.releaseFingerprint }) ||
    !same(previousPointer, previous) || preflight.activeStatus.lifecycle !== "complete" ||
    !same(projectReleaseStatus(preflight.activeStatus), { publicReleaseId: active.publicReleaseId,
      releaseFingerprint: active.releaseFingerprint, lifecycle: "complete" }) ||
    preflight.previousStatus.lifecycle !== "complete" ||
    !same(projectReleaseStatus(preflight.previousStatus), previous && { ...previous, lifecycle: "complete" }) ||
    preflight.candidate.publicReleaseId !== currentBundle.intent.candidate.publicReleaseId || preflight.candidate.status !== null ||
    !same(preflight.authenticatedReads.statusPublicReleaseIds,
      [active.publicReleaseId, previous?.publicReleaseId, currentBundle.intent.candidate.publicReleaseId])) {
    refuse("POST_HEAD_SUCCESSOR_TARGET_HISTORY_INVALID");
  }
  const rawPredecessor = artifact.parseJsonBytes(values.predecessorBundleBytes) as Record<string, unknown>;
  const predecessorConfig = artifact.parseSourceConfig(rawPredecessor.sourceConfig);
  const rawIntent = (rawPredecessor.intent ?? {}) as Record<string, unknown>;
  const rawSource = (rawIntent.source ?? {}) as Record<string, unknown>;
  const predecessorHead = clutchpacksProductionPostHeadSchema.parse({ providerId: predecessorConfig.scope.providerId,
    configId: predecessorConfig.scope.configVersionId, configNumber: predecessorConfig.scope.configVersionNumber,
    runId: rawSource.runId, checkpointHash: rawSource.checkpointHash, generation: rawSource.stateGeneration,
    runtimeRowVersion: predecessorConfig.expected.runtimeRowVersion, headFinishedAt: rawSource.lastHeadReachedAt,
    authorityDigest: input.head.authorityDigest });
  const predecessorBundle = artifact.boundBundleBytes(values.predecessorBundleBytes, predecessorConfig, predecessorHead);
  const predecessorReceipt = artifact.parseReceiptBytes(values.predecessorReceiptBytes);
  const predecessorOutput = artifact.parseVerifiedOutput({ status: "verified",
    receiptPath: input.old.targetChain.predecessorReceipt.path, bundleSha256: predecessorBundle.bundleSha256,
    operationId: predecessorBundle.intent.operationId, publicReleaseId: predecessorBundle.intent.candidate.publicReleaseId,
    qualityState: predecessorBundle.intent.source.qualityState,
    quarantineCount: predecessorBundle.intent.source.quarantineCount });
  const predecessorEvidence = artifact.receiptEvidenceBytes(predecessorOutput, predecessorBundle,
    input.old.targetChain.predecessorBundle.path, predecessorHead, values.predecessorReceiptBytes);
  if (!same({ publicReleaseId: predecessorBundle.intent.candidate.publicReleaseId,
    releaseFingerprint: predecessorBundle.intent.candidate.releaseFingerprint },
  { publicReleaseId: active.publicReleaseId, releaseFingerprint: active.releaseFingerprint }) ||
    !same(predecessorBundle.intent.predecessor, previous && { generation: active.generation - 1, ...previous }) ||
    predecessorReceipt.candidate.publicReleaseId !== active.publicReleaseId || predecessorEvidence.generation !== active.generation ||
    predecessorEvidence.publicReleaseId !== active.publicReleaseId) {
    refuse("POST_HEAD_SUCCESSOR_TARGET_HISTORY_INVALID");
  }
  if (production && (!same(input.old.targetChain.authenticatedPreflight, incident.targetHistory.preflight) ||
    !same(input.old.targetChain.preflightScript, incident.targetHistory.script) ||
    !same(input.old.targetChain.preflightStderr, incident.targetHistory.stderr) ||
    !same(input.old.targetChain.predecessorBundle, incident.targetHistory.predecessorBundle) ||
    !same(input.old.targetChain.predecessorReceipt, incident.targetHistory.predecessorReceipt) ||
    preflight.publisher.worktree !== incident.oldWorktree || preflight.publisher.commit !== incident.oldCommit ||
    !same(preflight.publisher.runtimeModule, incident.targetHistory.runtimeModule) ||
    !same(preflight.publisher.publicationClient, incident.targetHistory.publicationClient))) {
    refuse("POST_HEAD_SUCCESSOR_TARGET_HISTORY_INVALID");
  }
  return { preflight, predecessorBundle, predecessorEvidence };
}

async function validateOld(input: z.infer<typeof successorInputSchema>, deps: SuccessorDependencies,
  policy: SuccessorPolicy, environment: NodeJS.ProcessEnv) {
  const old = input.old, run = path.join(old.artifactDirectory, input.head.runId);
  const pending = path.join(old.artifactDirectory, "pending"), attempt = path.dirname(old.failure.publishStarted.path);
  if (old.pendingHead.path !== path.join(pending, "head.json") || old.journal.path !== path.join(run, "head.json") ||
    old.sourceConfig.path !== path.join(run, "source-config.json") || old.bundle.path !== path.join(run, "bundle.json") ||
    old.failure.prepared.path !== path.join(run, "prepared.json") || path.dirname(old.failure.pendingBlocked.path) !== pending ||
    path.dirname(attempt) !== run || old.failure.prepareStarted.path !== path.join(attempt, "prepare.started.json") ||
    old.failure.prepareStdout.path !== path.join(attempt, "prepare.stdout") ||
    old.failure.prepareStderr.path !== path.join(attempt, "prepare.stderr") ||
    old.failure.prepareCompleted.path !== path.join(attempt, "prepare.completed.json") ||
    old.failure.publishStarted.path !== path.join(attempt, "publish.started.json") ||
    old.failure.publishStdout.path !== path.join(attempt, "publish.stdout") ||
    old.failure.publishStderr.path !== path.join(attempt, "publish.stderr")) {
    refuse("POST_HEAD_SUCCESSOR_OLD_PATH_INVALID");
  }
  await artifact.directory(old.artifactDirectory); await artifact.directory(run); await artifact.directory(pending);
  if (policy.production) {
    const expectedRun = [incident.oldAttemptDirectoryName, "bundle.json", "head.json", "prepared.json", "source-config.json"].sort();
    const expectedAttempt = ["prepare.completed.json", "prepare.started.json", "prepare.stderr", "prepare.stdout",
      "publish.started.json", "publish.stderr", "publish.stdout"].sort();
    const pendingNames = (await readdir(pending)).sort();
    if (path.basename(attempt) !== incident.oldAttemptDirectoryName || old.pendingHead.sha256 !== incident.pendingHeadSha256 ||
      old.failure.pendingBlocked.sha256 !== incident.blockedMarkerSha256 ||
      !same((await readdir(run)).sort(), expectedRun) || !same((await readdir(attempt)).sort(), expectedAttempt) ||
      pendingNames.length !== 2 || !pendingNames.includes("head.json") ||
      !pendingNames.includes(path.basename(old.failure.pendingBlocked.path))) {
      refuse("POST_HEAD_SUCCESSOR_OLD_FAILURE_CHANGED");
    }
  }
  const [journalBytes, configBytes, bundleBytes, pendingBytes] = await Promise.all([
    pinned(old.journal, 65_536), pinned(old.sourceConfig, 1_048_576), pinned(old.bundle), pinned(old.pendingHead, 65_536),
  ]);
  const [, , , , , , , , , preflightBytes, , predecessorBundleBytes, predecessorReceiptBytes] = await Promise.all([
    pinned(old.failure.pendingBlocked, 65_536), pinned(old.failure.prepared, 65_536),
    pinned(old.failure.prepareStarted, 65_536), pinned(old.failure.prepareStdout, 65_536),
    pinned(old.failure.prepareStderr, 65_536, 0), pinned(old.failure.prepareCompleted, 65_536),
    pinned(old.failure.publishStarted, 65_536), pinned(old.failure.publishStdout, 65_536, 0),
    pinned(old.failure.publishStderr, 65_536), pinned(old.targetChain.authenticatedPreflight, 1_048_576),
    pinned(old.targetChain.preflightScript, 1_048_576), pinned(old.targetChain.predecessorBundle),
    pinned(old.targetChain.predecessorReceipt, 65_536)]);
  await pinned(old.targetChain.preflightStderr, 65_536, 0);
  const journal = artifact.parseJournal(artifact.parseJsonBytes(journalBytes));
  const config = artifact.parseSourceConfig(artifact.parseJsonBytes(configBytes));
  const pendingHead = artifact.parsePendingHead(artifact.parseJsonBytes(pendingBytes));
  if (!same(journal.head, input.head) || !same(pendingHead, { head: input.head, publisherCommit: old.publisherCommit }) ||
    journal.publisherWorktree !== old.publisherWorktree || journal.publisherCommit !== old.publisherCommit ||
    journal.sourceConfigSha256 !== artifact.digest(config)) refuse("POST_HEAD_SUCCESSOR_OLD_JOURNAL_INVALID");
  const baseBytes = await pinned(journal.baseSourceConfig, 1_048_576);
  const options = checkoutOptions(old.publisherWorktree, old.publisherCommit, old.artifactDirectory, input.head,
    journal.baseSourceConfig);
  await artifact.verifyCheckout(options, environment, { git: deps.git });
  const context = artifact.postHeadContext(options, baseBytes);
  if (!same(context.journal, journal) || !same(context.config, config)) refuse("POST_HEAD_SUCCESSOR_OLD_JOURNAL_INVALID");
  const bundle = artifact.boundBundleBytes(bundleBytes, config, input.head);
  const targetHistory = validateHistoricalTarget(input, bundle,
    { preflightBytes, predecessorBundleBytes, predecessorReceiptBytes }, policy.production);
  if (policy.production && (old.artifactDirectory !== incident.oldRoot || old.publisherWorktree !== incident.oldWorktree ||
    old.publisherCommit !== incident.oldCommit || !same(input.head, incident.head) ||
    bundle.bundleSha256 !== incident.bundleSha256 || bundle.intent.operationId !== incident.operationId ||
    !same(bundle.intent.predecessor, incident.predecessor) || !same(bundle.intent.candidate, incident.candidate) ||
    !same(old.targetPrevious, incident.previous))) refuse("POST_HEAD_SUCCESSOR_INCIDENT_MISMATCH");
  return { journal, journalBytes, config, configBytes, bundle, bundleBytes, baseBytes,
    baseSourceConfig: journal.baseSourceConfig, targetHistory, inventory: await rootInventory(old.artifactDirectory, deps) };
}

async function awaitHandshake(child: ChildProcess, file: string, expected: {
  attemptDirectory: string; bundle: z.infer<typeof filePin>; policy: z.infer<typeof filePin>;
  executable: z.infer<typeof filePin>; loader: z.infer<typeof filePin>; shim: z.infer<typeof filePin>;
  cli: z.infer<typeof filePin>; inventory: z.infer<typeof runtimeInventorySchema>;
  executorInventory: z.infer<typeof runtimeInventorySchema>; sourceInventory: z.infer<typeof runtimeInventorySchema>;
  publisher: z.infer<typeof publisherIdentity>; executor: z.infer<typeof executorIdentity>;
  sourceIdentity: z.infer<typeof sourceReaderIdentitySchema>; notBefore: string;
}, signal: AbortSignal) {
  let closed = false; const onClose = () => { closed = true; }; child.once("close", onClose);
  try {
    for (;;) {
      if (await exists(file)) {
        const handshake = await pin(file, 1_048_576);
        const proof = childLockProofSchema.parse(artifact.parseJsonBytes(await pinned(handshake, 1_048_576)));
        const { lockSha256, ...core } = proof;
        if (artifact.digest(core) !== lockSha256 || proof.pid !== child.pid || proof.acquiredAt < expected.notBefore ||
          proof.attemptDirectory !== expected.attemptDirectory || !same(proof.bundle, expected.bundle) ||
          !same(proof.executorPolicy, expected.policy) || !same(proof.executable, expected.executable) ||
          !same(proof.loader, expected.loader) || !same(proof.shim, expected.shim) || !same(proof.cli, expected.cli) ||
          !same(proof.runtimeInventory, expected.inventory) ||
          !same(proof.executorRuntimeInventory, expected.executorInventory) ||
          !same(proof.sourceRuntimeInventory, expected.sourceInventory) ||
          proof.publisherCheckout.worktree !== expected.publisher.worktree ||
          proof.publisherCheckout.commit !== expected.publisher.commit || proof.executorCheckout.worktree !== expected.executor.worktree ||
          proof.executorCheckout.commit !== expected.executor.commit ||
          proof.sourceCheckout.worktree !== expected.sourceIdentity.worktree ||
          proof.sourceCheckout.commit !== expected.sourceIdentity.commit) refuse("POST_HEAD_SUCCESSOR_CHILD_IDENTITY_INVALID");
        return handshake;
      }
      if (closed || signal.aborted) refuse("POST_HEAD_SUCCESSOR_CHILD_READY_MISSING");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  } finally { child.removeListener("close", onClose); }
}

async function readBoundHandshake(handshake: z.infer<typeof filePin>, expected: {
  attemptDirectory: string; bundle: z.infer<typeof filePin>; policy: z.infer<typeof filePin>;
  executable: z.infer<typeof filePin>; loader: z.infer<typeof filePin>; shim: z.infer<typeof filePin>;
  cli: z.infer<typeof filePin>; inventory: z.infer<typeof runtimeInventorySchema>;
  executorInventory: z.infer<typeof runtimeInventorySchema>; sourceInventory: z.infer<typeof runtimeInventorySchema>;
  publisher: z.infer<typeof publisherIdentity>; executor: z.infer<typeof executorIdentity>;
  sourceIdentity: z.infer<typeof sourceReaderIdentitySchema>;
}) {
  const proof = childLockProofSchema.parse(artifact.parseJsonBytes(await pinned(handshake, 1_048_576)));
  const { lockSha256, ...core } = proof;
  if (artifact.digest(core) !== lockSha256 || proof.attemptDirectory !== expected.attemptDirectory ||
    !same(proof.bundle, expected.bundle) || !same(proof.executorPolicy, expected.policy) ||
    !same(proof.executable, expected.executable) || !same(proof.loader, expected.loader) ||
    !same(proof.shim, expected.shim) || !same(proof.cli, expected.cli) ||
    !same(proof.runtimeInventory, expected.inventory) ||
    !same(proof.executorRuntimeInventory, expected.executorInventory) ||
    !same(proof.sourceRuntimeInventory, expected.sourceInventory) ||
    proof.publisherCheckout.worktree !== expected.publisher.worktree ||
    proof.publisherCheckout.commit !== expected.publisher.commit ||
    proof.executorCheckout.worktree !== expected.executor.worktree ||
    proof.executorCheckout.commit !== expected.executor.commit ||
    proof.sourceCheckout.worktree !== expected.sourceIdentity.worktree ||
    proof.sourceCheckout.commit !== expected.sourceIdentity.commit) {
    refuse("POST_HEAD_SUCCESSOR_CHILD_IDENTITY_INVALID");
  }
  return proof;
}

async function installOrValidate(file: string, bytes: Buffer) {
  const expected = { path: file, sha256: artifact.hashBytes(bytes) };
  if (await exists(file)) {
    if (!same(await pin(file, Math.max(bytes.length, 1), 0), expected)) refuse("POST_HEAD_SUCCESSOR_ROOT_CHANGED");
  } else await artifact.writeBytesExclusive(file, bytes);
  return expected;
}

async function attemptDirectories(run: string, excluded: ReadonlySet<string>) {
  const result: string[] = [];
  for (const name of await readdir(run)) {
    const candidate = path.join(run, name);
    if (/^attempt-[a-f0-9-]{36}$/u.test(name) && !excluded.has(candidate) &&
      await exists(path.join(candidate, "publish.started.json"))) result.push(candidate);
  }
  return result.sort();
}

async function interruptedAdoptionEvidence(successor: SuccessorRoot, run: string, attempt: string,
  input: z.infer<typeof successorInputSchema>, firstSidecarNames: ReadonlySet<string>) {
  const pending = path.join(successor.artifactDirectory, "pending");
  await artifact.directory(pending);
  const pendingNames = (await readdir(pending)).sort(), blockedNames = pendingNames.filter(name =>
    /^blocked-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/u.test(name));
  if (!same(pendingNames, [blockedNames[0], "head.json"].filter(Boolean).sort()) || blockedNames.length !== 1) {
    refuse("POST_HEAD_SUCCESSOR_ADOPTION_INTERRUPTION_INVALID");
  }
  const pendingHeadPath = path.join(pending, "head.json"), pendingBlockedPath = path.join(pending, blockedNames[0]!);
  const pendingHead = artifact.parsePendingHead(artifact.parseJsonBytes(await artifact.readPrivate(pendingHeadPath, 65_536)));
  const pendingBlocked = z.object({ status: z.literal("blocked"),
    code: z.literal("POST_HEAD_CHILD_FAILED") }).strict().parse(
    artifact.parseJsonBytes(await artifact.readPrivate(pendingBlockedPath, 65_536)));
  if (!same(pendingHead, { head: input.head, publisherCommit: input.publisher.commit }) ||
    pendingBlocked.code !== "POST_HEAD_CHILD_FAILED") refuse("POST_HEAD_SUCCESSOR_ADOPTION_INTERRUPTION_INVALID");
  await artifact.directory(attempt);
  const attemptNames = (await readdir(attempt)).sort();
  const mandatory = ["publish.lock-acquired.json", "publish.started.json", "publish.stderr", "publish.stdout"];
  const allowed = [...mandatory, "publish.continue.json"];
  if (mandatory.some(name => !attemptNames.includes(name)) || attemptNames.some(name => !allowed.includes(name)) ||
    attemptNames.includes("publish.completed.json") || attemptNames.includes("verified.json")) {
    refuse("POST_HEAD_SUCCESSOR_ADOPTION_INTERRUPTION_INVALID");
  }
  const sidecarNames = (await readdir(run)).filter(name => name.startsWith("bundle.json.")).sort();
  if (!same(sidecarNames, [...firstSidecarNames].sort()) ||
    (await readdir(successor.proofDirectory)).length !== 0) refuse("POST_HEAD_SUCCESSOR_ADOPTION_INTERRUPTION_INVALID");
  const attemptFiles = await Promise.all(attemptNames.map(name => pin(path.join(attempt, name), 1_048_576,
    name === "publish.stdout" || name === "publish.stderr" ? 0 : 1)));
  return interruptedAdoptionSchema.parse({ pendingHead: await pin(pendingHeadPath, 65_536),
    pendingBlocked: await pin(pendingBlockedPath, 65_536), attemptDirectory: attempt,
    attemptFiles, sidecarNames });
}

async function recoverCompletedAdoption(successor: SuccessorRoot, run: string, attempt: string,
  input: z.infer<typeof successorInputSchema>, bundlePath: string,
  bundle: ReturnType<typeof artifact.boundBundleBytes>, firstEvidence: unknown,
  firstSidecarNames: ReadonlySet<string>) {
  const completedPath = path.join(attempt, "publish.completed.json"), verifiedPath = path.join(attempt, "verified.json");
  const completedExists = await exists(completedPath), verifiedExists = await exists(verifiedPath);
  if (!completedExists && !verifiedExists) return null;
  if (!completedExists) refuse("POST_HEAD_SUCCESSOR_ADOPTION_INTERRUPTION_INVALID");
  const completed = z.object({ phase: z.literal("publish") }).strict().parse(
    artifact.parseJsonBytes(await artifact.readPrivate(completedPath, 65_536)));
  if (completed.phase !== "publish") refuse("POST_HEAD_SUCCESSOR_ADOPTION_INTERRUPTION_INVALID");
  const output = artifact.parseVerifiedOutput(artifact.parseJsonBytes(
    await artifact.readPrivate(path.join(attempt, "publish.stdout"), 65_536)));
  artifact.assertReceiptPath(output, bundlePath);
  const publication = await publicationSidecars(bundlePath, bundle, input.head, 2, firstSidecarNames, output);
  const verifiedBytes = jsonBytes(publication.evidence);
  await installOrValidate(verifiedPath, verifiedBytes);
  if (!same(await pin(path.join(run, "verified.json"), 65_536),
    { path: path.join(run, "verified.json"), sha256: artifact.hashBytes(jsonBytes(firstEvidence)) })) {
    refuse("POST_HEAD_SUCCESSOR_ADOPTION_INTERRUPTION_INVALID");
  }
  const pending = path.join(successor.artifactDirectory, "pending");
  await artifact.directory(pending);
  const names = (await readdir(pending)).sort();
  const blocked = names.filter(name => /^blocked-[a-f0-9-]{36}\.json$/u.test(name));
  if (blocked.length > 1 || names.some(name => name !== "head.json" && !blocked.includes(name)) ||
    (!names.includes("head.json") && blocked.length !== 0)) {
    refuse("POST_HEAD_SUCCESSOR_ADOPTION_INTERRUPTION_INVALID");
  }
  if (names.includes("head.json")) {
    const pendingHead = artifact.parsePendingHead(artifact.parseJsonBytes(
      await artifact.readPrivate(path.join(pending, "head.json"), 65_536)));
    if (!same(pendingHead, { head: input.head, publisherCommit: input.publisher.commit })) {
      refuse("POST_HEAD_SUCCESSOR_ADOPTION_INTERRUPTION_INVALID");
    }
  }
  if (blocked[0]) {
    z.object({ status: z.literal("blocked"),
      code: z.enum(["POST_HEAD_FAILED", "POST_HEAD_CHILD_FAILED", "POST_HEAD_ABORTED"]) }).strict().parse(
      artifact.parseJsonBytes(await artifact.readPrivate(path.join(pending, blocked[0]), 65_536)));
    await unlink(path.join(pending, blocked[0])); await artifact.syncDirectory(pending);
  }
  if (await exists(path.join(pending, "head.json"))) {
    await unlink(path.join(pending, "head.json")); await artifact.syncDirectory(pending);
  }
  await rmdir(pending); await artifact.syncDirectory(successor.artifactDirectory);
  return publication;
}

async function successorCore(raw: ClutchpacksProductionPostHeadSuccessorInput,
  deps: SuccessorDependencies, policy: SuccessorPolicy) {
  let releaseResidency: (() => void | Promise<void>) | undefined;
  let releaseExecution: (() => void | Promise<void>) | undefined;
  try {
    const now = deps.now ?? (() => new Date().toISOString());
    const input = successorInputSchema.parse(raw), environment = policy.environment ?? safeEnvironment(process.env);
    if (!deps.acquireResidencyExclusion || !deps.acquireExecutionExclusion) {
      if (policy.production) refuse("POST_HEAD_SUCCESSOR_EXCLUSION_MISSING");
    }
    const fallbackResidency = { label: "com.packscout.provider-import.clutchpacks" as const, port: 56_432 as const,
      launchdUnloaded: true as const, residentProcessCount: 0 as const, portBound: true as const,
      acquiredAt: now(), checkedAt: now() };
    const residencyHandle = deps.acquireResidencyExclusion ? await deps.acquireResidencyExclusion() : {
      proof: fallbackResidency, refreshProof: async () => fallbackResidency, release: () => undefined };
    const residency = residencyProofSchema.parse(residencyHandle.proof); releaseResidency = residencyHandle.release;
    const executionHandle = deps.acquireExecutionExclusion ? await deps.acquireExecutionExclusion() : {
      proof: { port: 47_432 as const, portBound: true as const, acquiredAt: now() },
      refreshProof: async () => ({ port: 47_432 as const, portBound: true as const, acquiredAt: now() }),
      relinquishForChild: () => undefined, reacquireAfterChild: () => undefined, release: () => undefined };
    executionLockProofSchema.parse(executionHandle.proof); releaseExecution = executionHandle.release;
    const manifest = await readIncidentManifest(input, policy);
    const executorPolicy = await readExecutorPolicy(input, manifest, policy);
    const ledgerRecords = await readLedgerRecords(manifest), ledgerState = reduceLedger(manifest, ledgerRecords);
    const successor = ledgerState.status === "empty" ? manifest.roots[0] :
      ledgerState.status === "retry_authorized" ? manifest.roots[1] : manifest.roots[ledgerState.ordinal - 1];
    if (!successor) refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
    const freshRoot = ledgerState.status === "empty" || ledgerState.status === "retry_authorized";
    const old = await validateOld(input, deps, policy, environment);
    if (old.inventory.inventorySha256 !== manifest.oldRootInventorySha256) {
      refuse("POST_HEAD_SUCCESSOR_OLD_ROOT_CHANGED");
    }
    const retryRecords = ledgerRecords.filter(record => record.event === "retry_authorized");
    if (retryRecords.length > 1 || (ledgerState.ordinal === 2 && retryRecords.length !== 1)) {
      refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
    }
    const retryEvidence = retryRecords[0] ? ledgerRetryPayloadSchema.parse(retryRecords[0].payload) : null;
    const verifyAbandonedRoot = async () => {
      if (!retryEvidence) return;
      const abandoned = manifest.roots[0];
      if (retryEvidence.reason === "claim_interrupted") {
        if (retryEvidence.abandonedArtifactRoot.path !== abandoned.artifactDirectory ||
          retryEvidence.abandonedProofRoot.path !== abandoned.proofDirectory) {
          refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
        }
        await verifyAbandonedRootState(retryEvidence.abandonedArtifactRoot, deps);
        await verifyAbandonedRootState(retryEvidence.abandonedProofRoot, deps);
      } else if (!same(await rootInventory(abandoned.artifactDirectory, deps), retryEvidence.abandonedArtifactInventory) ||
        !same(await rootInventory(abandoned.proofDirectory, deps), retryEvidence.abandonedProofInventory)) {
        refuse("POST_HEAD_SUCCESSOR_ABANDONED_ROOT_CHANGED");
      }
    };
    await verifyAbandonedRoot();
    const publisherOptions = checkoutOptions(input.publisher.worktree, input.publisher.commit,
      successor.artifactDirectory, input.head, old.baseSourceConfig);
    const executorOptions = checkoutOptions(input.executor.worktree, input.executor.commit,
      successor.proofDirectory, input.head, old.baseSourceConfig);
    await artifact.verifyCheckout(publisherOptions, environment, { git: deps.git }, Object.values(moduleRelativePaths));
    await verifyModuleMap(input.publisher.worktree, input.publisher.modules, moduleRelativePaths);
    await artifact.verifyCheckout(executorOptions, environment, { git: deps.git }, Object.values(executorRelativePaths));
    await verifyModuleMap(input.executor.worktree, input.executor.modules, executorRelativePaths);
    const inventory = await readRuntimeInventory(input, deps);
    const executorInventory = await readRuntimeTree(path.join(input.executor.worktree, "node_modules"),
      input.executor.worktree, input, deps);
    const sourceInventory = await readRuntimeTree(path.join(executorPolicy.document.sourceReader.worktree, "node_modules"),
      executorPolicy.document.sourceReader.worktree, input, deps);
    if (!same(inventory, executorPolicy.document.runtimeInventory) ||
      !same(executorInventory, executorPolicy.document.executorRuntimeInventory) ||
      !same(sourceInventory, executorPolicy.document.sourceReader.runtimeInventory) ||
      !same(environment, executorPolicy.document.environment)) {
      refuse("POST_HEAD_SUCCESSOR_RUNTIME_CHANGED");
    }
    const executable = await pinTrustedRegular(process.execPath), loader = await pinTrustedRegular(
      executorPolicy.document.loader.path, 8 * 1024 * 1024);
    const shim = await pinTrustedRegular(input.executor.modules.publishShim.path, 1_048_576);
    if (!same(executable, executorPolicy.document.executable) || !same(loader, executorPolicy.document.loader) ||
      !same(shim, input.executor.modules.publishShim)) refuse("POST_HEAD_SUCCESSOR_RUNTIME_CHANGED");
    const sourceIdentity = executorPolicy.document.sourceReader;
    if (!same(await pinTrustedRegular(sourceIdentity.executable.path), sourceIdentity.executable) ||
      !same(await pinTrustedRegular(sourceIdentity.loader.path, 8 * 1024 * 1024), sourceIdentity.loader) ||
      !same(await pinTrustedRegular(sourceIdentity.script.path, 8 * 1024 * 1024), sourceIdentity.script) ||
      !same(await pin(sourceIdentity.policy.path, 65_536), sourceIdentity.policy)) {
      refuse("POST_HEAD_SUCCESSOR_SOURCE_READER_CHANGED");
    }
    if (policy.production && (sourceIdentity.worktree !== sourceReader.worktree || sourceIdentity.commit !== sourceReader.commit ||
      !same(sourceIdentity.script, { path: sourceReader.script, sha256: sourceReader.scriptSha256 }) ||
      !same(sourceIdentity.policy, { path: sourceReader.policy, sha256: sourceReader.policySha256 }) ||
      !same(sourceIdentity.loader, { path: sourceReader.loader, sha256: sourceReader.loaderSha256 }) ||
      !same(sourceIdentity.executable, { path: sourceReader.executable, sha256: sourceReader.executableSha256 }))) {
      refuse("POST_HEAD_SUCCESSOR_SOURCE_READER_CHANGED");
    }
    if (ledgerState.status === "terminal") refuse("POST_HEAD_SUCCESSOR_LEDGER_TERMINAL");
    if (ledgerState.status !== "complete" && ledgerState.status !== "terminal") {
      try {
        const entryTarget = await readTarget(deps, environment, now, input.publisher,
          executorPolicy.document.runtimeInventory);
        targetDisposition(entryTarget, old.bundle, input.old.targetPrevious);
      } catch (error) {
        if (!freshRoot) {
          await appendLedgerRecord(manifest, ledgerState.status, "terminal", successor.ordinal,
            { reason: "target_rollback_or_divergence", evidenceSha256: null }, now);
        }
        throw error;
      }
      try { await readSource(deps, environment, now, input.head, executorPolicy.document.sourceReader); }
      catch (error) {
        if (!freshRoot) {
          await appendLedgerRecord(manifest, ledgerState.status, "terminal", successor.ordinal,
            { reason: "source_stale_or_moved", evidenceSha256: null }, now);
        }
        throw error;
      }
    }
    const run = path.join(successor.artifactDirectory, input.head.runId);
    const bundlePath = path.join(run, "bundle.json"), preparedPath = path.join(run, "prepared.json");
    const successorContext = artifact.postHeadContext(publisherOptions, old.baseBytes);
    if (!same(successorContext.journal, old.journal) || !same(successorContext.config, old.config)) {
      refuse("POST_HEAD_SUCCESSOR_JOURNAL_CHANGED");
    }
    const oldPrepared = artifact.parseJsonBytes(await pinned(input.old.failure.prepared, 65_536)) as Record<string, unknown>;
    const preparedBytes = jsonBytes({ ...oldPrepared, bundlePath });
    if (ledgerState.status === "attempt_claimed") {
      const heldExecutionLock = executionLockProofSchema.parse(await executionHandle.refreshProof());
      if (!deps.inspectUnboundChildAbsence) refuse("POST_HEAD_SUCCESSOR_CHILD_OBSERVABILITY_UNKNOWN");
      const termination = unboundChildAbsenceProofSchema.parse(
        await deps.inspectUnboundChildAbsence(successor, bundlePath, heldExecutionLock));
      const { proofSha256, ...terminationCore } = termination;
      if (!same(termination.executionLock, heldExecutionLock) || artifact.digest(terminationCore) !== proofSha256) {
        refuse("POST_HEAD_SUCCESSOR_CHILD_OBSERVABILITY_UNKNOWN");
      }
      if (successor.ordinal === 2) {
        await appendLedgerRecord(manifest, "attempt_claimed", "terminal", successor.ordinal,
          { reason: "claim_retry_exhausted", evidenceSha256: artifact.digest(termination) }, now);
        return refuse("POST_HEAD_SUCCESSOR_LEDGER_TERMINAL");
      }
      const [source, quiet, target, residencyValue, abandonedArtifactRoot, abandonedProofRoot] = await Promise.all([
        readSource(deps, environment, now, input.head, sourceIdentity),
        readRecoveryQuiet(deps, environment, now, input.head, sourceIdentity, input.old.sourceConfig,
          input.publisher, executorPolicy.document.runtimeInventory),
        readTarget(deps, environment, now, input.publisher, executorPolicy.document.runtimeInventory),
        residencyHandle.refreshProof(),
        abandonedRootState(successor.artifactDirectory, deps, now),
        abandonedRootState(successor.proofDirectory, deps, now),
      ]);
      targetDisposition(target, old.bundle, input.old.targetPrevious);
      const residencyValueParsed = residencyProofSchema.parse(residencyValue);
      await appendLedgerRecord(manifest, "attempt_claimed", "retry_authorized", successor.ordinal,
        { reason: "claim_interrupted", termination, source, quiet, target, residency: residencyValueParsed,
          abandonedArtifactRoot, abandonedProofRoot }, now);
      return refuse("POST_HEAD_SUCCESSOR_RETRY_AUTHORIZED");
    }
    if (freshRoot) {
      if (await exists(successor.artifactDirectory) || await exists(successor.proofDirectory)) {
        refuse("POST_HEAD_SUCCESSOR_ROOT_EXISTS");
      }
      await appendLedgerRecord(manifest, ledgerState.status, "attempt_claimed", successor.ordinal,
        { artifactRootAbsent: true, proofRootAbsent: true }, now);
      await deps.afterAttemptClaimed?.();
      await artifact.directory(path.dirname(successor.artifactDirectory));
      await artifact.directory(path.dirname(successor.proofDirectory));
      await mkdir(successor.artifactDirectory, { mode: 0o700 });
      await artifact.syncDirectory(path.dirname(successor.artifactDirectory));
      await deps.afterArtifactRootCreated?.();
      await mkdir(successor.proofDirectory, { mode: 0o700 });
      await artifact.syncDirectory(path.dirname(successor.proofDirectory));
      await mkdir(run, { mode: 0o700 }); await artifact.syncDirectory(successor.artifactDirectory);
      await artifact.writeBytesExclusive(path.join(run, "head.json"), old.journalBytes);
      await artifact.writeBytesExclusive(path.join(run, "source-config.json"), old.configBytes);
      await artifact.writeBytesExclusive(bundlePath, old.bundleBytes);
      await artifact.writeBytesExclusive(preparedPath, preparedBytes);
      await deps.afterSuccessorCreated?.();
    } else {
      await artifact.directory(successor.artifactDirectory); await artifact.directory(successor.proofDirectory);
      await artifact.directory(run);
      const expected = [[path.join(run, "head.json"), old.journalBytes],
        [path.join(run, "source-config.json"), old.configBytes], [bundlePath, old.bundleBytes],
        [preparedPath, preparedBytes]] as const;
      for (const [file, bytes] of expected) if (!same(await pin(file),
        { path: file, sha256: artifact.hashBytes(bytes) })) refuse("POST_HEAD_SUCCESSOR_ROOT_CHANGED");
    }
    const [oldBundleStat, successorBundleStat] = await Promise.all([
      lstat(input.old.bundle.path, { bigint: true }), lstat(bundlePath, { bigint: true })]);
    if (oldBundleStat.dev === successorBundleStat.dev && oldBundleStat.ino === successorBundleStat.ino) {
      refuse("POST_HEAD_SUCCESSOR_COPY_ALIASED");
    }
    if (!same(await rootInventory(input.old.artifactDirectory, deps), old.inventory)) {
      refuse("POST_HEAD_SUCCESSOR_OLD_ROOT_CHANGED");
    }

    const gateChild = async (child: ChildProcess, attempt: string, phase: "initial" | "reentry",
      notBefore: string, signal: AbortSignal) => {
      const bundle = await pin(bundlePath), handshakePath = path.join(attempt, "publish.lock-acquired.json");
      const handshake = await awaitHandshake(child, handshakePath, { attemptDirectory: attempt, bundle,
        policy: executorPolicy.pin, executable, loader, shim, cli: input.publisher.modules.promoteCli,
        inventory, executorInventory, sourceInventory,
        publisher: input.publisher, executor: input.executor, sourceIdentity, notBefore }, signal);
      await deps.afterChildHandshake?.();
      if (!same(await rootInventory(input.old.artifactDirectory, deps), old.inventory)) {
        refuse("POST_HEAD_SUCCESSOR_OLD_ROOT_CHANGED");
      }
      const [sourcePreDispatch, targetPreDispatch, residencyValue] = await Promise.all([
        readSource(deps, environment, now, input.head, executorPolicy.document.sourceReader),
        readTarget(deps, environment, now, input.publisher, executorPolicy.document.runtimeInventory),
        residencyHandle.refreshProof(),
      ]);
      targetDisposition(targetPreDispatch, old.bundle, input.old.targetPrevious);
      const residencyPreDispatch = residencyProofSchema.parse(residencyValue);
      if (residencyPreDispatch.acquiredAt !== residency.acquiredAt || residencyPreDispatch.checkedAt < residency.checkedAt) {
        refuse("POST_HEAD_SUCCESSOR_RESIDENCY_CHANGED");
      }
      const ledgerDispatch = await appendLedgerRecord(manifest,
        phase === "initial" ? "attempt_claimed" : "direct_verified",
        phase === "initial" ? "direct_dispatched" : "adoption_dispatched", successor.ordinal,
        { phase: phase === "initial" ? "direct" : "adoption", attemptDirectory: attempt, handshake,
          sourcePreDispatch, targetPreDispatch, residencyPreDispatch }, now);
      await deps.afterLedgerDispatch?.(phase);
      const tokenCore = { schemaVersion: "clutchpacks_production_post_head_recovery_continue_v1" as const,
        createdAt: now(), attemptDirectory: attempt, bundle, handshake, executorPolicy: executorPolicy.pin,
        sourcePreDispatch, targetPreDispatch, residencyPreDispatch, ledgerRecord: ledgerDispatch.pin };
      const token = continueTokenSchema.parse({ ...tokenCore, tokenSha256: artifact.digest(tokenCore) });
      await artifact.writeBytesExclusive(path.join(attempt, "publish.continue.json"), jsonBytes(token));
      await deps.afterChildReady?.(phase);
    };
    const direct = artifact.commandInvocation(publisherOptions, ["--publish", bundlePath]);
    const launch = deps.spawn ?? ((file: string, args: readonly string[], options: {
      cwd: string; env: NodeJS.ProcessEnv; detached: boolean; stdio: ["ignore", "pipe", "pipe"];
    }) => spawnChild(file, [...args], options));
    const shimArguments = (attempt: string) => [shim.path, "--publish", bundlePath, "--policy", executorPolicy.pin.path,
      "--policy-sha256", executorPolicy.pin.sha256, "--handshake", path.join(attempt, "publish.lock-acquired.json"),
      "--continue", path.join(attempt, "publish.continue.json")];

    const noSidecars = new Set<string>();
    if (ledgerState.status === "terminal") {
      refuse("POST_HEAD_SUCCESSOR_LEDGER_TERMINAL");
    }
    if (ledgerState.status === "complete") {
      const payload = ledgerCompletePayloadSchema.parse(ledgerState.tail?.payload);
      const receipt = successorReceiptSchema.parse(artifact.parseJsonBytes(await pinned(payload.successorReceipt, 1_048_576)));
      if (receipt.receiptSha256 !== artifact.digest(Object.fromEntries(Object.entries(receipt)
        .filter(([key]) => key !== "receiptSha256"))) || receipt.successorArtifactDirectory !== successor.artifactDirectory ||
        receipt.successorRunDirectory !== run || !same(receipt.oldRootInventory, old.inventory) ||
        !same(receipt.finalOldRootInventory, old.inventory) || !same(payload.bundle, await pin(bundlePath))) {
        refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
      }
      return { status: "verified" as const, artifactDirectory: successor.artifactDirectory, runDirectory: run,
        bundleSha256: old.bundle.bundleSha256, evidence: receipt.firstEvidence,
        reentryEvidence: receipt.reentryEvidence, receipt: payload.successorReceipt };
    }

    let firstAttempt: string;
    let firstPublication: Awaited<ReturnType<typeof publicationSidecars>>;
    let firstEvidence: unknown;
    let firstTarget: z.infer<typeof targetProofSchema>;
    if (freshRoot) {
      firstAttempt = path.join(run, `attempt-${randomUUID()}`);
      await mkdir(firstAttempt, { mode: 0o700 }); await artifact.syncDirectory(run);
      const firstNotBefore = now(), controller = new AbortController(), abort = () => controller.abort();
      deps.signal?.addEventListener("abort", abort, { once: true }); if (deps.signal?.aborted) controller.abort();
      const cancel = (deps.startDeadline ?? ((callback, milliseconds) => {
        const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer);
      }))(() => controller.abort(), input.deadlineMs);
      let firstOutput: ReturnType<typeof artifact.parseVerifiedOutput>;
      try {
        await executionHandle.relinquishForChild();
        firstOutput = artifact.parseVerifiedOutput(await artifact.command(["--publish", bundlePath], publisherOptions,
          firstAttempt, "publish", environment, controller.signal, { git: deps.git, kill: deps.kill,
            spawn: (file, args, options) => {
              if (file !== direct.file || !same(args, direct.args)) refuse("POST_HEAD_SUCCESSOR_INVOCATION_CHANGED");
              return launch(file, shimArguments(firstAttempt), options);
            }, afterSpawn: child => gateChild(child, firstAttempt, "initial", firstNotBefore, controller.signal) }));
      } finally {
        await executionHandle.reacquireAfterChild(); cancel(); deps.signal?.removeEventListener("abort", abort);
      }
      artifact.assertReceiptPath(firstOutput, bundlePath);
      firstPublication = await publicationSidecars(bundlePath, old.bundle, input.head, 1, noSidecars, firstOutput);
      firstEvidence = firstPublication.evidence;
      firstTarget = await readTarget(deps, environment, now, input.publisher,
        executorPolicy.document.runtimeInventory);
      if (targetDisposition(firstTarget, old.bundle, input.old.targetPrevious) !== "candidate") {
        refuse("POST_HEAD_SUCCESSOR_TARGET_CHANGED");
      }
      if (!same(await rootInventory(input.old.artifactDirectory, deps), old.inventory)) {
        refuse("POST_HEAD_SUCCESSOR_OLD_ROOT_CHANGED");
      }
      const attemptVerifiedPath = path.join(firstAttempt, "verified.json"), runVerifiedPath = path.join(run, "verified.json");
      const verifiedBytes = jsonBytes(firstEvidence), expectedVerifiedSha = artifact.hashBytes(verifiedBytes);
      await appendLedgerRecord(manifest, "direct_dispatched", "direct_verified", successor.ordinal,
        { attemptDirectory: firstAttempt, bundle: await pin(bundlePath), evidenceSha256: artifact.digest(firstEvidence),
          sidecars: firstPublication.set, target: firstTarget,
          attemptVerified: { path: attemptVerifiedPath, sha256: expectedVerifiedSha },
          runVerified: { path: runVerifiedPath, sha256: expectedVerifiedSha } }, now);
      await installOrValidate(attemptVerifiedPath, verifiedBytes); await installOrValidate(runVerifiedPath, verifiedBytes);
      await deps.afterFirstPublish?.();
    } else if (ledgerState.status === "direct_dispatched") {
      const dispatch = ledgerDispatchPayloadSchema.parse(ledgerState.tail?.payload);
      firstAttempt = dispatch.attemptDirectory;
      if (path.dirname(firstAttempt) !== run || !/^attempt-[a-f0-9-]{36}$/u.test(path.basename(firstAttempt))) {
        refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
      }
      const handshake = await readBoundHandshake(dispatch.handshake, { attemptDirectory: firstAttempt,
        bundle: await pin(bundlePath), policy: executorPolicy.pin, executable, loader, shim,
        cli: input.publisher.modules.promoteCli, inventory, executorInventory, sourceInventory,
        publisher: input.publisher, executor: input.executor, sourceIdentity });
      if (!deps.inspectChildTermination) refuse("POST_HEAD_SUCCESSOR_CHILD_OBSERVABILITY_UNKNOWN");
      const heldExecutionLock = executionLockProofSchema.parse(await executionHandle.refreshProof());
      const termination = childTerminationProofSchema.parse(
        await deps.inspectChildTermination(handshake, heldExecutionLock));
      if (termination.pid !== handshake.pid || termination.processGroupId !== handshake.pid ||
        termination.checkedAt < handshake.acquiredAt || !same(termination.executionLock, heldExecutionLock)) {
        refuse("POST_HEAD_SUCCESSOR_CHILD_OBSERVABILITY_UNKNOWN");
      }
      const sidecarNames = (await readdir(run)).filter(name => name.startsWith("bundle.json."));
      firstTarget = await readTarget(deps, environment, now, input.publisher,
        executorPolicy.document.runtimeInventory);
      const disposition = targetDisposition(firstTarget, old.bundle, input.old.targetPrevious);
      if (sidecarNames.length === 0) {
        if (successor.ordinal === 2) {
          await appendLedgerRecord(manifest, "direct_dispatched", "terminal", successor.ordinal,
            { reason: "direct_retry_exhausted", evidenceSha256: artifact.digest({ termination, firstTarget }) }, now);
          return refuse("POST_HEAD_SUCCESSOR_LEDGER_TERMINAL");
        }
        const source = await readSource(deps, environment, now, input.head, sourceIdentity);
        const quiet = await readRecoveryQuiet(deps, environment, now, input.head, sourceIdentity, input.old.sourceConfig,
          input.publisher, executorPolicy.document.runtimeInventory);
        const residencyValue = residencyProofSchema.parse(await residencyHandle.refreshProof());
        const [abandonedArtifactInventory, abandonedProofInventory] = await Promise.all([
          rootInventory(successor.artifactDirectory, deps), rootInventory(successor.proofDirectory, deps),
        ]);
        await appendLedgerRecord(manifest, "direct_dispatched", "retry_authorized", successor.ordinal,
          { reason: "no_durable_receipt", termination, source, quiet, target: firstTarget,
            residency: residencyValue, abandonedArtifactInventory, abandonedProofInventory,
            interruptedAdoption: null }, now);
        return refuse("POST_HEAD_SUCCESSOR_RETRY_AUTHORIZED");
      }
      try { firstPublication = await publicationSidecars(bundlePath, old.bundle, input.head, 1, noSidecars); }
      catch {
        await appendLedgerRecord(manifest, "direct_dispatched", "terminal", successor.ordinal,
          { reason: "evidence_invalid", evidenceSha256: artifact.digest(sidecarNames.sort()) }, now);
        return refuse("POST_HEAD_SUCCESSOR_LEDGER_TERMINAL");
      }
      if (disposition !== "candidate") refuse("POST_HEAD_SUCCESSOR_TARGET_CHANGED");
      firstEvidence = firstPublication.evidence;
      const attemptVerifiedPath = path.join(firstAttempt, "verified.json"), runVerifiedPath = path.join(run, "verified.json");
      const verifiedBytes = jsonBytes(firstEvidence), expectedVerifiedSha = artifact.hashBytes(verifiedBytes);
      await appendLedgerRecord(manifest, "direct_dispatched", "direct_verified", successor.ordinal,
        { attemptDirectory: firstAttempt, bundle: await pin(bundlePath), evidenceSha256: artifact.digest(firstEvidence),
          sidecars: firstPublication.set, target: firstTarget,
          attemptVerified: { path: attemptVerifiedPath, sha256: expectedVerifiedSha },
          runVerified: { path: runVerifiedPath, sha256: expectedVerifiedSha } }, now);
      await installOrValidate(attemptVerifiedPath, verifiedBytes); await installOrValidate(runVerifiedPath, verifiedBytes);
    } else {
      const verifiedRecord = [...ledgerRecords].reverse().find(record => record.event === "direct_verified");
      if (!verifiedRecord) refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
      const verified = ledgerDirectVerifiedPayloadSchema.parse(verifiedRecord.payload);
      firstAttempt = verified.attemptDirectory;
      firstPublication = ledgerState.status === "direct_verified" ?
        await publicationSidecars(bundlePath, old.bundle, input.head, 1, noSidecars) :
        await publicationFromPinnedSet(bundlePath, old.bundle, input.head, verified.sidecars);
      firstEvidence = firstPublication.evidence;
      firstTarget = await readTarget(deps, environment, now, input.publisher,
        executorPolicy.document.runtimeInventory);
      if (verified.evidenceSha256 !== artifact.digest(firstEvidence) || !same(verified.sidecars, firstPublication.set) ||
        targetDisposition(firstTarget, old.bundle, input.old.targetPrevious) !== "candidate" ||
        !same(verified.bundle, await pin(bundlePath))) refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
      const bytes = jsonBytes(firstEvidence);
      if (!same(verified.attemptVerified, { path: path.join(firstAttempt, "verified.json"),
        sha256: artifact.hashBytes(bytes) }) || !same(verified.runVerified,
        { path: path.join(run, "verified.json"), sha256: artifact.hashBytes(bytes) })) {
        refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
      }
      await installOrValidate(verified.attemptVerified.path, bytes); await installOrValidate(verified.runVerified.path, bytes);
    }

    let reentryAttempt: string | undefined, reentryEvidence: unknown;
    if (ledgerState.status === "adoption_dispatched") {
      const dispatch = ledgerDispatchPayloadSchema.parse(ledgerState.tail?.payload);
      reentryAttempt = dispatch.attemptDirectory;
      if (path.dirname(reentryAttempt) !== run || firstAttempt === reentryAttempt ||
        !/^attempt-[a-f0-9-]{36}$/u.test(path.basename(reentryAttempt))) {
        refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
      }
      const handshake = await readBoundHandshake(dispatch.handshake, { attemptDirectory: reentryAttempt,
        bundle: await pin(bundlePath), policy: executorPolicy.pin, executable, loader, shim,
        cli: input.publisher.modules.promoteCli, inventory, executorInventory, sourceInventory,
        publisher: input.publisher, executor: input.executor, sourceIdentity });
      if (!deps.inspectChildTermination) refuse("POST_HEAD_SUCCESSOR_CHILD_OBSERVABILITY_UNKNOWN");
      const heldExecutionLock = executionLockProofSchema.parse(await executionHandle.refreshProof());
      const termination = childTerminationProofSchema.parse(
        await deps.inspectChildTermination(handshake, heldExecutionLock));
      if (termination.pid !== handshake.pid || termination.processGroupId !== handshake.pid ||
        termination.checkedAt < handshake.acquiredAt || !same(termination.executionLock, heldExecutionLock)) {
        refuse("POST_HEAD_SUCCESSOR_CHILD_OBSERVABILITY_UNKNOWN");
      }
      if (await exists(path.join(successor.artifactDirectory, "pending"))) {
        let completedAdoption: Awaited<ReturnType<typeof recoverCompletedAdoption>>;
        try { completedAdoption = await recoverCompletedAdoption(successor, run, reentryAttempt,
          input, bundlePath, old.bundle, firstEvidence, firstPublication.names); }
        catch {
          await appendLedgerRecord(manifest, "adoption_dispatched", "terminal", successor.ordinal,
            { reason: "evidence_invalid", evidenceSha256: artifact.digest({ termination }) }, now);
          return refuse("POST_HEAD_SUCCESSOR_LEDGER_TERMINAL");
        }
        if (completedAdoption) {
          reentryEvidence = completedAdoption.evidence;
        } else {
        if (successor.ordinal === 2) {
          await appendLedgerRecord(manifest, "adoption_dispatched", "terminal", successor.ordinal,
            { reason: "adoption_pending_retained", evidenceSha256: artifact.digest(termination) }, now);
          return refuse("POST_HEAD_SUCCESSOR_LEDGER_TERMINAL");
        }
        let interruption: z.infer<typeof interruptedAdoptionSchema>;
        try { interruption = await interruptedAdoptionEvidence(successor, run, reentryAttempt,
          input, firstPublication.names); }
        catch {
          await appendLedgerRecord(manifest, "adoption_dispatched", "terminal", successor.ordinal,
            { reason: "evidence_invalid", evidenceSha256: artifact.digest({ termination }) }, now);
          return refuse("POST_HEAD_SUCCESSOR_LEDGER_TERMINAL");
        }
        let retrySource: z.infer<typeof sourceProofSchema>, retryQuiet: z.infer<typeof recoveryQuietProofSchema>;
        let retryTarget: z.infer<typeof targetProofSchema>;
        try {
          retrySource = await readSource(deps, environment, now, input.head, sourceIdentity);
          retryQuiet = await readRecoveryQuiet(deps, environment, now, input.head, sourceIdentity, input.old.sourceConfig,
            input.publisher, executorPolicy.document.runtimeInventory);
        } catch {
          await appendLedgerRecord(manifest, "adoption_dispatched", "terminal", successor.ordinal,
            { reason: "lease_or_work_owned", evidenceSha256: artifact.digest({ termination, interruption }) }, now);
          return refuse("POST_HEAD_SUCCESSOR_LEDGER_TERMINAL");
        }
        try {
          retryTarget = await readTarget(deps, environment, now, input.publisher,
            executorPolicy.document.runtimeInventory);
          if (targetDisposition(retryTarget, old.bundle, input.old.targetPrevious) !== "candidate") throw new Error();
        } catch {
          await appendLedgerRecord(manifest, "adoption_dispatched", "terminal", successor.ordinal,
            { reason: "target_rollback_or_divergence", evidenceSha256: artifact.digest({ termination, interruption }) }, now);
          return refuse("POST_HEAD_SUCCESSOR_LEDGER_TERMINAL");
        }
        const retryResidency = residencyProofSchema.parse(await residencyHandle.refreshProof());
        const [abandonedArtifactInventory, abandonedProofInventory] = await Promise.all([
          rootInventory(successor.artifactDirectory, deps), rootInventory(successor.proofDirectory, deps),
        ]);
        await appendLedgerRecord(manifest, "adoption_dispatched", "retry_authorized", successor.ordinal,
          { reason: "adoption_interrupted_pending", termination, source: retrySource, quiet: retryQuiet,
            target: retryTarget, residency: retryResidency, abandonedArtifactInventory,
            abandonedProofInventory, interruptedAdoption: interruption }, now);
        return refuse("POST_HEAD_SUCCESSOR_RETRY_AUTHORIZED");
        }
      }
      const recovered = await publicationSidecars(bundlePath, old.bundle, input.head, 2, firstPublication.names);
      reentryEvidence = recovered.evidence;
      if (!same(await pin(path.join(reentryAttempt, "verified.json"), 65_536),
        { path: path.join(reentryAttempt, "verified.json"), sha256: artifact.hashBytes(jsonBytes(reentryEvidence)) })) {
        refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
      }
    } else {
      const reentryNotBefore = now();
      await executionHandle.relinquishForChild();
      try {
        reentryEvidence = await publishClutchpacksProductionPostHead({ head: input.head, baseSourceConfig: old.baseSourceConfig,
          artifactDirectory: successor.artifactDirectory, publisherWorktree: input.publisher.worktree,
          expectedPublisherCommit: input.publisher.commit, expectedResidentAuthorityDigest: input.head.authorityDigest,
          timeoutMs: input.deadlineMs, signal: deps.signal }, { git: deps.git, kill: deps.kill, startDeadline: deps.startDeadline,
          afterPublishCommandCompleted: deps.afterAdoptionCommandCompleted,
          afterAttemptVerified: deps.afterAdoptionAttemptVerified,
          afterRunVerified: deps.afterAdoptionRunVerified,
          spawn: (file, args, options) => {
            if (file !== direct.file || !same(args, direct.args)) refuse("POST_HEAD_SUCCESSOR_REENTRY_INVOCATION_CHANGED");
            const names = readdirSync(run);
            const candidates = names.map(name => path.join(run, name)).filter(candidate =>
              /^attempt-[a-f0-9-]{36}$/u.test(path.basename(candidate)) && candidate !== firstAttempt &&
              existsSync(path.join(candidate, "publish.started.json")));
            if (candidates.length !== 1) refuse("POST_HEAD_SUCCESSOR_REENTRY_ATTEMPT_INVALID");
            reentryAttempt = candidates[0]; return launch(file, shimArguments(reentryAttempt), options);
          }, afterSpawn: async child => {
            if (!reentryAttempt) refuse("POST_HEAD_SUCCESSOR_REENTRY_ATTEMPT_INVALID");
            const gateSignal = deps.signal ?? AbortSignal.timeout(input.deadlineMs);
            await gateChild(child, reentryAttempt, "reentry", reentryNotBefore, gateSignal);
          } });
      } finally { await executionHandle.reacquireAfterChild(); }
      await deps.afterStandardReentry?.();
    }
    if (reentryEvidence === null || typeof reentryEvidence !== "object" ||
      Object.getOwnPropertyDescriptor(reentryEvidence, "status")?.value !== "verified" ||
      await exists(path.join(successor.artifactDirectory, "pending"))) {
      refuse("POST_HEAD_SUCCESSOR_REENTRY_UNVERIFIED");
    }
    const reentryPublication = await publicationSidecars(bundlePath, old.bundle, input.head, 2, firstPublication.names);
    if (!same(reentryPublication.evidence, reentryEvidence)) refuse("POST_HEAD_SUCCESSOR_SIDECAR_INVALID");
    const finalTarget = await readTarget(deps, environment, now, input.publisher,
      executorPolicy.document.runtimeInventory);
    if (targetDisposition(finalTarget, old.bundle, input.old.targetPrevious) !== "candidate") refuse("POST_HEAD_SUCCESSOR_TARGET_CHANGED");
    const finalOldRootInventory = await rootInventory(input.old.artifactDirectory, deps);
    if (!same(finalOldRootInventory, old.inventory)) refuse("POST_HEAD_SUCCESSOR_OLD_ROOT_CHANGED");
    await verifyAbandonedRoot();
    const sourceFinal = await readSource(deps, environment, now, input.head,
      executorPolicy.document.sourceReader), completedAt = now();
    const attemptClaim = (await readLedgerRecords(manifest)).find(record =>
      record.event === "attempt_claimed" && record.ordinal === successor.ordinal);
    if (!attemptClaim) refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
    const receiptCore = { schemaVersion: "clutchpacks_production_post_head_successor_receipt_v1" as const,
      createdAt: attemptClaim.recordedAt, completedAt, head: input.head, oldRootInventory: old.inventory,
      finalOldRootInventory, successorArtifactDirectory: successor.artifactDirectory,
      successorRunDirectory: run, publisher: input.publisher, executor: input.executor,
      executorPolicy: executorPolicy.pin, bundle: await pin(bundlePath), firstEvidence, reentryEvidence,
      firstSidecars: firstPublication.set, reentrySidecars: reentryPublication.set,
      firstTarget, finalTarget, sourceFinal, residencyExclusion: residency };
    const receiptPath = path.join(successor.proofDirectory, "successor.completed.json");
    let receipt: z.infer<typeof successorReceiptSchema>;
    if (await exists(receiptPath)) {
      receipt = successorReceiptSchema.parse(artifact.parseJsonBytes(await artifact.readPrivate(receiptPath, 1_048_576)));
      const { receiptSha256, ...existingCore } = receipt;
      if (artifact.digest(existingCore) !== receiptSha256 || !same(receipt.head, input.head) ||
        !same(receipt.oldRootInventory, old.inventory) || !same(receipt.finalOldRootInventory, old.inventory) ||
        receipt.successorArtifactDirectory !== successor.artifactDirectory || receipt.successorRunDirectory !== run ||
        !same(receipt.publisher, input.publisher) || !same(receipt.executor, input.executor) ||
        !same(receipt.executorPolicy, executorPolicy.pin) || !same(receipt.bundle, await pin(bundlePath)) ||
        receipt.firstEvidence === null || artifact.digest(receipt.firstEvidence) !== artifact.digest(firstEvidence) ||
        artifact.digest(receipt.reentryEvidence) !== artifact.digest(reentryEvidence) ||
        !same(receipt.firstSidecars, firstPublication.set) || !same(receipt.reentrySidecars, reentryPublication.set) ||
        !same(receipt.sourceFinal.snapshot, exactSource(input.head)) ||
        targetDisposition(receipt.finalTarget, old.bundle, input.old.targetPrevious) !== "candidate") {
        refuse("POST_HEAD_SUCCESSOR_LEDGER_INVALID");
      }
    } else {
      receipt = successorReceiptSchema.parse({ ...receiptCore, receiptSha256: artifact.digest(receiptCore) });
      await installOrValidate(receiptPath, jsonBytes(receipt));
    }
    const receiptPin = await pin(receiptPath, 1_048_576);
    await appendLedgerRecord(manifest, "adoption_dispatched", "complete", successor.ordinal,
      { successorReceipt: receiptPin, bundle: await pin(bundlePath), firstSidecars: firstPublication.set,
        reentrySidecars: reentryPublication.set, finalTarget, sourceFinal }, now);
    return { status: "verified" as const, artifactDirectory: successor.artifactDirectory,
      runDirectory: run, bundleSha256: old.bundle.bundleSha256, evidence: firstEvidence,
      reentryEvidence, receipt: receiptPin };
  } catch (error) {
    if (!policy.production && !(error instanceof SuccessorError)) throw error;
    const code = error instanceof SuccessorError ? error.code : "POST_HEAD_SUCCESSOR_FAILED";
    return refuse(code);
  } finally { await releaseExecution?.(); await releaseResidency?.(); }
}

const productionEnvironment = Object.freeze({ HOME: "/Users/lains", NODE_ENV: "production" as const,
  PATH: "/Users/lains/.hermes/node/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  TMPDIR: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutch-production-successor-tmp-c533e197-v1" });
const sourceReader = Object.freeze({
  worktree: "/Users/lains/Projects/packscout/.worktrees/clutch-minute-polling",
  commit: "c4d6bf21cddde7155d1f6ebb1b979c69910d21dd",
  script: "/Users/lains/Projects/packscout/.worktrees/clutch-minute-polling/scripts/live/run-clutchpacks-production-poller.mts",
  policy: "/Users/lains/Library/Application Support/PackScout/provider-import-maintenance/clutchpacks-production-poller-successor-20260901T011542Z-7454390-126d1069.json",
  policySha256: "49a9e30f7b9cf09d7951da7963dede5e93a8a0b8bb91fb35cc7d5182ca9700c0",
  scriptSha256: "ba85446bcc7f5a7f24adb7b924d4dd667e746febd1f959c330e4de8dc840d6f0",
  loader: "/Users/lains/Projects/packscout/.worktrees/clutch-minute-polling/node_modules/tsx/dist/loader.mjs",
  loaderSha256: "274e965b148911ea8ccd08923aecf1b898e46db70c8c5a5071b1cc6035f5851d",
  executable: "/Users/lains/.hermes/node/bin/node",
  executableSha256: "5d9d3872911e2340a43b707962e68143de8a4e8d54628845c0c4f2de1fb7cd5c",
  argv: ["--check-only", "--organization-id", "3c9fa4d3-fe16-569c-8cfa-b4a44c63eb4a",
    "--provider-id", "14787a87-77c0-5771-bfe1-cd5507bf2881", "--provider-key", "clutchpacks",
    "--config-id", "de37fd7f-4461-4df1-86e6-6609486df4b7", "--initial-run-id",
    "ea1719bf-96e7-5d2d-a084-e1ad1821fadb", "--operation-id", "126d1069-0e62-4710-aa21-504f9a769e0e",
    "--operator-id", "7236e1b0-eb72-58cb-a3fb-3ae3dc7bb9de", "--poll-interval-seconds", "60"] as const,
});

type GitReader = NonNullable<SuccessorDependencies["git"]>;
const productionGitEnvironment = Object.freeze({ PATH: "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" });
const productionGit: GitReader = async (args, options) => (await promisify(execFile)("/usr/bin/git", [...args],
  { ...options, timeout: 30_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
async function verifyTrustedCheckout(identity: { worktree: string; commit: string },
  modules: Record<string, z.infer<typeof filePin>>, relatives: Readonly<Record<string, string>>, git: GitReader) {
  const options = { cwd: identity.worktree, env: productionGitEnvironment };
  if ((await git(["rev-parse", "--show-toplevel"], options)).trim() !== identity.worktree ||
    (await git(["rev-parse", "HEAD"], options)).trim() !== identity.commit ||
    await git(["status", "--porcelain=v1", "--untracked-files=normal"], options) !== "") {
    refuse("POST_HEAD_CHECKOUT_INVALID");
  }
  for (const [name, relative] of Object.entries(relatives)) {
    const expected = path.join(identity.worktree, relative), module = modules[name];
    if (!module || module.path !== expected ||
      (await git(["ls-files", "--error-unmatch", relative], options)).trim() !== relative ||
      !same(await pinTrustedRegular(expected, 8 * 1024 * 1024), module)) {
      refuse("POST_HEAD_SUCCESSOR_MODULE_CHANGED");
    }
  }
}
async function verifyTrustedRuntimeClosure(identity: { worktree: string; commit: string },
  modules: Record<string, z.infer<typeof filePin>>, relatives: Readonly<Record<string, string>>,
  expectedInventory: z.infer<typeof runtimeInventorySchema>, readInventory: (root: string, allowed: string) => Promise<unknown>,
  verifyExtras: () => Promise<void>, git: GitReader) {
  const proveCode = async () => { await verifyTrustedCheckout(identity, modules, relatives, git); await verifyExtras(); };
  const proveInventory = async () => {
    const parsed = runtimeInventorySchema.safeParse(await readInventory(expectedInventory.root,
      expectedInventory.allowedTargetRoot));
    if (!parsed.success || !same(parsed.data, expectedInventory)) refuse("POST_HEAD_SUCCESSOR_RUNTIME_CHANGED");
  };
  await proveCode(); await proveInventory(); await proveCode(); await proveInventory(); await proveCode();
}

async function bind(port: number) {
  const server = createServer(socket => socket.destroy());
  await new Promise<void>((resolve, reject) => { server.once("error", reject);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => resolve()); });
  return server;
}
async function closeServer(server: Server | undefined) {
  if (!server) return;
  await new Promise<void>(resolve => server.close(() => resolve()));
}
function launchctlServiceIsMissing(error: unknown, uid: number) {
  if (error === null || typeof error !== "object") return false;
  const value = error as { code?: string | number; stdout?: string; stderr?: string };
  const expected = `Could not find service \"com.packscout.provider-import.clutchpacks\" in domain for user gui: ${uid}\n`;
  return (value.code === 113 || value.code === "113") && (value.stdout ?? "") === "" &&
    (value.stderr === expected || value.stderr === `Bad request.\n${expected}`);
}
async function inspectProductionResidency(server: Server | undefined, acquiredAt: string) {
    const uid = process.getuid?.(); if (uid === undefined) refuse("POST_HEAD_SUCCESSOR_RESIDENCY_INVALID");
    let unloaded = false;
    try { await promisify(execFile)("/bin/launchctl", ["print", `gui/${uid}/com.packscout.provider-import.clutchpacks`],
      { timeout: 10_000, maxBuffer: 1_048_576 }); }
    catch (error) {
      if (!launchctlServiceIsMissing(error, uid)) refuse("POST_HEAD_SUCCESSOR_RESIDENCY_INVALID");
      unloaded = true;
    }
    const ps = await promisify(execFile)("/bin/ps", ["-axo", "pid=,command="],
      { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 });
    const residentProcessCount = ps.stdout.split("\n").filter(line =>
      (line.includes("run-clutchpacks-production-poller.mts") && line.includes("--run") && !line.includes("--check-only")) ||
      line.includes("promote-clutchpacks-production.mts")).length;
    return residencyProofSchema.parse({ label: "com.packscout.provider-import.clutchpacks", port: 56_432,
      launchdUnloaded: unloaded, residentProcessCount, portBound: server?.listening === true,
      acquiredAt, checkedAt: new Date().toISOString() });
}
async function productionResidencyExclusion() {
  let server: Server | undefined; const acquiredAt = new Date().toISOString();
  const inspect = () => inspectProductionResidency(server, acquiredAt);
  server = await bind(56_432);
  try {
    const proof = await inspect();
    return { proof, refreshProof: inspect, release: () => closeServer(server) };
  } catch (error) { await closeServer(server); server = undefined; throw error; }
}
async function productionExecutionExclusion() {
  let server: Server | undefined = await bind(47_432), childOwns = false;
  let acquiredAt = new Date().toISOString();
  const inspect = () => {
    const address = server?.address();
    if (childOwns || !server?.listening || !address || typeof address === "string" ||
      address.address !== "127.0.0.1" || address.port !== 47_432) {
      refuse("POST_HEAD_SUCCESSOR_EXECUTION_LOCK_INVALID");
    }
    return executionLockProofSchema.parse({ port: 47_432, portBound: true, acquiredAt });
  };
  return { proof: inspect(), refreshProof: async () => inspect(),
    async relinquishForChild() { if (childOwns || !server) refuse("POST_HEAD_SUCCESSOR_EXECUTION_LOCK_INVALID");
      await closeServer(server); server = undefined; childOwns = true; },
    async reacquireAfterChild() { if (!childOwns || server) refuse("POST_HEAD_SUCCESSOR_EXECUTION_LOCK_INVALID");
      server = await bind(47_432); acquiredAt = new Date().toISOString(); childOwns = false; },
    release: () => closeServer(server) };
}
async function productionSourceProof(inventoryModulePin: z.infer<typeof filePin>, _environment: NodeJS.ProcessEnv,
  _signal?: AbortSignal, identity?: z.infer<typeof sourceReaderIdentitySchema>) {
  if (!identity || identity.worktree !== sourceReader.worktree || identity.commit !== sourceReader.commit) {
    refuse("POST_HEAD_SUCCESSOR_SOURCE_READER_CHANGED");
  }
  const inventoryModulePath = fileURLToPath(new URL("./clutchpacks-production-runtime-inventory.mjs", import.meta.url));
  if (inventoryModulePin.path !== inventoryModulePath ||
    !same(await pinTrustedRegular(inventoryModulePath, 1_048_576), inventoryModulePin)) {
    refuse("POST_HEAD_SUCCESSOR_SOURCE_READER_CHANGED");
  }
  const inventoryModule: unknown = await import(pathToFileURL(inventoryModulePath).href);
  const inventoryReader = (inventoryModule as { readClutchpacksProductionRuntimeInventory?:
    (root: string, allowed: string) => Promise<unknown> }).readClutchpacksProductionRuntimeInventory;
  if (typeof inventoryReader !== "function") {
    refuse("POST_HEAD_SUCCESSOR_SOURCE_READER_CHANGED");
  }
  const sourceModules = { script: identity.script }, sourceRelatives = {
    script: path.relative(identity.worktree, identity.script.path) };
  await verifyTrustedRuntimeClosure(identity, sourceModules, sourceRelatives, identity.runtimeInventory,
    inventoryReader, async () => {
      if (!same(await pinTrustedRegular(sourceReader.loader, 8 * 1024 * 1024), identity.loader) ||
        !same(await pinTrustedRegular(sourceReader.executable), identity.executable) ||
        !same(await pin(sourceReader.policy, 65_536), identity.policy) ||
        !same(await pinTrustedRegular(inventoryModulePath, 1_048_576), inventoryModulePin)) {
        refuse("POST_HEAD_SUCCESSOR_SOURCE_READER_CHANGED");
      }
    }, productionGit);
  const childEnvironment: NodeJS.ProcessEnv = { HOME: productionEnvironment.HOME, PATH: productionEnvironment.PATH,
    TMPDIR: productionEnvironment.TMPDIR, NODE_ENV: "development",
    PACKSCOUT_CLUTCHPACKS_POLLER_POLICY_PATH: sourceReader.policy,
    PACKSCOUT_CLUTCHPACKS_POLLER_POLICY_SHA256: sourceReader.policySha256 };
  const result = await promisify(execFile)(sourceReader.executable,
    ["--import", sourceReader.loader, sourceReader.script, ...sourceReader.argv],
    { cwd: sourceReader.worktree, env: childEnvironment, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  const lines = result.stdout.trim().split("\n"), value = JSON.parse(lines.at(-1) ?? "null") as Record<string, unknown>;
  if (value.state !== "due" || value.providerId !== incident.head.providerId || value.runId !== incident.head.runId ||
    value.checkpointHash !== incident.head.checkpointHash || value.runtimeState !== "idle" ||
    value.generation !== incident.head.generation || value.runtimeRowVersion !== incident.head.runtimeRowVersion ||
    value.authorityDigest !== incident.head.authorityDigest || value.configVersionId !== incident.head.configId ||
    value.configVersionNumber !== incident.head.configNumber || value.headFinishedAt !== incident.head.headFinishedAt ||
    value.leaseOwned !== false || value.effectiveIntervalSeconds !== 60 || value.residency !== "not_claimed_check_only") {
    refuse("POST_HEAD_SUCCESSOR_SOURCE_CHANGED");
  }
  return exactSource(incident.head);
}

async function productionRecoveryQuietProof(inventoryModulePin: z.infer<typeof filePin>,
  _environment: NodeJS.ProcessEnv, signal?: AbortSignal, identity?: z.infer<typeof sourceReaderIdentitySchema>,
  sourceConfigPin?: z.infer<typeof filePin>, publisher?: z.infer<typeof publisherIdentity>,
  publisherRuntime?: z.infer<typeof runtimeInventorySchema>) {
  if (!identity || !sourceConfigPin || !publisher || !publisherRuntime || signal?.aborted ||
    publisher.worktree !== incident.oldWorktree || publisher.commit !== incident.oldCommit) {
    refuse("POST_HEAD_SUCCESSOR_RECOVERY_QUIET_UNAVAILABLE");
  }
  const inventoryModulePath = fileURLToPath(new URL("./clutchpacks-production-runtime-inventory.mjs", import.meta.url));
  if (inventoryModulePin.path !== inventoryModulePath ||
    !same(await pinTrustedRegular(inventoryModulePath, 1_048_576), inventoryModulePin)) {
    refuse("POST_HEAD_SUCCESSOR_RECOVERY_QUIET_UNAVAILABLE");
  }
  const loadedInventory: unknown = await import(pathToFileURL(inventoryModulePath).href);
  const inventoryReader = (loadedInventory as { readClutchpacksProductionRuntimeInventory?:
    (root: string, allowed: string) => Promise<unknown> }).readClutchpacksProductionRuntimeInventory;
  if (typeof inventoryReader !== "function") refuse("POST_HEAD_SUCCESSOR_RECOVERY_QUIET_UNAVAILABLE");
  const provePublisher = () => verifyTrustedRuntimeClosure(publisher, publisher.modules, moduleRelativePaths,
    publisherRuntime, inventoryReader, async () => {
      if (!same(await pinTrustedRegular(inventoryModulePath, 1_048_576), inventoryModulePin)) {
        refuse("POST_HEAD_SUCCESSOR_RECOVERY_QUIET_UNAVAILABLE");
      }
    }, productionGit);
  await provePublisher();
  const config = artifact.parseSourceConfig(artifact.parseJsonBytes(await pinned(sourceConfigPin, 1_048_576)));
  if (config.scope.providerId !== incident.head.providerId || config.scope.configVersionId !== incident.head.configId ||
    config.scope.configVersionNumber !== incident.head.configNumber || config.expected.latestSucceededRunId !== incident.head.runId ||
    config.expected.checkpointHash !== incident.head.checkpointHash || config.expected.stateGeneration !== incident.head.generation ||
    config.expected.runtimeRowVersion !== incident.head.runtimeRowVersion) {
    refuse("POST_HEAD_SUCCESSOR_RECOVERY_QUIET_CHANGED");
  }
  const frozenBytes = await pinned(config.frozenEnvironment, 1_048_576);
  await provePublisher();
  const publisherRequire = createRequire(path.join(incident.oldWorktree, "package.json"));
  const dotenv = publisherRequire("dotenv") as { parse(value: Buffer): Record<string, string> };
  const sourceEnvironment = dotenv.parse(frozenBytes); frozenBytes.fill(0);
  const allowed = ["PACKSCOUT_CENTRAL_DATABASE_URL", "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64",
    "PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION"];
  if (!same(Object.keys(sourceEnvironment).sort(), allowed.sort())) {
    for (const key of Object.keys(sourceEnvironment)) sourceEnvironment[key] = "";
    refuse("POST_HEAD_SUCCESSOR_RECOVERY_QUIET_UNAVAILABLE");
  }
  const encoded = sourceEnvironment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_BASE64;
  const encodedVersion = sourceEnvironment.PACKSCOUT_PROVIDER_CREDENTIAL_KEY_VERSION;
  const centralDatabaseUrl = sourceEnvironment.PACKSCOUT_CENTRAL_DATABASE_URL, version = Number(encodedVersion);
  const key = Buffer.from(encoded ?? "", "base64");
  let reader: { read(): Promise<Record<string, unknown>>; close(): Promise<void> } | undefined;
  try {
    if (!encoded || !encodedVersion || !centralDatabaseUrl || !/^[1-9][0-9]{0,9}$/u.test(encodedVersion) ||
      !Number.isSafeInteger(version) || version > 2_147_483_647 || key.byteLength !== 32 ||
      key.toString("base64") !== encoded) refuse("POST_HEAD_SUCCESSOR_RECOVERY_QUIET_UNAVAILABLE");
    await provePublisher();
    const [services, sourceModule] = await Promise.all([
      import(pathToFileURL(path.join(incident.oldWorktree, moduleRelativePaths.servicesIndex)).href),
      import(pathToFileURL(path.join(incident.oldWorktree, moduleRelativePaths.sourceReader)).href),
    ]) as [Record<string, unknown>, Record<string, unknown>];
    const Cipher = services.AesGcmProviderCredentialCipher as new (value: unknown) => unknown;
    const Resolver = services.CipherProviderDatabaseCredentialResolver as new (value: unknown) => unknown;
    const createReader = sourceModule.createClutchpacksProductionSourceReader as ((value: unknown) => typeof reader) | undefined;
    if (typeof Cipher !== "function" || typeof Resolver !== "function" || typeof createReader !== "function") {
      refuse("POST_HEAD_SUCCESSOR_RECOVERY_QUIET_UNAVAILABLE");
    }
    const cipher = new Cipher({ primaryVersion: version, keys: new Map([[version, key]]) });
    reader = createReader({ centralDatabaseUrl, centralHost: config.centralHost, providerHost: config.providerHost,
      credentialResolver: new Resolver(cipher),
      scope: { ...config.scope, configVersionNumber: BigInt(config.scope.configVersionNumber) },
      expected: { ...config.expected, stateGeneration: BigInt(config.expected.stateGeneration),
        runtimeRowVersion: BigInt(config.expected.runtimeRowVersion) },
      approvedPublicAssetOrigins: config.approvedPublicAssetOrigins });
    if (!reader || signal?.aborted) refuse("POST_HEAD_SUCCESSOR_RECOVERY_QUIET_UNAVAILABLE");
    const state = await reader.read();
    const runtime = state.runtime as Record<string, unknown>, lease = state.lease as Record<string, unknown>;
    if (!runtime || !lease || runtime.operating_state !== "idle" || lease.lease_owner !== null ||
      lease.lease_expires_at !== null || typeof state.digest !== "string" || !hash.safeParse(state.digest).success ||
      signal?.aborted) refuse("POST_HEAD_SUCCESSOR_RECOVERY_QUIET_CHANGED");
    return recoveryQuietSnapshotSchema.parse({ ...incident.head, runtimeState: "idle", importLeaseOwner: null,
      importLeaseExpiresAt: null, sourceStateDigest: state.digest,
      assertionProvenance: "production_source_state_strict_admission_v1" });
  } finally {
    key.fill(0); for (const name of Object.keys(sourceEnvironment)) sourceEnvironment[name] = "";
    await reader?.close();
  }
}

async function productionChildTermination(proof: z.infer<typeof childLockProofSchema>,
  heldExecutionLock: z.infer<typeof executionLockProofSchema>) {
  const absent = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; throw error; }
  };
  let processAbsent: boolean, processGroupAbsent: boolean;
  try { processAbsent = absent(proof.pid); processGroupAbsent = absent(-proof.pid); }
  catch { return refuse("POST_HEAD_SUCCESSOR_CHILD_OBSERVABILITY_UNKNOWN"); }
  if (!processAbsent || !processGroupAbsent) refuse("POST_HEAD_SUCCESSOR_CHILD_OBSERVABILITY_UNKNOWN");
  return childTerminationProofSchema.parse({ checkedAt: new Date().toISOString(), pid: proof.pid,
    processGroupId: proof.pid, processAbsent: true, processGroupAbsent: true,
    executionLock: executionLockProofSchema.parse(heldExecutionLock) });
}
async function productionUnboundChildAbsence(successor: SuccessorRoot, bundlePath: string,
  heldExecutionLock: z.infer<typeof executionLockProofSchema>) {
  const shimPath = path.join(fileURLToPath(new URL(".", import.meta.url)),
    "clutchpacks-production-recovery-publish-shim.mjs");
  const policyPath = path.join(productionRegistry.ledgerPath, "executor-policy.json");
  const result = await promisify(execFile)("/bin/ps", ["-axo", "pid=,pgid=,command="], {
    env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 10_000, maxBuffer: 16 * 1024 * 1024,
  }).catch(() => refuse("POST_HEAD_SUCCESSOR_CHILD_OBSERVABILITY_UNKNOWN"));
  if (result.stderr !== "") refuse("POST_HEAD_SUCCESSOR_CHILD_OBSERVABILITY_UNKNOWN");
  const matches = result.stdout.split("\n").filter(line => line.includes(shimPath) && line.includes(bundlePath) &&
    line.includes(policyPath) && line.includes(successor.artifactDirectory));
  if (matches.length !== 0) refuse("POST_HEAD_SUCCESSOR_CHILD_OBSERVABILITY_UNKNOWN");
  const core = { checkedAt: new Date().toISOString(), matchingProcessIds: [] as never[],
    matchingProcessGroupIds: [] as never[], executionLock: executionLockProofSchema.parse(heldExecutionLock) };
  return unboundChildAbsenceProofSchema.parse({ ...core, proofSha256: artifact.digest(core) });
}

interface ProductionRuntime {
  publication: { activeState(signal?: AbortSignal): Promise<{ generation: number; activeRelease: z.infer<typeof releasePointer> | null;
    previousRelease: z.infer<typeof releasePointer> | null }>; status(id: string, signal?: AbortSignal): Promise<unknown> };
  close(): void | Promise<void>;
}
async function verifyTrustedTargetRuntimeClosure(publisher: z.infer<typeof publisherIdentity>,
  runtimePin: z.infer<typeof filePin>, publisherRuntime: z.infer<typeof runtimeInventorySchema>,
  readInventory: (root: string, allowed: string) => Promise<unknown>, git: GitReader) {
  await verifyTrustedRuntimeClosure(publisher, publisher.modules, moduleRelativePaths, publisherRuntime,
    readInventory, async () => {
      if (!same(await pinTrustedRegular(runtimePin.path, 8 * 1024 * 1024), runtimePin)) {
        refuse("POST_HEAD_SUCCESSOR_TARGET_READER_CHANGED");
      }
    }, git);
}
async function productionTargetProof(input: z.infer<typeof successorInputSchema>, environment: NodeJS.ProcessEnv,
  signal: AbortSignal | undefined, publisher: z.infer<typeof publisherIdentity>,
  publisherRuntime: z.infer<typeof runtimeInventorySchema>) {
  const runtimePin = { path: path.join(incident.oldWorktree, moduleRelativePaths.convexRuntime),
    sha256: "b7fd402002f142d647727f6158fc49e841917a71e5a855a0896013f015f23d78" };
  if (input.publisher.worktree !== incident.oldWorktree || input.publisher.commit !== incident.oldCommit ||
    !same(input.publisher, publisher) || !same(input.publisher.modules.convexRuntime, runtimePin)) {
    refuse("POST_HEAD_SUCCESSOR_TARGET_READER_CHANGED");
  }
  const inventoryModulePath = fileURLToPath(new URL("./clutchpacks-production-runtime-inventory.mjs", import.meta.url));
  if (input.executor.modules.runtimeInventory.path !== inventoryModulePath ||
    !same(await pinTrustedRegular(inventoryModulePath, 1_048_576), input.executor.modules.runtimeInventory)) {
    refuse("POST_HEAD_SUCCESSOR_TARGET_READER_CHANGED");
  }
  const inventoryModule: unknown = await import(pathToFileURL(inventoryModulePath).href);
  const inventoryReader = (inventoryModule as { readClutchpacksProductionRuntimeInventory?:
    (root: string, allowed: string) => Promise<unknown> }).readClutchpacksProductionRuntimeInventory;
  if (typeof inventoryReader !== "function") refuse("POST_HEAD_SUCCESSOR_TARGET_READER_CHANGED");
  await verifyTrustedTargetRuntimeClosure(publisher, runtimePin, publisherRuntime, inventoryReader, productionGit);
  const loaded: unknown = await import(pathToFileURL(runtimePin.path).href);
  const openRuntime = (loaded as { openClutchpacksProductionConvexRuntime?:
    (value: NodeJS.ProcessEnv) => Promise<ProductionRuntime> }).openClutchpacksProductionConvexRuntime;
  if (typeof openRuntime !== "function") refuse("POST_HEAD_SUCCESSOR_TARGET_READER_CHANGED");
  const runtime = await openRuntime(environment);
  try {
    const first = await runtime.publication.activeState(signal);
    if (!first.activeRelease || !first.previousRelease) refuse("POST_HEAD_SUCCESSOR_TARGET_CHANGED");
    const [activeStatusValue, previousStatusValue, candidateStatusValue] = await Promise.all([
      runtime.publication.status(first.activeRelease.publicReleaseId, signal),
      runtime.publication.status(first.previousRelease.publicReleaseId, signal),
      runtime.publication.status(incident.candidate.publicReleaseId, signal),
    ]);
    const second = await runtime.publication.activeState(signal);
    if (!same(first, second)) refuse("POST_HEAD_SUCCESSOR_TARGET_CHANGED");
    const activeStatus = projectReleaseStatus(activeStatusValue), previousStatus = projectReleaseStatus(previousStatusValue),
      candidateStatus = projectReleaseStatus(candidateStatusValue);
    if (!activeStatus || !previousStatus) refuse("POST_HEAD_SUCCESSOR_TARGET_CHANGED");
    return targetSnapshotSchema.parse({ active: { generation: first.generation,
      publicReleaseId: first.activeRelease.publicReleaseId, releaseFingerprint: first.activeRelease.releaseFingerprint },
      previous: first.previousRelease, activeStatus, previousStatus, candidateStatus,
      assertionProvenance: { activeChain: "signed_active_state_double_read_v1",
        lifecycle: "signed_release_status_projection_v1", stagingExclusion: "publisher_start_cas_v1" } });
  } finally { await runtime.close(); }
}
async function productionRootMetadata(root: string) {
  const options = { env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 60_000,
    maxBuffer: 64 * 1024 * 1024 };
  const [xattrs, acl] = await Promise.all([
    promisify(execFile)("/usr/bin/xattr", ["-lr", root], options),
    promisify(execFile)("/bin/ls", ["-lRde@", root], options),
  ]);
  return { xattrs: xattrs.stdout, aclListing: acl.stdout };
}

/** Offline-only inventory primitive used by the reviewed incident-ledger preparer. */
export async function readClutchpacksProductionPostHeadRootInventoryForPreparation(root: string) {
  if (root !== incident.oldRoot) refuse("POST_HEAD_SUCCESSOR_INCIDENT_MISMATCH");
  return rootInventory(root, { readRootMetadata: productionRootMetadata });
}
function productionDependencies(input: z.infer<typeof successorInputSchema>, signal?: AbortSignal): SuccessorDependencies {
  return { signal,
    git: productionGit,
    spawn: (file, args, options) => spawnChild(file, [...args], options),
    kill: (child, kind) => { if (child.pid === undefined) throw new Error(); process.kill(-child.pid, kind); },
    startDeadline: (abort, milliseconds) => { const timer = setTimeout(abort, milliseconds); return () => clearTimeout(timer); },
    now: () => new Date().toISOString(),
    readSourceProof: (environment, childSignal, identity) => productionSourceProof(
      input.executor.modules.runtimeInventory, environment, childSignal, identity),
    readTargetProof: (environment, childSignal, publisher, publisherRuntime) =>
      productionTargetProof(input, environment, childSignal, publisher, publisherRuntime),
    readRecoveryQuietProof: (environment, childSignal, identity, sourceConfig, publisher, publisherRuntime) =>
      productionRecoveryQuietProof(input.executor.modules.runtimeInventory, environment, childSignal, identity,
        sourceConfig, publisher, publisherRuntime),
    inspectChildTermination: productionChildTermination,
    inspectUnboundChildAbsence: productionUnboundChildAbsence,
    readRootMetadata: productionRootMetadata,
    acquireResidencyExclusion: productionResidencyExclusion, acquireExecutionExclusion: productionExecutionExclusion };
}

/** Creates a fresh publisher-compatible root while leaving the blocked c533 root immutable. */
export async function createClutchpacksProductionPostHeadSuccessor(
  _raw: ClutchpacksProductionPostHeadSuccessorInput, _signal?: AbortSignal): Promise<never> {
  return refuse("POST_HEAD_SUCCESSOR_LAUNCHER_REQUIRED");
}
export const executeClutchpacksProductionPostHeadRecoveryPublication = createClutchpacksProductionPostHeadSuccessor;
type SealedLauncherContext = { readonly residencyServer: Server; readonly acquiredAt: string;
  readonly incidentManifest: z.infer<typeof filePin>;
  readonly launcher: z.infer<typeof filePin> & { readonly worktree: string; readonly commit: string } };
/** The sole production boundary. The direct-Node launcher owns 56432 before loading this module and closes it. */
export async function runClutchpacksProductionPostHeadSuccessorFromSealedLauncher(
  raw: ClutchpacksProductionPostHeadSuccessorInput, context: SealedLauncherContext, signal?: AbortSignal) {
  const input = successorInputSchema.parse(raw), environment = normalizeSealedEnvironment(process.env);
  if (context === null || typeof context !== "object" ||
    !same(Object.keys(context).sort(), ["acquiredAt", "incidentManifest", "launcher", "residencyServer"]) ||
    process.execArgv.length !== 0 || !same(environment, productionEnvironment) || !context.residencyServer?.listening ||
    !iso.safeParse(context.acquiredAt).success || !same(filePin.parse(context.incidentManifest), input.incidentManifest)) {
    refuse("POST_HEAD_SUCCESSOR_LAUNCHER_INVALID");
  }
  if (!same(Object.keys(context.launcher).sort(), ["commit", "path", "sha256", "worktree"])) {
    refuse("POST_HEAD_SUCCESSOR_LAUNCHER_INVALID");
  }
  const address = context.residencyServer.address(), launcher = filePin.parse(
    { path: context.launcher.path, sha256: context.launcher.sha256 });
  if (!address || typeof address === "string" || address.address !== "127.0.0.1" || address.port !== 56_432 ||
    context.launcher.worktree !== input.executor.worktree || context.launcher.commit !== input.executor.commit ||
    !same(launcher, input.executor.modules.launcher) ||
    context.launcher.path !== path.join(input.executor.worktree, executorRelativePaths.launcher) ||
    !same(await pinTrustedRegular(context.launcher.path, 8 * 1024 * 1024), launcher)) {
    refuse("POST_HEAD_SUCCESSOR_LAUNCHER_INVALID");
  }
  const initial = await inspectProductionResidency(context.residencyServer, context.acquiredAt);
  const dependencies: SuccessorDependencies = { ...productionDependencies(input, signal),
    acquireResidencyExclusion: async () => ({ proof: initial,
      refreshProof: () => inspectProductionResidency(context.residencyServer, context.acquiredAt),
      release: () => undefined }) };
  return successorCore(input, dependencies,
    { production: true, importedModulePath: fileURLToPath(import.meta.url), environment });
}
export const clutchpacksProductionPostHeadRecoveryTestHarness = process.env.NODE_ENV === "test" ? Object.freeze({
  execute: (raw: ClutchpacksProductionPostHeadSuccessorInput, dependencies: SuccessorDependencies = {}) =>
    successorCore(raw, dependencies, { production: false }),
  pinTrustedRegular: (file: string, maximum?: number, minimum?: number) =>
    pinTrustedRegular(file, maximum, minimum),
  verifyTrustedPublisherRuntimeClosure: (identity: z.infer<typeof publisherIdentity>,
    inventory: z.infer<typeof runtimeInventorySchema>, readInventory: (root: string, allowed: string) => Promise<unknown>,
    git: GitReader) => verifyTrustedRuntimeClosure(identity, identity.modules, moduleRelativePaths,
    inventory, readInventory, async () => undefined, git),
  verifyTrustedTargetRuntimeClosure: (identity: z.infer<typeof publisherIdentity>, runtimePin: z.infer<typeof filePin>,
    inventory: z.infer<typeof runtimeInventorySchema>, readInventory: (root: string, allowed: string) => Promise<unknown>,
    git: GitReader) => verifyTrustedTargetRuntimeClosure(identity, runtimePin, inventory, readInventory, git),
  rootInventory: (root: string, dependencies: SuccessorDependencies = {}) => rootInventory(root, dependencies),
  oldAttemptDirectoryName: incident.oldAttemptDirectoryName,
  normalizeSealedEnvironment,
  ledgerSchemaSha256,
  projectReleaseStatus,
  launchctlServiceIsMissing,
  validateHistoricalTarget: (rawInput: unknown, bundleBytes: Buffer, values: {
    preflightBytes: Buffer; predecessorBundleBytes: Buffer; predecessorReceiptBytes: Buffer;
  }) => {
    const input = successorInputSchema.parse(rawInput), rawBundle = artifact.parseJsonBytes(bundleBytes) as Record<string, unknown>;
    const sourceConfig = artifact.parseSourceConfig(rawBundle.sourceConfig);
    const bundle = artifact.boundBundleBytes(bundleBytes, sourceConfig, input.head);
    return validateHistoricalTarget(input, bundle, values, false);
  },
  manifest: (value: unknown) => incidentManifestSchema.parse(value),
  executorPolicy: (value: unknown) => executorPolicySchema.parse(value),
  successorInput: (value: unknown) => successorInputSchema.parse(value),
  reduceLedger: (manifest: unknown, records: unknown[]) => reduceLedger(
    incidentManifestSchema.parse(manifest) as unknown as IncidentManifest,
    records.map(record => ledgerRecordSchema.parse(record))),
}) : undefined;
