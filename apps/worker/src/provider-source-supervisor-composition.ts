import { createHmac, randomUUID } from "node:crypto";
import {
  PersistenceError,
  ProviderSourceDiagnosticRepository,
  ProviderSourceRequestRepository,
  ProviderSourceSupervisorRepository,
  ProviderSourceSupervisorSnapshotRepository,
  ProviderSourceSupervisorWorkRepository,
  ProviderSourceTestResultRepository,
  providerSourceSupervisorDiagnosticId,
  type DiagnosticEventInput,
  type PackscoutPrismaClient,
  type ProviderSourceSupervisorClaimedWork,
} from "@packscout/database";
import {
  AesGcmSourceConnectionConfigurationCipher,
  ControlPlaneTransactionError,
  ProviderSourceSupervisor,
  RuntimeLocallyFencedError,
  type ControlPlaneFailureCode,
  type SourceSupervisorCapacityAdmissionHook,
  type SourceSupervisorDiagnosticPort,
  type SourceSupervisorEpoch,
  type SourceSupervisorWorkDisposition,
} from "@packscout/services";
import { createProviderSourceImportComposition } from
  "./provider-source-import-composition.ts";
import { ProviderSourceSupervisorWorkExecutor } from
  "./provider-source-supervisor-executor.ts";
import { createProviderSourceCapacityAdmissionHook } from
  "./provider-source-capacity-admission.ts";
import type { ProviderSourceSupervisorConfiguration } from
  "./source-supervisor-runtime-config.ts";

export type ProviderSourceSupervisorRuntime = ProviderSourceSupervisor<
  ProviderSourceSupervisorClaimedWork
>;

export interface ProviderSourceSupervisorCompositionInput {
  readonly configuration: ProviderSourceSupervisorConfiguration;
  readonly database: PackscoutPrismaClient;
  readonly capacity?: SourceSupervisorCapacityAdmissionHook<
    ProviderSourceSupervisorClaimedWork
  >;
}

function epochFence(epoch: SourceSupervisorEpoch) {
  return {
    epochId: epoch.epochId,
    ownerKey: epoch.ownerKey,
    leaseToken: epoch.leaseToken,
  } as const;
}

function safeEpochNumber(value: bigint): number {
  const converted = Number(value);
  if (!Number.isSafeInteger(converted) || converted < 1) {
    throw new TypeError("Supervisor epoch number exceeds the safe range.");
  }
  return converted;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error &&
      typeof error.code === "string"
    ? error.code
    : null;
}

/** Exact source-neutral mapping: only database transport failures are retried. */
export function classifyProviderSourceControlPlaneFailure(
  error: unknown,
): ControlPlaneFailureCode {
  if (error instanceof RuntimeLocallyFencedError) return "lost_ownership";
  if (error instanceof ControlPlaneTransactionError) return error.code;
  if (error instanceof PersistenceError) {
    if (
      error.code === "SUPERVISOR_OWNERSHIP_LOST" ||
      error.code === "RUN_OWNERSHIP_LOST"
    ) return "lost_ownership";
    if (
      error.code === "SOURCE_FENCED" ||
      error.code === "HEALTH_GENERATION_STALE" ||
      error.code === "CONNECTION_BLOCKED" ||
      error.code === "REQUEST_ATTEMPT_TERMINAL" ||
      error.code === "NOT_FOUND"
    ) return "stale_fence";
    return "invariant";
  }
  const code = errorCode(error);
  if (code === "P2034" || code === "40001") return "serialization";
  if (code === "40P01") return "deadlock";
  if (
    code === "P1001" || code === "P1002" || code === "P1008" ||
    code === "P1017" || code === "57P01" || code === "08006"
  ) return "connection";
  if (code === "P2024" || code === "57014") return "timeout";
  return "invariant";
}

function diagnosticSafeCode(
  transition: string,
  disposition: SourceSupervisorWorkDisposition | undefined,
  explicit: string | undefined,
): string {
  if (explicit) return explicit;
  if (disposition && "safeCode" in disposition) return disposition.safeCode;
  return transition.toUpperCase();
}

