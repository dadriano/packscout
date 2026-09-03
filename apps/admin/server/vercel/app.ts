import { randomUUID } from "node:crypto";
import path from "node:path";
import express, {
  type ErrorRequestHandler,
  type RequestHandler,
} from "express";
import type { AdminRuntime } from "../runtime.ts";
import {
  createMachineryAlertCronHandler,
  type MachineryAlertCronDependencies,
} from "./machinery-alert-cron.ts";

export interface CreateVercelAdminAppInput {
  getRuntime(): Promise<AdminRuntime>;
  cron: Omit<MachineryAlertCronDependencies, "runCycle">;
  spaIndexPath: string;
  serveSpa?: RequestHandler;
  reportRuntimeFailure?(): void;
}

const PRIVATE_CACHE_CONTROL =
  "private, no-cache, no-store, max-age=0, must-revalidate";
const IMMUTABLE_ASSET_CACHE_CONTROL =
  "public, max-age=31536000, immutable";

const handleOuterError: ErrorRequestHandler = (
  error,
  request,
  response,
  next,
) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (request.path.startsWith("/api")) {
    response.status(503).json({
      error: "The admin service is temporarily unavailable.",
      code: "ADMIN_RUNTIME_UNAVAILABLE",
    });
    return;
  }
  response.status(503).type("text/plain").send("Admin temporarily unavailable.");
};

/** Creates the synchronous Express export Vercel's native detector requires. */
export function createVercelAdminApp(input: CreateVercelAdminAppInput) {
  const app = express();
  const spaPublicDirectory = path.dirname(input.spaIndexPath);
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.setHeader("X-Request-Id", randomUUID());
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader(
      "Cache-Control",
      request.path.startsWith("/api")
        ? "no-store"
        : PRIVATE_CACHE_CONTROL,
    );
    next();
  });
  app.get(
    "/api/internal/machinery-alert-cycle",
    createMachineryAlertCronHandler({
      ...input.cron,
      runCycle: async () => (await input.getRuntime()).runMachineryAlertCycle(),
    }),
  );
  app.use((request, response, next) => {
    if (!request.path.startsWith("/api")) {
      next();
      return;
    }
    void input
      .getRuntime()
      .then((runtime) => runtime.app(request, response, next))
      .catch(() => {
        input.reportRuntimeFailure?.();
        next(new Error("Admin runtime initialization failed."));
      });
  });
  app.get("/assets/*", (request, response, next) => {
    const assetName = (
      request.params as Record<string, string | undefined>
    )["0"];
    if (
      !assetName ||
      assetName !== path.basename(assetName) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(assetName)
    ) {
      response.status(404).type("text/plain").send("Admin asset not found.");
      return;
    }
    response.sendFile(
      assetName,
      {
        dotfiles: "deny",
        headers: {
          "Cache-Control": IMMUTABLE_ASSET_CACHE_CONTROL,
        },
        root: path.join(spaPublicDirectory, "assets"),
      },
      (error) => {
        if (!error) return;
        if (response.headersSent) {
          next(error);
          return;
        }
        response.setHeader("Cache-Control", PRIVATE_CACHE_CONTROL);
        const assetError = error as Error & {
          headers?: Record<string, string | undefined>;
          status?: number;
        };
        if (
          typeof assetError.status === "number" &&
          assetError.status >= 400 &&
          assetError.status < 500
        ) {
          const contentRange =
            assetError.headers?.["Content-Range"] ??
            assetError.headers?.["content-range"];
          if (contentRange) response.setHeader("Content-Range", contentRange);
          response
            .status(assetError.status)
            .type("text/plain")
            .send(
              assetError.status === 404
                ? "Admin asset not found."
                : "Admin asset request rejected.",
            );
          return;
        }
        next(error);
      },
    );
  });
  app.get(
    "*",
    input.serveSpa ??
      ((_request, response, next) => {
        response.sendFile(input.spaIndexPath, (error) => {
          if (error) next(error);
        });
      }),
  );
  app.use(handleOuterError);
  return app;
}
