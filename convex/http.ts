import { httpRouter } from "convex/server";
import {
  PRODUCTION_CATALOG_MANIFEST_PATHS,
  PRODUCTION_CATALOG_RETENTION_PATHS,
  PRODUCTION_PROVIDER_RELEASE_PATHS,
  PRODUCTION_REPACK_HEAT_PATHS,
} from "@packscout/contracts";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import {
  handleAuthenticatedCatalogManifestRequest,
  handleAuthenticatedCatalogRetentionRequest,
  handleAuthenticatedProviderReleaseRequest,
  handleAuthenticatedPublicationRequest,
} from "./productionDataReleaseAuth";

const http = httpRouter();

http.route({
  path: PRODUCTION_CATALOG_RETENTION_PATHS.retainManifests,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogRetentionRequest(
      ctx,
      request,
      internal.catalogRetention.retainManifests,
    ),
  ),
});

http.route({
  path: PRODUCTION_CATALOG_RETENTION_PATHS.retainProviderReleases,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogRetentionRequest(
      ctx,
      request,
      internal.catalogRetention.retainProviderReleases,
    ),
  ),
});

http.route({
  path: PRODUCTION_CATALOG_RETENTION_PATHS.status,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogRetentionRequest(
      ctx,
      request,
      internal.catalogRetentionRead.status,
    ),
  ),
});

http.route({
  path: PRODUCTION_CATALOG_MANIFEST_PATHS.activeState,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogManifestRequest(
      ctx,
      request,
      internal.catalogManifestRead.activeState,
    ),
  ),
});

http.route({
  path: PRODUCTION_CATALOG_MANIFEST_PATHS.activateManifest,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogManifestRequest(
      ctx,
      request,
      internal.catalogManifestActivate.activateManifest,
    ),
  ),
});

http.route({
  path: PRODUCTION_CATALOG_MANIFEST_PATHS.status,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogManifestRequest(
      ctx,
      request,
      internal.catalogManifestRead.status,
    ),
  ),
});

http.route({
  path: PRODUCTION_CATALOG_MANIFEST_PATHS.refreshActiveState,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogManifestRequest(
      ctx,
      request,
      internal.catalogManifestRefresh.refreshActiveState,
    ),
  ),
});

http.route({
  path: PRODUCTION_CATALOG_MANIFEST_PATHS.rollback,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogManifestRequest(
      ctx,
      request,
      internal.catalogManifestRollback.rollback,
    ),
  ),
});

http.route({
  path: PRODUCTION_CATALOG_MANIFEST_PATHS.block,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedCatalogManifestRequest(
      ctx,
      request,
      internal.catalogManifestBlock.block,
    ),
  ),
});

http.route({
  path: PRODUCTION_PROVIDER_RELEASE_PATHS.completedHead,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedProviderReleaseRequest(
      ctx,
      request,
      internal.providerReleaseRead.completedHead,
    ),
  ),
});

http.route({
  path: PRODUCTION_PROVIDER_RELEASE_PATHS.start,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedProviderReleaseRequest(
      ctx,
      request,
      internal.providerReleaseStart.start,
    ),
  ),
});

http.route({
  path: PRODUCTION_PROVIDER_RELEASE_PATHS.applyBatch,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedProviderReleaseRequest(
      ctx,
      request,
      internal.providerReleaseBatch.applyBatch,
    ),
  ),
});

http.route({
  path: PRODUCTION_PROVIDER_RELEASE_PATHS.finalize,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedProviderReleaseRequest(
      ctx,
      request,
      internal.providerReleaseFinalize.finalize,
    ),
  ),
});

http.route({
  path: PRODUCTION_PROVIDER_RELEASE_PATHS.status,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedProviderReleaseRequest(
      ctx,
      request,
      internal.providerReleaseRead.status,
    ),
  ),
});

http.route({
  path: PRODUCTION_PROVIDER_RELEASE_PATHS.confirmReuse,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedProviderReleaseRequest(
      ctx,
      request,
      internal.providerReleaseFinalize.confirmReuse,
    ),
  ),
});

http.route({
  path: PRODUCTION_PROVIDER_RELEASE_PATHS.block,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedProviderReleaseRequest(
      ctx,
      request,
      internal.providerReleaseBlock.block,
    ),
  ),
});

http.route({
  path: PRODUCTION_PROVIDER_RELEASE_PATHS.cleanup,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedProviderReleaseRequest(
      ctx,
      request,
      internal.providerReleaseCleanup.cleanup,
    ),
  ),
});

http.route({
  path: PRODUCTION_REPACK_HEAT_PATHS.activeState,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedPublicationRequest(
      ctx,
      request,
      internal.productionHeatActiveState.activeState,
    ),
  ),
});

http.route({
  path: PRODUCTION_REPACK_HEAT_PATHS.start,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedPublicationRequest(
      ctx,
      request,
      internal.productionHeatLifecycle.start,
    ),
  ),
});

http.route({
  path: PRODUCTION_REPACK_HEAT_PATHS.applyBatch,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedPublicationRequest(
      ctx,
      request,
      internal.productionHeatBatch.applyBatch,
    ),
  ),
});

http.route({
  path: PRODUCTION_REPACK_HEAT_PATHS.finalize,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedPublicationRequest(
      ctx,
      request,
      internal.productionHeatLifecycle.finalize,
    ),
  ),
});

http.route({
  path: PRODUCTION_REPACK_HEAT_PATHS.status,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedPublicationRequest(
      ctx,
      request,
      internal.productionHeatLifecycle.status,
    ),
  ),
});

http.route({
  path: PRODUCTION_REPACK_HEAT_PATHS.refreshFrame,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedPublicationRequest(
      ctx,
      request,
      internal.productionHeatLifecycle.refreshFrame,
    ),
  ),
});

http.route({
  path: PRODUCTION_REPACK_HEAT_PATHS.retain,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedPublicationRequest(
      ctx,
      request,
      internal.productionHeatRetention.retain,
    ),
  ),
});

export default http;
