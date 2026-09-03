export const CLUTCHPACKS_REPLAY_CONFIG_VERSION = 4n;
export const CLUTCHPACKS_REPLAY_LEASE_OWNER =
  "local:clutchpacks:dataforrest:replay:v4" as const;
export const CLUTCHPACKS_REPLAY_RESUME_IDEMPOTENCY_KEY =
  "local:clutchpacks:dataforrest:replay:v4:resume" as const;

export type ClutchpacksReplayCentralPhase =
  | "v3_active"
  | "v4_candidate"
  | "v4_active"
  | "unexpected";

export interface ClutchpacksReplayCentralState {
  readonly phase: ClutchpacksReplayCentralPhase;
  readonly organizationId: string;
  readonly providerId: string;
  readonly providerKey: "clutchpacks";
  readonly operatorId: string;
  readonly configVersionId: string;
  readonly configVersionNumber: bigint;
  readonly providerRowVersion: bigint;
  readonly topologyVersion: bigint;
}

export interface ClutchpacksReplayProviderState {
  readonly providerId: string;
  readonly providerKey: "clutchpacks";
  readonly runtimeState: "idle" | "running" | "paused" | "stopped" | "error";
  readonly runtimeGeneration: bigint;
  readonly cachedConfigVersionId: string | null;
  readonly cachedConfigVersionNumber: bigint | null;
  readonly activeRunId: string | null;
  readonly leaseDisposition: "unowned" | "owned" | "foreign";
  readonly cursorCleared: boolean;
  readonly exactResumeEvidence: boolean;
}

export interface ClutchpacksReplayLease {
  readonly fence: bigint;
}

export interface ClutchpacksReplayActivationProof {
  readonly configVersionId: string;
  readonly providerRowVersion: bigint;
  readonly topologyVersion: bigint;
  readonly databaseNodeId: string;
  readonly databaseNodeRowVersion: bigint;
  readonly databaseCredentialVersionId: string;
  readonly sourceCredentialVersionId: string;
  readonly observedProviderSchemaVersion: string;
  readonly durationMilliseconds: number;
  readonly responseStatus: number;
  readonly responseBytes: number;
  readonly recordCount: number;
}

export interface ClutchpacksReplayPreparationDependencies {
  inspectCentral(): Promise<ClutchpacksReplayCentralState>;
  inspectProvider(
    central: ClutchpacksReplayCentralState,
  ): Promise<ClutchpacksReplayProviderState>;
  acquireLease(
    central: ClutchpacksReplayCentralState,
  ): Promise<ClutchpacksReplayLease>;
  renewLease(
    central: ClutchpacksReplayCentralState,
    lease: ClutchpacksReplayLease,
  ): Promise<ClutchpacksReplayLease>;
  releaseLease(
    central: ClutchpacksReplayCentralState,
    lease: ClutchpacksReplayLease,
  ): Promise<boolean>;
  appendV4(
    expected: ClutchpacksReplayCentralState,
  ): Promise<ClutchpacksReplayCentralState>;
  testV4(
    candidate: ClutchpacksReplayCentralState,
  ): Promise<ClutchpacksReplayActivationProof>;
  activateV4(
    candidate: ClutchpacksReplayCentralState,
    proof: ClutchpacksReplayActivationProof,
  ): Promise<ClutchpacksReplayCentralState>;
  synchronizeProvider(
    active: ClutchpacksReplayCentralState,
  ): Promise<ClutchpacksReplayProviderState>;
  resumeProvider(
    active: ClutchpacksReplayCentralState,
    provider: ClutchpacksReplayProviderState,
  ): Promise<ClutchpacksReplayProviderState>;
}

export type ClutchpacksReplayPreparationFailureCode =
  | "REPLAY_CENTRAL_STATE_UNEXPECTED"
  | "REPLAY_PROVIDER_STATE_UNEXPECTED"
  | "REPLAY_PROVIDER_BUSY"
  | "REPLAY_PROVIDER_LEASE_HELD"
  | "REPLAY_PROVIDER_LEASE_LOST"
  | "REPLAY_V4_APPEND_FAILED"
  | "REPLAY_V4_TEST_FAILED"
  | "REPLAY_V4_ACTIVATION_FAILED"
  | "REPLAY_PROVIDER_SYNC_FAILED"
  | "REPLAY_PROVIDER_RESUME_FAILED"
  | "REPLAY_POSTCONDITION_FAILED"
  | "CLUTCHPACKS_REPLAY_PREPARATION_FAILED";

