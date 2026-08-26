import {
  providerSourceSingletonTiming,
  providerSourceSupervisorDefaults,
  providerSourceTransientRetryPolicy,
  type NormalizedContinuation,
} from "@packscout/contracts";
import {
  ConnectionPermitCoordinator,
  ConnectionPermitCoordinatorError,
} from "./connection-permit-coordinator.ts";
import {
  ControlPlaneRetryExhaustedError,
  type ControlPlaneFailureCode,
  ControlPlaneTransactionError,
  RuntimeControlPlaneFence,
  RuntimeLocallyFencedError,
  runControlPlaneTransaction,
} from "./control-plane-retry.ts";
import {
  SourceRequestLeaseAuthority,
  SourceRequestLeaseError,
} from "./source-request-lease.ts";

export interface SourceSupervisorEpoch {
  readonly epochId: string;
  readonly epochNumber: number;
  readonly ownerKey: string;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
}

export interface SourceSupervisorWorkItem {
  readonly id: string;
  readonly kind: "connection_test" | "source_test" | "page_read";
  readonly queuedAt: Date;
  readonly organizationId: string;
  readonly connectionProfileId: string;
  readonly connectionRevisionId: string;
  readonly profileRequestLimit: number;
  readonly sourceInstanceId?: string;
  readonly sourceRevisionId?: string;
  readonly runStartedAt?: Date;
  readonly committedPages?: number;
  readonly committedRecords?: number;
  readonly retryAttempt?: number;
  readonly sourceIntervalSeconds?: number;
}

export interface SourceSupervisorClaimCommand {
  readonly claimOwner: string;
  readonly claimToken: string;
  readonly claimLeaseId: string;
  readonly excludedProfiles?: readonly Readonly<{
    organizationId: string;
    connectionProfileId: string;
  }>[];
  readonly excludedSourceInstanceIds?: readonly string[];
  /** Leave page lanes durably queued while a fail-closed volume probe cools down. */
  readonly skipPageReads?: boolean;
}

export interface SourceSupervisorOwnershipPort {
  acquire(input: Readonly<{
    environmentKey: string;
    ownerKey: string;
    leaseToken: string;
  }>): Promise<SourceSupervisorEpoch>;
  renew(epoch: SourceSupervisorEpoch): Promise<Date>;
  fence(epoch: SourceSupervisorEpoch, safeReasonCode: string): Promise<void>;
  release(epoch: SourceSupervisorEpoch): Promise<void>;
  listReconcilablePredecessorAttempts(
    epoch: SourceSupervisorEpoch,
  ): Promise<readonly SourceSupervisorPredecessorAttempt[]>;
  reconcilePredecessorAttempt(
    epoch: SourceSupervisorEpoch,
    attempt: SourceSupervisorPredecessorAttempt,
  ): Promise<void>;
}

export interface SourceSupervisorPredecessorAttempt {
  readonly organizationId: string;
  readonly requestAttemptId: string;
}

export interface SourceSupervisorDueWork {
  readonly organizationId: string;
  readonly providerId: string;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly dueAt: Date;
}

export interface SourceSupervisorRecoverableClaim {
  readonly kind: "connection_test" | "source_test" | "page_read";
  readonly id: string;
}

export type SourceSupervisorUnstartedWaitReason =
  | "capacity_blocked"
  | "connection_blocked"
  | "graceful_shutdown"
  | "source_lane_busy";

export type SourceSupervisorWorkDisposition =
  | Readonly<{
      kind: "continued";
      continuationRunId: string;
      cursorFingerprint: string;
      pagesCommitted: number;
      recordsCommitted: number;
    }>
  | Readonly<{
      kind: "reached_head";
      cursorFingerprint: string | null;
      minimumDelaySeconds: number;
      pagesCommitted: number;
      recordsCommitted: number;
    }>
  | Readonly<{ kind: "paused" }>
  | Readonly<{
      kind: "retrying";
      retryAttempt: number;
      retryDelayMilliseconds: number;
      safeCode: string;
    }>
  | Readonly<{ kind: "action_required"; safeCode: string }>
  | Readonly<{ kind: "connection_blocked"; safeCode: string }>
  | Readonly<{ kind: "test_terminal" }>
  | Readonly<{ kind: "fenced" }>;

export interface SourceSupervisorWorkQueue<
  TWork extends SourceSupervisorWorkItem,
> {
  listDue(epoch: SourceSupervisorEpoch): Promise<readonly SourceSupervisorDueWork[]>;
  materializeDue(
    epoch: SourceSupervisorEpoch,
    due: SourceSupervisorDueWork,
    runId: string,
  ): Promise<"created" | "coalesced" | "unavailable">;
  listRecoverableClaims(
    epoch: SourceSupervisorEpoch,
  ): Promise<readonly SourceSupervisorRecoverableClaim[]>;
  recoverClaim(
    epoch: SourceSupervisorEpoch,
    claim: SourceSupervisorRecoverableClaim,
  ): Promise<void>;
  claimNext(
    epoch: SourceSupervisorEpoch,
    command: SourceSupervisorClaimCommand,
  ): Promise<TWork | null>;
  /** Null means the owning DB transaction durably recorded exact claim loss. */
  renewClaim(epoch: SourceSupervisorEpoch, work: TWork): Promise<Date | null>;
  releaseUnstarted(
    epoch: SourceSupervisorEpoch,
    work: TWork,
    reason: SourceSupervisorUnstartedWaitReason,
  ): Promise<void>;
  markAdmissionWaiting(
    epoch: SourceSupervisorEpoch,
    work: TWork,
    reason: "profile_capacity" | "execution_capacity",
  ): Promise<void>;
  markAdmissionGranted(
    epoch: SourceSupervisorEpoch,
    work: TWork,
  ): Promise<void>;
  complete(
    epoch: SourceSupervisorEpoch,
    work: TWork,
    disposition: SourceSupervisorWorkDisposition,
  ): Promise<SourceSupervisorWorkDisposition | void>;
}

export interface SourceSupervisorCapacityProbeInput<
  TWork extends SourceSupervisorWorkItem,
