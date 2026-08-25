import { createHash, randomUUID } from "node:crypto";
import {
  launchRecordIdScopeDeclarations,
  providerSourceLaunchBounds,
  type OpaqueCursorEnvelope,
  type ProviderSourcePageCommitPins,
  type SourceAdapterFailure,
} from "@packscout/contracts";
import {
  ProviderSourceRequestRepository,
  ProviderSourceTestResultRepository,
  type ProviderSourceSupervisorClaimedWork,
} from "@packscout/database";
import {
  AesGcmSourceConnectionConfigurationCipher,
  ControlPlaneRetryExhaustedError,
  RuntimeLocallyFencedError,
  SourceSupervisorStaleWorkError,
  SourceAdapterRegistry,
  SourceRequestLeaseError,
  captureAndTerminalizeSourceAdapterRequest,
  completeSourceAdapterConnectionTest,
  completeSourceAdapterPageRead,
  completeSourceAdapterRequestFailure,
  completeSourceAdapterSourceTest,
  createConnectionTestOperation,
  createPageReadOperation,
  createSourceTestOperation,
  interpretSourceAdapterConnectionTest,
  interpretSourceAdapterPage,
  interpretSourceAdapterSourceTest,
  providerSourceSuccessfulCaptureOutcomeHash,
  runControlPlaneTransaction,
  sourceAdapterInterpretationContextOf,
  type ControlPlaneFailureCode,
  type FailedSourceAdapterRequest,
  type ProductionProviderObservationMapperRegistry,
  type SourceAdapter,
  type SourceAdapterOperation,
  type SourceAdapterOperationResult,
  type SourceAdapterRequestTerminalizationInput,
  type SourceAdapterRequestResult,
  type SourceRequestLease,
  type SourceRequestLeaseAuthority,
  type SourceSupervisorExecutionContext,
  type SourceSupervisorExecutionResult,
  type SourceSupervisorWorkExecutor,
} from "@packscout/services";
import type { ProviderSourcePageImportService } from "@packscout/services";

interface ActiveRequest {
  readonly adapter: SourceAdapter;
  readonly authority: SourceRequestLeaseAuthority;
  readonly lease: SourceRequestLease;
  readonly organizationId: string;
  readonly connectionProfileId: string;
  phase: "begin_pending" | "request_active";
  cancelBeforeCall: boolean;
}

type ConnectionActionFailure = Extract<
  SourceAdapterFailure,
  { readonly disposition: "connection_action_required" }
>;

type ValidatedConnectionConfiguration = Extract<
  ReturnType<SourceAdapter["validateConnectionConfiguration"]>,
  { readonly ok: true }
>;

function invalidConnectionConfiguration(): ConnectionActionFailure {
  return {
    disposition: "connection_action_required",
    code: "profile_configuration_invalid",
  };
}

export interface ProviderSourceSupervisorExecutorDependencies {
  readonly sourceAdapters: SourceAdapterRegistry;
  readonly mappers: Pick<ProductionProviderObservationMapperRegistry, "resolve">;
  readonly connectionCipher: AesGcmSourceConnectionConfigurationCipher;
  readonly requests: ProviderSourceRequestRepository;
  readonly testResults: ProviderSourceTestResultRepository;
  readonly pageImports: ProviderSourcePageImportService;
  readonly classifyControlPlaneFailure: (
    error: unknown,
  ) => ControlPlaneFailureCode;
  readonly ids?: Readonly<{ id(): string }>;
  readonly clock?: Readonly<{ now(): Date }>;
}

function safeInteger(value: bigint, label: string): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 0) {
    throw new TypeError(`${label} is outside the safe integer range.`);
  }
  return converted;
}

function parseConfiguration(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new TypeError("Source connection configuration is not valid JSON.");
  }
}

function failureSafeCode(failure: SourceAdapterFailure): string {
  return failure.code.toUpperCase();
}

function failureSafeStatus(failure: SourceAdapterFailure): number | null {
  return "safeStatus" in failure ? failure.safeStatus ?? null : null;
}

function hasCanonicalRecordIdScopes(value: unknown): boolean {
  if (
    !Array.isArray(value) ||
    value.length !== launchRecordIdScopeDeclarations.length
  ) return false;
  // Activation persists the exact ordered scope keys, not declaration
  // objects. JSONB round-tripping therefore cannot depend on object key order.
  return value.every((candidate, index) =>
    typeof candidate === "string" &&
    candidate === launchRecordIdScopeDeclarations[index]?.recordIdScopeKey
  );
}

