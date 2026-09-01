import { createHash } from "node:crypto";
import {
  canonicalJson,
  type ActiveCatalogManifestStateV1,
  type CatalogManifestReceipt,
  type CatalogManifestStatusNotFoundReceipt,
  type CatalogManifestStatusRequest,
  type GlobalCatalogManifestV1,
} from "@packscout/contracts";
import type {
  ExactManifestActivationReceiptEvidence,
  ManifestActivationIntent,
  ManifestActivationLease,
  ManifestActivationMirror,
  ManifestGateClaim,
  PrismaManifestActivationRepository,
  SignedManifestActiveStateEvidence,
} from "@packscout/database";
import {
  IndependentProviderManifestGateError,
  composeIndependentProviderManifestGate,
  type IndependentProviderManifestGateTarget,
} from "./independent-provider-manifest-gate.ts";
import {
  SignedConvexCatalogManifestPublicationClient,
  type CatalogManifestMutationReceiptByKind,
} from "./convex-catalog-manifest-publication-client.ts";
import {
  PublicationClientError,
  type SignedPublicationResult,
} from "./convex-publication-http-client.ts";

const SAFE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;
const DEFAULT_LEASE_MILLISECONDS = 60_000;

type ManifestActivationStore = Pick<
  PrismaManifestActivationRepository,
  | "loadMirror"
  | "claimLease"
  | "releaseLease"
  | "persistIntent"
  | "recordAttempt"
  | "recordAmbiguous"
  | "recordFailed"
  | "recordStatusObservation"
  | "reconcileSignedActiveState"
  | "accept"
  | "statusRequest"
>;

export interface IndependentManifestCoordinatorTransport {
  activeState(signal?: AbortSignal): Promise<SignedPublicationResult<
    Readonly<{ details: Readonly<{ activeState: ActiveCatalogManifestStateV1 }> }>
  >>;
  sendExact(input: Readonly<{
    kind: "activateManifest" | "rollback";
    canonicalRequestBody: string;
  }>, signal?: AbortSignal): Promise<SignedPublicationResult<
    CatalogManifestMutationReceiptByKind["activateManifest" | "rollback"]
  >>;
  status(
    request: CatalogManifestStatusRequest,
    signal?: AbortSignal,
  ): Promise<SignedPublicationResult<
    CatalogManifestReceipt | CatalogManifestStatusNotFoundReceipt
  >>;
}

export type VerifiedManifestGateTargetResolution =
  | Readonly<{
      state: "ready";
      target: IndependentProviderManifestGateTarget;
    }>
  | Readonly<{
      state: "no_change" | "deferred" | "blocked";
      failureCode: string | null;
    }>;

export type VerifiedManifestStateResolution =
  | Readonly<{
      state: "ready";
      activeManifest: GlobalCatalogManifestV1 | null;
      previousManifest: GlobalCatalogManifestV1 | null;
    }>
  | Readonly<{
      state: "deferred" | "blocked";
      failureCode: string;
    }>;

/**
 * The relay/gateway owns provider routing and complete-proof reconstruction.
 * The coordinator accepts no database address or provider credential and
 * revalidates the returned exact target through the independent gate composer.
 */
export interface VerifiedManifestGateProofSource {
  resolveTarget(input: Readonly<{
    claim: ManifestGateClaim;
    currentManifest: GlobalCatalogManifestV1 | null;
    currentActiveState: ActiveCatalogManifestStateV1;
    signal?: AbortSignal;
  }>): Promise<VerifiedManifestGateTargetResolution>;
  resolveSignedState(input: Readonly<{
    reason: "bootstrap" | "cas_reconciliation";
    activeState: ActiveCatalogManifestStateV1;
    signal?: AbortSignal;
  }>): Promise<VerifiedManifestStateResolution>;
}

export interface IndependentManifestReconciliationResult {
  readonly disposition:
    | "activated"
    | "recovered"
    | "no_change"
    | "cas_lost"
    | "deferred"
    | "blocked";
  readonly semanticOperation: "advance" | "add" | "remove" | "rollback" | null;
  readonly operationId: string | null;
  readonly requestDigest: string | null;
  readonly receiptDigest: string | null;
  readonly activeGeneration: bigint;
  readonly publicReleaseId: string | null;
  readonly manifestFingerprint: string | null;
  readonly failureCode: string | null;
  readonly publicationCount: number;
  readonly operationCount: number;
}

