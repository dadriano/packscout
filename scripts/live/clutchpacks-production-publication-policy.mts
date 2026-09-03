import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { approvedPublicCatalogConfigurationV1Schema, canonicalJson } from "@packscout/contracts";
import type { PrismaProviderWorkerLeaseRepository, ProviderWorkerLease } from "@packscout/database";
import type { DataReleaseV3ActiveState } from "@packscout/services";

/** Operator-owned, scoped production boundary. A new source configuration needs
 * a reviewed successor to this v1 policy; this is not a generic provider route. */
export const CLUTCHPACKS_PRODUCTION_SCOPE = Object.freeze({
  organizationId: "3c9fa4d3-fe16-569c-8cfa-b4a44c63eb4a",
  providerId: "14787a87-77c0-5771-bfe1-cd5507bf2881",
  providerKey: "clutchpacks",
  configId: "de37fd7f-4461-4df1-86e6-6609486df4b7",
  configVersion: "4",
} as const);
export const CLUTCHPACKS_PRODUCTION_TARGET = Object.freeze({
  cloudUrl: "https://shiny-newt-310.convex.cloud",
  siteUrl: "https://shiny-newt-310.convex.site",
} as const);

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const sequence = z.string().regex(/^(0|[1-9][0-9]{0,19})$/u);
const iso = z.string().datetime().refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const count = z.number().int().safe().nonnegative();
const identity = z.object({ publicReleaseId: z.uuid(), releaseFingerprint: hash }).strict();
const predecessor = z.object({ generation: count, publicReleaseId: z.uuid().nullable(),
  releaseFingerprint: hash.nullable() }).strict().refine(value =>
  (value.publicReleaseId === null) === (value.releaseFingerprint === null));
const source = z.object({
  runId: z.uuid(), checkpointHash: hash, stateGeneration: sequence,
  promotionSequence: sequence, stabilityFingerprint: hash, lastHeadReachedAt: iso,
  qualityState: z.enum(["healthy", "degraded", "unhealthy", "unknown"]), quarantineCount: count,
}).strict().refine(value => value.quarantineCount === 0 || value.qualityState !== "healthy");
const scope = z.object({
  organizationId: z.literal(CLUTCHPACKS_PRODUCTION_SCOPE.organizationId),
  providerId: z.literal(CLUTCHPACKS_PRODUCTION_SCOPE.providerId),
  providerKey: z.literal(CLUTCHPACKS_PRODUCTION_SCOPE.providerKey),
  configId: z.literal(CLUTCHPACKS_PRODUCTION_SCOPE.configId),
  configVersion: z.literal(CLUTCHPACKS_PRODUCTION_SCOPE.configVersion),
}).strict();
const target = z.object({ cloudUrl: z.literal(CLUTCHPACKS_PRODUCTION_TARGET.cloudUrl),
  siteUrl: z.literal(CLUTCHPACKS_PRODUCTION_TARGET.siteUrl) }).strict();
export const clutchpacksProductionPublicationIntentSchema = z.object({
  schemaVersion: z.literal("clutchpacks_production_publication_v1"),
  operationId: z.uuid(), target, scope, readAt: iso, source,
  approvedConfigurationSha256: hash,
  candidate: identity.extend({ planSha256: hash }).strict(), predecessor,
}).strict().refine(value => value.readAt >= value.source.lastHeadReachedAt);
export type ClutchpacksProductionPublicationIntent = z.infer<typeof clutchpacksProductionPublicationIntentSchema>;
export type ClutchpacksProductionSourcePins = z.infer<typeof source>;

export type ClutchpacksProductionPublicationFailure =
  | "PRODUCTION_INTENT_INVALID" | "PRODUCTION_REPLAY_CONFLICT"
  | "PRODUCTION_SOURCE_CHANGED" | "PRODUCTION_CONFIGURATION_CHANGED"
  | "PRODUCTION_PLAN_CHANGED" | "PRODUCTION_PREDECESSOR_CHANGED"
  | "PRODUCTION_READBACK_MISMATCH" | "PRODUCTION_SOURCE_NOT_QUIET"
  | "PRODUCTION_IMPORT_LEASE_UNAVAILABLE" | "PRODUCTION_IMPORT_LEASE_LOST"
  | "PRODUCTION_IMPORT_LEASE_ATTEMPT_PERSIST_FAILED" | "PRODUCTION_IMPORT_LEASE_ACQUIRE_UNKNOWN"
  | "PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED"
  | "PRODUCTION_IMPORT_LEASE_RELEASE_FAILED" | "PRODUCTION_PUBLICATION_FAILED"
  | "PRODUCTION_BACKEND_NOT_READY" | "PRODUCTION_PUBLIC_EV_INVALID" | "PRODUCTION_OBSERVATION_INVALID"
  | "PRODUCTION_VERIFICATION_FAILED_ROLLED_BACK" | "PRODUCTION_VERIFICATION_RECOVERY_REQUIRED";
