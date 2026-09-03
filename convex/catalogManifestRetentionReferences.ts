import {
  MAX_CATALOG_RETENTION_PROTECTED_MANIFESTS,
  MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES,
  canonicalJson,
  verifyGlobalCatalogManifestV1,
} from "@packscout/contracts";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { refuseCatalogManifest } from "./catalogManifestErrors";
import {
  assertCompactProviderReleaseCompletion,
  loadProviderReleaseCompletionProof,
  providerReleaseImmutableProofSha256,
} from "./providerReleaseProof";

type ReadCtx = MutationCtx | QueryCtx;
export const CATALOG_RETENTION_REFERENCE_AUDIT_PAGE_SIZE = 32;

async function expectedReference(
  manifest: Doc<"globalCatalogManifests">,
  completion: Doc<"providerCatalogReleaseCompletionProofs">,
  index: number,
) {
  const embedded = manifest.manifest.providerReferences[index];
  if (
    embedded === undefined ||
    completion.releaseId !== manifest.providerReleaseIds[index] ||
    completion.platformKey !== embedded.platformKey ||
    completion.publicProviderReleaseId !== embedded.publicProviderReleaseId ||
    completion.providerReleaseFingerprint !==
      embedded.providerReleaseFingerprint ||
    completion.immutableProofSha256 !==
      await providerReleaseImmutableProofSha256(embedded)
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  return {
    manifestId: manifest._id,
    manifestPublicReleaseId: manifest.publicReleaseId,
    manifestFingerprint: manifest.manifestFingerprint,
    releaseId: completion.releaseId,
    platformKey: completion.platformKey,
    publicProviderReleaseId: completion.publicProviderReleaseId,
    providerReleaseFingerprint: completion.providerReleaseFingerprint,
  } as const;
}

async function expectedReferences(
  ctx: ReadCtx,
  manifest: Doc<"globalCatalogManifests">,
) {
  if (
    manifest.providerReleaseIds.length === 0 ||
    manifest.providerReleaseIds.length >
      MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES ||
    manifest.providerReleaseIds.length !==
      manifest.manifest.providerReferences.length
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  let completions: readonly Doc<"providerCatalogReleaseCompletionProofs">[];
  try {
    completions = await Promise.all(
      manifest.providerReleaseIds.map((id) =>
        loadProviderReleaseCompletionProof(ctx, id)
      ),
    );
  } catch {
    return refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  return await Promise.all(completions.map((completion, index) =>
    expectedReference(manifest, completion, index)
  ));
}

export async function insertCatalogManifestProviderReferences(
  ctx: MutationCtx,
  manifest: Doc<"globalCatalogManifests">,
): Promise<void> {
  const existing = await ctx.db
    .query("catalogManifestProviderReferences")
    .withIndex("by_manifest_id_and_platform_key", (index) =>
      index.eq("manifestId", manifest._id),
    )
    .take(1);
  if (existing.length !== 0) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  for (const reference of await expectedReferences(ctx, manifest)) {
    await ctx.db.insert("catalogManifestProviderReferences", reference);
  }
}

export async function assertExactCatalogManifestProviderReferences(
  ctx: ReadCtx,
  manifest: Doc<"globalCatalogManifests">,
): Promise<readonly Doc<"catalogManifestProviderReferences">[]> {
  const [stored, expected] = await Promise.all([
    ctx.db
      .query("catalogManifestProviderReferences")
      .withIndex("by_manifest_id_and_platform_key", (index) =>
        index.eq("manifestId", manifest._id),
      )
      .take(MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES + 1),
    expectedReferences(ctx, manifest),
  ]);
  if (
    stored.length !== expected.length ||
    canonicalJson(stored.map((reference) => ({
      manifestId: reference.manifestId,
      manifestPublicReleaseId: reference.manifestPublicReleaseId,
      manifestFingerprint: reference.manifestFingerprint,
      releaseId: reference.releaseId,
      platformKey: reference.platformKey,
      publicProviderReleaseId: reference.publicProviderReleaseId,
      providerReleaseFingerprint: reference.providerReleaseFingerprint,
    }))) !== canonicalJson(expected)
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  return stored;
}

export async function assertProviderReferenceEdgesAreNotOrphaned(
  ctx: ReadCtx,
  release: Doc<"providerCatalogReleases">,
): Promise<readonly Doc<"catalogManifestProviderReferences">[]> {
  const references = await ctx.db
    .query("catalogManifestProviderReferences")
    .withIndex("by_release_id_and_manifest_id", (index) =>
      index.eq("releaseId", release._id),
    )
    .take(MAX_CATALOG_RETENTION_PROTECTED_MANIFESTS + 1);
  if (references.length > MAX_CATALOG_RETENTION_PROTECTED_MANIFESTS) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  for (const reference of references) {
    const manifest = await ctx.db.get(
      "globalCatalogManifests",
      reference.manifestId,
    );
    if (manifest === null) {
      refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
    }
    const exact = await assertExactCatalogManifestProviderReferences(
      ctx,
      manifest,
    );
    if (!exact.some(({ _id }) => _id === reference._id)) {
      refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
    }
  }
  return references;
}

export async function loadManifestReferencesForPlatformAfterAudit(
  ctx: ReadCtx,
  platformKey: string,
): Promise<readonly Doc<"catalogManifestProviderReferences">[]> {
  const references = await ctx.db
    .query("catalogManifestProviderReferences")
    .withIndex("by_platform_key_and_release_id", (index) =>
      index.eq("platformKey", platformKey)
    )
    .take(MAX_CATALOG_RETENTION_PROTECTED_MANIFESTS + 1);
  if (references.length > MAX_CATALOG_RETENTION_PROTECTED_MANIFESTS) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  return references;
}

export async function auditCatalogManifestProviderReferencePage(
  ctx: ReadCtx,
  phase: "manifests" | "edges",
  cursor: string | null,
): Promise<Readonly<{
  phase: "manifests" | "edges";
  complete: boolean;
  continueCursor: string | null;
  auditedEdgeCount: number;
}>> {
  if (phase === "manifests") {
    const manifests = await ctx.db
      .query("globalCatalogManifests")
      .withIndex("by_public_release_id", (index) =>
        cursor === null ? index : index.gt("publicReleaseId", cursor)
      )
      .take(CATALOG_RETENTION_REFERENCE_AUDIT_PAGE_SIZE + 1);
    for (let index = 1; index < manifests.length; index += 1) {
      if (
        manifests[index - 1]!.publicReleaseId >=
          manifests[index]!.publicReleaseId
      ) {
        // The cursor is the public ID. Strict ordering across the lookahead
        // proves that a duplicate cannot straddle a page boundary and be
        // skipped by the next `gt(publicReleaseId, cursor)` query.
        refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
      }
    }
    const page = manifests.slice(0, CATALOG_RETENTION_REFERENCE_AUDIT_PAGE_SIZE);
    for (const manifest of page) {
      let verified;
      try {
        verified = await verifyGlobalCatalogManifestV1(manifest.manifest);
      } catch {
        refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
      }
      if (
        verified.publicReleaseId !== manifest.publicReleaseId ||
        verified.manifestFingerprint !== manifest.manifestFingerprint ||
        verified.providerReferenceSetHash !==
          manifest.providerReferenceSetHash
      ) {
        refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
      }
      await assertExactCatalogManifestProviderReferences(ctx, manifest);
    }
    if (manifests.length > CATALOG_RETENTION_REFERENCE_AUDIT_PAGE_SIZE) {
      return {
        phase: "manifests",
        complete: false,
        continueCursor: page.at(-1)!.publicReleaseId,
        auditedEdgeCount: 0,
      };
    }
    phase = "edges";
    cursor = null;
  }
  const edgeReadLimit = CATALOG_RETENTION_REFERENCE_AUDIT_PAGE_SIZE +
    MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES + 1;
  const references = await ctx.db
    .query("catalogManifestProviderReferences")
    .withIndex(
      "by_manifest_public_release_id_and_platform_key",
      (index) => cursor === null
        ? index
        : index.gt("manifestPublicReleaseId", cursor),
    )
    .take(edgeReadLimit);
  const grouped = new Map<
    string,
    Doc<"catalogManifestProviderReferences">[]
  >();
  for (const reference of references) {
    const group = grouped.get(reference.manifestPublicReleaseId) ?? [];
    group.push(reference);
    grouped.set(reference.manifestPublicReleaseId, group);
  }
  const groups = [...grouped.entries()];
  const complete = references.length < edgeReadLimit;
  const auditedGroups = complete ? groups : groups.slice(0, -1);
  if (!complete && auditedGroups.length === 0) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  const auditedReferences = auditedGroups.flatMap(([, group]) => group);
  const manifestIds = [
    ...new Set(auditedReferences.map(({ manifestId }) => manifestId)),
  ];
  for (const manifestId of manifestIds) {
    const manifest = await ctx.db.get("globalCatalogManifests", manifestId);
    if (manifest === null) {
      refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
    }
    await assertExactCatalogManifestProviderReferences(ctx, manifest);
  }
  const releaseIds = [
    ...new Set(auditedReferences.map(({ releaseId }) => releaseId)),
  ];
  for (const releaseId of releaseIds) {
    const release = await ctx.db.get("providerCatalogReleases", releaseId);
    if (release === null) {
      refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
    }
    try {
      await assertCompactProviderReleaseCompletion(ctx, release);
    } catch {
      refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
    }
  }
  return {
    phase: "edges",
    complete,
    continueCursor: complete ? null : auditedGroups.at(-1)![0],
    auditedEdgeCount: auditedReferences.length,
  };
}
