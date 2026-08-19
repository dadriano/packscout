import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
  PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
  canonicalJson,
  type ActiveCatalogManifestStateV1,
  type CatalogManifestActiveStateReceipt,
  type ProviderReleaseCompletedHeadReceipt,
  type ProviderReleaseCompletedHeadStateV1,
} from "@packscout/contracts";
import {
  CatalogManifestPromotionBootstrapCoordinator,
  CatalogManifestPromotionBootstrapError,
  type CatalogManifestBootstrapLocalCandidate,
  type CatalogManifestBootstrapProofPort,
  type CatalogManifestBootstrapProviderProof,
} from "./catalog-manifest-promotion-bootstrap.ts";

const now = new Date("2026-08-16T12:00:00.000Z");
const hash = "a".repeat(64);

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function signed<Receipt>(receipt: Receipt) {
  const canonicalReceiptBody = canonicalJson(receipt);
  return {
    receipt,
    canonicalReceiptBody,
    receiptSha256: sha256(canonicalReceiptBody),
    exactResponseBody: canonicalJson({ ok: true, receipt }),
  };
}

function activeReceipt(state: ActiveCatalogManifestStateV1) {
  const requestBody = canonicalJson({
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationId: "catalog-manifest-active-state",
  });
  return signed({
    schemaVersion: CATALOG_MANIFEST_PUBLICATION_SCHEMA_VERSION,
    operationKind: "activeState",
    operationId: "catalog-manifest-active-state",
    terminalState: "observed",
    result: "active_state",
    serverTime: now.toISOString(),
    requestDigest: sha256(requestBody),
    receiptDigest: hash,
    details: { activeState: state },
  } as CatalogManifestActiveStateReceipt);
}

function completedHeadReceipt(
  platformKey: string,
  head: ProviderReleaseCompletedHeadStateV1,
) {
  const requestBody = canonicalJson({
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationId: `bootstrap:completed-head:${platformKey}`,
    platformKey,
  });
  return signed({
    schemaVersion: PROVIDER_RELEASE_PUBLICATION_SCHEMA_VERSION,
    operationKind: "completedHead",
    operationId: `bootstrap:completed-head:${platformKey}`,
    platformKey,
    publicProviderReleaseId: head.release?.publicProviderReleaseId ?? null,
    terminalState: "observed",
    result: "completed_head",
    serverTime: now.toISOString(),
    requestDigest: sha256(requestBody),
    receiptDigest: hash,
    details: { head },
  } as ProviderReleaseCompletedHeadReceipt);
}

function emptyHead(platformKey: string): ProviderReleaseCompletedHeadStateV1 {
  return {
    platformKey,
    release: null,
    providerCheckpoint: { settledSequence: "0", settledAt: null },
    observation: null,
    terminalReceiptSha256: null,
  };
}

class MemoryProofs implements CatalogManifestBootstrapProofPort {
  verified: "empty" | "cleared" | "active" | null = null;
  providerProofs: readonly CatalogManifestBootstrapProviderProof[] = [];

  constructor(
    readonly candidate: CatalogManifestBootstrapLocalCandidate | null,
    private state:
      | "unverified"
      | "reproof_required"
      | "verified_empty"
      | "verified_cleared"
      | "verified_active" = "unverified",
  ) {}
  loadState() { return Promise.resolve(this.state); }
  loadLocalCandidate() { return Promise.resolve(this.candidate); }
  verifyEmpty(input: { providers: readonly CatalogManifestBootstrapProviderProof[] }) {
    this.verified = "empty";
    this.state = "verified_empty";
    this.providerProofs = input.providers;
    return Promise.resolve();
  }
  verifyCleared(input: { providers: readonly CatalogManifestBootstrapProviderProof[] }) {
    this.verified = "cleared";
    this.state = "verified_cleared";
    this.providerProofs = input.providers;
    return Promise.resolve();
  }
  verifyActive(input: { providers: readonly CatalogManifestBootstrapProviderProof[] }) {
    this.verified = "active";
    this.state = "verified_active";
    this.providerProofs = input.providers;
    return Promise.resolve();
  }
}

function localCandidate(overrides: Partial<CatalogManifestBootstrapLocalCandidate> = {}):
CatalogManifestBootstrapLocalCandidate {
  return {
    manifestDefinitionRequestBody: null,
    manifestTerminalRequestBody: null,
    manifestReceiptBody: null,
    manifestExactResponseBody: null,
    providers: [
      { platformKey: "alpha", activeReference: null, localCompletedHead: null },
      { platformKey: "beta", activeReference: null, localCompletedHead: null },
    ],
    ...overrides,
  };
}

