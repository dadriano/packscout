import {
  dataReleaseMetadataFromGlobalCatalogManifestV1,
  type DataReleaseMetadata,
} from "@packscout/contracts";
import { env, type QueryCtx } from "./_generated/server";
import {
  assertCatalogManifestNotBlocked,
  loadCatalogManifestByPublicReleaseId,
  loadValidatedCatalogManifest,
} from "./catalogManifestState";
import {
  loadPublicProviderCatalog,
  type PublicProviderCatalog,
  type SelectedProviderRelease,
} from "./publicProviderCatalogReadModel";

export type ActivePublicCatalogManifest = Readonly<{
  metadata: DataReleaseMetadata;
  catalog: PublicProviderCatalog;
}>;

function dataSourceIsReadable(metadata: DataReleaseMetadata): boolean {
  if (metadata.dataSource === "canonical") {
    return (
      /^[0-9a-f]{64}$/.test(env.PACKSCOUT_PUBLIC_ORIGIN_SET_HASH ?? "") &&
      env.PACKSCOUT_PUBLIC_ORIGIN_SET_HASH === metadata.originSetHash
    );
  }
  return (
    env.PACKSCOUT_RUNTIME_ENVIRONMENT === "local" ||
    env.PACKSCOUT_RUNTIME_ENVIRONMENT === "development" ||
    env.PACKSCOUT_RUNTIME_ENVIRONMENT === "preproduction"
  );
}

export async function loadActivePublicCatalogManifest(
  ctx: QueryCtx,
): Promise<ActivePublicCatalogManifest | null> {
  try {
    const loaded = await loadValidatedCatalogManifest(ctx);
    if (loaded === null) return null;
    const metadata = dataReleaseMetadataFromGlobalCatalogManifestV1(
      loaded.manifest,
      loaded.state,
    );
    if (!dataSourceIsReadable(metadata)) return null;

    const providers: SelectedProviderRelease[] =
      loaded.manifest.providerReferences.map((reference, index) => ({
        platformKey: reference.platformKey,
        release: loaded.providerReleases[index]!,
      }));
    const catalog = await loadPublicProviderCatalog(ctx, providers, {
      vendorCount: loaded.manifest.counts.vendors,
      categoryCount: loaded.manifest.counts.categories,
      repackCount: loaded.manifest.counts.repacks,
    });
    return catalog === null ? null : { metadata, catalog };
  } catch {
    return null;
  }
}

export async function retainedPublicCatalogManifestExists(
  ctx: QueryCtx,
  publicReleaseId: string,
): Promise<boolean> {
  try {
    const document = await loadCatalogManifestByPublicReleaseId(
      ctx,
      publicReleaseId,
    );
    if (document === null) return false;
    await assertCatalogManifestNotBlocked(ctx, document);
    return true;
  } catch {
    return false;
  }
}
