import { performance } from "node:perf_hooks";
import { z } from "zod";
import { assertBackfillPins, classifyBackfillCheckpoint, ProviderBackfillSupervisorError,
  refuseBackfill, type BackfillPins } from "./provider-backfill-supervisor-policy.mts";
import type { ContinuousView } from "./provider-continuous-policy.mts";
import { continuousPostHeadPolicySchema, defaultContinuousPostHeadPolicy,
  type ContinuousPostHeadPolicy } from "./provider-continuous-post-head-policy.mts";

export { continuousPostHeadMaximumMilliseconds } from "./provider-continuous-post-head-policy.mts";
const postHeadSchema = z.object({
  providerId: z.string().uuid(), configId: z.string().uuid(),
  configNumber: z.string().regex(/^[1-9][0-9]*$/u), runId: z.string().uuid(),
  checkpointHash: z.string().regex(/^[a-f0-9]{64}$/u),
  generation: z.string().regex(/^(0|[1-9][0-9]*)$/u),
  runtimeRowVersion: z.string().regex(/^[1-9][0-9]*$/u),
  headFinishedAt: z.string().datetime(), authorityDigest: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict().readonly();

/** Contains no source cursor, credentials, connection metadata, or mutable view. */
export type ContinuousPostHead = z.infer<typeof postHeadSchema>;
export interface ContinuousPostHeadRegistration {
  readonly policyFingerprint: string;
  readonly timeoutMilliseconds: number;
  run(head: ContinuousPostHead, signal: AbortSignal): Promise<void>;
}

/** Startup and invocation share the same immutable, audit-safe callback policy. */
export function continuousPostHeadPolicyForRegistration(
  registration?: ContinuousPostHeadRegistration,
): ContinuousPostHeadPolicy {
  if (registration === undefined) return defaultContinuousPostHeadPolicy;
  if (!registration || typeof registration.run !== "function") refuseBackfill("CONTINUOUS_POST_HEAD_INVALID");
  const parsed = continuousPostHeadPolicySchema.safeParse({ kind: "callback", fingerprint: registration.policyFingerprint,
    timeoutMilliseconds: registration.timeoutMilliseconds });
  if (!parsed.success) refuseBackfill("CONTINUOUS_POST_HEAD_INVALID");
  return Object.freeze(parsed.data);
}

function verifiedPostHead(view: ContinuousView, pins: BackfillPins): ContinuousPostHead {
  const snapshot = view.snapshot;
  assertBackfillPins(snapshot, pins, snapshot.run.configNumber);
  if (snapshot.state !== "idle" || snapshot.checkpointHash === null || snapshot.lease.expiresAt !== null ||
    !snapshot.run.finishedAt || !Number.isFinite(snapshot.run.finishedAt.getTime()) ||
    classifyBackfillCheckpoint(snapshot) !== "head") refuseBackfill("CONTINUOUS_HEAD_REQUIRED");
  const result = postHeadSchema.safeParse({ providerId: snapshot.providerId, configId: snapshot.configId,
    configNumber: snapshot.run.configNumber.toString(), runId: snapshot.run.id, checkpointHash: snapshot.checkpointHash,
    generation: snapshot.generation.toString(), headFinishedAt: snapshot.run.finishedAt.toISOString(),
    runtimeRowVersion: snapshot.runtimeRowVersion?.toString(),
    authorityDigest: view.authorityDigest });
  if (!result.success) refuseBackfill("CONTINUOUS_POST_HEAD_INVALID");
  return result.data;
}

/** One awaited invocation per call. Cancellation requests stop, but never detach
 * work: even a callback that ignores abort must settle before this rejects.
 * The resident owns invocation ordering and latches any rejected hook. */
export async function runContinuousPostHead(input: Readonly<{
  registration?: ContinuousPostHeadRegistration;
  view: ContinuousView;
  pins: BackfillPins;
  parentAbortSignal: AbortSignal;
}>): Promise<void> {
  const registration = input.registration;
  const policy = continuousPostHeadPolicyForRegistration(registration);
  if (registration === undefined || policy.kind === "none") return;
  const head = verifiedPostHead(input.view, input.pins);
  if (input.parentAbortSignal.aborted) refuseBackfill("CONTINUOUS_POST_HEAD_ABORTED");
  const controller = new AbortController();
  const deadline = performance.now() + policy.timeoutMilliseconds;
  let stopCode: "CONTINUOUS_POST_HEAD_ABORTED" | "CONTINUOUS_POST_HEAD_TIMEOUT" | null = null;
  const stop = (code: NonNullable<typeof stopCode>) => {
    stopCode ??= code;
    if (!controller.signal.aborted) controller.abort(new ProviderBackfillSupervisorError(stopCode));
  };
  const parentStopped = () => stop("CONTINUOUS_POST_HEAD_ABORTED");
  input.parentAbortSignal.addEventListener("abort", parentStopped, { once: true });
  const timer = setTimeout(() => stop("CONTINUOUS_POST_HEAD_TIMEOUT"), policy.timeoutMilliseconds);
  let failed = false;
  try {
    if (input.parentAbortSignal.aborted) parentStopped();
    if (stopCode === null) {
      try { await registration.run(head, controller.signal); }
      catch { failed = true; }
    }
    // A synchronous callback can occupy the event loop past the deadline before
    // its timer runs. A late fulfillment or rejection never becomes success.
    if (performance.now() >= deadline) stop("CONTINUOUS_POST_HEAD_TIMEOUT");
    if (input.parentAbortSignal.aborted) parentStopped();
  } finally {
    clearTimeout(timer);
    input.parentAbortSignal.removeEventListener("abort", parentStopped);
  }
  if (stopCode !== null) refuseBackfill(stopCode);
  if (failed) refuseBackfill("CONTINUOUS_POST_HEAD_FAILED");
}
