import {
  MAX_CATALOG_RETENTION_ADDITIONAL_COMPLETE,
  MAX_CATALOG_RETENTION_EXTERNAL_MANIFEST_PROTECTIONS,
  MAX_CATALOG_RETENTION_PROTECTED_MANIFESTS,
  MAX_CATALOG_RETENTION_PROTECTED_PROVIDER_RELEASES_PER_PLATFORM,
  MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES,
  canonicalJson,
  catalogManifestActivateRequestSchema,
  catalogManifestBlockRequestSchema,
  catalogManifestRollbackRequestSchema,
  catalogRetentionProtectionSetSchema,
  providerReleaseApplyBatchRequestSchema,
  providerReleaseBlockRequestSchema,
  providerReleaseConfirmReuseRequestSchema,
  providerReleaseFinalizeRequestSchema,
  providerReleaseStartRequestSchema,
  verifyGlobalCatalogManifestV1,
  type CatalogRetentionExternalManifestProtection,
  type CatalogRetentionExternalProviderProtection,
  type CatalogRetentionManifestProtectionReason,
  type CatalogRetentionPostgresProofSnapshot,
  type CatalogRetentionProtectionSet,
  type CatalogRetentionProviderProtectionReason,
  type GlobalCatalogProviderReferenceV1,
} from "@packscout/contracts";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import {
  assertExactCatalogManifestProviderReferences,
  assertProviderReferenceEdgesAreNotOrphaned,
  loadManifestReferencesForPlatformAfterAudit,
} from "./catalogManifestRetentionReferences";
import { loadCatalogManifestOperationById } from "./catalogManifestOperations";
import { loadActiveCatalogManifestState } from "./catalogManifestState";
import { refuseCatalogRetention } from "./catalogRetentionErrors";
import { configuredProviderReleasePlatforms } from "./providerReleaseRequests";
import { loadProviderOperationById } from "./providerReleaseOperations";
import {
  assertCompactProviderReleaseCompletion,
  loadProviderReleaseCompletionProof,
  loadProviderTerminalReceiptProof,
} from "./providerReleaseProof";
import {
  expectedHeadFromStored,
  oneProviderCompletedHead,
  oneProviderRelease,
} from "./providerReleaseState";

type ManifestEntry = {
  document: Doc<"globalCatalogManifests">;
  reasons: Set<CatalogRetentionManifestProtectionReason>;
};

type ProtectedProviderRelease = Pick<
  Doc<"providerCatalogReleases">,
  | "_id"
  | "platformKey"
  | "publicProviderReleaseId"
  | "providerReleaseFingerprint"
  | "lifecycle"
>;

type ProviderEntry = {
  document: ProtectedProviderRelease;
  reasons: Set<CatalogRetentionProviderProtectionReason>;
};

export type CatalogRetentionGraph = Readonly<{
  protectionSet: CatalogRetentionProtectionSet;
  manifests: ReadonlyMap<Id<"globalCatalogManifests">, ManifestEntry>;
  providerReleasesByPlatform: ReadonlyMap<
    string,
    ReadonlyMap<Id<"providerCatalogReleases">, ProviderEntry>
  >;
  configuredPlatforms: readonly string[];
}>;

