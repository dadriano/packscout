import { providerSourceLaunchBounds } from "@packscout/contracts";

export interface ConnectionProfilePermitIdentity {
  readonly organizationId: string;
  readonly connectionProfileId: string;
}

export type ConnectionPermitWaitReason =
  | "profile_capacity"
  | "execution_capacity";

export interface ConnectionProfilePermitConfiguration
  extends ConnectionProfilePermitIdentity {
  readonly approvedAggregateRequestCap: number;
}

export interface ConnectionPermitAcquireInput {
  readonly profile: ConnectionProfilePermitIdentity;
  readonly signal?: AbortSignal;
}

export type ConnectionPermitCoordinatorErrorCode =
  | "cancelled"
  | "invalid_execution_slots"
  | "invalid_profile_identity"
  | "invalid_profile_request_cap"
  | "profile_cap_change_while_in_use"
  | "profile_not_configured"
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
  readonly profile: ConnectionProfilePermitIdentity;
  readonly requestPermitHeld: boolean;
  readonly executionSlotHeld: boolean;
  releaseRequestPermit(): void;
  releaseExecutionSlot(): void;
  releaseAll(): void;
}

export interface ConnectionPermitCoordinatorSnapshot {
  readonly maximumExecutionSlots: number;
  readonly activeExecutionSlots: number;
  readonly queuedOperations: number;
  readonly profiles: readonly Readonly<{
    organizationId: string;
    connectionProfileId: string;
    approvedAggregateRequestCap: number;
    activeRequestPermits: number;
    queuedOperations: number;
  }>[];
}

interface ProfileState {
  readonly identity: ConnectionProfilePermitIdentity;
  approvedAggregateRequestCap: number;
  activeRequestPermits: number;
}

interface PermitWaiter {
  readonly sequence: number;
  readonly profileKey: string;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (permit: PairedConnectionPermit) => void;
  readonly reject: (error: ConnectionPermitCoordinatorError) => void;
  onAbort: (() => void) | undefined;
}

function validateIdentity(
  identity: ConnectionProfilePermitIdentity,
): ConnectionProfilePermitIdentity {
  if (
    typeof identity.organizationId !== "string" ||
    identity.organizationId.trim().length === 0 ||
    typeof identity.connectionProfileId !== "string" ||
    identity.connectionProfileId.trim().length === 0
  ) {
    throw new ConnectionPermitCoordinatorError("invalid_profile_identity");
  }
  return Object.freeze({
    organizationId: identity.organizationId,
    connectionProfileId: identity.connectionProfileId,
  });
}

function profileKey(identity: ConnectionProfilePermitIdentity): string {
  return JSON.stringify([identity.organizationId, identity.connectionProfileId]);
}

class GrantedPairedConnectionPermit implements PairedConnectionPermit {
  readonly profile: ConnectionProfilePermitIdentity;
  #coordinator: ConnectionPermitCoordinator;
  #profileKey: string;
  #requestPermitHeld = true;
  #executionSlotHeld = true;

  constructor(
    coordinator: ConnectionPermitCoordinator,
    key: string,
    profile: ConnectionProfilePermitIdentity,
  ) {
    this.#coordinator = coordinator;
    this.#profileKey = key;
    this.profile = profile;
  }

  get requestPermitHeld(): boolean {
    return this.#requestPermitHeld;
  }

  get executionSlotHeld(): boolean {
    return this.#executionSlotHeld;
  }

  releaseRequestPermit(): void {
    if (!this.#requestPermitHeld) {
      return;
    }
    this.#requestPermitHeld = false;
    this.#coordinator.releaseRequestPermit(this.#profileKey);
  }

