import { httpRouter } from "convex/server";
import {
  PRODUCTION_DATA_RELEASE_PATHS,
  PRODUCTION_PROVIDER_RELEASE_PATHS,
  PRODUCTION_REPACK_HEAT_PATHS,
} from "@packscout/contracts";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import {
  handleAuthenticatedProviderReleaseRequest,
  handleAuthenticatedPublicationRequest,
} from "./productionDataReleaseAuth";

const http = httpRouter();

http.route({
  path: PRODUCTION_DATA_RELEASE_PATHS.activeState,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedPublicationRequest(
      ctx,
      request,
      internal.productionDataReleaseActiveState.activeState,
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
