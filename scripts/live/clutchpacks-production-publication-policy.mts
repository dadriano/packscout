import { createHash, randomUUID } from "node:crypto";
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
  qualityState: z.enum(["healthy", "degraded"]), quarantineCount: count,
}).strict().refine(value => value.quarantineCount === 0 || value.qualityState === "degraded");
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
/** Caller checks process ownership/quiet source without changing operator state.
 * Call assertLive before every publication write and revalidate source pins there.
 * Lease renewals serialize; loss is latched and cannot reacquire a newer fence. */
export async function withClutchpacksProductionPublicationLease<T>(input: {
  readonly intent: unknown; readonly port: ClutchpacksProductionLeasePort;
  /** Persist the exact generated owner before an acquire that may commit without
   * returning. A failed or uncertain acquire must never generate a silent retry. */
  readonly prepareLeaseAttempt: (attempt: ClutchpacksProductionLeaseAttempt) => Promise<void>;
  readonly assertSourceQuiet: (ownedLease?: ClutchpacksProductionOwnedImportLease) => Promise<void>;
  readonly operation: (lease: ClutchpacksProductionOwnedImportLease, assertLive: () => Promise<void>,
    assertNotLost: () => void) => Promise<T>;
}): Promise<T> {
  const intent = parseClutchpacksProductionPublicationIntent(input.intent);
  const quiet = async (ownedLease?: ClutchpacksProductionOwnedImportLease) => {
    try { await input.assertSourceQuiet(ownedLease); }
    catch { return refuse("PRODUCTION_SOURCE_NOT_QUIET"); }
  };
  await quiet();
  // Unique process owner prevents concurrent attempts sharing an operation ID
  // from renewing each other's lease. Cloud operation identities remain stable.
  const attemptId = randomUUID();
  const owner = `production-publication:${intent.operationId}:${attemptId}`;
  const leaseMilliseconds = 15 * 60_000;
  const request = Object.freeze({ role: "import" as const, owner, leaseMilliseconds });
  try { await input.prepareLeaseAttempt(Object.freeze({ attemptId, intentSha256: productionPublicationSha256(intent),
    request, requestSha256: productionPublicationSha256(request) })); }
  catch { return refuse("PRODUCTION_IMPORT_LEASE_ATTEMPT_PERSIST_FAILED"); }
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
  const lease: ClutchpacksProductionOwnedImportLease = { role: "import", owner, fence: acquired.lease.fence };
  let failure: ClutchpacksProductionPublicationError | null = null;
  let pending: Promise<void> | null = null;
  // Recheck after asynchronous reads and immediately before dispatching a write.
  // This observes background failures without starting another database round trip.
  const assertNotLost = () => { if (failure !== null) throw failure; };
  const assertLive = async () => {
    assertNotLost();
    pending ??= (async () => {
      try {
        await quiet(lease);
        const renewed = await input.port.renew({ ...lease, leaseMilliseconds });
        if (renewed === null || renewed.owner !== owner || renewed.role !== "import" || renewed.fence !== lease.fence) {
          return refuse("PRODUCTION_IMPORT_LEASE_LOST");
        }
      } catch (error) {
        failure = error instanceof ClutchpacksProductionPublicationError ? error
          : new ClutchpacksProductionPublicationError("PRODUCTION_IMPORT_LEASE_LOST");
      }
    })().finally(() => { pending = null; });
    await pending;
    assertNotLost();
  };
  const timer = setInterval(() => { void assertLive().catch(() => undefined); }, 30_000);
  try {
    await assertLive();
    const result = await input.operation(lease, assertLive, assertNotLost);
    await assertLive();
    return result;
  } catch (error) {
    if (error instanceof ClutchpacksProductionPublicationError) throw error;
    return refuse("PRODUCTION_PUBLICATION_FAILED");
  } finally {
    clearInterval(timer);
    await pending;
    let released = false;
    try { released = await input.port.release(lease); } catch { /* No raw transport error may escape. */ }
    if (!released) refuse("PRODUCTION_IMPORT_LEASE_RELEASE_FAILED");
  }
}
