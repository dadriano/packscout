import { httpRouter } from "convex/server";
import { internal } from "./_generated/api";
import { httpAction } from "./_generated/server";
import { handleAuthenticatedPublicationRequest } from "./productionDataReleaseAuth";

const http = httpRouter();

http.route({
  path: "/internal/data-release/v2/start",
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
  path: "/internal/data-release/v2/apply-batch",
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
  path: "/internal/data-release/v2/finalize",
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
  path: "/internal/data-release/v2/status",
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
  path: "/internal/data-release/v2/refresh-observation",
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
  path: "/internal/data-release/v2/rollback",
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
  path: "/internal/data-release/v2/retain",
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