export class ClutchpacksReplayPreparationError extends Error {
  constructor(readonly code: ClutchpacksReplayPreparationFailureCode) {
    super(code);
    this.name = "ClutchpacksReplayPreparationError";
  }
}

function refuse(code: ClutchpacksReplayPreparationFailureCode): never {
  throw new ClutchpacksReplayPreparationError(code);
}

function centralIsV4(
  central: ClutchpacksReplayCentralState,
): boolean {
  return central.phase === "v4_active"
    && central.configVersionNumber === CLUTCHPACKS_REPLAY_CONFIG_VERSION;
}

function providerIdentityMatches(
  central: ClutchpacksReplayCentralState,
  provider: ClutchpacksReplayProviderState,
): boolean {
  return provider.providerId === central.providerId
    && provider.providerKey === central.providerKey;
}

function complete(
  central: ClutchpacksReplayCentralState,
  provider: ClutchpacksReplayProviderState,
): boolean {
  return centralIsV4(central)
    && providerIdentityMatches(central, provider)
    && provider.runtimeState === "idle"
    && provider.cachedConfigVersionId === central.configVersionId
    && provider.cachedConfigVersionNumber === CLUTCHPACKS_REPLAY_CONFIG_VERSION
    && provider.activeRunId === null
    && provider.leaseDisposition === "unowned"
    && provider.cursorCleared
    && provider.exactResumeEvidence;
}

function assertCentralCanContinue(
  central: ClutchpacksReplayCentralState,
): void {
  if (
    central.providerKey !== "clutchpacks"
    || !["v3_active", "v4_candidate", "v4_active"].includes(central.phase)
    || (central.phase === "v3_active" && central.configVersionNumber !== 3n)
    || (central.phase !== "v3_active"
      && central.configVersionNumber !== CLUTCHPACKS_REPLAY_CONFIG_VERSION)
  ) refuse("REPLAY_CENTRAL_STATE_UNEXPECTED");
}

function assertProviderCanContinue(
  central: ClutchpacksReplayCentralState,
  provider: ClutchpacksReplayProviderState,
): void {
  if (!providerIdentityMatches(central, provider)) {
    refuse("REPLAY_PROVIDER_STATE_UNEXPECTED");
  }
  if (provider.activeRunId !== null) refuse("REPLAY_PROVIDER_BUSY");
  if (provider.leaseDisposition === "foreign") {
    refuse("REPLAY_PROVIDER_LEASE_HELD");
  }
  if (provider.runtimeState === "idle") {
    if (
      !centralIsV4(central)
      || provider.cachedConfigVersionId !== central.configVersionId
      || provider.cachedConfigVersionNumber !== 4n
      || !provider.cursorCleared
      || !provider.exactResumeEvidence
      || provider.leaseDisposition !== "owned"
    ) refuse("REPLAY_PROVIDER_STATE_UNEXPECTED");
    return;
  }
  if (provider.runtimeState !== "error") {
    refuse("REPLAY_PROVIDER_STATE_UNEXPECTED");
  }
  const cachedVersion = provider.cachedConfigVersionNumber;
  if (
    (central.phase === "v4_active"
      ? cachedVersion !== 3n && cachedVersion !== 4n
      : cachedVersion !== 3n)
    || (cachedVersion === 4n
      && provider.cachedConfigVersionId !== central.configVersionId)
    || provider.exactResumeEvidence
  ) refuse("REPLAY_PROVIDER_STATE_UNEXPECTED");
}

function assertOwnedAndClean(
  central: ClutchpacksReplayCentralState,
  provider: ClutchpacksReplayProviderState,
): void {
  assertProviderCanContinue(central, provider);
  if (provider.leaseDisposition !== "owned") {
    refuse("REPLAY_PROVIDER_LEASE_LOST");
  }
}

export interface ClutchpacksReplayPreparationResult {
  readonly outcome: "prepared" | "already_prepared";
  readonly providerId: string;
  readonly providerKey: "clutchpacks";
  readonly configVersionId: string;
  readonly configVersionNumber: 4;
  readonly runtimeState: "idle";
  readonly cursorState: "cleared";
}

