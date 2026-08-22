import { createHash } from "node:crypto";
import {
  opaqueCheckpointEnvelopeSchema,
  type ProviderSourcePageCommitPins,
  type ProviderSourcePagePlan,
} from "@packscout/contracts";
import {
  CAPTURED_SOURCE_PAGE_VERSION,
  SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION,
  assertScopedSourceAdapterOperationResult,
  type CapturedSourcePageV1,
  type SourceAdapterOperationResult,
} from "./source-adapter.ts";
import { OpaqueCheckpointGuard } from "./opaque-checkpoint-guard.ts";
import { ProviderSourcePagePlanner } from "./provider-source-page-planner.ts";

export type ProviderSourcePageImportErrorCode =
  | "adapter_operation_failed"
  | "captured_page_invalid"
  | "checkpoint_mismatch"
  | "operation_scope_mismatch";

export class ProviderSourcePageImportError extends Error {
  constructor(readonly code: ProviderSourcePageImportErrorCode) {
    super(`provider_source_page_import.${code}`);
    this.name = "ProviderSourcePageImportError";
  }
}

export interface ProviderSourceAtomicPagePersistenceInput {
  readonly pins: ProviderSourcePageCommitPins;
  readonly plan: ProviderSourcePagePlan;
  readonly protectedRawResponse: Uint8Array;
  readonly protectedRawResponseSha256: string;
  readonly protectedNativeEvidence: CapturedSourcePageV1["protectedNativeEvidence"];
  readonly nextCheckpointFingerprint: string | null;
  readonly committedAt: Date;
}

export interface ProviderSourceAtomicPageCommitResult {
  readonly kind: "committed" | "already_committed";
  readonly pageId: string;
  readonly checkpointFingerprint: string | null;
  readonly continuation: ProviderSourcePagePlan["normalizedPage"]["continuation"];
  readonly counts: Readonly<{
    inserted: number;
    revised: number;
    duplicate: number;
    quarantined: number;
    warnings: number;
    unresolvedRelationships: number;
    canonicalRevisions: number;
    evRequests: number;
  }>;
}

export interface ProviderSourceAtomicPageRepository {
  commitPage(
    input: ProviderSourceAtomicPagePersistenceInput,
  ): Promise<ProviderSourceAtomicPageCommitResult>;
}

export interface ProviderSourcePageImportInput {
  readonly pins: ProviderSourcePageCommitPins;
  readonly adapterResult: SourceAdapterOperationResult<CapturedSourcePageV1>;
  readonly committedAt: Date;
}

function assertDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new ProviderSourcePageImportError("captured_page_invalid");
  }
}

function assertSafePins(pins: unknown): asserts pins is ProviderSourcePageCommitPins {
  if (typeof pins !== "object" || pins === null || Array.isArray(pins)) {
    throw new ProviderSourcePageImportError("operation_scope_mismatch");
  }
  const value = pins as Partial<ProviderSourcePageCommitPins>;
  if (
    typeof value.connectionHealthGeneration !== "bigint" ||
    value.connectionHealthGeneration < 0n ||
    value.connectionHealthGeneration > BigInt(Number.MAX_SAFE_INTEGER) ||
    typeof value.checkpointGeneration !== "bigint" ||
    value.checkpointGeneration < 1n ||
    value.checkpointGeneration > BigInt(Number.MAX_SAFE_INTEGER) ||
    typeof value.singletonFencingEpoch !== "number" ||
    !Number.isSafeInteger(value.singletonFencingEpoch) ||
    value.singletonFencingEpoch < 0 ||
    typeof value.pageNumber !== "number" ||
    !Number.isSafeInteger(value.pageNumber) ||
    value.pageNumber < 1
  ) {
    throw new ProviderSourcePageImportError("operation_scope_mismatch");
  }
}