> {
  readonly phase: "before_request" | "after_commit";
  readonly epoch: SourceSupervisorEpoch;
  readonly work: TWork;
}

export type SourceSupervisorCapacityProbeResult =
  | Readonly<{ admitted: true }>
  | Readonly<{
      admitted: false;
      state: "blocked" | "probe_failed";
      safeCode: string;
    }>;

export interface SourceSupervisorCapacityAdmissionHook<
  TWork extends SourceSupervisorWorkItem,
> {
  probe(
    input: SourceSupervisorCapacityProbeInput<TWork>,
  ): Promise<SourceSupervisorCapacityProbeResult>;
}

export type SourceSupervisorExecutionResult =
  | Readonly<{
      kind: "page_committed";
      cursorFingerprint: string | null;
      continuation: NormalizedContinuation;
      pagesCommitted: number;
      recordsCommitted: number;
      pauseRequested: boolean;
    }>
  | Readonly<{ kind: "test_terminal" }>
  | Readonly<{ kind: "retryable"; safeCode: string }>
  | Readonly<{ kind: "source_action_required"; safeCode: string }>
  | Readonly<{ kind: "connection_action_required"; safeCode: string }>
  | Readonly<{ kind: "stale" }>
  | Readonly<{ kind: "fenced" }>;

export interface SourceSupervisorExecutionContext {
  readonly epoch: SourceSupervisorEpoch;
  readonly requestLeases: SourceRequestLeaseAuthority;
  readonly runtimeFence: RuntimeControlPlaneFence;
  readonly signal: AbortSignal;
  /** Publish after enqueue/grant/permit release/slot release. */
  readonly capacityChanged: () => Promise<void>;
  readonly admissionWaiting: (
    reason: "profile_capacity" | "execution_capacity",
  ) => Promise<void>;
  readonly admissionGranted: () => Promise<void>;
  /** Retain the generic slot until the supervisor's durable completion lands. */
  readonly retainExecutionSlot: (release: () => void) => void;
  /** Persist executor-owned boundaries such as the durable pre-call attempt. */
  readonly recordDiagnostic: (
    transition: "adapter_request_started",
    details: Readonly<{
      requestAttemptId: string;
      pageId?: string;
      safeCode?: string;
    }>,
  ) => Promise<void>;
}

export interface SourceSupervisorWorkExecutor<
  TWork extends SourceSupervisorWorkItem,
> {
  /** Resolve the immutable registered cap for the exact claimed adapter. */
  registeredProfileRequestLimit(work: TWork): number;
  execute(
    work: TWork,
    context: SourceSupervisorExecutionContext,
  ): Promise<SourceSupervisorExecutionResult>;
  abortAll(reason: "capacity" | "claim_lost" | "ownership_lost" | "shutdown"): void;
}

export interface SourceSupervisorSnapshotPort {
  publish(input: Readonly<{
    epoch: SourceSupervisorEpoch;
    capacity: ReturnType<ConnectionPermitCoordinator["snapshot"]>;
    admission: Readonly<{
      state: "available" | "blocked" | "probe_failed";
      safeCode: string | null;
    }>;
  }>): Promise<void>;
}

export type SourceSupervisorDiagnosticTransition =
  | "adapter_request_started"
  | "continuation_queued"
  | "head_reached"
  | "lease_lost"
  | "page_committed"
  | "pause_completed"
  | "retry_scheduled"
  | "terminal"
  | "work_claimed"
  | "work_due"
  | "work_queued"
  | "work_recovered";

/**
 * Source-neutral durable diagnostic boundary. Queue/executor adapters use the
 * same port for due/queue/request/page/recovery transitions that happen below
 * the generic loop; the loop records the ownership and turn transitions it
 * controls directly.
 */
export interface SourceSupervisorDiagnosticPort<
  TWork extends SourceSupervisorWorkItem,
> {
  record(input: Readonly<{
    epoch: SourceSupervisorEpoch;
    work: TWork;
    transition: SourceSupervisorDiagnosticTransition;
    disposition?: SourceSupervisorWorkDisposition;
    safeCode?: string;
    requestAttemptId?: string;
    pageId?: string;
  }>): Promise<void>;
}

export interface ProviderSourceSupervisorDependencies<
  TWork extends SourceSupervisorWorkItem,
> {
  readonly environmentKey: string;
  readonly ownerKey: string;
  readonly leaseToken: string;
  readonly ownership: SourceSupervisorOwnershipPort;
  readonly queue: SourceSupervisorWorkQueue<TWork>;
  readonly executor: SourceSupervisorWorkExecutor<TWork>;
  readonly capacity: SourceSupervisorCapacityAdmissionHook<TWork>;
  readonly snapshot: SourceSupervisorSnapshotPort;
  readonly diagnostics: SourceSupervisorDiagnosticPort<TWork>;
  readonly classifyControlPlaneFailure: (
    error: unknown,
  ) => ControlPlaneFailureCode;
  readonly ids: Readonly<{ id(): string }>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pollIntervalMilliseconds?: number;
  /** Test/runtime scheduling override; never greater than the launch bound. */
  readonly ownershipRenewalIntervalMilliseconds?: number;
  /** Test/runtime scheduling override; never greater than the launch bound. */
  readonly claimRenewalIntervalMilliseconds?: number;
  readonly claimLookahead?: number;
  readonly executionSlots?: number;
}

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;