export class ClutchpacksProductionPublicationError extends Error {
  constructor(readonly code: ClutchpacksProductionPublicationFailure) {
    super("ClutchPacks production publication was refused safely.");
    this.name = "ClutchpacksProductionPublicationError";
  }
}
function refuse(code: ClutchpacksProductionPublicationFailure): never {
  throw new ClutchpacksProductionPublicationError(code);
}
export function parseClutchpacksProductionPublicationIntent(value: unknown): ClutchpacksProductionPublicationIntent {
  const parsed = clutchpacksProductionPublicationIntentSchema.safeParse(value);
  if (!parsed.success) return refuse("PRODUCTION_INTENT_INVALID");
  return parsed.data;
}
/** Raw SHA256 of canonical JSON, including full artifact bytes, not a filename. */
export function productionPublicationSha256(value: unknown): string {
  try { return createHash("sha256").update(canonicalJson(value)).digest("hex"); }
  catch { return refuse("PRODUCTION_INTENT_INVALID"); }
}
export function productionPublicationIdempotencyKey(value: unknown): string {
  const intent = parseClutchpacksProductionPublicationIntent(value);
  return `clutchpacks-production:${intent.operationId}:${productionPublicationSha256(intent)}`;
}
/** Persist the first reviewed intent; never replace it on an uncertain retry. */
export function assertClutchpacksProductionIntentReplay(previous: unknown, next: unknown): void {
  if (productionPublicationIdempotencyKey(previous) !== productionPublicationIdempotencyKey(next)) {
    refuse("PRODUCTION_REPLAY_CONFLICT");
  }
}
function pointer(value: DataReleaseV3ActiveState["activeRelease"]) {
  if (value === null) return { publicReleaseId: null, releaseFingerprint: null };
  const parsed = identity.safeParse({ publicReleaseId: value?.publicReleaseId,
    releaseFingerprint: value?.releaseFingerprint });
  if (!parsed.success) return refuse("PRODUCTION_PREDECESSOR_CHANGED");
  return parsed.data;
}
type NullableReleaseIdentity = { readonly publicReleaseId: string | null; readonly releaseFingerprint: string | null };
function sameIdentity(left: NullableReleaseIdentity, right: NullableReleaseIdentity) {
  return left.publicReleaseId === right.publicReleaseId && left.releaseFingerprint === right.releaseFingerprint;
}
export function assertClutchpacksProductionPredecessor(value: unknown, state: DataReleaseV3ActiveState): "publish" | "already_active" {
  const intent = parseClutchpacksProductionPublicationIntent(value);
  if (!state || !count.safeParse(state.generation).success) return refuse("PRODUCTION_PREDECESSOR_CHANGED");
  const active = pointer(state.activeRelease);
  if (state.generation === intent.predecessor.generation && sameIdentity(active, intent.predecessor)) {
    return sameIdentity(active, intent.candidate) ? "already_active" : "publish";
  }
  // An uncertain completed activation may be replayed only with the exact
  // predecessor and one generation advance. Returning to the same ID is not enough.
  if (state.generation === intent.predecessor.generation + 1 &&
    sameIdentity(active, intent.candidate) && sameIdentity(pointer(state.previousRelease), intent.predecessor)) {
    return "already_active";
  }
  return refuse("PRODUCTION_PREDECESSOR_CHANGED");
}
export function assertClutchpacksProductionBindings(value: unknown, observed: {
  readonly scope: unknown; readonly source: unknown; readonly approvedConfiguration: unknown; readonly plan: unknown;
  readonly activeState: DataReleaseV3ActiveState;
}): "publish" | "already_active" {
  const intent = parseClutchpacksProductionPublicationIntent(value);
  if (!scope.safeParse(observed.scope).success) return refuse("PRODUCTION_SOURCE_CHANGED");
  const actualSource = source.safeParse(observed.source);
  if (!actualSource.success || canonicalJson(actualSource.data) !== canonicalJson(intent.source)) {
    return refuse("PRODUCTION_SOURCE_CHANGED");
  }
  const configuration = approvedPublicCatalogConfigurationV1Schema.safeParse(observed.approvedConfiguration);
  if (!configuration.success || configuration.data.platforms.length !== 1 ||
    configuration.data.platforms[0]!.platformKey !== "clutchpacks" ||
    configuration.data.platforms[0]!.vendor.vendorKey !== "clutchpacks" ||
    productionPublicationSha256(configuration.data) !== intent.approvedConfigurationSha256) {
    return refuse("PRODUCTION_CONFIGURATION_CHANGED");
  }
  const plan = identity.passthrough().safeParse(observed.plan);
  if (!plan.success || !sameIdentity(plan.data, intent.candidate) ||
    productionPublicationSha256(observed.plan) !== intent.candidate.planSha256) {
    return refuse("PRODUCTION_PLAN_CHANGED");
  }
  return assertClutchpacksProductionPredecessor(intent, observed.activeState);
}
/** Only call after complete public identity/EV witness readback. This contract
 * deliberately excludes arbitrary diagnostics, credentials, raw cursors or rows. */