function scopeMatches(
  input: ProviderSourcePageImportInput,
): boolean {
  const { pins, adapterResult } = input;
  const scope = adapterResult.operationScope;
  return (
    scope.operationKind === "page_read" &&
    scope.organizationId === pins.organizationId &&
    scope.provider === pins.provider &&
    scope.sourceInstanceId === pins.sourceInstanceId &&
    scope.sourceRevisionId === pins.sourceRevisionId &&
    scope.sourceTypeKey === pins.sourceTypeKey &&
    scope.adapterVersion === pins.sourceAdapterVersion &&
    scope.normalizedContractVersion === pins.normalizedContractVersion &&
    scope.identityNamespaceKey === pins.identityNamespaceKey &&
    scope.connectionProfileId === pins.connectionProfileId &&
    scope.connectionProfileRevisionId === pins.connectionRevisionId &&
    scope.connectionHealthGeneration ===
      Number(pins.connectionHealthGeneration) &&
    scope.requestAttemptId === pins.requestAttemptId &&
    scope.requestLeaseId === pins.requestLeaseId &&
    scope.singletonFencingEpoch === pins.singletonFencingEpoch &&
    scope.importRunId === pins.runId &&
    scope.runClaimLeaseId === pins.runClaimLeaseId &&
    scope.pageAttemptId === pins.pageId &&
    scope.pageNumber === pins.pageNumber &&
    scope.checkpointGeneration === Number(pins.checkpointGeneration) &&
    scope.requestedCheckpointFingerprint ===
      pins.requestedCheckpointFingerprint
  );
}

function assertCheckpointPins(input: ProviderSourcePageImportInput): void {
  const { pins, adapterResult } = input;
  if (!adapterResult.ok) {
    throw new ProviderSourcePageImportError("adapter_operation_failed");
  }
  const parsed = opaqueCheckpointEnvelopeSchema.safeParse(
    pins.requestedCheckpoint,
  );
  if (!parsed.success) {
    throw new ProviderSourcePageImportError("checkpoint_mismatch");
  }
  const requested = parsed.data;
  const next = adapterResult.value.normalizedPage.nextCheckpoint;
  for (const [actual, expected] of [
    [requested.sourceInstanceId, pins.sourceInstanceId],
    [requested.sourceRevisionId, pins.sourceRevisionId],
    [requested.sourceTypeKey, pins.sourceTypeKey],
    [requested.adapterVersion, pins.sourceAdapterVersion],
    [requested.checkpointCodecKey, pins.checkpointCodecVersion],
    [requested.checkpointGeneration, Number(pins.checkpointGeneration)],
    [next.sourceInstanceId, pins.sourceInstanceId],
    [next.sourceRevisionId, pins.sourceRevisionId],
    [next.sourceTypeKey, pins.sourceTypeKey],
    [next.adapterVersion, pins.sourceAdapterVersion],
    [next.checkpointCodecKey, pins.checkpointCodecVersion],
    [next.checkpointGeneration, Number(pins.checkpointGeneration)],
  ] as const) {
    if (actual !== expected) {
      throw new ProviderSourcePageImportError("checkpoint_mismatch");
    }
  }
}

/**
 * Generic completed-page boundary. It never fetches, decrypts credentials,
 * parses vendor cursors, schedules work, or invokes a source adapter.
 */
export class ProviderSourcePageImportService {
  constructor(
    private readonly planner: ProviderSourcePagePlanner,
    private readonly checkpoints: OpaqueCheckpointGuard,
    private readonly pages: ProviderSourceAtomicPageRepository,
  ) {}

