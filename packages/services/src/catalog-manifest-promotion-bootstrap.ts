import { createHash } from "node:crypto";
import {
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  providerReleaseCompletedHeadRequestSchema,
  type ActiveCatalogManifestStateV1,
  type CatalogManifestActiveStateReceipt,
  type ProviderReleaseCompletedHeadReceipt,
  type ProviderReleaseCompletedHeadRequest,
  type ProviderReleaseCompletedHeadStateV1,
} from "@packscout/contracts";
import { MANIFEST_PROMOTION_ACTIVE_STATE_REQUEST_BODY } from
  "./manifest-promotion-operations.ts";

interface CatalogManifestBootstrapActiveReference {
  readonly publicProviderReleaseId: string;
  readonly providerReleaseFingerprint: string;
  readonly providerTerminalOperationId: string;
  readonly providerTerminalReceiptBody: string;
  readonly providerTerminalReceiptSha256: string;
  readonly providerTerminalResponseBody?: string | null;
  readonly publishArtifactAttemptId: string;
}

interface CatalogManifestBootstrapLocalCompletedHead {
  readonly attemptId: string;
  readonly publicProviderReleaseId: string;
  readonly providerReleaseFingerprint: string;
  readonly terminalReceiptSha256: string;
}

export interface CatalogManifestBootstrapProviderProof {
  readonly platformKey: string;
  readonly activeReference: CatalogManifestBootstrapActiveReference | null;
  readonly completedHeadProbe: Readonly<{
    requestBody: string;
    receiptBody: string;
    exactResponseBody?: string | null;
    remoteHead: ProviderReleaseCompletedHeadStateV1;
  }>;
  readonly localCompletedHead: CatalogManifestBootstrapLocalCompletedHead | null;
}

export interface CatalogManifestBootstrapLocalCandidate {
  readonly manifestDefinitionRequestBody: string | null;
  readonly manifestTerminalRequestBody: string | null;
  readonly manifestReceiptBody: string | null;
  readonly manifestExactResponseBody: string | null;
  readonly providers: readonly Readonly<{
    platformKey: string;
    activeReference: CatalogManifestBootstrapActiveReference | null;
    localCompletedHead: CatalogManifestBootstrapLocalCompletedHead | null;
  }>[];
}

export type CatalogManifestPromotionBootstrapErrorCode =
  | "CATALOG_MANIFEST_BOOTSTRAP_CONFIGURATION_INVALID"
  | "CATALOG_MANIFEST_BOOTSTRAP_LOCAL_PROOF_MISSING"
  | "CATALOG_MANIFEST_BOOTSTRAP_REMOTE_PROOF_INVALID";

export class CatalogManifestPromotionBootstrapError extends Error {
  constructor(readonly code: CatalogManifestPromotionBootstrapErrorCode) {
    super("Catalog manifest promotion bootstrap proof is unavailable.");
    this.name = "CatalogManifestPromotionBootstrapError";
  }
}

interface SignedProbeResult<Receipt> {
  readonly receipt: Receipt;
  readonly canonicalReceiptBody: string;
  readonly receiptSha256: string;
  readonly exactResponseBody?: string;
}

export interface CatalogManifestBootstrapProviderTransport {
  readonly platformKey: string;
  completedHead(
    request: ProviderReleaseCompletedHeadRequest,
    signal?: AbortSignal,
  ): Promise<SignedProbeResult<ProviderReleaseCompletedHeadReceipt>>;
}

export interface CatalogManifestBootstrapRemoteTransport {
  activeState(signal?: AbortSignal): Promise<
    SignedProbeResult<CatalogManifestActiveStateReceipt>
  >;
}

