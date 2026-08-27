import { randomUUID } from "node:crypto";
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

const handleOuterError: ErrorRequestHandler = (
  _error,
  request,
  response,
  _next,
) => {
  void _next;
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
        : "private, no-cache, no-store, max-age=0, must-revalidate",
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