function diagnosticPort(
  repository: ProviderSourceDiagnosticRepository,
): SourceSupervisorDiagnosticPort<ProviderSourceSupervisorClaimedWork> {
  return {
    async record(input) {
      const { work } = input;
      if (new Set([
        "adapter_request_started",
        "lease_lost",
        "work_claimed",
        "page_committed",
        "continuation_queued",
        "head_reached",
        "pause_completed",
        "retry_scheduled",
        "terminal",
      ]).has(input.transition)) {
        // These transitions are committed by their owning request/page/test/
        // queue transaction. Local output is only a sanitized process mirror.
        process.stdout.write(`${JSON.stringify({
          event: "provider_source_supervisor_transition",
          transition: input.transition,
          workKind: work.kind,
          organizationId: work.organizationId,
          connectionProfileId: work.connectionProfileId,
          safeCode: diagnosticSafeCode(
            input.transition,
            input.disposition,
            input.safeCode,
          ),
        })}\n`);
        return;
      }
      const shared = {
        id: providerSourceSupervisorDiagnosticId(work, input.transition),
        organizationId: work.organizationId,
        severity: input.disposition?.kind === "retrying" ||
            input.disposition?.kind === "action_required" ||
            input.disposition?.kind === "connection_blocked"
          ? "warning" as const
          : "info" as const,
        phase: input.transition,
        safeCode: diagnosticSafeCode(
          input.transition,
          input.disposition,
          input.safeCode,
        ),
        occurredAt: new Date(),
        sourceTypeKey: work.sourceTypeKey,
        sourceAdapterVersion: work.sourceAdapterVersion,
        connectionProfileId: work.connectionProfileId,
        connectionRevisionId: work.connectionRevisionId,
        retryDelayMs: input.disposition?.kind === "retrying"
          ? input.disposition.retryDelayMilliseconds
          : null,
        checkpointFingerprint:
          input.disposition && "checkpointFingerprint" in input.disposition
            ? input.disposition.checkpointFingerprint
            : work.kind === "page_read"
              ? work.requestedCheckpointFingerprint
              : null,
        continuation: input.disposition?.kind === "continued"
          ? { kind: "continue" as const }
          : input.disposition?.kind === "reached_head"
            ? {
                kind: "poll_after" as const,
                minimumDelaySeconds: input.disposition.minimumDelaySeconds,
              }
            : null,
      };
      let diagnostic: DiagnosticEventInput;
      if (work.kind === "connection_test") {
        diagnostic = {
          ...shared,
          scope: "connection",
          correlationKind: "connection_test",
          eventKind: "connection_test",
          connectionTestJobId: work.id,
          blockingEpisodeId: work.recoveryEpisodeId,
          requestAttemptId: input.requestAttemptId ?? null,
        };
      } else if (work.kind === "source_test") {
        diagnostic = {
          ...shared,
          scope: "source",
          correlationKind: "source_test",
          eventKind: "source_test",
          normalizedContractVersion: work.normalizedContractVersion,
          providerId: work.providerId,
          sourceInstanceId: work.sourceInstanceId,
          sourceRevisionId: work.sourceRevisionId,
          sourceTestJobId: work.id,
          requestAttemptId: input.requestAttemptId ?? null,
        };
      } else if (input.requestAttemptId || input.pageId) {
        const pageIdentity = input.pageId
          ? {
              pageId: input.pageId,
              requestAttemptId: input.requestAttemptId ?? null,
            }
          : {
              requestAttemptId: input.requestAttemptId!,
            };
        diagnostic = {
          ...shared,
          scope: "source",
          correlationKind: "page",
          eventKind: "source_page",
          normalizedContractVersion: work.normalizedContractVersion,
          providerId: work.providerId,
          sourceInstanceId: work.sourceInstanceId,
          sourceRevisionId: work.sourceRevisionId,
          runId: work.runId,
          runTrigger: work.runTrigger,
          ...pageIdentity,
        };
      } else {
        diagnostic = {
          ...shared,
          scope: "source",
          correlationKind: "run",
          eventKind: "source_run",
          normalizedContractVersion: work.normalizedContractVersion,
          providerId: work.providerId,
          sourceInstanceId: work.sourceInstanceId,
          sourceRevisionId: work.sourceRevisionId,
          runId: work.runId,
          runTrigger: work.runTrigger,
        };
      }
      if (input.transition === "adapter_request_started") {
        if (!input.requestAttemptId) {
          throw new TypeError("Request-start diagnostic requires an attempt.");
        }
        await repository.appendTerminalRequestStart(diagnostic);
        return;
      }
      await repository.appendAtDatabaseTime(diagnostic);
    },
  };
}