export interface CatalogManifestBootstrapProofPort {
  loadState(): Promise<
    | "unverified"
    | "reproof_required"
    | "verified_empty"
    | "verified_cleared"
    | "verified_active"
  >;
  loadLocalCandidate(input: Readonly<{
    activeState: ActiveCatalogManifestStateV1;
  }>): Promise<CatalogManifestBootstrapLocalCandidate | null>;
  verifyEmpty(input: Readonly<{
    activeStateRequestBody: string;
    activeStateReceiptBody: string;
    activeStateExactResponseBody?: string | null;
    providers: readonly CatalogManifestBootstrapProviderProof[];
    verifiedAt: Date;
  }>): Promise<void>;
  verifyCleared(input: Readonly<{
    activeStateRequestBody: string;
    activeStateReceiptBody: string;
    activeStateExactResponseBody?: string | null;
    manifestTerminalRequestBody: string;
    manifestReceiptBody: string;
    manifestExactResponseBody?: string | null;
    providers: readonly CatalogManifestBootstrapProviderProof[];
    verifiedAt: Date;
  }>): Promise<void>;
  verifyActive(input: Readonly<{
    activeStateRequestBody: string;
    activeStateReceiptBody: string;
    activeStateExactResponseBody?: string | null;
    manifestDefinitionRequestBody: string;
    manifestTerminalRequestBody: string;
    manifestReceiptBody: string;
    manifestExactResponseBody?: string | null;
    providers: readonly CatalogManifestBootstrapProviderProof[];
    verifiedAt: Date;
  }>): Promise<void>;
}

export interface CatalogManifestBootstrapEvaluationPort {
  enqueueEvaluation(input: Readonly<{
    cause: "bootstrap_reconcile";
    causeIdentity: string;
    requestedAt: Date;
  }>): Promise<unknown>;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function refuse(code: CatalogManifestPromotionBootstrapErrorCode): never {
  throw new CatalogManifestPromotionBootstrapError(code);
}

function exactReceipt<Receipt>(result: SignedProbeResult<Receipt>): void {
  if (canonicalJson(result.receipt) !== result.canonicalReceiptBody ||
      sha256(result.canonicalReceiptBody) !== result.receiptSha256) {
    refuse("CATALOG_MANIFEST_BOOTSTRAP_REMOTE_PROOF_INVALID");
  }
}

/** Probes every configured credential and anchors the full two-phase graph. */
export class CatalogManifestPromotionBootstrapCoordinator {
  readonly #providers: readonly CatalogManifestBootstrapProviderTransport[];

  constructor(
    private readonly proofs: CatalogManifestBootstrapProofPort,
    private readonly manifest: CatalogManifestBootstrapRemoteTransport,
    providers: readonly CatalogManifestBootstrapProviderTransport[],
    private readonly evaluations: CatalogManifestBootstrapEvaluationPort,
  ) {
    const canonical = [...providers].sort((left, right) =>
      left.platformKey < right.platformKey
        ? -1 : left.platformKey > right.platformKey ? 1 : 0);
    if (canonical.length < 1 || canonical.length > 8 ||
        canonical.some((provider, index) =>
          provider !== providers[index] ||
          (index > 0 && canonical[index - 1]!.platformKey ===
            provider.platformKey))) {
      refuse("CATALOG_MANIFEST_BOOTSTRAP_CONFIGURATION_INVALID");
    }
    this.#providers = Object.freeze(canonical);
  }

