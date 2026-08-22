import {
  opaqueCheckpointEnvelopeSchema,
  type LaunchProviderKey,
  type OpaqueCheckpointEnvelope,
} from "@packscout/contracts";
import {
  ConnectionPermitCoordinatorError,
  ConnectionPermitCoordinator,
  type ConnectionPermitWaitReason,
  type ConnectionProfilePermitIdentity,
  type PairedConnectionPermit,
} from "./connection-permit-coordinator.ts";

interface SourceRequestCommonPins {
  readonly requestAttemptId: string;
  readonly requestLeaseId: string;
  readonly organizationId: string;
  readonly sourceTypeKey: string;
  readonly adapterVersion: string;
  readonly singletonFencingEpoch: number;
  readonly connectionProfileId: string;
  readonly connectionProfileRevisionId: string;
  readonly connectionHealthGeneration: number;
}

export interface ConnectionTestRequestPins extends SourceRequestCommonPins {
  readonly operationKind: "connection_test";
  readonly connectionTestJobId: string;
  readonly jobClaimLeaseId: string;
  readonly recoveryEpisodeId: string | null;
}

interface SourceScopedRequestPins extends SourceRequestCommonPins {
  readonly provider: LaunchProviderKey;
  readonly sourceInstanceId: string;
  readonly sourceRevisionId: string;
  readonly normalizedContractVersion: string;
  readonly identityNamespaceKey: string;
}

export interface SourceTestRequestPins extends SourceScopedRequestPins {
  readonly operationKind: "source_test";
  readonly sourceTestJobId: string;
  readonly jobClaimLeaseId: string;
}

export interface PageReadRequestPins extends SourceScopedRequestPins {
  readonly operationKind: "page_read";
  readonly importRunId: string;
  readonly runClaimLeaseId: string;
  readonly pageAttemptId: string;
  readonly pageNumber: number;
  readonly pageLimit: number;
  readonly checkpointGeneration: number;
  readonly requestedCheckpointFingerprint: string | null;
}

export type SourceRequestOperationPins =
  | ConnectionTestRequestPins
  | SourceTestRequestPins
  | PageReadRequestPins;

export type SourceRequestLeaseState =
  | "available"
  | "consumed"
  | "cancelled"
  | "closed";

export type SourceRequestLeaseErrorCode =
  | "already_consumed"
  | "cancelled"
  | "closed"
  | "guard_failed"
  | "invalid_pins"
  | "lost_ownership"
  | "not_consumed"
  | "pin_mismatch"
  | "terminalization_receipt_mismatch"
  | "terminalization_required";

export class SourceRequestLeaseError extends Error {
  readonly code: SourceRequestLeaseErrorCode;

  constructor(code: SourceRequestLeaseErrorCode) {
    super(`source_request_lease.${code}`);
    this.name = "SourceRequestLeaseError";
    this.code = code;
  }
}

export interface SourceRequestInvocation {
  readonly pins: SourceRequestOperationPins;
  readonly signal: AbortSignal;
}

export type SourceRequestAdmissionGuard = (
  pins: SourceRequestOperationPins,
  requestedCheckpoint: OpaqueCheckpointEnvelope | null,
  signal: AbortSignal,
) => boolean | Promise<boolean>;

interface SourceRequestLeaseAdmissionBase {
  readonly pins: SourceRequestOperationPins;
  readonly guard: SourceRequestAdmissionGuard;
  readonly signal?: AbortSignal;
}

export type SourceRequestLeaseAdmissionInput =
  | (SourceRequestLeaseAdmissionBase & Readonly<{
      pins: ConnectionTestRequestPins | SourceTestRequestPins;
      requestedCheckpoint?: never;
    }>)
  | (SourceRequestLeaseAdmissionBase & Readonly<{
      pins: PageReadRequestPins;
      requestedCheckpoint: OpaqueCheckpointEnvelope;
    }>);

const sourceRequestLeaseIssueAuthority = Symbol("source-request-lease-authority");

const commonPinKeys = [
  "adapterVersion",
  "connectionHealthGeneration",
  "connectionProfileId",
  "connectionProfileRevisionId",
  "operationKind",
  "organizationId",
  "requestAttemptId",
  "requestLeaseId",
  "singletonFencingEpoch",
  "sourceTypeKey",
] as const;