function failedOutcomeHash(
  input: Extract<SourceAdapterRequestTerminalizationInput["outcome"], { ok: false }>,
): string {
  return createHash("sha256").update(JSON.stringify({
    disposition: input.failure.disposition,
    code: input.failure.code,
    responseBytes: input.measurements.responseBytes,
    durationMilliseconds: input.measurements.durationMilliseconds,
  })).digest("hex");
}

function dispositionForFailure(
  failure: SourceAdapterFailure,
): SourceSupervisorExecutionResult {
  const safeCode = failureSafeCode(failure);
  if (failure.disposition === "cancelled") {
    return failure.code === "lost_ownership"
      ? { kind: "fenced" }
      : { kind: "stale" };
  }
  if (failure.disposition === "retryable") {
    // The supervisor's versioned fixed policy is authoritative. Adapter hints
    // are evidence only and can never schedule an earlier retry.
    return { kind: "retryable", safeCode };
  }
  if (failure.disposition === "connection_action_required") {
    return { kind: "connection_action_required", safeCode };
  }
  return { kind: "source_action_required", safeCode };
}

function connectionTestDatabaseOperation(
  work: Extract<ProviderSourceSupervisorClaimedWork, { kind: "connection_test" }>,
) {
  return {
    kind: "connection_test" as const,
    connectionTestJobId: work.id,
    blockingEpisodeId: work.recoveryEpisodeId,
  };
}

function sourceDatabaseOperation(
  work: Exclude<ProviderSourceSupervisorClaimedWork, { kind: "connection_test" }>,
) {
  return work.kind === "source_test"
    ? {
        kind: "source_test" as const,
        providerId: work.providerId,
        sourceInstanceId: work.sourceInstanceId,
        sourceRevisionId: work.sourceRevisionId,
        sourceTestJobId: work.id,
      }
    : {
        kind: "page_read" as const,
        providerId: work.providerId,
        sourceInstanceId: work.sourceInstanceId,
        sourceRevisionId: work.sourceRevisionId,
        runId: work.runId,
        pageNumber: work.pageNumber,
        cursorGeneration: work.cursorGeneration,
        requestedCursorFingerprint: work.requestedCursorFingerprint,
      };
}

/**
 * Production source-neutral execution boundary. It decrypts an exact revision,
 * takes one paired permit, durably records and terminalizes the request, then
 * interprets and commits without ever branching on a transport provider.
 */