function coordinator(input: Readonly<{
  state: ActiveCatalogManifestStateV1;
  proofs: MemoryProofs;
  heads?: Readonly<Record<string, ProviderReleaseCompletedHeadStateV1>>;
  probes?: string[];
  evaluations?: string[];
}>) {
  return new CatalogManifestPromotionBootstrapCoordinator(
    input.proofs,
    { activeState: () => Promise.resolve(activeReceipt(input.state)) },
    ["alpha", "beta"].map((platformKey) => ({
      platformKey,
      completedHead(request: { platformKey: string }) {
        input.probes?.push(request.platformKey);
        return Promise.resolve(completedHeadReceipt(
          platformKey,
          input.heads?.[platformKey] ?? emptyHead(platformKey),
        ));
      },
    })),
    { enqueueEvaluation(evaluation: { causeIdentity: string }) {
      input.evaluations?.push(evaluation.causeIdentity);
      return Promise.resolve();
    } },
  );
}

test("empty manifest bootstrap accepts a locally and remotely proven provider head", async () => {
  const completed = {
    ...emptyHead("alpha"),
    release: {
      publicProviderReleaseId: "71000000-0000-5000-8000-000000000001",
      providerReleaseFingerprint: hash,
    },
    providerCheckpoint: {
      settledSequence: "20", settledAt: now.toISOString(),
    },
    observation: {},
    terminalReceiptSha256: hash,
  } as unknown as ProviderReleaseCompletedHeadStateV1;
  const proofs = new MemoryProofs(localCandidate({
    providers: [
      {
        platformKey: "alpha",
        activeReference: null,
        localCompletedHead: {
          attemptId: "71000000-0000-4000-8000-000000000001",
          publicProviderReleaseId:
            "71000000-0000-5000-8000-000000000001",
          providerReleaseFingerprint: hash,
          terminalReceiptSha256: hash,
        },
      },
      { platformKey: "beta", activeReference: null, localCompletedHead: null },
    ],
  }));
  const probes: string[] = [];
  const evaluations: string[] = [];

  await coordinator({
    state: {
      generation: 0, activeManifest: null, previousManifest: null,
      observation: null, terminalReceiptSha256: null,
    },
    proofs,
    heads: { alpha: completed },
    probes,
    evaluations,
  }).ensureVerified({ verifiedAt: now });

  assert.equal(proofs.verified, "empty");
  assert.deepEqual(probes, ["alpha", "beta"]);
  assert.equal(proofs.providerProofs[0]!.completedHeadProbe.remoteHead, completed);
  assert.match(evaluations[0]!, /^[0-9a-f]{64}$/u);
});

test("a persisted bootstrap anchor admits sent-operation status recovery before re-probing", async () => {
  const proofs = new MemoryProofs(null, "verified_empty");
  const probes: string[] = [];
  const evaluations: string[] = [];

  await coordinator({
    state: {
      generation: 99,
      activeManifest: null,
      previousManifest: null,
      observation: null,
      terminalReceiptSha256: hash,
    },
    proofs,
    probes,
    evaluations,
  }).ensureVerified({ verifiedAt: now });

  assert.deepEqual(probes, []);
  assert.deepEqual(evaluations, []);
  assert.equal(proofs.verified, null);
});

test("configured provider-set drift persists one exact reproof revision", async () => {
  const proofs = new MemoryProofs(localCandidate(), "reproof_required");
  const probes: string[] = [];
  const evaluations: string[] = [];
  const target = coordinator({
    state: {
      generation: 0, activeManifest: null, previousManifest: null,
      observation: null, terminalReceiptSha256: null,
    },
    proofs,
    probes,
    evaluations,
  });

  await target.ensureVerified({ verifiedAt: now });
  await target.ensureVerified({ verifiedAt: now });

  assert.equal(proofs.verified, "empty");
  assert.equal(await proofs.loadState(), "verified_empty");
  assert.deepEqual(probes, ["alpha", "beta"]);
  assert.equal(evaluations.length, 1);
});