const keysByOperation = Object.freeze({
  connection_test: [
    ...commonPinKeys,
    "connectionTestJobId",
    "jobClaimLeaseId",
    "recoveryEpisodeId",
  ],
  source_test: [
    ...commonPinKeys,
    "provider",
    "sourceInstanceId",
    "sourceRevisionId",
    "normalizedContractVersion",
    "identityNamespaceKey",
    "sourceTestJobId",
    "jobClaimLeaseId",
  ],
  page_read: [
    ...commonPinKeys,
    "provider",
    "sourceInstanceId",
    "sourceRevisionId",
    "normalizedContractVersion",
    "identityNamespaceKey",
    "importRunId",
    "runClaimLeaseId",
    "pageAttemptId",
    "pageNumber",
    "pageLimit",
    "checkpointGeneration",
    "requestedCheckpointFingerprint",
  ],
} as const satisfies Readonly<
  Record<SourceRequestOperationPins["operationKind"], readonly string[]>
>);

const launchProviders = new Set<string>([
  "courtyard",
  "collector_crypt",
  "phygitals",
  "clutchpacks",
]);

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1;
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function validateExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
): void {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== "string")) {
    throw new SourceRequestLeaseError("invalid_pins");
  }
  const actual = (ownKeys as string[]).sort();
  const expected = [...expectedKeys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new SourceRequestLeaseError("invalid_pins");
  }
}

function canonicalizePins(
  pins: SourceRequestOperationPins,
): SourceRequestOperationPins {
  if (typeof pins !== "object" || pins === null) {
    throw new SourceRequestLeaseError("invalid_pins");
  }
  const record = pins as unknown as Record<string, unknown>;
  const operationKind = record.operationKind;
  if (
    operationKind !== "connection_test" &&
    operationKind !== "source_test" &&
    operationKind !== "page_read"
  ) {
    throw new SourceRequestLeaseError("invalid_pins");
  }
  validateExactKeys(record, keysByOperation[operationKind]);
  for (const field of [
    "requestAttemptId",
    "requestLeaseId",
    "organizationId",
    "sourceTypeKey",
    "adapterVersion",
    "connectionProfileId",
    "connectionProfileRevisionId",
  ] as const) {
    if (!isNonBlankString(record[field])) {
      throw new SourceRequestLeaseError("invalid_pins");
    }
  }
  if (
    !isGeneration(record.singletonFencingEpoch) ||
    !isGeneration(record.connectionHealthGeneration)
  ) {
    throw new SourceRequestLeaseError("invalid_pins");
  }

  if (operationKind === "connection_test") {
    if (
      !isNonBlankString(record.connectionTestJobId) ||
      !isNonBlankString(record.jobClaimLeaseId) ||
      (record.recoveryEpisodeId !== null &&
        !isNonBlankString(record.recoveryEpisodeId))
    ) {
      throw new SourceRequestLeaseError("invalid_pins");
    }
    return Object.freeze({
      operationKind,
      requestAttemptId: record.requestAttemptId as string,
      requestLeaseId: record.requestLeaseId as string,
      organizationId: record.organizationId as string,
      sourceTypeKey: record.sourceTypeKey as string,
      adapterVersion: record.adapterVersion as string,
      singletonFencingEpoch: record.singletonFencingEpoch as number,
      connectionProfileId: record.connectionProfileId as string,
      connectionProfileRevisionId: record.connectionProfileRevisionId as string,
      connectionHealthGeneration: record.connectionHealthGeneration as number,
      connectionTestJobId: record.connectionTestJobId as string,
      jobClaimLeaseId: record.jobClaimLeaseId as string,
      recoveryEpisodeId: record.recoveryEpisodeId as string | null,
    });
  }

  for (const field of [
    "sourceInstanceId",
    "sourceRevisionId",
    "normalizedContractVersion",
    "identityNamespaceKey",
  ] as const) {
    if (!isNonBlankString(record[field])) {
      throw new SourceRequestLeaseError("invalid_pins");
    }
  }
  if (!launchProviders.has(String(record.provider))) {
    throw new SourceRequestLeaseError("invalid_pins");
  }
  const sourcePins = {
    operationKind,
    requestAttemptId: record.requestAttemptId as string,
    requestLeaseId: record.requestLeaseId as string,
    organizationId: record.organizationId as string,
    sourceTypeKey: record.sourceTypeKey as string,
    adapterVersion: record.adapterVersion as string,
    singletonFencingEpoch: record.singletonFencingEpoch as number,
    connectionProfileId: record.connectionProfileId as string,
    connectionProfileRevisionId: record.connectionProfileRevisionId as string,
    connectionHealthGeneration: record.connectionHealthGeneration as number,
    provider: record.provider as LaunchProviderKey,
    sourceInstanceId: record.sourceInstanceId as string,
    sourceRevisionId: record.sourceRevisionId as string,
    normalizedContractVersion: record.normalizedContractVersion as string,
    identityNamespaceKey: record.identityNamespaceKey as string,
  } as const;

  if (operationKind === "source_test") {
    if (
      !isNonBlankString(record.sourceTestJobId) ||
      !isNonBlankString(record.jobClaimLeaseId)
    ) {
      throw new SourceRequestLeaseError("invalid_pins");
    }
    return Object.freeze({
      ...sourcePins,
      operationKind,
      sourceTestJobId: record.sourceTestJobId as string,
      jobClaimLeaseId: record.jobClaimLeaseId as string,
    });
  }

  if (
    !isNonBlankString(record.importRunId) ||
    !isNonBlankString(record.runClaimLeaseId) ||
    !isNonBlankString(record.pageAttemptId) ||
    !Number.isSafeInteger(record.pageNumber) ||
    Number(record.pageNumber) < 1 ||
    !Number.isSafeInteger(record.pageLimit) ||
    Number(record.pageLimit) < 1 ||
    Number(record.pageLimit) > 5_000 ||
    !isPositiveGeneration(record.checkpointGeneration) ||
    (record.requestedCheckpointFingerprint !== null &&
      (typeof record.requestedCheckpointFingerprint !== "string" ||
        !/^[a-f0-9]{64}$/u.test(record.requestedCheckpointFingerprint)))
  ) {
    throw new SourceRequestLeaseError("invalid_pins");
  }
  return Object.freeze({
    ...sourcePins,
    operationKind,
    importRunId: record.importRunId as string,
    runClaimLeaseId: record.runClaimLeaseId as string,
    pageAttemptId: record.pageAttemptId as string,
    pageNumber: record.pageNumber as number,
    pageLimit: record.pageLimit as number,
    checkpointGeneration: record.checkpointGeneration as number,
    requestedCheckpointFingerprint:
      record.requestedCheckpointFingerprint as string | null,
  });
}

