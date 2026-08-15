import { httpRouter } from "convex/server";
import {
  PRODUCTION_DATA_RELEASE_PATHS,
  PRODUCTION_REPACK_HEAT_PATHS,
} from "@packscout/contracts";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { handleAuthenticatedPublicationRequest } from "./productionDataReleaseAuth";

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