function safeCode(value: string): string {
  if (!SAFE_CODE.test(value)) return "SOURCE_EXECUTION_FAILED";
  return value;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function workProfileKey(work: SourceSupervisorWorkItem): string {
  return JSON.stringify([work.organizationId, work.connectionProfileId]);
}

export class SourceSupervisorStaleWorkError extends Error {
  constructor() {
    super("provider_source_supervisor.stale_work");
    this.name = "SourceSupervisorStaleWorkError";
  }
}

/**
 * Source-neutral singleton loop. Adapter transport, credentials, cursor
 * grammar, mapping, and page persistence remain behind the executor port.
 */
export class ProviderSourceSupervisor<
  TWork extends SourceSupervisorWorkItem,
> {
  readonly #dependencies: ProviderSourceSupervisorDependencies<TWork>;
  readonly #coordinator: ConnectionPermitCoordinator;
  readonly #requestLeases: SourceRequestLeaseAuthority;
  readonly #runtimeFence = new RuntimeControlPlaneFence();
  readonly #activeSources = new Set<string>();
  readonly #activeTurns = new Set<Promise<void>>();
  readonly #activeProfileTurns = new Map<string, number>();
  #epoch: SourceSupervisorEpoch | null = null;
  #initialization: Promise<SourceSupervisorEpoch> | null = null;
  #stopPromise: Promise<void> | null = null;
  #fencePersistencePromise: Promise<boolean> | null = null;
  #fencedReleasePromise: Promise<void> | null = null;
  #cyclePromise: Promise<void> | null = null;
  #renewalTimer: ReturnType<typeof setInterval> | null = null;
  #renewalInFlight: Promise<void> | null = null;
  #pendingFenceReasonCode: string | null = null;
  #snapshotTail: Promise<void> = Promise.resolve();
  #capacityProbeNotBeforeMilliseconds = 0;
  #stopping = false;
  #fenceStarted = false;
  #admission: {
    state: "available" | "blocked" | "probe_failed";
    safeCode: string | null;
  } = { state: "available", safeCode: null };

  constructor(dependencies: ProviderSourceSupervisorDependencies<TWork>) {
    this.#coordinator = new ConnectionPermitCoordinator(
      dependencies.executionSlots,
    );
    this.#requestLeases = new SourceRequestLeaseAuthority(this.#coordinator);
    if (
      !dependencies.environmentKey.trim() ||
      !dependencies.ownerKey.trim() ||
      !dependencies.leaseToken.trim()
    ) {
      throw new TypeError("Source supervisor identity must not be blank.");
    }
    for (const [name, renewalInterval] of [
      ["Ownership", dependencies.ownershipRenewalIntervalMilliseconds],
      ["Claim", dependencies.claimRenewalIntervalMilliseconds],
    ] as const) {
      if (
        renewalInterval !== undefined &&
        (!Number.isSafeInteger(renewalInterval) || renewalInterval < 1 ||
          renewalInterval >
            providerSourceSingletonTiming.maximumRenewalIntervalSeconds * 1_000)
      ) {
        throw new TypeError(`${name} renewal interval exceeds the launch bound.`);
      }
    }
    this.#dependencies = dependencies;
  }

  get state(): "idle" | "active" | "fenced_draining" | "stopped" {
    if (this.#fenceStarted) return "fenced_draining";
    if (this.#epoch) return "active";
    return this.#stopping ? "stopped" : "idle";
  }

  async initialize(): Promise<SourceSupervisorEpoch> {
    if (this.#initialization) return this.#initialization;
    if (this.#epoch || this.#stopping) {
      throw new Error("provider_source_supervisor.already_started");
    }
    const initialization = this.#initializeOnce().finally(() => {
      if (this.#initialization === initialization) this.#initialization = null;
    });
    this.#initialization = initialization;
    return initialization;
  }

  async #initializeOnce(): Promise<SourceSupervisorEpoch> {
    const epoch = await this.#dependencies.ownership.acquire({
      environmentKey: this.#dependencies.environmentKey,
      ownerKey: this.#dependencies.ownerKey,
      leaseToken: this.#dependencies.leaseToken,
    });
    this.#epoch = epoch;
    try {
      if (this.#stopping) return epoch;
      const predecessorAttempts = await this.#runControlPlane(
        () => this.#dependencies.ownership.listReconcilablePredecessorAttempts(epoch),
        "TAKEOVER_RECONCILIATION_FAILED",
      );
      for (const attempt of predecessorAttempts) {
        if (this.#stopping || this.#fenceStarted) return epoch;
        await this.#runControlPlane(
          () => this.#dependencies.ownership.reconcilePredecessorAttempt(
            epoch,
            attempt,
          ),
          "TAKEOVER_RECONCILIATION_FAILED",
        );
      }
      if (this.#stopping) return epoch;
      await this.#recoverClaims(epoch, true);
      if (this.#stopping) return epoch;
      await this.#publishSnapshot();
      if (!this.#stopping) this.#startRenewal();
      return epoch;
    } catch (error) {
      await this.#beginFence("TAKEOVER_RECONCILIATION_FAILED");
      throw error;
    }
  }

  async start(): Promise<void> {
    await this.initialize();
    const sleep = this.#dependencies.sleep ?? defaultSleep;
    const poll = this.#dependencies.pollIntervalMilliseconds
      ?? providerSourceSupervisorDefaults.pollIntervalMilliseconds;
    while (!this.#stopping && !this.#fenceStarted) {
      try {
        await this.runCycle();
      } catch (error) {
        await this.#beginFence("SUPERVISOR_LOOP_FAILED");
        throw error;
      }
      if (!this.#stopping && !this.#fenceStarted) await sleep(poll);
    }
  }

  async runCycle(): Promise<void> {
    if (this.#cyclePromise) return this.#cyclePromise;
    const cycle = this.#runCycleOnce().finally(() => {
      if (this.#cyclePromise === cycle) this.#cyclePromise = null;
    });
    this.#cyclePromise = cycle;
    return cycle;
  }

  async #runCycleOnce(): Promise<void> {
    const epoch = this.#requireEpoch();
    this.#runtimeFence.assertActive();
    if (this.#stopping) return;
    try {
      // A replacement supervisor can acquire the singleton lease before a
      // predecessor's longer-lived work claims expire. Revisit recovery on
      // every poll so those claims do not remain running forever merely
      // because they were still valid during startup reconciliation.
      if (!(await this.#recoverClaims(epoch, false))) return;
      const dueWork = await this.#runControlPlane(
        () => this.#dependencies.queue.listDue(epoch),
        "DUE_MATERIALIZATION_FAILED",
      );
      for (const due of dueWork) {
        if (this.#stopping || this.#fenceStarted) break;
        const runId = this.#dependencies.ids.id();
        await this.#runControlPlane(
          () => this.#dependencies.queue.materializeDue(epoch, due, runId),
          "DUE_MATERIALIZATION_FAILED",
        );
      }
    const claimed: TWork[] = [];
    const pendingByProfile = new Map<string, number>();
    const profileLimits = new Map(
      this.#coordinator.snapshot().profiles.map((profile) => [
        JSON.stringify([
          profile.organizationId,
          profile.connectionProfileId,
        ]),
        profile.approvedAggregateRequestCap,
      ]),
    );
    let pendingExecutionSlots = 0;
    // Scan the bounded durable queue horizon even when old work belongs to a
    // saturated profile. Per-profile waiter bounds below keep those claims
    // resource-free, while the scan can still reach an independent profile in
    // this same poll instead of leaving generic execution slots idle.
    const claimBudget = 100;
    for (let index = 0; index < claimBudget; index += 1) {
      if (this.#stopping || this.#fenceStarted) break;
      const claimCommand = {
        claimOwner: this.#dependencies.ownerKey,
        claimToken: this.#dependencies.ids.id(),
        claimLeaseId: this.#dependencies.ids.id(),
        excludedProfiles: [...profileLimits.entries()]
          .filter(([key, limit]) =>
            (this.#activeProfileTurns.get(key) ?? 0) +
                (pendingByProfile.get(key) ?? 0) >= limit + 2
          )
          .map(([key]) => {
            const [organizationId, connectionProfileId] = JSON.parse(key) as [
              string,
              string,
            ];
            return { organizationId, connectionProfileId };
          }),
        excludedSourceInstanceIds: [
          ...this.#activeSources,
          ...claimed.flatMap((candidate) =>
            candidate.sourceInstanceId ? [candidate.sourceInstanceId] : []
          ),
        ],
        skipPageReads:
          this.#admission.state !== "available" &&
          Date.now() < this.#capacityProbeNotBeforeMilliseconds,
      } as const;
      const work = await this.#runControlPlane(
        () => this.#dependencies.queue.claimNext(epoch, claimCommand),
        "WORK_CLAIM_FAILED",
      );
      if (!work) break;
      if (this.#stopping) {
        await this.#runControlPlane(
          () => this.#dependencies.queue.releaseUnstarted(
            epoch,
            work,
            "graceful_shutdown",
          ),
          "WORK_RELEASE_FAILED",
        );
        break;
      }
      let registeredProfileRequestLimit: number;
      try {
        registeredProfileRequestLimit =
          this.#dependencies.executor.registeredProfileRequestLimit(work);
      } catch {
        const disposition = {
          kind: "action_required" as const,
          safeCode: "PROFILE_ADMISSION_CONFIGURATION_INVALID",
        };
        await this.#runControlPlane(
          () => this.#dependencies.queue.complete(epoch, work, disposition),
          "WORK_FINALIZATION_FAILED",
        );
        await this.#recordDiagnostic(
          epoch,
          work,
          "terminal",
          disposition,
          disposition.safeCode,
        );
        continue;
      }
      if (work.profileRequestLimit !== registeredProfileRequestLimit) {
        const disposition = {
          kind: "action_required" as const,
          safeCode: "PROFILE_REQUEST_LIMIT_MISMATCH",
        };
        await this.#runControlPlane(
          () => this.#dependencies.queue.complete(epoch, work, disposition),
          "WORK_FINALIZATION_FAILED",
        );
        await this.#recordDiagnostic(
          epoch,
          work,
          "terminal",
          disposition,
          disposition.safeCode,
        );
        continue;
      }
      const profileKey = workProfileKey(work);
      profileLimits.set(profileKey, registeredProfileRequestLimit);
      const reservedForProfile =
        (this.#activeProfileTurns.get(profileKey) ?? 0) +
        (pendingByProfile.get(profileKey) ?? 0);
      // Keep a tiny per-profile FIFO (one running permit plus at most two
      // resource-free waiters) while rotating deeper backlog to fresh DB time.
      // This preserves fair handoff evidence without letting one profile fill
      // the global claim horizon.
      if (reservedForProfile >= registeredProfileRequestLimit + 2) {
        await this.#runControlPlane(
          () => this.#dependencies.queue.releaseUnstarted(
            epoch,
            work,
            "capacity_blocked",
          ),
          "WORK_RELEASE_FAILED",
        );
        continue;
      }
      const waitsForProfile =
        reservedForProfile >= registeredProfileRequestLimit;
      if (
        !waitsForProfile &&
        this.#coordinator.snapshot().activeExecutionSlots +
              pendingExecutionSlots >=
          this.#coordinator.snapshot().maximumExecutionSlots
      ) {
        await this.#runControlPlane(
          () => this.#dependencies.queue.releaseUnstarted(
            epoch,
            work,
            "capacity_blocked",
          ),
          "WORK_RELEASE_FAILED",
        );
        break;
      }
      claimed.push(work);
      pendingByProfile.set(
        profileKey,
        (pendingByProfile.get(profileKey) ?? 0) + 1,
      );
      if (!waitsForProfile) pendingExecutionSlots += 1;
      this.#coordinator.configureProfile({
        organizationId: work.organizationId,
        connectionProfileId: work.connectionProfileId,
        approvedAggregateRequestCap: registeredProfileRequestLimit,
      });
      await this.#recordDiagnostic(epoch, work, "work_claimed");
    }

    for (const work of claimed) {
      if (this.#stopping) {
        await this.#runControlPlane(
          () => this.#dependencies.queue.releaseUnstarted(
            epoch,
            work,
            "graceful_shutdown",
          ),
          "WORK_RELEASE_FAILED",
        );
        continue;
      }
      const profileKey = workProfileKey(work);
      this.#activeProfileTurns.set(
        profileKey,
        (this.#activeProfileTurns.get(profileKey) ?? 0) + 1,
      );
      const turn = this.#executeTurn(epoch, work)
        .catch(async () => {
          await this.#beginFence("BACKGROUND_TURN_FAILED");
        })
        .finally(() => {
          this.#activeTurns.delete(turn);
          const remaining = (this.#activeProfileTurns.get(profileKey) ?? 1) - 1;
          if (remaining === 0) this.#activeProfileTurns.delete(profileKey);
          else this.#activeProfileTurns.set(profileKey, remaining);
        });
      this.#activeTurns.add(turn);
    }
      await this.#publishSnapshot();
    } catch (error) {
      await this.#beginFence("SUPERVISOR_LOOP_FAILED");
      throw error;
    }
  }

  async #recoverClaims(
    epoch: SourceSupervisorEpoch,
    drain: boolean,
  ): Promise<boolean> {
    try {
      while (!this.#stopping && !this.#fenceStarted) {
        const recoverable = await this.#runControlPlane(
          () => this.#dependencies.queue.listRecoverableClaims(epoch),
          "CLAIM_RECOVERY_FAILED",
          { fenceOnExhausted: drain },
        );
        if (recoverable.length === 0) return true;
        for (const claim of recoverable) {
          if (this.#stopping || this.#fenceStarted) return false;
          await this.#runControlPlane(
            () => this.#dependencies.queue.recoverClaim(epoch, claim),
            "CLAIM_RECOVERY_FAILED",
            { fenceOnExhausted: drain },
          );
        }
        if (!drain) return true;
      }
      return false;
    } catch (error) {
      // Startup takeover must drain every predecessor claim before this epoch
      // admits work. During an ordinary poll, however, the same claims remain
      // durably discoverable. Page commits can hold their rows longer than one
      // short control-plane retry window, so leave the runtime active and
      // revisit recovery on the next poll instead of restarting healthy work.
      if (!drain && error instanceof ControlPlaneRetryExhaustedError) {
        return false;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopping = true;
    const stop = this.#stopAfterInitialization();
    this.#stopPromise = stop;
    return stop;
  }

  async #stopAfterInitialization(): Promise<void> {
    this.#coordinator.stopAdmission();
    if (this.#renewalTimer) clearInterval(this.#renewalTimer);
    this.#renewalTimer = null;
    await this.#initialization?.catch(() => undefined);
    await this.#renewalInFlight?.catch(() => undefined);
    await this.#cyclePromise?.catch(() => undefined);
    await Promise.allSettled([...this.#activeTurns]);
    await this.#snapshotTail.catch(() => undefined);
    const epoch = this.#epoch;
    if (epoch && !this.#fenceStarted) {
      // Publish the drained zero-capacity state before the singleton release.
      // A failed shutdown-only snapshot must not turn an otherwise clean
      // release into a spurious owner fence.
      await this.#publishSnapshot().catch(() => undefined);
    }
    // Snapshot retry exhaustion may have fenced the epoch. Re-evaluate the
    // ownership path after that fallible boundary so clean and fenced release
    // can never race each other.
    const fencedByThisOwner = await this.#fencePersistencePromise
      ?.catch(() => false);
    if (
      epoch && this.#fenceStarted && fencedByThisOwner &&
      !this.#fencedReleasePromise
    ) {
      this.#fencedReleasePromise = this.#releaseFencedAfterDrain(epoch);
    }
    if (this.#fencedReleasePromise) {
      await this.#fencedReleasePromise;
    } else if (epoch && !this.#fenceStarted) {
      await this.#runControlPlane(
        () => this.#dependencies.ownership.release(epoch),
        "SUPERVISOR_RELEASE_FAILED",
      );
    }
    this.#epoch = null;
  }

  async #executeTurn(epoch: SourceSupervisorEpoch, work: TWork): Promise<void> {
    const sourceId = work.sourceInstanceId;
    if (sourceId && this.#activeSources.has(sourceId)) {
      await this.#runControlPlane(
        () => this.#dependencies.queue.releaseUnstarted(
          epoch,
          work,
          "source_lane_busy",
        ),
        "WORK_RELEASE_FAILED",
      );
      return;
    }
    if (sourceId) this.#activeSources.add(sourceId);
    const workController = new AbortController();
    let releaseExecutionSlot: (() => void) | null = null;
    let workClosed = false;
    let durableCloseInFlight: Promise<unknown> | null = null;
    let claimRenewalInFlight: Promise<void> | null = null;
    const persistDurableClose = async <TResult>(
      operation: () => Promise<TResult>,
      fenceReasonCode: string,
    ): Promise<TResult> => {
      const closing = this.#runControlPlane(operation, fenceReasonCode);
      durableCloseInFlight = closing;
      try {
        const result = await closing;
        workClosed = true;
        return result;
      } finally {
        if (durableCloseInFlight === closing) durableCloseInFlight = null;
      }
    };
    const renewalTimer = setInterval(() => {
      if (claimRenewalInFlight) return;
      const renewal = this.#runControlPlane(
        () => this.#dependencies.queue.renewClaim(epoch, work),
        "WORK_CLAIM_RENEWAL_LOST",
        { fenceOnExhausted: false },
      ).then(async (renewedUntil) => {
        if (renewedUntil !== null) return;
        const closing = durableCloseInFlight;
        if (closing) await closing.catch(() => undefined);
        if (workClosed || this.#stopping || this.#fenceStarted) return;
        // The queue transaction already owns the durable lease-loss event.
        // This port call is its bounded local mirror in the production adapter.
        await this.#dependencies.diagnostics.record({
          epoch,
          work,
          transition: "lease_lost",
          safeCode: "WORK_CLAIM_RENEWAL_LOST",
        }).catch(() => undefined);
        if (workClosed || this.#stopping || this.#fenceStarted) return;
        workController.abort();
        this.#dependencies.executor.abortAll("claim_lost");
        await this.#beginFence("WORK_CLAIM_RENEWAL_LOST");
      }).catch(async (error: unknown) => {
        // The durable lease still has multiple renewal intervals remaining.
        // A single contention window is not ownership loss; retry on the next
        // timer tick. A null renewal or any non-transient failure still takes
        // the exact fail-closed path above/below.
        if (error instanceof ControlPlaneRetryExhaustedError) return;
        const closing = durableCloseInFlight;
        if (closing) await closing.catch(() => undefined);
        if (workClosed || this.#stopping || this.#fenceStarted) return;
        workController.abort();
        this.#dependencies.executor.abortAll("claim_lost");
        await this.#beginFence("WORK_CLAIM_RENEWAL_LOST");
      });
      const trackedRenewal = renewal.finally(() => {
        if (claimRenewalInFlight === trackedRenewal) {
          claimRenewalInFlight = null;
        }
      });
      claimRenewalInFlight = trackedRenewal;
    }, this.#dependencies.claimRenewalIntervalMilliseconds ??
      providerSourceSingletonTiming.maximumRenewalIntervalSeconds * 1_000);
    try {
      if (work.kind === "page_read") {
        const admitted = await this.#probeCapacity("before_request", epoch, work);
        if (!admitted) {
          await persistDurableClose(
            () => this.#dependencies.queue.releaseUnstarted(
              epoch,
              work,
              "capacity_blocked",
            ),
            "WORK_RELEASE_FAILED",
          );
          return;
        }
      }
      if (this.#stopping) {
        await persistDurableClose(
          () => this.#dependencies.queue.releaseUnstarted(
            epoch,
            work,
            "graceful_shutdown",
          ),
          "WORK_RELEASE_FAILED",
        );
        return;
      }
      const signal = AbortSignal.any([
        workController.signal,
        this.#runtimeFence.signal,
      ]);
      const result = await this.#dependencies.executor.execute(work, {
        epoch,
        requestLeases: this.#requestLeases,
        runtimeFence: this.#runtimeFence,
        signal,
        capacityChanged: () => this.#publishSnapshot(),
        admissionWaiting: (reason) => this.#runControlPlane(
          () => this.#dependencies.queue.markAdmissionWaiting(
            epoch,
            work,
            reason,
          ),
          "WORK_ADMISSION_STATE_FAILED",
        ),
        admissionGranted: () => this.#runControlPlane(
          () => this.#dependencies.queue.markAdmissionGranted(epoch, work),
          "WORK_ADMISSION_STATE_FAILED",
        ),
        retainExecutionSlot: (release) => {
          if (releaseExecutionSlot !== null) {
            throw new Error("provider_source_supervisor.slot_release_already_registered");
          }
          releaseExecutionSlot = release;
        },
        recordDiagnostic: (transition, details) =>
          this.#runControlPlane(
            () => this.#dependencies.diagnostics.record({
              epoch,
              work,
              transition,
              requestAttemptId: details.requestAttemptId,
              ...(details.pageId ? { pageId: details.pageId } : {}),
              ...(details.safeCode
                ? { safeCode: safeCode(details.safeCode) }
                : {}),
            }),
            "DIAGNOSTIC_PERSISTENCE_FAILED",
          ),
      });
      this.#runtimeFence.assertActive();
      if (signal.aborted) throw new RuntimeLocallyFencedError();
      const disposition = await this.#dispositionFor(epoch, work, result);
      if (!this.#fenceStarted && disposition !== null) {
        const appliedDisposition = await persistDurableClose(
          () => this.#dependencies.queue.complete(epoch, work, disposition),
          "WORK_FINALIZATION_FAILED",
        );
        await this.#recordDisposition(
          epoch,
          work,
          result,
          appliedDisposition ?? disposition,
        );
      }
    } catch (error) {
      if (
        error instanceof ControlPlaneRetryExhaustedError ||
        error instanceof RuntimeLocallyFencedError
      ) {
        await this.#beginFence("CONTROL_PLANE_RETRY_EXHAUSTED");
        return;
      }
      if (error instanceof SourceSupervisorStaleWorkError) {
        if (!this.#fenceStarted) {
          const disposition = { kind: "fenced" as const };
          await persistDurableClose(
            () => this.#dependencies.queue.complete(epoch, work, disposition),
            "WORK_FINALIZATION_FAILED",
          );
          await this.#recordDiagnostic(
            epoch,
            work,
            "terminal",
            disposition,
            "STALE_WORK_FENCED",
          );
        }
        return;
      }
      if (
        (error instanceof ConnectionPermitCoordinatorError &&
          (error.code === "cancelled" || error.code === "admission_stopped")) ||
        (error instanceof SourceRequestLeaseError && error.code === "cancelled")
      ) {
        if (!this.#fenceStarted) {
          await persistDurableClose(
            () => this.#dependencies.queue.releaseUnstarted(
              epoch,
              work,
              this.#stopping ? "graceful_shutdown" : "capacity_blocked",
            ),
            "WORK_RELEASE_FAILED",
          );
        }
        return;
      }
      if (!this.#fenceStarted) {
        const disposition = {
          kind: "action_required" as const,
          safeCode: "SOURCE_EXECUTION_FAILED",
        };
        await persistDurableClose(
          () => this.#dependencies.queue.complete(epoch, work, disposition),
          "WORK_FINALIZATION_FAILED",
        );
        await this.#recordDiagnostic(
          epoch,
          work,
          "terminal",
          disposition,
          disposition.safeCode,
        );
      }
    } finally {
      clearInterval(renewalTimer);
      const pendingClaimRenewal = claimRenewalInFlight as Promise<void> | null;
      await pendingClaimRenewal?.catch(() => undefined);
      const releaseRetainedSlot = releaseExecutionSlot as (() => void) | null;
      if (releaseRetainedSlot !== null) {
        releaseRetainedSlot();
        await this.#publishSnapshot();
      }
      if (sourceId) this.#activeSources.delete(sourceId);
    }
  }

  async #dispositionFor(
    epoch: SourceSupervisorEpoch,
    work: TWork,
    result: SourceSupervisorExecutionResult,
  ): Promise<SourceSupervisorWorkDisposition | null> {
    if (result.kind === "test_terminal") return { kind: "test_terminal" };
    if (result.kind === "stale" || result.kind === "fenced") {
      return { kind: "fenced" };
    }
    if (result.kind === "connection_action_required") {
      return {
        kind: "connection_blocked",
        safeCode: safeCode(result.safeCode),
      };
    }
    if (result.kind === "source_action_required") {
      return {
        kind: "action_required",
        safeCode: safeCode(result.safeCode),
      };
    }
    if (result.kind === "retryable") {
      const nextAttempt = (work.retryAttempt ?? 0) + 1;
      if (nextAttempt > providerSourceTransientRetryPolicy.maximumAttempts) {
        return {
          kind: "action_required",
          safeCode: "TRANSIENT_RETRIES_EXHAUSTED",
        };
      }
      return {
        kind: "retrying",
        retryAttempt: nextAttempt,
        retryDelayMilliseconds: providerSourceTransientRetryPolicy
          .backoffMilliseconds[nextAttempt - 1]!,
        safeCode: safeCode(result.safeCode),
      };
    }
    if (work.kind !== "page_read") {
      return { kind: "action_required", safeCode: "WORK_KIND_MISMATCH" };
    }
    const admitted = await this.#probeCapacity("after_commit", epoch, work);
    if (!admitted) {
      // The page is already committed. Queue finalization records the durable
      // head/continuation first; the next turn remains capacity-blocked.
      this.#coordinator.cancelQueued();
    }
    if (result.pauseRequested) return { kind: "paused" };
    if (result.continuation.kind === "poll_after") {
      return {
        kind: "reached_head",
        cursorFingerprint: result.cursorFingerprint,
        minimumDelaySeconds: result.continuation.minimumDelaySeconds,
        pagesCommitted: result.pagesCommitted,
        recordsCommitted: result.recordsCommitted,
      };
    }
    if (result.cursorFingerprint === null) {
      return {
        kind: "action_required",
        safeCode: "CONTINUE_CURSOR_MISSING",
      };
    }
    return {
      kind: "continued",
      continuationRunId: this.#dependencies.ids.id(),
      cursorFingerprint: result.cursorFingerprint,
      pagesCommitted: result.pagesCommitted,
      recordsCommitted: result.recordsCommitted,
    };
  }

  async #probeCapacity(
    phase: "before_request" | "after_commit",
    epoch: SourceSupervisorEpoch,
    work: TWork,
  ): Promise<boolean> {
    let result: SourceSupervisorCapacityProbeResult;
    try {
      result = await this.#dependencies.capacity.probe({
        phase,
        epoch,
        work,
      });
    } catch {
      this.#admission = {
        state: "probe_failed",
        safeCode: "CAPACITY_PROBE_FAILED",
      };
      this.#capacityProbeNotBeforeMilliseconds = Date.now() + Math.max(
        this.#dependencies.pollIntervalMilliseconds ??
          providerSourceSupervisorDefaults.pollIntervalMilliseconds,
        5_000,
      );
      this.#coordinator.cancelQueued();
      await this.#publishSnapshot();
      return false;
    }
    if (result.admitted) {
      this.#admission = { state: "available", safeCode: null };
      this.#capacityProbeNotBeforeMilliseconds = 0;
      return true;
    }
    this.#admission = {
      state: result.state,
      safeCode: safeCode(result.safeCode),
    };
    this.#capacityProbeNotBeforeMilliseconds = Date.now() + Math.max(
      this.#dependencies.pollIntervalMilliseconds ??
        providerSourceSupervisorDefaults.pollIntervalMilliseconds,
      5_000,
    );
    this.#coordinator.cancelQueued();
    await this.#publishSnapshot();
    return false;
  }

  #startRenewal(): void {
    const interval = this.#dependencies.ownershipRenewalIntervalMilliseconds ??
      providerSourceSingletonTiming.maximumRenewalIntervalSeconds * 1_000;
    this.#renewalTimer = setInterval(() => {
      const epoch = this.#epoch;
      if (!epoch || this.#fenceStarted || this.#stopping || this.#renewalInFlight) {
        return;
      }
      const renewal = this.#runControlPlane(
        () => this.#dependencies.ownership.renew(epoch),
        "SUPERVISOR_RENEWAL_LOST",
        { fenceOnExhausted: false },
      ).then(() => {
        if (!this.#stopping && !this.#fenceStarted) {
          // Snapshot persistence is ordered on its own tail. A delayed
          // observability write must never suppress the next ownership
          // heartbeat and let an otherwise healthy singleton lease expire.
          void this.#publishSnapshot().catch(() => undefined);
        }
      }).catch(async (error: unknown) => {
        if (this.#stopping) return;
        // The 30-second durable singleton lease spans several heartbeat
        // intervals. Page commits intentionally hold the epoch fence and can
        // consume one bounded control-plane retry window; retry at the next
        // heartbeat instead of converting ordinary commit contention into a
        // false ownership loss. Real lost ownership still fences in
        // #runControlPlane before reaching this branch.
        if (error instanceof ControlPlaneRetryExhaustedError) return;
        if (!this.#fenceStarted && !(error instanceof RuntimeLocallyFencedError)) {
          // A failed renewal call is not proof that another owner exists. The
          // durable lease remains authoritative, and every poll/request/page
          // boundary independently revalidates it. Retry on the next heartbeat;
          // confirmed lost ownership is converted to RuntimeLocallyFencedError
          // inside #runControlPlane and still takes the fence path below.
          return;
        }
        try {
          // #beginFence stops admission before it aborts in-flight leases, so
          // the ownership-lost abort cannot throw ahead of the durable fence.
          await this.#beginFence("SUPERVISOR_RENEWAL_LOST");
        } catch {
          // Nothing may escape this detached lane: a rejection here would be
          // unhandled once #renewalInFlight clears. The runtime fence is
          // already up, so the failure stays observable as fenced_draining
          // while every later control-plane call fails closed.
        }
      });
      const trackedRenewal = renewal.finally(() => {
        if (this.#renewalInFlight === trackedRenewal) {
          this.#renewalInFlight = null;
        }
      });
      this.#renewalInFlight = trackedRenewal;
    }, interval);
  }

  async #beginFence(safeReasonCode: string): Promise<void> {
    if (!this.#fencePersistencePromise) {
      this.#pendingFenceReasonCode ??= safeReasonCode;
      this.#fenceStarted = true;
      this.#runtimeFence.fence();
      this.#coordinator.stopAdmission();
      if (this.#renewalTimer) clearInterval(this.#renewalTimer);
      this.#renewalTimer = null;
      this.#dependencies.executor.abortAll("ownership_lost");
      const epoch = this.#epoch;
      this.#fencePersistencePromise = epoch
        ? this.#persistFence(epoch, this.#pendingFenceReasonCode)
        : Promise.resolve(false);
    }
    const epoch = this.#epoch;
    const fencedByThisOwner = await this.#fencePersistencePromise;
    if (
      fencedByThisOwner && epoch && !this.#fencedReleasePromise
    ) {
      // Do not await the drain here: #beginFence may be running inside one of
      // the turns that the release must join. stop() joins this same promise
      // before it clears the epoch or lets its database lifecycle close.
      this.#fencedReleasePromise = this.#releaseFencedAfterDrain(epoch);
    }
  }

  async #persistFence(
    epoch: SourceSupervisorEpoch,
    safeReasonCode: string,
  ): Promise<boolean> {
    const sleep = this.#dependencies.sleep ?? defaultSleep;
    while (true) {
      try {
        await this.#dependencies.ownership.fence(epoch, safeReasonCode);
        return true;
      } catch (error) {
        const code = this.#dependencies.classifyControlPlaneFailure(error);
        // A replaced/released epoch is already unable to do more work. Never
        // retry against or mutate the successor's ownership record.
        if (code === "lost_ownership" || code === "stale_fence") return false;
        if (
          code !== "connection" && code !== "deadlock" &&
          code !== "serialization" && code !== "timeout"
        ) return false;
        await sleep(
          providerSourceSingletonTiming.maximumRenewalIntervalSeconds * 1_000,
        );
      }
    }
  }

  async #releaseFencedAfterDrain(epoch: SourceSupervisorEpoch): Promise<void> {
    await Promise.allSettled([...this.#activeTurns]);
    if (this.#epoch?.epochId !== epoch.epochId) return;
    try {
      await this.#dependencies.ownership.release(epoch);
      if (this.#epoch?.epochId === epoch.epochId) this.#epoch = null;
    } catch {
      // An uncertain durable request intentionally keeps the fenced epoch for
      // takeover reconciliation/expiry. A terminally drained epoch releases
      // immediately through the same exact DB guard.
    }
  }

  async #publishSnapshot(): Promise<void> {
    const publication = this.#snapshotTail.catch(() => undefined).then(async () => {
      const epoch = this.#epoch;
      if (!epoch || this.#fenceStarted) return;
      // Capture current counters only after every older publication settled;
      // a slow stale write can therefore never overwrite a newer grant or
      // drained state.
      try {
        await this.#runControlPlane(
          () => this.#dependencies.snapshot.publish({
            epoch,
            capacity: this.#coordinator.snapshot(),
            admission: this.#admission,
          }),
          "SNAPSHOT_PUBLISH_FAILED",
          { fenceOnExhausted: false },
        );
      } catch (error) {
        if (error instanceof ControlPlaneRetryExhaustedError) return;
        throw error;
      }
    });
    this.#snapshotTail = publication.catch(() => undefined);
    await publication;
  }

  async #recordDisposition(
    epoch: SourceSupervisorEpoch,
    work: TWork,
    result: SourceSupervisorExecutionResult,
    disposition: SourceSupervisorWorkDisposition,
  ): Promise<void> {
    // The detecting request owns one connection-scoped episode event. Do not
    // copy a shared profile failure into every bound source feed.
    if (disposition.kind === "connection_blocked") return;
    if (result.kind === "page_committed") {
      await this.#recordDiagnostic(epoch, work, "page_committed", disposition);
    }
    const transition: SourceSupervisorDiagnosticTransition =
      disposition.kind === "continued" ? "continuation_queued"
        : disposition.kind === "reached_head" ? "head_reached"
        : disposition.kind === "paused" ? "pause_completed"
        : disposition.kind === "retrying" ? "retry_scheduled"
        : "terminal";
    await this.#recordDiagnostic(
      epoch,
      work,
      transition,
      disposition,
      "safeCode" in disposition ? disposition.safeCode : undefined,
    );
  }

  async #recordDiagnostic(
    epoch: SourceSupervisorEpoch,
    work: TWork,
    transition: SourceSupervisorDiagnosticTransition,
    disposition?: SourceSupervisorWorkDisposition,
    diagnosticSafeCode?: string,
  ): Promise<void> {
    await this.#runControlPlane(
      () => this.#dependencies.diagnostics.record({
        epoch,
        work,
        transition,
        ...(disposition ? { disposition } : {}),
        ...(diagnosticSafeCode
          ? { safeCode: safeCode(diagnosticSafeCode) }
          : {}),
      }),
      "DIAGNOSTIC_PERSISTENCE_FAILED",
    );
  }

  async #runControlPlane<TResult>(
    operation: () => TResult | Promise<TResult>,
    fenceReasonCode: string,
    options?: Readonly<{
      fenceOnExhausted?: boolean;
    }>,
  ): Promise<TResult> {
    try {
      return await runControlPlaneTransaction({
        runtimeFence: this.#runtimeFence,
        revalidate: () => this.#runtimeFence.assertActive(),
        transact: () => operation(),
        fenceOnExhausted: options?.fenceOnExhausted,
        beforeFence: () => {
          this.#pendingFenceReasonCode ??= fenceReasonCode;
        },
        onExhausted: () => options?.fenceOnExhausted === false
          ? undefined
          : this.#beginFence(fenceReasonCode),
        classifyFailure: (error) => error instanceof ControlPlaneTransactionError
          ? error.code
          : this.#dependencies.classifyControlPlaneFailure(error),
        ...(this.#dependencies.sleep
          ? { sleep: this.#dependencies.sleep }
          : {}),
      });
    } catch (error) {
      const code = error instanceof ControlPlaneTransactionError
        ? error.code
        : this.#dependencies.classifyControlPlaneFailure(error);
      if (code === "lost_ownership") {
        // Preserve the exact control-plane boundary that detected ownership
        // loss. The repository error still carries SUPERVISOR_OWNERSHIP_LOST;
        // this durable reason identifies which operation failed its fence.
        await this.#beginFence(fenceReasonCode);
        throw new RuntimeLocallyFencedError();
      }
      if (code === "stale_fence") throw new SourceSupervisorStaleWorkError();
      throw error;
    }
  }

  #requireEpoch(): SourceSupervisorEpoch {
    if (!this.#epoch) throw new Error("provider_source_supervisor.not_started");
    return this.#epoch;
  }
}
