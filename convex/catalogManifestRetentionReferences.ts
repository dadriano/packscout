import {
  MAX_CATALOG_RETENTION_PROTECTED_MANIFESTS,
  MAX_GLOBAL_CATALOG_PROVIDER_REFERENCES,
  canonicalJson,
} from "@packscout/contracts";
import type { Doc } from "./_generated/dataModel";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { refuseCatalogManifest } from "./catalogManifestErrors";

type ReadCtx = MutationCtx | QueryCtx;

function expectedReference(
  manifest: Doc<"globalCatalogManifests">,
  release: Doc<"providerCatalogReleases">,
  index: number,
) {
  const embedded = manifest.manifest.providerReferences[index];
  if (
    embedded === undefined ||
    release._id !== manifest.providerReleaseIds[index] ||
    release.platformKey !== embedded.platformKey ||
    release.publicProviderReleaseId !== embedded.publicProviderReleaseId ||
    release.providerReleaseFingerprint !== embedded.providerReleaseFingerprint
  ) {
    refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
  }
  return {
    manifestId: manifest._id,
    manifestPublicReleaseId: manifest.publicReleaseId,
    manifestFingerprint: manifest.manifestFingerprint,
    releaseId: release._id,
    platformKey: release.platformKey,
    publicProviderReleaseId: release.publicProviderReleaseId,
    providerReleaseFingerprint: release.providerReleaseFingerprint,
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
  const releases = await Promise.all(
    manifest.providerReleaseIds.map((id) =>
      ctx.db.get("providerCatalogReleases", id)
    ),
  );
  return releases.map((release, index) => {
    if (release === null) {
      return refuseCatalogManifest("CATALOG_MANIFEST_STATE_CONFLICT");
    }
    return expectedReference(manifest, release, index);
  });
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