  releaseExecutionSlot(): void {
    if (!this.#executionSlotHeld) {
      return;
    }
    if (this.#requestPermitHeld) {
      throw new ConnectionPermitCoordinatorError(
        "request_permit_still_held",
      );
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
 * operation owns no capacity: the profile permit and generic execution slot
 * are reserved together only when the operation becomes eligible.
 */
export class ConnectionPermitCoordinator {
  readonly #maximumExecutionSlots: number;
  readonly #profiles = new Map<string, ProfileState>();
  readonly #waiters: PermitWaiter[] = [];
  #activeExecutionSlots = 0;
  #nextSequence = 0;
  #draining = false;
  #admissionStopped = false;

  get admissionStopped(): boolean {
    return this.#admissionStopped;
  }

  waitReasonFor(
    profile: ConnectionProfilePermitIdentity,
  ): ConnectionPermitWaitReason | null {
    const key = profileKey(profile);
    const state = this.#profiles.get(key);
    if (!state) throw new ConnectionPermitCoordinatorError("profile_not_configured");
    if (state.activeRequestPermits >= state.approvedAggregateRequestCap) {
      return "profile_capacity";
    }
    if (this.#activeExecutionSlots >= this.#maximumExecutionSlots) {
      return "execution_capacity";
    }
    return null;
  }

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

  configureProfile(configuration: ConnectionProfilePermitConfiguration): void {
    const identity = validateIdentity(configuration);
    const cap = configuration.approvedAggregateRequestCap;
    if (
      !Number.isSafeInteger(cap) ||
      cap < 1 ||
      cap > providerSourceLaunchBounds.stableProfileRequestCap
    ) {
      throw new ConnectionPermitCoordinatorError("invalid_profile_request_cap");
    }

    const key = profileKey(identity);
    const current = this.#profiles.get(key);
    if (current === undefined) {
      this.#profiles.set(key, {
        identity,
        approvedAggregateRequestCap: cap,
        activeRequestPermits: 0,
      });
      this.#drain();
      return;
    }
    if (current.approvedAggregateRequestCap === cap) {
      return;
    }
    if (
      current.activeRequestPermits > 0 ||
      this.#waiters.some((waiter) => waiter.profileKey === key)
    ) {
      throw new ConnectionPermitCoordinatorError(
        "profile_cap_change_while_in_use",
      );
    }
    current.approvedAggregateRequestCap = cap;
    this.#drain();
  }

  acquire(input: ConnectionPermitAcquireInput): Promise<PairedConnectionPermit> {
    if (this.#admissionStopped) {
      return Promise.reject(
        new ConnectionPermitCoordinatorError("admission_stopped"),
      );
    }
    let identity: ConnectionProfilePermitIdentity;
    try {
      identity = validateIdentity(input.profile);
    } catch (error) {
      return Promise.reject(error);
    }
    const key = profileKey(identity);
    if (!this.#profiles.has(key)) {
      return Promise.reject(
        new ConnectionPermitCoordinatorError("profile_not_configured"),
      );
    }
    if (input.signal?.aborted === true) {
      return Promise.reject(new ConnectionPermitCoordinatorError("cancelled"));
    }

    return new Promise<PairedConnectionPermit>((resolve, reject) => {
      const waiter: PermitWaiter = {
        sequence: this.#nextSequence,
        profileKey: key,
        signal: input.signal,
        resolve,
        reject,
        onAbort: undefined,
      };
      this.#nextSequence += 1;
      waiter.onAbort = () => {
        const index = this.#waiters.indexOf(waiter);
        if (index === -1) {
          return;
        }
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
      profiles: [...this.#profiles.values()].map((state) => ({
        ...state.identity,
        approvedAggregateRequestCap: state.approvedAggregateRequestCap,
        activeRequestPermits: state.activeRequestPermits,
        queuedOperations: this.#waiters.filter(
          (waiter) => waiter.profileKey === profileKey(state.identity),
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

  /** Cancels queued work for one exact tenant/profile blocking episode. */
  cancelQueuedForProfile(identity: ConnectionProfilePermitIdentity): void {
    const key = profileKey(validateIdentity(identity));
    const cancelled = this.#waiters.filter(
      (waiter) => waiter.profileKey === key,
    );
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
    const profile = this.#profiles.get(key);
    if (profile === undefined || profile.activeRequestPermits < 1) {
      throw new Error("connection_permit.release_request_invariant");
    }
    profile.activeRequestPermits -= 1;
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
    if (this.#draining) {
      return;
    }
    this.#draining = true;
    try {
      while (this.#activeExecutionSlots < this.#maximumExecutionSlots) {
        if (this.#admissionStopped) return;
        const nextIndex = this.#waiters.findIndex((waiter) => {
          const profile = this.#profiles.get(waiter.profileKey);
          return profile !== undefined &&
            profile.activeRequestPermits <
              profile.approvedAggregateRequestCap;
        });
        if (nextIndex === -1) {
          return;
        }
        const [waiter] = this.#waiters.splice(nextIndex, 1);
        if (waiter === undefined) {
          return;
        }
        waiter.signal?.removeEventListener("abort", waiter.onAbort!);
        if (waiter.signal?.aborted === true) {
          waiter.reject(new ConnectionPermitCoordinatorError("cancelled"));
          continue;
        }
        const profile = this.#profiles.get(waiter.profileKey);
        if (profile === undefined) {
          waiter.reject(
            new ConnectionPermitCoordinatorError("profile_not_configured"),
          );
          continue;
        }
        profile.activeRequestPermits += 1;
        this.#activeExecutionSlots += 1;
        waiter.resolve(
          new GrantedPairedConnectionPermit(
            this,
            waiter.profileKey,
            profile.identity,
          ),
        );
      }
    } finally {
      this.#draining = false;
    }
  }
}