export class ProviderSourceSupervisorWorkExecutor
  implements SourceSupervisorWorkExecutor<ProviderSourceSupervisorClaimedWork> {
  readonly #ids: Readonly<{ id(): string }>;
  readonly #clock: Readonly<{ now(): Date }>;
  readonly #active = new Set<ActiveRequest>();

  constructor(
    private readonly dependencies: ProviderSourceSupervisorExecutorDependencies,
  ) {
    this.#ids = dependencies.ids ?? { id: randomUUID };
    this.#clock = dependencies.clock ?? { now: () => new Date() };
  }

  registeredProfileRequestLimit(
    work: ProviderSourceSupervisorClaimedWork,
  ): number {
    return this.#adapterFor(work).manifest.maximumConnectionRequestCap;
  }

  async execute(
    work: ProviderSourceSupervisorClaimedWork,
    context: SourceSupervisorExecutionContext,
  ): Promise<SourceSupervisorExecutionResult> {
    context.runtimeFence.assertActive();
    const adapter = this.#adapterFor(work);
    const requestAttemptId = this.#ids.id();
    const requestLeaseId = this.#ids.id();
    const pageId = work.kind === "page_read" ? this.#ids.id() : null;
    const cursor = work.kind === "page_read"
      ? Object.freeze({
          sourceInstanceId: work.sourceInstanceId,
          sourceRevisionId: work.sourceRevisionId,
          sourceTypeKey: work.sourceTypeKey,
          adapterVersion: work.sourceAdapterVersion,
          cursorCodecKey: work.cursorCodecVersion,
          cursorGeneration: safeInteger(
            work.cursorGeneration,
            "Cursor generation",
          ),
          value: work.requestedCursorValue,
        } satisfies OpaqueCursorEnvelope)
      : null;
    const connectionHealthGeneration = safeInteger(
      work.connectionHealthGeneration,
      "Connection health generation",
    );
    const singletonFencingEpoch = context.epoch.epochNumber;
    const leasePins = work.kind === "connection_test"
      ? {
          operationKind: "connection_test" as const,
          requestAttemptId,
          requestLeaseId,
          organizationId: work.organizationId,
          sourceTypeKey: work.sourceTypeKey,
          adapterVersion: work.sourceAdapterVersion,
          singletonFencingEpoch,
          connectionProfileId: work.connectionProfileId,
          connectionProfileRevisionId: work.connectionRevisionId,
          connectionHealthGeneration,
          connectionTestJobId: work.id,
          jobClaimLeaseId: work.claimLeaseId,
          recoveryEpisodeId: work.recoveryEpisodeId,
        }
      : work.kind === "source_test"
        ? {
            operationKind: "source_test" as const,
            requestAttemptId,
            requestLeaseId,
            organizationId: work.organizationId,
            sourceTypeKey: work.sourceTypeKey,
            adapterVersion: work.sourceAdapterVersion,
            singletonFencingEpoch,
            connectionProfileId: work.connectionProfileId,
            connectionProfileRevisionId: work.connectionRevisionId,
            connectionHealthGeneration,
            provider: work.provider,
            sourceInstanceId: work.sourceInstanceId,
            sourceRevisionId: work.sourceRevisionId,
            normalizedContractVersion: work.normalizedContractVersion,
            identityNamespaceKey: work.identityNamespaceKey,
            sourceTestJobId: work.id,
            jobClaimLeaseId: work.claimLeaseId,
          }
        : {
            operationKind: "page_read" as const,
            requestAttemptId,
            requestLeaseId,
            organizationId: work.organizationId,
            sourceTypeKey: work.sourceTypeKey,
            adapterVersion: work.sourceAdapterVersion,
            singletonFencingEpoch,
            connectionProfileId: work.connectionProfileId,
            connectionProfileRevisionId: work.connectionRevisionId,
            connectionHealthGeneration,
            provider: work.provider,
            sourceInstanceId: work.sourceInstanceId,
            sourceRevisionId: work.sourceRevisionId,
            normalizedContractVersion: work.normalizedContractVersion,
            identityNamespaceKey: work.identityNamespaceKey,
            importRunId: work.runId,
            runClaimLeaseId: work.claimLeaseId,
            pageAttemptId: pageId!,
            pageNumber: work.pageNumber,
            pageLimit: providerSourceLaunchBounds.pageTargetRecords,
            cursorGeneration: cursor!.cursorGeneration,
            requestedCursorFingerprint: work.requestedCursorFingerprint,
          };

    const admissionController = new AbortController();
    const admissionSignal = AbortSignal.any([
      context.signal,
      admissionController.signal,
    ]);
    const admissionProfile = {
      organizationId: work.organizationId,
      connectionProfileId: work.connectionProfileId,
    } as const;
    const waitReason = context.requestLeases.admissionWaitReason(admissionProfile);
    const pendingLease = leasePins.operationKind === "page_read"
      ? context.requestLeases.admit({
          pins: leasePins,
          requestedCursor: cursor!,
          signal: admissionSignal,
          guard: () => {
            context.runtimeFence.assertActive();
            return !admissionSignal.aborted;
          },
        })
      : context.requestLeases.admit({
          pins: leasePins,
          signal: admissionSignal,
          guard: () => {
            context.runtimeFence.assertActive();
            return !admissionSignal.aborted;
          },
        });
    try {
      // Register with the in-process FIFO before the durable wait-state write.
      // A slow database write must never let newer work jump this operation.
      if (waitReason) await context.admissionWaiting(waitReason);
      await context.capacityChanged();
    } catch (error) {
      admissionController.abort();
      await pendingLease.catch(() => undefined);
      throw error;
    }
    const lease = await pendingLease;
    const active: ActiveRequest = {
      adapter,
      authority: context.requestLeases,
      lease,
      organizationId: work.organizationId,
      connectionProfileId: work.connectionProfileId,
      phase: "begin_pending",
      cancelBeforeCall: false,
    };
    this.#active.add(active);
    const releaseTerminalizedSlot = () => {
      this.#active.delete(active);
      if (lease.state !== "closed") {
        lease.releaseExecutionSlot();
        lease.close();
      }
    };
    const releaseUnusedLease = () => {
      this.#active.delete(active);
      lease.cancel();
      lease.close();
    };
    const retainSlotAfterUnstartedRejection = async (
      result: SourceSupervisorExecutionResult,
    ): Promise<SourceSupervisorExecutionResult> => {
      context.requestLeases.releaseUnstartedRequestPermit(lease);
      try {
        context.retainExecutionSlot(releaseTerminalizedSlot);
      } catch (error) {
        releaseTerminalizedSlot();
        throw error;
      }
      await context.capacityChanged();
      return result;
    };
    const abandonUncertainRequest = () => {
      adapter.cancelRequest(lease);
      lease.cancel();
      context.requestLeases.stopAdmission();
      try {
        context.requestLeases.abandonLocallyFencedLease(lease);
      } finally {
        this.#active.delete(active);
      }
    };
    const terminalizeCancelledBeforeCall = async (): Promise<void> => {
      await this.#controlPlane(context, () =>
        this.dependencies.requests.terminalize({
          organizationId: work.organizationId,
          requestAttemptId,
          supervisorEpochId: context.epoch.epochId,
          supervisorOwnerKey: context.epoch.ownerKey,
          supervisorLeaseToken: context.epoch.leaseToken,
          state: "failed",
          outcomeClass: "cancelled",
          safeCode: "profile_cancelled_before_call",
          safeOutcomeHash: createHash("sha256").update(JSON.stringify({
            domain: "packscout-source-profile-cancelled-before-call:v1",
            requestAttemptId,
            requestLeaseId,
          })).digest("hex"),
          responseBytes: 0,
          durationMs: 0,
          terminalAt: this.#clock.now(),
        }));
    };
    const retainCancelledBeforeCallSlot = async () => {
      if (leasePins.operationKind === "page_read") {
        lease.consume(leasePins, cursor!);
      } else {
        lease.consume(leasePins);
      }
      context.requestLeases.releaseTerminalizedRequestPermit(lease, {
        requestAttemptId,
        requestLeaseId,
      });
      try {
        context.retainExecutionSlot(releaseTerminalizedSlot);
      } catch (error) {
        releaseTerminalizedSlot();
        throw error;
      }
      await context.capacityChanged();
    };

    let operation: SourceAdapterOperation;
    let validatedConnection: ValidatedConnectionConfiguration | null = null;
    let connectionConfigurationFailure: ConnectionActionFailure | null = null;
    let sourceConfiguration: ReturnType<
      SourceAdapter["validateSourceConfiguration"]
    > | null = null;
    try {
      await context.admissionGranted();
      await context.capacityChanged();
      if (work.kind !== "connection_test") {
        try {
          this.dependencies.mappers.resolve({
            mapperKey: work.mapperKey,
            mapperVersion: work.mapperVersion,
            provider: work.provider,
            normalizedContractVersion: work.normalizedContractVersion,
            identityNamespaceKey: work.identityNamespaceKey,
          });
        } catch {
          return await retainSlotAfterUnstartedRejection({
            kind: "source_action_required",
            safeCode: "MAPPER_REGISTRATION_INCOMPATIBLE",
          });
        }
      }
      try {
        const connectionPlaintext = this.dependencies.connectionCipher.decrypt(
          work.connectionConfiguration,
          {
            organizationId: work.organizationId,
            connectionProfileId: work.connectionProfileId,
            connectionRevisionId: work.connectionRevisionId,
          },
        );
        const validation = adapter.validateConnectionConfiguration(
          parseConfiguration(connectionPlaintext),
        );
        if (validation.ok) {
          validatedConnection = validation;
        } else {
          connectionConfigurationFailure =
            validation.failure.disposition === "connection_action_required"
              ? validation.failure
              : invalidConnectionConfiguration();
        }
      } catch {
        connectionConfigurationFailure = invalidConnectionConfiguration();
      }
      sourceConfiguration = work.kind === "connection_test"
        ? null
        : adapter.validateSourceConfiguration(
            work.provider,
            work.sourceConfiguration,
          );
      if (sourceConfiguration !== null && !sourceConfiguration.ok) {
        return await retainSlotAfterUnstartedRejection({
          kind: "source_action_required",
          safeCode: failureSafeCode(sourceConfiguration.failure),
        });
      }
      if (
        work.kind !== "connection_test" &&
        !hasCanonicalRecordIdScopes(work.recordIdScopes)
      ) {
        return await retainSlotAfterUnstartedRejection({
          kind: "source_action_required",
          safeCode: "RECORD_ID_SCOPE_MISMATCH",
        });
      }
      if (validatedConnection === null && connectionConfigurationFailure === null) {
        throw new TypeError("Connection validation produced no disposition.");
      }
      operation = connectionConfigurationFailure !== null
        ? null as never
        : work.kind === "connection_test"
        ? createConnectionTestOperation({
            operationKind: "connection_test",
            organizationId: work.organizationId,
            sourceTypeKey: work.sourceTypeKey,
            adapterVersion: work.sourceAdapterVersion,
            connectionProfileId: work.connectionProfileId,
            connectionProfileRevisionId: work.connectionRevisionId,
            connectionConfiguration: validatedConnection!.value,
            requestLease: lease,
            bounds: adapter.manifest.requestBounds,
            correlation: {
              singletonFencingEpoch,
              connectionHealthGeneration,
              connectionTestJobId: work.id,
              jobClaimLeaseId: work.claimLeaseId,
              recoveryEpisodeId: work.recoveryEpisodeId,
            },
          })
        : work.kind === "source_test"
          ? createSourceTestOperation({
              operationKind: "source_test",
              organizationId: work.organizationId,
              sourceTypeKey: work.sourceTypeKey,
              adapterVersion: work.sourceAdapterVersion,
              connectionProfileId: work.connectionProfileId,
              connectionProfileRevisionId: work.connectionRevisionId,
              connectionConfiguration: validatedConnection!.value,
              requestLease: lease,
              bounds: adapter.manifest.requestBounds,
              provider: work.provider,
              sourceInstanceId: work.sourceInstanceId,
              sourceRevisionId: work.sourceRevisionId,
              normalizedContractVersion: work.normalizedContractVersion,
              identityNamespaceKey: work.identityNamespaceKey,
              recordIdScopes: launchRecordIdScopeDeclarations,
              sourceConfiguration: sourceConfiguration!.value,
              correlation: {
                singletonFencingEpoch,
                connectionHealthGeneration,
                sourceTestJobId: work.id,
                jobClaimLeaseId: work.claimLeaseId,
              },
            })
          : createPageReadOperation({
              operationKind: "page_read",
              organizationId: work.organizationId,
              sourceTypeKey: work.sourceTypeKey,
              adapterVersion: work.sourceAdapterVersion,
              connectionProfileId: work.connectionProfileId,
              connectionProfileRevisionId: work.connectionRevisionId,
              connectionConfiguration: validatedConnection!.value,
              requestLease: lease,
              bounds: adapter.manifest.requestBounds,
              provider: work.provider,
              sourceInstanceId: work.sourceInstanceId,
              sourceRevisionId: work.sourceRevisionId,
              normalizedContractVersion: work.normalizedContractVersion,
              identityNamespaceKey: work.identityNamespaceKey,
              recordIdScopes: launchRecordIdScopeDeclarations,
              sourceConfiguration: sourceConfiguration!.value,
              correlation: {
                singletonFencingEpoch,
                connectionHealthGeneration,
                importRunId: work.runId,
                runClaimLeaseId: work.claimLeaseId,
                pageAttemptId: pageId!,
                pageNumber: work.pageNumber,
                cursorGeneration: cursor!.cursorGeneration,
                requestedCursorFingerprint:
                  work.requestedCursorFingerprint,
                requestedCursor: cursor!,
                pageLimit: providerSourceLaunchBounds.pageTargetRecords,
              },
            });
      try {
        await this.#controlPlane(context, () => this.dependencies.requests.begin({
          id: requestAttemptId,
          organizationId: work.organizationId,
          requestLeaseId,
          claimOwner: work.claimOwner,
          claimToken: work.claimToken,
          supervisorEpochId: context.epoch.epochId,
          supervisorOwnerKey: context.epoch.ownerKey,
          supervisorLeaseToken: context.epoch.leaseToken,
          connectionProfileId: work.connectionProfileId,
          connectionRevisionId: work.connectionRevisionId,
          expectedHealthGeneration: work.connectionHealthGeneration,
          operation: work.kind === "connection_test"
            ? connectionTestDatabaseOperation(work)
            : sourceDatabaseOperation(work),
          startedAt: this.#clock.now(),
        }));
      } catch (beginError) {
        if (beginError instanceof SourceSupervisorStaleWorkError) {
          try {
            await terminalizeCancelledBeforeCall();
          } catch (terminalError) {
            if (terminalError instanceof SourceSupervisorStaleWorkError) {
              throw beginError;
            }
            abandonUncertainRequest();
            if (
              terminalError instanceof ControlPlaneRetryExhaustedError ||
              terminalError instanceof RuntimeLocallyFencedError
            ) throw terminalError;
            throw new RuntimeLocallyFencedError();
          }
          await retainCancelledBeforeCallSlot();
          return { kind: "stale" };
        }
        throw beginError;
      }
    } catch (error) {
      releaseUnusedLease();
      await context.capacityChanged();
      throw error;
    }
    if (active.cancelBeforeCall) {
      try {
        await terminalizeCancelledBeforeCall();
      } catch (error) {
        abandonUncertainRequest();
        if (
          error instanceof ControlPlaneRetryExhaustedError ||
          error instanceof RuntimeLocallyFencedError
        ) throw error;
        throw new RuntimeLocallyFencedError();
      }
      await retainCancelledBeforeCallSlot();
      return { kind: "stale" };
    }
    active.phase = "request_active";

    if (connectionConfigurationFailure !== null) {
      try {
        if (leasePins.operationKind === "page_read") {
          lease.consume(leasePins, cursor!);
        } else {
          lease.consume(leasePins);
        }
        await this.#controlPlane(context, () =>
          this.dependencies.requests.terminalize({
            organizationId: work.organizationId,
            requestAttemptId,
            supervisorEpochId: context.epoch.epochId,
            supervisorOwnerKey: context.epoch.ownerKey,
            supervisorLeaseToken: context.epoch.leaseToken,
            state: "failed",
            outcomeClass: connectionConfigurationFailure.disposition,
            safeCode: connectionConfigurationFailure.code,
            safeOutcomeHash: createHash("sha256").update(JSON.stringify({
              domain: "packscout-source-local-connection-failure:v1",
              requestAttemptId,
              disposition: connectionConfigurationFailure.disposition,
              code: connectionConfigurationFailure.code,
            })).digest("hex"),
            responseStatus: failureSafeStatus(connectionConfigurationFailure),
            responseBytes: 0,
            durationMs: 0,
            terminalAt: this.#clock.now(),
            blockingFailure: {
              failureClass: connectionConfigurationFailure.code,
              safeCode: connectionConfigurationFailure.code,
            },
          }));
        this.#abortProfile(work.organizationId, work.connectionProfileId);
        context.requestLeases.cancelQueuedForProfile({
          organizationId: work.organizationId,
          connectionProfileId: work.connectionProfileId,
        });
        context.requestLeases.releaseTerminalizedRequestPermit(lease, {
          requestAttemptId,
          requestLeaseId,
        });
      } catch (error) {
        abandonUncertainRequest();
        if (
          error instanceof ControlPlaneRetryExhaustedError ||
          error instanceof RuntimeLocallyFencedError
        ) throw error;
        throw new RuntimeLocallyFencedError();
      }
      try {
        context.retainExecutionSlot(releaseTerminalizedSlot);
      } catch (error) {
        releaseTerminalizedSlot();
        throw error;
      }
      await context.capacityChanged();
      await context.recordDiagnostic("adapter_request_started", {
        requestAttemptId,
      });
      return dispositionForFailure(connectionConfigurationFailure);
    }

    let request: SourceAdapterRequestResult;
    try {
      request = await captureAndTerminalizeSourceAdapterRequest(
        context.requestLeases,
        adapter,
        operation,
        async (terminalization) => {
        const blockingFailure = !terminalization.outcome.ok &&
            terminalization.outcome.failure.disposition ===
              "connection_action_required"
          ? {
              failureClass: terminalization.outcome.failure.code,
              safeCode: terminalization.outcome.failure.code,
            }
          : null;
        await this.#controlPlane(context, () =>
          this.dependencies.requests.terminalize({
            organizationId: work.organizationId,
            requestAttemptId,
            supervisorEpochId: context.epoch.epochId,
            supervisorOwnerKey: context.epoch.ownerKey,
            supervisorLeaseToken: context.epoch.leaseToken,
            state: terminalization.outcome.ok ? "captured" : "failed",
            outcomeClass: terminalization.outcome.ok
              ? "response_captured"
              : terminalization.outcome.failure.disposition,
            safeCode: terminalization.outcome.ok
              ? null
              : terminalization.outcome.failure.code,
            safeOutcomeHash: terminalization.outcome.ok
              ? providerSourceSuccessfulCaptureOutcomeHash(
                  terminalization.outcome,
                )
              : failedOutcomeHash(terminalization.outcome),
            responseStatus: terminalization.outcome.ok
              ? null
              : failureSafeStatus(terminalization.outcome.failure),
            responseBytes: terminalization.outcome.measurements.responseBytes,
            durationMs:
              terminalization.outcome.measurements.durationMilliseconds,
            terminalAt: this.#clock.now(),
            blockingFailure,
          }));
        if (blockingFailure) {
          this.#abortProfile(work.organizationId, work.connectionProfileId);
          context.requestLeases.cancelQueuedForProfile({
            organizationId: work.organizationId,
            connectionProfileId: work.connectionProfileId,
          });
        }
        return {
          requestAttemptId,
          requestLeaseId,
          operationScope: terminalization.operationScope,
        };
        },
      );
    } catch (error) {
      abandonUncertainRequest();
      if (
        error instanceof ControlPlaneRetryExhaustedError ||
        error instanceof RuntimeLocallyFencedError
      ) throw error;
      // A thrown capture has no trustworthy terminal outcome. Fence the owner
      // and leave the durable in-flight attempt for takeover reconciliation.
      throw new RuntimeLocallyFencedError();
    }
    try {
      context.retainExecutionSlot(releaseTerminalizedSlot);
    } catch (error) {
      releaseTerminalizedSlot();
      throw error;
    }
    await context.capacityChanged();
    await context.recordDiagnostic("adapter_request_started", {
      requestAttemptId,
    });

    if (!request.ok) {
      const operationResult = completeSourceAdapterRequestFailure(
        operation,
        request as FailedSourceAdapterRequest,
      );
      if (operationResult.ok) {
        throw new TypeError("Failed request produced a successful result.");
      }
      if (
        operationResult.failure.disposition !== "connection_action_required"
      ) {
        await this.#completeTestResult(
          work,
          context,
          requestAttemptId,
          operationResult,
        );
      }
      if (operationResult.failure.disposition === "connection_action_required") {
        return dispositionForFailure(operationResult.failure);
      }
      return work.kind === "source_test"
        ? {
            kind: "source_action_required",
            safeCode: failureSafeCode(operationResult.failure),
          }
        : work.kind === "connection_test"
          ? { kind: "test_terminal" }
          : dispositionForFailure(operationResult.failure);
    }

    if (work.kind === "connection_test" && operation.operationKind === "connection_test") {
      const interpretation = await interpretSourceAdapterConnectionTest(
        adapter,
        operation,
        request,
      );
      const result = completeSourceAdapterConnectionTest(
        operation,
        sourceAdapterInterpretationContextOf(operation),
        request,
        interpretation,
      );
      await this.#completeTestResult(work, context, requestAttemptId, result);
      return { kind: "test_terminal" };
    }
    if (work.kind === "source_test" && operation.operationKind === "source_test") {
      const interpretation = await interpretSourceAdapterSourceTest(
        adapter,
        operation,
        request,
      );
      const result = completeSourceAdapterSourceTest(
        operation,
        sourceAdapterInterpretationContextOf(operation),
        request,
        interpretation,
      );
      await this.#completeTestResult(work, context, requestAttemptId, result);
      return result.ok
        ? { kind: "test_terminal" }
        : {
            kind: "source_action_required",
            safeCode: failureSafeCode(result.failure),
          };
    }
    if (work.kind !== "page_read" || operation.operationKind !== "page_read") {
      return { kind: "source_action_required", safeCode: "WORK_KIND_MISMATCH" };
    }
    const interpretation = await interpretSourceAdapterPage(
      adapter,
      operation,
      request,
    );
    const result = completeSourceAdapterPageRead(
      operation,
      sourceAdapterInterpretationContextOf(operation),
      request,
      interpretation,
    );
    if (!result.ok) return dispositionForFailure(result.failure);
    const commitPins: ProviderSourcePageCommitPins = {
      organizationId: work.organizationId,
      providerId: work.providerId,
      provider: work.provider,
      sourceInstanceId: work.sourceInstanceId,
      sourceRevisionId: work.sourceRevisionId,
      sourceTypeKey: work.sourceTypeKey,
      sourceAdapterVersion: work.sourceAdapterVersion,
      normalizedContractVersion: work.normalizedContractVersion,
      mapperKey: work.mapperKey,
      mapperVersion: work.mapperVersion,
      identityNamespaceKey: work.identityNamespaceKey,
      connectionProfileId: work.connectionProfileId,
      connectionRevisionId: work.connectionRevisionId,
      connectionHealthGeneration: work.connectionHealthGeneration,
      requestAttemptId,
      requestLeaseId,
      supervisorEpochId: context.epoch.epochId,
      singletonFencingEpoch,
      supervisorOwnerKey: context.epoch.ownerKey,
      supervisorLeaseToken: context.epoch.leaseToken,
      runId: work.runId,
      runTrigger: work.runTrigger,
      runLeaseOwner: work.claimOwner,
      runLeaseToken: work.claimToken,
      runClaimLeaseId: work.claimLeaseId,
      pageId: pageId!,
      pageNumber: work.pageNumber,
      cursorCodecVersion: work.cursorCodecVersion,
      cursorGeneration: work.cursorGeneration,
      requestedCursor: cursor!,
      requestedCursorFingerprint: work.requestedCursorFingerprint,
    };
    const committed = await this.#controlPlane(context, () =>
      this.dependencies.pageImports.importPage({
        pins: commitPins,
        adapterResult: result,
        committedAt: this.#clock.now(),
      }));
    return {
      kind: "page_committed",
      cursorFingerprint: committed.cursorFingerprint,
      continuation: committed.continuation,
      pagesCommitted: work.committedPages + 1,
      recordsCommitted:
        work.committedRecords + result.measurements.recordCount,
      pauseRequested: false,
    };
  }

  abortAll(
    reason: "capacity" | "claim_lost" | "ownership_lost" | "shutdown",
  ): void {
    for (const active of this.#active) {
      if (active.phase === "begin_pending" && reason !== "ownership_lost") {
        active.cancelBeforeCall = true;
        continue;
      }
      active.adapter.cancelRequest(active.lease);
      active.lease.cancel();
      if (reason === "ownership_lost") {
        active.authority.abandonLocallyFencedLease(active.lease);
        this.#active.delete(active);
      }
    }
  }

  #abortProfile(organizationId: string, connectionProfileId: string): void {
    for (const active of this.#active) {
      if (
        active.organizationId === organizationId &&
        active.connectionProfileId === connectionProfileId
      ) {
        if (active.phase === "begin_pending") {
          active.cancelBeforeCall = true;
          continue;
        }
        active.adapter.cancelRequest(active.lease);
        active.lease.cancel();
      }
    }
  }

  #adapterFor(work: ProviderSourceSupervisorClaimedWork): SourceAdapter {
    return work.kind === "connection_test"
      ? this.dependencies.sourceAdapters.resolveSourceType(
          work.sourceTypeKey,
          work.sourceAdapterVersion,
        )
      : this.dependencies.sourceAdapters.resolve(
          work.sourceTypeKey,
          work.sourceAdapterVersion,
          work.provider,
        );
  }

  async #controlPlane<TResult>(
    context: SourceSupervisorExecutionContext,
    transact: () => Promise<TResult>,
  ): Promise<TResult> {
    try {
      return await runControlPlaneTransaction({
        runtimeFence: context.runtimeFence,
        revalidate: () => {
          context.runtimeFence.assertActive();
          if (context.signal.aborted) throw new RuntimeLocallyFencedError();
        },
        transact,
        classifyFailure: this.dependencies.classifyControlPlaneFailure,
        onExhausted: () => undefined,
      });
    } catch (error) {
      const classification = this.dependencies.classifyControlPlaneFailure(error);
      if (classification === "stale_fence") {
        throw new SourceSupervisorStaleWorkError();
      }
      if (classification === "lost_ownership") {
        throw new RuntimeLocallyFencedError();
      }
      throw error;
    }
  }

  async #completeTestResult(
    work: ProviderSourceSupervisorClaimedWork,
    context: SourceSupervisorExecutionContext,
    requestAttemptId: string,
    result: SourceAdapterOperationResult<unknown>,
  ): Promise<void> {
    if (work.kind === "page_read") return;
    const common = {
      organizationId: work.organizationId,
      jobId: work.id,
      requestAttemptId,
      claimOwner: work.claimOwner,
      claimToken: work.claimToken,
      supervisorEpochId: context.epoch.epochId,
      supervisorOwnerKey: context.epoch.ownerKey,
      supervisorLeaseToken: context.epoch.leaseToken,
      outcome: result.ok ? "success" as const : "failure" as const,
      safeCode: result.ok ? null : result.failure.code,
      measurements: {
        duration_ms: result.measurements.durationMilliseconds,
        response_bytes: result.measurements.responseBytes,
        record_count: result.measurements.recordCount,
      },
      completedAt: this.#clock.now(),
    };
    await this.#controlPlane(context, () => work.kind === "connection_test"
      ? this.dependencies.testResults.completeConnectionTest({
          ...common,
          responseStatus: result.ok ? null : failureSafeStatus(result.failure),
          latencyMs: result.measurements.durationMilliseconds,
        })
      : this.dependencies.testResults.completeSourceTest(common));
  }
}

export { ControlPlaneRetryExhaustedError, SourceRequestLeaseError };