const MANIFEST_SCAN_LIMIT = MAX_CATALOG_RETENTION_PROTECTED_MANIFESTS + 1;

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function sha256Utf8(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseCanonicalRequest<T>(
  body: string,
  parse: (value: unknown) => T,
): T {
  try {
    const value = JSON.parse(body) as unknown;
    const parsed = parse(value);
    if (canonicalJson(parsed) !== body) throw new Error("not canonical");
    return parsed;
  } catch {
    return refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
}

async function assertProofRequestDigest(
  proof: Readonly<{
    canonicalRequestBody: string | null;
    requestDigest: string;
  }>,
): Promise<void> {
  if (proof.canonicalRequestBody === null) return;
  if (await sha256Utf8(proof.canonicalRequestBody) !== proof.requestDigest) {
    refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
}

async function loadManifestByPublicId(
  ctx: MutationCtx,
  publicReleaseId: string,
): Promise<Doc<"globalCatalogManifests"> | null> {
  const matches = await ctx.db
    .query("globalCatalogManifests")
    .withIndex("by_public_release_id", (index) =>
      index.eq("publicReleaseId", publicReleaseId),
    )
    .take(2);
  if (matches.length > 1) {
    refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
  }
  return matches[0] ?? null;
}

async function assertManifestDocument(
  ctx: MutationCtx,
  document: Doc<"globalCatalogManifests">,
): Promise<void> {
  let manifest;
  try {
    manifest = await verifyGlobalCatalogManifestV1(document.manifest);
  } catch {
    return refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
  }
  if (
    document.publicReleaseId !== manifest.publicReleaseId ||
    document.manifestFingerprint !== manifest.manifestFingerprint ||
    document.providerReferenceSetHash !== manifest.providerReferenceSetHash ||
    document.providerReleaseIds.length !== manifest.providerReferences.length ||
    document.providerReleaseIds.length === 0 ||
    document.providerReleaseIds.length > MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
  }
  try {
    await assertExactCatalogManifestProviderReferences(ctx, document);
  } catch {
    refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
  }
}

async function findExactManifest(
  ctx: MutationCtx,
  identity: Readonly<{
    publicReleaseId: string;
    manifestFingerprint: string;
    sharedConfigurationEpoch: unknown;
    providerReferenceSetHash: string;
  }>,
): Promise<Doc<"globalCatalogManifests"> | null> {
  const document = await loadManifestByPublicId(ctx, identity.publicReleaseId);
  if (document === null) return null;
  if (
    document.manifestFingerprint !== identity.manifestFingerprint ||
    document.providerReferenceSetHash !== identity.providerReferenceSetHash ||
    canonicalJson(document.manifest.sharedConfigurationEpoch) !==
      canonicalJson(identity.sharedConfigurationEpoch)
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  await assertManifestDocument(ctx, document);
  return document;
}

async function loadExactProviderRelease(
  ctx: MutationCtx,
  identity: Readonly<{
    platformKey: string;
    publicProviderReleaseId: string;
    providerReleaseFingerprint: string;
  }>,
): Promise<Doc<"providerCatalogReleases">> {
  let release: Doc<"providerCatalogReleases"> | null;
  try {
    release = await oneProviderRelease(
      ctx,
      identity.platformKey,
      identity.publicProviderReleaseId,
    );
  } catch {
    return refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
  }
  if (
    release === null ||
    release.providerReleaseFingerprint !==
      identity.providerReleaseFingerprint
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  return release;
}

function addManifestReason(
  entries: Map<Id<"globalCatalogManifests">, ManifestEntry>,
  document: Doc<"globalCatalogManifests">,
  reason: CatalogRetentionManifestProtectionReason,
): void {
  const entry = entries.get(document._id) ?? {
    document,
    reasons: new Set<CatalogRetentionManifestProtectionReason>(),
  };
  entry.reasons.add(reason);
  entries.set(document._id, entry);
}

function addProviderReason(
  entries: Map<Id<"providerCatalogReleases">, ProviderEntry>,
  document: ProtectedProviderRelease,
  reason: CatalogRetentionProviderProtectionReason,
): void {
  const entry = entries.get(document._id) ?? {
    document,
    reasons: new Set<CatalogRetentionProviderProtectionReason>(),
  };
  entry.reasons.add(reason);
  entries.set(document._id, entry);
}

async function addProvenProviderReason(
  ctx: MutationCtx,
  entries: Map<Id<"providerCatalogReleases">, ProviderEntry>,
  document: Doc<"providerCatalogReleases">,
  reason: CatalogRetentionProviderProtectionReason,
): Promise<void> {
  if (document.lifecycle === "complete" && !entries.has(document._id)) {
    try {
      await assertCompactProviderReleaseCompletion(ctx, document);
    } catch {
      return refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
    }
  }
  addProviderReason(entries, document, reason);
}

async function assertManifestOperationProof(
  ctx: MutationCtx,
  protection: CatalogRetentionExternalManifestProtection,
): Promise<Readonly<{
  document: Doc<"globalCatalogManifests"> | null;
  pendingProviderReferences: readonly GlobalCatalogProviderReferenceV1[];
}>> {
  const { operationProof } = protection;
  await assertProofRequestDigest(operationProof);
  let requestIdentity: typeof protection.manifest | null = null;
  let activateManifest: Awaited<ReturnType<typeof verifyGlobalCatalogManifestV1>>
    | null = null;
  if (operationProof.canonicalRequestBody === null) {
    if (operationProof.operationState !== "acknowledged") {
      refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
    }
  } else if (operationProof.operationKind === "activateManifest") {
    const request = parseCanonicalRequest(
      operationProof.canonicalRequestBody,
      (value) => catalogManifestActivateRequestSchema.parse(value),
    );
    if (request.operationId !== operationProof.operationId) {
      refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
    }
    requestIdentity = {
      publicReleaseId: request.manifest.publicReleaseId,
      manifestFingerprint: request.manifest.manifestFingerprint,
      sharedConfigurationEpoch: request.manifest.sharedConfigurationEpoch,
      providerReferenceSetHash: request.manifest.providerReferenceSetHash,
    };
    try {
      activateManifest = await verifyGlobalCatalogManifestV1(request.manifest);
    } catch {
      return refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
    }
  } else if (operationProof.operationKind === "rollback") {
    const request = parseCanonicalRequest(
      operationProof.canonicalRequestBody,
      (value) => catalogManifestRollbackRequestSchema.parse(value),
    );
    if (
      request.operationId !== operationProof.operationId ||
      request.rollbackKind !== "manifest"
    ) {
      return refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
    }
    requestIdentity = request.targetManifest;
  } else {
    const request = parseCanonicalRequest(
      operationProof.canonicalRequestBody,
      (value) => catalogManifestBlockRequestSchema.parse(value),
    );
    if (request.operationId !== operationProof.operationId) {
      refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
    }
    requestIdentity = {
      publicReleaseId: request.publicReleaseId,
      manifestFingerprint: request.manifestFingerprint,
      sharedConfigurationEpoch:
        protection.manifest.sharedConfigurationEpoch,
      providerReferenceSetHash:
        protection.manifest.providerReferenceSetHash,
    };
  }
  if (
    requestIdentity !== null &&
    canonicalJson(requestIdentity) !== canonicalJson(protection.manifest)
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  let loaded;
  try {
    loaded = await loadCatalogManifestOperationById(
      ctx,
      operationProof.operationId,
    );
  } catch {
    return refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  if (
    loaded !== null &&
    (loaded.operation.kind !== operationProof.operationKind ||
      loaded.operation.bodyHash !== operationProof.requestDigest ||
      loaded.operation.publicReleaseId !==
        protection.manifest.publicReleaseId ||
      loaded.operation.manifestFingerprint !==
        protection.manifest.manifestFingerprint)
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  if (
    (loaded === null && operationProof.operationState === "acknowledged") ||
    (loaded !== null &&
      (operationProof.operationState !== "acknowledged" ||
        loaded.operation.terminalReceiptSha256 !==
          operationProof.terminalReceiptSha256))
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  const document = await findExactManifest(ctx, protection.manifest);
  if (document !== null) {
    return { document, pendingProviderReferences: [] };
  }
  if (
    loaded !== null &&
    operationProof.operationState === "acknowledged" &&
    operationProof.operationKind === "block" &&
    protection.reason === "block_recovery"
  ) {
    // Blocking an identity before its manifest is materialized is a valid
    // terminal operation. It has no Convex artifact or provider edge to
    // protect, but its exact retained operation must not wedge the barrier.
    return { document: null, pendingProviderReferences: [] };
  }
  if (
    loaded !== null || activateManifest === null ||
    operationProof.operationState === "acknowledged" ||
    protection.reason !== "in_flight_attempt"
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  const pendingProviderReferences = [];
  for (const reference of activateManifest.providerReferences) {
    const release = await loadExactProviderRelease(ctx, reference);
    if (release.lifecycle !== "complete") {
      refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
    }
    pendingProviderReferences.push(reference);
  }
  return { document: null, pendingProviderReferences };
}

function providerRequestForProof(
  protection: CatalogRetentionExternalProviderProtection,
) {
  const { operationProof } = protection;
  const body = operationProof.canonicalRequestBody;
  if (body === null) {
    return refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  switch (operationProof.operationKind) {
    case "start":
      return parseCanonicalRequest(
        body,
        (value) => providerReleaseStartRequestSchema.parse(value),
      );
    case "applyBatch":
      return parseCanonicalRequest(
        body,
        (value) => providerReleaseApplyBatchRequestSchema.parse(value),
      );
    case "finalize":
      return parseCanonicalRequest(
        body,
        (value) => providerReleaseFinalizeRequestSchema.parse(value),
      );
    case "confirmReuse":
      return parseCanonicalRequest(
        body,
        (value) => providerReleaseConfirmReuseRequestSchema.parse(value),
      );
    case "block":
      return parseCanonicalRequest(
        body,
        (value) => providerReleaseBlockRequestSchema.parse(value),
      );
  }
}

async function assertProviderOperationProof(
  ctx: MutationCtx,
  protection: CatalogRetentionExternalProviderProtection,
): Promise<Doc<"providerCatalogReleases">> {
  const { operationProof } = protection;
  await assertProofRequestDigest(operationProof);
  const request = operationProof.canonicalRequestBody === null
    ? null
    : providerRequestForProof(protection);
  if (
    (request === null && operationProof.operationState !== "acknowledged") ||
    (request !== null &&
      (request.operationId !== operationProof.operationId ||
        request.release.platformKey !== protection.release.platformKey ||
        request.release.publicProviderReleaseId !==
          protection.release.publicProviderReleaseId ||
        request.release.providerReleaseFingerprint !==
          protection.release.providerReleaseFingerprint))
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  const release = await loadExactProviderRelease(ctx, protection.release);
  let terminalProof;
  try {
    terminalProof = await loadProviderTerminalReceiptProof(
      ctx,
      operationProof.operationId,
    );
  } catch {
    return refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  if (terminalProof !== null) {
    if (
      operationProof.operationState !== "acknowledged" ||
      terminalProof.operationKind !== operationProof.operationKind ||
      terminalProof.requestDigest !== operationProof.requestDigest ||
      terminalProof.releaseId !== release._id ||
      terminalProof.platformKey !== protection.release.platformKey ||
      terminalProof.publicProviderReleaseId !==
        protection.release.publicProviderReleaseId ||
      terminalProof.providerReleaseFingerprint !==
        protection.release.providerReleaseFingerprint ||
      terminalProof.terminalReceiptSha256 !==
        operationProof.terminalReceiptSha256
    ) {
      refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
    }
    return release;
  }
  if (operationProof.operationState === "acknowledged") {
    refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  let loaded;
  try {
    loaded = await loadProviderOperationById(ctx, operationProof.operationId);
  } catch {
    return refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  if (loaded !== null) {
    refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  return release;
}

async function assertSnapshotPredecessors(
  ctx: MutationCtx,
  proof: CatalogRetentionPostgresProofSnapshot,
): Promise<{
  configuredPlatforms: readonly string[];
  activeState: Awaited<ReturnType<typeof loadActiveCatalogManifestState>>;
  heads: ReadonlyMap<string, Doc<"providerCatalogCompletedHeads"> | null>;
}> {
  const configuredPlatforms = configuredProviderReleasePlatforms();
  if (
    configuredPlatforms === null ||
    canonicalJson(proof.completedHeads.map(({ platformKey }) => platformKey)) !==
      canonicalJson(configuredPlatforms)
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  let activeState;
  try {
    activeState = await loadActiveCatalogManifestState(ctx);
  } catch {
    return refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
  }
  if (
    canonicalJson(activeState.state) !==
      canonicalJson(proof.activeState.state) ||
    (activeState.document?.terminalOperationId ?? null) !==
      proof.activeState.terminalOperationId
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_PREDECESSOR_CONFLICT");
  }
  const heads = new Map<
    string,
    Doc<"providerCatalogCompletedHeads"> | null
  >();
  for (const expected of proof.completedHeads) {
    let head;
    try {
      head = await oneProviderCompletedHead(ctx, expected.platformKey);
    } catch {
      return refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
    }
    if (
      canonicalJson(expected.completedHead) !== canonicalJson(
        expectedHeadFromStored(expected.platformKey, head),
      ) ||
      (head?.terminalOperationId ?? null) !== expected.terminalOperationId
    ) {
      refuseCatalogRetention("CATALOG_RETENTION_PREDECESSOR_CONFLICT");
    }
    if (head !== null) {
      let terminal;
      try {
        terminal = await loadProviderTerminalReceiptProof(
          ctx,
          head.terminalOperationId,
        );
      } catch {
        return refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
      }
      if (
        terminal === null ||
        terminal.operationKind !== head.terminalOperationKind ||
        terminal.releaseId !== head.releaseId ||
        terminal.platformKey !== head.platformKey ||
        terminal.publicProviderReleaseId !== head.publicProviderReleaseId ||
        terminal.terminalReceiptSha256 !== head.terminalReceiptSha256
      ) {
        refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
      }
    }
    heads.set(expected.platformKey, head);
  }
  const storedHeads = await ctx.db.query("providerCatalogCompletedHeads")
    .take(configuredPlatforms.length + 1);
  if (
    storedHeads.length > configuredPlatforms.length ||
    storedHeads.some(({ platformKey }) =>
      !configuredPlatforms.includes(platformKey)
    )
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
  }
  return { configuredPlatforms, activeState, heads };
}

async function buildManifestProtections(
  ctx: MutationCtx,
  proof: CatalogRetentionPostgresProofSnapshot,
  activeState: Awaited<ReturnType<typeof loadActiveCatalogManifestState>>,
  now: string,
): Promise<Readonly<{
  entries: Map<Id<"globalCatalogManifests">, ManifestEntry>;
  pendingProviderReferences: readonly GlobalCatalogProviderReferenceV1[];
}>> {
  const entries = new Map<Id<"globalCatalogManifests">, ManifestEntry>();
  const pendingProviderReferences: GlobalCatalogProviderReferenceV1[] = [];
  for (const protection of proof.manifestProtections) {
    const resolved = await assertManifestOperationProof(ctx, protection);
    if (resolved.document !== null) {
      addManifestReason(entries, resolved.document, protection.reason);
    }
    pendingProviderReferences.push(...resolved.pendingProviderReferences);
  }
  const pointerInputs = [
    {
      id: activeState.document?.activeManifestId ?? null,
      pointer: activeState.state.activeManifest,
      reason: "active_manifest" as const,
    },
    {
      id: activeState.document?.previousManifestId ?? null,
      pointer: activeState.state.previousManifest,
      reason: "previous_manifest" as const,
    },
  ];
  for (const { id, pointer, reason } of pointerInputs) {
    if ((id === null) !== (pointer === null)) {
      refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
    }
    if (id !== null && pointer !== null) {
      const document = await ctx.db.get("globalCatalogManifests", id);
      if (
        document === null || document.lifecycle !== "complete" ||
        document.publicReleaseId !== pointer.publicReleaseId ||
        document.manifestFingerprint !== pointer.manifestFingerprint ||
        document.providerReferenceSetHash !== pointer.providerReferenceSetHash
      ) {
        refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
      }
      await assertManifestDocument(ctx, document);
      addManifestReason(entries, document, reason);
    }
  }
  const protectHeatReferences = async (
    documents: readonly Doc<"globalCatalogManifests">[],
  ): Promise<void> => {
    for (const document of documents) {
      const heatReference = await ctx.db
        .query("repackHeatSignalSets")
        .withIndex("by_manifest_id", (index) =>
          index.eq("manifestId", document._id)
        )
        .take(1);
      if (heatReference.length === 0) continue;
      await assertManifestDocument(ctx, document);
      addManifestReason(entries, document, "heat_reference");
    }
  };
  for (const lifecycle of ["staging", "failed", "complete"] as const) {
    const oldest = await ctx.db
      .query("globalCatalogManifests")
      .withIndex(
        "by_lifecycle_and_retention_eligible_at_and_public_release_id",
        (index) => index.eq("lifecycle", lifecycle),
      )
      .order("asc")
      .take(MANIFEST_SCAN_LIMIT);
    await protectHeatReferences(oldest);
  }
  const recentComplete = await ctx.db
    .query("globalCatalogManifests")
    .withIndex(
      "by_lifecycle_and_retention_eligible_at_and_public_release_id",
      (index) => index.eq("lifecycle", "complete")
        .gt("retentionEligibleAt", now),
    )
    .order("desc")
    .take(MANIFEST_SCAN_LIMIT);
  await protectHeatReferences(recentComplete);
  let additional = 0;
  for (const document of recentComplete) {
    if (entries.has(document._id)) continue;
    if (
      additional === MAX_CATALOG_RETENTION_ADDITIONAL_COMPLETE ||
      entries.size === MAX_CATALOG_RETENTION_PROTECTED_MANIFESTS
    ) break;
    await assertManifestDocument(ctx, document);
    addManifestReason(entries, document, "complete_allowance");
    additional += 1;
  }
  for (const lifecycle of ["staging", "failed"] as const) {
    const young = await ctx.db
      .query("globalCatalogManifests")
      .withIndex(
        "by_lifecycle_and_retention_eligible_at_and_public_release_id",
        (index) => index.eq("lifecycle", lifecycle)
          .gt("retentionEligibleAt", now),
      )
      .order("asc")
      .take(MAX_CATALOG_RETENTION_PROTECTED_MANIFESTS + 1);
    if (young.length > MAX_CATALOG_RETENTION_PROTECTED_MANIFESTS) {
      refuseCatalogRetention("CATALOG_RETENTION_RETENTION_UNSAFE");
    }
    for (const document of young) {
      await assertManifestDocument(ctx, document);
      addManifestReason(entries, document, "abandoned_allowance");
    }
  }
  if (entries.size > MAX_CATALOG_RETENTION_PROTECTED_MANIFESTS) {
    refuseCatalogRetention("CATALOG_RETENTION_RETENTION_UNSAFE");
  }
  return { entries, pendingProviderReferences };
}

export async function selectCatalogManifestRetentionCandidate(
  ctx: MutationCtx,
  protectedManifests: ReadonlyMap<
    Id<"globalCatalogManifests">,
    ManifestEntry
  >,
  now: string,
): Promise<Doc<"globalCatalogManifests"> | null> {
  const firstUnprotected = (
    documents: readonly Doc<"globalCatalogManifests">[],
  ): Doc<"globalCatalogManifests"> | undefined => {
    return documents.find((document) => !protectedManifests.has(document._id));
  };
  const candidates: Doc<"globalCatalogManifests">[] = [];
  for (const lifecycle of ["staging", "failed", "complete"] as const) {
    const aged = await ctx.db
      .query("globalCatalogManifests")
      .withIndex(
        "by_lifecycle_and_retention_eligible_at_and_public_release_id",
        (index) => index.eq("lifecycle", lifecycle)
          .lte("retentionEligibleAt", now),
      )
      .order("asc")
      .take(MANIFEST_SCAN_LIMIT);
    const candidate = firstUnprotected(aged);
    if (candidate !== undefined) candidates.push(candidate);
  }
  const complete = await ctx.db
    .query("globalCatalogManifests")
    .withIndex(
      "by_lifecycle_and_retention_eligible_at_and_public_release_id",
      (index) => index.eq("lifecycle", "complete"),
    )
    .order("asc")
    .take(MANIFEST_SCAN_LIMIT);
  const overflow = firstUnprotected(complete);
  if (overflow !== undefined) candidates.push(overflow);
  candidates.sort((left, right) =>
    compareCodeUnits(left.retentionEligibleAt, right.retentionEligibleAt) ||
    compareCodeUnits(left.publicReleaseId, right.publicReleaseId)
  );
  const selected = candidates[0] ?? null;
  if (selected !== null) await assertManifestDocument(ctx, selected);
  return selected;
}

async function buildProviderProtectionsForPlatform(
  ctx: MutationCtx,
  platformKey: string,
  proof: CatalogRetentionPostgresProofSnapshot,
  pendingManifestProviderReferences:
    readonly GlobalCatalogProviderReferenceV1[],
  head: Doc<"providerCatalogCompletedHeads"> | null,
  activeManifestId: Id<"globalCatalogManifests"> | null,
  retainedManifestReferences:
    readonly Doc<"catalogManifestProviderReferences">[],
  allManifestReferences:
    readonly Doc<"catalogManifestProviderReferences">[] | null,
  includeProviderOperationProtections: boolean,
  now: string,
): Promise<Map<Id<"providerCatalogReleases">, ProviderEntry>> {
  const entries = new Map<Id<"providerCatalogReleases">, ProviderEntry>();
  const external = proof.providerProtectionsByPlatform.find(
    (group) => group.platformKey === platformKey,
  );
  if (includeProviderOperationProtections) {
    for (const protection of external?.releases ?? []) {
      await addProvenProviderReason(
        ctx,
        entries,
        await assertProviderOperationProof(ctx, protection),
        protection.reason,
      );
    }
  }
  for (const reference of pendingManifestProviderReferences) {
    if (reference.platformKey !== platformKey) continue;
    const release = await loadExactProviderRelease(ctx, reference);
    if (release.lifecycle !== "complete") {
      refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
    }
    await addProvenProviderReason(
      ctx,
      entries,
      release,
      "in_flight_attempt",
    );
  }
  const manifestReferences = allManifestReferences ??
    retainedManifestReferences;
  for (const reference of manifestReferences) {
    let completion;
    try {
      completion = await loadProviderReleaseCompletionProof(
        ctx,
        reference.releaseId,
      );
    } catch {
      return refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
    }
    if (
      completion.platformKey !== platformKey ||
      completion.publicProviderReleaseId !==
        reference.publicProviderReleaseId ||
      completion.providerReleaseFingerprint !==
        reference.providerReleaseFingerprint
    ) {
      refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
    }
    const release: ProtectedProviderRelease = {
      _id: completion.releaseId,
      platformKey: completion.platformKey,
      publicProviderReleaseId: completion.publicProviderReleaseId,
      providerReleaseFingerprint: completion.providerReleaseFingerprint,
      lifecycle: "complete",
    };
    addProviderReason(
      entries,
      release,
      "retained_manifest_reference",
    );
    if (reference.manifestId === activeManifestId) {
      addProviderReason(entries, release, "active_head");
    }
  }
  if (head !== null) {
    const release = await ctx.db.get("providerCatalogReleases", head.releaseId);
    if (
      release === null || release.lifecycle !== "complete" ||
      release.platformKey !== platformKey ||
      release.publicProviderReleaseId !== head.publicProviderReleaseId
    ) {
      refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
    }
    await addProvenProviderReason(ctx, entries, release, "completed_head");
  }
  const recentComplete = await ctx.db
    .query("providerCatalogReleases")
    .withIndex(
      "by_platform_lifecycle_retention_public_id",
      (index) => index.eq("platformKey", platformKey)
        .eq("lifecycle", "complete")
        .gt("retentionEligibleAt", now),
    )
    .order("desc")
    .take(
      MAX_CATALOG_RETENTION_PROTECTED_PROVIDER_RELEASES_PER_PLATFORM + 1,
    );
  let additional = 0;
  for (const release of recentComplete) {
    if (entries.has(release._id)) continue;
    if (
      additional === MAX_CATALOG_RETENTION_ADDITIONAL_COMPLETE ||
      entries.size ===
        MAX_CATALOG_RETENTION_PROTECTED_PROVIDER_RELEASES_PER_PLATFORM
    ) break;
    await addProvenProviderReason(
      ctx,
      entries,
      release,
      "complete_allowance",
    );
    additional += 1;
  }
  for (const lifecycle of ["staging", "failed"] as const) {
    const young = await ctx.db
      .query("providerCatalogReleases")
      .withIndex(
        "by_platform_lifecycle_retention_public_id",
        (index) => index.eq("platformKey", platformKey)
          .eq("lifecycle", lifecycle)
          .gt("retentionEligibleAt", now),
      )
      .order("asc")
      .take(
        MAX_CATALOG_RETENTION_PROTECTED_PROVIDER_RELEASES_PER_PLATFORM + 1,
      );
    if (
      young.length >
        MAX_CATALOG_RETENTION_PROTECTED_PROVIDER_RELEASES_PER_PLATFORM
    ) {
      refuseCatalogRetention("CATALOG_RETENTION_RETENTION_UNSAFE");
    }
    for (const release of young) {
      addProviderReason(entries, release, "abandoned_allowance");
    }
  }
  if (
    entries.size >
      MAX_CATALOG_RETENTION_PROTECTED_PROVIDER_RELEASES_PER_PLATFORM
  ) {
    refuseCatalogRetention("CATALOG_RETENTION_RETENTION_UNSAFE");
  }
  return entries;
}

export async function selectProviderRetentionCandidate(
  ctx: MutationCtx,
  platformKey: string,
  protectedReleases: ReadonlyMap<
    Id<"providerCatalogReleases">,
    ProviderEntry
  >,
  now: string,
): Promise<Doc<"providerCatalogReleases"> | null> {
  const candidates: Doc<"providerCatalogReleases">[] = [];
  const retired = await ctx.db
    .query("providerCatalogReleases")
    .withIndex(
      "by_platform_lifecycle_retention_public_id",
      (index) => index.eq("platformKey", platformKey)
        .eq("lifecycle", "retired"),
    )
    .order("asc")
    .take(1);
  if (retired[0] !== undefined) candidates.push(retired[0]);
  for (const lifecycle of ["staging", "failed", "complete"] as const) {
    const aged = await ctx.db
      .query("providerCatalogReleases")
      .withIndex(
        "by_platform_lifecycle_retention_public_id",
        (index) => index.eq("platformKey", platformKey)
          .eq("lifecycle", lifecycle)
          .lte("retentionEligibleAt", now),
      )
      .order("asc")
      .take(
        MAX_CATALOG_RETENTION_PROTECTED_PROVIDER_RELEASES_PER_PLATFORM + 1,
      );
    const candidate = aged.find(({ _id }) => !protectedReleases.has(_id));
    if (candidate !== undefined) candidates.push(candidate);
  }
  const complete = await ctx.db
    .query("providerCatalogReleases")
    .withIndex(
      "by_platform_lifecycle_retention_public_id",
      (index) => index.eq("platformKey", platformKey)
        .eq("lifecycle", "complete"),
    )
    .order("asc")
    .take(
      MAX_CATALOG_RETENTION_PROTECTED_PROVIDER_RELEASES_PER_PLATFORM + 1,
    );
  const overflow = complete.find(({ _id }) => !protectedReleases.has(_id));
  if (overflow !== undefined) candidates.push(overflow);
  candidates.sort((left, right) => {
    if (left.lifecycle === "retired" && right.lifecycle !== "retired") return -1;
    if (right.lifecycle === "retired" && left.lifecycle !== "retired") return 1;
    return compareCodeUnits(
      left.retentionEligibleAt,
      right.retentionEligibleAt,
    ) || compareCodeUnits(
      left.publicProviderReleaseId,
      right.publicProviderReleaseId,
    );
  });
  const selected = candidates[0] ?? null;
  if (selected !== null) {
    if (protectedReleases.has(selected._id)) {
      refuseCatalogRetention("CATALOG_RETENTION_RETENTION_UNSAFE");
    }
    let references;
    try {
      references = await assertProviderReferenceEdgesAreNotOrphaned(
        ctx,
        selected,
      );
    } catch {
      return refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
    }
    if (references.length !== 0) {
      refuseCatalogRetention("CATALOG_RETENTION_RETENTION_UNSAFE");
    }
    if (selected.lifecycle === "complete") {
      try {
        await assertCompactProviderReleaseCompletion(ctx, selected);
      } catch {
        return refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
      }
    }
  }
  return selected;
}

function protectionSet(
  proof: CatalogRetentionPostgresProofSnapshot,
  now: string,
  manifests: ReadonlyMap<Id<"globalCatalogManifests">, ManifestEntry>,
  providers: ReadonlyMap<
    string,
    ReadonlyMap<Id<"providerCatalogReleases">, ProviderEntry>
  >,
): CatalogRetentionProtectionSet {
  return catalogRetentionProtectionSetSchema.parse({
    authoritativeEvaluationTime: now,
    postgresProofSnapshotId: proof.snapshotId,
    postgresProofSnapshotSequence: proof.snapshotSequence,
    postgresProofSnapshotDigest: proof.snapshotDigest,
    manifests: [...manifests.values()]
      .map(({ document, reasons }) => ({
        publicReleaseId: document.publicReleaseId,
        manifestFingerprint: document.manifestFingerprint,
        lifecycle: document.lifecycle,
        reasons: [...reasons].sort(),
      }))
      .sort((left, right) =>
        compareCodeUnits(left.publicReleaseId, right.publicReleaseId)
      ),
    providerReleasesByPlatform: [...providers.entries()]
      .map(([platformKey, entries]) => ({
        platformKey,
        releases: [...entries.values()]
          .map(({ document, reasons }) => ({
            publicProviderReleaseId: document.publicProviderReleaseId,
            providerReleaseFingerprint: document.providerReleaseFingerprint,
            lifecycle: document.lifecycle,
            reasons: [...reasons].sort(),
          }))
          .sort((left, right) =>
            compareCodeUnits(
              left.publicProviderReleaseId,
              right.publicProviderReleaseId,
            )
          ),
      }))
      .sort((left, right) =>
        compareCodeUnits(left.platformKey, right.platformKey)
      ),
  });
}

export async function buildCatalogRetentionGraph(
  ctx: MutationCtx,
  proof: CatalogRetentionPostgresProofSnapshot,
  now: string,
  phase: "manifests" | "provider_releases",
  targetPlatformKey: string | null = null,
): Promise<CatalogRetentionGraph> {
  const { configuredPlatforms, activeState, heads } =
    await assertSnapshotPredecessors(ctx, proof);
  if (proof.providerProtectionsByPlatform.some(({ platformKey }) =>
    !configuredPlatforms.includes(platformKey)
  )) {
    refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE");
  }
  const manifestProtections = await buildManifestProtections(
    ctx,
    proof,
    activeState,
    now,
  );
  const manifests = manifestProtections.entries;
  const retainedReferencesByPlatform = new Map<
    string,
    Doc<"catalogManifestProviderReferences">[]
  >(configuredPlatforms.map((platformKey) => [platformKey, []]));
  for (const { document } of manifests.values()) {
    let references;
    try {
      references = await assertExactCatalogManifestProviderReferences(
        ctx,
        document,
      );
    } catch {
      return refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
    }
    for (const reference of references) {
      const platformReferences = retainedReferencesByPlatform.get(
        reference.platformKey,
      );
      if (platformReferences === undefined) {
        refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
      }
      platformReferences.push(reference);
    }
  }
  const providers = new Map<
    string,
    Map<Id<"providerCatalogReleases">, ProviderEntry>
  >();
  const allReferencesByPlatform = new Map<
    string,
    readonly Doc<"catalogManifestProviderReferences">[]
  >();
  const providerPlatforms = phase === "provider_releases"
    ? targetPlatformKey !== null && configuredPlatforms.includes(
        targetPlatformKey,
      )
      ? [targetPlatformKey]
      : refuseCatalogRetention("CATALOG_RETENTION_PROOF_INCOMPLETE")
    : configuredPlatforms;
  if (phase === "provider_releases") {
    try {
      const loaded = await Promise.all(providerPlatforms.map(
        async (platformKey) => [
          platformKey,
          await loadManifestReferencesForPlatformAfterAudit(ctx, platformKey),
        ] as const,
      ));
      const manifestDocuments = new Map<
        Id<"globalCatalogManifests">,
        Doc<"globalCatalogManifests">
      >();
      for (const [, references] of loaded) {
        for (const reference of references) {
          let manifest = manifestDocuments.get(reference.manifestId);
          if (manifest === undefined) {
            manifest = await ctx.db.get(
              "globalCatalogManifests",
              reference.manifestId,
            ) ?? undefined;
            if (manifest === undefined) {
              refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
            }
            manifestDocuments.set(manifest._id, manifest);
          }
          if (
            manifest.publicReleaseId !== reference.manifestPublicReleaseId ||
            manifest.manifestFingerprint !== reference.manifestFingerprint
          ) {
            refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
          }
        }
      }
      for (const [platformKey, references] of loaded) {
        allReferencesByPlatform.set(platformKey, references);
      }
    } catch {
      return refuseCatalogRetention("CATALOG_RETENTION_REFERENCE_INVALID");
    }
  }
  for (const platformKey of providerPlatforms) {
    providers.set(
      platformKey,
      await buildProviderProtectionsForPlatform(
        ctx,
        platformKey,
        proof,
        manifestProtections.pendingProviderReferences,
        heads.get(platformKey) ?? null,
        activeState.document?.activeManifestId ?? null,
        retainedReferencesByPlatform.get(platformKey) ?? [],
        allReferencesByPlatform.get(platformKey) ?? null,
        phase === "provider_releases",
        now,
      ),
    );
  }
  return {
    protectionSet: protectionSet(proof, now, manifests, providers),
    manifests,
    providerReleasesByPlatform: providers,
    configuredPlatforms,
  };
}