/**
 * Crash-resumable choreography for the one pre-launch local ClutchPacks replay.
 * Every mutation is delegated to its owning repository boundary; this state
 * machine never writes either database directly.
 */
export async function prepareClutchpacksDataforrestReplay(
  dependencies: ClutchpacksReplayPreparationDependencies,
): Promise<ClutchpacksReplayPreparationResult> {
  let central = await dependencies.inspectCentral();
  assertCentralCanContinue(central);
  let provider = await dependencies.inspectProvider(central);
  if (complete(central, provider)) {
    return {
      outcome: "already_prepared",
      providerId: central.providerId,
      providerKey: central.providerKey,
      configVersionId: central.configVersionId,
      configVersionNumber: 4,
      runtimeState: "idle",
      cursorState: "cleared",
    };
  }
  assertProviderCanContinue(central, provider);

  let lease = await dependencies.acquireLease(central);
  let released = false;
  try {
    provider = await dependencies.inspectProvider(central);
    assertOwnedAndClean(central, provider);

    if (central.phase === "v3_active") {
      central = await dependencies.appendV4(central).catch(() =>
        refuse("REPLAY_V4_APPEND_FAILED")
      );
      if (central.phase !== "v4_candidate") {
        refuse("REPLAY_V4_APPEND_FAILED");
      }
      lease = await dependencies.renewLease(central, lease).catch(() =>
        refuse("REPLAY_PROVIDER_LEASE_LOST")
      );
    }

    if (central.phase === "v4_candidate") {
      const proof = await dependencies.testV4(central).catch(() =>
        refuse("REPLAY_V4_TEST_FAILED")
      );
      lease = await dependencies.renewLease(central, lease).catch(() =>
        refuse("REPLAY_PROVIDER_LEASE_LOST")
      );
      central = await dependencies.activateV4(central, proof).catch(() =>
        refuse("REPLAY_V4_ACTIVATION_FAILED")
      );
    }
    if (!centralIsV4(central)) refuse("REPLAY_V4_ACTIVATION_FAILED");

    if (provider.runtimeState !== "idle") {
      lease = await dependencies.renewLease(central, lease).catch(() =>
        refuse("REPLAY_PROVIDER_LEASE_LOST")
      );
      provider = await dependencies.synchronizeProvider(central).catch(() =>
        refuse("REPLAY_PROVIDER_SYNC_FAILED")
      );
      assertOwnedAndClean(central, provider);
      if (
        provider.cachedConfigVersionId !== central.configVersionId
        || provider.cachedConfigVersionNumber !== 4n
        || !provider.cursorCleared
      ) refuse("REPLAY_PROVIDER_SYNC_FAILED");

      lease = await dependencies.renewLease(central, lease).catch(() =>
        refuse("REPLAY_PROVIDER_LEASE_LOST")
      );
      provider = await dependencies.resumeProvider(central, provider).catch(() =>
        refuse("REPLAY_PROVIDER_RESUME_FAILED")
      );
      if (
        provider.runtimeState !== "idle"
        || !provider.exactResumeEvidence
        || provider.leaseDisposition !== "owned"
      ) refuse("REPLAY_PROVIDER_RESUME_FAILED");
    }

    released = await dependencies.releaseLease(central, lease);
    if (!released) refuse("REPLAY_PROVIDER_LEASE_LOST");
  } finally {
    if (!released) {
      await dependencies.releaseLease(central, lease).catch(() => false);
    }
  }

  central = await dependencies.inspectCentral();
  provider = await dependencies.inspectProvider(central);
  if (!complete(central, provider)) refuse("REPLAY_POSTCONDITION_FAILED");
  return {
    outcome: "prepared",
    providerId: central.providerId,
    providerKey: central.providerKey,
    configVersionId: central.configVersionId,
    configVersionNumber: 4,
    runtimeState: "idle",
    cursorState: "cleared",
  };
}

export function safeClutchpacksReplayPreparationError(
  error: unknown,
): ClutchpacksReplayPreparationError {
  return error instanceof ClutchpacksReplayPreparationError
    ? error
    : new ClutchpacksReplayPreparationError(
        "CLUTCHPACKS_REPLAY_PREPARATION_FAILED",
      );
}