export function buildClutchpacksProductionPublicationReceipt(value: unknown, evidence: {
  readonly activeState: DataReleaseV3ActiveState; readonly verifiedAt: string;
  readonly publicReadbackSha256: string; readonly repackCount: number;
}) {
  const intent = parseClutchpacksProductionPublicationIntent(value);
  if (assertClutchpacksProductionPredecessor(intent, evidence.activeState) !== "already_active" ||
    !iso.safeParse(evidence.verifiedAt).success || evidence.verifiedAt < intent.readAt ||
    !hash.safeParse(evidence.publicReadbackSha256).success || !count.safeParse(evidence.repackCount).success) {
    return refuse("PRODUCTION_READBACK_MISMATCH");
  }
  return { schemaVersion: "clutchpacks_production_publication_receipt_v1" as const,
    status: "verified" as const, operationId: intent.operationId,
    intentSha256: productionPublicationSha256(intent), target: intent.target, scope: intent.scope,
    readAt: intent.readAt, source: intent.source, candidate: intent.candidate,
    approvedConfigurationSha256: intent.approvedConfigurationSha256,
    generation: evidence.activeState.generation, verifiedAt: evidence.verifiedAt,
    publicReadbackSha256: evidence.publicReadbackSha256, repackCount: evidence.repackCount };
}

export type ClutchpacksProductionLeasePort = Pick<PrismaProviderWorkerLeaseRepository, "acquire" | "renew" | "release">;
export type ClutchpacksProductionOwnedImportLease = Pick<ProviderWorkerLease, "owner" | "role" | "fence">;
export interface ClutchpacksProductionLeaseAttempt {
  readonly attemptId: string;
  readonly intentSha256: string;
  readonly request: { readonly role: "import"; readonly owner: string; readonly leaseMilliseconds: number };
  readonly requestSha256: string;
}
/** Initial quiet proof precedes acquisition; the adapter revalidates source,
 * authority and exact ownership on every periodic renewal. Dispatch checks use
 * only the bounded monotonic proof and join any renewal already in flight. */
