import { providerSourceLaunchBounds } from "@packscout/contracts";

export interface ConnectionProfileIdentity {
  readonly organizationId: string;
  readonly connectionProfileId: string;
}

export type ConnectionPermitLaneIdentity =
  | Readonly<
      ConnectionProfileIdentity & {
        scope: "platform";
        providerId: string;
      }
    >
  | Readonly<
      ConnectionProfileIdentity & {
        scope: "connection_test";
        providerId: null;
      }
    >;

export type ConnectionPermitWaitReason =
  | "request_lane_capacity"
  | "execution_capacity";

export type ConnectionPermitLaneConfiguration = Readonly<
  ConnectionPermitLaneIdentity & {
    approvedRequestCap: number;
  }
>;

export interface ConnectionPermitAcquireInput {
  readonly requestPermitLane: ConnectionPermitLaneIdentity;
  readonly signal?: AbortSignal;
}

export type ConnectionPermitCoordinatorErrorCode =
  | "cancelled"
  | "invalid_execution_slots"
  | "invalid_profile_identity"
  | "invalid_request_lane_identity"
  | "invalid_request_cap"
  | "request_cap_change_while_in_use"
  | "request_lane_not_configured"
  | "request_permit_still_held"
  | "admission_stopped";

export class ConnectionPermitCoordinatorError extends Error {
  readonly code: ConnectionPermitCoordinatorErrorCode;

  constructor(code: ConnectionPermitCoordinatorErrorCode) {
    super(`connection_permit.${code}`);
    this.name = "ConnectionPermitCoordinatorError";
    this.code = code;
  }
}

export interface PairedConnectionPermit {
  readonly requestPermitLane: ConnectionPermitLaneIdentity;
  readonly requestPermitHeld: boolean;
  readonly executionSlotHeld: boolean;
  releaseRequestPermit(): void;
  releaseExecutionSlot(): void;
  releaseAll(): void;
}

export type ConnectionPermitLaneSnapshot = Readonly<
  ConnectionPermitLaneIdentity & {
    approvedRequestCap: number;
    activeRequestPermits: number;
    queuedOperations: number;
  }
>;

export interface ConnectionPermitCoordinatorSnapshot {
  readonly maximumExecutionSlots: number;
  readonly activeExecutionSlots: number;
  readonly queuedOperations: number;
  readonly requestPermitLanes: readonly ConnectionPermitLaneSnapshot[];
}

interface RequestPermitLaneState {
  readonly identity: ConnectionPermitLaneIdentity;
  approvedRequestCap: number;
  activeRequestPermits: number;
}

interface PermitWaiter {
  readonly sequence: number;
  readonly requestPermitLaneKey: string;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (permit: PairedConnectionPermit) => void;
  readonly reject: (error: ConnectionPermitCoordinatorError) => void;
  onAbort: (() => void) | undefined;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateProfileIdentity(
  identity: ConnectionProfileIdentity,
): ConnectionProfileIdentity {
  if (
    typeof identity !== "object" ||
    identity === null ||
    !isNonBlankString(identity.organizationId) ||
    !isNonBlankString(identity.connectionProfileId)
  ) {
    throw new ConnectionPermitCoordinatorError("invalid_profile_identity");
  }
  return Object.freeze({
    organizationId: identity.organizationId,
    connectionProfileId: identity.connectionProfileId,
  });
}

function validateRequestPermitLaneIdentity(
  identity: ConnectionPermitLaneIdentity,
): ConnectionPermitLaneIdentity {
  const profile = validateProfileIdentity(identity);
  if (identity.scope === "platform" && isNonBlankString(identity.providerId)) {
    return Object.freeze({
      ...profile,
      scope: "platform",
      providerId: identity.providerId,
    });
  }
  if (identity.scope === "connection_test" && identity.providerId === null) {
    return Object.freeze({
      ...profile,
      scope: "connection_test",
      providerId: null,
    });
  }
  throw new ConnectionPermitCoordinatorError("invalid_request_lane_identity");
}

function profileKey(identity: ConnectionProfileIdentity): string {
  return JSON.stringify([identity.organizationId, identity.connectionProfileId]);
}

function requestPermitLaneKey(identity: ConnectionPermitLaneIdentity): string {
  return JSON.stringify([
    identity.organizationId,
    identity.connectionProfileId,
    identity.scope,
    identity.providerId,
  ]);
}

class GrantedPairedConnectionPermit implements PairedConnectionPermit {
  readonly requestPermitLane: ConnectionPermitLaneIdentity;
  #coordinator: ConnectionPermitCoordinator;
  #requestPermitLaneKey: string;
  #requestPermitHeld = true;
  #executionSlotHeld = true;