export function createProviderSourceSupervisorRuntime(
  input: ProviderSourceSupervisorCompositionInput,
): ProviderSourceSupervisorRuntime {
  const ownershipRepository = new ProviderSourceSupervisorRepository(
    input.database,
  );
  const workRepository = new ProviderSourceSupervisorWorkRepository(
    input.database,
  );
  const requestRepository = new ProviderSourceRequestRepository(input.database);
  const testResults = new ProviderSourceTestResultRepository(input.database);
  const snapshots = new ProviderSourceSupervisorSnapshotRepository(
    input.database,
  );
  const sourceImports = createProviderSourceImportComposition({
    database: input.database,
    actorPseudonymKey: input.configuration.actorPseudonymKey,
  });
  const cipher = new AesGcmSourceConnectionConfigurationCipher({
    primaryVersion: input.configuration.sourceConnectionConfigurationKeyVersion,
    keys: new Map([[
      input.configuration.sourceConnectionConfigurationKeyVersion,
      input.configuration.sourceConnectionConfigurationKey,
    ]]),
  });
  const executor = new ProviderSourceSupervisorWorkExecutor({
    sourceAdapters: sourceImports.sourceAdapters,
    mappers: sourceImports.mappers,
    connectionCipher: cipher,
    requests: requestRepository,
    testResults,
    pageImports: sourceImports.pageImports,
    classifyControlPlaneFailure: classifyProviderSourceControlPlaneFailure,
  });
  const uncertainOutcomeKey = input.configuration.actorPseudonymKey;
  return new ProviderSourceSupervisor({
    environmentKey: input.configuration.environment,
    ownerKey: input.configuration.workerId,
    leaseToken: randomUUID(),
    ownership: {
      async acquire(identity) {
        const acquired = await ownershipRepository.acquire({
          ...identity,
          now: new Date(),
        });
        return {
          epochId: acquired.epochId,
          epochNumber: safeEpochNumber(acquired.epochNumber),
          ownerKey: identity.ownerKey,
          leaseToken: identity.leaseToken,
          leaseExpiresAt: acquired.leaseExpiresAt,
        };
      },
      renew: (epoch) => ownershipRepository.renew({
        ...epochFence(epoch),
        now: new Date(),
      }),
      fence: (epoch, safeReasonCode) => ownershipRepository.fence({
        ...epochFence(epoch),
        safeReasonCode,
        fencedAt: new Date(),
      }),
      release: (epoch) => ownershipRepository.release({
        ...epochFence(epoch),
        releasedAt: new Date(),
      }),
      listReconcilablePredecessorAttempts: (epoch) =>
        workRepository.listReconcilablePredecessorAttempts(epochFence(epoch)),
      async reconcilePredecessorAttempt(epoch, attempt) {
        const safeOutcomeHash = createHmac("sha256", uncertainOutcomeKey)
          .update(
            `packscout-source-uncertain-outcome:v1\0${attempt.organizationId}\0${attempt.requestAttemptId}`,
          )
          .digest("hex");
        try {
          await requestRepository.reconcilePredecessorAttempt({
            organizationId: attempt.organizationId,
            requestAttemptId: attempt.requestAttemptId,
            currentSupervisorEpochId: epoch.epochId,
            currentSupervisorOwnerKey: epoch.ownerKey,
            currentSupervisorLeaseToken: epoch.leaseToken,
            safeOutcomeHash,
            reconciledAt: new Date(),
          });
        } catch (error) {
          if (
            error instanceof PersistenceError &&
            error.code === "REQUEST_ATTEMPT_TERMINAL"
          ) return;
          throw error;
        }
      },
    },
    queue: {
      listDue: (epoch) => workRepository.listDueSources({
        ...epochFence(epoch),
        limit: 100,
      }),
      materializeDue: (epoch, lane, runId) =>
        workRepository.materializeScheduledRun({
          ...epochFence(epoch),
          ...lane,
          runId,
        }),
      listRecoverableClaims: (epoch) =>
        workRepository.listRecoverableClaims(epochFence(epoch)),
      recoverClaim: (epoch, claim) => workRepository.recoverClaim({
        ...epochFence(epoch),
        claim,
      }),
      claimNext: (epoch, command) => workRepository.claimNext({
        ...epochFence(epoch),
        ...command,
      }),
      renewClaim: (epoch, work) => workRepository.renewClaim({
        ...epochFence(epoch),
        work,
      }),
      releaseUnstarted: (epoch, work, waitReason) =>
        workRepository.releaseUnstartedClaim({
          ...epochFence(epoch),
          work,
          waitReason,
          releasedAt: new Date(),
        }),
      markAdmissionWaiting: (epoch, work, reason) =>
        workRepository.markAdmissionWaiting({
          ...epochFence(epoch),
          work,
          reason,
        }),
      markAdmissionGranted: (epoch, work) =>
        workRepository.markAdmissionGranted({
          ...epochFence(epoch),
          work,
        }),
      async complete(epoch, work, disposition) {
        if (work.kind !== "page_read") {
          if (
            disposition.kind === "action_required" ||
            disposition.kind === "fenced"
          ) {
            await workRepository.finishTestClaim({
              ...epochFence(epoch),
              work,
              outcome: disposition.kind === "fenced" ? "fenced" : "failed",
              safeCode: disposition.kind === "fenced"
                ? "STALE_WORK_FENCED"
                : disposition.safeCode,
            });
          }
          return;
        }
        if (
          disposition.kind === "test_terminal" ||
          disposition.kind === "connection_blocked"
        ) return;
        if (disposition.kind === "fenced") {
          await workRepository.finishFencedPageClaim({
            ...epochFence(epoch),
            work,
          });
          return disposition;
        }
        return workRepository.finishPageTurn({
          ...epochFence(epoch),
          work,
          decision: disposition,
        });
      },
    },
    executor,
    capacity: input.capacity ?? createProviderSourceCapacityAdmissionHook({
      database: input.database,
      volumePath: input.configuration.sourceDatabaseVolumePath,
    }),
    snapshot: {
      publish: ({ epoch, capacity, admission }) => snapshots.publish({
        ...epochFence(epoch),
        capacity,
        admission,
      }),
    },
    diagnostics: diagnosticPort(
      new ProviderSourceDiagnosticRepository(input.database),
    ),
    classifyControlPlaneFailure: classifyProviderSourceControlPlaneFailure,
    ids: { id: randomUUID },
  });
}
