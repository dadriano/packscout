import { httpRouter } from "convex/server";
import { PRODUCTION_DATA_RELEASE_PATHS } from "@packscout/contracts";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { handleAuthenticatedPublicationRequest } from "./productionDataReleaseAuth";

const http = httpRouter();

http.route({
  path: PRODUCTION_DATA_RELEASE_PATHS.start,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedPublicationRequest(
      ctx,
      request,
      internal.productionDataReleaseLifecycle.start,
    ),
  ),
});

http.route({
  path: PRODUCTION_DATA_RELEASE_PATHS.applyBatch,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedPublicationRequest(
      ctx,
      request,
      internal.productionDataReleaseBatch.applyBatch,
    ),
  ),
});

http.route({
  path: PRODUCTION_DATA_RELEASE_PATHS.finalize,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedPublicationRequest(
      ctx,
      request,
      internal.productionDataReleaseLifecycle.finalize,
    ),
  ),
});

http.route({
  path: PRODUCTION_DATA_RELEASE_PATHS.status,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedPublicationRequest(
      ctx,
      request,
      internal.productionDataReleaseLifecycle.status,
    ),
  ),
});

http.route({
  path: PRODUCTION_DATA_RELEASE_PATHS.refreshObservation,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedPublicationRequest(
      ctx,
      request,
      internal.productionDataReleaseLifecycle.refreshObservation,
    ),
  ),
});

http.route({
  path: PRODUCTION_DATA_RELEASE_PATHS.rollback,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedPublicationRequest(
      ctx,
      request,
      internal.productionDataReleaseRollback.rollback,
    ),
  ),
});

http.route({
  path: PRODUCTION_DATA_RELEASE_PATHS.retain,
  method: "POST",
  handler: httpAction((ctx, request) =>
    handleAuthenticatedPublicationRequest(
      ctx,
      request,
      internal.productionDataReleaseRetention.retain,
    ),
  ),
});

export default http;