  constructor(
    coordinator: ConnectionPermitCoordinator,
    key: string,
    requestPermitLane: ConnectionPermitLaneIdentity,
  ) {
    this.#coordinator = coordinator;
    this.#requestPermitLaneKey = key;
    this.requestPermitLane = requestPermitLane;
  }

  get requestPermitHeld(): boolean {
    return this.#requestPermitHeld;
  }

  get executionSlotHeld(): boolean {
    return this.#executionSlotHeld;
  }

  releaseRequestPermit(): void {
    if (!this.#requestPermitHeld) return;
    this.#requestPermitHeld = false;
    this.#coordinator.releaseRequestPermit(this.#requestPermitLaneKey);
  }

  releaseExecutionSlot(): void {
    if (!this.#executionSlotHeld) return;
    if (this.#requestPermitHeld) {
      throw new ConnectionPermitCoordinatorError("request_permit_still_held");
    }
    this.#executionSlotHeld = false;
    this.#coordinator.releaseExecutionSlot();
  }

  releaseAll(): void {
    this.releaseRequestPermit();
    this.releaseExecutionSlot();
  }
}

/**
 * The runtime owns one instance of this process-local coordinator. A queued
 * operation owns no capacity: its request-lane permit and generic execution
 * slot are reserved together only when the operation becomes eligible.
 */
export class ConnectionPermitCoordinator {
  readonly #maximumExecutionSlots: number;
  readonly #requestPermitLanes = new Map<string, RequestPermitLaneState>();
  readonly #waiters: PermitWaiter[] = [];
  #activeExecutionSlots = 0;
  #nextSequence = 0;
  #draining = false;
  #admissionStopped = false;

  constructor(
    maximumExecutionSlots: number =
      providerSourceLaunchBounds.genericExecutionSlots,
  ) {
    if (
      !Number.isSafeInteger(maximumExecutionSlots) ||
      maximumExecutionSlots < 1 ||
      maximumExecutionSlots > providerSourceLaunchBounds.genericExecutionSlots
    ) {
      throw new ConnectionPermitCoordinatorError("invalid_execution_slots");
    }
    this.#maximumExecutionSlots = maximumExecutionSlots;
  }

  get admissionStopped(): boolean {
    return this.#admissionStopped;
  }

  waitReasonFor(
    requestPermitLane: ConnectionPermitLaneIdentity,
  ): ConnectionPermitWaitReason | null {
    const key = requestPermitLaneKey(
      validateRequestPermitLaneIdentity(requestPermitLane),
    );
    const state = this.#requestPermitLanes.get(key);
    if (!state) {
      throw new ConnectionPermitCoordinatorError("request_lane_not_configured");
    }
    if (state.activeRequestPermits >= state.approvedRequestCap) {
      return "request_lane_capacity";
    }
    if (this.#activeExecutionSlots >= this.#maximumExecutionSlots) {
      return "execution_capacity";
    }
    return null;
  }

  configureRequestPermitLane(
    configuration: ConnectionPermitLaneConfiguration,
  ): void {
    const identity = validateRequestPermitLaneIdentity(configuration);
    const cap = configuration.approvedRequestCap;
    if (
      !Number.isSafeInteger(cap) ||
      cap < 1 ||
      cap > providerSourceLaunchBounds.stablePlatformRequestCap
    ) {
      throw new ConnectionPermitCoordinatorError("invalid_request_cap");
    }

    const key = requestPermitLaneKey(identity);
    const current = this.#requestPermitLanes.get(key);
    if (current === undefined) {
      this.#requestPermitLanes.set(key, {
        identity,
        approvedRequestCap: cap,
        activeRequestPermits: 0,
      });
      this.#drain();
      return;
    }
    if (current.approvedRequestCap === cap) return;
    if (
      current.activeRequestPermits > 0 ||
      this.#waiters.some((waiter) => waiter.requestPermitLaneKey === key)
    ) {
      throw new ConnectionPermitCoordinatorError(
        "request_cap_change_while_in_use",
      );
    }
    current.approvedRequestCap = cap;
    this.#drain();
  }

