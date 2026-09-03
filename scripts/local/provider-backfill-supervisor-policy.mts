import { createHash } from "node:crypto";
import { z } from "zod";
import { providerMixedPageDigest } from "@packscout/database";

export class ProviderBackfillSupervisorError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ProviderBackfillSupervisorError"; }
}
export function refuseBackfill(code: string): never { throw new ProviderBackfillSupervisorError(code); }
export const transientBackfillCodes = new Set([
  "PROVIDER_DATAFORREST_REQUEST_TIMEOUT", "PROVIDER_DATAFORREST_NETWORK_INTERRUPTION",
  "PROVIDER_DATAFORREST_RATE_LIMITED", "PROVIDER_DATAFORREST_SERVER_FAILURE",
  // Emitted only for a trusted expired query after its rejected transaction
  // callback has settled; unknown P2028/commit outcomes retain permanent policy.
  "PROVIDER_IMPORT_DATABASE_TRANSACTION_EXPIRED",
  // A response only exceeds the fixed ceiling for a page size the runtime chooses,
  // so a retry under a lowered maximumPageRecords issues a materially smaller
  // request. Treating this as permanent latched the resident on a recoverable
  // condition with an intact checkpoint.
  "PROVIDER_DATAFORREST_RESPONSE_TOO_LARGE",
]);
export function safeBackfillFailureCode(value: string | null): string | null {
  return value === null || /^PROVIDER_[A-Z0-9_]{1,110}$/u.test(value) ? value : "BACKFILL_UNKNOWN_FAILURE";
}
export function backfillId(operationId: string, label: string): string {
  const hex = createHash("sha256").update(`${operationId}/${label}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function backfillDigest(value: unknown): string {
  return providerMixedPageDigest(JSON.parse(JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item)));
}
export function backfillDelayMilliseconds(consecutiveFailures: number, jitter: number): number {
  if (!Number.isSafeInteger(consecutiveFailures) || consecutiveFailures < 1 ||
    !Number.isFinite(jitter) || jitter < 0 || jitter >= 1) refuseBackfill("BACKFILL_BACKOFF_INVALID");
  const ceiling = Math.min(300_000, 10_000 * 2 ** Math.min(5, consecutiveFailures - 1));
  // Equal jitter avoids zero-delay retries, including after process restart.
  return Math.floor(ceiling * (0.5 + jitter * 0.5));
}

export const backfillPinsSchema = z.object({
  organizationId: z.string().uuid(), providerId: z.string().uuid(),
  providerKey: z.enum(["clutchpacks", "courtyard", "collector_crypt", "phygitals"]),
  configId: z.string().uuid(), initialRunId: z.string().uuid(), operationId: z.string().uuid(),
  operatorId: z.string().uuid(),
}).strict();
export type BackfillPins = z.infer<typeof backfillPinsSchema>;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
export const backfillIntentSchema = z.object({
  pins: backfillPinsSchema, authorityDigest: hash, parentRunId: z.string().uuid(),
  runId: z.string().uuid(), configNumber: z.string().regex(/^[1-9][0-9]*$/u),
  generation: z.string().regex(/^(0|[1-9][0-9]*)$/u), checkpointHash: hash,
  failureCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/u),
  retryNumber: z.number().int().positive(), consecutiveNoProgress: z.number().int().positive(),
  notBefore: z.string().datetime(), createdAt: z.string().datetime(),
  kind: z.enum(["transient_retry", "page_bound_continuation"]),
}).strict();
export type BackfillIntent = z.infer<typeof backfillIntentSchema>;

export interface BackfillSnapshot {
  readonly now: Date;
  readonly providerId: string;
  readonly providerKey: string;
  readonly configId: string | null;
  readonly configNumber: bigint | null;
  readonly configurationMatches: boolean;
  readonly state: string;
  readonly generation: bigint;
  /** Captured by live reads; required by the optional exact-head handoff. */
  readonly runtimeRowVersion?: bigint;
  readonly checkpointHash: string | null;
  readonly checkpointValid: boolean;
  readonly activeRunIds: readonly string[];
  readonly actionableCommands: readonly { id: string; runId: string | null }[];
  readonly lease: { owner: string | null; fence: bigint; expiresAt: Date | null };
  readonly run: {
    id: string; configId: string; configNumber: bigint; state: string; fence: bigint;
    requestedHash: string | null; requestedMatches: boolean; finalHash: string | null; finalMatches: boolean;
    reachedHead: boolean; pageCount: number; accepted: number;
    failureCode: string | null; finishedAt: Date | null; committedPageCount: number;
  };
  readonly lastPage: { number: number; continuation: string; hash: string | null; matches: boolean } | null;
  readonly headProof?: { runId: string; sourceRunId: string; checkpointHash: string | null; reconciliationComplete: boolean } | null;
}

export function assertBackfillPins(snapshot: BackfillSnapshot, pins: BackfillPins, configNumber: bigint): void {
  if (snapshot.providerId !== pins.providerId || snapshot.providerKey !== pins.providerKey ||
    snapshot.configId !== pins.configId || snapshot.configNumber !== configNumber ||
    snapshot.run.configId !== pins.configId || snapshot.run.configNumber !== configNumber ||
    !snapshot.configurationMatches || !snapshot.checkpointValid || !snapshot.run.requestedMatches) refuseBackfill("BACKFILL_CONFIGURATION_OR_CHECKPOINT_DRIFT");
}

export function classifyBackfillCheckpoint(snapshot: BackfillSnapshot): "head" | "operator_stop" | "transient_retry" | "page_bound_continuation" | "execute" {
  if (snapshot.state === "paused" || snapshot.state === "stopped") return "operator_stop";
  const run = snapshot.run;
  const ownHeadPage = snapshot.lastPage?.continuation === "head" && snapshot.lastPage.matches &&
    snapshot.lastPage.number === run.pageCount && snapshot.lastPage.hash === snapshot.checkpointHash;
  const proof = snapshot.headProof;
  const provenHead = proof?.runId === run.id && proof.checkpointHash === snapshot.checkpointHash &&
    (proof.sourceRunId === run.id ? ownHeadPage : run.pageCount === 0 && snapshot.lastPage === null &&
      run.requestedHash === snapshot.checkpointHash);
  if (run.state === "succeeded" && run.reachedHead && snapshot.activeRunIds.length === 0 &&
    snapshot.actionableCommands.length === 0 && snapshot.lease.owner === null &&
    (ownHeadPage || (provenHead && proof?.reconciliationComplete === true)) &&
    run.finalMatches && run.finalHash === snapshot.checkpointHash) return "head";
  if (run.state === "running" && run.reachedHead && provenHead && snapshot.state === "running" &&
    snapshot.activeRunIds.length === 1 && snapshot.activeRunIds[0] === run.id &&
    snapshot.actionableCommands.every(command => command.runId === run.id)) return "execute";
  if ((run.state === "queued" || run.state === "running") && !run.reachedHead &&
    snapshot.activeRunIds.length === 1 && snapshot.activeRunIds[0] === run.id &&
    (run.state === "queued" ? snapshot.state === "idle" && run.requestedHash === snapshot.checkpointHash
      : snapshot.state === "running" && (run.pageCount === 0 ? run.requestedHash === snapshot.checkpointHash
        : snapshot.lastPage?.matches && snapshot.lastPage.number === run.pageCount && snapshot.lastPage.hash === snapshot.checkpointHash))) return "execute";
  // A run that reached head and committed nothing leaves the checkpoint exactly
  // where it started, so a transient failure at that point is as safe to retry
  // as one before head. Without this a head-reaching commit failure matches no
  // classification branch at all and latches the provider on an intact
  // checkpoint: collector_crypt sat blocked for 16 hours this way.
  const headWithoutCommit = run.reachedHead && run.pageCount === 0 &&
    run.requestedHash === snapshot.checkpointHash;
  if (run.state !== "failed" || (run.reachedHead && !headWithoutCommit) ||
    !run.finishedAt || snapshot.state !== "error" ||
    snapshot.activeRunIds.length !== 0 || snapshot.actionableCommands.length !== 0 ||
    !run.finalMatches || run.finalHash !== snapshot.checkpointHash || !snapshot.checkpointHash ||
    (run.pageCount > 0 && (!snapshot.lastPage?.matches || snapshot.lastPage.number !== run.pageCount ||
      snapshot.lastPage.continuation !== "more" || snapshot.lastPage.hash !== snapshot.checkpointHash ||
      run.requestedHash === snapshot.checkpointHash))) {
    refuseBackfill("BACKFILL_TERMINAL_CHECKPOINT_UNSAFE");
  }
  if (transientBackfillCodes.has(run.failureCode ?? "")) return "transient_retry";
  if (run.failureCode === "PROVIDER_IMPORT_PAGE_LIMIT_EXCEEDED" && run.pageCount === 50_000 &&
    run.committedPageCount === 50_000 && snapshot.lastPage?.number === 50_000 && snapshot.lastPage.continuation === "more" &&
    run.requestedHash !== snapshot.checkpointHash) return "page_bound_continuation";
  return refuseBackfill("BACKFILL_PERMANENT_FAILURE");
}

export function assertBackfillLeaseAvailable(snapshot: BackfillSnapshot, allowedExpiredOwners: ReadonlySet<string>): void {
  const lease = snapshot.lease;
  if (lease.owner === null && lease.expiresAt === null) return;
  if (lease.owner === null || lease.expiresAt === null || lease.expiresAt > snapshot.now ||
    !allowedExpiredOwners.has(lease.owner)) refuseBackfill("BACKFILL_LEASE_UNAVAILABLE");
}

export function createBackfillIntent(input: {
  pins: BackfillPins; authorityDigest: string; snapshot: BackfillSnapshot;
  previous: BackfillIntent | null; jitter: number;
}): BackfillIntent {
  const kind = classifyBackfillCheckpoint(input.snapshot);
  if (kind !== "transient_retry" && kind !== "page_bound_continuation") refuseBackfill("BACKFILL_RETRY_NOT_REQUIRED");
  const s = input.snapshot;
  const noProgress = input.previous?.checkpointHash === s.checkpointHash
    ? input.previous.consecutiveNoProgress + 1 : 1;
  const delay = kind === "transient_retry" ? backfillDelayMilliseconds(noProgress, input.jitter) : 5_000;
  return backfillIntentSchema.parse({ pins: input.pins, authorityDigest: input.authorityDigest,
    parentRunId: s.run.id, runId: backfillId(input.pins.operationId, `run/${s.run.id}`),
    configNumber: s.configNumber?.toString(), generation: s.generation.toString(),
    checkpointHash: s.checkpointHash, failureCode: s.run.failureCode,
    retryNumber: (input.previous?.retryNumber ?? 0) + 1, consecutiveNoProgress: noProgress,
    createdAt: s.now.toISOString(), notBefore: new Date(s.now.getTime() + delay).toISOString(), kind });
}