  async importPage(
    input: ProviderSourcePageImportInput,
  ): Promise<ProviderSourceAtomicPageCommitResult> {
    try {
      assertScopedSourceAdapterOperationResult<CapturedSourcePageV1>(
        input.adapterResult,
      );
    } catch {
      throw new ProviderSourcePageImportError("captured_page_invalid");
    }
    assertDate(input.committedAt);
    assertSafePins(input.pins);
    if (
      typeof input.adapterResult !== "object" ||
      input.adapterResult === null ||
      !("ok" in input.adapterResult)
    ) {
      throw new ProviderSourcePageImportError("captured_page_invalid");
    }
    if (!input.adapterResult.ok) {
      throw new ProviderSourcePageImportError("adapter_operation_failed");
    }
    let matchingScope = false;
    try {
      matchingScope = scopeMatches(input);
    } catch {
      matchingScope = false;
    }
    if (!matchingScope) {
      throw new ProviderSourcePageImportError("operation_scope_mismatch");
    }
    try {
      assertCheckpointPins(input);
    } catch (error) {
      if (error instanceof ProviderSourcePageImportError) throw error;
      throw new ProviderSourcePageImportError("checkpoint_mismatch");
    }

    const captured = input.adapterResult.value;
    try {
      const evidenceReferences = captured.protectedNativeEvidence.map(
        ({ reference }) => reference,
      );
      const outcomeReferences = captured.normalizedPage.outcomes.flatMap(
        (outcome) => {
          if (outcome.status === "invalid") {
            return [outcome.protectedNativeEvidenceRef];
          }
          return [
            outcome.observation.protectedNativeEvidenceRef,
            ...(outcome.observation.kind === "trade" &&
            outcome.observation.protectedTransactionEvidenceRef !== null
              ? [outcome.observation.protectedTransactionEvidenceRef]
              : []),
          ];
        },
      );
      if (
        captured.captureVersion !== CAPTURED_SOURCE_PAGE_VERSION ||
        captured.requestCapture.captureVersion !==
          SOURCE_ADAPTER_REQUEST_CAPTURE_VERSION ||
        captured.normalizedPage.provider !== input.pins.provider ||
        captured.normalizedPage.normalizedContractVersion !==
          input.pins.normalizedContractVersion ||
        captured.normalizedPage.measurements.durationMilliseconds !==
          input.adapterResult.measurements.durationMilliseconds ||
        captured.normalizedPage.measurements.responseBytes !==
          input.adapterResult.measurements.responseBytes ||
        captured.normalizedPage.measurements.recordCount !==
          input.adapterResult.measurements.recordCount ||
        createHash("sha256")
            .update(captured.requestCapture.protectedRawResponse)
            .digest("hex") !==
          captured.requestCapture.protectedRawResponseSha256 ||
        new Set(evidenceReferences).size !== evidenceReferences.length ||
        new Set(outcomeReferences).size !== outcomeReferences.length ||
        evidenceReferences.length !== outcomeReferences.length ||
        evidenceReferences.some(
          (reference) => !outcomeReferences.includes(reference),
        )
      ) {
        throw new ProviderSourcePageImportError("captured_page_invalid");
      }
    } catch (error) {
      if (error instanceof ProviderSourcePageImportError) throw error;
      throw new ProviderSourcePageImportError("captured_page_invalid");
    }

    const requested = input.pins.requestedCheckpoint;
    let requestedFingerprint: string | null;
    let nextCheckpointFingerprint: string | null;
    try {
      requestedFingerprint = requested.value === null
        ? null
        : this.checkpoints.fingerprint(requested);
      const transition = this.checkpoints.guard({
        requested,
        next: captured.normalizedPage.nextCheckpoint,
        continuation: captured.normalizedPage.continuation,
        committedFingerprints: new Set(),
      });
      nextCheckpointFingerprint =
        captured.normalizedPage.nextCheckpoint.value === null
          ? null
          : transition.nextFingerprint;
    } catch {
      throw new ProviderSourcePageImportError("checkpoint_mismatch");
    }
    if (requestedFingerprint !== input.pins.requestedCheckpointFingerprint) {
      throw new ProviderSourcePageImportError("checkpoint_mismatch");
    }
    const plan = this.planner.plan({
      organizationId: input.pins.organizationId,
      providerId: input.pins.providerId,
      provider: input.pins.provider,
      mapperKey: input.pins.mapperKey,
      mapperVersion: input.pins.mapperVersion,
      normalizedContractVersion: input.pins.normalizedContractVersion,
      identityNamespaceKey: input.pins.identityNamespaceKey,
      page: captured.normalizedPage,
    });
    return this.pages.commitPage({
      pins: input.pins,
      plan,
      protectedRawResponse: new Uint8Array(
        captured.requestCapture.protectedRawResponse,
      ),
      protectedRawResponseSha256:
        captured.requestCapture.protectedRawResponseSha256,
      protectedNativeEvidence: captured.protectedNativeEvidence,
      nextCheckpointFingerprint,
      committedAt: new Date(input.committedAt),
    });
  }
}