function exactEvidence<T>(
  value: SignedPublicationResult<T>,
): ExactManifestActivationReceiptEvidence {
  return {
    canonicalReceiptBody: value.canonicalReceiptBody,
    receiptSha256: value.receiptSha256,
    exactResponseBody: value.exactResponseBody,
    exactResponseSha256: value.exactResponseSha256,
  };
}

function safeFailure(error: unknown, fallback: string): string {
  if (
    error !== null && typeof error === "object" && "code" in error &&
    typeof error.code === "string" && SAFE_FAILURE_CODE.test(error.code)
  ) return error.code;
  return fallback;
}

function isCasLoss(error: PublicationClientError): boolean {
  return !error.ambiguous && error.disposition === "terminal" &&
    (error.code === "CATALOG_MANIFEST_PREDECESSOR_CONFLICT" ||
      error.code === "CATALOG_MANIFEST_STATE_CONFLICT");
}

function result(
  disposition: IndependentManifestReconciliationResult["disposition"],
  mirror: ManifestActivationMirror,
  input: Readonly<{
    operation?: ManifestActivationIntent | null;
    semanticOperation?: IndependentManifestReconciliationResult["semanticOperation"];
    receiptDigest?: string | null;
    failureCode?: string | null;
    publicationCount?: number;
    operationCount?: number;
  }> = {},
): IndependentManifestReconciliationResult {
  return {
    disposition,
    semanticOperation: input.semanticOperation ?? input.operation?.operation ?? null,
    operationId: input.operation?.id ?? null,
    requestDigest: input.operation?.requestDigest ?? null,
    receiptDigest: input.receiptDigest ?? input.operation?.receiptSha256 ?? null,
    activeGeneration: mirror.generation,
    publicReleaseId: mirror.activeManifest?.publicReleaseId ?? null,
    manifestFingerprint: mirror.activeManifest?.manifestFingerprint ?? null,
    failureCode: input.failureCode ?? null,
    publicationCount: input.publicationCount ?? 0,
    operationCount: input.operationCount ?? (input.operation === undefined ? 0 : 1),
  };
}

function operationIdentity(input: Readonly<{
  claim: ManifestGateClaim;
  operation: "advance" | "add" | "remove" | "rollback";
  activeState: ActiveCatalogManifestStateV1;
  targetManifest: GlobalCatalogManifestV1;
}>): string {
  const digest = createHash("sha256").update(canonicalJson({
    domain: "packscout/independent-manifest-gate-operation/v1",
    providerId: input.claim.providerId,
    observedGeneration: input.claim.observedGeneration.toString(),
    evidenceDigest: input.claim.latestEvidenceDigest,
    authorizationDigest: input.claim.authorizationDigest,
    operation: input.operation,
    expectedGeneration: input.activeState.generation,
    expectedManifestId:
      input.activeState.activeManifest?.publicReleaseId ?? null,
    targetManifestId: input.targetManifest.publicReleaseId,
    targetManifestFingerprint: input.targetManifest.manifestFingerprint,
  }), "utf8").digest("hex");
  return `manifest-gate:${digest}`;
}

function targetMatchesClaim(
  claim: ManifestGateClaim,
  target: IndependentProviderManifestGateTarget,
  currentManifest: GlobalCatalogManifestV1 | null,
): string | null {
  if (
    target.proof.providerId.toLowerCase() !== claim.providerId.toLowerCase() ||
    target.proof.providerKey !== claim.providerKey
  ) return "PROVIDER_MANIFEST_GATE_PROVIDER_MISMATCH";
  const currentContainsProvider = currentManifest?.providerReferences.some(
    ({ platformKey }) => platformKey === claim.providerKey,
  ) ?? false;
  const expectedImplicit = currentContainsProvider ? "advance" : "add";
  if (claim.requestedOperation === null) {
    if (target.operation !== expectedImplicit) {
      return "PROVIDER_MANIFEST_GATE_OPERATION_MISMATCH";
    }
  } else if (target.operation !== claim.requestedOperation) {
    return "PROVIDER_MANIFEST_GATE_OPERATION_MISMATCH";
  }
  if (
    claim.requestedOperation !== null &&
    (target.proof.targetProviderReleaseId !== claim.targetProviderReleaseId ||
      target.proof.targetCatalogVersionId !== claim.targetCatalogVersionId)
  ) return "PROVIDER_MANIFEST_GATE_TARGET_DRIFT";
  if (
    (target.operation === "add" || target.operation === "advance") &&
    claim.providerLifecycle !== "active"
  ) return "PROVIDER_MANIFEST_GATE_PROVIDER_NOT_ACTIVE";
  return null;
}