  async ensureVerified(input: Readonly<{
    verifiedAt: Date;
    signal?: AbortSignal;
  }>): Promise<void> {
    if (!Number.isFinite(input.verifiedAt.getTime())) {
      refuse("CATALOG_MANIFEST_BOOTSTRAP_CONFIGURATION_INVALID");
    }
    // The DB exposes the prior verified state while exact sent work still
    // requires status-first recovery. Once that work settles, a configured-set
    // mismatch becomes reproof_required and must create a new durable proof
    // revision before fresh claims can proceed.
    const state = await this.proofs.loadState();
    if (state !== "unverified" && state !== "reproof_required") return;
    const [active, ...heads] = await Promise.all([
      this.manifest.activeState(input.signal),
      ...this.#providers.map(async (provider) => {
        const request = providerReleaseCompletedHeadRequestSchema.parse({
          schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
          operationId: `bootstrap:completed-head:${provider.platformKey}`,
          platformKey: provider.platformKey,
        });
        const result = await provider.completedHead(request, input.signal);
        return { provider, request, result };
      }),
    ]);
    exactReceipt(active);
    if (active.receipt.operationKind !== "activeState" ||
        active.receipt.operationId !== "catalog-manifest-active-state" ||
        active.receipt.requestDigest !==
          sha256(MANIFEST_PROMOTION_ACTIVE_STATE_REQUEST_BODY)) {
      refuse("CATALOG_MANIFEST_BOOTSTRAP_REMOTE_PROOF_INVALID");
    }
    for (const { provider, request, result } of heads) {
      exactReceipt(result);
      if (result.receipt.operationKind !== "completedHead" ||
          result.receipt.operationId !== request.operationId ||
          result.receipt.platformKey !== provider.platformKey ||
          result.receipt.details.head.platformKey !== provider.platformKey ||
          result.receipt.requestDigest !== sha256(canonicalJson(request))) {
        refuse("CATALOG_MANIFEST_BOOTSTRAP_REMOTE_PROOF_INVALID");
      }
    }
    const activeState = active.receipt.details.activeState;
    const local = await this.proofs.loadLocalCandidate({ activeState });
    if (local === null || local.providers.length !== this.#providers.length ||
        local.providers.some(({ platformKey }, index) =>
          platformKey !== this.#providers[index]!.platformKey)) {
      refuse("CATALOG_MANIFEST_BOOTSTRAP_LOCAL_PROOF_MISSING");
    }
    const providers = heads.map(({ provider, request, result }, index) => ({
      platformKey: provider.platformKey,
      activeReference: local.providers[index]!.activeReference,
      completedHeadProbe: {
        requestBody: canonicalJson(request),
        receiptBody: result.canonicalReceiptBody,
        ...(result.exactResponseBody === undefined ? {} : {
          exactResponseBody: result.exactResponseBody,
        }),
        remoteHead: result.receipt.details.head,
      },
      localCompletedHead: local.providers[index]!.localCompletedHead,
    })) satisfies readonly CatalogManifestBootstrapProviderProof[];
    const common = {
      activeStateRequestBody: MANIFEST_PROMOTION_ACTIVE_STATE_REQUEST_BODY,
      activeStateReceiptBody: active.canonicalReceiptBody,
      ...(active.exactResponseBody === undefined ? {} : {
        activeStateExactResponseBody: active.exactResponseBody,
      }),
      providers,
      verifiedAt: input.verifiedAt,
    };
    if (activeState.generation === 0) {
      await this.proofs.verifyEmpty(common);
    } else if (activeState.activeManifest === null) {
      if (local.manifestTerminalRequestBody === null ||
          local.manifestReceiptBody === null) {
        refuse("CATALOG_MANIFEST_BOOTSTRAP_LOCAL_PROOF_MISSING");
      }
      await this.proofs.verifyCleared({
        ...common,
        manifestTerminalRequestBody: local.manifestTerminalRequestBody,
        manifestReceiptBody: local.manifestReceiptBody,
        ...(local.manifestExactResponseBody === null ? {} : {
          manifestExactResponseBody: local.manifestExactResponseBody,
        }),
      });
    } else {
      if (local.manifestDefinitionRequestBody === null ||
          local.manifestTerminalRequestBody === null ||
          local.manifestReceiptBody === null) {
        refuse("CATALOG_MANIFEST_BOOTSTRAP_LOCAL_PROOF_MISSING");
      }
      await this.proofs.verifyActive({
        ...common,
        manifestDefinitionRequestBody: local.manifestDefinitionRequestBody,
        manifestTerminalRequestBody: local.manifestTerminalRequestBody,
        manifestReceiptBody: local.manifestReceiptBody,
        ...(local.manifestExactResponseBody === null ? {} : {
          manifestExactResponseBody: local.manifestExactResponseBody,
        }),
      });
    }
    await this.evaluations.enqueueEvaluation({
      cause: "bootstrap_reconcile",
      causeIdentity: sha256(canonicalJson({
        activeStateReceiptSha256: active.receiptSha256,
        providerHeadReceiptSha256: heads.map(
          ({ result }) => result.receiptSha256,
        ),
      })),
      requestedAt: input.verifiedAt,
    });
  }
}