test("cleared pointer restart uses the exact terminal transition proof", async () => {
  const proofs = new MemoryProofs(localCandidate({
    manifestTerminalRequestBody: "terminal-request",
    manifestReceiptBody: "terminal-receipt",
    manifestExactResponseBody: "terminal-response",
  }));
  await coordinator({
    state: {
      generation: 2,
      activeManifest: null,
      previousManifest: null,
      observation: null,
      terminalReceiptSha256: hash,
    },
    proofs,
  }).ensureVerified({ verifiedAt: now });
  assert.equal(proofs.verified, "cleared");
});

test("active two-provider graph carries immutable definition, terminal transition, and both refs", async () => {
  const reference = (platformKey: string, index: number) => ({
    publicProviderReleaseId:
      `71000000-0000-5000-8000-${String(index).padStart(12, "0")}`,
    providerReleaseFingerprint: hash,
    providerTerminalOperationId: `finalize:${platformKey}`,
    providerTerminalReceiptBody: canonicalJson({ platformKey }),
    providerTerminalReceiptSha256: sha256(canonicalJson({ platformKey })),
    providerTerminalResponseBody: null,
    publishArtifactAttemptId:
      `71000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  });
  const proofs = new MemoryProofs(localCandidate({
    manifestDefinitionRequestBody: "manifest-definition",
    manifestTerminalRequestBody: "manifest-terminal",
    manifestReceiptBody: "manifest-receipt",
    manifestExactResponseBody: "manifest-response",
    providers: [
      { platformKey: "alpha", activeReference: reference("alpha", 1),
        localCompletedHead: null },
      { platformKey: "beta", activeReference: reference("beta", 2),
        localCompletedHead: null },
    ],
  }));
  const active = {
    generation: 3,
    activeManifest: {
      publicReleaseId: "71000000-0000-5000-8000-000000000010",
      manifestFingerprint: hash,
      sharedConfigurationEpoch: {
        configurationKey: "catalog", revision: 1,
        publicChangeSequence: "1", configurationHash: hash,
      },
      providerReferenceSetHash: hash,
      createdAt: now.toISOString(),
      completedAt: now.toISOString(),
    },
    previousManifest: null,
    observation: { providerSelections: [] },
    terminalReceiptSha256: hash,
  } as unknown as ActiveCatalogManifestStateV1;

  await coordinator({ state: active, proofs }).ensureVerified({ verifiedAt: now });

  assert.equal(proofs.verified, "active");
  assert.deepEqual(
    proofs.providerProofs.map(({ platformKey, activeReference }) => ({
      platformKey,
      operationId: activeReference?.providerTerminalOperationId,
    })),
    [
      { platformKey: "alpha", operationId: "finalize:alpha" },
      { platformKey: "beta", operationId: "finalize:beta" },
    ],
  );
});

test("completed-head receipt bound to the wrong provider is refused", async () => {
  const proofs = new MemoryProofs(localCandidate());
  const target = new CatalogManifestPromotionBootstrapCoordinator(
    proofs,
    { activeState: () => Promise.resolve(activeReceipt({
      generation: 0, activeManifest: null, previousManifest: null,
      observation: null, terminalReceiptSha256: null,
    })) },
    [
      {
        platformKey: "alpha",
        completedHead: () => Promise.resolve(completedHeadReceipt(
          "beta", emptyHead("beta"),
        )),
      },
      {
        platformKey: "beta",
        completedHead: () => Promise.resolve(completedHeadReceipt(
          "beta", emptyHead("beta"),
        )),
      },
    ],
    { enqueueEvaluation: () => Promise.resolve() },
  );
  await assert.rejects(
    target.ensureVerified({ verifiedAt: now }),
    (error: unknown) => error instanceof CatalogManifestPromotionBootstrapError &&
      error.code === "CATALOG_MANIFEST_BOOTSTRAP_REMOTE_PROOF_INVALID",
  );
  assert.equal(proofs.verified, null);
});

test("missing or partial local graph fails before any bootstrap acknowledgement", async () => {
  const proofs = new MemoryProofs(null);
  await assert.rejects(
    coordinator({
      state: {
        generation: 0, activeManifest: null, previousManifest: null,
        observation: null, terminalReceiptSha256: null,
      },
      proofs,
    }).ensureVerified({ verifiedAt: now }),
    (error: unknown) => error instanceof CatalogManifestPromotionBootstrapError &&
      error.code === "CATALOG_MANIFEST_BOOTSTRAP_LOCAL_PROOF_MISSING",
  );
  assert.equal(proofs.verified, null);
});