function pinKey(pins: SourceRequestOperationPins): string {
  return JSON.stringify(pins);
}

function canonicalizeRequestedCheckpoint(
  pins: SourceRequestOperationPins,
  checkpoint: OpaqueCheckpointEnvelope | undefined,
): OpaqueCheckpointEnvelope | null {
  if (pins.operationKind !== "page_read") {
    if (checkpoint !== undefined) {
      throw new SourceRequestLeaseError("invalid_pins");
    }
    return null;
  }
  const parsed = opaqueCheckpointEnvelopeSchema.safeParse(checkpoint);
  if (
    !parsed.success ||
    parsed.data.sourceInstanceId !== pins.sourceInstanceId ||
    parsed.data.sourceRevisionId !== pins.sourceRevisionId ||
    parsed.data.sourceTypeKey !== pins.sourceTypeKey ||
    parsed.data.adapterVersion !== pins.adapterVersion ||
    parsed.data.checkpointGeneration !== pins.checkpointGeneration
  ) {
    throw new SourceRequestLeaseError("invalid_pins");
  }
  return Object.freeze({ ...parsed.data });
}

function checkpointsEqual(
  left: OpaqueCheckpointEnvelope | null,
  right: OpaqueCheckpointEnvelope | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function sourceRequestOperationPinsEqual(
  left: SourceRequestOperationPins,
  right: SourceRequestOperationPins,
): boolean {
  return pinKey(canonicalizePins(left)) === pinKey(canonicalizePins(right));
}

const releaseTerminalizedRequestPermit = Symbol(
  "release-terminalized-source-request-permit",
);
const releaseUnstartedRequestPermit = Symbol(
  "release-unstarted-source-request-permit",
);
const abandonLocallyFencedRequestLease = Symbol(
  "abandon-locally-fenced-source-request-lease",
);

export interface SourceRequestPermitTerminalizationProof {
  readonly requestAttemptId: string;
  readonly requestLeaseId: string;
}

export class SourceRequestLease {
  readonly pins: SourceRequestOperationPins;
  readonly #permit: PairedConnectionPermit;
  readonly #abortController = new AbortController();
  readonly #externalSignal: AbortSignal | undefined;
  readonly #onExternalAbort: (() => void) | undefined;
  readonly #requestedCheckpoint: OpaqueCheckpointEnvelope | null;
  #state: SourceRequestLeaseState = "available";

  constructor(
    issueAuthority: symbol,
    pins: SourceRequestOperationPins,
    permit: PairedConnectionPermit,
    requestedCheckpoint: OpaqueCheckpointEnvelope | null,
    externalSignal?: AbortSignal,
  ) {
    if (issueAuthority !== sourceRequestLeaseIssueAuthority) {
      throw new SourceRequestLeaseError("invalid_pins");
    }
    this.pins = canonicalizePins(pins);
    this.#permit = permit;
    this.#requestedCheckpoint = requestedCheckpoint;
    this.#externalSignal = externalSignal;
    this.#onExternalAbort = externalSignal === undefined
      ? undefined
      : () => this.cancel();
    externalSignal?.addEventListener("abort", this.#onExternalAbort!, {
      once: true,
    });
    if (externalSignal?.aborted === true) {
      this.cancel();
    }
  }

  get state(): SourceRequestLeaseState {
    return this.#state;
  }

  get signal(): AbortSignal {
    return this.#abortController.signal;
  }

  get requestPermitHeld(): boolean {
    return this.#permit.requestPermitHeld;
  }

  get executionSlotHeld(): boolean {
    return this.#permit.executionSlotHeld;
  }

  consume(
    expectedPins: SourceRequestOperationPins,
    expectedCheckpoint?: OpaqueCheckpointEnvelope,
  ): SourceRequestInvocation {
    if (this.#state === "consumed") {
      throw new SourceRequestLeaseError("already_consumed");
    }
    if (this.#state === "cancelled") {
      throw new SourceRequestLeaseError("cancelled");
    }
    if (this.#state === "closed") {
      throw new SourceRequestLeaseError("closed");
    }
    const canonicalExpectedCheckpoint = canonicalizeRequestedCheckpoint(
      expectedPins,
      expectedCheckpoint,
    );
    if (
      !sourceRequestOperationPinsEqual(this.pins, expectedPins) ||
      !checkpointsEqual(this.#requestedCheckpoint, canonicalExpectedCheckpoint)
    ) {
      throw new SourceRequestLeaseError("pin_mismatch");
    }
    this.#state = "consumed";
    return Object.freeze({ pins: this.pins, signal: this.signal });
  }

  cancel(): void {
    if (this.#state === "closed" || this.#state === "cancelled") {
      return;
    }
    const wasAvailable = this.#state === "available";
    this.#state = "cancelled";
    this.#removeExternalAbortListener();
    this.#abortController.abort();
    if (wasAvailable) {
      this.#permit.releaseAll();
    }
  }

  [releaseTerminalizedRequestPermit](
    proof: SourceRequestPermitTerminalizationProof,
  ): void {
    this.#assertConsumedOrCancelled();
    if (typeof proof !== "object" || proof === null) {
      throw new SourceRequestLeaseError("terminalization_receipt_mismatch");
    }
    const proofKeys = Reflect.ownKeys(proof);
    if (
      proofKeys.some((key) => typeof key !== "string") ||
      (proofKeys as string[]).sort().join("\0") !==
        ["requestAttemptId", "requestLeaseId"].sort().join("\0") ||
      proof.requestAttemptId !== this.pins.requestAttemptId ||
      proof.requestLeaseId !== this.pins.requestLeaseId
    ) {
      throw new SourceRequestLeaseError("terminalization_receipt_mismatch");
    }
    this.#permit.releaseRequestPermit();
  }

  [releaseUnstartedRequestPermit](): void {
    if (this.#state !== "available") {
      throw new SourceRequestLeaseError(
        this.#state === "closed" ? "closed" : "already_consumed",
      );
    }
    this.#state = "cancelled";
    this.#removeExternalAbortListener();
    this.#abortController.abort();
    // A bounded local validation rejected the operation before a durable
    // request attempt existed. Release only the profile permit; the generic
    // execution slot remains owned by the supervisor until its durable work
    // finalizer/diagnostic boundary completes.
    this.#permit.releaseRequestPermit();
  }

  releaseExecutionSlot(): void {
    this.#assertConsumedOrCancelled();
    if (this.#permit.requestPermitHeld) {
      throw new SourceRequestLeaseError("terminalization_required");
    }
    this.#permit.releaseExecutionSlot();
  }

  close(): void {
    if (this.#state === "closed") {
      return;
    }
    if (
      this.#permit.requestPermitHeld &&
      (this.#state === "consumed" || this.#state === "cancelled")
    ) {
      throw new SourceRequestLeaseError("terminalization_required");
    }
    this.#state = "closed";
    this.#removeExternalAbortListener();
    this.#permit.releaseAll();
  }

  [abandonLocallyFencedRequestLease](): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#removeExternalAbortListener();
    this.#abortController.abort();
    // This changes process-local counters only. The durable in-flight attempt
    // remains for the replacement epoch's mandatory reconciliation.
    this.#permit.releaseAll();
  }

  #assertConsumedOrCancelled(): void {
    if (this.#state === "available") {
      throw new SourceRequestLeaseError("not_consumed");
    }
    if (this.#state === "closed") {
      throw new SourceRequestLeaseError("closed");
    }
  }

  #removeExternalAbortListener(): void {
    if (this.#onExternalAbort !== undefined) {
      this.#externalSignal?.removeEventListener(
        "abort",
        this.#onExternalAbort,
      );
    }
  }
}