/** Uses the current credential for mutations and all overlapping role keys for
 * status recovery. A historical accepted receipt remains recoverable while an
 * old role key is intentionally retained during rotation. */
export class RotationAwareManifestCoordinatorTransport
implements IndependentManifestCoordinatorTransport {
  constructor(
    private readonly current: SignedConvexCatalogManifestPublicationClient,
    private readonly historicalStatusReaders:
      readonly Pick<SignedConvexCatalogManifestPublicationClient, "status">[] = [],
  ) {}

  activeState(signal?: AbortSignal) {
    return this.current.activeState(signal);
  }

  sendExact(input: Readonly<{
    kind: "activateManifest" | "rollback";
    canonicalRequestBody: string;
  }>, signal?: AbortSignal) {
    return this.current.sendExact(input, signal);
  }

  async status(request: CatalogManifestStatusRequest, signal?: AbortSignal) {
    let notFound: Awaited<ReturnType<
      SignedConvexCatalogManifestPublicationClient["status"]
    >> | null = null;
    let lastFailure: unknown = null;
    for (const reader of [this.current, ...this.historicalStatusReaders]) {
      try {
        const observed = await reader.status(request, signal);
        if (observed.receipt.result !== "not_found") return observed;
        notFound ??= observed;
      } catch (error) {
        lastFailure = error;
      }
    }
    if (notFound !== null) return notFound;
    throw lastFailure ?? new Error("Manifest status authority is unavailable.");
  }
}

/** One claimed provider gate through exact intent/status/receipt recovery. */
export class IndependentProviderManifestCoordinator {
  readonly #leaseMilliseconds: number;
  readonly #now: () => Date;