export async function withClutchpacksProductionPublicationLease<T>(input: {
  readonly intent: unknown; readonly port: ClutchpacksProductionLeasePort;
  /** Persist the exact owner before an acquire that may commit without returning. */
  readonly prepareLeaseAttempt: (attempt: ClutchpacksProductionLeaseAttempt) => Promise<void>;
  readonly assertSourceQuiet: (ownedLease?: ClutchpacksProductionOwnedImportLease) => Promise<void>;
  readonly operation: (lease: ClutchpacksProductionOwnedImportLease, assertLive: () => Promise<void>,
    assertNotLost: () => void) => Promise<T>;
  readonly monotonicNow?: () => number;
}): Promise<T> {
  const intent = parseClutchpacksProductionPublicationIntent(input.intent);
  try { await input.assertSourceQuiet(); } catch { return refuse("PRODUCTION_SOURCE_NOT_QUIET"); }
  const attemptId = randomUUID();
  const owner = `production-publication:${intent.operationId}:${attemptId}`;
  const leaseMilliseconds = 15 * 60_000;
  const request = Object.freeze({ role: "import" as const, owner, leaseMilliseconds });
  try { await input.prepareLeaseAttempt(Object.freeze({ attemptId, intentSha256: productionPublicationSha256(intent),
    request, requestSha256: productionPublicationSha256(request) })); }
  catch { return refuse("PRODUCTION_IMPORT_LEASE_ATTEMPT_PERSIST_FAILED"); }
  let failure: ClutchpacksProductionPublicationError | null = null;
  const lose = (): never => { failure ??= new ClutchpacksProductionPublicationError("PRODUCTION_IMPORT_LEASE_LOST"); throw failure; };
  let lastMonotonic = -1;
  const monotonic = () => {
    let now: number;
    try { now = (input.monotonicNow ?? (() => performance.now()))(); } catch { return lose(); }
    if (!Number.isFinite(now) || now < 0 || now < lastMonotonic) return lose();
    lastMonotonic = now; return now;
  };
  // Start before the queued adapter call so database/postcheck/queue latency
  // consumes validity rather than extending it at response time.
  const acquiredStarted = monotonic();
  let acquired;
  try { acquired = await input.port.acquire(request); }
  catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED") {
      return refuse("PRODUCTION_SOURCE_LEASE_CLEANUP_UNCONFIRMED");
    }
    return refuse("PRODUCTION_IMPORT_LEASE_ACQUIRE_UNKNOWN");
  }
  if (acquired === null || typeof acquired !== "object") return refuse("PRODUCTION_IMPORT_LEASE_ACQUIRE_UNKNOWN");
  if (acquired.kind === "held") return refuse("PRODUCTION_IMPORT_LEASE_UNAVAILABLE");
  if (acquired.kind !== "acquired" || acquired.lease?.owner !== owner || acquired.lease?.role !== "import" ||
    typeof acquired.lease?.fence !== "bigint" || acquired.lease.fence < 1n) return refuse("PRODUCTION_IMPORT_LEASE_ACQUIRE_UNKNOWN");
  const lease: ClutchpacksProductionOwnedImportLease = Object.freeze({ role: "import", owner, fence: acquired.lease.fence });
  let proof: { deadline: number; heartbeatAt: number; expiresAt: number } | undefined;
  const acceptProof = (returned: ProviderWorkerLease | null, started: number) => {
    if (failure !== null) throw failure;
    if (returned === null || returned.owner !== owner || returned.role !== "import" || returned.fence !== lease.fence) return lose();
    const heartbeatAt = returned.heartbeatAt instanceof Date ? returned.heartbeatAt.getTime() : NaN;
    const expiresAt = returned.expiresAt instanceof Date ? returned.expiresAt.getTime() : NaN;
    const duration = expiresAt - heartbeatAt;
    const deadline = started + duration - 15_000;
    const receivedAt = monotonic();
    if (!Number.isFinite(heartbeatAt) || !Number.isFinite(expiresAt) || !Number.isSafeInteger(duration) ||
      duration <= 15_000 || duration > leaseMilliseconds || !Number.isFinite(deadline) || deadline <= receivedAt ||
      (proof !== undefined && (receivedAt >= proof.deadline || heartbeatAt <= proof.heartbeatAt || expiresAt <= proof.expiresAt))) return lose();
    // Copy primitives: retaining mutable Date objects could change accepted proof.
    proof = { deadline, heartbeatAt, expiresAt };
  };
  const assertNotLost = () => {
    if (failure !== null) throw failure;
    const now = monotonic();
    if (proof === undefined || now >= proof.deadline) return lose();
    return now;
  };
  let pending: Promise<void> | null = null;
  const renew = (): Promise<void> => {
    if (pending !== null) return pending;
    const started = assertNotLost();
    pending = (async () => {
      try { acceptProof(await input.port.renew({ ...lease, leaseMilliseconds }), started); }
      catch { return lose(); }
    })().finally(() => { pending = null; });
    return pending;
  };
  const assertLive = async () => {
    if (pending !== null) await pending;
    const now = assertNotLost();
    if (proof!.deadline - now <= 30_000) {
      await renew(); assertNotLost();
    }
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    // From this point ownership is known: even invalid date/latency proof gets
    // normal exact-fence cleanup, never an invented force-clear or reacquire.
    acceptProof(acquired.lease, acquiredStarted);
    timer = setInterval(() => {
      try { void renew().catch(() => undefined); } catch { /* Expiry/loss is already latched. */ }
    }, 30_000);
    const result = await input.operation(lease, assertLive, assertNotLost);
    await assertLive();
    return result;
  } catch (error) {
    if (error instanceof ClutchpacksProductionPublicationError) throw error;
    return refuse("PRODUCTION_PUBLICATION_FAILED");
  } finally {
    if (timer !== undefined) clearInterval(timer);
    await Promise.resolve(pending).catch(() => undefined);
    let released = false;
    try { released = await input.port.release(lease); } catch { /* No raw transport error may escape. */ }
    if (!released) refuse("PRODUCTION_IMPORT_LEASE_RELEASE_FAILED");
  }
}