export class SourceRequestLeaseAuthority {
  readonly #coordinator: ConnectionPermitCoordinator;
  readonly #ownedLeases = new WeakSet<SourceRequestLease>();
  readonly #issuedLeases = new WeakSet<SourceRequestLease>();

  constructor(coordinator: ConnectionPermitCoordinator) {
    this.#coordinator = coordinator;
  }

  releaseTerminalizedRequestPermit(
    lease: SourceRequestLease,
    proof: SourceRequestPermitTerminalizationProof,
  ): void {
    if (!this.#ownedLeases.has(lease)) {
      throw new SourceRequestLeaseError("terminalization_receipt_mismatch");
    }
    lease[releaseTerminalizedRequestPermit](proof);
    this.#ownedLeases.delete(lease);
  }

  releaseUnstartedRequestPermit(lease: SourceRequestLease): void {
    if (!this.#ownedLeases.has(lease)) {
      throw new SourceRequestLeaseError("terminalization_receipt_mismatch");
    }
    lease[releaseUnstartedRequestPermit]();
    this.#ownedLeases.delete(lease);
  }

  cancelQueuedForProfile(profile: ConnectionProfilePermitIdentity): void {
    this.#coordinator.cancelQueuedForProfile(profile);
  }

  admissionWaitReason(
    profile: ConnectionProfilePermitIdentity,
  ): ConnectionPermitWaitReason | null {
    return this.#coordinator.waitReasonFor(profile);
  }