  constructor(private readonly dependencies: Readonly<{
    workerId: string;
    activations: ManifestActivationStore;
    proofs: VerifiedManifestGateProofSource;
    transport: IndependentManifestCoordinatorTransport;
    leaseMilliseconds?: number;
    now?: () => Date;
  }>) {
    this.#leaseMilliseconds = dependencies.leaseMilliseconds ??
      DEFAULT_LEASE_MILLISECONDS;
    this.#now = dependencies.now ?? (() => new Date());
    if (
      dependencies.workerId.length < 1 || dependencies.workerId.length > 128 ||
      !Number.isSafeInteger(this.#leaseMilliseconds) ||
      this.#leaseMilliseconds < 1_000 || this.#leaseMilliseconds > 15 * 60_000
    ) throw new RangeError("Manifest coordinator bounds are invalid.");
  }

  async reconcile(input: Readonly<{
    claim: ManifestGateClaim;
    attemptId: string;
    signal?: AbortSignal;
  }>): Promise<IndependentManifestReconciliationResult> {
    let lease: ManifestActivationLease;
    try {
      lease = await this.dependencies.activations.claimLease(
        `${this.dependencies.workerId}:${input.attemptId}`,
        this.#leaseMilliseconds,
      );
    } catch (error) {
      const mirror = await this.dependencies.activations.loadMirror();
      return result("deferred", mirror, {
        failureCode: safeFailure(error, "MANIFEST_ACTIVATION_LEASE_HELD"),
      });
    }
    try {
      const snapshot = await this.currentSnapshot(lease, input.signal);
      if ("failureCode" in snapshot) {
        return result(snapshot.disposition, snapshot.mirror, {
          failureCode: snapshot.failureCode,
        });
      }
      if (
        input.claim.latestEvidenceDigest === null ||
        input.claim.observedGeneration < 1n
      ) return result("blocked", snapshot.mirror, {
        failureCode: "PROVIDER_MANIFEST_GATE_EVIDENCE_INVALID",
      });
      let resolved: VerifiedManifestGateTargetResolution;
      try {
        resolved = await this.dependencies.proofs.resolveTarget({
          claim: input.claim,
          currentManifest: snapshot.currentManifest,
          currentActiveState: snapshot.activeState,
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
      } catch (error) {
        return result("deferred", snapshot.mirror, {
          failureCode: safeFailure(
            error,
            "PROVIDER_MANIFEST_GATE_PROOF_UNAVAILABLE",
          ),
        });
      }
      if (resolved.state !== "ready") {
        return result(resolved.state, snapshot.mirror, {
          failureCode: resolved.failureCode,
        });
      }
      const mismatch = targetMatchesClaim(
        input.claim,
        resolved.target,
        snapshot.currentManifest,
      );
      if (mismatch !== null) return result("blocked", snapshot.mirror, {
        semanticOperation: resolved.target.operation,
        failureCode: mismatch,
      });
      const identity = operationIdentity({
        claim: input.claim,
        operation: resolved.target.operation,
        activeState: snapshot.activeState,
        targetManifest: resolved.target.candidateManifest,
      });
      let command;
      try {
        command = await composeIndependentProviderManifestGate({
          operationId: identity,
          idempotencyKey: identity,
          currentManifest: snapshot.currentManifest,
          currentActiveState: snapshot.activeState,
          target: resolved.target,
        });
      } catch (error) {
        return result("blocked", snapshot.mirror, {
          semanticOperation: resolved.target.operation,
          failureCode: error instanceof IndependentProviderManifestGateError
            ? error.code
            : "PROVIDER_MANIFEST_GATE_CANDIDATE_INVALID",
        });
      }
      let intent: ManifestActivationIntent;
      try {
        intent = await this.dependencies.activations.persistIntent(lease, {
          providerId: input.claim.providerId,
          operation: command.semanticOperation,
          targetProviderReleaseId: command.targetProviderReleaseId,
          targetCatalogVersionId: command.targetCatalogVersionId,
          targetManifest: command.targetManifest,
          canonicalRequestBody: command.canonicalRequestBody,
          requestDigest: command.requestDigest,
          requestedByOperatorId: input.claim.requestedByOperatorId,
          requestedAt: this.#now(),
        });
      } catch (error) {
        return result("blocked", snapshot.mirror, {
          semanticOperation: command.semanticOperation,
          failureCode: safeFailure(
            error,
            "MANIFEST_ACTIVATION_INTENT_INVALID",
          ),
        });
      }
      if (intent.state === "accepted") {
        return result("recovered", await this.dependencies.activations.loadMirror(), {
          operation: intent,
          receiptDigest: intent.receiptSha256,
          operationCount: 1,
        });
      }
      if (intent.state === "failed") {
        if (intent.failureCode === "MANIFEST_ACTIVATION_CAS_LOST") {
          const reconciled = await this.reconcileRemoteState(
            lease,
            input.signal,
          );
          return result("cas_lost", reconciled.mirror, {
            operation: intent,
            failureCode: reconciled.failureCode ??
              "MANIFEST_ACTIVATION_CAS_LOST",
          });
        }
        return result("blocked", snapshot.mirror, {
          operation: intent,
          failureCode: intent.failureCode ?? "MANIFEST_ACTIVATION_FAILED",
        });
      }
      if (intent.attemptCount > 0 || intent.state === "ambiguous") {
        const status = await this.dependencies.transport.status(
          this.dependencies.activations.statusRequest(intent),
          input.signal,
        );
        const statusEvidence = exactEvidence(status);
        const observation = await this.dependencies.activations
          .recordStatusObservation({
            lease,
            operationId: intent.id,
            evidence: statusEvidence,
            observedAt: this.#now(),
          });
        if (observation.resultKind === "terminal") {
          const accepted = await this.dependencies.activations.accept({
            lease,
            operationId: intent.id,
            evidence: statusEvidence,
            receivedAt: this.#now(),
          });
          return result("recovered", accepted.mirror, {
            operation: accepted.operation,
            receiptDigest: status.receiptSha256,
            publicationCount: 1,
            operationCount: 1,
          });
        }
      }
      intent = await this.dependencies.activations.recordAttempt({
        lease,
        operationId: intent.id,
        attemptedAt: this.#now(),
      });
      try {
        const publication = await this.dependencies.transport.sendExact({
          kind: command.convexMutationKind,
          canonicalRequestBody: command.canonicalRequestBody,
        }, input.signal);
        const accepted = await this.dependencies.activations.accept({
          lease,
          operationId: intent.id,
          evidence: exactEvidence(publication),
          receivedAt: this.#now(),
        });
        return result("activated", accepted.mirror, {
          operation: accepted.operation,
          receiptDigest: publication.receiptSha256,
          publicationCount: 1,
          operationCount: 1,
        });
      } catch (error) {
        if (error instanceof PublicationClientError && isCasLoss(error)) {
          await this.dependencies.activations.recordFailed({
            lease,
            operationId: intent.id,
            failureCode: "MANIFEST_ACTIVATION_CAS_LOST",
            observedAt: this.#now(),
          });
          const reconciled = await this.reconcileRemoteState(
            lease,
            input.signal,
          );
          return result("cas_lost", reconciled.mirror, {
            operation: intent,
            failureCode: reconciled.failureCode ??
              "MANIFEST_ACTIVATION_CAS_LOST",
          });
        }
        const failureCode = safeFailure(
          error,
          "MANIFEST_ACTIVATION_TRANSPORT_FAILED",
        );
        if (!(error instanceof PublicationClientError) || error.ambiguous) {
          await this.dependencies.activations.recordAmbiguous({
            lease,
            operationId: intent.id,
            failureCode,
            observedAt: this.#now(),
          });
          return result("deferred", snapshot.mirror, {
            operation: intent,
            failureCode,
          });
        }
        await this.dependencies.activations.recordFailed({
          lease,
          operationId: intent.id,
          failureCode,
          observedAt: this.#now(),
        });
        return result("blocked", snapshot.mirror, {
          operation: intent,
          failureCode,
        });
      }
    } catch (error) {
      const mirror = await this.dependencies.activations.loadMirror();
      return result("deferred", mirror, {
        failureCode: safeFailure(error, "MANIFEST_ACTIVATION_UNAVAILABLE"),
      });
    } finally {
      await this.dependencies.activations.releaseLease(lease).catch(() => false);
    }
  }

  private async currentSnapshot(
    lease: ManifestActivationLease,
    signal?: AbortSignal,
  ): Promise<
    | Readonly<{
        mirror: ManifestActivationMirror;
        currentManifest: GlobalCatalogManifestV1 | null;
        activeState: ActiveCatalogManifestStateV1;
      }>
    | Readonly<{
        disposition: "deferred" | "blocked";
        mirror: ManifestActivationMirror;
        failureCode: string;
      }>
  > {
    const mirror = await this.dependencies.activations.loadMirror();
    if (mirror.activeManifest !== null && mirror.activeState !== null) {
      return {
        mirror,
        currentManifest: mirror.activeManifest,
        activeState: mirror.activeState,
      };
    }
    if (mirror.activeManifest !== null || mirror.activeState !== null) {
      return {
        disposition: "blocked",
        mirror,
        failureCode: "MANIFEST_ACTIVATION_MIRROR_INVALID",
      };
    }
    try {
      const observed = await this.dependencies.transport.activeState(signal);
      const activeState = observed.receipt.details.activeState;
      const resolution = await this.dependencies.proofs.resolveSignedState({
        reason: "bootstrap",
        activeState,
        ...(signal === undefined ? {} : { signal }),
      });
      if (resolution.state !== "ready") {
        return {
          disposition: resolution.state,
          mirror,
          failureCode: resolution.failureCode,
        };
      }
      const evidence: SignedManifestActiveStateEvidence = {
        ...exactEvidence(observed),
        activeManifest: resolution.activeManifest,
        previousManifest: resolution.previousManifest,
      };
      const adopted = await this.dependencies.activations
        .reconcileSignedActiveState({
          lease,
          observationKind: "bootstrap",
          evidence,
          observedAt: this.#now(),
        });
      return {
        mirror: adopted,
        currentManifest: resolution.activeManifest,
        activeState,
      };
    } catch (error) {
      return {
        disposition: "deferred",
        mirror,
        failureCode: safeFailure(error, "MANIFEST_BOOTSTRAP_UNAVAILABLE"),
      };
    }
  }

  private async reconcileRemoteState(
    lease: ManifestActivationLease,
    signal?: AbortSignal,
  ): Promise<Readonly<{
    mirror: ManifestActivationMirror;
    failureCode: string | null;
  }>> {
    const fallback = await this.dependencies.activations.loadMirror();
    try {
      const observed = await this.dependencies.transport.activeState(signal);
      const resolution = await this.dependencies.proofs.resolveSignedState({
        reason: "cas_reconciliation",
        activeState: observed.receipt.details.activeState,
        ...(signal === undefined ? {} : { signal }),
      });
      if (resolution.state !== "ready") {
        return { mirror: fallback, failureCode: resolution.failureCode };
      }
      const mirror = await this.dependencies.activations
        .reconcileSignedActiveState({
          lease,
          observationKind: "reconciliation",
          evidence: {
            ...exactEvidence(observed),
            activeManifest: resolution.activeManifest,
            previousManifest: resolution.previousManifest,
          },
          observedAt: this.#now(),
        });
      return { mirror, failureCode: null };
    } catch (error) {
      return {
        mirror: fallback,
        failureCode: safeFailure(
          error,
          "MANIFEST_CAS_RECONCILIATION_UNAVAILABLE",
        ),
      };
    }
  }
}