  acquire(input: ConnectionPermitAcquireInput): Promise<PairedConnectionPermit> {
    if (this.#admissionStopped) {
      return Promise.reject(
        new ConnectionPermitCoordinatorError("admission_stopped"),
      );
    }
    let identity: ConnectionPermitLaneIdentity;
    try {
      identity = validateRequestPermitLaneIdentity(input.requestPermitLane);
    } catch (error) {
      return Promise.reject(error);
    }
    const key = requestPermitLaneKey(identity);
    if (!this.#requestPermitLanes.has(key)) {
      return Promise.reject(
        new ConnectionPermitCoordinatorError("request_lane_not_configured"),
      );
    }
    if (input.signal?.aborted === true) {
      return Promise.reject(new ConnectionPermitCoordinatorError("cancelled"));
    }

    return new Promise<PairedConnectionPermit>((resolve, reject) => {
      const waiter: PermitWaiter = {
        sequence: this.#nextSequence,
        requestPermitLaneKey: key,
        signal: input.signal,
        resolve,
        reject,
        onAbort: undefined,
      };
      this.#nextSequence += 1;
      waiter.onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index === -1) return;
        this.#waiters.splice(index, 1);
        waiter.signal?.removeEventListener("abort", waiter.onAbort!);
        reject(new ConnectionPermitCoordinatorError("cancelled"));
        this.#drain();
      };
      input.signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.#waiters.push(waiter);
      this.#drain();
    });
  }

  snapshot(): ConnectionPermitCoordinatorSnapshot {
    return {
      maximumExecutionSlots: this.#maximumExecutionSlots,
      activeExecutionSlots: this.#activeExecutionSlots,
      queuedOperations: this.#waiters.length,
      requestPermitLanes: [...this.#requestPermitLanes.values()].map((state) => ({
        ...state.identity,
        approvedRequestCap: state.approvedRequestCap,
        activeRequestPermits: state.activeRequestPermits,
        queuedOperations: this.#waiters.filter(
          (waiter) =>
            waiter.requestPermitLaneKey === requestPermitLaneKey(state.identity),
        ).length,
      })),
    };
  }

  /** Cancels only queued operations. Active permits keep their safe boundary. */
  cancelQueued(): void {
    const queued = this.#waiters.splice(0);
    for (const waiter of queued) {
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      waiter.reject(new ConnectionPermitCoordinatorError("cancelled"));
    }
  }

  /** Cancels queued work across every request lane for one exact profile. */
  cancelQueuedForProfile(identity: ConnectionProfileIdentity): void {
    const exactProfileKey = profileKey(validateProfileIdentity(identity));
    const cancelled = this.#waiters.filter((waiter) => {
      const lane = this.#requestPermitLanes.get(waiter.requestPermitLaneKey);
      return lane !== undefined && profileKey(lane.identity) === exactProfileKey;
    });
    for (const waiter of cancelled) {
      const index = this.#waiters.indexOf(waiter);
      if (index === -1) continue;
      this.#waiters.splice(index, 1);
      waiter.signal?.removeEventListener("abort", waiter.onAbort!);
      waiter.reject(new ConnectionPermitCoordinatorError("cancelled"));
    }
    this.#drain();
  }

  /** Irreversible process drain used for shutdown or owner fencing. */
  stopAdmission(): void {
    if (this.#admissionStopped) return;
    this.#admissionStopped = true;
    this.cancelQueued();
  }

  releaseRequestPermit(key: string): void {
    const lane = this.#requestPermitLanes.get(key);
    if (lane === undefined || lane.activeRequestPermits < 1) {
      throw new Error("connection_permit.release_request_invariant");
    }
    lane.activeRequestPermits -= 1;
    this.#drain();
  }

  releaseExecutionSlot(): void {
    if (this.#activeExecutionSlots < 1) {
      throw new Error("connection_permit.release_execution_invariant");
    }
    this.#activeExecutionSlots -= 1;
    this.#drain();
  }

  #drain(): void {
    if (this.#draining) return;
    this.#draining = true;
    try {
      while (this.#activeExecutionSlots < this.#maximumExecutionSlots) {
        if (this.#admissionStopped) return;
        const nextIndex = this.#waiters.findIndex((waiter) => {
          const lane = this.#requestPermitLanes.get(waiter.requestPermitLaneKey);
          return lane !== undefined &&
            lane.activeRequestPermits < lane.approvedRequestCap;
        });
        if (nextIndex === -1) return;
        const [waiter] = this.#waiters.splice(nextIndex, 1);
        if (waiter === undefined) return;
        waiter.signal?.removeEventListener("abort", waiter.onAbort!);
        if (waiter.signal?.aborted === true) {
          waiter.reject(new ConnectionPermitCoordinatorError("cancelled"));
          continue;
        }
        const lane = this.#requestPermitLanes.get(waiter.requestPermitLaneKey);
        if (lane === undefined) {
          waiter.reject(
            new ConnectionPermitCoordinatorError("request_lane_not_configured"),
          );
          continue;
        }
        lane.activeRequestPermits += 1;
        this.#activeExecutionSlots += 1;
        waiter.resolve(
          new GrantedPairedConnectionPermit(
            this,
            waiter.requestPermitLaneKey,
            lane.identity,
          ),
        );
      }
    } finally {
      this.#draining = false;
    }
  }
}
