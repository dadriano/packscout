import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { AuditTrail } from "./core/audit-trail.ts";
import type { LogSourceRegistry } from "./core/log-sources.ts";
import type { LogStreamHub } from "./core/log-stream-hub.ts";
import { createPanelAccessMiddleware } from "./express/panel-access.ts";
import type { LogTailReader } from "./log-tail-reader.ts";
import { createActivityRouter } from "./routes/activity.ts";
import { createHealthRouter } from "./routes/health.ts";
import { createLogsRouter } from "./routes/logs.ts";
import { createLogSourcesRouter } from "./routes/log-sources.ts";

export interface OpsPanelAppOptions {
  audit: AuditTrail;
  registry: LogSourceRegistry;
  hub: LogStreamHub;
  reader: LogTailReader;
  logDirectory: string;
  pollIntervalMs: number;
  onAuditError?: (error: unknown) => void;
}

/**
 * The panel's HTTP surface.
 *
 * Permanent design invariant: no endpoint, parameter, or debug path runs a
 * caller-supplied command, path, or SQL statement. Everything the panel reads
 * is derived from the log-file convention or from configuration it resolved
 * itself. Later surfaces mount under `/api/logs` and `/api/database`, which is
 * what puts them inside the declared guard membership.
 */
export function createOpsPanelApp({
  audit,
  registry,
  hub,
  reader,
  logDirectory,
  pollIntervalMs,
  onAuditError,
}: OpsPanelAppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  // The panel is loopback-only; there is no proxy chain to trust.
  app.set("trust proxy", false);

  // Guards run before any route so guard membership cannot be bypassed by a
  // route that forgets to opt in.
  app.use(createPanelAccessMiddleware({ audit, onAuditError }));

  app.use("/api/health", createHealthRouter());
  app.use(
    "/api/logs/sources",
    createLogSourcesRouter({ registry, logDirectory, pollIntervalMs }),
  );
  app.use("/api/logs", createLogsRouter({ hub, reader }));
  app.use("/api/activity", createActivityRouter({ audit }));

  // Unknown API routes answer with the panel's stable error shape rather than
  // falling through to the UI.
  app.use("/api", (_request, response) => {
    response
      .status(404)
      .json({ error: "Unknown operations panel route.", code: "ops_panel_not_found" });
  });

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      next: NextFunction,
    ): void => {
      if (response.headersSent) {
        next(error);
        return;
      }
      console.error("PackScout operations panel request failed:", error);
      response.status(500).json({
        error: "The operations panel could not complete that request.",
        code: "ops_panel_request_failed",
      });
    },
  );

  return app;
}