  /** Irreversible local owner fence used only for an uncertain request. */
  stopAdmission(): void {
    this.#coordinator.stopAdmission();
  }

  abandonLocallyFencedLease(lease: SourceRequestLease): void {
    if (!this.#coordinator.admissionStopped || !this.#issuedLeases.has(lease)) {
      throw new SourceRequestLeaseError("lost_ownership");
    }
    lease[abandonLocallyFencedRequestLease]();
    this.#ownedLeases.delete(lease);
  }

  async admit(
    input: SourceRequestLeaseAdmissionInput,
  ): Promise<SourceRequestLease> {
    const pins = canonicalizePins(input.pins);
    const requestedCheckpoint = canonicalizeRequestedCheckpoint(
      pins,
      input.requestedCheckpoint,
    );
    const profile: ConnectionProfilePermitIdentity = {
      organizationId: pins.organizationId,
      connectionProfileId: pins.connectionProfileId,
    };
    let permit: PairedConnectionPermit;
    try {
      permit = await this.#coordinator.acquire({
        profile,
        signal: input.signal,
      });
    } catch (error) {
      if (
        error instanceof ConnectionPermitCoordinatorError &&
        error.code === "cancelled"
      ) {
        throw new SourceRequestLeaseError("cancelled");
      }
      throw error;
    }

    try {
      if (signalIsAborted(input.signal)) {
        throw new SourceRequestLeaseError("cancelled");
      }
      const active = await input.guard(
        pins,
        requestedCheckpoint,
        input.signal ?? new AbortController().signal,
      );
      if (!active) {
        throw new SourceRequestLeaseError("lost_ownership");
      }
      if (signalIsAborted(input.signal)) {
        throw new SourceRequestLeaseError("cancelled");
      }
      const lease = new SourceRequestLease(
        sourceRequestLeaseIssueAuthority,
        pins,
        permit,
        requestedCheckpoint,
        input.signal,
      );
      this.#ownedLeases.add(lease);
      this.#issuedLeases.add(lease);
      return lease;
    } catch (error) {
      permit.releaseAll();
      if (error instanceof SourceRequestLeaseError) {
        throw error;
      }
      throw new SourceRequestLeaseError("guard_failed");
    }
  }
}
